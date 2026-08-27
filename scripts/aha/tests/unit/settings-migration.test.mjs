// Tests for the settings migration pure function and the one-time
// simplification-notice trigger logic (issue #59).
//
// settings-migration.ts imports DEFAULT_SETTINGS/AhaPluginSettings from
// settings.ts, which imports `obsidian` (App/Notice/PluginSettingTab/Setting)
// plus llm-request.ts (requestUrl) transitively -- so this bundles both
// files together behind a minimal obsidian stub, the same pattern
// process-bridge.test.mjs established for process.ts.

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const repoRoot = path.resolve(import.meta.dirname, "../../../..");
const requireFromPlugin = createRequire(path.join(repoRoot, "obsidian-plugin/package.json"));
const esbuild = requireFromPlugin("esbuild");

function obsidianStubPlugin() {
  return {
    name: "obsidian-stub",
    setup(build) {
      build.onResolve({ filter: /^obsidian$/ }, () => ({ path: "obsidian", namespace: "obsidian-stub" }));
      build.onLoad({ filter: /.*/, namespace: "obsidian-stub" }, () => ({
        contents: [
          "export class App {}",
          "export class Notice {}",
          "export class PluginSettingTab {}",
          "export class Setting {}",
          "export async function requestUrl() { return { status: 200, text: '{}' }; }",
        ].join("\n"),
        loader: "js",
      }));
    },
  };
}

async function loadModule() {
  const temp = await mkdtemp(path.join(tmpdir(), "aha-settings-migration-test-"));
  const entry = path.join(temp, "entry.ts");
  const out = path.join(temp, "bundle.mjs");
  await writeFile(entry, [
    `export * from ${JSON.stringify(path.join(repoRoot, "obsidian-plugin/src/settings.ts"))};`,
    `export * from ${JSON.stringify(path.join(repoRoot, "obsidian-plugin/src/settings-migration.ts"))};`,
    "",
  ].join("\n"));
  await esbuild.build({
    bundle: true,
    entryPoints: [entry],
    format: "esm",
    outfile: out,
    platform: "node",
    plugins: [obsidianStubPlugin()],
    target: "es2022",
  });
  const loaded = await import(`${pathToFileURL(out).href}?cacheBust=${Date.now()}`);
  await rm(temp, { recursive: true, force: true });
  return loaded;
}

test("carried fields keep their old values when present and well-typed", async () => {
  const { migrateAhaPluginSettings } = await loadModule();
  const old = {
    deepseekBaseUrl: "https://custom.deepseek.example",
    deepseekModel: "deepseek-custom",
    deepseekApiKey: "ds-custom",
    deepseekApiKeyEnv: "CUSTOM_DEEPSEEK_KEY",
    targetCandidates: 17,
    qmdCommand: "/opt/custom/qmd",
    qmdIndex: "custom-index",
    qmdRerank: true,
    useFixtureResult: true,
    useLegacyWrapper: true,
  };

  const migrated = migrateAhaPluginSettings(old);

  for (const [key, value] of Object.entries(old)) {
    assert.equal(migrated[key], value, `${key} should carry over unchanged`);
  }
});

test("dead-field group resets to DEFAULT_SETTINGS regardless of old stored value", async () => {
  const { migrateAhaPluginSettings, DEFAULT_SETTINGS } = await loadModule();
  const old = {
    llmProvider: "openai",
    ahaWorkspace: "/old/workspace",
    wrapperRelativePath: "old/wrapper/path.mjs",
    nodeCommand: "/old/node",
    codexCommand: "/old/codex",
    codexModel: "old-codex-model",
    codexReasoningEffort: "high",
    codexSandbox: "workspace-write",
    obsidianCommand: "/old/obsidian",
    qmdRunner: "cli",
    qmdSdkModule: "/old/sdk-module.js",
  };

  const migrated = migrateAhaPluginSettings(old);

  for (const key of Object.keys(old)) {
    assert.equal(migrated[key], DEFAULT_SETTINGS[key], `${key} must reset to its DEFAULT_SETTINGS value, not the old stored value`);
    assert.notEqual(migrated[key], old[key], `${key} must not carry the old (non-default) value forward`);
  }
});

