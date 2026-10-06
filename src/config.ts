import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";

import { omitAuthorizationHeaders } from "./headers.js";
import { isRecord, optionalString, positiveFiniteNumber as numberOr } from "./shared/index.js";

export const KIRO_API = "kiro" as const;

export type ThinkingLevelKey = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
export type ThinkingLevelMap = Partial<Record<ThinkingLevelKey, string | null>>;

export interface KiroPromptCachingConfig {
  supportsPromptCaching: boolean;
  maximumCacheCheckpointsPerRequest?: number;
  minimumTokensPerCacheCheckpoint?: number;
}

export type KiroProviderModelConfig = ProviderModelConfig & {
  thinkingLevelMap?: ThinkingLevelMap;
  importOwnership?: "model-discovery" | "manual" | string;
  rateMultiplier?: number;
  rateUnit?: string;
  promptCaching?: KiroPromptCachingConfig;
};

export type KiroAuthMethod = "builder-id" | "google" | "github";
export type KiroAuthMethodLabels = Record<KiroAuthMethod, string>;

export interface KiroOAuthConfig {
  providerId?: string;
  requestTimeoutMs?: number;
  region: string;
  startUrl: string;
  clientName: string;
  clientType: string;
  scopes: string[];
  grantTypes: string[];
  issuerUrl?: string;
  skipIssuerUrlForRegistration: boolean;
  socialPortalUrl: string;
  socialPortalRedirectUri: string;
  socialCallbackPath: string;
  socialAuthorizeUrl: string;
  socialTokenUrl: string;
  socialRefreshUrl: string;
  socialRedirectUri: string;
  methodLabels: KiroAuthMethodLabels;
}

export type KiroEndpoint = "codewhisperer" | "amazonq";

export interface ExtensionConfig {
  enabled: boolean;
  debug: boolean;
  providerId: string;
  displayName: string;
  upstreamUrl: string;
  endpoint: KiroEndpoint;
  apiKey: string;
  requestTimeoutMs: number;
  profileArn?: string;
  headers: Record<string, string>;
  models: KiroProviderModelConfig[];
  oauth: KiroOAuthConfig;
  modelDiscovery: { enabled: boolean; origin?: string };
}

export interface ConfigLoadResult {
  config: ExtensionConfig;
  warnings: string[];
}

type RawModel = Record<string, unknown>;

const KIRO_MAX_OUTPUT_TOKENS = 32_000;
const KIRO_PROMPT_CACHING_1024 = { supportsPromptCaching: true, maximumCacheCheckpointsPerRequest: 4, minimumTokensPerCacheCheckpoint: 1_024 } satisfies KiroPromptCachingConfig;
const KIRO_PROMPT_CACHING_4096 = { supportsPromptCaching: true, maximumCacheCheckpointsPerRequest: 4, minimumTokensPerCacheCheckpoint: 4_096 } satisfies KiroPromptCachingConfig;
const KIRO_PROMPT_CACHING_DISABLED = { supportsPromptCaching: false } satisfies KiroPromptCachingConfig;
const ANTHROPIC_REASONING_MAP = { off: "disabled", minimal: "low", low: "low", medium: "medium", high: "high", xhigh: null } satisfies ThinkingLevelMap;
const ANTHROPIC_OPUS_4_7_REASONING_MAP = { ...ANTHROPIC_REASONING_MAP, xhigh: "xhigh" } satisfies ThinkingLevelMap;
const ANTHROPIC_MAX_REASONING_MAP = { ...ANTHROPIC_REASONING_MAP, xhigh: "max" } satisfies ThinkingLevelMap;

function defaultThinkingLevelMapForModel(id: string, name: string): ThinkingLevelMap | undefined {
  const identity = `${id} ${name}`.toLowerCase();
  if (/claude[-\s_/]*opus[-\s_/]*4[.-]?7\b/.test(identity)) return { ...ANTHROPIC_OPUS_4_7_REASONING_MAP };
  if (/claude[-\s_/]*(?:opus|sonnet)[-\s_/]*4[.-]?6\b/.test(identity)) return { ...ANTHROPIC_MAX_REASONING_MAP };
  return undefined;
}

