// Tests for the shared-core candidate pool merge/ranking module (ADR 0005,
// issue #56). Ports rerankPipelineCandidates and pipelineCandidate from the
// frozen legacy wrapper scripts/aha/run-insight-search.mjs verbatim,
// including the filter order and the reciprocal-rank/diversity scoring
// formula (finalScore = bestScore + rankScore*0.18 + diversity, diversity =
// queryKinds.size*0.12 + commands.size*0.04). Neither function had
// standalone unit coverage before (only end-to-end coverage through spawned
// wrapper subprocesses).
//
// Imports go through the core artifact loader on purpose: the loader
// rebuilds obsidian-plugin/dist/core.mjs from src/core before importing, so
// this test also exercises the rebuild path every run.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  DEFAULT_EXCLUDED_CANDIDATE_FOLDERS,
  firstSnippetLine,
  mergeAndRankQueryResults,
  pipelineCandidate,
} from "../../../lib/core-artifact.mjs";

test("firstSnippetLine skips frontmatter/metadata lines and strips line-number prefixes", () => {
  assert.equal(firstSnippetLine("1: create: 2026-01-01\n2: ---\n3: real content here"), "real content here");
  assert.equal(firstSnippetLine("---\nreal content"), "real content");
  assert.equal(firstSnippetLine(42), "");
  assert.equal(firstSnippetLine(""), "");
});

async function withVault(fn) {
  const vault = await mkdtemp(path.join(tmpdir(), "core-pool-vault-"));
  try {
    await mkdir(path.join(vault, "templates"), { recursive: true });
    await writeFile(path.join(vault, "a.md"), "a");
    await writeFile(path.join(vault, "b.md"), "b");
    await writeFile(path.join(vault, "source.md"), "source");
    await writeFile(path.join(vault, "templates", "t.md"), "template");
    await fn(vault);
  } finally {
    await rm(vault, { recursive: true, force: true });
  }
}

test("mergeAndRankQueryResults merges by note path, accumulating best score and reciprocal rank", () => (
  withVault(async (vault) => {
    const args = { vaultRoot: vault, sourcePath: "source.md" };
    const policy = { excludedFolders: DEFAULT_EXCLUDED_CANDIDATE_FOLDERS, vaultRootPrefix: vault };
    const queryResults = [
      {
        query: { kind: "raw", command: "qmd query" },
        rows: [
          { file: "a.md", score: 0.4, title: "A" },
          { file: "b.md", score: 0.9, title: "B" },
        ],
      },
      {
        query: { kind: "contextual", command: "qmd query" },
        rows: [
          { file: "a.md", score: 0.5, title: "A" },
        ],
      },
    ];
    const merged = await mergeAndRankQueryResults(args, queryResults, policy);
    assert.equal(merged.length, 2);
    // a.md: bestScore=0.5, rankScore=1/1+1/1=2, diversity=2*0.12+1*0.04=0.28
    //   -> 0.5 + 2*0.18 + 0.28 = 1.14
    // b.md: bestScore=0.9, rankScore=1/2=0.5, diversity=1*0.12+1*0.04=0.16
    //   -> 0.9 + 0.5*0.18 + 0.16 = 1.15
    const byPath = Object.fromEntries(merged.map((c) => [c.notePath, c]));
    assert.ok(Math.abs(byPath["a.md"].finalScore - 1.14) < 1e-9);
    assert.ok(Math.abs(byPath["b.md"].finalScore - 1.15) < 1e-9);
    // Sorted descending by finalScore.
    assert.deepEqual(merged.map((c) => c.notePath), ["b.md", "a.md"]);
  })
));

test("mergeAndRankQueryResults filters out-of-vault, source self-hit, and excluded-folder rows", () => (
  withVault(async (vault) => {
    const args = { vaultRoot: vault, sourcePath: "source.md" };
    const policy = { excludedFolders: DEFAULT_EXCLUDED_CANDIDATE_FOLDERS, vaultRootPrefix: vault };
    const queryResults = [
      {
        query: { kind: "raw", command: "qmd query" },
        rows: [
          { file: "a.md", score: 0.5, title: "A" },
          { file: "source.md", score: 0.99, title: "Source" },
          { file: "templates/t.md", score: 0.95, title: "T" },
          { file: "missing-outside-vault.md", score: 0.9, title: "Missing" },
        ],
      },
    ];
    const merged = await mergeAndRankQueryResults(args, queryResults, policy);
    assert.deepEqual(merged.map((c) => c.notePath), ["a.md"]);
  })
));

test("mergeAndRankQueryResults falls back to the row's basename when no title is given", () => (
  withVault(async (vault) => {
    const args = { vaultRoot: vault, sourcePath: "source.md" };
    const policy = { excludedFolders: DEFAULT_EXCLUDED_CANDIDATE_FOLDERS, vaultRootPrefix: vault };
    const queryResults = [{ query: { kind: "raw", command: "qmd query" }, rows: [{ file: "a.md", score: 0.1 }] }];
    const merged = await mergeAndRankQueryResults(args, queryResults, policy);
    assert.equal(merged[0].noteTitle, "a");
    assert.equal(merged[0].hit, "QMD score 0.1");
  })
));

test("pipelineCandidate shapes a weak, quote-free candidate summarizing its strongest sources", () => {
  const candidate = {
    notePath: "b.md",
    noteTitle: "B",
    hit: "hello",
    bestScore: 0.9,
    rankScore: 0.5,
    queryKinds: new Set(["raw", "contextual"]),
    commands: new Set(["qmd query"]),
    rawLocations: new Set(["b.md"]),
    sources: [
      { kind: "raw", command: "qmd query", rank: 2, score: 0.9 },
      { kind: "contextual", command: "qmd query", rank: 1, score: 0.5 },
    ],
    finalScore: 1.15,
  };
  const shaped = pipelineCandidate(candidate);
  assert.equal(shaped.notePath, "b.md");
  assert.equal(shaped.relation, "weak");
  assert.equal(shaped.selected, true);
  assert.deepEqual(shaped.quotes, []);
  assert.deepEqual(shaped._rawLocations, ["b.md"]);
  // Sources are ordered by rank ascending in the "strongest signals" summary.
  assert.match(shaped.why, /contextual\/qmd query#1, raw\/qmd query#2/);
  assert.match(shaped.why, /2 query kind\(s\)/);
});
