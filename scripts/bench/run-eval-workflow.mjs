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
  await createImmutableRunDirectory(runDir);

  if (specification.command === "validate") {
    process.exitCode = await runValidate({ ...options, specification, gitStart, runId, runDir, manifestPath });
    return;
  }
  if (specification.command === "smoke") {
    process.exitCode = await runSmoke({ ...options, specification, gitStart, runId, runDir, manifestPath });
    return;
  }
  process.exitCode = await runPipeline({ ...options, specification, gitStart, runId, runDir, manifestPath });
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
  const startedAt = new Date().toISOString();
  let status = "complete";
  let validation;
  try {
    validation = context.privateValidation
      ? await validatePrivateCases(context.cases, context.vaultRoot)
      : await validatePublicCases(context.cases);
  } catch (error) {
    status = "failed";
    validation = { status: "failed", reason: "validation_failed" };
    console.error(error.message);
  }
  const endState = readGitState(REPO_ROOT);
  const manifest = buildWorkflowProvenance({
    workflow: "validate",
    runId: context.runId,
    profile: null,
    status,
    startedAt,
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
  console.log(`Validation ${status}: ${relativeToRepo(context.manifestPath)}`);
  return status === "complete" ? 0 : 1;
}

async function runSmoke(context) {
  const startedAt = new Date().toISOString();
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
    startedAt,
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
  const startedAt = new Date().toISOString();
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
    startedAt,
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
    startedAt,
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
    if (error?.code === "EEXIST") throw new Error(`Run directory already exists: ${relativeToRepo(runDir)}`);
    throw error;
  }
}

function safeValidationSummary(validation) {
  return {
    status: validation.status,
    reason: validation.reason ?? null,
    suite_versions: validation.suiteVersions ?? {},
    case_counts: validation.caseCounts ?? {},
  };
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

await main();