const DEFAULT_MODELS: RawModel[] = [
  { id: "auto", name: "Auto", reasoning: true, contextWindow: 1_000_000, maxTokens: KIRO_MAX_OUTPUT_TOKENS, rateMultiplier: 1.0, rateUnit: "Credit", promptCaching: KIRO_PROMPT_CACHING_1024, importOwnership: "model-discovery" },
  { id: "claude-opus-4.7", name: "Claude Opus 4.7", reasoning: true, thinkingLevelMap: ANTHROPIC_OPUS_4_7_REASONING_MAP, contextWindow: 1_000_000, maxTokens: KIRO_MAX_OUTPUT_TOKENS, rateMultiplier: 2.2, rateUnit: "Credit", promptCaching: KIRO_PROMPT_CACHING_4096, importOwnership: "model-discovery" },
  { id: "claude-opus-4.6", name: "Claude Opus 4.6", reasoning: true, thinkingLevelMap: ANTHROPIC_MAX_REASONING_MAP, contextWindow: 1_000_000, maxTokens: KIRO_MAX_OUTPUT_TOKENS, rateMultiplier: 2.2, rateUnit: "Credit", promptCaching: KIRO_PROMPT_CACHING_4096, importOwnership: "model-discovery" },
  { id: "claude-sonnet-4.6", name: "Claude Sonnet 4.6", reasoning: true, thinkingLevelMap: ANTHROPIC_MAX_REASONING_MAP, contextWindow: 1_000_000, maxTokens: KIRO_MAX_OUTPUT_TOKENS, rateMultiplier: 1.3, rateUnit: "Credit", promptCaching: KIRO_PROMPT_CACHING_1024, importOwnership: "model-discovery" },
  { id: "claude-opus-4.5", name: "Claude Opus 4.5", reasoning: true, contextWindow: 200_000, maxTokens: KIRO_MAX_OUTPUT_TOKENS, rateMultiplier: 2.2, rateUnit: "Credit", promptCaching: KIRO_PROMPT_CACHING_4096, importOwnership: "model-discovery" },
  { id: "claude-sonnet-4.5", name: "Claude Sonnet 4.5", reasoning: true, contextWindow: 200_000, maxTokens: KIRO_MAX_OUTPUT_TOKENS, rateMultiplier: 1.3, rateUnit: "Credit", promptCaching: KIRO_PROMPT_CACHING_1024, importOwnership: "model-discovery" },
  { id: "claude-sonnet-4", name: "Claude Sonnet 4", reasoning: true, contextWindow: 200_000, maxTokens: KIRO_MAX_OUTPUT_TOKENS, rateMultiplier: 1.3, rateUnit: "Credit", promptCaching: KIRO_PROMPT_CACHING_1024, importOwnership: "model-discovery" },
  { id: "claude-haiku-4.5", name: "Claude Haiku 4.5", reasoning: true, contextWindow: 200_000, maxTokens: KIRO_MAX_OUTPUT_TOKENS, rateMultiplier: 0.4, rateUnit: "Credit", promptCaching: KIRO_PROMPT_CACHING_4096, importOwnership: "model-discovery" },
  { id: "deepseek-3.2", name: "DeepSeek 3.2", reasoning: true, contextWindow: 164_000, maxTokens: KIRO_MAX_OUTPUT_TOKENS, rateMultiplier: 0.25, rateUnit: "Credit", promptCaching: KIRO_PROMPT_CACHING_DISABLED, importOwnership: "model-discovery" },
  { id: "minimax-m2.5", name: "MiniMax M2.5", reasoning: true, contextWindow: 196_000, maxTokens: KIRO_MAX_OUTPUT_TOKENS, rateMultiplier: 0.25, rateUnit: "Credit", promptCaching: KIRO_PROMPT_CACHING_DISABLED, importOwnership: "model-discovery" },
  { id: "minimax-m2.1", name: "MiniMax M2.1", reasoning: true, contextWindow: 196_000, maxTokens: KIRO_MAX_OUTPUT_TOKENS, rateMultiplier: 0.15, rateUnit: "Credit", promptCaching: KIRO_PROMPT_CACHING_DISABLED, importOwnership: "model-discovery" },
  { id: "glm-5", name: "GLM-5", reasoning: true, contextWindow: 200_000, maxTokens: KIRO_MAX_OUTPUT_TOKENS, rateMultiplier: 0.5, rateUnit: "Credit", promptCaching: KIRO_PROMPT_CACHING_DISABLED, importOwnership: "model-discovery" },
  { id: "qwen3-coder-next", name: "Qwen3 Coder Next", reasoning: true, contextWindow: 256_000, maxTokens: KIRO_MAX_OUTPUT_TOKENS, rateMultiplier: 0.05, rateUnit: "Credit", promptCaching: KIRO_PROMPT_CACHING_DISABLED, importOwnership: "model-discovery" },
];

