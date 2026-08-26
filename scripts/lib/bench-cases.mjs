import { readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { expandHome, normalizeFailureAttribution, qmdExpectedPath } from "./bench-scoring.mjs";
import { benchVaultRoot } from "./vault-paths.mjs";
import {
  buildVaultPathResolver,
  normalizeLineRange,
  parseLineRange,
  resolveVaultPath,
  sliceLineRange,
} from "./core-artifact.mjs";

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
  failureAttributionForPipelineCase,
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

export function normalizeBenchmarkCase(caseItem) {
  const input = caseItem.input && typeof caseItem.input === "object" && !Array.isArray(caseItem.input)
    ? caseItem.input
    : {};
  const gold = caseItem.gold && typeof caseItem.gold === "object" && !Array.isArray(caseItem.gold)
    ? caseItem.gold
    : {};
  const note = String(input.note ?? caseItem.source_note_path ?? "").trim();
  const lines = normalizeLines(input, caseItem);
  const thought = String(input.thought ?? caseItem.insight_thought ?? (!note ? caseItem.insight_input ?? "" : "")).trim();
  const wholeNote = input.whole_note === true || caseItem.allow_full_note === true;
  const state = normalizeCaseState(caseItem);
  const must = normalizeStringArray(gold.must ?? caseItem.must_recall, "gold.must", caseItem.id || "(missing id)");
  const nice = normalizeStringArray(gold.nice ?? caseItem.nice_to_have, "gold.nice", caseItem.id || "(missing id)");
  const noise = normalizeStringArray(gold.noise ?? caseItem.negative, "gold.noise", caseItem.id || "(missing id)");
  const title = String(caseItem.title ?? caseItem.description ?? caseItem.id ?? "").trim();
  const why = String(caseItem.why ?? caseItem.annotation_note ?? "").trim();

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
    _schema_version: 3,
  };
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

export function validateCase(caseItem) {
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
  if (!caseItem.expected_no_recall && (caseItem.must_recall.length < 1 || caseItem.must_recall.length > 8)) {
    throw new Error(`${caseId}: must_recall should contain 1-8 files unless expected_no_recall is true.`);
  }
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
  const relationTargetPaths = (caseItem.relation_targets ?? []).map((target) => target.note_path ?? target.notePath);
  const goldIdentities = [
    ...caseItem.must_recall,
    ...(caseItem.nice_to_have ?? []),
    ...(caseItem.negative ?? []),
  ].map(qmdExpectedPath);
  const duplicates = goldIdentities.filter((identity, index) => goldIdentities.indexOf(identity) !== index);
  if (duplicates.length > 0) {
    throw new Error(`${caseId}: benchmark gold paths contain duplicate canonical identities: ${Array.from(new Set(duplicates)).join(", ")}`);
  }
  const vaultRoot = benchVaultRoot();
  const resolver = buildVaultPathResolver(vaultRoot);
  for (const goldPath of [...caseItem.must_recall, ...(caseItem.nice_to_have ?? []), ...(caseItem.negative ?? []), ...relationTargetPaths]) {
    const resolved = resolveVaultPath(goldPath, resolver);
    if (resolved.status === "ambiguous") {
      throw new Error(`${caseId}: ambiguous benchmark gold path ${goldPath}: ${resolved.matches.join(", ")}`);
    }
  }
}

export function activeCases(cases, includeDraft) {
  return cases.filter((caseItem) => {
    const state = normalizeCaseState(caseItem);
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

  const cases = activeCases(input.cases, !!options.includeDraft).map((caseItem) => {
    const normalized = normalizeBenchmarkCase(caseItem);
    return {
      ...normalized,
      _resolved_insight_input: insightInputForCase(normalized, casesDir),
    };
  });
  for (const caseItem of cases) {
    validateCase(caseItem);
  }

  return {
    input,
    cases,
    collection: input.collection || "obsidian",
    expectedInTopK: Number(input.expected_in_top_k ?? 10),
    expectedNiceInTopK: Number(input.nice_expected_in_top_k ?? 20),
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