test("the six qmdRemote* fields are carried verbatim AND converted into qmdEnvironment", async () => {
  const { migrateAhaPluginSettings } = await loadModule();
  const old = {
    qmdRemoteEmbedUrl: "https://embed.example/v1",
    qmdRemoteEmbedModel: "embed-model",
    qmdRemoteGenerateUrl: "https://generate.example/v1",
    qmdRemoteGenerateModel: "generate-model",
    qmdRemoteRerankUrl: "https://rerank.example/v1",
    qmdRemoteRerankModel: "rerank-model",
  };

  const migrated = migrateAhaPluginSettings(old);

  // Carried verbatim (process.ts's frozen legacy wrapper still reads these).
  assert.equal(migrated.qmdRemoteEmbedUrl, "https://embed.example/v1");
  assert.equal(migrated.qmdRemoteEmbedModel, "embed-model");
  assert.equal(migrated.qmdRemoteGenerateUrl, "https://generate.example/v1");
  assert.equal(migrated.qmdRemoteGenerateModel, "generate-model");
  assert.equal(migrated.qmdRemoteRerankUrl, "https://rerank.example/v1");
  assert.equal(migrated.qmdRemoteRerankModel, "rerank-model");

  // Converted into the new qmdEnvironment multi-line field, using the exact
  // env-var names qmdChildEnv already used.
  const lines = migrated.qmdEnvironment.split("\n");
  assert.deepEqual(lines, [
    "QMD_REMOTE_EMBED_URL=https://embed.example/v1",
    "QMD_REMOTE_EMBED_MODEL=embed-model",
    "QMD_REMOTE_GENERATE_URL=https://generate.example/v1",
    "QMD_REMOTE_GENERATE_MODEL=generate-model",
    "QMD_REMOTE_RERANK_URL=https://rerank.example/v1",
    "QMD_REMOTE_RERANK_MODEL=rerank-model",
  ]);
});

test("blank/absent qmdRemote* fields do not produce blank qmdEnvironment lines", async () => {
  const { migrateAhaPluginSettings } = await loadModule();
  const migrated = migrateAhaPluginSettings({ qmdRemoteEmbedUrl: "https://embed.example/v1" });
  assert.equal(migrated.qmdEnvironment, "QMD_REMOTE_EMBED_URL=https://embed.example/v1");
});

test("new fields (excludedFolders, queryPromptOverride, traceDirectory) default when absent from the old object", async () => {
  const { migrateAhaPluginSettings, DEFAULT_SETTINGS } = await loadModule();
  const migrated = migrateAhaPluginSettings({});
  assert.equal(migrated.excludedFolders, DEFAULT_SETTINGS.excludedFolders);
  assert.equal(migrated.queryPromptOverride, DEFAULT_SETTINGS.queryPromptOverride);
  assert.equal(migrated.traceDirectory, DEFAULT_SETTINGS.traceDirectory);
  assert.equal(migrated.qmdEnvironment, DEFAULT_SETTINGS.qmdEnvironment);
});

test("migration is safe on null/undefined/non-object input", async () => {
  const { migrateAhaPluginSettings, DEFAULT_SETTINGS } = await loadModule();
  assert.deepEqual(migrateAhaPluginSettings(null), migrateAhaPluginSettings({}));
  assert.deepEqual(migrateAhaPluginSettings(undefined), migrateAhaPluginSettings({}));
  assert.deepEqual(migrateAhaPluginSettings("not an object"), migrateAhaPluginSettings({}));
  assert.equal(migrateAhaPluginSettings(null).llmProvider, DEFAULT_SETTINGS.llmProvider);
});

// A synthetic fixture with the real production settings object's exact key
// set (31 keys), since the real file's secret values cannot be shared here.
// Representative non-default values are used for every key so the test can
// distinguish "carried", "converted", and "dropped" behavior precisely.
const PRODUCTION_KEY_SET_FIXTURE = {
  ahaWorkspace: "/Users/example/Aha",
  codexCommand: "/opt/codex/bin/codex",
  codexModel: "gpt-5.3-codex-spark-prod",
  codexReasoningEffort: "medium",
  codexSandbox: "workspace-write",
  deepseekApiKey: "ds-prod-key",
  deepseekApiKeyEnv: "DEEPSEEK_API_KEY",
  deepseekBaseUrl: "https://api.deepseek.com",
  deepseekModel: "deepseek-v4-pro",
  llmApiKey: "sk-prod-key",
  llmApiKeyEnv: "OPENAI_API_KEY",
  llmBaseUrl: "https://api.openai.com/v1",
  llmModel: "gpt-5.5",
  llmProvider: "openai",
  nodeCommand: "/usr/local/bin/node",
  obsidianCommand: "/usr/local/bin/obsidian",
  qmdCommand: "/usr/local/bin/qmd",
  qmdIndex: "obsidian",
  qmdRemoteEmbedModel: "prod-embed-model",
  qmdRemoteEmbedUrl: "https://prod-embed.example/v1",
  qmdRemoteGenerateModel: "prod-generate-model",
  qmdRemoteGenerateUrl: "https://prod-generate.example/v1",
  qmdRemoteRerankModel: "prod-rerank-model",
  qmdRemoteRerankUrl: "https://prod-rerank.example/v1",
  qmdRerank: true,
  qmdRunner: "sdk",
  qmdSdkModule: "/opt/qmd/sdk.js",
  reviewFolder: "Aha/Reviews",
  targetCandidates: 18,
  useFixtureResult: false,
  wrapperRelativePath: "scripts/aha/run-insight-search.mjs",
};

