import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  emptyOpenAiTransportStats,
  mergeOpenAiTransportStats,
  normalizeOpenAiTransportStats,
} from "./openai-transport.mjs";

const WORKFLOW_SCHEMA = "AhaBenchmarkWorkflowRun";
const POINTER_SCHEMA = "AhaBenchmarkLatestPointer";
const OPENAI_TRANSPORT_FIELDS = ["request_count", "attempt_count", "retry_count", "retry_categories"];
const RECOVERED_RETRY_WARNING_PREFIX = "recovered_openai_retries:";

const WORKFLOWS = {
  validate: { command: "validate", profile: null, suites: [], promotes: false },
  smoke: { command: "smoke", profile: null, suites: [], promotes: false },
  baseline: {
    command: "baseline",
    profile: "product-parity",
    suites: ["development", "holdout"],
    promotes: true,
  },
  diagnostic: {
    command: "diagnostic",
    profile: "diagnostic-enhanced",
    suites: ["development"],
    promotes: false,
  },
};

export function workflowSpecification(command) {
  const specification = WORKFLOWS[String(command ?? "").trim().toLowerCase()];
  if (!specification) throw new Error(`Unknown evaluation workflow: ${command}`);
  return structuredClone(specification);
}

export async function sha256File(filePath) {
  return sha256(await readFile(filePath));
}

export function readGitState(repoRoot, spawn) {
  const run = spawn ?? defaultSpawn;
  const head = run("git", ["rev-parse", "HEAD"], repoRoot).trim();
  const porcelain = run("git", ["status", "--porcelain"], repoRoot);
  return { head, clean: porcelain.trim().length === 0 };
}

export function loadPluginRuntimeConfiguration(pluginDataPath, options = {}) {
  let document;
  try {
    document = JSON.parse(readFileSync(path.resolve(pluginDataPath), "utf8"));
  } catch (error) {
    throw new Error(`Could not read Aha plugin settings: ${error.message}`);
  }
  const settings = document?.settings;
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
    throw new Error("Aha plugin data must contain a settings object for product-parity evaluation.");
  }
  const required = (key) => {
    const value = typeof settings[key] === "string" ? settings[key].trim() : "";
    if (!value) throw new Error(`Aha plugin setting ${key} is required for product-parity evaluation.`);
    return value;
  };
  const repoRoot = path.resolve(options.repoRoot ?? ".");
  const workspace = path.resolve(required("ahaWorkspace"));
  if (workspace !== repoRoot) {
    throw new Error("Aha plugin workspace does not match the repository being benchmarked.");
  }
  const wrapperRelativePath = required("wrapperRelativePath").replace(/\\/g, "/").replace(/^\.\//, "");
  if (wrapperRelativePath !== "scripts/aha/run-insight-search.mjs") {
    throw new Error("Aha plugin wrapper must be the shipped scripts/aha/run-insight-search.mjs for product parity.");
  }
  if (settings.useFixtureResult === true) {
    throw new Error("Plugin fixture result must be disabled for product-parity evaluation.");
  }
  const targetCandidates = Number(settings.targetCandidates);
  if (!Number.isInteger(targetCandidates) || targetCandidates < 15 || targetCandidates > 20) {
    throw new Error("Aha plugin targetCandidates must be an integer from 15 to 20.");
  }
  const qmdRunner = required("qmdRunner");
  if (!["sdk", "cli"].includes(qmdRunner)) throw new Error("Aha plugin qmdRunner must be sdk or cli.");
  const llmProvider = required("llmProvider");
  if (!["openai", "codex-cli"].includes(llmProvider)) throw new Error("Aha plugin llmProvider is unsupported.");
  const llmApiKeyEnv = required("llmApiKeyEnv");
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(llmApiKeyEnv)) {
    throw new Error("Aha plugin llmApiKeyEnv is not a valid environment variable name.");
  }
  if (typeof settings.qmdRerank !== "boolean") throw new Error("Aha plugin qmdRerank must be boolean.");
  const retrievalPolicy = typeof settings.retrievalPolicy === "string" && settings.retrievalPolicy.trim()
    ? settings.retrievalPolicy.trim()
    : "legacy-v1";
  if (!["product-v2", "legacy-v1"].includes(retrievalPolicy)) {
    throw new Error("Aha plugin retrievalPolicy must be product-v2 or legacy-v1.");
  }

  const effective = {
    llm_provider: llmProvider,
    llm_base_url: required("llmBaseUrl"),
    llm_model: required("llmModel"),
    llm_api_key_env: llmApiKeyEnv,
    codex_command: required("codexCommand"),
    codex_model: required("codexModel"),
    codex_reasoning_effort: required("codexReasoningEffort"),
    codex_sandbox: required("codexSandbox"),
    qmd_runner: qmdRunner,
    qmd_command: required("qmdCommand"),
    qmd_index: required("qmdIndex"),
    qmd_sdk_module: typeof settings.qmdSdkModule === "string" ? settings.qmdSdkModule.trim() : "",
    qmd_rerank: settings.qmdRerank,
    obsidian_command: required("obsidianCommand"),
    target_candidates: targetCandidates,
    retrieval_policy: retrievalPolicy,
    wrapper: wrapperRelativePath,
  };
  const runnerArgs = [
    "--llm-provider", effective.llm_provider,
    "--llm-base-url", effective.llm_base_url,
    "--llm-model", effective.llm_model,
    "--llm-api-key-env", effective.llm_api_key_env,
    "--query-agent-provider", effective.llm_provider,
    "--query-agent-bin", effective.codex_command,
    "--query-agent-model", effective.llm_provider === "codex-cli" ? effective.codex_model : effective.llm_model,
    "--relation-judge-agent-provider", effective.llm_provider,
    "--relation-judge-agent-bin", effective.codex_command,
    "--relation-judge-agent-model", effective.llm_provider === "codex-cli" ? effective.codex_model : effective.llm_model,
    "--runtime-codex-command", effective.codex_command,
    "--runtime-codex-model", effective.codex_model,
    "--runtime-codex-reasoning-effort", effective.codex_reasoning_effort,
    "--runtime-codex-sandbox", effective.codex_sandbox,
    "--runtime-qmd-runner", effective.qmd_runner,
    "--qmd", effective.qmd_command,
    "--index", effective.qmd_index,
    "--obsidian", effective.obsidian_command,
    "--limit", String(effective.target_candidates),
    "--retrieval-policy", effective.retrieval_policy,
  ];
  if (effective.qmd_sdk_module) runnerArgs.push("--runtime-qmd-sdk-module", effective.qmd_sdk_module);
  if (effective.qmd_rerank) runnerArgs.push("--runtime-qmd-rerank");
  const settingsId = sha256(JSON.stringify(effective));
  return {
    runnerArgs,
    environment: typeof settings.llmApiKey === "string" && settings.llmApiKey.trim()
      ? { [llmApiKeyEnv]: settings.llmApiKey.trim() }
      : {},
    settingsId,
    provenance: {
      source: "obsidian-plugin-settings",
      settings_id: settingsId,
      retrieval_policy: effective.retrieval_policy,
    },
  };
}

