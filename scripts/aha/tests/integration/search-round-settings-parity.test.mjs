// Parity tests for Memory Search Round settings (core/search-round-settings.ts).
//
// The point of this file is the comparison itself: one saved settings object
// is read through the plugin adapter (tier-pipeline.ts's
// searchRoundSettingsFor) and through the batch/bench adapter
// (scripts/lib/core-artifact.mjs's searchRoundSettings), and the two must
// agree. Before the shared module they did not: the batch side resurrected
// the "templates" default over a deliberately cleared field and never
// forwarded the query-plan prompt override at all, so a batch round could
// silently search a different corpus with a different prompt than the plugin
// round the user was comparing it against.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { searchRoundSettings as batchSearchRoundSettings } from "../../../lib/core-artifact.mjs";

const repoRoot = path.resolve(import.meta.dirname, "../../../..");
const requireFromPlugin = createRequire(path.join(repoRoot, "obsidian-plugin/package.json"));
const esbuild = requireFromPlugin("esbuild");

// tier-pipeline.ts computes the prompt-override hash through getNodeRequire().
globalThis.require = createRequire(import.meta.url);

function obsidianStubPlugin() {
  return {
    name: "obsidian-stub",
    setup(build) {
      build.onResolve({ filter: /^obsidian$/ }, () => ({ path: "obsidian", namespace: "obsidian-stub" }));
      build.onLoad({ filter: /.*/, namespace: "obsidian-stub" }, () => ({
        contents: "export async function requestUrl() { return { status: 200, text: '{}' }; }",
        loader: "js",
      }));
    },
  };
}

let pluginModulePromise;
function pluginModule() {
  pluginModulePromise ??= (async () => {
    const temp = await mkdtemp(path.join(tmpdir(), "aha-round-settings-test-"));
    const entry = path.join(temp, "entry.ts");
    const out = path.join(temp, "bundle.mjs");
    await writeFile(entry, `export * from ${JSON.stringify(path.join(repoRoot, "obsidian-plugin/src/tier-pipeline.ts"))};\n`);
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
  })();
  return pluginModulePromise;
}

/** Reads one settings object through both adapters and asserts they match. */
async function bothEnds(settings) {
  const { searchRoundSettingsFor } = await pluginModule();
  const plugin = searchRoundSettingsFor(settings);
  const batch = batchSearchRoundSettings(settings);
  assert.deepEqual(
    JSON.parse(JSON.stringify(plugin)),
    JSON.parse(JSON.stringify(batch)),
    "plugin and batch must interpret the same saved settings identically",
  );
  return plugin;
}

test("a deliberately cleared excluded-folders field excludes nothing on both ends", async () => {
  const round = await bothEnds({ excludedFolders: "", targetCandidates: 20, relationJudgeBudget: 40 });
  assert.deepEqual(round.excludedFolders, []);
});

test("a missing excluded-folders field falls back to the shipped default on both ends", async () => {
  const round = await bothEnds({});
  assert.deepEqual(round.excludedFolders, ["templates"]);
});

test("excluded folders split on commas and newlines identically on both ends", async () => {
  const round = await bothEnds({ excludedFolders: "templates, Aha/Reviews\n  \nDrafts" });
  assert.deepEqual(round.excludedFolders, ["templates", "Aha/Reviews", "Drafts"]);
});

test("a query-plan prompt override reaches both ends with the same version hash", async () => {
  const text = "只找出与判断更新直接相关的旧笔记。";
  const round = await bothEnds({ queryPromptOverride: `  ${text}  ` });
  assert.equal(round.queryPromptOverride.text, text);
  assert.equal(
    round.queryPromptOverride.version,
    `aha-query-plan-custom-${createHash("sha256").update(text).digest("hex").slice(0, 16)}`,
  );
});

test("an empty prompt override means the built-in prompt on both ends", async () => {
  const round = await bothEnds({ queryPromptOverride: "   \n " });
  assert.equal(round.queryPromptOverride, undefined);
});

test("candidate target and Relation Judge budget share one default and one validity rule", async () => {
  assert.deepEqual(
    { ...(await bothEnds({})) },
    { excludedFolders: ["templates"], targetCandidates: 20, relationJudgeBudget: 40, queryPromptOverride: undefined },
  );
  const custom = await bothEnds({ targetCandidates: 12, relationJudgeBudget: 30 });
  assert.equal(custom.targetCandidates, 12);
  assert.equal(custom.relationJudgeBudget, 30);
  const invalid = await bothEnds({ targetCandidates: 0, relationJudgeBudget: -5 });
  assert.equal(invalid.targetCandidates, 20);
  assert.equal(invalid.relationJudgeBudget, 40);
});
