import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { expandHome, normalizeFailureAttribution } from "./bench-scoring.mjs";
import { benchVaultRoot } from "./vault-paths.mjs";
import { normalizeLineRange, parseLineRange, sliceLineRange } from "./note-excerpt.mjs";
import {
  buildVaultPathResolver,
  normalizeNoteIdentity,
  resolveVaultPath,
} from "../aha/lib/note-identity.mjs";

export const BENCHMARK_SUITES = ["development", "holdout"];
export const BENCHMARK_EVALUATION_MODES = ["discovery", "graph_assisted"];
export const BENCHMARK_GRAPH_EVIDENCE_KINDS = ["source_link", "backlink", "obsidian_graph"];

export {
  compactLine,
  defaultQueryGenerationOptions,
  normalizeLex,
  qmdQueryForCase,
  resolveQmdQueriesForCase,
  qmdQueryFromObject,
  resolveQmdQueryForCase,
  splitLexCandidates,
  unique,
} from "../aha/query-plan.mjs";

export {
  applyBenchEvaluationPolicy,
  droppedMustFromExpandedPool,
  expandHome,
  FAILURE_ATTRIBUTION_GROUPS,
  filterSourceNoteFromResults,
  normalizeFailureAttribution,
  normalizePathForScore,
  pathsMatch,
  qmdExpectedPath,
  scoreEvalV2,
  scoreNiceToHave,
  scoreResults,
  sourceNotePathForCase,
  summarizePipelineEvaluation,
} from "./bench-scoring.mjs";

function sliceSourceNote(content, caseItem) {
  if (!caseItem.source_note_start_line && !caseItem.source_note_end_line && !caseItem.allow_full_note) {
    throw new Error("source note benchmark input requires input.lines/source_note_*_line, or explicit input.whole_note: true.");
  }
  return sliceLineRange(content, {
    start: caseItem.source_note_start_line,
    end: caseItem.source_note_end_line,
  });
}

export function readSourceNote(sourceNotePath, casesDir, caseId, caseItem = {}) {
  const rawPath = expandHome(String(sourceNotePath ?? "").trim());
  if (!rawPath) return "";
  const vaultRoot = benchVaultRoot();
  const candidates = isAbsolute(rawPath)
    ? [rawPath]
    : [
        resolve(casesDir, rawPath),
        resolve(vaultRoot, rawPath),
      ];

  const errors = [];
  for (const candidate of candidates) {
    try {
      return sliceSourceNote(readFileSync(candidate, "utf-8"), caseItem);
    } catch (error) {
      errors.push(`${candidate}: ${error.message}`);
    }
  }
  throw new Error(`${caseId}: could not read source_note_path. Tried:\n${errors.join("\n")}`);
}

export function insightInputForCase(caseItem, casesDir) {
  if (!caseItem.source_note_path && typeof caseItem.insight_input === "string" && caseItem.insight_input.trim()) {
    return caseItem.insight_input.trim();
  }

  const caseId = caseItem.id || "(missing id)";
  const sourceNotePath = String(caseItem.source_note_path ?? "").trim();
  if (!sourceNotePath) return String(caseItem.insight_thought ?? "").trim();
  if (!caseItem.allow_full_note && (!caseItem.source_note_start_line || !caseItem.source_note_end_line)) {
    throw new Error(`${caseId}: note-based benchmark inputs require input.lines or explicit input.whole_note: true.`);
  }

  const sourceNote = readSourceNote(sourceNotePath, casesDir, caseId, caseItem);
  const thought = String(caseItem.insight_thought ?? "").trim();
  return [
    "Source note:",
    sourceNote.trim(),
    thought ? ["", "Fresh thought:", thought].join("\n") : "",
  ].filter(Boolean).join("\n");
}

function normalizeCaseState(caseItem) {
  const rawState = String(caseItem.state ?? caseItem.status ?? "active").trim().toLowerCase();
  if (rawState === "active") return "active";
  if (rawState === "draft") return "draft";
  if (rawState === "off" || rawState === "disabled" || rawState === "holdout") return "off";
  throw new Error(`${caseItem.id || "(missing id)"}: state must be active, draft, or off.`);
}

function normalizeLines(input, caseItem) {
  const value = input.lines;
  if (Array.isArray(value) || (typeof value === "string" && value.trim())) {
    const range = Array.isArray(value) ? normalizeLineRange(value[0], value[1]) : parseLineRange(value);
    return [range.start, range.end];
  }
  const hasLegacyStart = caseItem.source_note_start_line !== undefined && caseItem.source_note_start_line !== null && caseItem.source_note_start_line !== "";
  const hasLegacyEnd = caseItem.source_note_end_line !== undefined && caseItem.source_note_end_line !== null && caseItem.source_note_end_line !== "";
  if (hasLegacyStart || hasLegacyEnd) {
    const range = normalizeLineRange(caseItem.source_note_start_line, caseItem.source_note_end_line);
    return [range.start, range.end];
  }
  return undefined;
}