const DEFAULT_MODEL_DEFAULTS = {
  reasoning: true,
  input: ["text"] as Array<"text" | "image">,
  contextWindow: 200_000,
  maxTokens: KIRO_MAX_OUTPUT_TOKENS,
  cost: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
  },
};

const DEFAULT_OAUTH_CONFIG: KiroOAuthConfig = {
  requestTimeoutMs: 300_000,
  region: "us-east-1",
  startUrl: "https://view.awsapps.com/start",
  clientName: "kiro-oauth-client",
  clientType: "public",
  scopes: ["codewhisperer:completions", "codewhisperer:analysis", "codewhisperer:conversations"],
  grantTypes: ["urn:ietf:params:oauth:grant-type:device_code", "refresh_token"],
  issuerUrl: "https://identitycenter.amazonaws.com/ssoins-722374e8c3c8e6c6",
  skipIssuerUrlForRegistration: false,
  socialPortalUrl: "https://app.kiro.dev/signin",
  socialPortalRedirectUri: "http://localhost:3128",
  socialCallbackPath: "/oauth/callback",
  socialAuthorizeUrl: "https://prod.us-east-1.auth.desktop.kiro.dev/login",
  socialTokenUrl: "https://prod.us-east-1.auth.desktop.kiro.dev/oauth/token",
  socialRefreshUrl: "https://prod.us-east-1.auth.desktop.kiro.dev/refreshToken",
  socialRedirectUri: "kiro://kiro.kiroAgent/authenticate-success",
  methodLabels: {
    "builder-id": "AWS Builder ID",
    google: "Google",
    github: "GitHub",
  },
};

const THINKING_LEVEL_KEYS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

function stringOr(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
}

function booleanOr(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function optionalBoolean(value: unknown, fallback: boolean | undefined): boolean | undefined {
  return typeof value === "boolean" ? value : fallback;
}

function stringArrayOr(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return [...fallback];
  const parsed = value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0).map((entry) => entry.trim());
  return parsed.length > 0 ? parsed : [...fallback];
}

function stringRecordOr(value: unknown, fallback?: Record<string, string>): Record<string, string> | undefined {
  if (!isRecord(value)) return fallback ? { ...fallback } : undefined;
  const parsed = Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
  return Object.keys(parsed).length > 0 ? parsed : fallback ? { ...fallback } : undefined;
}

function methodLabelsOr(value: unknown, fallback: KiroAuthMethodLabels): KiroAuthMethodLabels {
  const raw = isRecord(value) ? value : {};
  return {
    "builder-id": stringOr(raw["builder-id"], fallback["builder-id"]),
    google: stringOr(raw.google, fallback.google),
    github: stringOr(raw.github, fallback.github),
  };
}

function recordOr(value: unknown, fallback?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (isRecord(value)) return { ...value };
  return fallback ? { ...fallback } : undefined;
}