export function buildWorkflowProvenance(input) {
  const artifacts = safeArtifacts(input.artifacts);
  return {
    schema: WORKFLOW_SCHEMA,
    version: 1,
    workflow: input.workflow,
    run_id: input.runId,
    profile: input.profile ?? null,
    status: input.status ?? (input.promotion?.eligible ? "complete" : "ineligible"),
    started_at: input.startedAt,
    finished_at: input.finishedAt,
    git: {
      commit_start: input.startState?.head ?? null,
      commit_end: input.endState?.head ?? null,
      clean_start: input.startState?.clean === true,
      clean_end: input.endState?.clean === true,
    },
    cases: {
      sha256: input.casesHash ?? null,
      suite_versions: cloneObject(input.suiteVersions),
      counts: cloneObject(input.caseCounts),
      holdout: safeHoldoutSnapshot(input.holdoutSnapshot),
    },
    runtime_configuration: safeRuntimeConfiguration(input.runtimeConfiguration),
    artifacts,
    openai_transport: manifestOpenAiTransport(artifacts),
    promotion: {
      eligible: input.promotion?.eligible === true,
      reasons: [...(input.promotion?.reasons ?? [])],
      warnings: [...(input.promotion?.warnings ?? [])],
    },
  };
}

export function evaluateBaselinePromotion(input) {
  const reasons = [];
  const warnings = [];
  if (input.workflow !== "baseline") reasons.push("workflow_not_baseline");
  if (input.profile !== "product-parity") reasons.push("profile_not_product_parity");
  if (!input.startState?.clean) reasons.push("dirty_worktree_start");
  if (!input.endState?.clean) reasons.push("dirty_worktree_end");
  if (!input.startState?.head || input.startState.head !== input.endState?.head) reasons.push("git_head_changed");
  if (!input.casesHashStart || input.casesHashStart !== input.casesHashEnd) reasons.push("cases_changed");
  if (input.suiteValidationStatus !== "ready") reasons.push("suite_validation_not_ready");
  if (input.identitiesReady !== true) reasons.push("identity_validation_not_ready");
  if (input.holdoutTransition?.status === "invalid") {
    reasons.push(...(input.holdoutTransition.reasons ?? ["holdout_transition_invalid"]));
  }

  for (const suite of ["development", "holdout"]) {
    const expectedIds = input.expectedCaseIds?.[suite];
    if (!Array.isArray(expectedIds) || expectedIds.length === 0) {
      reasons.push(`missing_active_suite:${suite}`);
      continue;
    }
    inspectSuiteArtifact({ suite, expectedIds, input, reasons, warnings });
  }
  return {
    eligible: reasons.length === 0,
    reasons: Array.from(new Set(reasons)).sort(reasonOrder),
    warnings: Array.from(new Set(warnings)).sort(),
  };
}