function normalizeStringArray(value, label, caseId) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error(`${caseId}: ${label} must be an array.`);
  }
  return value;
}

function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function versionString(value) {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return nonEmptyString(value);
}

function labelSource(gold, caseItem, currentKey, legacyKey, caseId) {
  const currentProvided = Object.hasOwn(gold, currentKey);
  const legacyProvided = Object.hasOwn(caseItem, legacyKey);
  const current = currentProvided
    ? normalizeStringArray(gold[currentKey], `gold.${currentKey}`, caseId)
    : undefined;
  const legacy = legacyProvided
    ? normalizeStringArray(caseItem[legacyKey], legacyKey, caseId)
    : undefined;
  return {
    currentProvided,
    legacyProvided,
    current,
    legacy,
    selected: currentProvided ? current : legacy ?? [],
  };
}

export function normalizeBenchmarkCase(caseItem) {
  const caseId = caseItem.id || "(missing id)";
  if (caseItem.input !== undefined && !isRecord(caseItem.input)) {
    throw new Error(`${caseId}: input must be an object when present.`);
  }
  if (caseItem.gold !== undefined && !isRecord(caseItem.gold)) {
    throw new Error(`${caseId}: gold must be an object when present.`);
  }
  const input = isRecord(caseItem.input) ? caseItem.input : {};
  const gold = isRecord(caseItem.gold) ? caseItem.gold : {};
  const note = String(input.note ?? caseItem.source_note_path ?? "").trim();
  const lines = normalizeLines(input, caseItem);
  const thought = String(input.thought ?? caseItem.insight_thought ?? (!note ? caseItem.insight_input ?? "" : "")).trim();
  const wholeNote = input.whole_note === true || caseItem.allow_full_note === true;
  const state = normalizeCaseState(caseItem);
  const labelSources = {
    must: labelSource(gold, caseItem, "must", "must_recall", caseId),
    nice: labelSource(gold, caseItem, "nice", "nice_to_have", caseId),
    noise: labelSource(gold, caseItem, "noise", "negative", caseId),
  };
  const must = labelSources.must.selected;
  const nice = labelSources.nice.selected;
  const noise = labelSources.noise.selected;
  const title = String(caseItem.title ?? caseItem.description ?? caseItem.id ?? "").trim();
  const why = String(caseItem.why ?? caseItem.annotation_note ?? "").trim();
  const suite = nonEmptyString(caseItem.suite).toLowerCase() || undefined;
  const evaluationMode = nonEmptyString(caseItem.evaluation_mode).toLowerCase() || undefined;

  return {
    ...caseItem,
    state,
    title,
    why,
    input: {
      ...(note ? { note } : {}),
      ...(lines ? { lines } : {}),
      ...(wholeNote ? { whole_note: true } : {}),
      ...(thought ? { thought } : {}),
    },
    gold: {
      must,
      nice,
      noise,
    },
    source_note_path: note || undefined,
    source_note_start_line: lines?.[0],
    source_note_end_line: lines?.[1],
    allow_full_note: wholeNote,
    insight_thought: thought || undefined,
    must_recall: must,
    nice_to_have: nice,
    negative: noise,
    expected_no_recall: caseItem.expected_no_recall === true,
    suite,
    evaluation_mode: evaluationMode,
    mode_review_required: caseItem.mode_review_required === true,
    provenance: isRecord(caseItem.provenance) ? { ...caseItem.provenance } : caseItem.provenance,
    graph_evidence: caseItem.graph_evidence,
    _benchmark_label_sources: labelSources,
    _schema_version: 3,
  };
}

function emptyIdentityDiagnostics() {
  return {
    ambiguous: [],
    not_found: [],
    duplicates: [],
    schema_conflicts: [],
    label_conflicts: [],
  };
}

function identityRecord(reference, resolver) {
  const resolved = resolveVaultPath(reference, resolver);
  if (resolved.status === "resolved") {
    return {
      reference,
      status: "resolved",
      path: resolved.path,
      identity: resolved.identity ?? normalizeNoteIdentity(resolved.path),
    };
  }
  return {
    reference,
    status: resolved.status,
    matches: resolved.matches ?? [],
    identity: `${resolved.status}:${normalizeNoteIdentity(reference)}`,
  };
}

function identitySetForReferences(references, resolver) {
  return Array.from(new Set(references.map((reference) => identityRecord(reference, resolver).identity))).sort();
}

