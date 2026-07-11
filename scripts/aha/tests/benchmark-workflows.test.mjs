import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
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
      development: {
        report: "development/report.json",
        effectiveConfigId: "config-dev",
        openAiTransport: {
          request_count: 4,
          attempt_count: 5,
          retry_count: 1,
          retry_categories: { http_429: 1, "do-not-record": 99 },
        },
      },
      holdout: {
        report: "holdout/report.json",
        effectiveConfigId: "config-holdout",
        openAiTransport: { request_count: 2, attempt_count: 2, retry_count: 0, retry_categories: {} },
      },
    },
    promotion: { eligible: true, reasons: [], warnings: ["recovered_openai_retries:development:1"] },
    secret: "do-not-record",
    noteText: "personal note body",
  });

  assert.equal(provenance.git.commit_start, "abc123");
  assert.equal(provenance.git.clean_end, true);
  assert.equal(provenance.cases.sha256, "cases-hash");
  assert.equal(provenance.artifacts.development.report, "development/report.json");
  assert.deepEqual(provenance.openai_transport, {
    by_suite: {
      development: { request_count: 4, attempt_count: 5, retry_count: 1, retry_categories: { http_429: 1 } },
      holdout: { request_count: 2, attempt_count: 2, retry_count: 0, retry_categories: {} },
    },
    total: { request_count: 6, attempt_count: 7, retry_count: 1, retry_categories: { http_429: 1 } },
  });
  assert.deepEqual(provenance.promotion.warnings, ["recovered_openai_retries:development:1"]);
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

  assert.deepEqual(evaluateBaselinePromotion(common), { eligible: true, reasons: [], warnings: [] });
  assert.deepEqual(
    evaluateBaselinePromotion({
      ...common,
      expectedCaseIds: { development: ["case-1"] },
      artifacts: { development: { reportPath: developmentReportPath } },
    }),
    { eligible: false, reasons: ["missing_active_suite:holdout"], warnings: [] },
  );
  assert.deepEqual(
    evaluateBaselinePromotion({
      ...common,
      holdoutTransition: { status: "invalid", reasons: ["holdout_version_not_changed"] },
    }),
    { eligible: false, reasons: ["holdout_version_not_changed"], warnings: [] },
  );
  assert.deepEqual(
    evaluateBaselinePromotion({ ...common, endState: { head: "def456", clean: false } }),
    { eligible: false, reasons: ["dirty_worktree_end", "git_head_changed"], warnings: [] },
  );

  const tracePath = path.join(root, "development/traces/case-1.json");
  const trace = JSON.parse(await readFile(tracePath, "utf8"));
  trace.case.id = "different-case";
  await writeFile(tracePath, JSON.stringify(trace));
  assert.deepEqual(
    evaluateBaselinePromotion(common),
    { eligible: false, reasons: ["openai_transport_invalid:development"], warnings: [] },
  );

  trace.case.id = "case-1";
  trace.status = "partial";
  await writeFile(tracePath, JSON.stringify(trace));
  assert.deepEqual(
    evaluateBaselinePromotion(common),
    {
      eligible: false,
      reasons: ["openai_transport_invalid:development", "trace_not_success:development:case-1"],
      warnings: [],
    },
  );

  trace.status = "success";
  await writeFile(tracePath, JSON.stringify(trace));
  const report = JSON.parse(await readFile(developmentReportPath, "utf8"));
  report.results[0].evaluation_status = "not_scored";
  await writeFile(developmentReportPath, JSON.stringify(report));
  assert.deepEqual(
    evaluateBaselinePromotion(common),
    { eligible: false, reasons: ["case_not_scored:development:case-1"], warnings: [] },
  );

  report.results[0].evaluation_status = "scored";
  delete report.results[0].runtime_status;
  await writeFile(developmentReportPath, JSON.stringify(report));
  assert.deepEqual(
    evaluateBaselinePromotion(common),
    {
      eligible: false,
      reasons: ["openai_transport_invalid:development", "runtime_not_success:development:case-1"],
      warnings: [],
    },
  );

  report.results[0].runtime_status = "success";
  const recoveredStats = transportStats({ requestCount: 1, retryCount: 1, category: "http_429" });
  report.results[0].openai_transport = {
    query_generation: recoveredStats,
    relation_judge: transportStats(),
    total: recoveredStats,
  };
  report.diagnostics = {
    openai_transport: {
      query_generation: recoveredStats,
      relation_judge: transportStats(),
      total: recoveredStats,
    },
  };
  trace.steps.query_generation = { ...recoveredStats };
  trace.steps.relation_judge = { ...transportStats() };
  await writeFile(tracePath, JSON.stringify(trace));
  await writeFile(developmentReportPath, JSON.stringify(report));
  assert.deepEqual(evaluateBaselinePromotion(common), {
    eligible: true,
    reasons: [],
    warnings: ["recovered_openai_retries:development:1"],
  });

  report.results[0].runtime_status = "failed";
  const failedStats = transportStats({ requestCount: 1, retryCount: 2, category: "http_5xx" });
  report.results[0].openai_transport = {
    query_generation: failedStats,
    relation_judge: transportStats(),
    total: failedStats,
  };
  report.diagnostics.openai_transport = report.results[0].openai_transport;
  trace.status = "failed";
  trace.steps.query_generation = { ...failedStats };
  trace.steps.relation_judge = { ...transportStats() };
  await writeFile(tracePath, JSON.stringify(trace));
  await writeFile(developmentReportPath, JSON.stringify(report));
  assert.deepEqual(evaluateBaselinePromotion(common), {
    eligible: false,
    reasons: [
      "runtime_not_success:development:case-1",
      "trace_not_success:development:case-1",
    ],
    warnings: [],
  });
  await rm(root, { recursive: true, force: true });
});

