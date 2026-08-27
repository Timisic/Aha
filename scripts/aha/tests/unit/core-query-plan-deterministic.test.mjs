// Tests for the shared-core deterministic query-planning module (ADR 0005,
// issue #56). Imports go through the core artifact loader on purpose: the
// loader rebuilds obsidian-plugin/dist/core.mjs from src/core before
// importing, so this test also exercises the rebuild path every run.
//
// scripts/aha/tests/unit/query-plan.test.mjs keeps its full coverage of
// scripts/aha/query-plan.mjs's LLM-adapter surface (generateQueryPlanWithAdapter,
// resolveQmdQueriesForCase), which now calls into these same core functions
// internally — nothing was dropped there.
// This file adds direct unit coverage of the pure deterministic functions
// themselves, including edge cases (sanitization, length limits, the rules
// fallback plan) that had no standalone test before because they were
// private helpers inline in scripts/aha/query-plan.mjs.

import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_QMD_HYDE_CHARS,
  MAX_QMD_INTENT_CHARS,
  MAX_QMD_LEX_CHARS,
  MAX_QMD_LEX_TERMS,
  MAX_QMD_VEC_CHARS,
  QUERY_PLAN_COMMANDS,
  QUERY_PLAN_KINDS,
  compactLine,
  deterministicSourceFallbackQuery,
  fallbackQmdObject,
  normalizeLex,
  normalizeQmdObject,
  normalizeQueryCommand,
  normalizeQueryKind,
  normalizeQueryPlan,
  normalizeQueryPlanItem,
  qmdQueryFromObject,
  queryPlanFromFallbackRules,
  queryTextForCommand,
  sanitizeQmdLine,
  splitLexCandidates,
  unique,
} from "../../../lib/core-artifact.mjs";

test("compactLine collapses whitespace and truncates with an ellipsis", () => {
  assert.equal(compactLine("  a   b\n\tc  "), "a b c");
  assert.equal(compactLine("x".repeat(10), 5), `${"x".repeat(4)}...`);
  assert.equal(compactLine(null), "");
});

test("unique trims, drops blanks, and de-duplicates in order", () => {
  assert.deepEqual(unique([" a ", "a", "", null, "b", undefined, "b "]), ["a", "b"]);
});

test("splitLexCandidates isolates fresh-thought terms and drops stopword-like tokens", () => {
  const terms = splitLexCandidates("Source note:\n反馈闭环和行动修正。\n\nFresh thought:\n要找旧判断里的反例。");
  assert.ok(terms.length > 0 && terms.length <= MAX_QMD_LEX_TERMS);
  assert.ok(terms.every((term) => term.length <= MAX_QMD_LEX_CHARS));
  assert.ok(!terms.includes("source note"));
  assert.ok(!terms.includes("fresh thought"));
});

test("normalizeLex accepts arrays and single strings, bounding each item length", () => {
  assert.deepEqual(normalizeLex(["a", "b".repeat(40)]), ["a", `${"b".repeat(MAX_QMD_LEX_CHARS - 1)}...`]);
  assert.deepEqual(normalizeLex("solo term"), ["solo term"]);
  assert.deepEqual(normalizeLex(undefined), []);
});

test("sanitizeQmdLine strips field prefixes, normalizes quotes, and bounds length", () => {
  assert.equal(sanitizeQmdLine('intent: "hello world"', 100), "'hello world'");
  assert.equal(sanitizeQmdLine("- bullet term", 100), "bullet term");
  assert.equal(sanitizeQmdLine("lex: `term`", 100), "'term'");
});

test("normalizeQueryKind falls back by position; normalizeQueryCommand falls back by kind", () => {
  assert.equal(normalizeQueryKind("bounds", 0), "bounds");
  assert.equal(normalizeQueryKind("not-a-kind", 1), "abstracted_judgment");
  assert.equal(normalizeQueryKind(undefined, 99), "contextual");
  assert.equal(normalizeQueryCommand("qmd search", "raw"), "qmd search");
  assert.equal(normalizeQueryCommand("bogus", "explicit_cue"), "qmd search");
  assert.equal(normalizeQueryCommand("bogus", "raw"), "qmd query");
  assert.deepEqual(QUERY_PLAN_KINDS, ["raw", "abstracted_judgment", "contextual", "explicit_cue", "bounds"]);
  assert.deepEqual(QUERY_PLAN_COMMANDS, ["qmd query", "qmd search"]);
});

test("fallbackQmdObject derives intent/lex/vec/hyde from source text and respects length caps", () => {
  const qmd = fallbackQmdObject({ sourcePath: "Source.md" }, "# 反馈闭环\n\n反馈闭环暴露经验差距，也帮助下一次行动修正。");
  assert.ok(qmd.intent.length <= MAX_QMD_INTENT_CHARS);
  assert.ok(qmd.lex.length > 0 && qmd.lex.length <= MAX_QMD_LEX_TERMS);
  assert.ok(qmd.vec.length <= MAX_QMD_VEC_CHARS);
  assert.ok(qmd.hyde.length <= MAX_QMD_HYDE_CHARS);
  assert.match(qmd.hyde, /反馈闭环/);
});

