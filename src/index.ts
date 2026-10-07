import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { ExtensionAPI, ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { Api, AssistantMessage, AssistantMessageEvent, AssistantMessageEventStream, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { registerOAuthProvider } from "@earendil-works/pi-ai/oauth";

import { homedir } from "node:os";
import { billingPeriodStart, collectKiroCredits, formatKiroCredits } from "./credits.js";
import { readCatalogCache } from "./catalog-cache.js";
import { KIRO_API, type ExtensionConfig, createModelFromRaw, loadConfig } from "./config.js";
import { DebugLogger } from "./debug-logger.js";
import type { DebugLogger as DebugLoggerInstance } from "./debug-logger.js";
import { omitAuthorizationHeaders } from "./headers.js";
import { applyDiscoveredModels, isCatalogStale, refreshCatalog, regionFromUpstreamUrl, type CatalogSnapshot } from "./discovery.js";
import { createKiroOAuthProvider } from "./oauth.js";
import { nonEmptyString } from "./shared/index.js";

const EXTENSION_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const RUNTIME_PROVIDER_REGISTRATION_EVENT = "pi-multi-auth:runtime-provider-registration";
const MULTI_AUTH_PROVIDERS_REGISTERED_EVENT = "pi-multi-auth:providers-registered";

type KiroRuntimeState = { cwd?: string };
type KiroStreamModule = typeof import("./kiro.js");
type KiroStreamSimple = (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => AssistantMessageEventStream;

function createLazyModule<T>(importer: () => Promise<T>): { load(): Promise<T> } {
  let loaded: T | undefined;
  let promise: Promise<T> | undefined;
  return {
    load(): Promise<T> {
      if (loaded) return Promise.resolve(loaded);
      promise ??= importer().then((module) => {
        loaded = module;
        return module;
      });
      return promise;
    },
  };
}

const kiroStreamLoader = createLazyModule<KiroStreamModule>(() => import("./kiro.js"));

function createLazyKiroStream(config: ExtensionConfig, runtime: KiroRuntimeState, logger: DebugLoggerInstance): KiroStreamSimple {
  return (model, context, options) => {
    const streamPromise = kiroStreamLoader.load()
      .then(({ createKiroStream }) => createKiroStream(config, runtime, logger)(model, context, options));
    streamPromise.catch(() => undefined);

    const lazyStream = {
      async *[Symbol.asyncIterator](): AsyncIterator<AssistantMessageEvent> {
        const stream = await streamPromise;
        yield* stream;
      },
      result(): Promise<AssistantMessage> {
        return streamPromise.then((stream) => stream.result());
      },
      push(event: AssistantMessageEvent): void {
        void streamPromise.then((stream) => stream.push(event), () => undefined);
      },
      end(result?: AssistantMessage): void {
        void streamPromise.then((stream) => stream.end(result), () => undefined);
      },
    };

    return lazyStream as unknown as AssistantMessageEventStream;
  };
}

export default function kiroProviderExtension(pi: ExtensionAPI): void {
  const { config, warnings } = loadConfig(EXTENSION_ROOT);
  const logger = new DebugLogger({ extensionRoot: EXTENSION_ROOT, debug: config.debug });
  for (const warning of warnings) logger.warn("config_warning", { warning });

  if (!config.enabled) {
    logger.debug("extension_disabled", { providerId: config.providerId });
    return;
  }

  const CATALOG_CACHE_PATH = join(EXTENSION_ROOT, "cache", "kiro-models.json");
  let catalog: CatalogSnapshot | undefined = config.modelDiscovery.enabled ? readCatalogCache(CATALOG_CACHE_PATH) : undefined;
  const buildProviderModels = () =>
    applyDiscoveredModels(config.models, catalog, (raw) => createModelFromRaw(raw, config.modelDefaults)).map((model) => ({
      ...model,
      ...(model.headers ? { headers: omitAuthorizationHeaders(model.headers) } : {}),
    }));
  let providerModels = buildProviderModels();

  const publishCatalog = (snapshot: CatalogSnapshot): void => {
    catalog = snapshot;
    providerModels = buildProviderModels();
    // registerKiroProvider/emitRuntimeProviderRegistration are defined below; both run only after init.
    // Deferred so it never re-enters omp's registry from inside an OAuth refresh callback.
    setTimeout(() => {
      try {
        registerKiroProvider();
        emitRuntimeProviderRegistration(true);
      } catch (error) {
        logger.warn("catalog_republish_failed", { error });
      }
    }, 0);
  };

  const oauthProvider = createKiroOAuthProvider(config.oauth, logger, {
    providerId: config.providerId,
    displayName: config.displayName,
    refreshCatalog: async (credentials) => {
      const snapshot = await refreshCatalog({
        accessToken: credentials.access,
        profileArn: nonEmptyString(credentials.profileArn) ?? config.profileArn,
        regionHint: nonEmptyString(credentials.region),
        discovery: config.modelDiscovery,
        cachePath: CATALOG_CACHE_PATH,
        logger,
        providerId: config.providerId,
      });
      if (snapshot) publishCatalog(snapshot);
      return snapshot;
    },
  });
  registerOAuthProvider(oauthProvider);

  const runtime: KiroRuntimeState = {};
  const streamSimple = createLazyKiroStream(config, runtime, logger);
  const providerHeaders = omitAuthorizationHeaders(config.headers);
  let runtimeProviderRegistrationEmitted = false;
  const emitRuntimeProviderRegistration = (force = false): void => {
    if (runtimeProviderRegistrationEmitted && !force) {
      logger.debug("runtime_provider_registration_skipped", {
        providerId: config.providerId,
        reason: "already_emitted",
      });
      return;
    }
    if (!pi.events) return;
    pi.events.emit(RUNTIME_PROVIDER_REGISTRATION_EVENT, {
      provider: config.providerId,
      displayName: config.displayName,
      baseUrl: config.upstreamUrl,
      api: KIRO_API,
      authHeader: false,
      headers: { ...providerHeaders },
      models: providerModels.map((model) => ({ ...model, ...(model.headers ? { headers: { ...model.headers } } : {}) })),
      streamSimple,
    });
    runtimeProviderRegistrationEmitted = true;
    logger.debug("runtime_provider_registration_emitted", {
      providerId: config.providerId,
      api: KIRO_API,
      modelCount: providerModels.length,
    });
  };

  // Covers users who are logged in with a valid token and never trigger an OAuth refresh.
  let catalogRefreshInFlight = false;
  const refreshCatalogIfStale = async (registry: ModelRegistry): Promise<void> => {
    if (catalogRefreshInFlight || !config.modelDiscovery.enabled || !isCatalogStale(catalog, config.modelDiscovery.ttlMs, config.profileArn)) return;
    catalogRefreshInFlight = true;
    try {
      // getApiKeyForProvider makes omp refresh an expired OAuth token first.
      const accessToken = await registry.getApiKeyForProvider(config.providerId);
      if (!accessToken || accessToken === config.apiKey) return;
      const snapshot = await refreshCatalog({
        accessToken,
        profileArn: config.profileArn,
        regionHint: regionFromUpstreamUrl(config.upstreamUrl) ?? config.oauth.region,
        discovery: config.modelDiscovery,
        cachePath: CATALOG_CACHE_PATH,
        logger,
        providerId: config.providerId,
      });
      if (snapshot) publishCatalog(snapshot);
    } catch (error) {
      logger.warn("model_discovery_failed", { provider: config.providerId, error });
    } finally {
      catalogRefreshInFlight = false;
    }
  };

  pi.on("session_start", (_event, ctx) => {
    runtime.cwd = ctx.cwd;
    emitRuntimeProviderRegistration(true);
    void refreshCatalogIfStale(ctx.modelRegistry);
  });

  pi.on("before_agent_start", (_event, ctx) => {
    runtime.cwd = ctx.cwd;
    emitRuntimeProviderRegistration(true);
    return {};
  });

  pi.events?.on(MULTI_AUTH_PROVIDERS_REGISTERED_EVENT, () => {
    emitRuntimeProviderRegistration(true);
  });

  pi.registerCommand("kiro-credits", {
    description: "Show Kiro credits used per day and model (optional arg: number of days, default 7)",
    handler: async (args, ctx) => {
      const parsed = Number.parseInt(args.trim(), 10);
      const days = Number.isFinite(parsed) && parsed > 0 ? parsed : 7;
      const sessionsDir = join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".omp", "agent"), "sessions");
      const now = new Date();
      const billingStart = billingPeriodStart(now, config.pricing.billingDay);
      const since = Math.min(now.getTime() - days * 86_400_000, billingStart.getTime());
      const rows = collectKiroCredits(sessionsDir, config.providerId, since);
      ctx.ui.notify(formatKiroCredits(rows, { days, billingStart, usdPerCredit: config.pricing.usdPerCredit, now }), "info");
    },
  });

  const registerKiroProvider = (): void => {
    pi.registerProvider(config.providerId, {
      name: config.displayName,
      baseUrl: config.upstreamUrl,
      apiKey: config.apiKey,
      api: KIRO_API,
      authHeader: false,
      streamSimple,
      headers: providerHeaders,
      models: providerModels,
      oauth: {
        name: oauthProvider.name,
        login: (callbacks) => oauthProvider.login(callbacks),
        refreshToken: (credentials) => oauthProvider.refreshToken(credentials),
        getApiKey: (credentials) => oauthProvider.getApiKey(credentials),
        modifyModels: (models, credentials) => oauthProvider.modifyModels?.(models, credentials) ?? models,
      },
    });
  };
  registerKiroProvider();
  emitRuntimeProviderRegistration(true);

  logger.debug("provider_registered", {
    providerId: config.providerId,
    api: KIRO_API,
    upstreamUrl: config.upstreamUrl,
    modelCount: providerModels.length,
  });
}
