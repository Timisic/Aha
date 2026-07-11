import assert from "node:assert/strict";
import test from "node:test";

import { expandGraphCandidates } from "../graph-expansion.mjs";
import { LEGACY_RETRIEVAL_POLICY_V1, PRODUCT_RETRIEVAL_POLICY_V2 } from "../retrieval-policies.mjs";

const identity = (candidate) => candidate.file.toLowerCase();
const admit = (row) => row.excluded ? null : { file: row.file, score: row.score ?? 0.1 };

test("expands direct links and backlinks with source-only provenance", async () => {
  const result = await expandGraphCandidates({
    sourcePath: "Insights/New.md",
    policy: { seedLimit: 0, linksLimit: 2, backlinksLimit: 2, globalCandidateLimit: 4 },
    adapters: {
      links: async () => [{ file: "Memory/Out.md", contents: "private" }],
      backlinks: async () => [{ file: "Memory/Back.md" }],
      admitCandidate: admit,
      canonicalIdentity: identity,
    },
  });

  assert.deepEqual(result.candidates.map(({ file }) => file), ["Memory/Out.md", "Memory/Back.md"]);
  assert.deepEqual(result.candidates[0].graphEvidence, [
    { kind: "outlink", origin: "source", from: "Insights/New.md", seedRank: null },
  ]);
  assert.ok(!JSON.stringify(result).includes("private"));
});

test("selects top seeds and enforces command, per-seed, hub, and global budgets", async () => {
  const calls = [];
  const result = await expandGraphCandidates({
    sourcePath: "Source.md",
    rankedSeeds: [{ file: "Seed/A.md" }, { file: "Seed/B.md" }, { file: "Seed/C.md" }],
    policy: { seedLimit: 2, linksLimit: 3, backlinksLimit: 3, perSeedLimit: 2, globalCandidateLimit: 5 },
    adapters: {
      links: async ({ path, limit }) => {
        calls.push(["links", path, limit]);
        return Array.from({ length: 20 }, (_, index) => ({ file: `${path}/L${index}.md` }));
      },
      backlinks: async ({ path, limit }) => {
        calls.push(["backlinks", path, limit]);
        return Array.from({ length: 20 }, (_, index) => ({ file: `${path}/B${index}.md` }));
      },
      admitCandidate: admit,
      canonicalIdentity: identity,
    },
  });

  assert.equal(result.candidates.length, 5);
  assert.deepEqual(result.seeds, [{ path: "Seed/A.md", rank: 1 }, { path: "Seed/B.md", rank: 2 }]);
  assert.ok(!calls.some(([, path]) => path === "Seed/C.md"));
  const counts = Map.groupBy(result.candidates, (candidate) => candidate.graphEvidence[0].from);
  assert.ok([...counts.values()].every((rows) => rows.length <= 2));
});

test("canonical duplicates are emitted once and accumulate provenance without weight", async () => {
  const result = await expandGraphCandidates({
    sourcePath: "Source.md",
    rankedSeeds: [{ file: "Seed.md" }],
    policy: { seedLimit: 1, linksLimit: 2, backlinksLimit: 1, perSeedLimit: 4, globalCandidateLimit: 10 },
    adapters: {
      links: async () => [{ file: "Memory/Same.md", score: 0.2 }, { file: "memory/same.md", score: 99 }],
      backlinks: async () => [{ file: "Memory/Same.md" }],
      admitCandidate: admit,
      canonicalIdentity: identity,
    },
  });

  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].score, 0.2);
  assert.equal(result.candidates[0].graphEvidence.length, 4);
});

test("admission exclusions and structured command failures preserve successful candidates", async () => {
  const result = await expandGraphCandidates({
    sourcePath: "Source.md",
    rankedSeeds: [{ file: "Seed.md" }],
    policy: { seedLimit: 1, linksLimit: 4, backlinksLimit: 4, perSeedLimit: 4, globalCandidateLimit: 10 },
    adapters: {
      links: async ({ path }) => path === "Source.md"
        ? [{ file: "Reviews/Generated.md", excluded: true }, { file: "Memory/Good.md" }]
        : [{ file: "Memory/SeedGood.md" }],
      backlinks: async ({ path }) => {
        if (path === "Source.md") throw new Error("obsidian unavailable");
        return { ok: false, error: new Error("seed backlinks timed out") };
      },
      admitCandidate: admit,
      canonicalIdentity: identity,
    },
  });

  assert.deepEqual(result.candidates.map(({ file }) => file), ["Memory/Good.md", "Memory/SeedGood.md"]);
  assert.deepEqual(result.failures.map(({ command, from, message }) => ({ command, from, message })), [
    { command: "backlinks", from: "Source.md", message: "obsidian unavailable" },
    { command: "backlinks", from: "Seed.md", message: "seed backlinks timed out" },
  ]);
});

test("disabled graph expansion never invokes adapters", async () => {
  const result = await expandGraphCandidates({
    sourcePath: "Source.md",
    rankedSeeds: [{ file: "Seed.md" }],
    policy: { graphExpansion: false },
    adapters: {
      links: async () => { throw new Error("must not run"); },
      admitCandidate: admit,
      canonicalIdentity: identity,
    },
  });

  assert.deepEqual(result, {
    mode: "disabled",
    enabled: false,
    candidates: [],
    failures: [],
    seeds: [],
    policy: {
      enabled: false,
      seedLimit: 0,
      linksLimit: 5,
      backlinksLimit: 5,
      perOriginLimit: 8,
      globalCandidateLimit: 20,
    },
  });
});

test("legacy policy preserves the complete source graph in command order", async () => {
  const limits = [];
  const links = Array.from({ length: 12 }, (_, index) => ({ file: `Memory/Link-${index}.md` }));
  const backlinks = Array.from({ length: 12 }, (_, index) => ({ file: `Memory/Back-${index}.md` }));
  const result = await expandGraphCandidates({
    sourcePath: "Source.md",
    policy: LEGACY_RETRIEVAL_POLICY_V1,
    adapters: {
      links: async ({ limit }) => {
        limits.push(limit);
        return links;
      },
      backlinks: async ({ limit }) => {
        limits.push(limit);
        return backlinks;
      },
      admitCandidate: (row, { command }) => ({
        ...row,
        score: command === "backlinks" ? 0.18 : 0.14,
      }),
      canonicalIdentity: identity,
    },
  });

  assert.deepEqual(limits, [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY]);
  assert.equal(result.candidates.length, 24);
  assert.deepEqual(result.candidates.slice(0, 12).map(({ score }) => score), Array(12).fill(0.14));
  assert.deepEqual(result.candidates.slice(12).map(({ score }) => score), Array(12).fill(0.18));
  assert.equal(result.seeds.length, 0);
});

test("legacy graph restoration does not remove product-v2 bounds", async () => {
  const limits = [];
  const rows = Array.from({ length: 12 }, (_, index) => ({ file: `Memory/Graph-${index}.md` }));
  const result = await expandGraphCandidates({
    sourcePath: "Source.md",
    policy: PRODUCT_RETRIEVAL_POLICY_V2,
    adapters: {
      links: async ({ limit }) => {
        limits.push(limit);
        return rows;
      },
      backlinks: async ({ limit }) => {
        limits.push(limit);
        return rows.map((row) => ({ file: row.file.replace("Graph", "Back") }));
      },
      admitCandidate: admit,
      canonicalIdentity: identity,
    },
  });

  assert.deepEqual(limits, [5, 5]);
  assert.equal(result.candidates.length, 8);
  assert.equal(result.policy.globalCandidateLimit, 24);
});
