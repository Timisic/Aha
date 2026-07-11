#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  benchmarkHoldoutSnapshot,
  readBenchmarkCases,
  validateBenchmarkSuiteDocument,
  validatePublicBenchmarkFixture,
} from "../lib/bench-cases.mjs";
import {
  buildWorkflowProvenance,
  evaluateBaselinePromotion,
  evaluateHoldoutSnapshotTransition,
  loadPluginRuntimeConfiguration,
  promoteLatestPointer,
  readGitState,
  resolveLatestPointer,
  sha256File,
  workflowSpecification,
  writeJsonAtomic,
} from "../lib/bench-workflow.mjs";
import { benchVaultRoot } from "../lib/vault-paths.mjs";
import { normalizeOpenAiTransportStats } from "../lib/openai-transport.mjs";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const DEFAULT_REPORTS_ROOT = path.join(REPO_ROOT, "bench/reports");
const DEFAULT_PRIVATE_CASES = path.join(REPO_ROOT, "bench/aha-memory-cases.json");
const DEFAULT_PUBLIC_CASES = path.join(REPO_ROOT, "bench/aha-memory-cases.example.json");
const DEFAULT_RUNNER = path.join(REPO_ROOT, "scripts/bench/run-pipeline-bench.mjs");
const SMOKE_TESTS = [
  "scripts/aha/tests/bench-scoring.test.mjs",
  "scripts/aha/tests/benchmark-suites.test.mjs",
  "scripts/aha/tests/evaluation-evidence.test.mjs",
  "scripts/aha/tests/pipeline-bench-profiles.test.mjs",
  "scripts/aha/tests/benchmark-workflows.test.mjs",
  "scripts/aha/tests/review-seeds-collector.test.mjs",
];
const SAFE_VALIDATION_REASON_CODES = [
  "missing_suite_metadata",
  "invalid_suite_metadata",
  "missing_suite",
  "invalid_suite",
  "missing_evaluation_mode",
  "invalid_evaluation_mode",
  "missing_provenance",
  "graph_evidence_conflicts",
  "mode_review_required",
  "identity_conflicts",
  "duplicate_case_ids",
  "cross_suite_leakage",
  "missing_privacy_declaration",
  "non_synthetic_provenance",
  "private_paths",
  "forbidden_content_fields",
];
const EVIDENCE_SUITES = ["development", "holdout"];

const USAGE = [
  "Usage:",
  "  node scripts/bench/run-eval-workflow.mjs <validate|smoke|baseline|diagnostic> [options] [-- runner-options]",
  "",
  "Options:",
  "  --cases <path>           Benchmark cases file",
  "  --vault-root <path>      Private benchmark vault root",
  "  --plugin-data <path>     Aha plugin data.json used as the live runtime configuration",
  "  --reports-root <path>    Default: bench/reports",
  "  --run-id <id>            Stable run directory name",
  "  --latest-pointer <path>  Default: <reports-root>/latest/product-parity.json",
  "  --runner <path>          Pipeline runner override",
  "  --private                Validate the private suite instead of the public example",
  "  -h, --help",
].join("\n");

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(USAGE);
    return;
  }
  const specification = workflowSpecification(options.command);
  const gitStart = readGitState(REPO_ROOT);
  const runId = options.runId || defaultRunId(specification.command, gitStart.head);
  const runDir = path.join(options.reportsRoot, "runs", runId);
  const manifestPath = path.join(runDir, "manifest.json");
  const startedAt = new Date().toISOString();
  await createImmutableRunDirectory(runDir);

  const context = { ...options, specification, gitStart, runId, runDir, manifestPath, startedAt };
  try {
    if (specification.command === "validate") {
      process.exitCode = await runValidate(context);
      return;
    }
    if (specification.command === "smoke") {
      process.exitCode = await runSmoke(context);
      return;
    }
    process.exitCode = await runPipeline(context);
  } catch {
    const phase = existsSync(manifestPath) ? "execution" : "preflight";
    try {
      await writeFailedWorkflowManifest(context, phase);
      console.error(`Evaluation workflow failed: workflow_${phase}_failed.`);
    } catch {
      console.error("Evaluation workflow failed: workflow_failure_manifest_write_failed.");
    }
    process.exitCode = 1;
  }
}