test("baseline promotion compares retry category counts independent of key order", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "aha-workflow-retry-order-"));
  const casesPath = path.join(root, "cases.json");
  await writeFile(casesPath, "{}\n");
  const developmentReportPath = await writeSuiteArtifact(root, "development", ["case-1"]);
  const holdoutReportPath = await writeSuiteArtifact(root, "holdout", ["case-2"]);
  const tracePath = path.join(root, "development/traces/case-1.json");
  const report = JSON.parse(await readFile(developmentReportPath, "utf8"));
  const trace = JSON.parse(await readFile(tracePath, "utf8"));
  const query = transportStats({ requestCount: 1, retryCount: 1, category: "transport" });
  const relation = transportStats({ requestCount: 1, retryCount: 1, category: "timeout" });
  const total = mergeTransportStats([query, relation]);

  report.results[0].openai_transport = { query_generation: query, relation_judge: relation, total };
  report.diagnostics.openai_transport = { query_generation: query, relation_judge: relation, total };
  trace.steps.query_generation = { ...query };
  trace.steps.relation_judge = { ...relation };
  await writeFile(developmentReportPath, JSON.stringify(report));
  await writeFile(tracePath, JSON.stringify(trace));

  const hash = await sha256File(casesPath);
  assert.deepEqual(evaluateBaselinePromotion({
    workflow: "baseline",
    profile: "product-parity",
    startState: { head: "abc123", clean: true },
    endState: { head: "abc123", clean: true },
    casesHashStart: hash,
    casesHashEnd: hash,
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
  }), {
    eligible: true,
    reasons: [],
    warnings: ["recovered_openai_retries:development:2"],
  });
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
  const retryStats = transportStats({ requestCount: 1, retryCount: 1, category: "http_429" });
  const reportPath = await writeSuiteArtifact(runDir, "development", ["case-1"], {
    transportById: { "case-1": retryStats },
  });
  const tracePath = path.join(runDir, "development/traces/case-1.json");
  const manifestDocument = buildWorkflowProvenance({
    workflow: "baseline",
    runId: "run-1",
    profile: "product-parity",
    startedAt: "2026-07-10T00:00:00.000Z",
    finishedAt: "2026-07-10T00:01:00.000Z",
    startState: { head: "abc123", clean: true },
    endState: { head: "abc123", clean: true },
    artifacts: {
      development: {
        report: "development/report.json",
        reportSha256: await sha256File(reportPath),
        traces: {
          "development/traces/case-1.json": await sha256File(tracePath),
        },
        effectiveConfigId: "config-development",
        openAiTransport: retryStats,
      },
    },
    promotion: {
      eligible: true,
      reasons: [],
      warnings: ["recovered_openai_retries:development:1"],
    },
  });
  await writeJsonAtomic(manifestPath, manifestDocument);

  await promoteLatestPointer({
    pointerPath,
    manifestPath,
    gitCommit: "abc123",
    suiteVersions: { development: "dev-v1" },
    promotedAt: "2026-07-10T00:02:00.000Z",
  });

  const resolved = await resolveLatestPointer(pointerPath);
  assert.equal(resolved.manifest.run_id, "run-1");
  assert.deepEqual(resolved.manifest.openai_transport.total, retryStats);
  assert.equal(resolved.reportPaths.development, path.join(runDir, "development/report.json"));
  assert.deepEqual((await readdir(path.dirname(pointerPath))).sort(), ["product-parity.json"]);

  const pointerBeforeMismatch = await readFile(pointerPath, "utf8");
  const originalReport = await readFile(reportPath, "utf8");
  const originalTrace = await readFile(tracePath, "utf8");
  const zeroStats = transportStats();

  const failedReport = JSON.parse(originalReport);
  failedReport.results[0].runtime_status = "failed";
  const failedTrace = JSON.parse(originalTrace);
  failedTrace.status = "failed";
  await writeFile(reportPath, JSON.stringify(failedReport));
  await writeFile(tracePath, JSON.stringify(failedTrace));
  const forgedEligibleManifest = {
    ...manifestDocument,
    artifacts: {
      development: {
        ...manifestDocument.artifacts.development,
        report_sha256: await sha256File(reportPath),
        traces: {
          "development/traces/case-1.json": await sha256File(tracePath),
        },
      },
    },
    promotion: { ...manifestDocument.promotion, warnings: [] },
  };
  await writeJsonAtomic(manifestPath, forgedEligibleManifest);
  await assert.rejects(
    () => promoteLatestPointer({
      pointerPath,
      manifestPath,
      gitCommit: "abc123",
      suiteVersions: { development: "dev-v1" },
      promotedAt: "2026-07-10T00:02:10.000Z",
    }),
    /eligible evidence requires successful trace and runtime status/i,
  );
  const pointerWithFailedEvidence = JSON.parse(pointerBeforeMismatch);
  pointerWithFailedEvidence.manifest_sha256 = await sha256File(manifestPath);
  await writeJsonAtomic(pointerPath, pointerWithFailedEvidence);
  await assert.rejects(
    () => resolveLatestPointer(pointerPath),
    /eligible evidence requires successful trace and runtime status/i,
  );
  await writeFile(pointerPath, pointerBeforeMismatch);
  await writeFile(reportPath, originalReport);
  await writeFile(tracePath, originalTrace);
  await writeJsonAtomic(manifestPath, manifestDocument);

  await writeJsonAtomic(manifestPath, {
    ...manifestDocument,
    promotion: { ...manifestDocument.promotion, warnings: [] },
  });
  await assert.rejects(
    () => promoteLatestPointer({
      pointerPath,
      manifestPath,
      gitCommit: "abc123",
      suiteVersions: { development: "dev-v1" },
      promotedAt: "2026-07-10T00:02:15.000Z",
    }),
    /promotion warnings do not match recovered OpenAI retries/i,
  );
  const pointerWithoutWarning = JSON.parse(pointerBeforeMismatch);
  pointerWithoutWarning.manifest_sha256 = await sha256File(manifestPath);
  await writeJsonAtomic(pointerPath, pointerWithoutWarning);
  await assert.rejects(
    () => resolveLatestPointer(pointerPath),
    /promotion warnings do not match recovered OpenAI retries/i,
  );
  await writeFile(pointerPath, pointerBeforeMismatch);

  await writeJsonAtomic(manifestPath, {
    ...manifestDocument,
    promotion: {
      ...manifestDocument.promotion,
      warnings: ["recovered_openai_retries:development:2"],
    },
  });
  await assert.rejects(
    () => promoteLatestPointer({
      pointerPath,
      manifestPath,
      gitCommit: "abc123",
      suiteVersions: { development: "dev-v1" },
      promotedAt: "2026-07-10T00:02:17.000Z",
    }),
    /promotion warnings do not match recovered OpenAI retries/i,
  );
  await writeJsonAtomic(manifestPath, manifestDocument);

  const mismatchedIdentityTrace = JSON.parse(originalTrace);
  mismatchedIdentityTrace.case.id = "different-case";
  await writeFile(tracePath, JSON.stringify(mismatchedIdentityTrace));
  const identityMismatchManifest = {
    ...manifestDocument,
    artifacts: {
      development: {
        ...manifestDocument.artifacts.development,
        traces: {
          "development/traces/case-1.json": await sha256File(tracePath),
        },
      },
    },
  };
  await writeJsonAtomic(manifestPath, identityMismatchManifest);
  await assert.rejects(
    () => promoteLatestPointer({
      pointerPath,
      manifestPath,
      gitCommit: "abc123",
      suiteVersions: { development: "dev-v1" },
      promotedAt: "2026-07-10T00:02:18.000Z",
    }),
    /trace case id does not match its report result/i,
  );
  const pointerWithIdentityMismatch = JSON.parse(pointerBeforeMismatch);
  pointerWithIdentityMismatch.manifest_sha256 = await sha256File(manifestPath);
  await writeJsonAtomic(pointerPath, pointerWithIdentityMismatch);
  await assert.rejects(
    () => resolveLatestPointer(pointerPath),
    /trace case id does not match its report result/i,
  );
  await writeFile(pointerPath, pointerBeforeMismatch);
  await writeFile(tracePath, originalTrace);

  const mismatchedStatusTrace = JSON.parse(originalTrace);
  mismatchedStatusTrace.status = "failed";
  await writeFile(tracePath, JSON.stringify(mismatchedStatusTrace));
  await writeJsonAtomic(manifestPath, {
    ...manifestDocument,
    artifacts: {
      development: {
        ...manifestDocument.artifacts.development,
        traces: {
          "development/traces/case-1.json": await sha256File(tracePath),
        },
      },
    },
  });
  await assert.rejects(
    () => promoteLatestPointer({
      pointerPath,
      manifestPath,
      gitCommit: "abc123",
      suiteVersions: { development: "dev-v1" },
      promotedAt: "2026-07-10T00:02:19.000Z",
    }),
    /trace status does not match its report result/i,
  );
  const pointerWithStatusMismatch = JSON.parse(pointerBeforeMismatch);
  pointerWithStatusMismatch.manifest_sha256 = await sha256File(manifestPath);
  await writeJsonAtomic(pointerPath, pointerWithStatusMismatch);
  await assert.rejects(
    () => resolveLatestPointer(pointerPath),
    /trace status does not match its report result/i,
  );
  await writeFile(pointerPath, pointerBeforeMismatch);
  await writeFile(tracePath, originalTrace);
  await writeJsonAtomic(manifestPath, manifestDocument);

  const mismatchedTrace = JSON.parse(originalTrace);
  mismatchedTrace.steps.query_generation = { ...zeroStats };
  await writeFile(tracePath, JSON.stringify(mismatchedTrace));
  const traceMismatchManifest = {
    ...manifestDocument,
    artifacts: {
      development: {
        ...manifestDocument.artifacts.development,
        traces: {
          "development/traces/case-1.json": await sha256File(tracePath),
        },
      },
    },
  };
  await writeJsonAtomic(manifestPath, traceMismatchManifest);
  await assert.rejects(
    () => promoteLatestPointer({
      pointerPath,
      manifestPath,
      gitCommit: "abc123",
      suiteVersions: { development: "dev-v1" },
      promotedAt: "2026-07-10T00:02:20.000Z",
    }),
    /report result case-1 OpenAI transport query_generation does not match its trace/i,
  );
  const pointerWithTraceMismatch = JSON.parse(pointerBeforeMismatch);
  pointerWithTraceMismatch.manifest_sha256 = await sha256File(manifestPath);
  await writeJsonAtomic(pointerPath, pointerWithTraceMismatch);
  await assert.rejects(
    () => resolveLatestPointer(pointerPath),
    /report result case-1 OpenAI transport query_generation does not match its trace/i,
  );
  await writeFile(pointerPath, pointerBeforeMismatch);
  await writeFile(tracePath, originalTrace);
  await writeJsonAtomic(manifestPath, manifestDocument);

  const reportWithMismatchedAggregate = JSON.parse(originalReport);
  reportWithMismatchedAggregate.diagnostics.openai_transport = {
    query_generation: zeroStats,
    relation_judge: zeroStats,
    total: zeroStats,
  };
  await writeFile(reportPath, JSON.stringify(reportWithMismatchedAggregate));
  await writeJsonAtomic(manifestPath, {
    ...manifestDocument,
    artifacts: {
      development: {
        ...manifestDocument.artifacts.development,
        report_sha256: await sha256File(reportPath),
      },
    },
  });
  await assert.rejects(
    () => promoteLatestPointer({
      pointerPath,
      manifestPath,
      gitCommit: "abc123",
      suiteVersions: { development: "dev-v1" },
      promotedAt: "2026-07-10T00:02:30.000Z",
    }),
    /report OpenAI transport .* does not match merged results/i,
  );
  assert.equal(await readFile(pointerPath, "utf8"), pointerBeforeMismatch);
  await writeFile(reportPath, originalReport);

  await writeJsonAtomic(manifestPath, {
    ...manifestDocument,
    artifacts: {
      development: { ...manifestDocument.artifacts.development, openai_transport: zeroStats },
    },
    openai_transport: { by_suite: { development: zeroStats }, total: zeroStats },
  });
  await assert.rejects(
    () => promoteLatestPointer({
      pointerPath,
      manifestPath,
      gitCommit: "abc123",
      suiteVersions: { development: "dev-v1" },
      promotedAt: "2026-07-10T00:03:00.000Z",
    }),
    /artifact OpenAI transport does not match its report/i,
  );
  assert.equal(await readFile(pointerPath, "utf8"), pointerBeforeMismatch);
  const pointerForMismatchedManifest = JSON.parse(pointerBeforeMismatch);
  pointerForMismatchedManifest.manifest_sha256 = await sha256File(manifestPath);
  await writeJsonAtomic(pointerPath, pointerForMismatchedManifest);
  await assert.rejects(
    () => resolveLatestPointer(pointerPath),
    /artifact OpenAI transport does not match its report/i,
  );
  await writeFile(pointerPath, pointerBeforeMismatch);

  await writeJsonAtomic(manifestPath, {
    ...manifestDocument,
    openai_transport: { by_suite: { development: zeroStats }, total: zeroStats },
  });
  await assert.rejects(
    () => promoteLatestPointer({
      pointerPath,
      manifestPath,
      gitCommit: "abc123",
      suiteVersions: { development: "dev-v1" },
      promotedAt: "2026-07-10T00:04:00.000Z",
    }),
    /top-level OpenAI transport does not match suite artifacts/i,
  );
  assert.equal(await readFile(pointerPath, "utf8"), pointerBeforeMismatch);
  await writeJsonAtomic(manifestPath, manifestDocument);

  await writeFile(reportPath, "{}\n");
  await assert.rejects(() => resolveLatestPointer(pointerPath), /report hash mismatch/i);
  await writeFile(reportPath, originalReport);

  await writeFile(tracePath, "{}\n");
  await assert.rejects(() => resolveLatestPointer(pointerPath), /trace hash mismatch/i);
  await writeFile(tracePath, originalTrace);

  await writeFile(manifestPath, "{}\n");
  await assert.rejects(() => resolveLatestPointer(pointerPath), /manifest hash mismatch/i);
  await rm(root, { recursive: true, force: true });
});