export function evaluateHoldoutSnapshotTransition(previous, current) {
  const reasons = [];
  if (!current?.version || !current?.fingerprint) reasons.push("missing_holdout_snapshot");
  if (current?.frozen !== true) reasons.push("holdout_not_frozen");
  if (!previous) {
    return { status: reasons.length > 0 ? "invalid" : "initial", reasons };
  }
  const changed = previous.fingerprint !== current?.fingerprint;
  if (changed && previous.version === current?.version) reasons.push("holdout_version_not_changed");
  if (changed && previous.version !== current?.version && !String(current?.change_reason ?? "").trim()) {
    reasons.push("missing_holdout_change_reason");
  }
  return {
    status: reasons.length > 0 ? "invalid" : changed ? "versioned_change" : "unchanged",
    reasons,
  };
}

function inspectSuiteArtifact({ suite, expectedIds, input, reasons, warnings }) {
  const artifact = input.artifacts?.[suite];
  if (!artifact?.reportPath || !existsSync(artifact.reportPath)) {
    reasons.push(`missing_suite_report:${suite}`);
    return;
  }
  let report;
  try {
    report = JSON.parse(readFileSync(artifact.reportPath, "utf8"));
  } catch {
    reasons.push(`invalid_suite_report:${suite}`);
    return;
  }
  if (report.profile !== "product-parity") reasons.push(`report_profile_mismatch:${suite}`);
  if (report.suite?.kind !== suite) reasons.push(`report_suite_mismatch:${suite}`);
  if (report.suite?.version !== input.suiteVersions?.[suite]) reasons.push(`suite_version_mismatch:${suite}`);
  if (report.suite_validation?.status !== "ready") reasons.push(`report_suite_validation_not_ready:${suite}`);
  if (report.metadata?.git_commit !== input.startState?.head) reasons.push(`report_git_commit_mismatch:${suite}`);
  if (report.metadata?.git_clean !== true) reasons.push(`report_worktree_not_clean:${suite}`);
  if (report.metadata?.trace_schema !== "PipelineTrace" || report.metadata?.trace_version !== 2) {
    reasons.push(`trace_schema_mismatch:${suite}`);
  }
  if (!report.metadata?.effective_config_id) reasons.push(`effective_config_missing:${suite}`);
  const policy = report.metadata?.effective_configuration?.retrieval_policy;
  if (!policy?.id || !Number.isInteger(policy?.version)) reasons.push(`retrieval_policy_identity_missing:${suite}`);
  if (input.expectedRetrievalPolicy && policy?.id !== input.expectedRetrievalPolicy) reasons.push(`expected_config_mismatch:${suite}`);
  const siblingConfigIds = Object.values(input.artifacts ?? {}).map((item) => item?.effectiveConfigId).filter(Boolean);
  if (siblingConfigIds.some((id) => id !== report.metadata?.effective_config_id)) reasons.push(`cross_suite_config_mismatch:${suite}`);

  const results = report.results ?? [];
  const actualIds = results.map((result) => result.id).sort();
  const wantedIds = [...expectedIds].sort();
  if (actualIds.length !== wantedIds.length || actualIds.some((id, index) => id !== wantedIds[index])) {
    reasons.push(`incomplete_case_set:${suite}`);
  }
  const traces = results.map((result) => inspectTrace({
    suite,
    result,
    reportPath: artifact.reportPath,
    repoRoot: input.repoRoot,
    reasons,
    report,
  }));
  if (traces.every(Boolean)) {
    try {
      const evidence = canonicalSuiteOpenAiEvidence(report, traces, `${suite} report`, {
        requireSuccess: false,
      });
      warnings.push(...recoveredRetryWarnings(suite, evidence));
    } catch {
      reasons.push(`openai_transport_invalid:${suite}`);
    }
  }
}

