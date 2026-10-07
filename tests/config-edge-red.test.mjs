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

function writeConfig(raw) {
  const dir = mkdtempSync(join(tmpdir(), "pi-kiro-provider-config-edge-"));
  writeFileSync(join(dir, "config.json"), JSON.stringify(raw), "utf-8");
  return dir;
}

test("loadConfig ignores negative model cost values instead of producing negative usage pricing metadata", () => {
  const { config } = loadConfig(writeConfig({
    models: [{
      id: "edge-model",
      name: "Edge Model",
      cost: { input: -1, output: -2, cacheRead: -3, cacheWrite: -4 },
    }],
  }));

  assert.deepEqual(config.models[0].cost, {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
  });
});

test("loadConfig drops cache checkpoint limits when prompt caching is explicitly disabled", () => {
  const { config } = loadConfig(writeConfig({
    models: [{
      id: "no-cache-model",
      name: "No Cache Model",
      promptCaching: {
        supportsPromptCaching: false,
        maximumCacheCheckpointsPerRequest: 4,
        minimumTokensPerCacheCheckpoint: 1024,
      },
    }],
  }));

  assert.deepEqual(config.models[0].promptCaching, { supportsPromptCaching: false });
});

test("loadConfig defaults pricing and discovery origin, and honors overrides", () => {
  const defaults = loadConfig(writeConfig({})).config;
  assert.equal(defaults.pricing.usdPerCredit, 0.04);
  assert.equal(defaults.modelDiscovery.origin, "KIRO_CLI");
  assert.equal(defaults.modelDiscovery.ttlMs, 86_400_000);

  const overridden = loadConfig(writeConfig({
    pricing: { usdPerCredit: 0.05 },
    modelDiscovery: { origin: "AI_EDITOR" },
  })).config;
  assert.equal(overridden.pricing.usdPerCredit, 0.05);
  assert.equal(overridden.modelDiscovery.origin, "AI_EDITOR");
});

test("loadConfig accepts comments in config.json but leaves comment-like text inside strings alone", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-kiro-provider-config-comments-"));
  writeFileSync(join(dir, "config.json"), `{
  // line comment
  "displayName": "http://example/*not a comment*/", /* block */
  "pricing": { "usdPerCredit": 0.05 } // trailing
}`, "utf-8");
  const { config, warnings } = loadConfig(dir);
  assert.deepEqual(warnings, []);
  assert.equal(config.displayName, "http://example/*not a comment*/");
  assert.equal(config.pricing.usdPerCredit, 0.05);
});
