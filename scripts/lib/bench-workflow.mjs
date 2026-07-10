import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const WORKFLOW_SCHEMA = "AhaBenchmarkWorkflowRun";
const POINTER_SCHEMA = "AhaBenchmarkLatestPointer";

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

export function buildWorkflowProvenance(input) {
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
    artifacts: safeArtifacts(input.artifacts),
    promotion: {
      eligible: input.promotion?.eligible === true,
      reasons: [...(input.promotion?.reasons ?? [])],
    },
  };
}

export function evaluateBaselinePromotion(input) {
  const reasons = [];
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
    inspectSuiteArtifact({ suite, expectedIds, input, reasons });
  }
  return { eligible: reasons.length === 0, reasons: Array.from(new Set(reasons)).sort(reasonOrder) };
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

function inspectSuiteArtifact({ suite, expectedIds, input, reasons }) {
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

  const results = report.results ?? [];
  const actualIds = results.map((result) => result.id).sort();
  const wantedIds = [...expectedIds].sort();
  if (actualIds.length !== wantedIds.length || actualIds.some((id, index) => id !== wantedIds[index])) {
    reasons.push(`incomplete_case_set:${suite}`);
  }
  for (const result of results) inspectTrace({ suite, result, reportPath: artifact.reportPath, repoRoot: input.repoRoot, reasons });
}

function inspectTrace({ suite, result, reportPath, repoRoot, reasons }) {
  if (result.evaluation_status !== "scored") {
    reasons.push(`case_not_scored:${suite}:${result.id}`);
  }
  if (result.runtime_status !== "success") {
    reasons.push(`runtime_not_success:${suite}:${result.id}`);
  }
  const tracePath = resolveTracePath(result.trace_json, reportPath, repoRoot);
  if (!tracePath) {
    reasons.push(`trace_missing:${suite}:${result.id}`);
    return;
  }
  let trace;
  try {
    trace = JSON.parse(readFileSync(tracePath, "utf8"));
  } catch {
    reasons.push(`trace_invalid:${suite}:${result.id}`);
    return;
  }
  if (trace.schema !== "PipelineTrace" || trace.version !== 2 || trace.profile !== "product-parity") {
    reasons.push(`trace_incompatible:${suite}:${result.id}`);
  } else if (trace.status !== "success") {
    reasons.push(`trace_not_success:${suite}:${result.id}`);
  }
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
  const manifest = JSON.parse(await readFile(input.manifestPath, "utf8"));
  if (manifest.promotion?.eligible !== true) throw new Error("Cannot promote an ineligible benchmark manifest.");
  const pointerRoot = path.dirname(path.dirname(path.resolve(input.pointerPath)));
  const resolvedManifest = path.resolve(input.manifestPath);
  assertInside(pointerRoot, resolvedManifest, "manifest");
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
  assertInside(reportsRoot, manifestPath, "manifest");
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
    }];
  }));
}

async function verifyManifestArtifacts(manifest, manifestPath) {
  const runDir = path.dirname(path.resolve(manifestPath));
  for (const [suite, artifact] of Object.entries(manifest.artifacts ?? {})) {
    const reportPath = path.resolve(runDir, artifact.report ?? "");
    assertInside(runDir, reportPath, `${suite} report`);
    assertDigest(artifact.report_sha256, `${suite} report`);
    if (!existsSync(reportPath) || await sha256File(reportPath) !== artifact.report_sha256) {
      throw new Error(`${suite} report hash mismatch.`);
    }
    const traces = artifact.traces ?? {};
    if (!traces || typeof traces !== "object" || Array.isArray(traces)) {
      throw new Error(`${suite} trace manifest is invalid.`);
    }
    for (const [traceReference, expectedHash] of Object.entries(traces)) {
      const tracePath = path.resolve(runDir, traceReference);
      assertInside(runDir, tracePath, `${suite} trace`);
      assertDigest(expectedHash, `${suite} trace`);
      if (!existsSync(tracePath) || await sha256File(tracePath) !== expectedHash) {
        throw new Error(`${suite} trace hash mismatch.`);
      }
    }
  }
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

function assertInside(root, candidate, label) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`${label} escapes benchmark reports root.`);
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