test("normalizeQmdObject merges provided lex with fallback lex and sanitizes every field", () => {
  const normalized = normalizeQmdObject(
    { intent: "intent: custom intent", lex: ["term one", "term two"], vec: "custom vec", hyde: "custom hyde" },
    { sourcePath: "Source.md" },
    "# Heading\n\nSome source body text long enough to matter here.",
  );
  assert.equal(normalized.intent, "custom intent");
  assert.ok(normalized.lex.includes("term one"));
  assert.ok(normalized.lex.length <= MAX_QMD_LEX_TERMS);
  assert.equal(normalized.vec, "custom vec");
  assert.equal(normalized.hyde, "custom hyde");
});

test("qmdQueryFromObject renders intent/lex/vec/hyde lines in a fixed order", () => {
  // qmdQueryFromObject re-normalizes its input (normalizeQmdObject always
  // merges in the deterministic fallback's lex terms), so with no args/
  // sourceText context an extra "source" lex line is expected here; the
  // point of this test is the line ORDER, not an exact lex-term count.
  const query = qmdQueryFromObject({ intent: "i", lex: ["a", "b"], vec: "v", hyde: "h" });
  const lines = query.split("\n");
  assert.equal(lines[0], "intent: i");
  assert.equal(lines.at(-2), "vec: v");
  assert.equal(lines.at(-1), "hyde: h");
  assert.ok(lines.slice(1, -2).every((line) => line.startsWith("lex: ")));
  assert.ok(lines.includes("lex: a"));
  assert.ok(lines.includes("lex: b"));
});

test("queryTextForCommand uses lex join for qmd search and the full qmd object for qmd query", () => {
  const qmd = { intent: "i", lex: ["a", "b"], vec: "v", hyde: "h" };
  assert.equal(queryTextForCommand("qmd search", "", qmd), "a b");
  assert.equal(queryTextForCommand("qmd search", "explicit text", qmd), "explicit text");
  assert.equal(queryTextForCommand("qmd query", "ignored", qmd), qmdQueryFromObject(qmd));
});

test("deterministicSourceFallbackQuery preserves source phrasing in its vec field", () => {
  const query = deterministicSourceFallbackQuery({ sourcePath: "Source.md" }, "反馈闭环暴露经验差距，也帮助下一次行动修正。");
  assert.equal(query.kind, "source_fallback");
  assert.equal(query.command, "qmd query");
  assert.match(query.qmd.vec, /反馈闭环暴露经验差距/);
  assert.match(query.query, /^intent:/);
});

test("normalizeQueryPlan de-duplicates, caps at 5 model queries, and appends the deterministic fallback", () => {
  const rawPlan = {
    queries: [
      { kind: "raw", command: "qmd query", text: "a", qmd: { intent: "i1", lex: ["a"], vec: "v1", hyde: "h1" } },
      { kind: "raw", command: "qmd query", text: "a", qmd: { intent: "i1", lex: ["a"], vec: "v1", hyde: "h1" } },
      { kind: "contextual", command: "qmd query", text: "b", qmd: { intent: "i2", lex: ["b"], vec: "v2", hyde: "h2" } },
      { kind: "explicit_cue", command: "qmd search", text: "c", qmd: { intent: "i3", lex: ["c"], vec: "v3", hyde: "h3" } },
    ],
  };
  const plan = normalizeQueryPlan(rawPlan, { sourcePath: "Source.md" }, "source text");
  // The exact duplicate ("a" under qmd query) collapses to one entry.
  assert.equal(plan.model_query_count, 3);
  assert.equal(plan.queries.length, 4);
  assert.equal(plan.queries.at(-1).kind, "source_fallback");
});

test("normalizeQueryPlan supplements with rules when fewer than 3 usable queries survive de-duplication", () => {
  const plan = normalizeQueryPlan(
    { queries: [{ kind: "raw", command: "qmd query", text: "a", qmd: {} }] },
    { displayName: "test-agent", _resolved_insight_input: "补充测试" },
    "",
  );
  assert.equal(plan.model_query_count, 1);
  assert.ok(plan.queries.length >= 3, "supplemented plan should have at least 3 queries");
  assert.equal(plan.queries[0].kind, "raw");
  assert.equal(plan.queries.at(-1).kind, "source_fallback");
});

test("normalizeQueryPlanItem falls back kind by index and derives query text from qmd when text is absent", () => {
  const item = normalizeQueryPlanItem({ qmd: { vec: "vector text" } }, { sourcePath: "Source.md" }, "source", 1);
  assert.equal(item.kind, "abstracted_judgment");
  assert.equal(item.command, "qmd query");
  assert.match(item.query, /^intent:/);
});

test("queryPlanFromFallbackRules produces the same 4-query, 4-kind shape as the rules generator", () => {
  const plan = queryPlanFromFallbackRules({
    id: "rules-case",
    _resolved_insight_input: "Source note:\n反馈闭环和行动修正。\n\nFresh thought:\n要找旧判断里的反例。",
  });
  assert.equal(plan.queries.length, 4);
  assert.deepEqual(plan.queries.map((q) => q.kind), ["raw", "abstracted_judgment", "contextual", "explicit_cue"]);
  assert.equal(plan.queries.at(-1).command, "qmd search");
  assert.ok(plan.queries.every((q) => q.qmd.lex.length <= MAX_QMD_LEX_TERMS));
});
