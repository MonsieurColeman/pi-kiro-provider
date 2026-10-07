import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { CatalogSnapshot, DiscoveredKiroModel } from "./discovery.js";
import { isRecord, nonEmptyString } from "./shared/index.js";

const CACHE_VERSION = 1;

/** Read the provider-level catalog cache; returns undefined when missing, corrupt, or of another version. */
export function readCatalogCache(path: string): CatalogSnapshot | undefined {
  try {
    const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isRecord(raw) || raw.version !== CACHE_VERSION) return undefined;
    const profileArn = nonEmptyString(raw.profileArn);
    if (!profileArn || typeof raw.region !== "string" || typeof raw.fetchedAt !== "number" || !Number.isFinite(raw.fetchedAt) || !Array.isArray(raw.models)) return undefined;
    const models = raw.models.filter((model): model is DiscoveredKiroModel => isRecord(model) && Boolean(nonEmptyString(model.id)));
    if (models.length === 0) return undefined;
    return { profileArn, region: raw.region, fetchedAt: raw.fetchedAt, models };
  } catch {
    return undefined;
  }
}

/** Atomically write the catalog cache (temp file + rename). Errors propagate to the caller. */
export function writeCatalogCache(path: string, snapshot: CatalogSnapshot): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify({ version: CACHE_VERSION, ...snapshot }));
  renameSync(tmp, path);
}