function setsEqual(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function resolveLabelReferences(label, references, resolver, diagnostics) {
  const byIdentity = new Map();
  for (const reference of references) {
    const record = identityRecord(reference, resolver);
    if (record.status === "ambiguous") {
      diagnostics.ambiguous.push({ label, reference, matches: record.matches });
      continue;
    }
    if (record.status === "not_found") {
      diagnostics.not_found.push({ label, reference });
      continue;
    }
    const existing = byIdentity.get(record.identity);
    if (existing) {
      diagnostics.duplicates.push({
        label,
        identity: record.identity,
        references: [existing.reference, reference],
      });
      continue;
    }
    byIdentity.set(record.identity, record);
  }
  return Array.from(byIdentity.values());
}

export function resolveBenchmarkCaseIdentities(caseItem, resolver = buildVaultPathResolver(benchVaultRoot())) {
  const diagnostics = emptyIdentityDiagnostics();
  const sources = caseItem._benchmark_label_sources ?? {
    must: {
      currentProvided: false,
      legacyProvided: true,
      legacy: caseItem.must_recall ?? [],
      selected: caseItem.must_recall ?? [],
    },
    nice: {
      currentProvided: false,
      legacyProvided: true,
      legacy: caseItem.nice_to_have ?? [],
      selected: caseItem.nice_to_have ?? [],
    },
    noise: {
      currentProvided: false,
      legacyProvided: true,
      legacy: caseItem.negative ?? [],
      selected: caseItem.negative ?? [],
    },
  };

  for (const label of ["must", "nice", "noise"]) {
    const source = sources[label];
    if (!source.currentProvided || !source.legacyProvided) continue;
    const currentIdentities = identitySetForReferences(source.current ?? [], resolver);
    const legacyIdentities = identitySetForReferences(source.legacy ?? [], resolver);
    if (!setsEqual(currentIdentities, legacyIdentities)) {
      diagnostics.schema_conflicts.push({
        label,
        current: source.current ?? [],
        legacy: source.legacy ?? [],
      });
    }
  }

  const records = {
    must: resolveLabelReferences("must", sources.must.selected ?? [], resolver, diagnostics),
    nice: resolveLabelReferences("nice", sources.nice.selected ?? [], resolver, diagnostics),
    noise: resolveLabelReferences("noise", sources.noise.selected ?? [], resolver, diagnostics),
  };
  const labelsByIdentity = new Map();
  for (const label of ["must", "nice", "noise"]) {
    for (const record of records[label]) {
      const labels = labelsByIdentity.get(record.identity) ?? [];
      labels.push(label);
      labelsByIdentity.set(record.identity, labels);
    }
  }
  for (const [identity, labels] of labelsByIdentity) {
    if (labels.length > 1) diagnostics.label_conflicts.push({ identity, labels });
  }

  const blocksScoring = diagnostics.ambiguous.length > 0
    || diagnostics.not_found.length > 0
    || diagnostics.duplicates.length > 0
    || diagnostics.schema_conflicts.length > 0
    || diagnostics.label_conflicts.length > 0;
  return {
    status: blocksScoring ? "not_scored" : "ready",
    gold: {
      must: records.must.map((record) => record.path),
      nice: records.nice.map((record) => record.path),
      noise: records.noise.map((record) => record.path),
    },
    diagnostics,
  };
}

function emptySuiteDiagnostics() {
  return {
    missing_suite_metadata: [],
    invalid_suite_metadata: [],
    missing_suite: [],
    invalid_suite: [],
    missing_evaluation_mode: [],
    invalid_evaluation_mode: [],
    missing_provenance: [],
    graph_evidence_conflicts: [],
    mode_review_required: [],
    identity_conflicts: [],
    duplicate_case_ids: [],
    cross_suite_leakage: [],
  };
}

function suiteDiagnosticsHaveEntries(diagnostics) {
  return Object.values(diagnostics).some((items) => items.length > 0);
}

function addSuiteDiagnostic(documentDiagnostics, caseDiagnostics, key, value) {
  documentDiagnostics[key].push(value);
  if (caseDiagnostics) caseDiagnostics[key].push(value);
}

function normalizedSuiteDefinitions(input) {
  const rawSuites = isRecord(input?.suites) ? input.suites : {};
  const definitions = {};
  for (const suite of BENCHMARK_SUITES) {
    if (!isRecord(rawSuites[suite])) continue;
    definitions[suite] = {
      ...rawSuites[suite],
      version: versionString(rawSuites[suite].version),
    };
  }
  return definitions;
}

function graphEvidenceRecords(caseItem, resolver, diagnostics, caseDiagnostics) {
  if (caseItem.graph_evidence === undefined) return [];
  if (!Array.isArray(caseItem.graph_evidence)) {
    addSuiteDiagnostic(diagnostics, caseDiagnostics, "graph_evidence_conflicts", {
      case_id: caseItem.id,
      reason: "graph_evidence_must_be_an_array",
    });
    return [];
  }

  const goldIdentities = new Set(
    [caseItem.gold?.must ?? [], caseItem.gold?.nice ?? []]
      .flat()
      .map((reference) => identityRecord(reference, resolver).identity),
  );
  const records = [];
  for (const [index, evidence] of caseItem.graph_evidence.entries()) {
    const target = isRecord(evidence) ? nonEmptyString(evidence.target ?? evidence.note_path ?? evidence.notePath) : "";
    const kind = isRecord(evidence) ? nonEmptyString(evidence.kind).toLowerCase() : "";
    if (!target || !BENCHMARK_GRAPH_EVIDENCE_KINDS.includes(kind)) {
      addSuiteDiagnostic(diagnostics, caseDiagnostics, "graph_evidence_conflicts", {
        case_id: caseItem.id,
        index,
        reason: "invalid_graph_evidence",
      });
      continue;
    }
    const identity = identityRecord(target, resolver).identity;
    if (!goldIdentities.has(identity)) {
      addSuiteDiagnostic(diagnostics, caseDiagnostics, "graph_evidence_conflicts", {
        case_id: caseItem.id,
        index,
        reason: "graph_evidence_target_is_not_gold",
        target,
      });
      continue;
    }
    records.push({ target, kind, identity });
  }
  return records;
}

function normalizedCaseForSuiteValidation(caseItem) {
  return caseItem?._schema_version === 3 ? caseItem : normalizeBenchmarkCase(caseItem);
}

function caseGoldIdentities(caseItem, resolver) {
  const normalized = normalizedCaseForSuiteValidation(caseItem);
  return Object.fromEntries(["must", "nice", "noise"].map((label) => [
    label,
    Array.from(new Set((normalized.gold?.[label] ?? []).map((reference) => identityRecord(reference, resolver).identity))).sort(),
  ]));
}

export function benchmarkCaseFingerprint(caseItem, resolver = buildVaultPathResolver(benchVaultRoot())) {
  const normalized = normalizedCaseForSuiteValidation(caseItem);
  const inputNote = nonEmptyString(normalized.input?.note);
  const graphEvidence = Array.isArray(normalized.graph_evidence)
    ? normalized.graph_evidence.map((item) => ({
        kind: nonEmptyString(item?.kind).toLowerCase(),
        target: identityRecord(item?.target ?? item?.note_path ?? item?.notePath ?? "", resolver).identity,
      })).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))
    : [];
  const relationTargets = Array.isArray(normalized.relation_targets)
    ? normalized.relation_targets.map((item) => ({
        relation: nonEmptyString(item?.relation).toLowerCase(),
        target: identityRecord(item?.note_path ?? item?.notePath ?? "", resolver).identity,
      })).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))
    : [];
  const scoringOverride = (value) => {
    if (value === undefined || value === null || value === "") return null;
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : String(value);
  };
  const payload = {
    input: {
      note: inputNote ? identityRecord(inputNote, resolver).identity : "",
      lines: normalized.input?.lines ?? null,
      whole_note: normalized.input?.whole_note === true,
      thought_hash: createHash("sha256").update(String(normalized.input?.thought ?? "")).digest("hex"),
    },
    gold: caseGoldIdentities(normalized, resolver),
    evaluation_mode: normalized.evaluation_mode ?? null,
    graph_evidence: graphEvidence,
    relation_targets: relationTargets,
    expected_no_recall: normalized.expected_no_recall === true,
    scoring_contract: {
      expected_in_top_k: scoringOverride(normalized.expected_in_top_k),
      nice_expected_in_top_k: scoringOverride(normalized.nice_expected_in_top_k),
      expanded_pool_expected_in_top_k: scoringOverride(normalized.expanded_pool_expected_in_top_k),
    },
  };
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function strictSuiteError(validation) {
  const codes = Object.entries(validation.diagnostics)
    .filter(([, entries]) => entries.length > 0)
    .map(([code]) => code)
    .join(", ");
  return new Error(`Benchmark suite validation failed: ${codes || "unknown suite error"}.`);
}

