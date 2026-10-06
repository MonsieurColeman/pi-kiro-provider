import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const buildDir = process.env.PI_KIRO_PROVIDER_BUILD_DIR;
if (!buildDir) throw new Error("PI_KIRO_PROVIDER_BUILD_DIR is required.");

const fromBuild = (path) => pathToFileURL(join(buildDir, path)).href;
const { loadConfig } = await import(fromBuild("src/config.js"));
const { redactForDebugLog } = await import(fromBuild("src/debug-logger.js"));
const { classifyKiroHttpFailure, buildHeaders } = await import(fromBuild("src/kiro.js"));
const { classifyKiroOAuthFailure, createKiroOAuthProvider } = await import(fromBuild("src/oauth.js"));
const { default: kiroProviderExtension } = await import(fromBuild("src/index.js"));

const RUNTIME_PROVIDER_REGISTRATION_EVENT = "pi-multi-auth:runtime-provider-registration";
const MULTI_AUTH_PROVIDERS_REGISTERED_EVENT = "pi-multi-auth:providers-registered";

function createOAuthConfig(overrides = {}) {
  return {
    region: "us-east-1",
    startUrl: "https://example.invalid/start",
    clientName: "test",
    clientType: "public",
    scopes: ["scope"],
    grantTypes: ["refresh_token"],
    skipIssuerUrlForRegistration: false,
    socialAuthorizeUrl: "https://auth.example.invalid/login",
    socialTokenUrl: "https://auth.example.invalid/oauth/token",
    socialRefreshUrl: "https://auth.example.invalid/refreshToken",
    socialRedirectUri: "kiro://kiro.kiroAgent/authenticate-success",
    methodLabels: {
      "builder-id": "AWS Builder ID",
      google: "Google",
      github: "GitHub",
    },
    ...overrides,
  };
}

function writeConfig(raw) {
  const dir = mkdtempSync(join(tmpdir(), "pi-kiro-provider-config-"));
  writeFileSync(join(dir, "config.json"), JSON.stringify(raw), "utf-8");
  return dir;
}

function createFakeExtensionApi() {
  const listenersByEvent = new Map();
  const emittedEvents = [];
  const lifecycleHandlers = new Map();
  const registeredProviders = [];

  const events = {
    on(event, handler) {
      const listeners = listenersByEvent.get(event) ?? [];
      listeners.push(handler);
      listenersByEvent.set(event, listeners);
    },
    emit(event, payload) {
      emittedEvents.push({ event, payload });
      for (const listener of listenersByEvent.get(event) ?? []) {
        listener(payload);
      }
    },
  };

  return {
    emittedEvents,
    lifecycleHandlers,
    registeredProviders,
    pi: {
      events,
      on(event, handler) {
        const handlers = lifecycleHandlers.get(event) ?? [];
        handlers.push(handler);
        lifecycleHandlers.set(event, handlers);
      },
      registerProvider(name, config) {
        registeredProviders.push({ name, config });
      },
    },
  };
}

test("runtime provider registration replays after multi-auth readiness and before agent start", () => {
  const { pi, emittedEvents, lifecycleHandlers, registeredProviders } = createFakeExtensionApi();
  const runtimeEvents = () => emittedEvents.filter((entry) => entry.event === RUNTIME_PROVIDER_REGISTRATION_EVENT);

  kiroProviderExtension(pi);

  assert.equal(runtimeEvents().length, 1);
  assert.equal(runtimeEvents()[0].payload.provider, "kiro");
  assert.equal(runtimeEvents()[0].payload.api, "kiro");
  assert.equal(typeof runtimeEvents()[0].payload.streamSimple, "function");
  assert.equal(registeredProviders.length, 1);

  lifecycleHandlers.get("before_agent_start")?.[0]?.({}, { cwd: "/tmp/project" });

  assert.equal(runtimeEvents().length, 2);
  assert.equal(runtimeEvents()[1].payload.provider, "kiro");
  assert.equal(runtimeEvents()[1].payload.api, "kiro");
  assert.equal(typeof runtimeEvents()[1].payload.streamSimple, "function");

  pi.events.emit(MULTI_AUTH_PROVIDERS_REGISTERED_EVENT, { generation: 1 });

  assert.equal(runtimeEvents().length, 3);
  assert.equal(runtimeEvents()[2].payload.provider, "kiro");
  assert.equal(runtimeEvents()[2].payload.api, "kiro");
  assert.equal(typeof runtimeEvents()[2].payload.streamSimple, "function");
});