test("promotion rejects manifest, report, and trace symlink escapes before hashing", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "aha-workflow-symlink-root-"));
  const externalRoot = await mkdtemp(path.join(tmpdir(), "aha-workflow-symlink-external-"));
  const runDir = path.join(root, "runs/run-symlink");
  const manifestPath = path.join(runDir, "manifest.json");
  const pointerPath = path.join(root, "latest/product-parity.json");
  const reportPath = await writeSuiteArtifact(runDir, "development", ["case-1"]);
  const tracePath = path.join(runDir, "development/traces/case-1.json");
  const reportBytes = await readFile(reportPath);
  const traceBytes = await readFile(tracePath);
  const externalReportPath = path.join(externalRoot, "report.json");
  const externalTracePath = path.join(externalRoot, "trace.json");
  const externalManifestPath = path.join(externalRoot, "manifest.json");
  await writeFile(externalReportPath, reportBytes);
  await writeFile(externalTracePath, traceBytes);

  const manifestDocument = buildWorkflowProvenance({
    workflow: "baseline",
    runId: "run-symlink",
    profile: "product-parity",
    artifacts: {
      development: {
        report: "development/report.json",
        reportSha256: await sha256File(reportPath),
        traces: {
          "development/traces/case-1.json": await sha256File(tracePath),
        },
        openAiTransport: transportStats(),
      },
    },
    promotion: { eligible: true, reasons: [], warnings: [] },
  });
  const promote = () => promoteLatestPointer({
    pointerPath,
    manifestPath,
    gitCommit: "abc123",
    suiteVersions: { development: "dev-v1" },
    promotedAt: "2026-07-10T00:08:00.000Z",
  });

  try {
    await rm(reportPath);
    await symlink(externalReportPath, reportPath);
    await writeJsonAtomic(manifestPath, manifestDocument);
    await assert.rejects(promote, /development report.*symlink|development report.*physically escapes/i);

    await rm(reportPath);
    await writeFile(reportPath, reportBytes);
    await rm(tracePath);
    await symlink(externalTracePath, tracePath);
    await writeJsonAtomic(manifestPath, manifestDocument);
    await assert.rejects(promote, /development trace.*symlink|development trace.*physically escapes/i);

    await rm(tracePath);
    await writeFile(tracePath, traceBytes);
    await writeJsonAtomic(externalManifestPath, manifestDocument);
    await rm(manifestPath);
    await symlink(externalManifestPath, manifestPath);
    await assert.rejects(promote, /manifest.*symlink|manifest.*physically escapes/i);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(externalRoot, { recursive: true, force: true });
  }
});

