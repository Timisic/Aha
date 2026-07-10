import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const pipelineBench = path.join(repoRoot, "scripts/bench/run-pipeline-bench.mjs");

test("pipeline benchmark separates product parity from diagnostic enhancement", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "aha-pipeline-profiles-"));
  const vault = path.join(root, "vault");
  const bin = path.join(root, "bin");
  const cases = path.join(root, "cases.json");
  const codex = path.join(bin, "codex");
  const qmd = path.join(bin, "qmd");
  const obsidian = path.join(bin, "obsidian");
  const qmdSdkModule = path.join(root, "private-qmd-sdk.mjs");
  const productReportPath = path.join(root, "bench/reports/latest/product-parity.json");
  const failedProductReportPath = path.join(root, "bench/reports/latest/product-parity-failed.json");
  const retrievalFailureReportPath = path.join(root, "bench/reports/latest/product-parity-retrieval-failed.json");
  const queryTimeoutReportPath = path.join(root, "bench/reports/latest/product-parity-query-timeout.json");
  const diagnosticReportPath = path.join(root, "bench/reports/latest/diagnostic-enhanced.json");

  await mkdir(path.join(vault, "Memory"), { recursive: true });
  await mkdir(bin, { recursive: true });
  await writeFile(path.join(vault, "Source.md"), "# Source\n\nA product-parity source insight.\n");
  await writeFile(path.join(vault, "Memory/First.md"), "# First\n\nFirst candidate evidence.\n");
  await writeFile(path.join(vault, "Memory/Second.md"), "# Second\n\nSecond candidate evidence.\n");
  await writeQmdSdkModule(qmdSdkModule);
  await writeFile(cases, `${JSON.stringify({
    version: 3,
    privacy: "sanitized-synthetic",
    collection: "obsidian",
    suites: {
      development: { version: "dev-profile-v1" },
      holdout: { version: "holdout-profile-v1", frozen: true, change_reason: "Test fixture." },
    },
    expected_in_top_k: 2,
    cases: [{
      id: "profile-parity",
      state: "active",
      suite: "development",
      evaluation_mode: "discovery",
      provenance: { origin: "synthetic", reason: "Product parity profile fixture." },
      input: { note: "Source.md", whole_note: true },
      gold: { must: ["Memory/Second.md", "Memory/First.md"], nice: [], noise: [] },
    }],
  }, null, 2)}\n`);
  await writeRuntimeHelpers({ codex, qmd, obsidian });

  const commonArgs = [
    pipelineBench,
    "--cases", cases,
    "--qmd", qmd,
    "--obsidian", obsidian,
    "--llm-provider", "codex-cli",
  ];
  const env = {
    ...process.env,
    AHA_BENCH_VAULT_ROOT: vault,
    QMD_REMOTE_EMBED_URL: "http://private-qmd.test/embed",
    QMD_REMOTE_EMBED_MODEL: "embed-test",
    QMD_REMOTE_GENERATE_URL: "http://private-qmd.test/generate",
    QMD_REMOTE_GENERATE_MODEL: "generate-test",
    QMD_REMOTE_RERANK_URL: "http://private-qmd.test/rerank",
    QMD_REMOTE_RERANK_MODEL: "rerank-test",
  };

  try {
    const productRun = spawnSync(process.execPath, [
      ...commonArgs,
      "--profile", "product-parity",
      "--report", productReportPath,
      "--limit", "18",
      "--runtime-qmd-runner", "sdk",
      "--runtime-qmd-sdk-module", qmdSdkModule,
      "--runtime-qmd-rerank",
      "--runtime-codex-command", codex,
      "--runtime-codex-model", "codex-product-test",
      "--runtime-codex-reasoning-effort", "medium",
      "--runtime-codex-sandbox", "read-only",
    ], { cwd: root, encoding: "utf8", env, timeout: 30_000 });

    assert.equal(productRun.status, 0, productRun.stderr);
    const productReport = JSON.parse(await readFile(productReportPath, "utf8"));
    const productResult = productReport.results[0];
    const productTrace = JSON.parse(await readFile(
      path.resolve(path.dirname(productReportPath), productResult.trace_json),
      "utf8",
    ));
    const resultFiles = productResult.pipeline.top_candidates.map((candidate) => candidate.file);
    const traceFiles = productTrace.steps.final_candidates.map((candidate) => candidate.file);

    assert.equal(productReport.profile, "product-parity");
    assert.equal(productReport.metadata.profile, "product-parity");
    assert.equal(productReport.metadata.runtime_configuration.entry_point, "scripts/aha/run-insight-search.mjs");
    assert.equal(productReport.metadata.runtime_configuration.qmd_runner, "sdk");
    assert.deepEqual(productReport.metadata.effective_configuration, {
      profile: "product-parity",
      index: "obsidian",
      collection: "obsidian",
      source_note_filter: true,
      llm: {
        provider: "codex-cli",
        model: "gpt-5.5",
        endpoint_identity: `sha256:${createHash("sha256").update("https://api.openai.com/v1").digest("hex")}`,
      },
      runtime_codex: {
        command: "codex",
        version: "codex-test 1.0",
        model: "codex-product-test",
        reasoning_effort: "medium",
        sandbox: "read-only",
      },
      qmd: {
        runner: "sdk",
        command: "qmd",
        version: "qmd-test 1.0",
        rerank: true,
        sdk_module_identity: `sha256:${createHash("sha256").update(await readFile(qmdSdkModule)).digest("hex")}`,
        remote_services: {
          embed: {
            endpoint_identity: `sha256:${createHash("sha256").update(env.QMD_REMOTE_EMBED_URL).digest("hex")}`,
            model: "embed-test",
          },
          generate: {
            endpoint_identity: `sha256:${createHash("sha256").update(env.QMD_REMOTE_GENERATE_URL).digest("hex")}`,
            model: "generate-test",
          },
          rerank: {
            endpoint_identity: `sha256:${createHash("sha256").update(env.QMD_REMOTE_RERANK_URL).digest("hex")}`,
            model: "rerank-test",
          },
        },
      },
      obsidian: {
        command: "obsidian",
        version: "ok",
      },
      prompt_versions: {
        query_plan: productReport.metadata.query_prompt_version,
        relation_judge: productReport.metadata.relation_judge_prompt_version,
      },
      candidate_limits: {
        requested_final: 18,
        runtime_final: 18,
        qmd_pool: 20,
        query_plan: 5,
        relation_judge: 18,
      },
    });
    assert.equal(
      productReport.metadata.effective_config_id,
      createHash("sha256")
        .update(JSON.stringify(productReport.metadata.effective_configuration))
        .digest("hex"),
    );
    assert.match(productReport.report, /^(?:bench\/reports\/latest\/product-parity\.json|sha256:[a-f0-9]{64})$/);
    assert.match(productReport.cases, /^(?:cases\.json|sha256:[a-f0-9]{64})$/);
    assert.ok(!Object.hasOwn(productReport.metadata, "git_status"));
    assert.ok(!JSON.stringify(productReport).includes(root));
    assert.equal(productResult.profile, "product-parity");
    assert.deepEqual(productReport.case_counts, {
      total: 1,
      scored: 1,
      not_scored: 0,
      discovery: 1,
      graph_assisted: 0,
    });
    assert.equal(productTrace.profile, "product-parity");
    assert.equal(productTrace.runtime_profile, "product-runtime");
    assert.deepEqual(resultFiles, ["Memory/Second.md", "Memory/First.md"]);
    assert.deepEqual(traceFiles, resultFiles);
    assert.equal(productTrace.steps.source_expansion.mode, "source-links-and-backlinks");
    assert.equal(productTrace.steps.relation_judge.status, "success");
    assert.deepEqual(productResult.openai_transport, {
      query_generation: { request_count: 0, attempt_count: 0, retry_count: 0, retry_categories: {} },
      relation_judge: { request_count: 0, attempt_count: 0, retry_count: 0, retry_categories: {} },
      total: { request_count: 0, attempt_count: 0, retry_count: 0, retry_categories: {} },
    });
    assert.deepEqual(productReport.diagnostics.openai_transport, productResult.openai_transport);
    assert.deepEqual(
      productTrace.steps.relation_judge.reviewed_candidates.map((candidate) => candidate.file),
      ["Memory/Second.md", "Memory/First.md"],
    );
    assert.ok(!Object.hasOwn(productTrace.steps, "backlink_expansion"));

    const failedProductRun = spawnSync(process.execPath, [
      ...commonArgs,
      "--profile", "product-parity",
      "--report", failedProductReportPath,
      "--runtime-qmd-runner", "sdk",
      "--runtime-qmd-sdk-module", qmdSdkModule,
      "--runtime-codex-command", codex,
      "--runtime-codex-model", "codex-product-test",
    ], {
      cwd: root,
      encoding: "utf8",
      env: { ...env, AHA_TEST_RELATION_FAILURE: "1" },
      timeout: 30_000,
    });

    assert.equal(failedProductRun.status, 0, failedProductRun.stderr);
    const failedProductReport = JSON.parse(await readFile(failedProductReportPath, "utf8"));
    const failedProductResult = failedProductReport.results[0];
    assert.equal(failedProductResult.runtime_status, "failed");
    assert.equal(failedProductResult.evaluation_status, "not_scored");
    assert.equal(failedProductResult.mode_evaluation.reason, "runtime_failure");
    assert.deepEqual(failedProductResult.runtime_error, {
      tool: "codex",
      message: "Aha Relation Judge failed.",
      details_hash: failedProductResult.runtime_error.details_hash,
    });
    assert.match(failedProductResult.runtime_error.details_hash, /^[a-f0-9]{64}$/);
    assert.equal(failedProductReport.case_counts.not_scored, 1);
    assert.equal(failedProductResult.failure_attribution.primary, "relation_failure");
    assert.equal(failedProductResult.trace_diagnosis.primary, "relation_failure");
    const failedProductTrace = JSON.parse(await readFile(
      path.resolve(path.dirname(failedProductReportPath), failedProductResult.trace_json),
      "utf8",
    ));
    assert.equal(failedProductTrace.diagnosis.primary, "relation_failure");

    const retrievalFailureRun = spawnSync(process.execPath, [
      ...commonArgs,
      "--profile", "product-parity",
      "--report", retrievalFailureReportPath,
      "--runtime-qmd-runner", "sdk",
      "--runtime-qmd-sdk-module", qmdSdkModule,
      "--runtime-codex-command", codex,
      "--runtime-codex-model", "codex-product-test",
    ], {
      cwd: root,
      encoding: "utf8",
      env: { ...env, AHA_TEST_EMPTY_QMD: "1" },
      timeout: 30_000,
    });

    assert.equal(retrievalFailureRun.status, 0, retrievalFailureRun.stderr);
    const retrievalFailureReport = JSON.parse(await readFile(retrievalFailureReportPath, "utf8"));
    const retrievalFailureResult = retrievalFailureReport.results[0];
    assert.equal(retrievalFailureResult.runtime_status, "failed");
    assert.equal(retrievalFailureResult.failure_attribution.primary, "retrieval_failure");
    assert.equal(retrievalFailureResult.trace_diagnosis.primary, "retrieval_failure");
    const retrievalFailureTrace = JSON.parse(await readFile(
      path.resolve(path.dirname(retrievalFailureReportPath), retrievalFailureResult.trace_json),
      "utf8",
    ));
    assert.equal(retrievalFailureTrace.diagnosis.primary, "retrieval_failure");
    assert.ok(retrievalFailureTrace.errors.some((error) => error.stage === "qmd_retrieval"));

    const queryTimeoutRun = spawnSync(process.execPath, [
      ...commonArgs,
      "--profile", "product-parity",
      "--report", queryTimeoutReportPath,
      "--runtime-qmd-runner", "sdk",
      "--runtime-qmd-sdk-module", qmdSdkModule,
      "--runtime-codex-command", codex,
      "--runtime-codex-model", "codex-product-test",
    ], {
      cwd: root,
      encoding: "utf8",
      env: { ...env, AHA_TEST_QUERY_TIMEOUT: "1" },
      timeout: 30_000,
    });

    assert.equal(queryTimeoutRun.status, 0, queryTimeoutRun.stderr);
    const queryTimeoutReport = JSON.parse(await readFile(queryTimeoutReportPath, "utf8"));
    const queryTimeoutResult = queryTimeoutReport.results[0];
    assert.equal(queryTimeoutResult.runtime_status, "failed");
    assert.equal(queryTimeoutResult.failure_attribution.primary, "query_failure");
    assert.equal(queryTimeoutResult.trace_diagnosis.primary, "query_failure");
    const queryTimeoutTrace = JSON.parse(await readFile(
      path.resolve(path.dirname(queryTimeoutReportPath), queryTimeoutResult.trace_json),
      "utf8",
    ));
    assert.equal(
      queryTimeoutTrace.errors.find((error) => error.stage === "query_generation")?.category,
      "timeout",
    );
    assert.equal(queryTimeoutTrace.diagnosis.primary, "query_failure");

    const diagnosticRun = spawnSync(process.execPath, [
      ...commonArgs,
      "--profile", "diagnostic-enhanced",
      "--report", diagnosticReportPath,
      "--query-generator", "rules",
      "--query-mode", "raw-only",
      "--relation-judge", "agent",
      "--relation-judge-agent-provider", "codex-cli",
      "--relation-judge-agent-bin", codex,
      "--no-relation-judge-agent-cache",
      "--limit", "1",
      "--no-backlinks",
      "--no-archive",
    ], { cwd: repoRoot, encoding: "utf8", env, timeout: 30_000 });

    assert.equal(diagnosticRun.status, 0, diagnosticRun.stderr);
    const diagnosticReport = JSON.parse(await readFile(diagnosticReportPath, "utf8"));
    const diagnosticTrace = JSON.parse(await readFile(
      path.resolve(path.dirname(diagnosticReportPath), diagnosticReport.results[0].trace_json),
      "utf8",
    ));
    assert.equal(diagnosticReport.profile, "diagnostic-enhanced");
    assert.equal(diagnosticReport.metadata.profile, "diagnostic-enhanced");
    assert.equal(diagnosticReport.results[0].profile, "diagnostic-enhanced");
    assert.match(diagnosticReport.results[0].trace_json, /^traces\//);
    assert.equal(diagnosticTrace.profile, "diagnostic-enhanced");
    assert.ok(Object.hasOwn(diagnosticTrace.steps, "backlink_expansion"));
    assert.equal(diagnosticTrace.steps.final_candidates.length, 1);
    assert.deepEqual(
      diagnosticTrace.steps.relation_judge.reviewed_candidates.map((candidate) => candidate.file),
      ["Memory/Second.md", "Memory/First.md"],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function writeRuntimeHelpers({ codex, qmd, obsidian }) {
  await writeFile(codex, [
    "#!/usr/bin/env node",
    "import { writeFileSync } from 'node:fs';",
    "const args = process.argv.slice(2);",
    "if (args.includes('--version')) { console.log('codex-test 1.0'); process.exit(0); }",
    "const outputIndex = args.indexOf('--output-last-message');",
    "const outputFile = outputIndex === -1 ? '' : args[outputIndex + 1];",
    "if (outputFile.endsWith('query-plan.json')) {",
    "  if (process.env.AHA_TEST_QUERY_TIMEOUT === '1') { console.error('planned query timed out'); process.exit(2); }",
    "  writeFileSync(outputFile, JSON.stringify({ queries: [",
    "    { kind: 'raw', command: 'qmd query', qmd: { intent: 'raw', lex: ['source'], vec: 'source insight', hyde: 'old source insight' } },",
    "    { kind: 'abstracted_judgment', command: 'qmd query', qmd: { intent: 'abstracted', lex: ['candidate'], vec: 'candidate evidence', hyde: 'old candidate evidence' } },",
    "    { kind: 'contextual', command: 'qmd query', qmd: { intent: 'context', lex: ['memory'], vec: 'memory context', hyde: 'old memory context' } }",
    "  ] }));",
    "  process.exit(0);",
    "}",
    "if (outputFile.endsWith('relation-judge.json')) {",
    "  if (process.env.AHA_TEST_RELATION_FAILURE === '1') { console.error('planned relation failure'); process.exit(2); }",
    "  writeFileSync(outputFile, JSON.stringify({ ok: true, sourcePath: 'Source.md', summary: 'judge ok', warnings: [], candidates: [",
    "    { notePath: 'Memory/First.md', noteTitle: 'First', relation: 'supports', hit: '\"First candidate evidence.\"', why: 'The judge returns First before Second.', quotes: ['First candidate evidence.'], selected: true },",
    "    { notePath: 'Memory/Second.md', noteTitle: 'Second', relation: 'supports', hit: '\"Second candidate evidence.\"', why: 'The judge returns Second after First.', quotes: ['Second candidate evidence.'], selected: true }",
    "  ] }));",
    "  process.exit(0);",
    "}",
    "console.error('unexpected codex invocation');",
    "process.exit(2);",
    "",
  ].join("\n"));

  await writeFile(qmd, [
    "#!/usr/bin/env node",
    "const args = process.argv.slice(2);",
    "if (args.includes('--version')) { console.log('qmd-test 1.0'); process.exit(0); }",
    "console.log(JSON.stringify([",
    "  { score: 0.95, file: 'qmd://obsidian/Memory/Second.md?index=obsidian', title: 'Second', snippet: 'Second candidate evidence.' },",
    "  { score: 0.90, file: 'qmd://obsidian/Memory/First.md?index=obsidian', title: 'First', snippet: 'First candidate evidence.' }",
    "]));",
    "",
  ].join("\n"));

  await writeFile(obsidian, [
    "#!/usr/bin/env node",
    "const args = process.argv.slice(2);",
    "if (args[0] === 'files' && args[1] === 'total') { console.log('3'); process.exit(0); }",
    "if (args[0] === 'links' || args[0] === 'backlinks') { console.log('[]'); process.exit(0); }",
    "console.log('ok');",
    "",
  ].join("\n"));

  await Promise.all([codex, qmd, obsidian].map((file) => chmod(file, 0o755)));
}

async function writeQmdSdkModule(file) {
  await writeFile(file, [
    "const rows = [",
    "  { score: 0.95, file: 'Memory/Second.md', title: 'Second', snippet: 'Second candidate evidence.' },",
    "  { score: 0.90, file: 'Memory/First.md', title: 'First', snippet: 'First candidate evidence.' },",
    "];",
    "export async function createStore() {",
    "  return {",
    "    async searchLex() { return process.env.AHA_TEST_EMPTY_QMD === '1' ? [] : rows; },",
    "    async search() { return process.env.AHA_TEST_EMPTY_QMD === '1' ? [] : rows; },",
    "    close() {},",
    "  };",
    "}",
    "",
  ].join("\n"));
}