export function validateBenchmarkSuiteDocument(input, caseItems = input?.cases ?? [], options = {}) {
  const resolver = options.resolver ?? buildVaultPathResolver(benchVaultRoot());
  const diagnostics = emptySuiteDiagnostics();
  const definitions = normalizedSuiteDefinitions(input);
  const validationCases = options.allStates === true || options.strict === true
    ? input?.cases ?? caseItems
    : caseItems;
  const normalizedCases = (validationCases ?? []).map(normalizedCaseForSuiteValidation);
  const caseEvaluations = [];
  const evaluationByCase = new Map();

  if (!isRecord(input?.suites)) {
    diagnostics.missing_suite_metadata.push({ reason: "suites_object_missing" });
  }

  for (const caseItem of normalizedCases) {
    const caseDiagnostics = emptySuiteDiagnostics();
    const id = nonEmptyString(caseItem.id) || "(missing id)";
    const suite = nonEmptyString(caseItem.suite).toLowerCase();
    const evaluationMode = nonEmptyString(caseItem.evaluation_mode).toLowerCase();

    if (!suite) {
      addSuiteDiagnostic(diagnostics, caseDiagnostics, "missing_suite", id);
    } else if (!BENCHMARK_SUITES.includes(suite)) {
      addSuiteDiagnostic(diagnostics, caseDiagnostics, "invalid_suite", { case_id: id, value: suite });
    }

    let suiteVersion = null;
    if (BENCHMARK_SUITES.includes(suite)) {
      const definition = definitions[suite];
      suiteVersion = definition?.version || null;
      if (!definition || !suiteVersion) {
        addSuiteDiagnostic(diagnostics, caseDiagnostics, "missing_suite_metadata", { case_id: id, suite });
      } else if (suite === "holdout" && definition.frozen !== true) {
        addSuiteDiagnostic(diagnostics, caseDiagnostics, "invalid_suite_metadata", {
          case_id: id,
          suite,
          reason: "holdout_must_be_frozen",
        });
      }
    }

    if (!evaluationMode) {
      addSuiteDiagnostic(diagnostics, caseDiagnostics, "missing_evaluation_mode", id);
    } else if (!BENCHMARK_EVALUATION_MODES.includes(evaluationMode)) {
      addSuiteDiagnostic(diagnostics, caseDiagnostics, "invalid_evaluation_mode", { case_id: id, value: evaluationMode });
    }

    const provenance = caseItem.provenance;
    if (!isRecord(provenance) || !nonEmptyString(provenance.origin) || !nonEmptyString(provenance.reason)) {
      addSuiteDiagnostic(diagnostics, caseDiagnostics, "missing_provenance", id);
    }

    const graphEvidence = graphEvidenceRecords(caseItem, resolver, diagnostics, caseDiagnostics);
    if (evaluationMode === "discovery" && graphEvidence.length > 0) {
      addSuiteDiagnostic(diagnostics, caseDiagnostics, "graph_evidence_conflicts", {
        case_id: id,
        reason: "discovery_case_has_graph_evidence",
      });
    }
    if (evaluationMode === "graph_assisted" && graphEvidence.length === 0) {
      addSuiteDiagnostic(diagnostics, caseDiagnostics, "graph_evidence_conflicts", {
        case_id: id,
        reason: "graph_assisted_case_requires_graph_evidence",
      });
    }
    const relationTargets = Array.isArray(caseItem.relation_targets) ? caseItem.relation_targets : [];
    if (relationTargets.length > 0 && evaluationMode !== "graph_assisted") {
      addSuiteDiagnostic(diagnostics, caseDiagnostics, "graph_evidence_conflicts", {
        case_id: id,
        reason: "relation_targets_require_graph_assisted",
      });
    }
    if (relationTargets.length > 0 && evaluationMode === "graph_assisted") {
      const evidencedIdentities = new Set(graphEvidence.map((record) => record.identity));
      for (const target of relationTargets) {
        const targetPath = nonEmptyString(target?.note_path ?? target?.notePath);
        if (!targetPath) continue;
        if (!evidencedIdentities.has(identityRecord(targetPath, resolver).identity)) {
          addSuiteDiagnostic(diagnostics, caseDiagnostics, "graph_evidence_conflicts", {
            case_id: id,
            reason: "relation_target_missing_graph_evidence",
            target: targetPath,
          });
        }
      }
    }
    if (caseItem.mode_review_required === true) {
      addSuiteDiagnostic(diagnostics, caseDiagnostics, "mode_review_required", { case_id: id });
    }

    const identityEvaluation = caseItem.identity_evaluation ?? resolveBenchmarkCaseIdentities(caseItem, resolver);
    if (identityEvaluation.status !== "ready") {
      addSuiteDiagnostic(diagnostics, caseDiagnostics, "identity_conflicts", {
        case_id: id,
        diagnostics: identityEvaluation.diagnostics,
      });
    }

    const evaluation = {
      id,
      status: suiteDiagnosticsHaveEntries(caseDiagnostics) ? "not_scored" : "ready",
      suite: suite || null,
      suite_version: suiteVersion,
      evaluation_mode: evaluationMode || null,
      diagnostics: caseDiagnostics,
    };
    caseItem._suite_version = suiteVersion;
    caseItem.suite_evaluation = evaluation;
    caseEvaluations.push(evaluation);
    evaluationByCase.set(caseItem, evaluation);
  }

  const byId = new Map();
  for (const caseItem of normalizedCases) {
    const id = nonEmptyString(caseItem.id) || "(missing id)";
    const items = byId.get(id) ?? [];
    items.push(caseItem);
    byId.set(id, items);
  }
  for (const [id, items] of byId) {
    const suites = Array.from(new Set(items.map((item) => item.suite).filter((suite) => BENCHMARK_SUITES.includes(suite))));
    if (items.length < 2) continue;
    const value = { case_id: id, suites: suites.sort() };
    diagnostics.duplicate_case_ids.push(value);
    for (const item of items) evaluationByCase.get(item)?.diagnostics.duplicate_case_ids.push(value);
  }

  const byFingerprint = new Map();
  for (const caseItem of normalizedCases) {
    if (!BENCHMARK_SUITES.includes(caseItem.suite)) continue;
    const fingerprint = benchmarkCaseFingerprint(caseItem, resolver);
    const items = byFingerprint.get(fingerprint) ?? [];
    items.push(caseItem);
    byFingerprint.set(fingerprint, items);
  }
  for (const [fingerprint, items] of byFingerprint) {
    const suites = Array.from(new Set(items.map((item) => item.suite)));
    if (suites.length < 2) continue;
    const value = {
      fingerprint,
      case_ids: items.map((item) => item.id).sort(),
      suites: suites.sort(),
    };
    diagnostics.cross_suite_leakage.push(value);
    for (const item of items) evaluationByCase.get(item)?.diagnostics.cross_suite_leakage.push(value);
  }

  for (const evaluation of caseEvaluations) {
    if (suiteDiagnosticsHaveEntries(evaluation.diagnostics)) evaluation.status = "not_scored";
  }
  const validation = {
    status: suiteDiagnosticsHaveEntries(diagnostics) ? "not_scored" : "ready",
    suite_versions: Object.fromEntries(
      Object.entries(definitions).filter(([, definition]) => definition.version).map(([suite, definition]) => [suite, definition.version]),
    ),
    diagnostics,
    case_evaluations: caseEvaluations,
  };
  if (options.strict && validation.status !== "ready") throw strictSuiteError(validation);
  return validation;
}