test("latest pointer only accepts legacy-missing transport telemetry for non-OpenAI evidence", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "aha-workflow-legacy-transport-"));
  const runDir = path.join(root, "runs/run-legacy");
  const manifestPath = path.join(runDir, "manifest.json");
  const pointerPath = path.join(root, "latest/product-parity.json");
  const reportPath = await writeSuiteArtifact(runDir, "development", ["legacy-case"]);
  const tracePath = path.join(runDir, "development/traces/legacy-case.json");
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  const trace = JSON.parse(await readFile(tracePath, "utf8"));
  delete report.results[0].openai_transport;
  delete report.diagnostics.openai_transport;
  delete trace.steps.query_generation.request_count;
  delete trace.steps.query_generation.attempt_count;
  delete trace.steps.query_generation.retry_count;
  delete trace.steps.query_generation.retry_categories;
  delete trace.steps.relation_judge.request_count;
  delete trace.steps.relation_judge.attempt_count;
  delete trace.steps.relation_judge.retry_count;
  delete trace.steps.relation_judge.retry_categories;
  await writeFile(reportPath, JSON.stringify(report));
  await writeFile(tracePath, JSON.stringify(trace));

  const legacyManifest = buildWorkflowProvenance({
    workflow: "baseline",
    runId: "run-legacy",
    profile: "product-parity",
    artifacts: {
      development: {
        report: "development/report.json",
        reportSha256: await sha256File(reportPath),
        traces: {
          "development/traces/legacy-case.json": await sha256File(tracePath),
        },
        openAiTransport: transportStats(),
      },
    },
    promotion: { eligible: true, reasons: [], warnings: [] },
  });
  await writeJsonAtomic(manifestPath, legacyManifest);
  await promoteLatestPointer({
    pointerPath,
    manifestPath,
    gitCommit: "abc123",
    suiteVersions: { development: "dev-v1" },
    promotedAt: "2026-07-10T00:05:00.000Z",
  });

  report.metadata.llm_provider = "openai";
  await writeFile(reportPath, JSON.stringify(report));
  await writeJsonAtomic(manifestPath, {
    ...legacyManifest,
    artifacts: {
      development: {
        ...legacyManifest.artifacts.development,
        report_sha256: await sha256File(reportPath),
      },
    },
  });
  await assert.rejects(
    () => promoteLatestPointer({
      pointerPath,
      manifestPath,
      gitCommit: "abc123",
      suiteVersions: { development: "dev-v1" },
      promotedAt: "2026-07-10T00:06:00.000Z",
    }),
    /OpenAI transport telemetry is missing for retry-capable evidence/i,
  );
  await rm(root, { recursive: true, force: true });
});