function inspectTrace({ suite, result, reportPath, repoRoot, reasons, report }) {
  if (result.evaluation_status !== "scored") {
    reasons.push(`case_not_scored:${suite}:${result.id}`);
  }
  if (result.runtime_status !== "success") {
    reasons.push(`runtime_not_success:${suite}:${result.id}`);
  }
  const tracePath = resolveTracePath(result.trace_json, reportPath, repoRoot);
  if (!tracePath) {
    reasons.push(`trace_missing:${suite}:${result.id}`);
    return null;
  }
  let trace;
  try {
    trace = JSON.parse(readFileSync(tracePath, "utf8"));
  } catch {
    reasons.push(`trace_invalid:${suite}:${result.id}`);
    return null;
  }
  if (trace.schema !== "PipelineTrace" || trace.version !== 2 || trace.profile !== "product-parity") {
    reasons.push(`trace_incompatible:${suite}:${result.id}`);
  } else if (trace.status !== "success") {
    reasons.push(`trace_not_success:${suite}:${result.id}`);
  }
  const tracePolicy = trace.effective_configuration;
  const reportPolicy = report.metadata?.effective_configuration?.retrieval_policy;
  if (tracePolicy?.policy_id !== reportPolicy?.id || tracePolicy?.policy_version !== reportPolicy?.version) {
    reasons.push(`trace_config_mismatch:${suite}:${result.id}`);
  }
  return trace;
}

function resolveTracePath(reference, reportPath, repoRoot) {
  const value = String(reference ?? "").trim();
  if (!value) return null;
  const candidates = path.isAbsolute(value)
    ? [value]
    : [path.resolve(repoRoot, value), path.resolve(path.dirname(reportPath), value)];
  return candidates.find(existsSync) ?? null;
}

export async function writeJsonAtomic(filePath, value) {
  const directory = path.dirname(filePath);
  const temporary = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
  );
  await mkdir(directory, { recursive: true });
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, filePath);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function promoteLatestPointer(input) {
  const pointerRoot = path.dirname(path.dirname(path.resolve(input.pointerPath)));
  const resolvedManifest = path.resolve(input.manifestPath);
  await assertPhysicalFileInside(pointerRoot, resolvedManifest, "manifest");
  const manifest = JSON.parse(await readFile(resolvedManifest, "utf8"));
  if (manifest.promotion?.eligible !== true) throw new Error("Cannot promote an ineligible benchmark manifest.");
  await verifyManifestArtifacts(manifest, resolvedManifest);
  const pointer = {
    schema: POINTER_SCHEMA,
    version: 1,
    profile: "product-parity",
    manifest: slash(path.relative(path.dirname(input.pointerPath), resolvedManifest)),
    manifest_sha256: await sha256File(resolvedManifest),
    git_commit: input.gitCommit,
    suite_versions: cloneObject(input.suiteVersions),
    promoted_at: input.promotedAt,
  };
  await writeJsonAtomic(input.pointerPath, pointer);
  return pointer;
}

export async function resolveLatestPointer(pointerPath) {
  const resolvedPointer = path.resolve(pointerPath);
  const pointer = JSON.parse(await readFile(resolvedPointer, "utf8"));
  if (pointer.schema !== POINTER_SCHEMA || pointer.version !== 1) throw new Error("Unsupported latest benchmark pointer.");
  const reportsRoot = path.dirname(path.dirname(resolvedPointer));
  const manifestPath = path.resolve(path.dirname(resolvedPointer), pointer.manifest);
  await assertPhysicalFileInside(reportsRoot, manifestPath, "manifest");
  if (await sha256File(manifestPath) !== pointer.manifest_sha256) throw new Error("Latest benchmark manifest hash mismatch.");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  await verifyManifestArtifacts(manifest, manifestPath);
  const reportPaths = Object.fromEntries(Object.entries(manifest.artifacts ?? {}).map(([suite, artifact]) => {
    const reportPath = path.resolve(path.dirname(manifestPath), artifact.report);
    assertInside(path.dirname(manifestPath), reportPath, `${suite} report`);
    return [suite, reportPath];
  }));
  return { pointer, manifest, pointerPath: resolvedPointer, manifestPath, reportPaths };
}

export async function resolveReportInput(inputPath, suite = "development") {
  const resolvedInput = path.resolve(inputPath);
  const document = JSON.parse(await readFile(resolvedInput, "utf8"));
  if (document.schema !== POINTER_SCHEMA) return resolvedInput;
  const latest = await resolveLatestPointer(resolvedInput);
  const reportPath = latest.reportPaths[suite] ?? Object.values(latest.reportPaths)[0];
  if (!reportPath) throw new Error("Latest benchmark pointer has no report artifacts.");
  return reportPath;
}