function inputOr(value: unknown, fallback: Array<"text" | "image">): Array<"text" | "image"> {
  if (!Array.isArray(value)) return [...fallback];
  const parsed = value.filter((entry): entry is "text" | "image" => entry === "text" || entry === "image");
  return parsed.length > 0 ? parsed : [...fallback];
}

function nonNegativeCostOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function costOr(value: unknown, fallback: ProviderModelConfig["cost"]): ProviderModelConfig["cost"] {
  if (!isRecord(value)) return { ...fallback };
  return {
    input: nonNegativeCostOr(value.input, fallback.input),
    output: nonNegativeCostOr(value.output, fallback.output),
    cacheRead: nonNegativeCostOr(value.cacheRead, fallback.cacheRead),
    cacheWrite: nonNegativeCostOr(value.cacheWrite, fallback.cacheWrite),
  };
}

function thinkingLevelMapOr(value: unknown, fallback?: ThinkingLevelMap): ThinkingLevelMap | undefined {
  if (!isRecord(value)) return fallback ? { ...fallback } : undefined;
  const parsed: ThinkingLevelMap = {};
  for (const key of THINKING_LEVEL_KEYS) {
    if (typeof value[key] === "string" || value[key] === null) parsed[key] = value[key];
  }
  return Object.keys(parsed).length > 0 ? parsed : fallback ? { ...fallback } : undefined;
}

function promptCachingOr(value: unknown, fallback?: KiroPromptCachingConfig): KiroPromptCachingConfig | undefined {
  if (!isRecord(value)) return fallback ? { ...fallback } : undefined;
  if (typeof value.supportsPromptCaching !== "boolean") return fallback ? { ...fallback } : undefined;
  const output: KiroPromptCachingConfig = { supportsPromptCaching: value.supportsPromptCaching };
  if (!output.supportsPromptCaching) return output;
  const maximumCacheCheckpointsPerRequest = numberOr(value.maximumCacheCheckpointsPerRequest, 0);
  const minimumTokensPerCacheCheckpoint = numberOr(value.minimumTokensPerCacheCheckpoint, 0);
  if (maximumCacheCheckpointsPerRequest > 0) output.maximumCacheCheckpointsPerRequest = maximumCacheCheckpointsPerRequest;
  if (minimumTokensPerCacheCheckpoint > 0) output.minimumTokensPerCacheCheckpoint = minimumTokensPerCacheCheckpoint;
  return output;
}

function endpointOr(value: unknown, upstreamUrl: string): KiroEndpoint {
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["amazonq", "amazon-q", "q", "cli"].includes(normalized)) return "amazonq";
    if (["codewhisperer", "code-whisperer", "ide"].includes(normalized)) return "codewhisperer";
  }
  try {
    return new URL(upstreamUrl).hostname.toLowerCase() === "q.us-east-1.amazonaws.com" ? "amazonq" : "codewhisperer";
  } catch {
    return "codewhisperer";
  }
}

function sanitizeHeaderConfig(headers: Record<string, string> | undefined, warnings: string[], path: string): Record<string, string> | undefined {
  let dropped = false;
  const sanitized = omitAuthorizationHeaders(headers, () => {
    dropped = true;
  });
  if (dropped) warnings.push(`Authorization header entries in ${path} are ignored; Kiro credentials are selected by the provider and pi-multi-auth.`);
  return Object.keys(sanitized).length > 0 ? sanitized : undefined;
}

