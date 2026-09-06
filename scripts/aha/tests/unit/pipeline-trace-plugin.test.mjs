// Tests for the plugin-side, lighter Pipeline Trace writer (issue #59;
// ADR 0003): obsidian-plugin/src/pipeline-trace.ts. Covers the schema/version
// guard against scripts/lib/pipeline-trace.mjs's bench-side constants, the
// `origin: "plugin"` marker, prompt-version threading (built-in vs. override),
// and that the trace file is written only when a traceDirectory is given
// (asserting zero filesystem writes when it is not).
//
// pipeline-trace.ts uses Node's crypto/fs/path via getNodeRequire() (the same
// pattern process.ts/qmd-request.ts already use), so tests that call
// writePluginPipelineTrace set globalThis.require the same way
// process-bridge.test.mjs does for process.ts.

import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { TRACE_SCHEMA as BENCH_TRACE_SCHEMA, TRACE_VERSION as BENCH_TRACE_VERSION } from "../../../lib/pipeline-trace.mjs";

const repoRoot = path.resolve(import.meta.dirname, "../../../..");
const requireFromPlugin = createRequire(path.join(repoRoot, "obsidian-plugin/package.json"));
const esbuild = requireFromPlugin("esbuild");

// pipeline-trace.ts's sha256Hex/writePluginPipelineTrace both go through
// getNodeRequire() (the same globalThis.require pattern process.ts and
// qmd-request.ts use), which is unavailable in a plain Node ESM module scope
// unless installed explicitly -- the same setup process-bridge.test.mjs uses
// for process.ts. Installed for this whole file since every test here
// exercises that code path.
globalThis.require = createRequire(import.meta.url);