function safeArtifacts(artifacts = {}) {
  return Object.fromEntries(Object.entries(artifacts).map(([suite, artifact]) => {
    const report = slash(String(artifact.report ?? ""));
    if (!report || path.isAbsolute(report) || report.split("/").includes("..")) {
      throw new Error(`${suite} artifact report must be relative to the run directory.`);
    }
    const traces = Object.fromEntries(Object.entries(artifact.traces ?? {}).map(([tracePath, digest]) => {
      const normalized = slash(tracePath);
      if (!normalized || path.isAbsolute(normalized) || normalized.split("/").includes("..")) {
        throw new Error(`${suite} trace artifact must be relative to the run directory.`);
      }
      assertDigest(digest, `${suite} trace`);
      return [normalized, digest];
    }));
    if (artifact.reportSha256 !== undefined) assertDigest(artifact.reportSha256, `${suite} report`);
    return [suite, {
      report,
      report_sha256: artifact.reportSha256 ?? null,
      traces,
      effective_config_id: artifact.effectiveConfigId ?? null,
      openai_transport: normalizeOpenAiTransportStats(artifact.openAiTransport),
    }];
  }));
}

function manifestOpenAiTransport(artifacts = {}) {
  const bySuite = Object.fromEntries(Object.entries(artifacts).map(([suite, artifact]) => [
    suite,
    normalizeOpenAiTransportStats(artifact.openai_transport),
  ]));
  return {
    by_suite: bySuite,
    total: mergeOpenAiTransportStats(...Object.values(bySuite)),
  };
}

async function verifyManifestArtifacts(manifest, manifestPath) {
  const runDir = path.dirname(path.resolve(manifestPath));
  const verifiedBySuite = {};
  const expectedWarnings = [];
  for (const [suite, artifact] of Object.entries(manifest.artifacts ?? {})) {
    const reportPath = path.resolve(runDir, artifact.report ?? "");
    await assertPhysicalFileInside(runDir, reportPath, `${suite} report`);
    assertDigest(artifact.report_sha256, `${suite} report`);
    let reportBytes;
    try {
      reportBytes = await readFile(reportPath);
    } catch {
      throw new Error(`${suite} report hash mismatch.`);
    }
    if (sha256(reportBytes) !== artifact.report_sha256) throw new Error(`${suite} report hash mismatch.`);
    let report;
    try {
      report = JSON.parse(reportBytes.toString("utf8"));
    } catch {
      throw new Error(`${suite} report is invalid JSON.`);
    }
    const traces = artifact.traces ?? {};
    if (!traces || typeof traces !== "object" || Array.isArray(traces)) {
      throw new Error(`${suite} trace manifest is invalid.`);
    }
    const verifiedTraces = new Map();
    for (const [traceReference, expectedHash] of Object.entries(traces)) {
      const tracePath = path.resolve(runDir, traceReference);
      await assertPhysicalFileInside(runDir, tracePath, `${suite} trace`);
      assertDigest(expectedHash, `${suite} trace`);
      let traceBytes;
      try {
        traceBytes = await readFile(tracePath);
      } catch {
        throw new Error(`${suite} trace hash mismatch.`);
      }
      if (sha256(traceBytes) !== expectedHash) throw new Error(`${suite} trace hash mismatch.`);
      let trace;
      try {
        trace = JSON.parse(traceBytes.toString("utf8"));
      } catch {
        throw new Error(`${suite} trace is invalid JSON.`);
      }
      verifiedTraces.set(tracePath, trace);
    }
    const resultTraces = (report.results ?? []).map((result) => takeVerifiedResultTrace({
      result,
      reportPath,
      runDir,
      verifiedTraces,
      label: `${suite} report result ${result?.id ?? "unknown"}`,
    }));
    if (verifiedTraces.size > 0) throw new Error(`${suite} trace manifest does not match its report results.`);

    const evidence = canonicalSuiteOpenAiEvidence(report, resultTraces, `${suite} report`, {
      requireSuccess: true,
    });
    const artifactTransport = requiredOpenAiTransportStats(
      artifact.openai_transport,
      `${suite} artifact OpenAI transport`,
    );
    if (!sameOpenAiTransportStats(artifactTransport, evidence.total)) {
      throw new Error(`${suite} artifact OpenAI transport does not match its report.`);
    }
    verifiedBySuite[suite] = evidence.total;
    expectedWarnings.push(...recoveredRetryWarnings(suite, evidence));
  }
  assertManifestOpenAiTransport(manifest.openai_transport, verifiedBySuite);
  assertRecoveredRetryWarnings(manifest.promotion?.warnings, expectedWarnings);
}