function parseArgs(argv) {
  const command = argv[0];
  if (!command || command === "-h" || command === "--help") return { help: true };
  const options = {
    command,
    reportsRoot: DEFAULT_REPORTS_ROOT,
    runner: DEFAULT_RUNNER,
    privateValidation: false,
    runnerArgs: [],
  };
  let forwarded = false;
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (forwarded) {
      options.runnerArgs.push(arg);
      continue;
    }
    if (arg === "--") {
      forwarded = true;
      continue;
    }
    if (arg === "-h" || arg === "--help") {
      options.help = true;
      continue;
    }
    if (arg === "--private") {
      options.privateValidation = true;
      continue;
    }
    const key = {
      "--cases": "cases",
      "--vault-root": "vaultRoot",
      "--plugin-data": "pluginData",
      "--reports-root": "reportsRoot",
      "--run-id": "runId",
      "--latest-pointer": "latestPointer",
      "--runner": "runner",
    }[arg];
    if (!key) throw new Error(`Unknown workflow option: ${arg}\n\n${USAGE}`);
    const value = argv[++index];
    if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value.`);
    options[key] = pathOption(key) ? path.resolve(value) : value;
  }
  options.latestPointer ??= path.join(options.reportsRoot, "latest/product-parity.json");
  options.cases ??= command === "validate" && !options.privateValidation ? DEFAULT_PUBLIC_CASES : DEFAULT_PRIVATE_CASES;
  options.vaultRoot ??= benchVaultRoot();
  options.pluginData ??= path.join(options.vaultRoot, ".obsidian/plugins/aha-memory-surface/data.json");
  assertSafeRunId(options.runId);
  rejectProtectedRunnerArgs(options.runnerArgs);
  return options;
}

async function runValidate(context) {
  let status = "complete";
  let validation;
  try {
    validation = context.privateValidation
      ? await validatePrivateCases(context.cases, context.vaultRoot)
      : await validatePublicCases(context.cases);
  } catch (error) {
    status = "failed";
    const reason = safeValidationFailureReason(error);
    validation = { status: "failed", reason };
    console.error(`Validation failed: ${reason}.`);
  }
  const endState = readGitState(REPO_ROOT);
  const manifest = buildWorkflowProvenance({
    workflow: "validate",
    runId: context.runId,
    profile: null,
    status,
    startedAt: context.startedAt,
    finishedAt: new Date().toISOString(),
    startState: context.gitStart,
    endState,
    casesHash: existsSync(context.cases) ? await sha256File(context.cases) : null,
    suiteVersions: validation.suiteVersions,
    caseCounts: validation.caseCounts,
    artifacts: {},
    promotion: { eligible: false, reasons: ["validation_does_not_promote"] },
  });
  manifest.validation = safeValidationSummary(validation);
  await writeJsonAtomic(context.manifestPath, manifest);
  if (status === "complete") {
    console.log(`Validation complete: ${relativeToRepo(context.manifestPath)}`);
  }
  return status === "complete" ? 0 : 1;
}

async function runSmoke(context) {
  const result = spawnSync(process.execPath, ["--test", "--test-concurrency=1", ...SMOKE_TESTS], {
    cwd: REPO_ROOT,
    stdio: "inherit",
  });
  const status = result.status === 0 ? "complete" : "failed";
  const manifest = buildWorkflowProvenance({
    workflow: "smoke",
    runId: context.runId,
    profile: null,
    status,
    startedAt: context.startedAt,
    finishedAt: new Date().toISOString(),
    startState: context.gitStart,
    endState: readGitState(REPO_ROOT),
    casesHash: null,
    suiteVersions: {},
    caseCounts: { synthetic_test_files: SMOKE_TESTS.length },
    artifacts: {},
    promotion: { eligible: false, reasons: ["smoke_does_not_promote"] },
  });
  await writeJsonAtomic(context.manifestPath, manifest);
  return result.status ?? 1;
}

async function runPipeline(context) {
  const casesHashStart = await sha256File(context.cases);
  const pluginRuntime = loadPluginRuntimeConfiguration(context.pluginData, { repoRoot: REPO_ROOT });
  const previousVaultRoot = process.env.AHA_BENCH_VAULT_ROOT;
  if (context.vaultRoot) process.env.AHA_BENCH_VAULT_ROOT = context.vaultRoot;
  let benchmark;
  try {
    benchmark = readBenchmarkCases(context.cases);
    validateBenchmarkSuiteDocument(benchmark.input, benchmark.cases, {
      resolver: benchmark.identityResolver,
      strict: true,
    });
  } finally {
    restoreVaultRoot(previousVaultRoot);
  }
  const activeBySuite = Object.fromEntries(context.specification.suites.map((suite) => [
    suite,
    benchmark.cases.filter((caseItem) => caseItem.suite === suite).map((caseItem) => caseItem.id),
  ]).filter(([, ids]) => ids.length > 0));
  const missingSuites = context.specification.suites.filter((suite) => !activeBySuite[suite]?.length);
  if (missingSuites.length > 0) {
    throw new Error(`${context.specification.command} requires at least one active case in: ${missingSuites.join(", ")}.`);
  }
  const holdoutSnapshot = benchmarkHoldoutSnapshot(benchmark.input, benchmark.identityResolver);
  const previousBaseline = await previousBaselineState(context.latestPointer);
  const holdoutTransition = evaluateHoldoutSnapshotTransition(
    previousBaseline.manifest?.cases?.holdout ?? null,
    holdoutSnapshot,
  );

  await writeJsonAtomic(context.manifestPath, buildWorkflowProvenance({
    workflow: context.specification.command,
    runId: context.runId,
    profile: context.specification.profile,
    status: "running",
    startedAt: context.startedAt,
    finishedAt: null,
    startState: context.gitStart,
    endState: context.gitStart,
    casesHash: casesHashStart,
    suiteVersions: benchmark.suiteVersions,
    caseCounts: mapCounts(activeBySuite),
    holdoutSnapshot,
    runtimeConfiguration: pluginRuntime.provenance,
    artifacts: {},
    promotion: { eligible: false, reasons: ["run_in_progress"] },
  }));

  const previousReports = previousBaseline.reportPaths;
  const artifacts = {};
  let runnerFailed = false;
  for (const [suite] of Object.entries(activeBySuite)) {
    const reportPath = path.join(context.runDir, suite, "report.json");
    await mkdir(path.dirname(reportPath), { recursive: true });
    const args = [
      context.runner,
      "--cases", context.cases,
      "--report", reportPath,
      "--profile", context.specification.profile,
      "--suite", suite,
      "--no-archive",
    ];
    if (previousReports[suite]) args.push("--compare-report", previousReports[suite]);
    args.push(...pluginRuntime.runnerArgs, ...context.runnerArgs);
    const result = spawnSync(process.execPath, args, {
      cwd: REPO_ROOT,
      stdio: "inherit",
      env: {
        ...process.env,
        ...pluginRuntime.environment,
        AHA_BENCH_VAULT_ROOT: context.vaultRoot,
      },
    });
    if (result.status !== 0) runnerFailed = true;
    if (existsSync(reportPath)) {
      const report = JSON.parse(await readFile(reportPath, "utf8"));
      artifacts[suite] = await buildSuiteArtifact({
        suite,
        reportPath,
        report: path.relative(context.runDir, reportPath),
        effectiveConfigId: report.metadata?.effective_config_id ?? null,
        reportDocument: report,
        runDir: context.runDir,
      });
    }
  }

  const endState = readGitState(REPO_ROOT);
  const casesHashEnd = await sha256File(context.cases);
  const identitiesReady = benchmark.cases.every((caseItem) => caseItem.identity_evaluation?.status === "ready");
  const promotion = context.specification.promotes && !runnerFailed
    ? evaluateBaselinePromotion({
        workflow: context.specification.command,
        profile: context.specification.profile,
        startState: context.gitStart,
        endState,
        casesHashStart,
        casesHashEnd,
        suiteValidationStatus: benchmark.suiteEvaluation.status,
        identitiesReady,
        suiteVersions: benchmark.suiteVersions,
        expectedCaseIds: activeBySuite,
        artifacts,
        holdoutTransition,
        expectedRetrievalPolicy: pluginRuntime.provenance.retrieval_policy,
        repoRoot: REPO_ROOT,
      })
    : {
        eligible: false,
        reasons: [runnerFailed ? "runner_failed" : "diagnostic_does_not_promote"],
      };
  const manifest = buildWorkflowProvenance({
    workflow: context.specification.command,
    runId: context.runId,
    profile: context.specification.profile,
    status: runnerFailed ? "failed" : promotion.eligible ? "complete" : "ineligible",
    startedAt: context.startedAt,
    finishedAt: new Date().toISOString(),
    startState: context.gitStart,
    endState,
    casesHash: casesHashEnd,
    suiteVersions: benchmark.suiteVersions,
    caseCounts: mapCounts(activeBySuite),
    holdoutSnapshot,
    runtimeConfiguration: pluginRuntime.provenance,
    artifacts,
    promotion,
  });
  await writeJsonAtomic(context.manifestPath, manifest);
  if (promotion.eligible) {
    await promoteLatestPointer({
      pointerPath: context.latestPointer,
      manifestPath: context.manifestPath,
      gitCommit: endState.head,
      suiteVersions: benchmark.suiteVersions,
      promotedAt: new Date().toISOString(),
    });
    console.log(`Promoted baseline pointer: ${relativeToRepo(context.latestPointer)}`);
  } else {
    console.log(`Run kept without promotion: ${promotion.reasons.join(", ")}`);
  }
  return runnerFailed ? 1 : context.specification.promotes && !promotion.eligible ? 2 : 0;
}

async function validatePrivateCases(casesPath, vaultRoot) {
  const previous = process.env.AHA_BENCH_VAULT_ROOT;
  if (vaultRoot) process.env.AHA_BENCH_VAULT_ROOT = vaultRoot;
  try {
    const benchmark = readBenchmarkCases(casesPath, { includeDraft: true, includeOff: true });
    validateBenchmarkSuiteDocument(benchmark.input, benchmark.cases, {
      resolver: benchmark.identityResolver,
      strict: true,
    });
    if (benchmark.cases.some((caseItem) => caseItem.identity_evaluation?.status !== "ready")) {
      throw new Error("Canonical identity validation is not ready.");
    }
    return {
      status: "ready",
      suiteVersions: benchmark.suiteVersions,
      caseCounts: countCases(benchmark.cases),
    };
  } finally {
    restoreVaultRoot(previous);
  }
}

async function validatePublicCases(casesPath) {
  const document = JSON.parse(await readFile(casesPath, "utf8"));
  validatePublicBenchmarkFixture(document, { strict: true });
  const syntheticVault = await materializePublicVault(document);
  try {
    const previous = process.env.AHA_BENCH_VAULT_ROOT;
    process.env.AHA_BENCH_VAULT_ROOT = syntheticVault;
    try {
      const benchmark = readBenchmarkCases(casesPath, { includeDraft: true, includeOff: true });
      validateBenchmarkSuiteDocument(benchmark.input, benchmark.cases, {
        resolver: benchmark.identityResolver,
        strict: true,
      });
      return {
        status: "ready",
        suiteVersions: benchmark.suiteVersions,
        caseCounts: countCases(benchmark.cases),
      };
    } finally {
      restoreVaultRoot(previous);
    }
  } finally {
    await rm(syntheticVault, { recursive: true, force: true });
  }
}

async function materializePublicVault(document) {
  const root = await mkdtemp(path.join(tmpdir(), "aha-public-bench-vault-"));
  const paths = new Set();
  for (const caseItem of document.cases ?? []) {
    for (const value of [
      caseItem.input?.note,
      ...(caseItem.gold?.must ?? []),
      ...(caseItem.gold?.nice ?? []),
      ...(caseItem.gold?.noise ?? []),
      ...(caseItem.relation_targets ?? []).map((item) => item?.note_path ?? item?.notePath),
      ...(caseItem.graph_evidence ?? []).map((item) => item?.target),
    ]) {
      if (typeof value === "string" && value.trim()) paths.add(value.trim());
    }
  }
  for (const relativePath of paths) {
    const target = path.resolve(root, relativePath);
    if (!target.startsWith(`${root}${path.sep}`)) throw new Error("Public fixture path escapes the synthetic vault.");
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, Array.from({ length: 24 }, (_, index) => `Synthetic line ${index + 1}.`).join("\n"));
  }
  return root;
}

async function previousBaselineState(pointerPath) {
  if (!existsSync(pointerPath)) return { reportPaths: {}, manifest: null };
  try {
    const latest = await resolveLatestPointer(pointerPath);
    return { reportPaths: latest.reportPaths, manifest: latest.manifest };
  } catch (error) {
    throw new Error(`Existing latest baseline pointer is invalid: ${error.message}`);
  }
}

async function buildSuiteArtifact(input) {
  const reportPath = path.resolve(input.reportPath);
  assertInsideRun(input.runDir, reportPath, `${input.suite} report`);
  const traces = {};
  for (const result of input.reportDocument.results ?? []) {
    const tracePath = resolveTraceArtifact(result.trace_json, reportPath);
    if (!tracePath) continue;
    assertInsideRun(input.runDir, tracePath, `${input.suite} trace`);
    traces[slash(path.relative(input.runDir, tracePath))] = await sha256File(tracePath);
  }
  return {
    reportPath,
    report: slash(input.report),
    reportSha256: await sha256File(reportPath),
    traces,
    effectiveConfigId: input.effectiveConfigId,
    openAiTransport: normalizeOpenAiTransportStats(
      input.reportDocument.diagnostics?.openai_transport?.total,
    ),
  };
}

function resolveTraceArtifact(reference, reportPath) {
  const value = String(reference ?? "").trim();
  if (!value) return null;
  const candidates = path.isAbsolute(value)
    ? [path.resolve(value)]
    : [path.resolve(REPO_ROOT, value), path.resolve(path.dirname(reportPath), value)];
  return candidates.find(existsSync) ?? null;
}

function assertInsideRun(runDir, candidate, label) {
  const relativePath = path.relative(path.resolve(runDir), path.resolve(candidate));
  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw new Error(`${label} escapes immutable run directory.`);
  }
}

async function createImmutableRunDirectory(runDir) {
  await mkdir(path.dirname(runDir), { recursive: true });
  try {
    await mkdir(runDir);
  } catch (error) {
    if (error?.code === "EEXIST") {
      const runExists = new Error("Evaluation workflow run already exists.");
      runExists.code = "WORKFLOW_RUN_EXISTS";
      throw runExists;
    }
    throw error;
  }
}

async function writeFailedWorkflowManifest(context, phase) {
  const reason = `workflow_${phase}_failed`;
  const endState = readGitState(REPO_ROOT);
  const existing = await readExistingWorkflowManifest(context);
  const minimal = buildWorkflowProvenance({
    workflow: context.specification.command,
    runId: context.runId,
    profile: context.specification.profile,
    status: "failed",
    startedAt: context.startedAt,
    finishedAt: new Date().toISOString(),
    startState: context.gitStart,
    endState,
    casesHash: null,
    suiteVersions: {},
    caseCounts: {},
    artifacts: {},
    promotion: { eligible: false, reasons: [reason] },
  });
  let manifest = minimal;
  if (existing) {
    try {
      manifest = buildProjectedFailureManifest(context, existing, endState, reason);
    } catch {
      manifest = minimal;
    }
  }
  manifest.failure = { phase, reason };
  await writeJsonAtomic(context.manifestPath, manifest);
}

function buildProjectedFailureManifest(context, existing, endState, reason) {
  if (!isRecord(existing.cases)) throw new Error("Existing workflow cases provenance is invalid.");
  const casesHash = requireDigest(existing.cases.sha256, "cases sha256");
  const suiteVersions = projectSuiteVersions(existing.cases.suite_versions, context.specification.suites);
  const caseCounts = projectCaseCounts(existing.cases.counts, context.specification.suites);
  const holdoutSnapshot = projectHoldoutSnapshot(existing.cases.holdout);
  const runtimeConfiguration = projectRuntimeConfiguration(existing.runtime_configuration);
  const artifacts = projectArtifacts(existing.artifacts);
  return buildWorkflowProvenance({
    workflow: context.specification.command,
    runId: context.runId,
    profile: context.specification.profile,
    status: "failed",
    startedAt: context.startedAt,
    finishedAt: new Date().toISOString(),
    startState: context.gitStart,
    endState,
    casesHash,
    suiteVersions,
    caseCounts,
    holdoutSnapshot,
    runtimeConfiguration,
    artifacts,
    promotion: { eligible: false, reasons: [reason] },
  });
}

function projectSuiteVersions(value, expectedSuites) {
  if (!isRecord(value)) throw new Error("Existing workflow suite versions are invalid.");
  const projected = {};
  for (const suite of EVIDENCE_SUITES.filter((item) => Object.hasOwn(value, item))) {
    const version = value[suite];
    if (typeof version !== "string" || !/^[A-Za-z0-9._-]{1,128}$/.test(version)) {
      throw new Error("Existing workflow suite version is invalid.");
    }
    projected[suite] = version;
  }
  if (expectedSuites.some((suite) => !Object.hasOwn(projected, suite))) {
    throw new Error("Existing workflow suite version is missing.");
  }
  return projected;
}

function projectCaseCounts(value, expectedSuites) {
  if (!isRecord(value)) throw new Error("Existing workflow case counts are invalid.");
  const projected = {};
  for (const suite of EVIDENCE_SUITES.filter((item) => Object.hasOwn(value, item))) {
    const count = value[suite];
    if (!Number.isInteger(count) || count < 0) throw new Error("Existing workflow case count is invalid.");
    projected[suite] = count;
  }
  if (expectedSuites.some((suite) => !Object.hasOwn(projected, suite))) {
    throw new Error("Existing workflow case count is missing.");
  }
  return projected;
}

function projectHoldoutSnapshot(value) {
  if (value === null || value === undefined) return null;
  if (!isRecord(value)) throw new Error("Existing workflow holdout snapshot is invalid.");
  if (typeof value.version !== "string" || !/^[A-Za-z0-9._-]{1,128}$/.test(value.version)) {
    throw new Error("Existing workflow holdout version is invalid.");
  }
  if (typeof value.frozen !== "boolean") throw new Error("Existing workflow holdout frozen flag is invalid.");
  if (value.change_reason !== null && typeof value.change_reason !== "string") {
    throw new Error("Existing workflow holdout change reason is invalid.");
  }
  return {
    version: value.version,
    frozen: value.frozen,
    change_reason: value.change_reason,
    fingerprint: requireDigest(value.fingerprint, "holdout fingerprint"),
  };
}

function projectRuntimeConfiguration(value) {
  if (!isRecord(value)) throw new Error("Existing workflow runtime provenance is invalid.");
  if (value.source !== "obsidian-plugin-settings") {
    throw new Error("Existing workflow runtime source is invalid.");
  }
  return {
    source: value.source,
    settings_id: requireDigest(value.settings_id, "runtime settings id"),
  };
}

function projectArtifacts(value) {
  if (!isRecord(value)) throw new Error("Existing workflow artifacts are invalid.");
  const projected = {};
  for (const suite of EVIDENCE_SUITES) {
    if (!Object.hasOwn(value, suite)) continue;
    const artifact = value[suite];
    if (!isRecord(artifact)) throw new Error("Existing workflow suite artifact is invalid.");
    projected[suite] = {
      report: artifact.report,
      reportSha256: artifact.report_sha256 ?? undefined,
      traces: artifact.traces,
      effectiveConfigId: requireDigest(artifact.effective_config_id, `${suite} effective config id`),
      openAiTransport: artifact.openai_transport,
    };
  }
  return projected;
}

function requireDigest(value, label) {
  const digest = String(value ?? "");
  if (!/^[a-f0-9]{64}$/i.test(digest)) throw new Error(`Existing workflow ${label} is invalid.`);
  return digest;
}

async function readExistingWorkflowManifest(context) {
  try {
    const manifest = JSON.parse(await readFile(context.manifestPath, "utf8"));
    if (!isRecord(manifest)) return null;
    if (manifest.schema !== "AhaBenchmarkWorkflowRun") return null;
    if (manifest.workflow !== context.specification.command) return null;
    if (manifest.run_id !== context.runId) return null;
    return manifest;
  } catch {
    return null;
  }
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function safeValidationSummary(validation) {
  return {
    status: validation.status,
    reason: validation.reason ?? null,
    suite_versions: validation.suiteVersions ?? {},
    case_counts: validation.caseCounts ?? {},
  };
}

function safeValidationFailureReason(error) {
  const message = String(error?.message ?? "");
  const tokens = new Set((message.match(/[a-z][a-z0-9_]*/gi) ?? []).map((token) => token.toLowerCase()));
  const codes = SAFE_VALIDATION_REASON_CODES.filter((code) => tokens.has(code));
  return codes.length > 0 ? codes.join(",") : "validation_failed";
}

function countCases(cases) {
  const counts = { total: cases.length, development: 0, holdout: 0, discovery: 0, graph_assisted: 0 };
  for (const caseItem of cases) {
    if (Object.hasOwn(counts, caseItem.suite)) counts[caseItem.suite] += 1;
    if (Object.hasOwn(counts, caseItem.evaluation_mode)) counts[caseItem.evaluation_mode] += 1;
  }
  return counts;
}

function mapCounts(casesBySuite) {
  return Object.fromEntries(Object.entries(casesBySuite).map(([suite, ids]) => [suite, ids.length]));
}

function rejectProtectedRunnerArgs(args) {
  const protectedFlags = new Set([
    "--cases", "--report", "--profile", "--suite", "--compare-report", "--only", "--include-draft", "--no-archive",
    "--llm-provider", "--llm-base-url", "--llm-model", "--llm-api-key-env",
    "--query-agent-provider", "--query-agent-bin", "--query-agent-model",
    "--relation-judge-agent-provider", "--relation-judge-agent-bin", "--relation-judge-agent-model",
    "--runtime-codex-command", "--runtime-codex-model", "--runtime-codex-reasoning-effort", "--runtime-codex-sandbox",
    "--runtime-qmd-runner", "--runtime-qmd-sdk-module", "--runtime-qmd-rerank",
    "--qmd", "--index", "--obsidian", "--limit", "--no-source-note-filter",
  ]);
  const conflict = args.find((arg) => protectedFlags.has(arg));
  if (conflict) throw new Error(`${conflict} is owned by the named evaluation workflow.`);
}

function pathOption(key) {
  return ["cases", "vaultRoot", "pluginData", "reportsRoot", "latestPointer", "runner"].includes(key);
}

function assertSafeRunId(runId) {
  if (runId !== undefined && !/^[a-zA-Z0-9._-]+$/.test(runId)) throw new Error("run-id contains unsafe characters.");
}

function defaultRunId(command, head) {
  return `${new Date().toISOString().replace(/[:.]/g, "-")}-${String(head).slice(0, 8)}-${command}`;
}

function relativeToRepo(filePath) {
  return path.relative(REPO_ROOT, filePath).replace(/\\/g, "/");
}

function slash(value) {
  return String(value).replace(/\\/g, "/");
}

function restoreVaultRoot(previous) {
  if (previous === undefined) delete process.env.AHA_BENCH_VAULT_ROOT;
  else process.env.AHA_BENCH_VAULT_ROOT = previous;
}

try {
  await main();
} catch (error) {
  const code = error?.code === "WORKFLOW_RUN_EXISTS"
    ? "workflow_run_exists"
    : "workflow_setup_failed";
  console.error(`Evaluation workflow setup failed: ${code}.`);
  process.exitCode = 1;
}
