import assert from "node:assert/strict";
import test from "node:test";

import {
  comparePipelineStability,
  failureAttributionFromTrace,
} from "../../lib/bench-scoring.mjs";

test("stability is not measured without a compatible comparison report", () => {
  const current = pipelineReport(["Memory/A.md", "Memory/B.md"]);

  const comparison = comparePipelineStability(current, null);

  assert.deepEqual(comparison.summary, {
    status: "not_measured",
    reason: "no_comparison_report",
    metric: "top_k_overlap",
    top_k: 10,
    measured_cases: 0,
    score: null,
  });
  assert.equal(comparison.by_case["case-1"].status, "not_measured");
});

test("stability uses canonical top-k overlap only for compatible reports", () => {
  const current = pipelineReport(["Memory/A.md", "Memory/B.md", "Memory/C.md"]);
  const baseline = pipelineReport([
    "qmd://obsidian/Memory/A.md?index=obsidian",
    "Memory/B.md",
    "Memory/D.md",
  ]);

  const comparison = comparePipelineStability(current, baseline);

  assert.equal(comparison.summary.status, "measured");
  assert.equal(comparison.summary.measured_cases, 1);
  assert.equal(comparison.summary.score, 2 / 3);
  assert.equal(comparison.by_case["case-1"].score, 2 / 3);

  baseline.profile = "diagnostic-enhanced";
  const incompatible = comparePipelineStability(current, baseline);
  assert.equal(incompatible.summary.status, "not_measured");
  assert.equal(incompatible.summary.reason, "incompatible_profile");
});

test("stability honors each case top-k and refuses a mismatched comparison budget", () => {
  const current = pipelineReport(["Memory/A.md", "Memory/B.md", "Memory/C.md"]);
  const baseline = pipelineReport(["Memory/A.md", "Memory/B.md", "Memory/C.md"]);
  baseline.results[0].pipeline.score.top_k = 5;

  const comparison = comparePipelineStability(current, baseline);

  assert.deepEqual(comparison.by_case["case-1"], {
    status: "not_measured",
    reason: "incompatible_top_k",
    metric: "top_k_overlap",
    top_k: 10,
    comparison_top_k: 5,
    score: null,
  });
  assert.equal(comparison.summary.status, "not_measured");
  assert.equal(comparison.summary.reason, "no_comparable_cases");
});

test("stability reports mixed per-case top-k budgets without pretending they share one K", () => {
  const current = pipelineReport(["Memory/A.md", "Memory/B.md"]);
  const baseline = pipelineReport(["Memory/A.md", "Memory/C.md"]);
  current.results.push(pipelineResult("case-2", 5, ["Memory/D.md", "Memory/E.md"]));
  baseline.results.push(pipelineResult("case-2", 5, ["Memory/D.md", "Memory/F.md"]));

  const comparison = comparePipelineStability(current, baseline);

  assert.equal(comparison.by_case["case-1"].top_k, 10);
  assert.equal(comparison.by_case["case-2"].top_k, 5);
  assert.deepEqual(comparison.summary, {
    status: "measured",
    metric: "top_k_overlap",
    top_k: null,
    top_ks: [5, 10],
    measured_cases: 2,
    score: 0.5,
  });
});

test("trace attribution treats a deep unreviewed hit as retrieval evidence, not rerank", () => {
  const trace = pipelineTrace({
    preJudge: rankedCandidates("Other", 44).concat(candidate("Memory/Must.md", 45)),
    reviewed: rankedCandidates("Other", 20),
    final: rankedCandidates("Other", 10),
  });

  const attribution = failureAttributionFromTrace(caseItem(), trace, { topK: 10 });

  assert.equal(attribution.status, "attributed");
  assert.equal(attribution.primary, "retrieval_failure");
  assert.equal(attribution.evidence.must_found_beyond_judge_budget, 1);
  assert.ok(attribution.flags.includes("found_beyond_judge_budget"));
});

test("trace attribution marks ordering only after the must memory was actually reviewed", () => {
  const reviewed = [candidate("Memory/Must.md", 1), ...rankedCandidates("Other", 10)];
  const trace = pipelineTrace({
    preJudge: reviewed,
    reviewed,
    final: [...rankedCandidates("Other", 10), candidate("Memory/Must.md", 11)],
  });

  const attribution = failureAttributionFromTrace(caseItem(), trace, { topK: 10 });

  assert.equal(attribution.status, "attributed");
  assert.equal(attribution.primary, "rerank_failure");
  assert.equal(attribution.evidence.stage, "ordering");
  assert.equal(attribution.evidence.reviewed_must_count, 1);
});

