import type { Api, Model } from "@earendil-works/pi-ai";
import type { OAuthCredentials } from "@earendil-works/pi-ai/oauth";

import type { DebugLogger } from "./debug-logger.js";
import { isRecord, nonEmptyString } from "./shared/index.js";

/**
 * Model discovery: asks Kiro's management API which profile and models this account can use,
 * the same way Kiro's own clients do, and stores the result on the OAuth credentials so it is
 * persisted alongside them and refreshed whenever the token is refreshed.
 *
 * Requests identify themselves honestly as this extension. The optional `origin` setting is
 * passed through only if the user configures one.
 */

export interface ModelDiscoveryConfig {
  enabled: boolean;
  origin?: string;
}

export interface DiscoveredKiroModel {
  id: string;
  name: string;
  contextWindow?: number;
  maxTokens?: number;
}

export interface DiscoveryResult {
  profileArn: string;
  kiroModels: DiscoveredKiroModel[];
  kiroModelsRegion: string;
  kiroModelsFetchedAt: number;
}

const MANAGEMENT_REGIONS = ["us-east-1", "eu-central-1"];
const AWS_REGION_PATTERN = /^[a-z]{2}(?:-[a-z]+)+-\d$/;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_PAGES = 10;
const USER_AGENT = "pi-kiro-provider (fork; model discovery)";

class ManagementHttpError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "KiroManagementHttpError";
  }
}

