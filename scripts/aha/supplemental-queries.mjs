import { compactLine, normalizeQmdObject, qmdQueryFromObject, splitLexCandidates } from "./query-plan.mjs";

const DEFAULT_SOURCE_LIMIT = 360;
const DEFAULT_THOUGHT_LIMIT = 240;

/**
 * Add bounded, deterministic recall-floor queries to a generated query plan.
 * Policies only select supplements; construction remains shared by every caller.
 */
export function mergeSupplementalQueries({
  generatedPlan = {},
  sourceExcerpt = "",
  thought = "",
  policy = {},
} = {}) {
  const generatedQueries = Array.isArray(generatedPlan?.queries) ? generatedPlan.queries : [];
  const seen = new Set(generatedQueries.flatMap(queryDeduplicationKeys));
  const supplementalQueries = [];

  const candidates = [
    policy.sourceExcerpt !== false
      ? deterministicQuery("source_excerpt", sourceExcerpt, boundedLimit(policy.sourceExcerptMaxChars, DEFAULT_SOURCE_LIMIT))
      : null,
    policy.thought !== false
      ? deterministicQuery("thought", thought, boundedLimit(policy.thoughtMaxChars, DEFAULT_THOUGHT_LIMIT))
      : null,
  ].filter(Boolean);

  for (const query of candidates) {
    const keys = queryDeduplicationKeys(query);
    if (keys.some((key) => seen.has(key))) continue;
    supplementalQueries.push(query);
    for (const key of keys) seen.add(key);
  }

  return {
    ...generatedPlan,
    queries: [...generatedQueries, ...supplementalQueries],
    supplementalQueries,
  };
}

export function buildSupplementalQueries(input = {}) {
  return mergeSupplementalQueries(input).supplementalQueries;
}

/**
 * Build trace-safe query metadata. Query text and raw error messages are
 * deliberately excluded because either may contain private note content.
 */
export function buildQueryTraceMetadata(queries = [], outcomes = []) {
  const byIndex = new Map(outcomes.map((outcome) => [outcome.index, outcome]));
  const entries = queries.map((query, index) => {
    const outcome = byIndex.get(index);
    const success = outcome == null ? null : outcome.success === true;
    return {
      index,
      kind: String(query?.kind || "unknown"),
      command: String(query?.command || "qmd query"),
      provenance: query?.provenance === "deterministic" ? "deterministic" : "generated",
      success,
      failure: success === false ? safeFailureCode(outcome?.failure) : null,
    };
  });
  return { count: entries.length, queries: entries };
}

function deterministicQuery(kind, value, maxChars) {
  const text = boundedText(value, maxChars);
  if (!text) return null;
  const qmd = normalizeQmdObject({
    intent: kind === "source_excerpt"
      ? "召回与当前来源摘录直接相关的旧判断、反例和边界条件。"
      : "召回与用户当前新想法直接相关的旧判断、反例和边界条件。",
    lex: splitLexCandidates(text),
    vec: text,
    hyde: text,
  }, {}, text);
  return {
    kind,
    command: "qmd query",
    text,
    query: qmdQueryFromObject(qmd),
    qmd,
    provenance: "deterministic",
  };
}

function boundedText(value, maxChars) {
  const normalized = compactLine(value, Number.POSITIVE_INFINITY);
  if (normalized.length <= maxChars) return normalized;
  if (maxChars <= 3) return normalized.slice(0, maxChars);
  return `${normalized.slice(0, maxChars - 3).trimEnd()}...`;
}

function queryDeduplicationKeys(query) {
  return [query?.text, query?.query, query?.qmd?.vec]
    .map(normalizeDeduplicationText)
    .filter(Boolean);
}

function normalizeDeduplicationText(value) {
  return String(value ?? "").normalize("NFKC").replace(/\s+/g, " ").trim().toLocaleLowerCase("en-US");
}

function boundedLimit(value, fallback) {
  return Number.isInteger(value) && value > 0 ? Math.min(value, fallback) : fallback;
}

function safeFailureCode(value) {
  const code = String(value ?? "query_failed").trim().toLowerCase();
  return /^[a-z0-9_]{1,48}$/.test(code) ? code : "query_failed";
}