test("a copy of the real production settings object's key set migrates losslessly (keys intact)", async () => {
  const { migrateAhaPluginSettings, DEFAULT_SETTINGS } = await loadModule();
  const migrated = migrateAhaPluginSettings(PRODUCTION_KEY_SET_FIXTURE);

  // Exact key-set match against the new AhaPluginSettings interface: no
  // stray extra keys, no missing required keys.
  assert.deepEqual(Object.keys(migrated).sort(), Object.keys(DEFAULT_SETTINGS).sort());

  // Carried fields keep the production fixture's values.
  assert.equal(migrated.deepseekModel, "deepseek-v4-pro");
  assert.equal(migrated.targetCandidates, 18);
  assert.equal(migrated.qmdCommand, "/usr/local/bin/qmd");
  assert.equal(migrated.qmdIndex, "obsidian");
  assert.equal(migrated.qmdRerank, true);
  assert.equal(migrated.useFixtureResult, false);

  // Dead-field group dropped (reset to defaults, not the fixture's values).
  // llmProvider: an old stored "openai" value is no longer valid (OpenAI
  // removed as a provider), so it resets to DEFAULT_SETTINGS ("deepseek")
  // like the rest of the dead-field group, rather than carrying forward.
  assert.equal(migrated.llmProvider, DEFAULT_SETTINGS.llmProvider);
  assert.notEqual(migrated.llmProvider, PRODUCTION_KEY_SET_FIXTURE.llmProvider);
  // llmApiKey/llmBaseUrl/llmModel/llmApiKeyEnv (old OpenAI-shaped fields)
  // were dropped from the interface entirely, not just reset.
  assert.equal(migrated.llmApiKey, undefined);
  assert.equal(migrated.llmBaseUrl, undefined);
  assert.equal(migrated.llmModel, undefined);
  assert.equal(migrated.llmApiKeyEnv, undefined);
  // reviewFolder (Review Note markdown export) was removed entirely, not
  // just reset.
  assert.equal(migrated.reviewFolder, undefined);
  assert.equal(migrated.ahaWorkspace, DEFAULT_SETTINGS.ahaWorkspace);
  assert.notEqual(DEFAULT_SETTINGS.ahaWorkspace, PRODUCTION_KEY_SET_FIXTURE.ahaWorkspace);
  assert.equal(migrated.nodeCommand, DEFAULT_SETTINGS.nodeCommand);
  assert.equal(migrated.codexCommand, DEFAULT_SETTINGS.codexCommand);
  assert.equal(migrated.codexModel, DEFAULT_SETTINGS.codexModel);
  assert.equal(migrated.codexReasoningEffort, DEFAULT_SETTINGS.codexReasoningEffort);
  assert.equal(migrated.codexSandbox, DEFAULT_SETTINGS.codexSandbox);
  assert.equal(migrated.obsidianCommand, DEFAULT_SETTINGS.obsidianCommand);
  assert.equal(migrated.qmdRunner, DEFAULT_SETTINGS.qmdRunner);
  assert.equal(migrated.qmdSdkModule, DEFAULT_SETTINGS.qmdSdkModule);

  // Endpoint-to-environment conversion.
  assert.match(migrated.qmdEnvironment, /QMD_REMOTE_EMBED_URL=https:\/\/prod-embed\.example\/v1/);
  assert.match(migrated.qmdEnvironment, /QMD_REMOTE_RERANK_MODEL=prod-rerank-model/);
  assert.equal(migrated.qmdRemoteEmbedUrl, "https://prod-embed.example/v1");

  // New fields land at defaults (not present in the old object).
  assert.equal(migrated.excludedFolders, DEFAULT_SETTINGS.excludedFolders);
  assert.equal(migrated.queryPromptOverride, DEFAULT_SETTINGS.queryPromptOverride);
  assert.equal(migrated.traceDirectory, DEFAULT_SETTINGS.traceDirectory);
});