function modelDefaultsFrom(raw: Record<string, unknown>, warnings: string[]): Omit<KiroProviderModelConfig, "id" | "name"> {
  const defaults = isRecord(raw.modelDefaults) ? raw.modelDefaults : {};
  return {
    api: KIRO_API,
    reasoning: booleanOr(defaults.reasoning, DEFAULT_MODEL_DEFAULTS.reasoning),
    thinkingLevelMap: thinkingLevelMapOr(defaults.thinkingLevelMap),
    input: inputOr(defaults.input, DEFAULT_MODEL_DEFAULTS.input),
    contextWindow: numberOr(defaults.contextWindow, DEFAULT_MODEL_DEFAULTS.contextWindow),
    maxTokens: numberOr(defaults.maxTokens, DEFAULT_MODEL_DEFAULTS.maxTokens),
    cost: costOr(defaults.cost, DEFAULT_MODEL_DEFAULTS.cost),
    headers: sanitizeHeaderConfig(stringRecordOr(defaults.headers), warnings, "modelDefaults.headers"),
    compat: recordOr(defaults.compat) as ProviderModelConfig["compat"],
    importOwnership: optionalString(defaults.importOwnership),
    promptCaching: promptCachingOr(defaults.promptCaching),
  };
}

function normalizeModel(rawModel: unknown, defaults: Omit<KiroProviderModelConfig, "id" | "name">, warnings: string[], index: number): KiroProviderModelConfig | null {
  if (!isRecord(rawModel)) return null;
  const id = stringOr(rawModel.id, "");
  if (!id) return null;
  const name = stringOr(rawModel.name, id);
  const thinkingLevelMap = thinkingLevelMapOr(rawModel.thinkingLevelMap, defaults.thinkingLevelMap) ?? defaultThinkingLevelMapForModel(id, name);

  const model: KiroProviderModelConfig = {
    id,
    name,
    api: KIRO_API,
    reasoning: booleanOr(rawModel.reasoning, defaults.reasoning),
    thinkingLevelMap,
    input: inputOr(rawModel.input, defaults.input),
    contextWindow: numberOr(rawModel.contextWindow, defaults.contextWindow),
    maxTokens: numberOr(rawModel.maxTokens, defaults.maxTokens),
    cost: costOr(rawModel.cost, defaults.cost),
    headers: sanitizeHeaderConfig(stringRecordOr(rawModel.headers, defaults.headers), warnings, `models[${index}].headers`),
    compat: recordOr(rawModel.compat, defaults.compat as Record<string, unknown> | undefined) as ProviderModelConfig["compat"],
    importOwnership: optionalString(rawModel.importOwnership) ?? defaults.importOwnership,
    rateMultiplier: typeof rawModel.rateMultiplier === "number" && Number.isFinite(rawModel.rateMultiplier) ? rawModel.rateMultiplier : defaults.rateMultiplier,
    rateUnit: optionalString(rawModel.rateUnit) ?? defaults.rateUnit,
    promptCaching: promptCachingOr(rawModel.promptCaching, defaults.promptCaching),
  };

  for (const key of ["thinkingLevelMap", "headers", "compat", "importOwnership", "rateMultiplier", "rateUnit", "promptCaching"] as const) {
    if (model[key] === undefined) delete model[key];
  }
  return model;
}

function readRawConfig(extensionRoot: string, warnings: string[]): Record<string, unknown> {
  try {
    const parsed = JSON.parse(readFileSync(join(extensionRoot, "config.json"), "utf-8")) as unknown;
    if (isRecord(parsed)) return parsed;
    warnings.push("config.json root must be an object; using defaults.");
  } catch (error) {
    warnings.push(`Unable to read config.json; using defaults: ${error instanceof Error ? error.message : "unknown error"}`);
  }
  return {};
}

