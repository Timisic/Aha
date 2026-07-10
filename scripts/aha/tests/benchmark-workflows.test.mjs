import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildWorkflowProvenance,
  evaluateBaselinePromotion,
  evaluateHoldoutSnapshotTransition,
  loadPluginRuntimeConfiguration,
  promoteLatestPointer,
  resolveLatestPointer,
  sha256File,
  workflowSpecification,
  writeJsonAtomic,
} from "../../lib/bench-workflow.mjs";

const repoRoot = path.resolve(import.meta.dirname, "../../..");

test("named workflows pin the safe profile and suite boundary", () => {
  assert.deepEqual(workflowSpecification("validate"), {
    command: "validate",
    profile: null,
    suites: [],
    promotes: false,
  });
  assert.deepEqual(workflowSpecification("smoke"), {
    command: "smoke",
    profile: null,
    suites: [],
    promotes: false,
  });
  assert.deepEqual(workflowSpecification("baseline"), {
    command: "baseline",
    profile: "product-parity",
    suites: ["development", "holdout"],
    promotes: true,
  });
  assert.deepEqual(workflowSpecification("diagnostic"), {
    command: "diagnostic",
    profile: "diagnostic-enhanced",
    suites: ["development"],
    promotes: false,
  });
  assert.throws(() => workflowSpecification("unknown"), /unknown evaluation workflow/i);
});

test("workflow provenance records reproducibility facts without private strings", () => {
  const provenance = buildWorkflowProvenance({
    workflow: "baseline",
    runId: "run-1",
    profile: "product-parity",
    startedAt: "2026-07-10T00:00:00.000Z",
    finishedAt: "2026-07-10T00:01:00.000Z",
    startState: { head: "abc123", clean: true, status: "/Users/alice/Private Note.md" },
    endState: { head: "abc123", clean: true },
    casesHash: "cases-hash",
    suiteVersions: { development: "dev-v1", holdout: "holdout-v1" },
    caseCounts: { development: 2, holdout: 1 },
    artifacts: {
      development: { report: "development/report.json", effectiveConfigId: "config-dev" },
    },
    promotion: { eligible: true, reasons: [] },
    secret: "do-not-record",
    noteText: "personal note body",
  });

  assert.equal(provenance.git.commit_start, "abc123");
  assert.equal(provenance.git.clean_end, true);
  assert.equal(provenance.cases.sha256, "cases-hash");
  assert.equal(provenance.artifacts.development.report, "development/report.json");
  const encoded = JSON.stringify(provenance);
  assert.ok(!encoded.includes("/Users/"));
  assert.ok(!encoded.includes("Private Note"));
  assert.ok(!encoded.includes("do-not-record"));
  assert.ok(!encoded.includes("personal note body"));
});

test("product-parity configuration is loaded from plugin settings without exposing its API key", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "aha-plugin-runtime-settings-"));
  const pluginDataPath = path.join(root, "data.json");
  const secret = "test-secret-value";
  await writeFile(pluginDataPath, JSON.stringify({
    settings: {
      ahaWorkspace: repoRoot,
      llmProvider: "openai",
      llmBaseUrl: "https://example.invalid/v1",
      llmModel: "model-current",
      llmApiKey: secret,
      llmApiKeyEnv: "AHA_TEST_PLUGIN_KEY",
      codexCommand: "/opt/tools/codex-current",
      codexModel: "codex-current",
      codexReasoningEffort: "high",
      codexSandbox: "read-only",
      qmdRunner: "sdk",
      qmdCommand: "/opt/tools/qmd-current",
      qmdIndex: "obsidian-current",
      qmdSdkModule: "/opt/tools/qmd-sdk.mjs",
      qmdRerank: true,
      obsidianCommand: "/opt/tools/obsidian-current",
      wrapperRelativePath: "scripts/aha/run-insight-search.mjs",
      targetCandidates: 17,
      useFixtureResult: false,
    },
    sessionStore: { private: "must-not-affect-runtime-settings" },
  }));

  const loaded = loadPluginRuntimeConfiguration(pluginDataPath, { repoRoot });
  const args = loaded.runnerArgs.join(" ");
  assert.match(args, /--runtime-codex-model codex-current/);
  assert.match(args, /--runtime-codex-reasoning-effort high/);
  assert.match(args, /--runtime-qmd-runner sdk/);
  assert.match(args, /--qmd \/opt\/tools\/qmd-current/);
  assert.match(args, /--obsidian \/opt\/tools\/obsidian-current/);
  assert.match(args, /--index obsidian-current/);
  assert.match(args, /--limit 17/);
  assert.equal(loaded.environment.AHA_TEST_PLUGIN_KEY, secret);
  assert.match(loaded.settingsId, /^[a-f0-9]{64}$/);
  assert.ok(!args.includes(secret));
  assert.ok(!JSON.stringify(loaded.provenance).includes(secret));

  const fixture = JSON.parse(await readFile(pluginDataPath, "utf8"));
  fixture.settings.useFixtureResult = true;
  await writeFile(pluginDataPath, JSON.stringify(fixture));
  assert.throws(
    () => loadPluginRuntimeConfiguration(pluginDataPath, { repoRoot }),
    /fixture result.*product-parity/i,
  );
  await rm(root, { recursive: true, force: true });
});