export function regionFromProfileArn(profileArn: string | undefined): string | undefined {
  const region = profileArn?.split(":")[3];
  return region && AWS_REGION_PATTERN.test(region) ? region : undefined;
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

async function managementRequest(region: string, path: string, method: "GET" | "POST", accessToken: string, params: Record<string, string | undefined>): Promise<Record<string, unknown>> {
  if (!AWS_REGION_PATTERN.test(region)) throw new Error(`Invalid Kiro management region: ${region}`);
  const url = new URL(path, `https://management.${region}.kiro.dev/`);
  const init: RequestInit = {
    method,
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${accessToken}`,
      "User-Agent": USER_AGENT,
      ...(method === "POST" ? { "Content-Type": "application/json" } : {}),
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  };
  const defined = Object.entries(params).filter((entry): entry is [string, string] => entry[1] !== undefined);
  if (method === "GET") for (const [name, value] of defined) url.searchParams.set(name, value);
  else init.body = JSON.stringify(Object.fromEntries(defined));

  const response = await fetch(url, init);
  if (!response.ok) throw new ManagementHttpError(`Kiro ${path} failed in ${region}: HTTP ${response.status}`, response.status);
  const body: unknown = await response.json().catch(() => undefined);
  if (!isRecord(body)) throw new Error(`Kiro ${path} returned invalid JSON in ${region}`);
  return body;
}

async function findProfileArn(accessToken: string, preferredRegion: string | undefined): Promise<string> {
  const regions = [...new Set([preferredRegion, ...MANAGEMENT_REGIONS].filter((r): r is string => Boolean(r)))];
  let lastError: unknown;
  for (const region of regions) {
    try {
      const body = await managementRequest(region, "List-Available-Profiles", "POST", accessToken, {});
      const profiles = Array.isArray(body.profiles) ? body.profiles : [];
      const arn = profiles.map((profile) => (isRecord(profile) ? nonEmptyString(profile.arn) : undefined)).find(Boolean);
      if (arn) return arn;
    } catch (error) {
      // A 403 or an unreachable endpoint in one region usually just means the profile lives in
      // another region, so try the next one. A 401 means the token itself was rejected.
      lastError = error;
      if (error instanceof ManagementHttpError && error.status === 401) throw error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`No Kiro profile found in ${regions.join(", ")}`);
}

async function listModels(accessToken: string, region: string, profileArn: string, origin: string | undefined): Promise<DiscoveredKiroModel[]> {
  const models: DiscoveredKiroModel[] = [];
  const seen = new Set<string>();
  let nextToken: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const body = await managementRequest(region, "List-Available-Models", "GET", accessToken, { profileArn, origin, nextToken });
    for (const raw of Array.isArray(body.models) ? body.models : []) {
      if (!isRecord(raw)) continue;
      const id = nonEmptyString(raw.modelId);
      if (!id || id.trim() !== id || seen.has(id)) continue;
      seen.add(id);
      const limits = isRecord(raw.tokenLimits) ? raw.tokenLimits : {};
      models.push({
        id,
        name: nonEmptyString(raw.displayName) ?? nonEmptyString(raw.modelName) ?? id,
        contextWindow: positiveNumber(limits.maxInputTokens),
        maxTokens: positiveNumber(limits.maxOutputTokens),
      });
    }
    nextToken = nonEmptyString(body.nextToken);
    if (!nextToken) break;
  }
  if (models.length === 0) throw new Error(`Kiro List-Available-Models returned no models in ${region}`);
  return models;
}

export async function discoverKiroCatalog(credentials: OAuthCredentials, configuredProfileArn: string | undefined, discovery: ModelDiscoveryConfig): Promise<DiscoveryResult> {
  const accessToken = nonEmptyString(credentials.access);
  if (!accessToken) throw new Error("Kiro model discovery requires an access token");
  const loginRegion = nonEmptyString(credentials.region);
  const profileArn = nonEmptyString(credentials.profileArn) ?? configuredProfileArn ?? (await findProfileArn(accessToken, loginRegion));
  const region = regionFromProfileArn(profileArn) ?? MANAGEMENT_REGIONS[0];
  const kiroModels = await listModels(accessToken, region, profileArn, discovery.origin);
  return { profileArn, kiroModels, kiroModelsRegion: region, kiroModelsFetchedAt: Date.now() };
}

/** Run discovery after login/refresh; on failure keep whatever catalog the credentials already had. */
export async function withDiscoveredCatalog<T extends OAuthCredentials>(
  credentials: T,
  previous: OAuthCredentials | undefined,
  configuredProfileArn: string | undefined,
  discovery: ModelDiscoveryConfig,
  logger: DebugLogger,
  providerId: string,
): Promise<T> {
  if (!discovery.enabled) return credentials;
  try {
    const result = await discoverKiroCatalog(credentials, configuredProfileArn, discovery);
    logger.debug("model_discovery_succeeded", { provider: providerId, region: result.kiroModelsRegion, modelCount: result.kiroModels.length });
    return { ...credentials, ...result };
  } catch (error) {
    logger.warn("model_discovery_failed", { provider: providerId, error });
    const keep = previous ?? credentials;
    return {
      ...credentials,
      ...(keep.kiroModels !== undefined ? { kiroModels: keep.kiroModels, kiroModelsRegion: keep.kiroModelsRegion, kiroModelsFetchedAt: keep.kiroModelsFetchedAt } : {}),
    };
  }
}

function storedCatalog(credentials: OAuthCredentials): DiscoveredKiroModel[] | undefined {
  const raw = credentials.kiroModels;
  if (!Array.isArray(raw)) return undefined;
  const models = raw.filter((model): model is DiscoveredKiroModel => isRecord(model) && Boolean(nonEmptyString(model.id)));
  return models.length > 0 ? models : undefined;
}

// Per-model tuning that only makes sense for the specific model it was written for.
const MODEL_SPECIFIC_FIELDS = ["thinkingLevelMap", "promptCaching", "rateMultiplier", "rateUnit", "importOwnership"] as const;

/**
 * Replace this provider's models with the discovered catalog. Models already defined in the
 * built-in list or config.json keep their tuning; new models are cloned from a neutral template.
 * Other providers' models are left untouched.
 */
export function applyDiscoveredModels(models: Model<Api>[], credentials: OAuthCredentials, providerId: string): Model<Api>[] {
  const catalog = storedCatalog(credentials);
  if (!catalog) return models;
  const ours = models.filter((model) => model.provider === providerId);
  if (ours.length === 0) return models;

  const template: Record<string, unknown> = { ...(ours.find((model) => model.id === "auto") ?? ours[0]) };
  for (const field of MODEL_SPECIFIC_FIELDS) delete template[field];

  const discovered = catalog.map((entry) => {
    const existing = ours.find((model) => model.id === entry.id);
    const base = (existing ?? template) as Model<Api>;
    return {
      ...base,
      id: entry.id,
      name: existing?.name ?? entry.name,
      contextWindow: entry.contextWindow ?? base.contextWindow,
      maxTokens: entry.maxTokens ?? base.maxTokens,
    } as Model<Api>;
  });

  const firstIndex = models.findIndex((model) => model.provider === providerId);
  const others = models.filter((model) => model.provider !== providerId);
  return [...others.slice(0, firstIndex), ...discovered, ...others.slice(firstIndex)];
}