async function loadModule() {
  const temp = await mkdtemp(path.join(tmpdir(), "aha-pipeline-trace-test-"));
  const entry = path.join(temp, "entry.ts");
  const out = path.join(temp, "bundle.mjs");
  await writeFile(entry, `export * from ${JSON.stringify(path.join(repoRoot, "obsidian-plugin/src/pipeline-trace.ts"))};\n`);
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

const baseResult = {
  ok: true,
  sourcePath: "Source.md",
  generatedAt: "2026-01-01T00:00:00.000Z",
  summary: "Full Tier round summary.",
  warnings: [],
  candidates: [
    {
      notePath: "Memory/Feedback.md",
      noteTitle: "Feedback",
      relation: "supports",
      hit: "\"Feedback loops expose experience gaps\"",
      why: "Feedback evidence connects the old note to the current source insight.",
      quotes: ["Feedback loops expose experience gaps"],
      selected: true,
    },
  ],
};

test("TRACE_SCHEMA/TRACE_VERSION stay in sync with the bench-side source of truth", async () => {
  const { TRACE_SCHEMA, TRACE_VERSION } = await loadModule();
  assert.equal(TRACE_SCHEMA, BENCH_TRACE_SCHEMA);
  assert.equal(TRACE_VERSION, BENCH_TRACE_VERSION);
});

test("buildPluginPipelineTrace stamps origin: plugin and a schema-valid shape", async () => {
  const { buildPluginPipelineTrace, TRACE_SCHEMA, TRACE_VERSION } = await loadModule();
  const trace = buildPluginPipelineTrace({
    sourcePath: "Source.md",
    sourceTitle: "Source",
    sourceText: "反馈闭环暴露经验差距。",
    tier: "full",
    result: baseResult,
    queryPlan: { generatedBy: "llm", fallback: false, error: null, promptVersion: "aha-query-plan-v6" },
  });

  assert.equal(trace.schema, TRACE_SCHEMA);
  assert.equal(trace.version, TRACE_VERSION);
  assert.equal(trace.origin, "plugin");
  assert.equal(trace.case.id, "Source.md");
  assert.equal(trace.gold_positions, null);
  assert.equal(trace.diagnosis, null);
  assert.equal(trace.steps.backlink_expansion, null);
  assert.equal(trace.steps.pre_rerank_candidates, null);
  assert.equal(trace.steps.final_candidates.length, 1);
  assert.equal(trace.steps.final_candidates[0].file, "Memory/Feedback.md");
  assert.equal(trace.steps.final_candidates[0].relation, "supports");
});

test("without a prompt override, the trace records the built-in prompt version", async () => {
  const { buildPluginPipelineTrace } = await loadModule();
  const trace = buildPluginPipelineTrace({
    sourcePath: "Source.md",
    sourceTitle: "Source",
    sourceText: "source text",
    tier: "full",
    result: baseResult,
    queryPlan: { generatedBy: "llm", fallback: false, error: null, promptVersion: "aha-query-plan-v6" },
  });
  assert.equal(trace.steps.query_generation.prompt_version, "aha-query-plan-v6");
  assert.equal(trace.steps.query_generation.generated_by, "llm");
  assert.equal(trace.steps.rerank.generated_by, "llm");
});

test("with a prompt override active, the trace records the custom content-hash version", async () => {
  const { buildPluginPipelineTrace } = await loadModule();
  const trace = buildPluginPipelineTrace({
    sourcePath: "Source.md",
    sourceTitle: "Source",
    sourceText: "source text",
    tier: "full",
    result: baseResult,
    queryPlan: { generatedBy: "llm", fallback: false, error: null, promptVersion: "aha-query-plan-custom-deadbeefdeadbeef" },
  });
  assert.equal(trace.steps.query_generation.prompt_version, "aha-query-plan-custom-deadbeefdeadbeef");
});

test("Full Tier trace records every judge batch, refill source, stop reason, calls, and elapsed time", async () => {
  const { buildPluginPipelineTrace } = await loadModule();
  const relationJudgeTrace = {
    targetNonWeakCount: 2,
    budget: 4,
    poolSize: 4,
    reviewedCount: 3,
    nonWeakCount: 2,
    weakCount: 1,
    failedCount: 0,
    repairedCount: 0,
    callCount: 3,
    elapsedMs: 125,
    stopReason: "target_reached",
    batches: [
      { batchIndex: 1, refillSource: "initial", poolStartRank: 1, poolEndRank: 2, candidatePaths: ["Memory/A.md", "Memory/B.md"], reviewedCount: 2, nonWeakCount: 1, weakCount: 1, failedCount: 0, repairedCount: 0, callCount: 2, elapsedMs: 80 },
      { batchIndex: 2, refillSource: "weak_backfill", poolStartRank: 3, poolEndRank: 3, candidatePaths: ["Memory/C.md"], reviewedCount: 1, nonWeakCount: 1, weakCount: 0, failedCount: 0, repairedCount: 0, callCount: 1, elapsedMs: 45 },
    ],
  };
  const trace = buildPluginPipelineTrace({
    sourcePath: "Source.md",
    sourceTitle: "Source",
    sourceText: "source text",
    tier: "full",
    result: baseResult,
    queryPlan: { generatedBy: "llm", fallback: false, error: null, promptVersion: "aha-query-plan-v7" },
    relationJudgeTrace,
  });

  assert.equal(trace.steps.rerank.backfill.stop_reason, "target_reached");
  assert.equal(trace.steps.rerank.backfill.call_count, 3);
  assert.equal(trace.steps.rerank.backfill.elapsed_ms, 125);
  assert.deepEqual(trace.steps.rerank.backfill.batches.map((batch) => batch.refill_source), ["initial", "weak_backfill"]);
  assert.deepEqual(trace.steps.rerank.backfill.batches[1].candidate_paths, ["Memory/C.md"]);
});

test("Recall Tier rounds (no queryPlan) record generated_by: rules and rerank: none", async () => {
  const { buildPluginPipelineTrace } = await loadModule();
  const trace = buildPluginPipelineTrace({
    sourcePath: "Source.md",
    sourceTitle: "Source",
    sourceText: "source text",
    tier: "recall",
    result: baseResult,
  });
  assert.equal(trace.steps.query_generation.generated_by, "rules");
  assert.equal(trace.steps.query_generation.prompt_version, null);
  assert.equal(trace.steps.rerank.generated_by, "none");
});

test("Neighborhood Tier rounds record a null query_generation.generated_by", async () => {
  const { buildPluginPipelineTrace } = await loadModule();
  const trace = buildPluginPipelineTrace({
    sourcePath: "Source.md",
    sourceTitle: "Source",
    sourceText: "source text",
    tier: "neighborhood",
    result: baseResult,
  });
  assert.equal(trace.steps.query_generation.generated_by, null);
});

test("writePluginPipelineTrace creates the directory and writes a schema-valid JSON file", async () => {
  const { buildPluginPipelineTrace, writePluginPipelineTrace } = await loadModule();
  const temp = await mkdtemp(path.join(tmpdir(), "aha-trace-write-"));
  const traceDirectory = path.join(temp, "nested", "traces");

  try {
    const trace = buildPluginPipelineTrace({
      sourcePath: "Idea/Source.md",
      sourceTitle: "Source",
      sourceText: "source text",
      tier: "full",
      result: baseResult,
      queryPlan: { generatedBy: "llm", fallback: false, error: null, promptVersion: "aha-query-plan-v6" },
    });
    const writtenPath = writePluginPipelineTrace(trace, traceDirectory);
    const files = await readdir(traceDirectory);
    assert.equal(files.length, 1);
    assert.ok(files[0].endsWith(".json"));
    const contents = JSON.parse(await readFile(writtenPath, "utf-8"));
    assert.equal(contents.origin, "plugin");
    assert.equal(contents.case.id, "Idea/Source.md");
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("trace filenames retain Chinese titles and distinguish same-second runs without hashes", async () => {
  const { buildPluginPipelineTrace, writePluginPipelineTrace } = await loadModule();
  const temp = await mkdtemp(path.join(tmpdir(), "aha-trace-name-"));
  try {
    const trace = buildPluginPipelineTrace({ sourcePath: "Folder/独处与实践.md", sourceTitle: "独处与实践", sourceText: "text", tier: "full", result: baseResult });
    const first = writePluginPipelineTrace(trace, temp);
    const second = writePluginPipelineTrace(trace, temp);
    assert.match(path.basename(first), /^独处与实践__\d{8}-\d{6}\.json$/);
    assert.notEqual(first, second);
    assert.equal((await readdir(temp)).length, 2);
  } finally { await rm(temp, { recursive: true, force: true }); }
});

// --- recordPipelineTrace: the completion sequence both ends now share ---
//
// Config gating, build, write, trace back-fill onto the result, and failure
// degradation used to be re-implemented at each call site (tier-pipeline.ts
// and scripts/dev/run-batch-vault.mjs). These verify the guarantees once, at
// the module's own interface.

test("recordPipelineTrace writes the trace and makes the reference readable from the result", async () => {
  const { recordPipelineTrace } = await loadModule();
  const traceDirectory = await mkdtemp(path.join(tmpdir(), "aha-record-trace-"));
  try {
    const result = { ...baseResult, warnings: [] };
    const outcome = recordPipelineTrace({
      traceDirectory,
      sourcePath: "Source.md",
      sourceTitle: "Source",
      sourceText: "The source note.",
      tier: "recall",
      result,
    });

    assert.equal(outcome.status, "written");
    assert.equal(result.trace.path, outcome.tracePath);
    assert.equal(result.trace.origin, "plugin");
    assert.ok(result.warnings.some((warning) => warning.startsWith("Pipeline trace saved:")));
    const written = JSON.parse(await readFile(result.trace.path, "utf-8"));
    assert.equal(written.schema, "PipelineTrace");
    assert.equal(written.case.id, "Source.md");
  } finally {
    await rm(traceDirectory, { recursive: true, force: true });
  }
});

test("recordPipelineTrace stamps a batch round's reference with the batch origin", async () => {
  const { recordPipelineTrace } = await loadModule();
  const traceDirectory = await mkdtemp(path.join(tmpdir(), "aha-record-trace-batch-"));
  try {
    const result = { ...baseResult, warnings: [] };
    recordPipelineTrace({
      traceDirectory,
      origin: "batch",
      sourcePath: "Source.md",
      sourceTitle: "Source",
      sourceText: "The source note.",
      tier: "full",
      result,
    });

    assert.equal(result.trace.origin, "batch");
    assert.equal(JSON.parse(await readFile(result.trace.path, "utf-8")).origin, "batch");
  } finally {
    await rm(traceDirectory, { recursive: true, force: true });
  }
});

test("an unset traceDirectory disables tracing entirely -- no write, no warning, no trace reference", async () => {
  const { recordPipelineTrace } = await loadModule();
  for (const traceDirectory of ["", "   ", undefined, null]) {
    const result = { ...baseResult, warnings: [] };
    const outcome = recordPipelineTrace({
      traceDirectory,
      sourcePath: "Source.md",
      sourceTitle: "Source",
      sourceText: "The source note.",
      tier: "recall",
      result,
    });
    assert.equal(outcome.status, "disabled");
    assert.equal(result.trace, undefined);
    assert.deepEqual(result.warnings, []);
  }
});

test("a write failure never discards the round: the result survives with a warning", async () => {
  const { recordPipelineTrace } = await loadModule();
  const temp = await mkdtemp(path.join(tmpdir(), "aha-record-trace-fail-"));
  try {
    const traceDirectory = path.join(temp, "not-a-directory");
    await writeFile(traceDirectory, "existing file");
    const result = { ...baseResult, warnings: ["an earlier warning"] };
    const outcome = recordPipelineTrace({
      traceDirectory,
      sourcePath: "Source.md",
      sourceTitle: "Source",
      sourceText: "The source note.",
      tier: "recall",
      result,
    });

    assert.equal(outcome.status, "failed");
    assert.match(outcome.warning, /^Pipeline trace write failed:/);
    assert.equal(result.ok, true, "a trace failure must not turn a successful round into a failure");
    assert.equal(result.trace, undefined, "no reference is attached when nothing was written");
    assert.deepEqual(result.warnings, ["an earlier warning", outcome.warning]);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("fullPipelineTraceFields maps a Full Tier result's four trace inputs, and records no query generation without a prompt version", async () => {
  const { fullPipelineTraceFields, buildPluginPipelineTrace } = await loadModule();
  const fullResult = {
    ...baseResult,
    queryPlanGeneratedBy: "llm",
    queryPlanFallback: false,
    queryPlanPromptVersion: "aha-query-plan-v6",
    queryPlanQueries: [{ kind: "raw", command: "qmd query", text: "feedback" }],
    qmdQueryResults: [{ query: { kind: "raw", command: "qmd query", text: "feedback" }, rows: [] }],
    pooledCandidates: [],
    relationJudgeTrace: undefined,
  };

  const fields = fullPipelineTraceFields(fullResult);
  assert.equal(fields.queryPlan.promptVersion, "aha-query-plan-v6");
  assert.equal(fields.queryPlan.generatedBy, "llm");
  assert.equal(fields.queryPlan.error, null);
  assert.equal(fields.qmdQueryResults.length, 1);

  const trace = buildPluginPipelineTrace({
    sourcePath: "Source.md", sourceTitle: "Source", sourceText: "x", tier: "full", result: fullResult, ...fields,
  });
  assert.equal(trace.steps.query_generation.prompt_version, "aha-query-plan-v6");

  const bare = fullPipelineTraceFields({});
  assert.equal(bare.queryPlan, undefined);
});
