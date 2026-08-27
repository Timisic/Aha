// Tests for the shared-core LLM query planning (ADR 0005, issue #57).
//
// The compiled core artifact is never committed, so this test rebuilds it the
// same way scripts/lib/core-artifact.mjs does and imports
// obsidian-plugin/dist/core.mjs directly. LLM effects are all injected: a
// recording fake httpPost plus a recording fake sleep, matching the style of
// core-llm-transport.test.mjs.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const repoRoot = path.resolve(import.meta.dirname, "..", "..", "..", "..");
const pluginDir = path.join(repoRoot, "obsidian-plugin");
const artifactPath = path.join(pluginDir, "dist", "core.mjs");

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
const { generateQueryPlanViaLlm, buildQueryPlanPrompt, QUERY_PLAN_PROMPT_VERSION } = core;

function fakeDeps(script) {
  const calls = [];
  let index = 0;
  return {
    calls,
    deps: {
      httpPost: async (url, headers, body, timeoutMs) => {
        calls.push({ url, headers, body: JSON.parse(body), timeoutMs });
        const step = script[Math.min(index, script.length - 1)];
        index += 1;
        if (step instanceof Error) throw step;
        return step;
      },
      sleep: async () => {},
    },
  };
}

const responsesEnvelope = (json) => ({
  status: 200,
  bodyText: JSON.stringify({ output_text: JSON.stringify(json) }),
});

const transportRequest = () => ({
  baseUrl: "https://api.openai.com/v1",
  apiKey: "sk-test",
  model: "gpt-test",
  protocol: "responses",
  timeoutMs: 60_000,
});

const validPlan = {
  queries: ["raw", "abstracted_judgment", "contextual"].map((kind) => ({
    kind,
    command: "qmd query",
    text: `${kind} query`,
    qmd: {
      intent: `召回 ${kind} 相关的旧判断`,
      lex: ["反馈", "闭环", "学习", "改进", "extra"],
      vec: "围绕反馈闭环和学习改进寻找旧判断。",
      hyde: "一篇旧笔记讨论反馈如何帮助学习改进。",
    },
  })),
};

test("QUERY_PLAN_PROMPT_VERSION is aha-query-plan-v7", () => {
  assert.equal(QUERY_PLAN_PROMPT_VERSION, "aha-query-plan-v7");
});

test("buildQueryPlanPrompt embeds the source path and a source summary block", () => {
  const prompt = buildQueryPlanPrompt({ sourcePath: "Source.md" }, "# Heading\n\nSome salient body line long enough to pass the filter.");
  assert.match(prompt, /source path: Source\.md/);
  assert.match(prompt, /<source_summary>/);
  assert.match(prompt, /headings: Heading/);
});

test("successful LLM call normalizes the plan and appends the deterministic fallback", async () => {
  const { deps, calls } = fakeDeps([responsesEnvelope(validPlan)]);
  const outcome = await generateQueryPlanViaLlm(
    { sourcePath: "Source.md", _resolved_insight_input: "反馈闭环暴露经验差距，也帮助下一次行动修正。" },
    "反馈闭环暴露经验差距，也帮助下一次行动修正。",
    transportRequest(),
    deps,
  );

  assert.equal(outcome.generatedBy, "llm");
  assert.equal(outcome.fallback, false);
  assert.equal(outcome.error, null);
  assert.equal(outcome.model_query_count, 3);
  assert.equal(outcome.queries.length, 4);
  assert.equal(outcome.queries.at(-1).kind, "source_fallback");
  assert.match(outcome.queries.at(-1).qmd.vec, /反馈闭环暴露经验差距/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.text.format.name, "aha_qmd_query_plan_agent");
});

test("transport failure falls back to the deterministic rules plan", async () => {
  const { deps } = fakeDeps([new Error("network down")]);
  const args = { sourcePath: "Source.md", id: "case-1", _resolved_insight_input: "Source note:\n反馈闭环和行动修正。\n\nFresh thought:\n要找旧判断里的反例。" };
  const outcome = await generateQueryPlanViaLlm(args, args._resolved_insight_input, transportRequest(), deps);

  assert.equal(outcome.generatedBy, "rules");
  assert.equal(outcome.fallback, true);
  assert.match(outcome.error, /network down/);
  assert.equal(outcome.queries.length, 4);
  assert.equal(outcome.model_query_count, 4);
  assert.ok(outcome.queries.every((query) => ["qmd query", "qmd search"].includes(query.command)));
});