function canonicalSuiteOpenAiEvidence(report, traces, label, { requireSuccess }) {
  const results = Array.isArray(report?.results) ? report.results : [];
  if (!Array.isArray(traces) || traces.length !== results.length) {
    throw new Error(`${label} trace set does not match its results.`);
  }
  const legacyTransportAllowed = !hasRetryCapableEvidence(report)
    && !suiteHasOpenAiTransportFields(report, traces);
  const normalizedResults = results.map((result, index) => {
    return canonicalResultOpenAiEvidence(
      result,
      traces[index],
      `${label} result ${result?.id ?? index}`,
      legacyTransportAllowed,
      requireSuccess,
    );
  });
  const expected = {
    query_generation: mergeOpenAiTransportStats(...normalizedResults.map((item) => item.queryGeneration)),
    relation_judge: mergeOpenAiTransportStats(...normalizedResults.map((item) => item.relationJudge)),
    total: mergeOpenAiTransportStats(...normalizedResults.map((item) => item.total)),
  };
  const diagnosticInput = report?.diagnostics?.openai_transport;
  const diagnosticSnapshots = {
    query_generation: transportSnapshot(diagnosticInput?.query_generation, `${label} diagnostics query_generation`),
    relation_judge: transportSnapshot(diagnosticInput?.relation_judge, `${label} diagnostics relation_judge`),
    total: transportSnapshot(diagnosticInput?.total, `${label} diagnostics total`),
  };
  const diagnosticsPresent = Object.values(diagnosticSnapshots).some((snapshot) => snapshot.present);
  const resultTelemetryPresent = normalizedResults.some((result) => result.telemetryPresent);
  if (diagnosticsPresent !== resultTelemetryPresent) {
    throw new Error(`${label} diagnostics OpenAI transport presence does not match its results.`);
  }
  if (diagnosticsPresent && Object.values(diagnosticSnapshots).some((snapshot) => !snapshot.present)) {
    throw new Error(`${label} diagnostics OpenAI transport telemetry is incomplete.`);
  }
  const diagnostics = diagnosticsPresent
    ? Object.fromEntries(Object.entries(diagnosticSnapshots).map(([stage, snapshot]) => [stage, snapshot.stats]))
    : expected;
  for (const stage of ["query_generation", "relation_judge", "total"]) {
    if (!sameOpenAiTransportStats(diagnostics[stage], expected[stage])) {
      throw new Error(`${label} OpenAI transport ${stage} does not match merged results.`);
    }
  }
  return { ...diagnostics, results: normalizedResults };
}

function canonicalResultOpenAiEvidence(result, trace, label, legacyTransportAllowed, requireSuccess) {
  if (trace?.schema !== "PipelineTrace" || trace.version !== 2 || trace.profile !== "product-parity") {
    throw new Error(`${label} trace is incompatible.`);
  }
  const resultId = String(result?.id ?? "").trim();
  const traceId = String(trace?.case?.id ?? "").trim();
  if (!resultId || !traceId || traceId !== resultId) {
    throw new Error(`${label} trace case id does not match its report result.`);
  }
  const resultStatus = String(result?.runtime_status ?? "").trim();
  const traceStatus = String(trace?.status ?? "").trim();
  if (!resultStatus || !traceStatus || traceStatus !== resultStatus) {
    throw new Error(`${label} trace status does not match its report result.`);
  }
  if (requireSuccess && traceStatus !== "success") {
    throw new Error(`${label} eligible evidence requires successful trace and runtime status.`);
  }
  const reportSnapshots = {
    query_generation: transportSnapshot(result?.openai_transport?.query_generation, `${label} query_generation`),
    relation_judge: transportSnapshot(result?.openai_transport?.relation_judge, `${label} relation_judge`),
    total: transportSnapshot(result?.openai_transport?.total, `${label} total`),
  };
  const traceSnapshots = {
    query_generation: transportSnapshot(
      trace?.steps?.query_generation,
      `${label} trace query_generation`,
      { embedded: true },
    ),
    relation_judge: transportSnapshot(
      trace?.steps?.relation_judge,
      `${label} trace relation_judge`,
      { embedded: true },
    ),
  };
  const reportPresent = Object.values(reportSnapshots).some((snapshot) => snapshot.present);
  const tracePresent = Object.values(traceSnapshots).some((snapshot) => snapshot.present);
  if (!reportPresent && !tracePresent) {
    if (!legacyTransportAllowed) {
      throw new Error(`${label} OpenAI transport telemetry is missing for retry-capable evidence.`);
    }
    const queryGeneration = emptyOpenAiTransportStats();
    const relationJudge = emptyOpenAiTransportStats();
    return {
      runtimeStatus: resultStatus,
      queryGeneration,
      relationJudge,
      total: mergeOpenAiTransportStats(queryGeneration, relationJudge),
      telemetryPresent: false,
    };
  }
  if (reportPresent !== tracePresent) {
    throw new Error(`${label} OpenAI transport telemetry presence does not match its trace.`);
  }
  if (
    Object.values(reportSnapshots).some((snapshot) => !snapshot.present)
    || Object.values(traceSnapshots).some((snapshot) => !snapshot.present)
  ) {
    throw new Error(`${label} OpenAI transport telemetry is incomplete.`);
  }
  for (const stage of ["query_generation", "relation_judge"]) {
    if (!sameOpenAiTransportStats(reportSnapshots[stage].stats, traceSnapshots[stage].stats)) {
      throw new Error(`${label} OpenAI transport ${stage} does not match its trace.`);
    }
  }
  const traceTotal = mergeOpenAiTransportStats(
    traceSnapshots.query_generation.stats,
    traceSnapshots.relation_judge.stats,
  );
  if (!sameOpenAiTransportStats(reportSnapshots.total.stats, traceTotal)) {
    throw new Error(`${label} OpenAI transport total does not match its trace stages.`);
  }
  return {
    runtimeStatus: resultStatus,
    queryGeneration: traceSnapshots.query_generation.stats,
    relationJudge: traceSnapshots.relation_judge.stats,
    total: traceTotal,
    telemetryPresent: true,
  };
}

