// Tests for core/memory-retrieval.ts: the shared Memory Retrieval module both
// Recall Tier and Full Tier now run their retrieval through. These exercise
// the module's own interface -- QMD execution, graph expansion, excluded
// folders, and failure degradation -- so both tiers inherit the guarantees
// instead of each call site re-proving them.

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

async function coreModule() {
  const temp = await mkdtemp(path.join(tmpdir(), "aha-memory-retrieval-test-"));
  const entry = path.join(temp, "entry.ts");
  const out = path.join(temp, "bundle.mjs");
  await writeFile(entry, `export * from ${JSON.stringify(path.join(repoRoot, "obsidian-plugin/src/core/index.ts"))};\n`);
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
};

const oneQuery = [{ kind: "raw", command: "qmd query", text: "feedback", query: "feedback" }];

test("a backlink-only note becomes a candidate even when QMD returns nothing", async () => {
  const core = await coreModule();
  const outcome = await core.retrieveMemoryCandidates(
    { ...baseArgs, excludedFolders: [] },
    oneQuery,
    {
      ...vaultBoundaryDeps(),
      runQmdQuery: async () => "[]",
      listGraphNeighbors: async () => ({
        neighbors: [{ notePath: "Memory/Linked.md", kind: "backlink" }],
        warnings: [],
      }),
    },
  );

  assert.deepEqual(outcome.pooled.map((candidate) => candidate.notePath), ["Memory/Linked.md"]);
  assert.deepEqual(outcome.errors, []);
});

test("excluded folders drop graph neighbors just like they drop QMD rows", async () => {
  const core = await coreModule();
  const outcome = await core.retrieveMemoryCandidates(
    { ...baseArgs, excludedFolders: ["templates"] },
    oneQuery,
    {
      ...vaultBoundaryDeps(),
      runQmdQuery: async () => JSON.stringify([
        { file: "templates/Boilerplate.md", title: "Boilerplate", snippet: "A template.", score: 0.9 },
      ]),
      listGraphNeighbors: async () => ({
        neighbors: [
          { notePath: "templates/Linked Template.md", kind: "outlink" },
          { notePath: "Memory/Keep.md", kind: "backlink" },
        ],
        warnings: [],
      }),
    },
  );

  assert.deepEqual(outcome.pooled.map((candidate) => candidate.notePath), ["Memory/Keep.md"]);
});

test("a graph-expansion failure is a warning; QMD candidates still come back", async () => {
  const core = await coreModule();
  const outcome = await core.retrieveMemoryCandidates(
    { ...baseArgs, excludedFolders: [] },
    oneQuery,
    {
      ...vaultBoundaryDeps(),
      runQmdQuery: async () => JSON.stringify([
        { file: "Memory/Found.md", title: "Found", snippet: "An old judgment.", score: 0.8 },
      ]),
      listGraphNeighbors: async () => {
        throw new Error("obsidian CLI missing");
      },
    },
  );

  assert.deepEqual(outcome.pooled.map((candidate) => candidate.notePath), ["Memory/Found.md"]);
  assert.ok(outcome.warnings.some((warning) => warning.includes("Obsidian graph expansion failed")));
  assert.ok(outcome.warnings.some((warning) => warning.includes("obsidian CLI missing")));
});

test("deps without listGraphNeighbors skip graph expansion silently", async () => {
  const core = await coreModule();
  const outcome = await core.retrieveMemoryCandidates(
    { ...baseArgs, excludedFolders: [] },
    oneQuery,
    {
      ...vaultBoundaryDeps(),
      runQmdQuery: async () => JSON.stringify([
        { file: "Memory/Found.md", title: "Found", snippet: "An old judgment.", score: 0.8 },
      ]),
    },
  );

  assert.deepEqual(outcome.warnings, []);
  assert.deepEqual(outcome.queryResults.map((result) => result.query.kind), ["raw"]);
});

test("a failed query becomes an error entry, not a throw, and graph expansion still runs", async () => {
  const core = await coreModule();
  const outcome = await core.retrieveMemoryCandidates(
    { ...baseArgs, excludedFolders: [] },
    oneQuery,
    {
      ...vaultBoundaryDeps(),
      runQmdQuery: async () => {
        throw new Error("qmd exited 1");
      },
      listGraphNeighbors: async () => ({
        neighbors: [{ notePath: "Memory/Linked.md", kind: "backlink" }],
        warnings: ["obsidian backlinks partially unavailable"],
      }),
    },
  );

  assert.equal(outcome.errors.length, 1);
  assert.match(outcome.errors[0], /qmd exited 1/);
  assert.deepEqual(outcome.warnings, ["obsidian backlinks partially unavailable"]);
  assert.deepEqual(outcome.pooled.map((candidate) => candidate.notePath), ["Memory/Linked.md"]);
});
