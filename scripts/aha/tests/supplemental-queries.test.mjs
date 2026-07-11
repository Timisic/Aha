import assert from "node:assert/strict";
import test from "node:test";

import {
  buildQueryTraceMetadata,
  buildSupplementalQueries,
  mergeSupplementalQueries,
} from "../supplemental-queries.mjs";

const generated = (text) => ({
  kind: "raw",
  command: "qmd query",
  text,
  query: `intent: generated\nvec: ${text}`,
  qmd: { vec: text },
});

test("builds one bounded source-excerpt query for note-only input", () => {
  const privateText = `private source ${"x".repeat(500)}`;
  const queries = buildSupplementalQueries({ sourceExcerpt: privateText });

  assert.equal(queries.length, 1);
  assert.equal(queries[0].kind, "source_excerpt");
  assert.equal(queries[0].provenance, "deterministic");
  assert.ok(queries[0].text.length <= 360);
});

test("builds one bounded thought query for thought-only input", () => {
  const queries = buildSupplementalQueries({ thought: `fresh ${"idea ".repeat(100)}` });

  assert.equal(queries.length, 1);
  assert.equal(queries[0].kind, "thought");
  assert.ok(queries[0].text.length <= 240);
});

test("combines distinct source and thought supplements in stable order", () => {
  const merged = mergeSupplementalQueries({
    generatedPlan: { queries: [generated("existing plan")] },
    sourceExcerpt: "source evidence",
    thought: "a distinct new thought",
  });

  assert.deepEqual(merged.queries.map((query) => query.kind), ["raw", "source_excerpt", "thought"]);
  assert.deepEqual(merged.supplementalQueries.map((query) => query.kind), ["source_excerpt", "thought"]);
});

test("normalizes and deduplicates supplements against the plan and each other", () => {
  const merged = mergeSupplementalQueries({
    generatedPlan: { queries: [generated("SAME retrieval text")] },
    sourceExcerpt: "  same   retrieval text ",
    thought: "ＳＡＭＥ retrieval text",
  });

  assert.equal(merged.queries.length, 1);
  assert.deepEqual(merged.supplementalQueries, []);
});

test("empty and explicitly disabled inputs add no supplemental queries", () => {
  assert.deepEqual(buildSupplementalQueries({ sourceExcerpt: " \n ", thought: "" }), []);
  assert.deepEqual(buildSupplementalQueries({
    sourceExcerpt: "source",
    thought: "thought",
    policy: { sourceExcerpt: false, thought: false },
  }), []);
});

test("trace metadata represents partial failure without private query or error text", () => {
  const secret = "my private thought";
  const queries = mergeSupplementalQueries({
    generatedPlan: { queries: [generated("generated secret")] },
    thought: secret,
  }).queries;
  const trace = buildQueryTraceMetadata(queries, [
    { index: 0, success: true },
    { index: 1, success: false, failure: `timeout: ${secret}` },
  ]);

  assert.equal(trace.count, 2);
  assert.deepEqual(trace.queries, [
    { index: 0, kind: "raw", command: "qmd query", provenance: "generated", success: true, failure: null },
    { index: 1, kind: "thought", command: "qmd query", provenance: "deterministic", success: false, failure: "query_failed" },
  ]);
  assert.equal(JSON.stringify(trace).includes(secret), false);
  assert.equal(JSON.stringify(trace).includes("generated secret"), false);
});