function takeVerifiedResultTrace({ result, reportPath, runDir, verifiedTraces, label }) {
  const reference = String(result?.trace_json ?? "").trim();
  if (!reference) throw new Error(`${label} trace is missing from the trace manifest.`);
  const candidates = path.isAbsolute(reference)
    ? [path.resolve(reference)]
    : [path.resolve(path.dirname(reportPath), reference), path.resolve(runDir, reference)];
  const tracePath = candidates.find((candidate) => verifiedTraces.has(candidate));
  if (!tracePath) throw new Error(`${label} trace is missing from the trace manifest.`);
  const trace = verifiedTraces.get(tracePath);
  verifiedTraces.delete(tracePath);
  return trace;
}

function transportSnapshot(value, label, options = {}) {
  const isObject = value !== null && typeof value === "object" && !Array.isArray(value);
  const presentFields = isObject
    ? OPENAI_TRANSPORT_FIELDS.filter((field) => Object.hasOwn(value, field))
    : [];
  if (presentFields.length === 0) {
    if (value !== undefined && !(options.embedded && isObject)) {
      throw new Error(`${label} telemetry is incomplete.`);
    }
    return { present: false, stats: null };
  }
  if (!isObject || presentFields.length !== OPENAI_TRANSPORT_FIELDS.length) {
    throw new Error(`${label} telemetry is incomplete.`);
  }
  return { present: true, stats: normalizeOpenAiTransportStats(value) };
}

function requiredOpenAiTransportStats(value, label) {
  const snapshot = transportSnapshot(value, label);
  if (!snapshot.present) throw new Error(`${label} telemetry is missing.`);
  return snapshot.stats;
}

function hasRetryCapableEvidence(report) {
  const metadata = report?.metadata ?? {};
  const providers = [
    metadata.llm_provider,
    metadata.query_agent_provider,
    metadata.relation_judge_agent_provider,
    metadata.runtime_configuration?.llm_provider,
    metadata.effective_configuration?.llm_provider,
  ];
  return providers.some((provider) => String(provider ?? "").trim().toLowerCase() === "openai");
}

function suiteHasOpenAiTransportFields(report, traces) {
  const values = [];
  for (const result of report?.results ?? []) {
    values.push(
      result?.openai_transport?.query_generation,
      result?.openai_transport?.relation_judge,
      result?.openai_transport?.total,
    );
  }
  for (const trace of traces) {
    values.push(trace?.steps?.query_generation, trace?.steps?.relation_judge);
  }
  values.push(
    report?.diagnostics?.openai_transport?.query_generation,
    report?.diagnostics?.openai_transport?.relation_judge,
    report?.diagnostics?.openai_transport?.total,
  );
  return values.some((value) => value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && OPENAI_TRANSPORT_FIELDS.some((field) => Object.hasOwn(value, field)));
}

function recoveredRetryWarnings(suite, evidence) {
  const recoveredRetries = evidence.results
    .filter((result) => result.runtimeStatus === "success")
    .reduce((count, result) => count + result.total.retry_count, 0);
  return recoveredRetries > 0
    ? [`${RECOVERED_RETRY_WARNING_PREFIX}${suite}:${recoveredRetries}`]
    : [];
}

function assertRecoveredRetryWarnings(actualWarnings, expectedWarnings) {
  const actual = (Array.isArray(actualWarnings) ? actualWarnings : [])
    .filter((warning) => String(warning).startsWith(RECOVERED_RETRY_WARNING_PREFIX))
    .sort();
  const expected = [...expectedWarnings].sort();
  if (actual.length !== expected.length || actual.some((warning, index) => warning !== expected[index])) {
    throw new Error("Benchmark promotion warnings do not match recovered OpenAI retries.");
  }
}