function normalizeOAuthConfig(rawOAuth: unknown, fallbackRequestTimeoutMs = DEFAULT_OAUTH_CONFIG.requestTimeoutMs ?? 300_000): KiroOAuthConfig {
  const raw = isRecord(rawOAuth) ? rawOAuth : {};
  const region = stringOr(raw.region, DEFAULT_OAUTH_CONFIG.region);
  return {
    requestTimeoutMs: numberOr(raw.requestTimeoutMs, fallbackRequestTimeoutMs),
    region,
    startUrl: stringOr(raw.startUrl, DEFAULT_OAUTH_CONFIG.startUrl),
    clientName: stringOr(raw.clientName, DEFAULT_OAUTH_CONFIG.clientName),
    clientType: stringOr(raw.clientType, DEFAULT_OAUTH_CONFIG.clientType),
    scopes: stringArrayOr(raw.scopes, DEFAULT_OAUTH_CONFIG.scopes),
    grantTypes: stringArrayOr(raw.grantTypes, DEFAULT_OAUTH_CONFIG.grantTypes),
    issuerUrl: optionalString(raw.issuerUrl) ?? DEFAULT_OAUTH_CONFIG.issuerUrl,
    skipIssuerUrlForRegistration: booleanOr(raw.skipIssuerUrlForRegistration, DEFAULT_OAUTH_CONFIG.skipIssuerUrlForRegistration),
    socialPortalUrl: stringOr(raw.socialPortalUrl, DEFAULT_OAUTH_CONFIG.socialPortalUrl),
    socialPortalRedirectUri: stringOr(raw.socialPortalRedirectUri, DEFAULT_OAUTH_CONFIG.socialPortalRedirectUri),
    socialCallbackPath: stringOr(raw.socialCallbackPath, DEFAULT_OAUTH_CONFIG.socialCallbackPath),
    socialAuthorizeUrl: stringOr(raw.socialAuthorizeUrl, DEFAULT_OAUTH_CONFIG.socialAuthorizeUrl),
    socialTokenUrl: stringOr(raw.socialTokenUrl, DEFAULT_OAUTH_CONFIG.socialTokenUrl),
    socialRefreshUrl: stringOr(raw.socialRefreshUrl, DEFAULT_OAUTH_CONFIG.socialRefreshUrl),
    socialRedirectUri: stringOr(raw.socialRedirectUri, DEFAULT_OAUTH_CONFIG.socialRedirectUri),
    methodLabels: methodLabelsOr(raw.methodLabels, DEFAULT_OAUTH_CONFIG.methodLabels),
  };
}

function normalizeModelList(rawModels: unknown, defaults: Omit<KiroProviderModelConfig, "id" | "name">, warnings: string[]): KiroProviderModelConfig[] {
  if (!Array.isArray(rawModels)) return [];
  return rawModels.map((model, index) => normalizeModel(model, defaults, warnings, index)).filter((model): model is KiroProviderModelConfig => model !== null);
}

export function loadConfig(extensionRoot: string): ConfigLoadResult {
  const warnings: string[] = [];
  const raw = readRawConfig(extensionRoot, warnings);
  const defaults = modelDefaultsFrom(raw, warnings);
  const models = normalizeModelList(Array.isArray(raw.models) ? raw.models : DEFAULT_MODELS, defaults, warnings);

  if (models.length === 0) {
    warnings.push("No valid models were configured; using the default Kiro model list.");
    models.push(...normalizeModelList(DEFAULT_MODELS, defaults, warnings));
  }

  const upstreamUrl = stringOr(raw.upstreamUrl, "https://codewhisperer.us-east-1.amazonaws.com/generateAssistantResponse");
  return {
    config: {
      enabled: booleanOr(raw.enabled, true),
      debug: booleanOr(raw.debug, false),
      providerId: stringOr(raw.providerId, "kiro"),
      displayName: stringOr(raw.displayName, "Kiro"),
      upstreamUrl,
      endpoint: endpointOr(raw.endpoint, upstreamUrl),
      apiKey: stringOr(raw.apiKey, "$KIRO_ACCESS_TOKEN"),
      requestTimeoutMs: numberOr(raw.requestTimeoutMs, 600_000),
      profileArn: optionalString(raw.profileArn),
      headers: sanitizeHeaderConfig(stringRecordOr(raw.headers), warnings, "headers") ?? {},
      models,
      oauth: normalizeOAuthConfig(raw.oauth, numberOr(raw.requestTimeoutMs, 600_000)),
      modelDiscovery: {
        enabled: booleanOr(isRecord(raw.modelDiscovery) ? raw.modelDiscovery.enabled : undefined, true),
        origin: isRecord(raw.modelDiscovery) ? optionalString(raw.modelDiscovery.origin) : undefined,
      },
    },
    warnings,
  };
}