test("migrating an already-migrated object is a no-op (idempotency)", async () => {
  const { migrateAhaPluginSettings } = await loadModule();
  const once = migrateAhaPluginSettings(PRODUCTION_KEY_SET_FIXTURE);
  const twice = migrateAhaPluginSettings(once);
  assert.deepEqual(twice, once);

  // Also idempotent starting from a completely empty (all-default) object.
  const defaultsOnce = migrateAhaPluginSettings({});
  const defaultsTwice = migrateAhaPluginSettings(defaultsOnce);
  assert.deepEqual(defaultsTwice, defaultsOnce);
});

test("a user upgrading from the pre-OpenAI-removal schemaVersion 2 release gets re-migrated off a stale llmProvider: openai value", async () => {
  // Regression test: the #59 release shipped schemaVersion 2 with
  // DEFAULT_SETTINGS.llmProvider === "openai". A user who ran that release
  // has data.json = { schemaVersion: 2, settings: { llmProvider: "openai", ... } }.
  // CURRENT_SETTINGS_SCHEMA_VERSION must be strictly greater than 2 so
  // shouldShowSimplificationNotice(2, CURRENT) is true and this old,
  // now-invalid llmProvider value gets migrated (reset to "deepseek") on
  // next load, instead of winning main.ts's plain
  // {...DEFAULT_SETTINGS, ...data.settings} merge and silently downgrading
  // the user to Recall Tier forever (resolveLlmRequestProfile only accepts
  // "deepseek" now, and the provider dropdown that could fix it by hand was
  // removed from the settings UI).
  const { migrateAhaPluginSettings, shouldShowSimplificationNotice, CURRENT_SETTINGS_SCHEMA_VERSION, DEFAULT_SETTINGS } = await loadModule();

  const storedSchemaVersion2Data = { schemaVersion: 2, llmProvider: "openai" };
  assert.equal(
    shouldShowSimplificationNotice(storedSchemaVersion2Data.schemaVersion, CURRENT_SETTINGS_SCHEMA_VERSION),
    true,
    "CURRENT_SETTINGS_SCHEMA_VERSION must have been bumped past 2 so this upgrade path re-migrates",
  );

  const migrated = migrateAhaPluginSettings(storedSchemaVersion2Data);
  assert.equal(migrated.llmProvider, DEFAULT_SETTINGS.llmProvider);
  assert.equal(migrated.llmProvider, "deepseek");
});

test("shouldShowSimplificationNotice fires exactly once per upgrade", async () => {
  const { shouldShowSimplificationNotice, CURRENT_SETTINGS_SCHEMA_VERSION } = await loadModule();
  assert.equal(shouldShowSimplificationNotice(undefined, CURRENT_SETTINGS_SCHEMA_VERSION), true);
  assert.equal(shouldShowSimplificationNotice(CURRENT_SETTINGS_SCHEMA_VERSION - 1, CURRENT_SETTINGS_SCHEMA_VERSION), true);
  assert.equal(shouldShowSimplificationNotice(CURRENT_SETTINGS_SCHEMA_VERSION, CURRENT_SETTINGS_SCHEMA_VERSION), false);
  assert.equal(shouldShowSimplificationNotice(CURRENT_SETTINGS_SCHEMA_VERSION + 1, CURRENT_SETTINGS_SCHEMA_VERSION), false);
});

test("a simulated two-load sequence shows the notice on the first load only", async () => {
  const { migrateAhaPluginSettings, shouldShowSimplificationNotice, CURRENT_SETTINGS_SCHEMA_VERSION } = await loadModule();

  // Simulates main.ts's loadSettings(): first load has no stored
  // schemaVersion at all (pre-#59 data.json).
  let storedData = { settings: PRODUCTION_KEY_SET_FIXTURE };
  let noticeCount = 0;

  function simulateLoad() {
    const needsNotice = shouldShowSimplificationNotice(storedData.schemaVersion, CURRENT_SETTINGS_SCHEMA_VERSION);
    const settings = needsNotice ? migrateAhaPluginSettings(storedData.settings ?? {}) : storedData.settings;
    if (needsNotice) {
      noticeCount += 1;
      storedData = { settings, schemaVersion: CURRENT_SETTINGS_SCHEMA_VERSION };
    }
    return settings;
  }

  simulateLoad();
  simulateLoad();
  simulateLoad();

  assert.equal(noticeCount, 1);
});
