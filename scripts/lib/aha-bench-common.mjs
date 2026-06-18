import { readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { expandHome } from "./aha-bench-evaluation.mjs";

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
} from "./aha-query-generation.mjs";

export {
  applyBenchEvaluationPolicy,
  expandHome,
  filterSourceNoteFromResults,
  normalizePathForScore,
  pathsMatch,
  qmdExpectedPath,
  scoreNiceToHave,
  scoreResults,
  sourceNotePathForCase,
  summarizePipelineEvaluation,
} from "./aha-bench-evaluation.mjs";

function sliceSourceNote(content, caseItem) {
  const start = Number(caseItem.source_note_start_line ?? 1);
  const end = Number(caseItem.source_note_end_line ?? 0);
  if ((!caseItem.source_note_start_line && !caseItem.source_note_end_line) || !Number.isFinite(start)) {
    return content;
  }
  const lines = content.split(/\r?\n/);
  const from = Math.max(0, start - 1);
  const to = Number.isFinite(end) && end > 0 ? Math.min(lines.length, end) : lines.length;
  return lines.slice(from, to).join("\n");
}

export function readSourceNote(sourceNotePath, casesDir, caseId, caseItem = {}) {
  const rawPath = expandHome(String(sourceNotePath ?? "").trim());
  if (!rawPath) return "";
  const vaultRoot = expandHome(process.env.AHA_BENCH_VAULT_ROOT || "/Users/hong/Obsidian Notes");
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
  if (typeof caseItem.insight_input === "string" && caseItem.insight_input.trim()) {
    return caseItem.insight_input.trim();
  }

  const caseId = caseItem.id || "(missing id)";
  const sourceNotePath = String(caseItem.source_note_path ?? "").trim();
  if (!sourceNotePath) return "";

  const sourceNote = readSourceNote(sourceNotePath, casesDir, caseId, caseItem);
  const thought = String(caseItem.insight_thought ?? "").trim();
  return [
    "Source note:",
    sourceNote.trim(),
    thought ? ["", "Fresh thought:", thought].join("\n") : "",
  ].filter(Boolean).join("\n");
}

function assertArrayOfStrings(value, label, caseId) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error(`${caseId}: ${label} must be an array of non-empty strings.`);
  }
}

export function validateCase(caseItem) {
  const caseId = caseItem.id || "(missing id)";
  if (typeof caseItem.id !== "string" || !caseItem.id.trim()) {
    throw new Error("Each case must have a non-empty id.");
  }
  if (typeof caseItem._resolved_insight_input !== "string" || !caseItem._resolved_insight_input.trim()) {
    throw new Error(`${caseId}: provide either insight_input, or source_note_path with an optional insight_thought.`);
  }
  assertArrayOfStrings(caseItem.must_recall, "must_recall", caseId);
  if (caseItem.must_recall.length < 1 || caseItem.must_recall.length > 8) {
    throw new Error(`${caseId}: must_recall should contain 1-8 files.`);
  }
  if (caseItem.nice_to_have !== undefined) {
    assertArrayOfStrings(caseItem.nice_to_have, "nice_to_have", caseId);
  }
}

export function activeCases(cases, includeDraft) {
  return cases.filter((caseItem) => {
    const status = String(caseItem.status ?? "active").toLowerCase();
    if (includeDraft) return status !== "disabled";
    return status === "active";
  });
}

export function readBenchmarkCases(inputPath, options = {}) {
  const resolvedInputPath = resolve(inputPath);
  const casesDir = dirname(resolvedInputPath);
  const input = JSON.parse(readFileSync(resolvedInputPath, "utf-8"));
  if (!Array.isArray(input.cases)) {
    throw new Error("cases.json must contain a cases array.");
  }

  const cases = activeCases(input.cases, !!options.includeDraft).map((caseItem) => ({
    ...caseItem,
    _resolved_insight_input: insightInputForCase(caseItem, casesDir),
  }));
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
