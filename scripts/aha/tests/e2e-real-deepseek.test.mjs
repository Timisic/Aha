// True end-to-end tests against the real DeepSeek API (ADR 0005 follow-up,
// 2026-08-26 relation-judge-all-weak bug). Every other test in this suite
// mocks the LLM transport with a hand-written JSON payload that is already
// known-valid -- which cannot catch a real model deviating from an
// under-specified prompt (exactly how the all-weak bug slipped through 314
// passing mocked tests). These tests make real network calls to the real
// model and assert on structural properties (schema validity, enum
// membership), never exact wording, since model output is not
// deterministic.
//
// Auto-runs whenever DEEPSEEK_API_KEY is set in the environment (a
// developer's local shell, or a CI secret); skips with a clear message
// otherwise, so a normal `npm test` never silently costs money or flakes on
// network access when the key is absent.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const repoRoot = path.resolve(import.meta.dirname, "..", "..", "..");
const pluginDir = path.join(repoRoot, "obsidian-plugin");
const artifactPath = path.join(pluginDir, "dist", "core.mjs");

const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
const DEEPSEEK_BASE_URL = process.env.DEEPSEEK_TEST_BASE_URL || "https://api.deepseek.com";
const DEEPSEEK_MODEL = process.env.DEEPSEEK_TEST_MODEL || "deepseek-v4-pro";
const E2E_TIMEOUT_MS = 60_000;

if (!DEEPSEEK_API_KEY) {
  test("real DeepSeek E2E tests (skipped: DEEPSEEK_API_KEY is not set)", { skip: true }, () => {});
} else {
  const build = spawnSync(process.execPath, ["esbuild.config.mjs", "core"], {
    cwd: pluginDir,
    encoding: "utf-8",
  });
  if (build.error) {
    throw new Error(`core artifact build failed to spawn: ${build.error.message}`);
  }
  if (build.status !== 0) {
    throw new Error(`core artifact build failed (exit ${build.status}):\n${build.stdout ?? ""}${build.stderr ?? ""}`);
  }

  const core = await import(pathToFileURL(artifactPath).href);
  const { AHA_RESULT_SCHEMA, QUERY_PLAN_SCHEMA, RELATIONS, validateAhaResult } = core;

  async function coreHttpJsonPost(url, headers, body, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { method: "POST", headers, body, signal: controller.signal });
      const bodyText = await response.text();
      return { status: response.status, bodyText };
    } finally {
      clearTimeout(timer);
    }
  }

  const deps = {
    httpPost: coreHttpJsonPost,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };

  const transportRequest = {
    baseUrl: DEEPSEEK_BASE_URL,
    apiKey: DEEPSEEK_API_KEY,
    model: DEEPSEEK_MODEL,
    protocol: "chat-completions",
    thinking: "disabled",
    timeoutMs: E2E_TIMEOUT_MS,
  };

  test("real DeepSeek call: query-plan generation returns a schema-valid, non-fallback plan", async () => {
    const outcome = await core.generateQueryPlanViaLlm(
      {
        sourcePath: "e2e-source.md",
        id: "e2e-source.md",
        displayName: "Aha",
        _resolved_insight_input: "最近总是在假期或低压力时期陷入迷茫，缺乏驱动力，但过一段时间又会因为外部压力或他人要求重新振作起来。",
      },
      "最近总是在假期或低压力时期陷入迷茫，缺乏驱动力，但过一段时间又会因为外部压力或他人要求重新振作起来。",
      transportRequest,
      deps,
    );

    assert.equal(outcome.generatedBy, "llm", `expected a real LLM-generated plan, got fallback: ${outcome.error}`);
    assert.equal(outcome.fallback, false);
    assert.ok(outcome.queries.length >= 3, `expected at least 3 queries, got ${outcome.queries.length}`);
    for (const query of outcome.queries) {
      assert.ok(typeof query.kind === "string" && query.kind, "each query must have a kind");
      assert.ok(typeof query.text === "string" && query.text.trim(), "each query must have non-empty text");
    }
  }, { timeout: E2E_TIMEOUT_MS + 10_000 });

  test("real DeepSeek call: relation judge returns a schema-valid candidate with a real relation label", async () => {
    // This is the exact shape (sourceText/candidateInputs) and the exact bug
    // this test would have caught: DeepSeek routinely omitted `relation`,
    // returned `quotes` as a bare string, or omitted `notePath` -- all
    // fixed in obsidian-plugin/src/core/relation-judge.ts (commit 380c0d7).
    const raw = await core.judgeRelationsRawViaLlm(
      {
        sourcePath: "e2e-source.md",
        sourceText: "最近总是在假期或低压力时期陷入迷茫，缺乏驱动力，但过一段时间又会因为外部压力或他人要求重新振作起来。这次的迷茫感觉和以前很像，但我说不清楚具体的原因。",
        candidateInputs: [{
          notePath: "e2e-candidate.md",
          noteTitle: "e2e-candidate",
          excerpt: "上个假期我也经历了类似的状态，整整两周没有学习的动力，直到导师发消息催我交作业，我才重新振作起来开始行动。事后回想，这种靠外部压力推动的模式好像每次假期都会出现。",
        }],
      },
      transportRequest,
      deps,
    );

    assert.equal(raw.ok, true, `expected the real relation judge call to succeed, got: ${raw.ok ? "" : raw.error}`);
    assert.equal(raw.candidates.length, 1);
    const candidate = raw.candidates[0];
    assert.ok(RELATIONS.has(candidate.relation), `relation "${candidate.relation}" must be one of ${[...RELATIONS].join(", ")}`);
    assert.ok(typeof candidate.hit === "string" && candidate.hit.trim(), "hit must be a non-empty string");
    assert.ok(Array.isArray(candidate.quotes), "quotes must be normalized to an array");

    // Full-shape validation against the same schema production traffic is judged against.
    const fullResult = {
      ok: true,
      sourcePath: "e2e-source.md",
      generatedAt: new Date().toISOString(),
      summary: "e2e",
      warnings: [],
      error: null,
      candidates: [{
        notePath: candidate.notePath,
        noteTitle: candidate.noteTitle ?? "e2e-candidate",
        relation: candidate.relation,
        hit: candidate.hit,
        why: candidate.why,
        quotes: candidate.quotes ?? [],
        selected: true,
      }],
    };
    const validation = validateAhaResult(fullResult);
    assert.equal(validation.ok, true, `full AhaResult must validate: ${validation.errors?.join("; ")}`);
  }, { timeout: E2E_TIMEOUT_MS + 10_000 });
}