function emptyHoldoutTransitionDiagnostics() {
  return {
    missing_holdout_metadata: [],
    holdout_not_frozen: [],
    holdout_version_not_changed: [],
    missing_change_reason: [],
  };
}

function holdoutFingerprint(document, resolver) {
  const cases = (document?.cases ?? [])
    .map(normalizedCaseForSuiteValidation)
    .filter((caseItem) => caseItem.suite === "holdout")
    .map((caseItem) => ({
      id: caseItem.id,
      state: caseItem.state,
      fingerprint: benchmarkCaseFingerprint(caseItem, resolver),
    }))
    .sort((left, right) => String(left.id).localeCompare(String(right.id)));
  return createHash("sha256").update(JSON.stringify(cases)).digest("hex");
}

export function benchmarkHoldoutSnapshot(document, resolver = buildVaultPathResolver(benchVaultRoot())) {
  const definition = normalizedSuiteDefinitions(document).holdout;
  return {
    version: definition?.version || null,
    frozen: definition?.frozen === true,
    change_reason: nonEmptyString(definition?.change_reason) || null,
    fingerprint: holdoutFingerprint(document, resolver),
  };
}

export function validateHoldoutTransition(previous, current, options = {}) {
  const resolver = options.resolver ?? buildVaultPathResolver(benchVaultRoot());
  const diagnostics = emptyHoldoutTransitionDiagnostics();
  const previousDefinition = normalizedSuiteDefinitions(previous).holdout;
  const currentDefinition = normalizedSuiteDefinitions(current).holdout;
  const previousFingerprint = holdoutFingerprint(previous, resolver);
  const currentFingerprint = holdoutFingerprint(current, resolver);
  const changed = previousFingerprint !== currentFingerprint;

  if (!previousDefinition || !currentDefinition || !previousDefinition.version || !currentDefinition.version) {
    diagnostics.missing_holdout_metadata.push({
      previous_version: previousDefinition?.version || null,
      current_version: currentDefinition?.version || null,
    });
  }
  if (currentDefinition && currentDefinition.frozen !== true) {
    diagnostics.holdout_not_frozen.push({ version: currentDefinition.version || null });
  }
  if (changed && previousDefinition?.version === currentDefinition?.version) {
    diagnostics.holdout_version_not_changed.push({
      previous_version: previousDefinition?.version || null,
      current_version: currentDefinition?.version || null,
    });
  }
  if (changed && previousDefinition?.version !== currentDefinition?.version && !nonEmptyString(currentDefinition?.change_reason)) {
    diagnostics.missing_change_reason.push({ version: currentDefinition?.version || null });
  }

  const invalid = Object.values(diagnostics).some((items) => items.length > 0);
  const result = {
    status: invalid ? "invalid" : changed ? "versioned_change" : "unchanged",
    changed,
    previous_version: previousDefinition?.version || null,
    current_version: currentDefinition?.version || null,
    previous_fingerprint: previousFingerprint,
    current_fingerprint: currentFingerprint,
    diagnostics,
  };
  if (options.strict && invalid) {
    const codes = Object.entries(diagnostics).filter(([, entries]) => entries.length > 0).map(([code]) => code).join(", ");
    throw new Error(`Holdout transition validation failed: ${codes}.`);
  }
  return result;
}

