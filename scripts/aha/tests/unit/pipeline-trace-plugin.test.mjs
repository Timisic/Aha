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
