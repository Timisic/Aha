// Tests for the shared-core QMD retrieval orchestration module (ADR 0005,
// issue #56): serial multi-query execution, the 30s default timeout policy,
// retry-once-on-timeout warning semantics (never downgrading the query
// kind), and row-array parsing. Ports the behavior of runQmdPlanQuery /
// runQmdPlanQueryCommand / runQmdPlanQueries / isQmdRetryableTimeout from the
// frozen legacy wrapper scripts/aha/run-insight-search.mjs, which had no
// standalone unit coverage before (only end-to-end coverage through spawned
// wrapper subprocesses in scripts/aha/tests/integration/aha-wrapper.test.mjs,
// which stays
// untouched and still covers the CLI adapter/argv/stdin/timeout contract).
//
// Imports go through the core artifact loader on purpose: the loader
// rebuilds obsidian-plugin/dist/core.mjs from src/core before importing, so
// this test also exercises the rebuild path every run. The `runQmdQuery` dep
// here is a fake (per ADR 0005, only argv/stdin/timeout/output-bounding are
// the adapter's duty) so this suite runs with no real qmd binary and no
// real elapsed timeouts.

import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_QMD_QUERY_TIMEOUT_MS,
  extractQmdRows,
  isQmdRetryableTimeout,
  runQmdPlanQueries,
  runQmdPlanQuery,
} from "../../../lib/core-artifact.mjs";

test("DEFAULT_QMD_QUERY_TIMEOUT_MS matches the legacy wrapper constant", () => {
  assert.equal(DEFAULT_QMD_QUERY_TIMEOUT_MS, 30_000);
});

test("extractQmdRows finds the outermost JSON array in qmd CLI stdout", () => {
  assert.deepEqual(extractQmdRows('noise\n[{"file":"a.md"}]\ntrailing'), [{ file: "a.md" }]);
  assert.throws(() => extractQmdRows("no array here"), /QMD output did not include a JSON array\./);
});

test("isQmdRetryableTimeout only retries a plain qmd query timeout, never qmd search or non-timeout errors", () => {
  assert.equal(isQmdRetryableTimeout(new Error("qmd timed out after 30000ms."), { command: "qmd query" }), true);
  assert.equal(isQmdRetryableTimeout(new Error("qmd timed out after 30000ms."), { command: "qmd search" }), false);
  assert.equal(isQmdRetryableTimeout(new Error("qmd exited 1"), { command: "qmd query" }), false);
});

function fakeDeps(script) {
  const calls = [];
  let index = 0;
  return {
    calls,
    deps: {
      async runQmdQuery(query, timeoutMs) {
        calls.push({ query, timeoutMs });
        const step = script[Math.min(index, script.length - 1)];
        index += 1;
        if (step instanceof Error) throw step;
        return step;
      },
    },
  };
}

test("runQmdPlanQuery resolves with parsed rows on the first success", async () => {
  const { deps, calls } = fakeDeps(['[{"file":"a.md","score":0.5}]']);
  const outcome = await runQmdPlanQuery({ kind: "raw", command: "qmd query", text: "t", query: "t" }, deps, { queryTimeoutMs: 1000 });
  assert.deepEqual(outcome.rows, [{ file: "a.md", score: 0.5 }]);
  assert.equal(outcome.warning, undefined);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].timeoutMs, 1000);
});

test("runQmdPlanQuery defaults to DEFAULT_QMD_QUERY_TIMEOUT_MS when no policy is given", async () => {
  const { deps, calls } = fakeDeps(["[]"]);
  await runQmdPlanQuery({ kind: "raw", command: "qmd query", query: "t" }, deps);
  assert.equal(calls[0].timeoutMs, DEFAULT_QMD_QUERY_TIMEOUT_MS);
});

test("runQmdPlanQuery retries once on a retryable timeout and warns without downgrading the kind", async () => {
  const { deps, calls } = fakeDeps([
    new Error("qmd timed out after 250ms."),
    '[{"file":"b.md","score":0.9}]',
  ]);
  const query = { kind: "raw", command: "qmd query", query: "t" };
  const outcome = await runQmdPlanQuery(query, deps, { queryTimeoutMs: 250 });
  assert.deepEqual(outcome.rows, [{ file: "b.md", score: 0.9 }]);
  assert.equal(outcome.query.kind, "raw");
  assert.match(outcome.warning, /raw\/qmd query timed out once \(qmd timed out after 250ms\.\); retry succeeded with qmd query\./);
  assert.equal(calls.length, 2);
});

test("runQmdPlanQuery throws a combined message when both the initial call and the retry time out", async () => {
  const { deps } = fakeDeps([
    new Error("qmd timed out after 250ms."),
    new Error("qmd timed out after 250ms."),
  ]);
  await assert.rejects(
    runQmdPlanQuery({ kind: "raw", command: "qmd query", query: "t" }, deps, { queryTimeoutMs: 250 }),
    /qmd timed out after 250ms\.; retry failed: qmd timed out after 250ms\./,
  );
});

test("runQmdPlanQuery never retries a qmd search timeout or a non-timeout failure", async () => {
  const { deps: searchDeps } = fakeDeps([new Error("qmd timed out after 250ms.")]);
  await assert.rejects(
    runQmdPlanQuery({ kind: "explicit_cue", command: "qmd search", query: "t" }, searchDeps, { queryTimeoutMs: 250 }),
    /timed out after 250ms\./,
  );

  const { deps: failDeps, calls } = fakeDeps([new Error("QMD exited 1")]);
  await assert.rejects(
    runQmdPlanQuery({ kind: "raw", command: "qmd query", query: "t" }, failDeps),
    /QMD exited 1/,
  );
  assert.equal(calls.length, 1);
});

test("runQmdPlanQueries runs serially, catching each query's failure independently", async () => {
  const calls = [];
  const deps = {
    async runQmdQuery(query) {
      calls.push(query.kind);
      if (query.kind === "contextual") throw new Error("QMD exited 1");
      return `[{"file":"${query.kind}.md","score":0.1}]`;
    },
  };
  const queries = [
    { kind: "raw", command: "qmd query", query: "a" },
    { kind: "contextual", command: "qmd query", query: "b" },
    { kind: "explicit_cue", command: "qmd search", query: "c" },
  ];
  const result = await runQmdPlanQueries(queries, deps);
  assert.deepEqual(calls, ["raw", "contextual", "explicit_cue"]);
  assert.equal(result.queryResults.length, 2);
  assert.deepEqual(result.queryResults.map((r) => r.query.kind), ["raw", "explicit_cue"]);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /^contextual\/qmd query: QMD exited 1$/);
  assert.deepEqual(result.warnings, []);
});

test("runQmdPlanQueries surfaces retry warnings alongside successful results", async () => {
  let firstCall = true;
  const deps = {
    async runQmdQuery(query) {
      if (query.kind === "raw" && firstCall) {
        firstCall = false;
        throw new Error("qmd timed out after 100ms.");
      }
      return "[]";
    },
  };
  const result = await runQmdPlanQueries([{ kind: "raw", command: "qmd query", query: "a" }], deps, { queryTimeoutMs: 100 });
  assert.equal(result.queryResults.length, 1);
  assert.equal(result.errors.length, 0);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /timed out once/);
});