test("latest pointer rejects legacy-missing telemetry mixed with instrumented evidence", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "aha-workflow-mixed-transport-"));
  const runDir = path.join(root, "runs/run-mixed");
  const manifestPath = path.join(runDir, "manifest.json");
  const pointerPath = path.join(root, "latest/product-parity.json");
  const reportPath = await writeSuiteArtifact(runDir, "development", ["legacy-case", "instrumented-case"]);
  const legacyTracePath = path.join(runDir, "development/traces/legacy-case.json");
  const instrumentedTracePath = path.join(runDir, "development/traces/instrumented-case.json");
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  const legacyTrace = JSON.parse(await readFile(legacyTracePath, "utf8"));
  delete report.results[0].openai_transport;
  for (const stage of ["query_generation", "relation_judge"]) {
    delete legacyTrace.steps[stage].request_count;
    delete legacyTrace.steps[stage].attempt_count;
    delete legacyTrace.steps[stage].retry_count;
    delete legacyTrace.steps[stage].retry_categories;
  }
  await writeFile(reportPath, JSON.stringify(report));
  await writeFile(legacyTracePath, JSON.stringify(legacyTrace));
  const manifest = buildWorkflowProvenance({
    workflow: "baseline",
    runId: "run-mixed",
    profile: "product-parity",
    artifacts: {
      development: {
        report: "development/report.json",
        reportSha256: await sha256File(reportPath),
        traces: {
          "development/traces/legacy-case.json": await sha256File(legacyTracePath),
          "development/traces/instrumented-case.json": await sha256File(instrumentedTracePath),
        },
        openAiTransport: transportStats(),
      },
    },
    promotion: { eligible: true, reasons: [], warnings: [] },
  });
  await writeJsonAtomic(manifestPath, manifest);
  await assert.rejects(
    () => promoteLatestPointer({
      pointerPath,
      manifestPath,
      gitCommit: "abc123",
      suiteVersions: { development: "dev-v1" },
      promotedAt: "2026-07-10T00:07:00.000Z",
    }),
    /OpenAI transport telemetry is missing for retry-capable evidence/i,
  );
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
  assert.equal(repeated.stdout, "");
  assert.equal(repeated.stderr, "Evaluation workflow setup failed: workflow_run_exists.\n");
  assert.ok(!`${repeated.stdout}\n${repeated.stderr}`.includes(root));
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

test("validate manifest preserves safe identity conflict diagnostics without private evidence", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "aha-workflow-identity-conflict-"));
  const vaultRoot = path.join(root, "Private Vault");
  const reportsRoot = path.join(root, "reports");
  const casesPath = path.join(root, "cases.json");
  const privateNoteText = "PRIVATE_NOTE_TEXT_MUST_NOT_LEAK";
  await mkdir(path.join(vaultRoot, "Folder A"), { recursive: true });
  await mkdir(path.join(vaultRoot, "Folder B"), { recursive: true });
  await writeFile(path.join(vaultRoot, "Folder A", "Same.md"), privateNoteText);
  await writeFile(path.join(vaultRoot, "Folder B", "Same.md"), privateNoteText);
  await writeFile(casesPath, JSON.stringify({
    version: 3,
    collection: "obsidian",
    suites: { development: { version: "dev-private-v1" } },
    cases: [{
      id: "identity-conflict-case",
      state: "active",
      suite: "development",
      evaluation_mode: "discovery",
      provenance: { origin: "reviewed", reason: "Ambiguous identity regression case." },
      input: { thought: "Private standalone thought." },
      gold: { must: ["Same.md"], nice: [], noise: [] },
    }],
  }));

  const result = spawnSync(process.execPath, [
    "scripts/bench/run-eval-workflow.mjs",
    "validate",
    "--private",
    "--cases", casesPath,
    "--vault-root", vaultRoot,
    "--reports-root", reportsRoot,
    "--run-id", "validate-identity-conflict",
  ], { cwd: repoRoot, encoding: "utf8" });

  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.match(result.stderr, /identity_conflicts/i);
  const manifest = JSON.parse(await readFile(
    path.join(reportsRoot, "runs/validate-identity-conflict/manifest.json"),
    "utf8",
  ));
  assert.equal(manifest.status, "failed");
  assert.equal(manifest.validation.reason, "identity_conflicts");
  const encoded = JSON.stringify(manifest);
  assert.ok(!encoded.includes(root));
  assert.ok(!encoded.includes(privateNoteText));
  assert.ok(!encoded.includes("Folder A"));
  assert.ok(!encoded.includes("Folder B"));
  await rm(root, { recursive: true, force: true });
});