test("short model output (fewer than 3 usable queries) supplements with deterministic rules", async () => {
  const { deps } = fakeDeps([responsesEnvelope({ queries: [validPlan.queries[0]] })]);
  const args = { sourcePath: "Source.md", id: "case-2", _resolved_insight_input: "太短的输入也需要兜底规则查询计划。" };
  const outcome = await generateQueryPlanViaLlm(args, args._resolved_insight_input, transportRequest(), deps);

  assert.equal(outcome.generatedBy, "llm");
  assert.equal(outcome.fallback, false);
  assert.equal(outcome.error, null);
  assert.equal(outcome.model_query_count, 1);
  assert.ok(outcome.queries.length >= 3, "supplemented plan should have at least 3 queries");
  assert.equal(outcome.queries[0].kind, validPlan.queries[0].kind);
});

test("non-JSON model output falls back to rules with a parse-kind error", async () => {
  const { deps } = fakeDeps([{ status: 200, bodyText: JSON.stringify({ output_text: "not json" }) }]);
  const args = { sourcePath: "Source.md", id: "case-3", _resolved_insight_input: "非 JSON 输出也应触发兜底。" };
  const outcome = await generateQueryPlanViaLlm(args, args._resolved_insight_input, transportRequest(), deps);

  assert.equal(outcome.generatedBy, "rules");
  assert.equal(outcome.fallback, true);
  assert.match(outcome.error, /not valid JSON/);
});

// --- Prompt override coverage (issue #59) -----------------------------------
// The plugin settings page can supply a query-plan prompt override; core's
// job is purely additive: when omitted, behavior and promptVersion stay
// byte-identical to before this parameter existed (covered by every test
// above, none of which pass a 5th argument). These tests cover the new
// parameter itself.

test("omitting promptOverride records the built-in QUERY_PLAN_PROMPT_VERSION", async () => {
  const { deps } = fakeDeps([responsesEnvelope(validPlan)]);
  const outcome = await generateQueryPlanViaLlm(
    { sourcePath: "Source.md", _resolved_insight_input: "无覆盖时应使用内置 prompt。" },
    "无覆盖时应使用内置 prompt。",
    transportRequest(),
    deps,
  );
  assert.equal(outcome.promptVersion, QUERY_PLAN_PROMPT_VERSION);
});

test("a non-empty promptOverride replaces the built-in prompt text and records the override version", async () => {
  const { deps, calls } = fakeDeps([responsesEnvelope(validPlan)]);
  const overrideText = "CUSTOM OVERRIDE PROMPT: only follow this instruction.";
  const outcome = await generateQueryPlanViaLlm(
    { sourcePath: "Source.md", _resolved_insight_input: "覆盖 prompt 的测试输入。" },
    "覆盖 prompt 的测试输入。",
    transportRequest(),
    deps,
    { text: overrideText, version: "aha-query-plan-custom-deadbeefdeadbeef" },
  );
  assert.equal(outcome.promptVersion, "aha-query-plan-custom-deadbeefdeadbeef");
  assert.equal(calls[0].body.input, overrideText);
  assert.equal(buildQueryPlanPrompt({ sourcePath: "Source.md" }, "ignored", overrideText), overrideText);
});

test("a promptOverride is still recorded on the promptVersion even when the LLM call falls back to rules", async () => {
  const { deps } = fakeDeps([new Error("network down")]);
  const outcome = await generateQueryPlanViaLlm(
    { sourcePath: "Source.md", _resolved_insight_input: "覆盖 + 兜底组合。" },
    "覆盖 + 兜底组合。",
    transportRequest(),
    deps,
    { text: "override text", version: "aha-query-plan-custom-abc123" },
  );
  assert.equal(outcome.generatedBy, "rules");
  assert.equal(outcome.fallback, true);
  assert.equal(outcome.promptVersion, "aha-query-plan-custom-abc123");
});

test("an empty-string promptOverride.text is treated as no override (byte-identical behavior)", async () => {
  const { deps: depsA, calls: callsA } = fakeDeps([responsesEnvelope(validPlan)]);
  const { deps: depsB, calls: callsB } = fakeDeps([responsesEnvelope(validPlan)]);
  const args = { sourcePath: "Source.md", _resolved_insight_input: "空覆盖应等同于未传覆盖。" };

  const withoutParam = await generateQueryPlanViaLlm(args, args._resolved_insight_input, transportRequest(), depsA);
  const withEmptyOverride = await generateQueryPlanViaLlm(args, args._resolved_insight_input, transportRequest(), depsB, { text: "   ", version: "should-not-be-used" });

  assert.equal(withoutParam.promptVersion, QUERY_PLAN_PROMPT_VERSION);
  assert.equal(withEmptyOverride.promptVersion, QUERY_PLAN_PROMPT_VERSION);
  assert.deepEqual(callsA[0].body.input, callsB[0].body.input);
});