test("baseline promotion requires clean current complete product-parity evidence", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "aha-workflow-eligibility-"));
  const casesPath = path.join(root, "cases.json");
  await writeFile(casesPath, "{}\n");
  const developmentReportPath = await writeSuiteArtifact(root, "development", ["case-1"]);
  const holdoutReportPath = await writeSuiteArtifact(root, "holdout", ["case-2"]);
  const common = {
    workflow: "baseline",
    profile: "product-parity",
    startState: { head: "abc123", clean: true },
    endState: { head: "abc123", clean: true },
    casesHashStart: await sha256File(casesPath),
    casesHashEnd: await sha256File(casesPath),
    suiteValidationStatus: "ready",
    identitiesReady: true,
    suiteVersions: { development: "dev-v1", holdout: "holdout-v1" },
    expectedCaseIds: { development: ["case-1"], holdout: ["case-2"] },
    artifacts: {
      development: { reportPath: developmentReportPath },
      holdout: { reportPath: holdoutReportPath },
    },
    holdoutTransition: { status: "unchanged", reasons: [] },
    repoRoot: root,
  };

  assert.deepEqual(evaluateBaselinePromotion(common), { eligible: true, reasons: [] });
  assert.deepEqual(
    evaluateBaselinePromotion({
      ...common,
      expectedCaseIds: { development: ["case-1"] },
      artifacts: { development: { reportPath: developmentReportPath } },
    }),
    { eligible: false, reasons: ["missing_active_suite:holdout"] },
  );
  assert.deepEqual(
    evaluateBaselinePromotion({
      ...common,
      holdoutTransition: { status: "invalid", reasons: ["holdout_version_not_changed"] },
    }),
    { eligible: false, reasons: ["holdout_version_not_changed"] },
  );
  assert.deepEqual(
    evaluateBaselinePromotion({ ...common, endState: { head: "def456", clean: false } }),
    { eligible: false, reasons: ["dirty_worktree_end", "git_head_changed"] },
  );

  const tracePath = path.join(root, "development/traces/case-1.json");
  const trace = JSON.parse(await readFile(tracePath, "utf8"));
  trace.status = "partial";
  await writeFile(tracePath, JSON.stringify(trace));
  assert.deepEqual(
    evaluateBaselinePromotion(common),
    { eligible: false, reasons: ["trace_not_success:development:case-1"] },
  );

  trace.status = "success";
  await writeFile(tracePath, JSON.stringify(trace));
  const report = JSON.parse(await readFile(developmentReportPath, "utf8"));
  report.results[0].evaluation_status = "not_scored";
  await writeFile(developmentReportPath, JSON.stringify(report));
  assert.deepEqual(
    evaluateBaselinePromotion(common),
    { eligible: false, reasons: ["case_not_scored:development:case-1"] },
  );

  report.results[0].evaluation_status = "scored";
  delete report.results[0].runtime_status;
  await writeFile(developmentReportPath, JSON.stringify(report));
  assert.deepEqual(
    evaluateBaselinePromotion(common),
    { eligible: false, reasons: ["runtime_not_success:development:case-1"] },
  );
  await rm(root, { recursive: true, force: true });
});

