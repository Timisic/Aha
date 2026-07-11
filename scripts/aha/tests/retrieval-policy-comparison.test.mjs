import assert from "node:assert/strict";
import test from "node:test";
import { comparePolicyReports } from "../../bench/compare-retrieval-policies.mjs";

function report(policy, latency, recall) {
  const result = {
    id: "case-1",
    runtime_status: "success",
    evaluation_status: "scored",
    latency_ms: latency,
    openai_transport: { total: { request_count: 2, attempt_count: 3, retry_count: 1, retry_categories: { timeout: 1 } } },
    qmd: { top_files: ["retrieved.md"] },
    pipeline: {
      score: { recall_at_k: recall },
      eval_v2: { useful_precision_at_k: 0.5, ndcg_at_k: 0.75, negative_rate_at_k: 0 },
      stability: { score: 0.8 },
      relation_judge_reviewed_candidates: [{ notePath: "judged.md" }],
      top_candidates: [{ file: "final.md" }],
    },
  };
  return {
    profile: "product-parity",
    suite: { kind: "development", version: "dev-v1" },
    metadata: { effective_config_id: `${policy}-config`, effective_configuration: { retrieval_policy: { id: policy, version: policy === "product-v2" ? 2 : 1 } } },
    results: [result],
  };
}

test("policy comparison keeps suite separation, operational metrics, and per-case stage evidence", () => {
  const comparison = comparePolicyReports(report("product-v2", 120, 1), report("legacy-v1", 100, 0.5), {
    thresholds: { minimum_quality_delta: { must_recall_at_10: 0.25 }, maximum_mean_latency_increase_ms: 30, maximum_failure_increase: 0 },
    tradeoff_decision: "Accept 20ms mean latency for the recall gain.",
  });
  assert.equal(comparison.candidate.logical_requests, 2);
  assert.equal(comparison.candidate.attempts, 3);
  assert.equal(comparison.candidate.retries, 1);
  assert.equal(comparison.tradeoffs.quality.must_recall_at_10, 0.5);
  assert.equal(comparison.promotion.eligible, true);
  assert.deepEqual(comparison.cases[0].candidate, {
    status: "success",
    evaluation_status: "scored",
    latency_ms: 120,
    retrieval_top_10: ["retrieved.md"],
    judge_top_10: ["judged.md"],
    final_top_10: ["final.md"],
  });
});

test("policy comparison rejects cross-suite evidence", () => {
  const rollback = report("legacy-v1", 100, 0.5);
  rollback.suite.kind = "holdout";
  assert.throws(() => comparePolicyReports(report("product-v2", 120, 1), rollback), /same suite/);
});
