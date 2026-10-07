import { writeCatalogCache } from "./catalog-cache.js";
import type { KiroPromptCachingConfig, KiroProviderModelConfig } from "./config.js";
import type { DebugLogger } from "./debug-logger.js";
import { isRecord, nonEmptyString } from "./shared/index.js";

/**
 * Model discovery: asks Kiro's management API which profile and models this account can use,
 * the same way Kiro's own clients do. The result is a provider-level catalog cached on disk
 * (not stored on any single OAuth credential) and refreshed when stale or on login/refresh.
 *
 * Requests identify themselves honestly as this extension. The management API rejects
 * List-Available-Models without an `origin`, so one is always sent (default `KIRO_CLI`).
 */

export interface ModelDiscoveryConfig {
  enabled: boolean;
  origin: string;
  ttlMs: number;
}

export interface DiscoveredKiroModel {
  id: string;
  name: string;
  contextWindow?: number;
  maxTokens?: number;
  rateMultiplier?: number;
  rateUnit?: string;
  promptCaching?: KiroPromptCachingConfig;
}

export interface CatalogSnapshot {
  profileArn: string;
  region: string;
  fetchedAt: number;
  models: DiscoveredKiroModel[];
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

async function listModels(accessToken: string, region: string, profileArn: string, origin: string): Promise<DiscoveredKiroModel[]> {
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
      const model: DiscoveredKiroModel = {
        id,
        name: nonEmptyString(raw.displayName) ?? nonEmptyString(raw.modelName) ?? id,
        contextWindow: positiveNumber(limits.maxInputTokens),
        maxTokens: positiveNumber(limits.maxOutputTokens),
        rateMultiplier: positiveNumber(raw.rateMultiplier),
        rateUnit: nonEmptyString(raw.rateUnit),
      };
      if (isRecord(raw.promptCaching) && typeof raw.promptCaching.supportsPromptCaching === "boolean") {
        const promptCaching: KiroPromptCachingConfig = { supportsPromptCaching: raw.promptCaching.supportsPromptCaching };
        const maxCheckpoints = positiveNumber(raw.promptCaching.maximumCacheCheckpointsPerRequest);
        const minTokens = positiveNumber(raw.promptCaching.minimumTokensPerCacheCheckpoint);
        if (maxCheckpoints !== undefined) promptCaching.maximumCacheCheckpointsPerRequest = maxCheckpoints;
        if (minTokens !== undefined) promptCaching.minimumTokensPerCacheCheckpoint = minTokens;
        model.promptCaching = promptCaching;
      }
      models.push(model);
    }
    nextToken = nonEmptyString(body.nextToken);
    if (!nextToken) break;
  }
  if (models.length === 0) throw new Error(`Kiro List-Available-Models returned no models in ${region}`);
  return models;
}

/** Region of a Kiro/CodeWhisperer upstream URL such as `https://q.us-east-1.amazonaws.com/...`. */
export function regionFromUpstreamUrl(url: string): string | undefined {
  try {
    const match = /^(?:q|codewhisperer)\.([a-z]{2}(?:-[a-z]+)+-\d)\.amazonaws\.com$/.exec(new URL(url).hostname);
    return match && AWS_REGION_PATTERN.test(match[1]) ? match[1] : undefined;
  } catch {
    return undefined;
  }
}

export async function discoverKiroCatalog(
  accessToken: string,
  options: { profileArn?: string; regionHint?: string; discovery: ModelDiscoveryConfig },
): Promise<CatalogSnapshot> {
  const profileArn = options.profileArn ?? (await findProfileArn(accessToken, options.regionHint));
  const region = regionFromProfileArn(profileArn) ?? MANAGEMENT_REGIONS[0];
  const models = await listModels(accessToken, region, profileArn, options.discovery.origin);
  return { profileArn, region, fetchedAt: Date.now(), models };
}

/** Discover and cache the catalog. Never throws; on failure the existing cache stays in place. */
export async function refreshCatalog(args: {
  accessToken: string;
  profileArn?: string;
  regionHint?: string;
  discovery: ModelDiscoveryConfig;
  cachePath: string;
  logger: DebugLogger;
  providerId: string;
}): Promise<CatalogSnapshot | undefined> {
  if (!args.discovery.enabled) return undefined;
  try {
    const snapshot = await discoverKiroCatalog(args.accessToken, { profileArn: args.profileArn, regionHint: args.regionHint, discovery: args.discovery });
    writeCatalogCache(args.cachePath, snapshot);
    args.logger.debug("model_discovery_succeeded", { provider: args.providerId, region: snapshot.region, modelCount: snapshot.models.length });
    return snapshot;
  } catch (error) {
    args.logger.warn("model_discovery_failed", { provider: args.providerId, error });
    return undefined;
  }
}

export function isCatalogStale(snapshot: CatalogSnapshot | undefined, ttlMs: number, configuredProfileArn: string | undefined, now = Date.now()): boolean {
  if (!snapshot || now - snapshot.fetchedAt > ttlMs) return true;
  return configuredProfileArn !== undefined && configuredProfileArn !== snapshot.profileArn;
}

/**
 * The live catalog is authoritative: the result is exactly the snapshot's models, in snapshot order.
 * Models already defined in the built-in list or config.json keep their tuning (thinking map, cost,
 * reasoning, input); new models get the configured defaults via `createModel`.
 */
export function applyDiscoveredModels(
  models: KiroProviderModelConfig[],
  snapshot: CatalogSnapshot | undefined,
  createModel: (raw: Record<string, unknown>) => KiroProviderModelConfig | null,
): KiroProviderModelConfig[] {
  if (!snapshot || snapshot.models.length === 0) return models;
  const result: KiroProviderModelConfig[] = [];
  for (const entry of snapshot.models) {
    const existing = models.find((model) => model.id === entry.id);
    const model = createModel({
      ...(existing ?? {}),
      id: entry.id,
      name: existing?.name ?? entry.name,
      contextWindow: entry.contextWindow ?? existing?.contextWindow,
      maxTokens: entry.maxTokens ?? existing?.maxTokens,
      rateMultiplier: entry.rateMultiplier ?? existing?.rateMultiplier,
      rateUnit: entry.rateUnit ?? existing?.rateUnit,
      promptCaching: entry.promptCaching ?? existing?.promptCaching,
      importOwnership: existing?.importOwnership ?? "model-discovery",
    });
    if (model) result.push(model);
  }
  return result;
}