test("holdout transition requires a versioned, explained semantic change", () => {
  const previous = {
    version: "holdout-v1",
    frozen: true,
    change_reason: "Initial split.",
    fingerprint: "fingerprint-a",
  };
  assert.deepEqual(evaluateHoldoutSnapshotTransition(null, previous), {
    status: "initial",
    reasons: [],
  });
  assert.deepEqual(evaluateHoldoutSnapshotTransition(previous, previous), {
    status: "unchanged",
    reasons: [],
  });
  assert.deepEqual(
    evaluateHoldoutSnapshotTransition(previous, { ...previous, fingerprint: "fingerprint-b" }),
    { status: "invalid", reasons: ["holdout_version_not_changed"] },
  );
  assert.deepEqual(
    evaluateHoldoutSnapshotTransition(previous, {
      ...previous,
      version: "holdout-v2",
      fingerprint: "fingerprint-b",
      change_reason: null,
    }),
    { status: "invalid", reasons: ["missing_holdout_change_reason"] },
  );
  assert.deepEqual(
    evaluateHoldoutSnapshotTransition(previous, {
      ...previous,
      version: "holdout-v2",
      fingerprint: "fingerprint-b",
      change_reason: "Add a newly reviewed frozen case.",
    }),
    { status: "versioned_change", reasons: [] },
  );
});

test("latest pointer replacement is atomic and hash-verified", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "aha-workflow-pointer-"));
  const runDir = path.join(root, "runs/run-1");
  const manifestPath = path.join(runDir, "manifest.json");
  const pointerPath = path.join(root, "latest/product-parity.json");
  const reportPath = await writeSuiteArtifact(runDir, "development", ["case-1"]);
  const tracePath = path.join(runDir, "development/traces/case-1.json");
  await writeJsonAtomic(manifestPath, {
    schema: "AhaBenchmarkWorkflowRun",
    version: 1,
    run_id: "run-1",
    profile: "product-parity",
    artifacts: {
      development: {
        report: "development/report.json",
        report_sha256: await sha256File(reportPath),
        traces: {
          "development/traces/case-1.json": await sha256File(tracePath),
        },
      },
    },
    promotion: { eligible: true, reasons: [] },
  });

  await promoteLatestPointer({
    pointerPath,
    manifestPath,
    gitCommit: "abc123",
    suiteVersions: { development: "dev-v1" },
    promotedAt: "2026-07-10T00:02:00.000Z",
  });

  const resolved = await resolveLatestPointer(pointerPath);
  assert.equal(resolved.manifest.run_id, "run-1");
  assert.equal(resolved.reportPaths.development, path.join(runDir, "development/report.json"));
  assert.deepEqual((await readdir(path.dirname(pointerPath))).sort(), ["product-parity.json"]);

  const originalReport = await readFile(reportPath, "utf8");
  await writeFile(reportPath, "{}\n");
  await assert.rejects(() => resolveLatestPointer(pointerPath), /report hash mismatch/i);
  await writeFile(reportPath, originalReport);

  const originalTrace = await readFile(tracePath, "utf8");
  await writeFile(tracePath, "{}\n");
  await assert.rejects(() => resolveLatestPointer(pointerPath), /trace hash mismatch/i);
  await writeFile(tracePath, originalTrace);

  await writeFile(manifestPath, "{}\n");
  await assert.rejects(() => resolveLatestPointer(pointerPath), /manifest hash mismatch/i);
  await rm(root, { recursive: true, force: true });
});

