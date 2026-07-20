// Tests for the plugin-side Recall Tier module (issue #58; CONTEXT.md
// "Recall Tier"): the deterministic query plan -> qmd retrieval -> pool
// merge/rank pipeline, producing ranked, unjudged (`relation: "weak"`)
// candidates with no LLM call. recall-tier.ts only pulls in obsidian-free
// core/*.ts modules, so this bundles and runs with no Obsidian stub.

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const requireFromPlugin = createRequire(path.join(repoRoot, "obsidian-plugin/package.json"));
const esbuild = requireFromPlugin("esbuild");

async function loadTsModule(relativePath) {
  const temp = await mkdtemp(path.join(tmpdir(), "aha-recall-tier-test-"));
  const entry = path.join(temp, "entry.ts");
  const out = path.join(temp, "bundle.mjs");
  await writeFile(entry, `export * from ${JSON.stringify(path.join(repoRoot, relativePath))};\n`);
  await esbuild.build({
    bundle: true,
    entryPoints: [entry],
    format: "esm",
    outfile: out,
    platform: "node",
    target: "es2022",
  });
  const loaded = await import(`${pathToFileURL(out).href}?cacheBust=${Date.now()}`);
  await rm(temp, { recursive: true, force: true });
  return loaded;
}

async function recallTierModule() {
  return loadTsModule("obsidian-plugin/src/recall-tier.ts");
}

function vaultBoundaryDeps() {
  return {
    path: {
      isAbsolute: (value) => path.isAbsolute(value),
      relative: (from, to) => path.relative(from, to),
      resolve: (...segments) => path.resolve(...segments),
      basename: (value, ext) => (ext === undefined ? path.basename(value) : path.basename(value, ext)),
    },
    posixNormalize: (value) => path.posix.normalize(value),
    realpath: async (absolutePath) => absolutePath,
  };
}

const baseArgs = {
  vaultRoot: "/vault",
  sourcePath: "Source.md",
  sourceAbsolutePath: "/vault/Source.md",
  id: "Source.md",
  displayName: "Aha",
  _resolved_insight_input: "反馈闭环暴露经验差距，也帮助下一次行动修正。",
};

test("runs the deterministic pipeline (no LLM) and returns ranked, unjudged weak candidates", async () => {
  const recallTier = await recallTierModule();
  const rows = [
    { file: "Memory/A.md", title: "A", snippet: "Old judgment about feedback loops.", score: 0.9 },
    { file: "Memory/B.md", title: "B", snippet: "Boundary condition noted here.", score: 0.5 },
  ];
  let qmdCalls = 0;
  const deps = {
    ...vaultBoundaryDeps(),
    runQmdQuery: async () => {
      qmdCalls += 1;
      return JSON.stringify(rows);
    },
  };

  const result = await recallTier.runRecallTier({ ...baseArgs, targetCandidates: 20 }, deps);

  assert.equal(result.ok, true);
  assert.ok(qmdCalls >= 3, "the deterministic query plan issues multiple qmd calls");
  assert.equal(result.candidates.length, 2);
  for (const candidate of result.candidates) {
    assert.equal(candidate.relation, "weak", "Recall Tier never judges relations");
    assert.equal(candidate.selected, true);
    assert.ok(!("_rawLocations" in candidate), "internal _rawLocations must not leak into the result");
    // Review feedback fields remain settable -- a plain mutable object, the
    // same shape review-panel.ts's ReviewPanelCandidate expects.
    candidate.selected = false;
    assert.equal(candidate.selected, false);
  }
  assert.match(result.summary, /^Recall Tier \(no LLM configured\)\./);
  assert.equal(result.sourcePath, "Source.md");
});

test("a failing qmd query becomes a warning, not a fake failure -- zero candidates is still an honest ok:true result", async () => {
  const recallTier = await recallTierModule();
  const deps = {
    ...vaultBoundaryDeps(),
    runQmdQuery: async () => {
      throw new Error("qmd exited 1");
    },
  };

  const result = await recallTier.runRecallTier(baseArgs, deps);

  assert.equal(result.ok, true, "Recall Tier is never an error state, even when every query fails");
  assert.equal(result.candidates.length, 0);
  assert.ok(result.warnings.some((warning) => warning.includes("Skipped failed query")));
});