test("static, model, and request Authorization headers cannot override managed credentials", () => {
  const { config, warnings } = loadConfig(writeConfig({
    headers: { Authorization: "Bearer static-secret", "x-safe": "top" },
    modelDefaults: { headers: { authorization: "Bearer model-default-secret", "x-model-safe": "default" } },
    models: [{ id: "m", name: "M", headers: { AUTHORIZATION: "Bearer model-secret", "x-model": "ok" } }],
  }));

  assert.deepEqual(config.headers, { "x-safe": "top" });
  assert.equal(config.models[0].headers?.authorization, undefined);
  assert.equal(config.models[0].headers?.Authorization, undefined);
  assert.equal(config.models[0].headers?.AUTHORIZATION, undefined);
  assert.equal(config.models[0].headers?.["x-model"], "ok");
  assert.ok(warnings.some((warning) => warning.includes("Authorization header") && warning.includes("headers")));

  const headers = buildHeaders(config, "managed-token", { headers: { authorization: "Bearer request-secret", "x-request": "ok" } });
  assert.equal(headers.Authorization, "Bearer managed-token");
  assert.equal(headers.authorization, undefined);
  assert.equal(headers["x-request"], "ok");
});

test("Kiro HTTP auth failures expose refreshable metadata without treating quota 403 as refreshable", () => {
  const unauthorized = classifyKiroHttpFailure(401, { message: "expired bearer token" }, "managed");
  assert.equal(unauthorized.name, "KiroAuthFailureError");
  assert.equal(unauthorized.kiroAuth.refreshable, true);
  assert.equal(unauthorized.kiroAuth.status, 401);
  assert.equal(unauthorized.kiroAuth.credentialMode, "managed");

  const rejected = classifyKiroHttpFailure(403, { message: "auth-rejected: token rejected" }, "managed");
  assert.equal(rejected.kiroAuth.refreshable, true);
  assert.equal(rejected.kiroAuth.reason, "auth_rejected");

  const quota = classifyKiroHttpFailure(403, { message: "quota exceeded for this entitlement" }, "managed");
  assert.equal(quota.kiroAuth.refreshable, false);
  assert.equal(quota.kiroAuth.reason, "quota_or_entitlement");

  const unmanaged = classifyKiroHttpFailure(401, { message: "expired bearer token" }, "env-token");
  assert.equal(unmanaged.kiroAuth.refreshable, false);
  assert.equal(unmanaged.kiroAuth.credentialMode, "env-token");
  assert.match(unmanaged.message, /unmanaged and non-rotating/);
});

test("OAuth config preserves defaults while supporting social endpoints and method labels", () => {
  const { config } = loadConfig(writeConfig({}));

  assert.equal(config.oauth.socialAuthorizeUrl, "https://prod.us-east-1.auth.desktop.kiro.dev/login");
  assert.equal(config.oauth.socialTokenUrl, "https://prod.us-east-1.auth.desktop.kiro.dev/oauth/token");
  assert.equal(config.oauth.socialRefreshUrl, "https://prod.us-east-1.auth.desktop.kiro.dev/refreshToken");
  assert.equal(config.oauth.socialRedirectUri, "kiro://kiro.kiroAgent/authenticate-success");
  assert.deepEqual(config.oauth.methodLabels, {
    "builder-id": "AWS Builder ID",
    google: "Google",
    github: "GitHub",
  });
});

test("default model metadata matches Kiro ListAvailableModels discovery", () => {
  const { config } = loadConfig(writeConfig({}));
  const byId = new Map(config.models.map((model) => [model.id, model]));

  assert.equal(byId.get("auto")?.maxTokens, 32_000);
  assert.deepEqual(byId.get("auto")?.promptCaching, {
    supportsPromptCaching: true,
    maximumCacheCheckpointsPerRequest: 4,
    minimumTokensPerCacheCheckpoint: 1_024,
  });
  assert.equal(byId.get("claude-opus-4.7")?.maxTokens, 32_000);
  assert.deepEqual(byId.get("claude-opus-4.7")?.thinkingLevelMap, {
    off: "disabled",
    minimal: "low",
    low: "low",
    medium: "medium",
    high: "high",
    xhigh: "xhigh",
  });
  assert.deepEqual(byId.get("claude-opus-4.7")?.promptCaching, {
    supportsPromptCaching: true,
    maximumCacheCheckpointsPerRequest: 4,
    minimumTokensPerCacheCheckpoint: 4_096,
  });
  assert.equal(byId.get("claude-sonnet-4.6")?.thinkingLevelMap?.xhigh, "max");
  assert.deepEqual(byId.get("deepseek-3.2")?.promptCaching, { supportsPromptCaching: false });
});