function assertManifestOpenAiTransport(value, verifiedBySuite) {
  const bySuite = value?.by_suite;
  if (!bySuite || typeof bySuite !== "object" || Array.isArray(bySuite)) {
    throw new Error("Manifest top-level OpenAI transport does not match suite artifacts.");
  }
  const expectedSuites = Object.keys(verifiedBySuite).sort();
  const actualSuites = Object.keys(bySuite).sort();
  if (
    expectedSuites.length !== actualSuites.length
    || expectedSuites.some((suite, index) => suite !== actualSuites[index])
  ) {
    throw new Error("Manifest top-level OpenAI transport does not match suite artifacts.");
  }
  for (const suite of expectedSuites) {
    if (!sameOpenAiTransportStats(
      requiredOpenAiTransportStats(bySuite[suite], `Manifest ${suite} OpenAI transport`),
      verifiedBySuite[suite],
    )) {
      throw new Error("Manifest top-level OpenAI transport does not match suite artifacts.");
    }
  }
  const expectedTotal = mergeOpenAiTransportStats(...Object.values(verifiedBySuite));
  if (!sameOpenAiTransportStats(
    requiredOpenAiTransportStats(value?.total, "Manifest total OpenAI transport"),
    expectedTotal,
  )) {
    throw new Error("Manifest top-level OpenAI transport does not match suite artifacts.");
  }
}

function sameOpenAiTransportStats(left, right) {
  const normalizedLeft = normalizeOpenAiTransportStats(left);
  const normalizedRight = normalizeOpenAiTransportStats(right);
  if (
    normalizedLeft.request_count !== normalizedRight.request_count
    || normalizedLeft.attempt_count !== normalizedRight.attempt_count
    || normalizedLeft.retry_count !== normalizedRight.retry_count
  ) {
    return false;
  }
  const categories = new Set([
    ...Object.keys(normalizedLeft.retry_categories),
    ...Object.keys(normalizedRight.retry_categories),
  ]);
  return [...categories].every((category) => (
    (normalizedLeft.retry_categories[category] ?? 0)
    === (normalizedRight.retry_categories[category] ?? 0)
  ));
}

function assertDigest(value, label) {
  if (!/^[a-f0-9]{64}$/i.test(String(value ?? ""))) throw new Error(`${label} digest is invalid.`);
}

function cloneObject(value) {
  return value && typeof value === "object" ? structuredClone(value) : {};
}

function safeHoldoutSnapshot(value) {
  if (!value || typeof value !== "object") return null;
  return {
    version: value.version ?? null,
    frozen: value.frozen === true,
    change_reason: value.change_reason ?? null,
    fingerprint: value.fingerprint ?? null,
  };
}

function safeRuntimeConfiguration(value) {
  if (!value || typeof value !== "object") return null;
  return {
    source: value.source ?? null,
    settings_id: value.settings_id ?? null,
  };
}

function assertInside(root, candidate, label) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`${label} escapes benchmark reports root.`);
}

async function assertPhysicalFileInside(root, candidate, label) {
  assertInside(root, candidate, label);
  let fileStat;
  let physicalRoot;
  let physicalCandidate;
  try {
    [fileStat, physicalRoot, physicalCandidate] = await Promise.all([
      lstat(candidate),
      realpath(root),
      realpath(candidate),
    ]);
  } catch {
    throw new Error(`${label} is missing or cannot be resolved.`);
  }
  if (fileStat.isSymbolicLink()) throw new Error(`${label} must not be a symlink.`);
  const relative = path.relative(physicalRoot, physicalCandidate);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${label} physically escapes benchmark reports root.`);
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function slash(value) {
  return String(value).replace(/\\/g, "/");
}

function reasonOrder(left, right) {
  const order = [
    "workflow_not_baseline",
    "profile_not_product_parity",
    "dirty_worktree_start",
    "dirty_worktree_end",
    "git_head_changed",
    "cases_changed",
    "suite_validation_not_ready",
    "identity_validation_not_ready",
    "missing_holdout_snapshot",
    "holdout_not_frozen",
    "holdout_version_not_changed",
    "missing_holdout_change_reason",
    "missing_active_suite:development",
    "missing_active_suite:holdout",
  ];
  const leftIndex = order.indexOf(left);
  const rightIndex = order.indexOf(right);
  if (leftIndex >= 0 || rightIndex >= 0) return (leftIndex < 0 ? order.length : leftIndex) - (rightIndex < 0 ? order.length : rightIndex);
  return left.localeCompare(right);
}

function defaultSpawn(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with ${result.status}`);
  return String(result.stdout ?? "");
}