test("reserved workflow runs record privacy-bounded failed manifests on preflight exceptions", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "aha-workflow-preflight-failure-"));
  const reportsRoot = path.join(root, "reports");
  const invalidCasesPath = path.join(root, "invalid-cases.json");
  const placeholderCasesPath = path.join(root, "placeholder-cases.json");
  const invalidPluginDataPath = path.join(root, "private-plugin-data.json");
  const smokeHookPath = path.join(root, "fail-smoke-spawn.cjs");
  const privateCaseText = "PRIVATE_CASE_BODY_MUST_NOT_LEAK";
  const privatePluginSecret = "PRIVATE_PLUGIN_SECRET_MUST_NOT_LEAK";
  const privateSmokeError = "PRIVATE_SMOKE_ERROR_MUST_NOT_LEAK";

  await writeFile(invalidCasesPath, `{\"privacy\":\"${privateCaseText}\"`);
  await writeFile(placeholderCasesPath, JSON.stringify({ privacy: privateCaseText }));
  await writeFile(
    invalidPluginDataPath,
    `{\"settings\":{\"llmApiKey\":\"${privatePluginSecret}\"`,
  );
  await writeFile(smokeHookPath, [
    'const childProcess = require("node:child_process");',
    'const { syncBuiltinESMExports } = require("node:module");',
    "const originalSpawnSync = childProcess.spawnSync;",
    "childProcess.spawnSync = function (command, args, options) {",
    `  if (command === process.execPath && args?.[0] === "--test") throw new Error("${privateSmokeError}");`,
    "  return originalSpawnSync(command, args, options);",
    "};",
    "syncBuiltinESMExports();",
    "",
  ].join("\n"));

  const scenarios = [
    {
      command: "validate",
      args: ["--cases", invalidCasesPath],
      expectedFailure: { validation: { status: "failed", reason: "validation_failed" } },
    },
    {
      command: "smoke",
      env: { NODE_OPTIONS: `--require=${smokeHookPath}` },
      expectedFailure: { failure: { phase: "preflight", reason: "workflow_preflight_failed" } },
    },
    {
      command: "baseline",
      args: ["--cases", placeholderCasesPath, "--plugin-data", invalidPluginDataPath],
      expectedFailure: { failure: { phase: "preflight", reason: "workflow_preflight_failed" } },
    },
    {
      command: "diagnostic",
      args: ["--cases", placeholderCasesPath, "--plugin-data", invalidPluginDataPath],
      expectedFailure: { failure: { phase: "preflight", reason: "workflow_preflight_failed" } },
    },
  ];

  for (const scenario of scenarios) {
    const runId = `preflight-${scenario.command}`;
    const result = spawnSync(process.execPath, [
      "scripts/bench/run-eval-workflow.mjs",
      scenario.command,
      "--reports-root", reportsRoot,
      "--run-id", runId,
      ...(scenario.args ?? []),
    ], {
      cwd: repoRoot,
      encoding: "utf8",
      env: { ...process.env, ...(scenario.env ?? {}) },
    });

    assert.notEqual(result.status, 0, `${scenario.command} unexpectedly succeeded`);
    const output = `${result.stdout}\n${result.stderr}`;
    assert.ok(!output.includes(root), `${scenario.command} leaked its private root: ${output}`);
    assert.ok(!output.includes(privateCaseText), `${scenario.command} leaked case text`);
    assert.ok(!output.includes(privatePluginSecret), `${scenario.command} leaked plugin secret`);
    assert.ok(!output.includes(privateSmokeError), `${scenario.command} leaked smoke marker`);
    if (scenario.expectedFailure.failure) {
      assert.equal(result.stdout, "");
      assert.equal(result.stderr, "Evaluation workflow failed: workflow_preflight_failed.\n");
    } else {
      assert.equal(result.stdout, "");
      assert.equal(result.stderr, "Validation failed: validation_failed.\n");
    }
    const manifestPath = path.join(reportsRoot, "runs", runId, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    assert.equal(manifest.status, "failed");
    if (scenario.expectedFailure.failure) {
      assert.deepEqual(manifest.failure, scenario.expectedFailure.failure);
      assert.deepEqual(manifest.promotion, {
        eligible: false,
        reasons: ["workflow_preflight_failed"],
        warnings: [],
      });
    } else {
      assert.equal(manifest.validation.status, scenario.expectedFailure.validation.status);
      assert.equal(manifest.validation.reason, scenario.expectedFailure.validation.reason);
    }
    const encoded = JSON.stringify(manifest);
    assert.ok(!encoded.includes(root));
    assert.ok(!encoded.includes(privateCaseText));
    assert.ok(!encoded.includes(privatePluginSecret));
    assert.ok(!encoded.includes(privateSmokeError));
  }

  const failedBaselineManifestPath = path.join(
    reportsRoot,
    "runs/preflight-baseline/manifest.json",
  );
  const failedBaselineManifest = await readFile(failedBaselineManifestPath, "utf8");
  const repeatedBaseline = spawnSync(process.execPath, [
    "scripts/bench/run-eval-workflow.mjs",
    "baseline",
    "--reports-root", reportsRoot,
    "--run-id", "preflight-baseline",
    "--cases", placeholderCasesPath,
    "--plugin-data", invalidPluginDataPath,
  ], { cwd: repoRoot, encoding: "utf8" });
  assert.notEqual(repeatedBaseline.status, 0);
  assert.equal(repeatedBaseline.stdout, "");
  assert.equal(repeatedBaseline.stderr, "Evaluation workflow setup failed: workflow_run_exists.\n");
  assert.ok(!`${repeatedBaseline.stdout}\n${repeatedBaseline.stderr}`.includes(root));
  assert.equal(await readFile(failedBaselineManifestPath, "utf8"), failedBaselineManifest);

  const badOption = spawnSync(process.execPath, [
    "scripts/bench/run-eval-workflow.mjs",
    "validate",
    `--private-${privatePluginSecret}`,
  ], { cwd: repoRoot, encoding: "utf8" });
  assert.equal(badOption.status, 1);
  assert.equal(badOption.stdout, "");
  assert.equal(badOption.stderr, "Evaluation workflow setup failed: workflow_setup_failed.\n");
  assert.ok(!`${badOption.stdout}\n${badOption.stderr}`.includes(privatePluginSecret));

  await rm(root, { recursive: true, force: true });
});