test("validate workflow checks a sanitized synthetic suite without a private vault", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "aha-workflow-validate-"));
  const casesPath = path.join(root, "cases.json");
  const reportsRoot = path.join(root, "reports");
  await writeFile(casesPath, JSON.stringify({
    privacy: "sanitized-synthetic",
    version: 3,
    collection: "obsidian",
    suites: { development: { version: "dev-synthetic-v1" } },
    cases: [{
      id: "synthetic-case",
      state: "active",
      suite: "development",
      evaluation_mode: "discovery",
      provenance: { origin: "synthetic", reason: "Repository-owned deterministic validation case." },
      input: { thought: "Synthetic benchmark thought." },
      gold: { must: ["Sanitized/Must.md"], nice: [], noise: [] },
    }],
  }));

  const result = spawnSync(process.execPath, [
    "scripts/bench/run-eval-workflow.mjs",
    "validate",
    "--cases", casesPath,
    "--reports-root", reportsRoot,
    "--run-id", "validate-test",
  ], { cwd: repoRoot, encoding: "utf8" });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const manifest = JSON.parse(await readFile(path.join(reportsRoot, "runs/validate-test/manifest.json"), "utf8"));
  assert.equal(manifest.status, "complete");
  assert.equal(manifest.validation.status, "ready");
  assert.deepEqual(manifest.cases.counts, {
    total: 1,
    development: 1,
    holdout: 0,
    discovery: 1,
    graph_assisted: 0,
  });

  const manifestBefore = await readFile(path.join(reportsRoot, "runs/validate-test/manifest.json"), "utf8");
  const repeated = spawnSync(process.execPath, [
    "scripts/bench/run-eval-workflow.mjs",
    "validate",
    "--cases", casesPath,
    "--reports-root", reportsRoot,
    "--run-id", "validate-test",
  ], { cwd: repoRoot, encoding: "utf8" });
  assert.notEqual(repeated.status, 0);
  assert.match(repeated.stderr, /run directory already exists/i);
  assert.equal(await readFile(path.join(reportsRoot, "runs/validate-test/manifest.json"), "utf8"), manifestBefore);
  await rm(root, { recursive: true, force: true });
});

test("validate workflow rejects invalid off cases without making them runnable", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "aha-workflow-off-validation-"));
  const casesPath = path.join(root, "cases.json");
  const reportsRoot = path.join(root, "reports");
  await writeFile(casesPath, JSON.stringify({
    privacy: "sanitized-synthetic",
    version: 3,
    collection: "obsidian",
    suites: { development: { version: "dev-synthetic-v1" } },
    cases: [
      {
        id: "active-valid",
        state: "active",
        suite: "development",
        evaluation_mode: "discovery",
        provenance: { origin: "synthetic", reason: "Runnable synthetic case." },
        input: { thought: "Synthetic active thought." },
        gold: { must: ["Sanitized/Must.md"], nice: [], noise: [] },
      },
      {
        id: "off-invalid",
        state: "off",
        suite: "development",
        evaluation_mode: "unsupported-mode",
        provenance: { origin: "synthetic", reason: "Disabled but still schema-validated." },
        input: { thought: "Synthetic disabled thought." },
        gold: { must: ["Sanitized/Off.md"], nice: [], noise: [] },
      },
    ],
  }));

  const result = spawnSync(process.execPath, [
    "scripts/bench/run-eval-workflow.mjs",
    "validate",
    "--cases", casesPath,
    "--reports-root", reportsRoot,
    "--run-id", "validate-off-test",
  ], { cwd: repoRoot, encoding: "utf8" });

  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.match(result.stderr, /invalid_evaluation_mode/i);
  const manifest = JSON.parse(await readFile(path.join(reportsRoot, "runs/validate-off-test/manifest.json"), "utf8"));
  assert.equal(manifest.status, "failed");
  await rm(root, { recursive: true, force: true });
});

async function writeSuiteArtifact(root, suite, caseIds) {
  const suiteDir = path.join(root, suite);
  const tracesDir = path.join(suiteDir, "traces");
  const reportPath = path.join(suiteDir, "report.json");
  await mkdir(tracesDir, { recursive: true });
  for (const id of caseIds) {
    await writeFile(path.join(tracesDir, `${id}.json`), JSON.stringify({
      schema: "PipelineTrace",
      version: 2,
      profile: "product-parity",
      status: "success",
      case: { id },
    }));
  }
  await writeFile(reportPath, JSON.stringify({
    profile: "product-parity",
    suite: { kind: suite, version: `${suite === "development" ? "dev" : suite}-v1` },
    suite_validation: { status: "ready" },
    metadata: {
      git_commit: "abc123",
      git_clean: true,
      trace_schema: "PipelineTrace",
      trace_version: 2,
      effective_config_id: `config-${suite}`,
    },
    results: caseIds.map((id) => ({
      id,
      runtime_status: "success",
      evaluation_status: "scored",
      trace_json: `traces/${id}.json`,
    })),
  }));
  return reportPath;
}
