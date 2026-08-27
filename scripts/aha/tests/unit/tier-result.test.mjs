// Tests for tier-result.ts's shapeFullTierResult (issue #58; CONTEXT.md
// "Runtime Tier Fallback") -- the crux of the "a Full Tier round with a
// failing LLM lands on Recall Tier results plus a structured failure
// record" acceptance criterion. Exercised against plain AhaResult fixtures
// (the shape core/orchestrator.ts's runFullPipeline returns) so this proves
// the distinguishing logic directly, without spinning up real qmd/LLM
// transports:
//   - Relation Judge failed but deterministic candidates survived
//     (candidates.length > 0) -> Runtime Tier Fallback: an honest Recall
//     Tier success (ok:true) with the failure kept as a structured record.
//   - qmd retrieval itself produced nothing (candidates.length === 0) ->
//     nothing to fall back to -> a genuine failure (ok:false), never
//     disguised as a fallback success.

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

async function loadTsModule(relativePath) {
  const temp = await mkdtemp(path.join(tmpdir(), "aha-tier-result-test-"));
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

async function tierResultModule() {
  return loadTsModule("obsidian-plugin/src/tier-result.ts");
}

test("Full Tier success stays tier full, ok:true, with the tier header prefixed onto summary", async () => {
  const tierResult = await tierResultModule();
  const fullSuccess = {
    ok: true,
    sourcePath: "Source.md",
    generatedAt: "2026-07-01T00:00:00.000Z",
    summary: "LLM generated 3 QMD query rewrites; mixed retrieval returned 2 reranked candidates; Relation Judge reviewed 2 candidate excerpts.",
    warnings: ["Relation Judge ran on bounded candidate excerpts; strong relation labels require quote evidence from the excerpt."],
    error: null,
    candidates: [
      { notePath: "Memory/A.md", noteTitle: "A", relation: "supports", hit: "\"quote\"", why: "because it matters", quotes: ["quote"], selected: true },
    ],
  };

  const outcome = tierResult.shapeFullTierResult(fullSuccess);

  assert.equal(outcome.tier, "full");
  assert.equal(outcome.result.ok, true);
  assert.match(outcome.result.summary, /^Full Tier\. LLM generated 3 QMD query rewrites/);
  assert.equal(outcome.result.error, undefined);
  assert.equal(outcome.result.candidates.length, 1);
});

test("Runtime Tier Fallback: Relation Judge failure with surviving candidates lands on an honest Recall Tier success plus a structured failure record", async () => {
  const tierResult = await tierResultModule();
  const relationJudgeFailure = {
    ok: false,
    sourcePath: "Source.md",
    generatedAt: "2026-07-01T00:00:00.000Z",
    summary: "LLM generated 3 QMD query rewrites; mixed retrieval returned 2 reranked candidates; Relation Judge reviewed 2 candidate excerpts.",
    warnings: [
      "Relation Judge unavailable; returning structured failure instead of treating weak candidates as success: LLM call failed after 3 attempts: network error: connection refused",
    ],
    error: {
      message: "Aha Relation Judge failed.",
      tool: "llm",
      details: "LLM call failed after 3 attempts: network error: connection refused",
    },
    candidates: [
      { notePath: "Memory/A.md", noteTitle: "A", relation: "weak", hit: "QMD score 0.9", why: "Mixed QMD retrieval ranked this candidate from 3 query kind(s).", quotes: [], selected: true },
      { notePath: "Memory/B.md", noteTitle: "B", relation: "weak", hit: "QMD score 0.5", why: "Mixed QMD retrieval ranked this candidate from 2 query kind(s).", quotes: [], selected: true },
    ],
  };

  const outcome = tierResult.shapeFullTierResult(relationJudgeFailure);

  assert.equal(outcome.tier, "recall", "the round actually landed on Recall Tier results, not Full Tier");
  assert.equal(outcome.result.ok, true, "Runtime Tier Fallback is an honest success at the tier it actually reached, not a hard failure");
  assert.equal(outcome.result.candidates.length, 2);
  assert.ok(outcome.result.candidates.every((candidate) => candidate.relation === "weak"), "fallback candidates stay unjudged -- never disguised as full judged results");
  assert.match(
    outcome.result.summary,
    /^Recall Tier \(Full Tier fallback: Relation Judge failed - LLM call failed after 3 attempts: network error: connection refused\)\./,
  );
  assert.deepEqual(outcome.result.error, relationJudgeFailure.error, "the structured failure record is kept, not discarded");
});

test("a genuine Full Tier failure (retrieval produced nothing to fall back to) stays a real failure, never a fake fallback success", async () => {
  const tierResult = await tierResultModule();
  const genuineFailure = {
    ok: false,
    sourcePath: "Source.md",
    generatedAt: "2026-07-01T00:00:00.000Z",
    summary: "Aha mixed retrieval returned no usable candidates.",
    warnings: [],
    error: {
      message: "Aha retrieval returned no usable candidates.",
      tool: "qmd",
      details: "QMD retrieval returned no vault-contained candidates after self-hit and path-boundary filtering.",
    },
    candidates: [],
  };

  const outcome = tierResult.shapeFullTierResult(genuineFailure);

  assert.equal(outcome.tier, "full");
  assert.equal(outcome.result.ok, false, "there is nothing to fall back to, so this must stay a genuine failure");
  assert.equal(outcome.result.candidates.length, 0);
  assert.match(outcome.result.error.message, /^Full Tier\. Aha retrieval returned no usable candidates\./);
});
