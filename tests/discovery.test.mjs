import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const buildDir = process.env.PI_KIRO_PROVIDER_BUILD_DIR;
if (!buildDir) throw new Error("PI_KIRO_PROVIDER_BUILD_DIR is required.");

const fromBuild = (path) => pathToFileURL(join(buildDir, path)).href;
const { loadConfig, createModelFromRaw } = await import(fromBuild("src/config.js"));
const { discoverKiroCatalog, applyDiscoveredModels } = await import(fromBuild("src/discovery.js"));
const { readCatalogCache, writeCatalogCache } = await import(fromBuild("src/catalog-cache.js"));

const PROFILE_ARN = "arn:aws:codewhisperer:us-east-1:123456789012:profile/ABCDEF";

function writeConfig(raw) {
  const dir = mkdtempSync(join(tmpdir(), "pi-kiro-provider-discovery-"));
  writeFileSync(join(dir, "config.json"), JSON.stringify(raw), "utf-8");
  return dir;
}

const LIVE_MODELS = [
  {
    modelId: "gpt-5.6-terra",
    rateMultiplier: 1.0,
    rateUnit: "credit",
    promptCaching: { supportsPromptCaching: true, maximumCacheCheckpointsPerRequest: null, minimumTokensPerCacheCheckpoint: null },
    tokenLimits: { maxInputTokens: 272000, maxOutputTokens: 128000 },
  },
  {
    modelId: "claude-sonnet-4.5",
    rateMultiplier: 1.3,
    rateUnit: "credit",
    tokenLimits: { maxInputTokens: 200000, maxOutputTokens: 64000 },
  },
];

test("discoverKiroCatalog sends origin (the API 400s without it) and parses live fields", async () => {
  const originalFetch = globalThis.fetch;
  const urls = [];
  try {
    globalThis.fetch = async (url) => {
      const parsed = new URL(String(url));
      urls.push(parsed);
      if (!parsed.searchParams.has("origin")) {
        return new Response(JSON.stringify({ message: "Value null at 'origin' failed to satisfy constraint" }), { status: 400 });
      }
      return new Response(JSON.stringify({ models: LIVE_MODELS }), { status: 200 });
    };

    const snapshot = await discoverKiroCatalog("token", {
      profileArn: PROFILE_ARN,
      discovery: { enabled: true, origin: "KIRO_CLI", ttlMs: 1 },
    });

    assert.equal(urls.length, 1);
    assert.equal(urls[0].host, "management.us-east-1.kiro.dev");
    assert.equal(urls[0].searchParams.get("origin"), "KIRO_CLI");
    assert.equal(snapshot.region, "us-east-1");
    assert.equal(snapshot.profileArn, PROFILE_ARN);
    assert.deepEqual(snapshot.models.map((model) => model.id), ["gpt-5.6-terra", "claude-sonnet-4.5"]);
    const [terra, sonnet] = snapshot.models;
    assert.equal(terra.contextWindow, 272000);
    assert.equal(terra.maxTokens, 128000);
    assert.equal(terra.rateMultiplier, 1);
    assert.deepEqual(terra.promptCaching, { supportsPromptCaching: true });
    assert.equal(sonnet.rateMultiplier, 1.3);
    assert.equal(sonnet.promptCaching, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("applyDiscoveredModels makes the live catalog authoritative while keeping known-model tuning", () => {
  const { config } = loadConfig(writeConfig({}));
  const sonnetBefore = config.models.find((model) => model.id === "claude-sonnet-4.5");
  assert.ok(sonnetBefore, "default list must include claude-sonnet-4.5");
  const snapshot = {
    profileArn: PROFILE_ARN,
    region: "us-east-1",
    fetchedAt: Date.now(),
    models: [
      { id: "gpt-5.6-terra", name: "gpt-5.6-terra", contextWindow: 272000, maxTokens: 128000, rateMultiplier: 1 },
      { id: "claude-sonnet-4.5", name: "claude-sonnet-4.5", contextWindow: 200000, maxTokens: 64000 },
    ],
  };

  const result = applyDiscoveredModels(config.models, snapshot, (raw) => createModelFromRaw(raw, config.modelDefaults));

  assert.deepEqual(result.map((model) => model.id), ["gpt-5.6-terra", "claude-sonnet-4.5"]);
  const [terra, sonnet] = result;
  assert.equal(sonnet.name, sonnetBefore.name);
  assert.deepEqual(sonnet.thinkingLevelMap, sonnetBefore.thinkingLevelMap);
  assert.equal(sonnet.maxTokens, 64000);
  assert.equal(terra.api, "kiro");
  assert.equal(terra.rateMultiplier, 1);
  assert.equal(terra.importOwnership, "model-discovery");
  assert.deepEqual(terra.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  assert.equal(terra.contextWindow, 272000);

  assert.equal(applyDiscoveredModels(config.models, undefined, () => null), config.models);
});

test("catalog cache round-trips and rejects corrupt or wrong-version files", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-kiro-provider-cache-"));
  const path = join(dir, "nested", "kiro-models.json");
  const snapshot = {
    profileArn: PROFILE_ARN,
    region: "us-east-1",
    fetchedAt: 1_700_000_000_000,
    models: [{ id: "gpt-5.6-terra", name: "gpt-5.6-terra", contextWindow: 272000 }],
  };

  assert.equal(readCatalogCache(path), undefined);
  writeCatalogCache(path, snapshot);
  assert.deepEqual(readCatalogCache(path), snapshot);

  writeFileSync(path, "{not json", "utf-8");
  assert.equal(readCatalogCache(path), undefined);

  writeFileSync(path, JSON.stringify({ version: 2, ...snapshot }), "utf-8");
  assert.equal(readCatalogCache(path), undefined);
});

test("collectKiroCredits sums metering per day/model, filters provider and age", async () => {
  const { collectKiroCredits } = await import(fromBuild("src/credits.js"));
  const dir = mkdtempSync(join(tmpdir(), "pi-kiro-provider-credits-"));
  const now = Date.now();
  const line = (provider, model, at, usage) => JSON.stringify({ type: "message", message: { provider, model, timestamp: at, diagnostics: [{ type: "kiro_metering", details: { usage, unit: "credit" } }] } });
  writeFileSync(join(dir, "a.jsonl"), [
    line("kiro", "m1", now, 0.25), line("kiro", "m1", now, 0.5), line("other", "m1", now, 9), line("kiro", "m1", now - 30 * 86_400_000, 9),
  ].join("\n"));
  const rows = collectKiroCredits(dir, "kiro", now - 7 * 86_400_000);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].credits, 0.75);
  assert.equal(rows[0].requests, 2);
});

test("billingPeriodStart picks the most recent renewal day", async () => {
  const { billingPeriodStart } = await import(fromBuild("src/credits.js"));
  assert.equal(billingPeriodStart(new Date(2026, 9, 7), 15).getTime(), new Date(2026, 8, 15).getTime());
  assert.equal(billingPeriodStart(new Date(2026, 9, 15), 15).getTime(), new Date(2026, 9, 15).getTime());
  assert.equal(billingPeriodStart(new Date(2026, 0, 3), 10).getTime(), new Date(2025, 11, 10).getTime());
});