function emptyPublicFixtureDiagnostics() {
  return {
    missing_privacy_declaration: [],
    non_synthetic_provenance: [],
    private_paths: [],
    forbidden_content_fields: [],
  };
}

function publicFixturePaths(caseItem, caseIndex) {
  const casePath = `cases[${caseIndex}]`;
  return [
    { field: `${casePath}.input.note`, value: caseItem.input?.note },
    ...(caseItem.gold?.must ?? []).map((value, index) => ({ field: `${casePath}.gold.must[${index}]`, value })),
    ...(caseItem.gold?.nice ?? []).map((value, index) => ({ field: `${casePath}.gold.nice[${index}]`, value })),
    ...(caseItem.gold?.noise ?? []).map((value, index) => ({ field: `${casePath}.gold.noise[${index}]`, value })),
    ...(caseItem.relation_targets ?? []).map((item, index) => ({
      field: `${casePath}.relation_targets[${index}].note_path`,
      value: item?.note_path ?? item?.notePath,
    })),
    ...(caseItem.graph_evidence ?? []).map((item, index) => ({
      field: `${casePath}.graph_evidence[${index}].target`,
      value: item?.target ?? item?.note_path ?? item?.notePath,
    })),
  ].filter((item) => typeof item.value === "string" && item.value.trim());
}