test("OAuth social login uses single kiro provider id with exact state verification and callback paste", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  try {
    globalThis.fetch = async (url, init = {}) => {
      requests.push({ url: String(url), init });
      assert.equal(String(url), "https://auth.example.invalid/oauth/token");
      const body = JSON.parse(init.body);
      assert.equal(body.code, "social-code");
      assert.equal(body.redirect_uri, "kiro://kiro.kiroAgent/authenticate-success");
      assert.match(body.code_verifier, /^[A-Za-z0-9_-]{43,128}$/);
      return new Response(JSON.stringify({ accessToken: "social-access", refreshToken: "social-refresh", profileArn: "profile", expiresIn: 120 }), { status: 200 });
    };

    let selectedPrompt;
    let authUrl;
    const provider = createKiroOAuthProvider(createOAuthConfig(), { warn() {}, debug() {}, error() {} });
    const credentials = await provider.login({
      onSelect: async (prompt) => {
        selectedPrompt = prompt;
        return "google";
      },
      onAuth: (info) => {
        authUrl = info.url;
      },
      onPrompt: async () => {
        const state = new URL(authUrl).searchParams.get("state");
        return `kiro://kiro.kiroAgent/authenticate-success?code=social-code&state=${state}`;
      },
    });

    assert.equal(provider.id, "kiro");
    assert.deepEqual(selectedPrompt.options.map((option) => option.id), ["portal", "builder-id", "google", "github"]);
    const parsedAuthUrl = new URL(authUrl);
    assert.equal(parsedAuthUrl.searchParams.get("idp"), "Google");
    assert.equal(parsedAuthUrl.searchParams.get("code_challenge_method"), "S256");
    assert.equal(credentials.access, "social-access");
    assert.equal(credentials.refresh, "social-refresh");
    assert.equal(credentials.profileArn, "profile");
    assert.equal(credentials.authMethod, "google");
    assert.equal(requests.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("OAuth social callback rejects mismatched state without leaking callback secrets", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCount = 0;
  try {
    globalThis.fetch = async () => {
      fetchCount += 1;
      return new Response("{}", { status: 500 });
    };

    const provider = createKiroOAuthProvider(createOAuthConfig(), { warn() {}, debug() {}, error() {} });
    await assert.rejects(() => provider.login({
      onSelect: async () => "github",
      onAuth: () => {},
      onPrompt: async () => "kiro://kiro.kiroAgent/authenticate-success?code=secret-code&state=wrong-state",
    }), (error) => {
      assert.equal(error.name, "KiroOAuthFailureError");
      assert.equal(error.details.reason, "state_mismatch");
      assert.doesNotMatch(error.message, /secret-code|wrong-state/);
      return true;
    });
    assert.equal(fetchCount, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("OAuth modifyModels propagates profileArn into model headers", () => {
  const provider = createKiroOAuthProvider(createOAuthConfig(), { warn() {}, debug() {}, error() {} });
  const [model] = provider.modifyModels?.([{ id: "m", name: "M", api: "kiro", provider: "kiro", baseUrl: "https://example.invalid", reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1_000, maxTokens: 1_000, headers: { "x-existing": "ok" } }], { access: "access", refresh: "refresh", expires: Date.now() + 60_000, profileArn: "profile-arn" }) ?? [];
  assert.equal(model.headers["x-kiro-profile-arn"], "profile-arn");
  assert.equal(model.headers["x-existing"], "ok");
});

test("OAuth modifyModels reads profileArn from persisted request headers", () => {
  const provider = createKiroOAuthProvider(createOAuthConfig(), { warn() {}, debug() {}, error() {} });
  const [model] = provider.modifyModels?.([{ id: "m", name: "M", api: "kiro", provider: "kiro", baseUrl: "https://example.invalid", reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1_000, maxTokens: 1_000 }], { access: "access", refresh: "refresh", expires: Date.now() + 60_000, request: { headers: { "x-kiro-profile-arn": "persisted-profile" } } }) ?? [];
  assert.equal(model.headers["x-kiro-profile-arn"], "persisted-profile");
});

test("OAuth refresh routes explicitly by authMethod with legacy builder-id fallback", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  try {
    globalThis.fetch = async (url, init = {}) => {
      requests.push({ url: String(url), body: JSON.parse(init.body) });
      if (String(url).includes("oidc.us-east-1.amazonaws.com/token")) {
        return new Response(JSON.stringify({ accessToken: "builder-access", refreshToken: "builder-refresh", expiresIn: 60 }), { status: 200 });
      }
      if (String(url) === "https://auth.example.invalid/refreshToken") {
        return new Response(JSON.stringify({ accessToken: "social-access", refreshToken: "social-refresh", profileArn: "profile", expiresIn: 60 }), { status: 200 });
      }
      return new Response("{}", { status: 404 });
    };

    const provider = createKiroOAuthProvider(createOAuthConfig(), { warn() {}, debug() {}, error() {} });
    const legacy = await provider.refreshToken({ access: "old", refresh: "legacy-refresh", clientId: "client", clientSecret: "secret" });
    assert.equal(legacy.authMethod, "builder-id");
    assert.equal(legacy.access, "builder-access");
    assert.equal(requests[0].body.grantType, "refresh_token");

    const google = await provider.refreshToken({ access: "old", refresh: "google-refresh", authMethod: "google", clientId: "client", clientSecret: "secret" });
    assert.equal(google.authMethod, "google");
    assert.equal(google.access, "social-access");
    assert.equal(google.profileArn, "profile");
    assert.equal(requests[1].url, "https://auth.example.invalid/refreshToken");
    assert.deepEqual(requests[1].body, { refreshToken: "google-refresh" });

    await assert.rejects(() => provider.refreshToken({ access: "old", refresh: "bad-refresh", authMethod: "unsupported" }), (error) => {
      assert.equal(error.name, "OAuthRefreshFailureError");
      assert.equal(error.details.reason, "unsupported_auth_method");
      assert.equal(error.details.permanent, true);
      return true;
    });
    assert.equal(requests.length, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("OAuth refresh failures are classified as permanent reauth-required or transient retryable", async () => {
  const invalidGrant = classifyKiroOAuthFailure("refresh", "Kiro token refresh failed", {
    status: 400,
    body: { error: "invalid_grant", error_description: "refresh token secret-fragment was revoked" },
  });
  assert.equal(invalidGrant.name, "OAuthRefreshFailureError");
  assert.equal(invalidGrant.details.permanent, true);
  assert.equal(invalidGrant.details.reason, "token_rejected");
  assert.doesNotMatch(invalidGrant.message, /secret-fragment/);

  const throttled = classifyKiroOAuthFailure("refresh", "Kiro token refresh failed", {
    status: 429,
    body: { error: "slow_down", error_description: "try later" },
  });
  assert.equal(throttled.details.permanent, false);
  assert.equal(throttled.details.reason, "rate_limited");

  const provider = createKiroOAuthProvider(createOAuthConfig({ socialRefreshUrl: "https://example.invalid/refresh" }), { warn() {}, debug() {}, error() {} });
  await assert.rejects(() => provider.refreshToken({ access: "access", refresh: "" }), (error) => {
    assert.equal(error.name, "OAuthRefreshFailureError");
    assert.equal(error.details.permanent, true);
    assert.equal(error.details.reason, "missing_refresh_token");
    return true;
  });
});

test("debug redaction removes secrets from keys, sensitive strings, URLs, and nested errors", () => {
  const jwt = ["eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiJraXJvIn0", "signaturePart"].join(".");
  const redacted = redactForDebugLog({
    authorization: "Bearer live-secret-token",
    code: "oauth-code-secret",
    state: "oauth-state-secret",
    codeVerifier: "oauth-verifier-secret",
    url: `https://example.invalid/callback?access_token=${jwt}&code=callback-code-secret&state=callback-state-secret&code_verifier=callback-verifier-secret&safe=1`,
    nested: {
      error: new Error(`Authorization: Bearer nested-secret failed with ${jwt}`),
      fragments: "refresh_token=refresh-secret accessToken=access-secret code=fragment-code-secret state=fragment-state-secret verifier=fragment-verifier-secret",
    },
  });
  const serialized = JSON.stringify(redacted);

  assert.doesNotMatch(serialized, /live-secret-token|nested-secret|refresh-secret|access-secret|signaturePart|oauth-code-secret|oauth-state-secret|oauth-verifier-secret|callback-code-secret|callback-state-secret|callback-verifier-secret|fragment-code-secret|fragment-state-secret|fragment-verifier-secret/);
  assert.match(serialized, /\[REDACTED\]/);
  assert.match(serialized, /safe=1/);
});