test("execution exceptions retain recorded provenance and emit only a safe failure code", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "aha-workflow-execution-failure-"));
  const vaultRoot = path.join(root, "Private Vault");
  const reportsRoot = path.join(root, "reports");
  const casesPath = path.join(root, "private-cases.json");
  const pluginDataPath = path.join(root, "private-plugin-data.json");
  const runnerPath = path.join(root, "private-runner.mjs");
  const markerPath = path.join(repoRoot, `.aha-private-execution-marker-${randomUUID()}`);
  const privateText = "PRIVATE_EXECUTION_TEXT_MUST_NOT_LEAK";
  const privateSecret = "PRIVATE_EXECUTION_SECRET_MUST_NOT_LEAK";
  const retryStats = {
    request_count: 1,
    attempt_count: 2,
    retry_count: 1,
    retry_categories: { timeout: 1 },
  };
  const recordedArtifact = {
    report: "development/already-recorded-report.json",
    report_sha256: "a".repeat(64),
    traces: { "development/traces/already-recorded.json": "b".repeat(64) },
    effective_config_id: "c".repeat(64),
    openai_transport: retryStats,
  };

  await assert.rejects(readFile(markerPath), { code: "ENOENT" });

  await mkdir(path.join(vaultRoot, "Notes"), { recursive: true });
  await writeFile(path.join(vaultRoot, "Notes/Dev.md"), privateText);
  await writeFile(path.join(vaultRoot, "Notes/Holdout.md"), privateText);
  await writeFile(casesPath, JSON.stringify({
    version: 3,
    collection: "obsidian",
    suites: {
      development: { version: "dev-execution-v1" },
      holdout: { version: "holdout-execution-v1", frozen: true, change_reason: "Initial frozen split." },
    },
    cases: [
      {
        id: "execution-development",
        state: "active",
        suite: "development",
        evaluation_mode: "discovery",
        provenance: { origin: "reviewed", reason: "Execution failure regression." },
        input: { thought: "Private development thought." },
        gold: { must: ["Notes/Dev.md"], nice: [], noise: [] },
      },
      {
        id: "execution-holdout",
        state: "active",
        suite: "holdout",
        evaluation_mode: "discovery",
        provenance: { origin: "reviewed", reason: "Execution failure regression." },
        input: { thought: "Private holdout thought." },
        gold: { must: ["Notes/Holdout.md"], nice: [], noise: [] },
      },
    ],
  }));
  await writeFile(pluginDataPath, JSON.stringify({ settings: {
    ahaWorkspace: repoRoot,
    llmProvider: "openai",
    llmBaseUrl: "https://example.invalid/v1",
    llmModel: "private-model-name",
    llmApiKey: privateSecret,
    llmApiKeyEnv: "AHA_EXECUTION_TEST_KEY",
    codexCommand: "/opt/private/codex",
    codexModel: "private-codex-model",
    codexReasoningEffort: "high",
    codexSandbox: "read-only",
    qmdRunner: "cli",
    qmdCommand: "/opt/private/qmd",
    qmdIndex: "private-index",
    qmdRerank: false,
    obsidianCommand: "/opt/private/obsidian",
    wrapperRelativePath: "scripts/aha/run-insight-search.mjs",
    targetCandidates: 17,
    useFixtureResult: false,
  } }));
  await writeFile(runnerPath, [
    'import { readFileSync, writeFileSync } from "node:fs";',
    'import path from "node:path";',
    "const args = process.argv.slice(2);",
    'const reportPath = args[args.indexOf("--report") + 1];',
    "const runDir = path.dirname(path.dirname(reportPath));",
    'const manifestPath = path.join(runDir, "manifest.json");',
    'const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));',
    `manifest.artifacts = { development: ${JSON.stringify(recordedArtifact)} };`,
    `manifest.openai_transport = { by_suite: { development: ${JSON.stringify(retryStats)} }, total: ${JSON.stringify(retryStats)} };`,
    "manifest.private_extra = process.env.AHA_EXECUTION_TEST_KEY;",
    "manifest.cases.private_path = reportPath;",
    "manifest.runtime_configuration.private_secret = process.env.AHA_EXECUTION_TEST_KEY;",
    `manifest.artifacts.development.private_text = "${privateText}";`,
    `manifest.openai_transport.private_marker = "${privateText}";`,
    "if (process.env.AHA_UNSAFE_RUNNING_MANIFEST === \"1\") manifest.artifacts.development.report = reportPath;",
    `writeFileSync(manifestPath, process.env.AHA_CORRUPT_RUNNING_MANIFEST === "1" ? '{"private":"${privateText}"' : \`${"${JSON.stringify(manifest, null, 2)}"}\\n\`);`,
    `writeFileSync(process.env.AHA_EXECUTION_MARKER_PATH, "${privateText}");`,
    `writeFileSync(reportPath, '{"private":"${privateText}"');`,
    "",
  ].join("\n"));

  try {
    const result = spawnSync(process.execPath, [
      "scripts/bench/run-eval-workflow.mjs",
      "baseline",
      "--cases", casesPath,
      "--vault-root", vaultRoot,
      "--plugin-data", pluginDataPath,
      "--runner", runnerPath,
      "--reports-root", reportsRoot,
      "--run-id", "execution-failure",
    ], {
      cwd: repoRoot,
      encoding: "utf8",
      env: { ...process.env, AHA_EXECUTION_MARKER_PATH: markerPath },
    });

    assert.equal(result.status, 1, result.stderr || result.stdout);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "Evaluation workflow failed: workflow_execution_failed.\n");
    const output = `${result.stdout}\n${result.stderr}`;
    assert.ok(!output.includes(root));
    assert.ok(!output.includes(markerPath));
    assert.ok(!output.includes(privateText));
    assert.ok(!output.includes(privateSecret));

    const manifest = JSON.parse(await readFile(
      path.join(reportsRoot, "runs/execution-failure/manifest.json"),
      "utf8",
    ));
    const currentHead = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).stdout.trim();
    const currentClean = spawnSync("git", ["status", "--porcelain"], { cwd: repoRoot, encoding: "utf8" }).stdout.trim() === "";
    assert.equal(manifest.status, "failed");
    assert.match(manifest.finished_at, /^\d{4}-\d{2}-\d{2}T/);
    assert.deepEqual(manifest.failure, { phase: "execution", reason: "workflow_execution_failed" });
    assert.equal(manifest.git.commit_end, currentHead);
    assert.equal(manifest.git.clean_end, currentClean);
    assert.equal(manifest.git.clean_end, false);
    assert.equal(manifest.cases.suite_versions.development, "dev-execution-v1");
    assert.equal(manifest.cases.suite_versions.holdout, "holdout-execution-v1");
    assert.equal(manifest.cases.counts.development, 1);
    assert.equal(manifest.cases.counts.holdout, 1);
    assert.equal(manifest.cases.holdout.version, "holdout-execution-v1");
    assert.match(manifest.cases.sha256, /^[a-f0-9]{64}$/);
    assert.equal(manifest.runtime_configuration.source, "obsidian-plugin-settings");
    assert.match(manifest.runtime_configuration.settings_id, /^[a-f0-9]{64}$/);
    assert.deepEqual(manifest.artifacts.development, recordedArtifact);
    assert.deepEqual(manifest.openai_transport, {
      by_suite: { development: retryStats },
      total: retryStats,
    });
    assert.deepEqual(manifest.promotion, {
      eligible: false,
      reasons: ["workflow_execution_failed"],
      warnings: [],
    });
    const manifestText = JSON.stringify(manifest);
    assert.ok(!manifestText.includes(root));
    assert.ok(!manifestText.includes(markerPath));
    assert.ok(!manifestText.includes(privateText));
    assert.ok(!manifestText.includes(privateSecret));

    const corruptResult = spawnSync(process.execPath, [
      "scripts/bench/run-eval-workflow.mjs",
      "diagnostic",
      "--cases", casesPath,
      "--vault-root", vaultRoot,
      "--plugin-data", pluginDataPath,
      "--runner", runnerPath,
      "--reports-root", reportsRoot,
      "--run-id", "execution-corrupt-manifest",
    ], {
      cwd: repoRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        AHA_EXECUTION_MARKER_PATH: markerPath,
        AHA_CORRUPT_RUNNING_MANIFEST: "1",
      },
    });
    assert.equal(corruptResult.status, 1, corruptResult.stderr || corruptResult.stdout);
    assert.equal(corruptResult.stdout, "");
    assert.equal(corruptResult.stderr, "Evaluation workflow failed: workflow_execution_failed.\n");
    const corruptOutput = `${corruptResult.stdout}\n${corruptResult.stderr}`;
    assert.ok(!corruptOutput.includes(root));
    assert.ok(!corruptOutput.includes(markerPath));
    assert.ok(!corruptOutput.includes(privateText));
    assert.ok(!corruptOutput.includes(privateSecret));
    const corruptManifest = JSON.parse(await readFile(
      path.join(reportsRoot, "runs/execution-corrupt-manifest/manifest.json"),
      "utf8",
    ));
    const corruptEndHead = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).stdout.trim();
    const corruptEndClean = spawnSync("git", ["status", "--porcelain"], { cwd: repoRoot, encoding: "utf8" }).stdout.trim() === "";
    assert.equal(corruptManifest.status, "failed");
    assert.match(corruptManifest.finished_at, /^\d{4}-\d{2}-\d{2}T/);
    assert.deepEqual(corruptManifest.failure, { phase: "execution", reason: "workflow_execution_failed" });
    assert.equal(corruptManifest.git.commit_end, corruptEndHead);
    assert.equal(corruptManifest.git.clean_end, corruptEndClean);
    assert.equal(corruptManifest.git.clean_end, false);
    assert.deepEqual(corruptManifest.cases.suite_versions, {});
    assert.deepEqual(corruptManifest.cases.counts, {});
    assert.equal(corruptManifest.runtime_configuration, null);
    assert.deepEqual(corruptManifest.artifacts, {});
    assert.deepEqual(corruptManifest.promotion, {
      eligible: false,
      reasons: ["workflow_execution_failed"],
      warnings: [],
    });
    const corruptManifestText = JSON.stringify(corruptManifest);
    assert.ok(!corruptManifestText.includes(root));
    assert.ok(!corruptManifestText.includes(markerPath));
    assert.ok(!corruptManifestText.includes(privateText));
    assert.ok(!corruptManifestText.includes(privateSecret));

    const unsafeResult = spawnSync(process.execPath, [
      "scripts/bench/run-eval-workflow.mjs",
      "diagnostic",
      "--cases", casesPath,
      "--vault-root", vaultRoot,
      "--plugin-data", pluginDataPath,
      "--runner", runnerPath,
      "--reports-root", reportsRoot,
      "--run-id", "execution-unsafe-manifest",
    ], {
      cwd: repoRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        AHA_EXECUTION_MARKER_PATH: markerPath,
        AHA_UNSAFE_RUNNING_MANIFEST: "1",
      },
    });
    assert.equal(unsafeResult.status, 1, unsafeResult.stderr || unsafeResult.stdout);
    assert.equal(unsafeResult.stdout, "");
    assert.equal(unsafeResult.stderr, "Evaluation workflow failed: workflow_execution_failed.\n");
    const unsafeManifest = JSON.parse(await readFile(
      path.join(reportsRoot, "runs/execution-unsafe-manifest/manifest.json"),
      "utf8",
    ));
    assert.equal(unsafeManifest.status, "failed");
    assert.deepEqual(unsafeManifest.failure, { phase: "execution", reason: "workflow_execution_failed" });
    assert.deepEqual(unsafeManifest.cases.suite_versions, {});
    assert.equal(unsafeManifest.runtime_configuration, null);
    assert.deepEqual(unsafeManifest.artifacts, {});
    const unsafeManifestText = JSON.stringify(unsafeManifest);
    assert.ok(!unsafeManifestText.includes(root));
    assert.ok(!unsafeManifestText.includes(markerPath));
    assert.ok(!unsafeManifestText.includes(privateText));
    assert.ok(!unsafeManifestText.includes(privateSecret));
  } finally {
    await rm(markerPath, { force: true });
    await rm(root, { recursive: true, force: true });
  }
});