function collectStringFields(value, path = "", output = []) {
  if (typeof value === "string") {
    output.push({ field: path, value });
    return output;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectStringFields(item, `${path}[${index}]`, output));
    return output;
  }
  if (!isRecord(value)) return output;
  for (const [key, item] of Object.entries(value)) {
    collectStringFields(item, path ? `${path}.${key}` : key, output);
  }
  return output;
}

function containsPrivateAbsolutePath(value) {
  const text = String(value ?? "").replace(/\\/g, "/");
  const trimmed = text.trim();
  return /(^|[\s'"(])~\/(?=\S)/.test(text)
    || /(^|[\s'"(])(?:file:\/\/)?\/(?:Users|home|Volumes|private|tmp|var)\/[^\s'"),;]+/i.test(text)
    || /(^|[\s'"(])[a-z]:\/[^\s'"),;]+/i.test(text)
    || /^\/(?:[^/\n]+\/)+[^/\n]+$/.test(trimmed);
}

function collectForbiddenContentFields(value, path = "", output = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectForbiddenContentFields(item, `${path}[${index}]`, output));
    return output;
  }
  if (!isRecord(value)) return output;
  const forbidden = new Set(["body", "content", "excerpt", "note_text", "raw_note", "raw_note_body", "prompt", "raw_prompt"]);
  for (const [key, item] of Object.entries(value)) {
    const fieldPath = path ? `${path}.${key}` : key;
    if (forbidden.has(key.toLowerCase())) output.push(fieldPath);
    collectForbiddenContentFields(item, fieldPath, output);
  }
  return output;
}

function isSanitizedPublicPath(value) {
  const raw = String(value ?? "").trim().replace(/\\/g, "/");
  return raw.startsWith("Sanitized/")
    && !raw.startsWith("/")
    && !raw.startsWith("~/")
    && !/^[a-z]:\//i.test(raw)
    && !raw.split("/").includes("..");
}

export function validatePublicBenchmarkFixture(document, options = {}) {
  const diagnostics = emptyPublicFixtureDiagnostics();
  const privatePathFields = new Set();
  const addPrivatePath = ({ caseId = "(document)", field, kind }) => {
    if (privatePathFields.has(field)) return;
    privatePathFields.add(field);
    diagnostics.private_paths.push({ case_id: caseId, field, kind });
  };
  if (document?.privacy !== "sanitized-synthetic") {
    diagnostics.missing_privacy_declaration.push({ expected: "sanitized-synthetic" });
  }
  for (const [caseIndex, caseItem] of (document?.cases ?? []).entries()) {
    const caseId = caseItem?.id ?? "(missing id)";
    if (caseItem?.provenance?.origin !== "synthetic") {
      diagnostics.non_synthetic_provenance.push({ case_id: caseId });
    }
    for (const item of publicFixturePaths(caseItem, caseIndex)) {
      if (!isSanitizedPublicPath(item.value)) {
        addPrivatePath({ caseId, field: item.field, kind: "unsanitized_fixture_path" });
      }
    }
  }
  for (const item of collectStringFields(document)) {
    if (!containsPrivateAbsolutePath(item.value)) continue;
    const caseMatch = /^cases\[(\d+)\]/.exec(item.field);
    const caseId = caseMatch
      ? document.cases?.[Number(caseMatch[1])]?.id ?? "(missing id)"
      : "(document)";
    addPrivatePath({ caseId, field: item.field, kind: "private_absolute_path" });
  }
  diagnostics.forbidden_content_fields = collectForbiddenContentFields(document).map((field) => ({ field }));
  const unsafe = Object.values(diagnostics).some((items) => items.length > 0);
  const result = { status: unsafe ? "unsafe" : "ready", diagnostics };
  if (options.strict && unsafe) {
    const codes = Object.entries(diagnostics).filter(([, entries]) => entries.length > 0).map(([code]) => code).join(", ");
    throw new Error(`Public benchmark fixture validation failed: ${codes}.`);
  }
  return result;
}

function assertArrayOfStrings(value, label, caseId) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error(`${caseId}: ${label} must be an array of non-empty strings.`);
  }
}

function assertRelationTargets(value, caseId) {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    throw new Error(`${caseId}: relation_targets must be an array when present.`);
  }
  for (const [index, target] of value.entries()) {
    if (!target || typeof target !== "object" || Array.isArray(target)) {
      throw new Error(`${caseId}: relation_targets[${index}] must be an object.`);
    }
    const notePath = typeof target.note_path === "string"
      ? target.note_path
      : typeof target.notePath === "string"
        ? target.notePath
        : "";
    if (!notePath.trim()) {
      throw new Error(`${caseId}: relation_targets[${index}] must include note_path.`);
    }
    if (target.relation !== undefined && (typeof target.relation !== "string" || !target.relation.trim())) {
      throw new Error(`${caseId}: relation_targets[${index}].relation must be a non-empty string when present.`);
    }
  }
}

export function validateCase(caseItem, options = {}) {
  const caseId = caseItem.id || "(missing id)";
  if (typeof caseItem.id !== "string" || !caseItem.id.trim()) {
    throw new Error("Each case must have a non-empty id.");
  }
  if (caseItem.source_note_path && !caseItem.allow_full_note && (!caseItem.source_note_start_line || !caseItem.source_note_end_line)) {
    throw new Error(`${caseId}: note-based benchmark inputs require input.lines or explicit input.whole_note: true.`);
  }
  if (typeof caseItem._resolved_insight_input !== "string" || !caseItem._resolved_insight_input.trim()) {
    throw new Error(`${caseId}: provide input.note with lines/whole_note, or standalone input.thought.`);
  }
  assertArrayOfStrings(caseItem.must_recall, "must_recall", caseId);
  if (caseItem.expected_no_recall && caseItem.must_recall.length !== 0) {
    throw new Error(`${caseId}: expected_no_recall cases should leave must_recall empty.`);
  }
  if (caseItem.nice_to_have !== undefined) {
    assertArrayOfStrings(caseItem.nice_to_have, "nice_to_have", caseId);
  }
  if (caseItem.negative !== undefined) {
    assertArrayOfStrings(caseItem.negative, "negative", caseId);
  }
  assertRelationTargets(caseItem.relation_targets, caseId);
  normalizeFailureAttribution(caseItem.failure_attribution, caseId);
  const resolver = options.resolver ?? buildVaultPathResolver(benchVaultRoot());
  const identityEvaluation = caseItem.identity_evaluation ?? resolveBenchmarkCaseIdentities(caseItem, resolver);
  caseItem.identity_evaluation = identityEvaluation;
  if (!caseItem.expected_no_recall && identityEvaluation.status === "ready") {
    const mustCount = identityEvaluation.gold.must.length;
    if (mustCount < 1 || mustCount > 8) {
      throw new Error(`${caseId}: canonical must gold should contain 1-8 notes unless expected_no_recall is true.`);
    }
  }
  const relationTargetPaths = (caseItem.relation_targets ?? []).map((target) => target.note_path ?? target.notePath);
  for (const relationTargetPath of relationTargetPaths) {
    const resolved = resolveVaultPath(relationTargetPath, resolver);
    if (resolved.status === "ambiguous") {
      throw new Error(`${caseId}: ambiguous relation target path ${relationTargetPath}: ${resolved.matches.join(", ")}`);
    }
  }
  return identityEvaluation;
}

export function activeCases(cases, includeDraft, includeOff = false) {
  return cases.filter((caseItem) => {
    const state = normalizeCaseState(caseItem);
    if (includeOff) return true;
    if (includeDraft) return state !== "off";
    return state === "active";
  });
}

export function readBenchmarkCases(inputPath, options = {}) {
  const resolvedInputPath = resolve(inputPath);
  const casesDir = dirname(resolvedInputPath);
  const input = JSON.parse(readFileSync(resolvedInputPath, "utf-8"));
  if (!Array.isArray(input.cases)) {
    throw new Error("cases.json must contain a cases array.");
  }

  const identityResolver = buildVaultPathResolver(benchVaultRoot());
  const cases = activeCases(input.cases, !!options.includeDraft, !!options.includeOff).map((caseItem) => {
    const normalized = normalizeBenchmarkCase(caseItem);
    const resolved = {
      ...normalized,
      _resolved_insight_input: insightInputForCase(normalized, casesDir),
    };
    resolved.identity_evaluation = resolveBenchmarkCaseIdentities(resolved, identityResolver);
    return resolved;
  });
  for (const caseItem of cases) {
    validateCase(caseItem, { resolver: identityResolver });
  }
  const suiteEvaluation = validateBenchmarkSuiteDocument(input, cases, { resolver: identityResolver });

  return {
    input,
    cases,
    collection: input.collection || "obsidian",
    expectedInTopK: Number(input.expected_in_top_k ?? 10),
    expectedNiceInTopK: Number(input.nice_expected_in_top_k ?? 20),
    identityResolver,
    suiteEvaluation,
    suiteVersions: suiteEvaluation.suite_versions,
  };
}

export function collectResultItems(value) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return [];
  for (const key of ["results", "items", "pages", "matches", "data"]) {
    const nested = value[key];
    if (Array.isArray(nested)) return nested;
  }
  return [];
}

export function pickFirstString(record, keys) {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

export function textFromUnknown(value) {
  if (typeof value === "string") return value;
  if (value == null) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