test("trace attribution distinguishes query, relation, and identity evidence", () => {
  const queryFailure = pipelineTrace({ reviewed: [], final: [] });
  queryFailure.steps.query_generation.status = "failed";
  queryFailure.steps.query_generation.errors = [{ category: "stage_error" }];
  delete queryFailure.steps.final_candidates;
  assert.equal(
    failureAttributionFromTrace(caseItem(), queryFailure, { topK: 10 }).primary,
    "query_failure",
  );

  const relationFailure = pipelineTrace({
    preJudge: [candidate("Memory/Must.md", 1)],
    reviewed: [candidate("Memory/Must.md", 1)],
    final: [],
    judgeStatus: "failed",
  });
  assert.equal(
    failureAttributionFromTrace(caseItem(), relationFailure, { topK: 10 }).primary,
    "relation_failure",
  );

  const identityCase = caseItem();
  identityCase.identity_evaluation = {
    status: "not_scored",
    diagnostics: { ambiguous: [{ reference: "Memory/Must.md" }] },
  };
  assert.equal(
    failureAttributionFromTrace(identityCase, pipelineTrace({}), { topK: 10 }).primary,
    "input_representation_failure",
  );
});

test("incomplete trace evidence remains explicitly unattributed", () => {
  const trace = pipelineTrace({ preJudge: [], reviewed: undefined, final: [] });
  delete trace.steps.relation_judge.reviewed_candidates;

  const attribution = failureAttributionFromTrace(caseItem(), trace, { topK: 10 });

  assert.deepEqual(attribution, {
    status: "unattributed",
    primary: null,
    reason: "insufficient_trace_evidence",
    evidence: {
      stage: "unknown",
      missing_trace_fields: ["relation_judge.reviewed_candidates"],
    },
    flags: [],
  });
});

test("trace attribution does not fabricate retrieval evidence when candidate-path stages are missing", () => {
  const scenarios = [
    {
      missingField: "pre_judge_candidates",
      remove(trace) {
        delete trace.steps.pre_judge_candidates;
      },
    },
    {
      missingField: "qmd_runs",
      remove(trace) {
        delete trace.steps.qmd_runs;
      },
    },
    {
      missingField: "final_candidates",
      remove(trace) {
        delete trace.steps.final_candidates;
      },
    },
  ];

  for (const scenario of scenarios) {
    const trace = pipelineTrace({ preJudge: [], reviewed: [], final: [] });
    scenario.remove(trace);

    const attribution = failureAttributionFromTrace(caseItem(), trace, { topK: 10 });

    assert.deepEqual(attribution, {
      status: "unattributed",
      primary: null,
      reason: "insufficient_trace_evidence",
      evidence: {
        stage: "unknown",
        missing_trace_fields: [scenario.missingField],
      },
      flags: [],
    });
  }
});

function pipelineReport(files) {
  return {
    profile: "product-parity",
    suite: { kind: "development", version: "dev-v1" },
    candidate_limit: 20,
    metadata: {
      trace_schema: "PipelineTrace",
      trace_version: 2,
      effective_config_id: "config-v1",
    },
    summary: { eval_v2: { top_k: 10 } },
    results: [pipelineResult("case-1", 10, files)],
  };
}

function pipelineResult(id, topK, files) {
  return {
    id,
    pipeline: {
      score: { top_k: topK },
      top_candidates: files.map((file) => ({ file })),
    },
  };
}

function caseItem() {
  return {
    id: "case-1",
    must_recall: ["Memory/Must.md"],
    nice_to_have: [],
    negative: [],
  };
}

function pipelineTrace({ preJudge = [], reviewed = [], final = [], judgeStatus = "success" } = {}) {
  return {
    schema: "PipelineTrace",
    version: 2,
    status: "success",
    steps: {
      query_generation: { status: "success", errors: [] },
      qmd_runs: [{ status: "success", errors: [] }],
      source_expansion: { errors: [] },
      pre_judge_candidates: preJudge,
      relation_judge: {
        status: judgeStatus,
        fallback: false,
        reviewed_candidates: reviewed,
        decisions: reviewed,
        errors: judgeStatus === "failed" ? [{ category: "stage_error" }] : [],
      },
      final_candidates: final,
    },
    errors: [],
  };
}

function candidate(file, rank) {
  return { file, rank };
}

function rankedCandidates(prefix, count) {
  return Array.from({ length: count }, (_, index) => candidate(`${prefix}/${index + 1}.md`, index + 1));
}