async function writeSuiteArtifact(root, suite, caseIds, options = {}) {
  const suiteDir = path.join(root, suite);
  const tracesDir = path.join(suiteDir, "traces");
  const reportPath = path.join(suiteDir, "report.json");
  await mkdir(tracesDir, { recursive: true });
  for (const id of caseIds) {
    const total = options.transportById?.[id] ?? transportStats();
    await writeFile(path.join(tracesDir, `${id}.json`), JSON.stringify({
      schema: "PipelineTrace",
      version: 2,
      profile: "product-parity",
      status: "success",
      case: { id },
      effective_configuration: { policy_id: "product-v2", policy_version: 2 },
      steps: {
        query_generation: { ...total },
        relation_judge: { ...transportStats() },
      },
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
      effective_config_id: "config-product-v2",
      effective_configuration: { retrieval_policy: { id: "product-v2", version: 2 } },
    },
    results: caseIds.map((id) => {
      const total = options.transportById?.[id] ?? transportStats();
      return {
        id,
        runtime_status: "success",
        evaluation_status: "scored",
        trace_json: `traces/${id}.json`,
        openai_transport: {
          query_generation: total,
          relation_judge: transportStats(),
          total,
        },
      };
    }),
    diagnostics: {
      openai_transport: {
        query_generation: mergeTransportStats(caseIds.map((id) => options.transportById?.[id] ?? transportStats())),
        relation_judge: transportStats(),
        total: mergeTransportStats(caseIds.map((id) => options.transportById?.[id] ?? transportStats())),
      },
    },
  }));
  return reportPath;
}

function transportStats({ requestCount = 0, retryCount = 0, category = null } = {}) {
  return {
    request_count: requestCount,
    attempt_count: requestCount + retryCount,
    retry_count: retryCount,
    retry_categories: category && retryCount > 0 ? { [category]: retryCount } : {},
  };
}

function mergeTransportStats(values) {
  const merged = transportStats();
  for (const value of values) {
    merged.request_count += value.request_count;
    merged.attempt_count += value.attempt_count;
    merged.retry_count += value.retry_count;
    for (const [category, count] of Object.entries(value.retry_categories)) {
      merged.retry_categories[category] = (merged.retry_categories[category] ?? 0) + count;
    }
  }
  return merged;
}
