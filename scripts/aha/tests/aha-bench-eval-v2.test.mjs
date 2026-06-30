import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  applyBenchEvaluationPolicy,
  droppedMustFromExpandedPool,
  failureAttributionForPipelineCase,
  normalizeFailureAttribution,
  readBenchmarkCases,
  scoreEvalV2,
  scoreNiceToHave,
  scoreResults,
  summarizePipelineEvaluation,
  validateCase,
} from "../../lib/aha-bench-common.mjs";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const previousVaultRoot = process.env.AHA_BENCH_VAULT_ROOT;

test.after(() => {
  if (previousVaultRoot === undefined) {
    delete process.env.AHA_BENCH_VAULT_ROOT;
  } else {
    process.env.AHA_BENCH_VAULT_ROOT = previousVaultRoot;
  }
});

test("eval-v2 scoring counts useful concentration, ranking quality, and active negatives at @10", () => {
  const results = [
    "Memory/must-one.md",
    "Memory/noise-a.md",
    "Memory/nice-one.md",
    "Memory/negative-one.md",
    "Memory/unlabeled-b.md",
    "Memory/must-two.md",
    "Memory/unlabeled-c.md",
    "Memory/unlabeled-d.md",
    "Memory/unlabeled-e.md",
    "Memory/unlabeled-f.md",
    "Memory/negative-outside-budget.md",
  ];

  const score = scoreEvalV2(results, {
    topK: 10,
    mustRecallFiles: ["Memory/must-one.md", "Memory/must-two.md"],
    niceToHaveFiles: ["Memory/nice-one.md"],
    negativeFiles: ["Memory/negative-one.md", "Memory/negative-outside-budget.md"],
  });

  assert.equal(score.top_k, 10);
  assert.equal(score.must_recall_at_k, 1);
  assert.equal(score.useful_precision_at_k, 0.3);
  assert.equal(score.negative_rate_at_k, 0.1);
  assert.equal(score.negative_hits_at_k, 1);
  assert.deepEqual(score.must_recall_hits, ["Memory/must-one.md", "Memory/must-two.md"]);
  assert.deepEqual(score.nice_to_have_hits, ["Memory/nice-one.md"]);
  assert.ok(score.ndcg_at_k > 0.7 && score.ndcg_at_k < 1, `nDCG should penalize late must hit, got ${score.ndcg_at_k}`);
});

test("benchmark validation accepts negative labels and optional relation targets", async () => {
  const vaultRoot = await mkdtemp(path.join(tmpdir(), "aha-eval-v2-vault-"));
  process.env.AHA_BENCH_VAULT_ROOT = vaultRoot;

  const caseItem = {
    id: "case-v2",
    status: "active",
    _resolved_insight_input: "A realistic insight input remains the source of truth.",
    must_recall: ["Memory/must.md"],
    nice_to_have: ["Memory/nice.md"],
    negative: ["Memory/noise.md"],
    relation_targets: [
      {
        note_path: "Memory/must.md",
        relation: "supports",
      },
    ],
  };

  assert.doesNotThrow(() => validateCase(caseItem));
  await rm(vaultRoot, { recursive: true, force: true });
});

test("failure attribution validation rejects unknown or multiple primary groups", async () => {
  const vaultRoot = await mkdtemp(path.join(tmpdir(), "aha-eval-v2-vault-"));
  process.env.AHA_BENCH_VAULT_ROOT = vaultRoot;

  assert.equal(
    normalizeFailureAttribution({
      primary: "retrieval_failure",
      flags: ["runtime_fallback", "source_self_hit"],
    }, "case-attribution").primary,
    "retrieval_failure",
  );
  assert.throws(
    () => normalizeFailureAttribution({ primary: "unknown_failure" }, "case-attribution"),
    /unknown failure_attribution primary/,
  );
  assert.throws(
    () => normalizeFailureAttribution({ primary: ["retrieval_failure", "rerank_failure"] }, "case-attribution"),
    /exactly one primary attribution/,
  );
  assert.throws(
    () => validateCase({
      id: "bad-attribution",
      _resolved_insight_input: "input",
      must_recall: ["Memory/must.md"],
      failure_attribution: { primary: "bad_group" },
    }),
    /unknown failure_attribution primary/,
  );

  await rm(vaultRoot, { recursive: true, force: true });
});

test("benchmark validation rejects duplicate identities across must, nice, and negative labels", async () => {
  const vaultRoot = await mkdtemp(path.join(tmpdir(), "aha-eval-v2-vault-"));
  process.env.AHA_BENCH_VAULT_ROOT = vaultRoot;

  assert.throws(
    () => validateCase({
      id: "duplicate-negative",
      _resolved_insight_input: "input",
      must_recall: ["Memory/same.md"],
      nice_to_have: [],
      negative: ["qmd://obsidian/Memory/same.md"],
    }),
    /duplicate canonical identities/,
  );
  await rm(vaultRoot, { recursive: true, force: true });
});

test("benchmark reader rejects malformed v3 gold arrays", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "aha-malformed-gold-"));
  const vaultRoot = await mkdtemp(path.join(tmpdir(), "aha-malformed-gold-vault-"));
  process.env.AHA_BENCH_VAULT_ROOT = vaultRoot;
  const casesPath = path.join(root, "cases.json");
  await writeFile(casesPath, JSON.stringify({
    collection: "obsidian",
    cases: [
      {
        id: "bad-gold",
        state: "active",
        input: { thought: "real input" },
        gold: { must: "Memory/not-array.md", nice: [], noise: [] },
      },
    ],
  }, null, 2));

  assert.throws(
    () => readBenchmarkCases(casesPath),
    /bad-gold: gold\.must must be an array/,
  );

  await rm(root, { recursive: true, force: true });
  await rm(vaultRoot, { recursive: true, force: true });
});

test("source note line ranges bound benchmark input and preview CLI output", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "aha-line-range-cases-"));
  const vaultRoot = await mkdtemp(path.join(tmpdir(), "aha-line-range-vault-"));
  process.env.AHA_BENCH_VAULT_ROOT = vaultRoot;
  await writeFile(path.join(vaultRoot, "Source.md"), [
    "line one should stay hidden",
    "line two is benchmark input",
    "line three is benchmark input",
    "line four should stay hidden",
  ].join("\n"));
  const casesPath = path.join(root, "cases.json");
  await writeFile(casesPath, JSON.stringify({
    collection: "obsidian",
    cases: [
      {
        id: "line-range-case",
        state: "active",
        input: {
          note: "Source.md",
          lines: [2, 3],
          thought: "extra thought",
        },
        gold: {
          must: ["Memory/must.md"],
          nice: [],
          noise: [],
        },
      },
    ],
  }, null, 2));

  const bench = readBenchmarkCases(casesPath);
  const input = bench.cases[0]._resolved_insight_input;
  assert.deepEqual(bench.cases[0].input.lines, [2, 3]);
  assert.deepEqual(bench.cases[0].must_recall, ["Memory/must.md"]);
  assert.match(input, /line two is benchmark input/);
  assert.match(input, /line three is benchmark input/);
  assert.doesNotMatch(input, /line one should stay hidden/);
  assert.doesNotMatch(input, /line four should stay hidden/);

  const unsafeCasesPath = path.join(root, "unsafe-cases.json");
  await writeFile(unsafeCasesPath, JSON.stringify({
    collection: "obsidian",
    cases: [
      {
        id: "unsafe-note-case",
        state: "active",
        input: { note: "Source.md" },
        gold: { must: ["Memory/must.md"], nice: [], noise: [] },
      },
    ],
  }, null, 2));
  assert.throws(
    () => readBenchmarkCases(unsafeCasesPath),
    /require input\.lines or explicit input\.whole_note: true/,
  );

  const preview = spawnSync("node", [
    "scripts/bench/extract-note-excerpt.mjs",
    "--note", "Source.md",
    "--lines", "2:3",
    "--vault-root", vaultRoot,
  ], {
    cwd: repoRoot,
    encoding: "utf-8",
  });
  assert.equal(preview.status, 0, preview.stderr || preview.stdout);
  assert.equal(preview.stdout.trim(), [
    "line two is benchmark input",
    "line three is benchmark input",
  ].join("\n"));

  const unsafePreview = spawnSync("node", [
    "scripts/bench/extract-note-excerpt.mjs",
    "--note", "Source.md",
    "--vault-root", vaultRoot,
  ], {
    cwd: repoRoot,
    encoding: "utf-8",
  });
  assert.notEqual(unsafePreview.status, 0);
  assert.match(unsafePreview.stderr, /line range is required/i);

  const wholeNoteCasesPath = path.join(root, "whole-note-cases.json");
  await writeFile(wholeNoteCasesPath, JSON.stringify({
    collection: "obsidian",
    cases: [
      {
        id: "whole-note-case",
        state: "draft",
        input: {
          note: "Source.md",
          whole_note: true,
          thought: "extra thought",
        },
        gold: {
          must: ["Memory/must.md"],
          nice: [],
          noise: [],
        },
      },
    ],
  }, null, 2));
  const wholeNotePreview = spawnSync("node", [
    "scripts/bench/extract-note-excerpt.mjs",
    "--case", "whole-note-case",
    "--cases", wholeNoteCasesPath,
    "--vault-root", vaultRoot,
    "--json",
  ], {
    cwd: repoRoot,
    encoding: "utf-8",
  });
  assert.equal(wholeNotePreview.status, 0, wholeNotePreview.stderr || wholeNotePreview.stdout);
  const wholeNotePayload = JSON.parse(wholeNotePreview.stdout);
  assert.equal(wholeNotePayload.whole_note, true);
  assert.match(wholeNotePayload.text, /line one should stay hidden/);
  assert.match(wholeNotePayload.text, /line four should stay hidden/);

  await rm(root, { recursive: true, force: true });
  await rm(vaultRoot, { recursive: true, force: true });
});

test("case lifecycle keeps normal runs active-only while includeDraft validates draft and excludes off", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "aha-eval-v2-cases-"));
  const vaultRoot = await mkdtemp(path.join(tmpdir(), "aha-eval-v2-vault-"));
  process.env.AHA_BENCH_VAULT_ROOT = vaultRoot;
  const casesPath = path.join(root, "cases.json");
  await writeFile(casesPath, JSON.stringify({
    collection: "obsidian",
    expected_in_top_k: 10,
    cases: [
      {
        id: "active-case",
        state: "active",
        input: { thought: "active input" },
        gold: { must: ["Memory/active.md"], nice: [], noise: [] },
      },
      {
        id: "draft-case",
        state: "draft",
        input: { thought: "draft input" },
        gold: { must: ["Memory/draft.md"], nice: [], noise: ["Memory/draft-noise.md"] },
      },
      {
        id: "off-case",
        state: "off",
        input: { thought: "off input" },
        gold: { must: ["Memory/off.md"], nice: [], noise: [] },
      },
      {
        id: "legacy-holdout-case",
        status: "holdout",
        insight_input: "legacy holdout input",
        must_recall: ["Memory/legacy-holdout.md"],
      },
    ],
  }, null, 2));

  const normal = readBenchmarkCases(casesPath);
  assert.deepEqual(normal.cases.map((item) => item.id), ["active-case"]);

  const withDrafts = readBenchmarkCases(casesPath, { includeDraft: true });
  assert.deepEqual(withDrafts.cases.map((item) => item.id), ["active-case", "draft-case"]);

  await rm(root, { recursive: true, force: true });
  await rm(vaultRoot, { recursive: true, force: true });
});

test("legacy report policy remains valid and attaches eval-v2 metrics when negatives are absent", () => {
  const report = {
    results: [
      {
        id: "legacy-case",
        backends: {
          full: {
            top_files: ["Memory/must.md", "Memory/other.md"],
          },
        },
      },
    ],
    summary: {
      full: {},
    },
  };

  const evaluated = applyBenchEvaluationPolicy(report, {
    expectedById: new Map([["legacy-case", ["Memory/must.md"]]]),
    queryMetaById: new Map(),
    caseById: new Map([["legacy-case", {
      topK: 10,
      niceTopK: 20,
      niceToHave: [],
      sourceNotePath: "",
    }]]),
  });

  const stats = evaluated.results[0].backends.full;
  assert.equal(stats.recall_at_k, 1);
  assert.equal(stats.eval_v2.must_recall_at_k, 1);
  assert.equal(stats.eval_v2.useful_precision_at_k, 0.1);
  assert.equal(stats.eval_v2.negative_rate_at_k, 0);
  assert.equal(evaluated.summary.full.eval_v2.avg_must_recall_at_k, 1);
});

test("pipeline summary exposes eval-v2 metrics, expanded-pool recall at 20, dropped must count, and stability", () => {
  const must = ["Memory/must-a.md", "Memory/must-b.md"];
  const nice = ["Memory/nice-a.md"];
  const negative = ["Memory/noise-a.md"];
  const pipelineFiles = [
    "Memory/must-a.md",
    "Memory/nice-a.md",
    "Memory/noise-a.md",
    "Memory/unlabeled-1.md",
    "Memory/unlabeled-2.md",
    "Memory/unlabeled-3.md",
    "Memory/unlabeled-4.md",
    "Memory/unlabeled-5.md",
    "Memory/unlabeled-6.md",
    "Memory/unlabeled-7.md",
  ];
  const expandedFiles = [
    ...pipelineFiles,
    "Memory/unlabeled-8.md",
    "Memory/unlabeled-9.md",
    "Memory/unlabeled-10.md",
    "Memory/unlabeled-11.md",
    "Memory/must-b.md",
  ];
  const pipelineScore = scoreResults(pipelineFiles, must, 10);
  const expandedScoreAt20 = scoreResults(expandedFiles, must, 20);
  const result = {
    qmd: {
      score: scoreResults(["Memory/must-a.md"], must, 10),
    },
    pipeline: {
      score: pipelineScore,
      nice_to_have: scoreNiceToHave(pipelineFiles, nice, 20),
      eval_v2: scoreEvalV2(pipelineFiles, {
        topK: 10,
        mustRecallFiles: must,
        niceToHaveFiles: nice,
        negativeFiles: negative,
      }),
      stability_at_k: 1,
    },
    expanded_pool: {
      score: scoreResults(expandedFiles, must, expandedFiles.length),
      score_at_20: expandedScoreAt20,
      recall_at_20: expandedScoreAt20.recall_at_k,
      dropped_from_final_top_k: ["Memory/must-b.md"],
      dropped_must_count: 1,
    },
    must_recall_sources: [
      { file: "Memory/must-a.md", source: "qmd_query", in_expanded_pool: true },
      { file: "Memory/must-b.md", source: "missing", in_expanded_pool: true },
    ],
  };

  const summary = summarizePipelineEvaluation([result]);

  assert.equal(summary.eval_v2.avg_must_recall_at_k, 0.5);
  assert.equal(summary.eval_v2.avg_useful_precision_at_k, 0.2);
  assert.equal(summary.eval_v2.avg_negative_rate_at_k, 0.1);
  assert.equal(summary.avg_expanded_pool_recall_at_20, 1);
  assert.equal(summary.dropped_must_count, 1);
  assert.equal(summary.avg_stability_at_10, 1);
});

test("dropped must count includes expanded-pool hits ranked outside final top ten", () => {
  const must = ["Memory/must-late.md"];
  const pipelineFiles = [
    "Memory/noise-01.md",
    "Memory/noise-02.md",
    "Memory/noise-03.md",
    "Memory/noise-04.md",
    "Memory/noise-05.md",
    "Memory/noise-06.md",
    "Memory/noise-07.md",
    "Memory/noise-08.md",
    "Memory/noise-09.md",
    "Memory/noise-10.md",
    "Memory/noise-11.md",
    "Memory/noise-12.md",
    "Memory/noise-13.md",
    "Memory/noise-14.md",
    "Memory/must-late.md",
  ];
  const expandedFiles = ["Memory/must-late.md", ...pipelineFiles.slice(0, 19)];
  const pipelineScore = scoreResults(pipelineFiles, must, 10);
  const expandedScoreAt20 = scoreResults(expandedFiles, must, 20);

  assert.equal(pipelineScore.recall_at_k, 0);
  assert.deepEqual(pipelineScore.unmatched_expected_files, []);
  assert.deepEqual(droppedMustFromExpandedPool(expandedScoreAt20, pipelineScore, 10), ["Memory/must-late.md"]);
});

test("generated pipeline attribution marks expanded-pool hit outside top ten as rerank failure", () => {
  const must = ["Memory/must-late.md"];
  const pipelineFiles = [
    "Memory/noise-01.md",
    "Memory/noise-02.md",
    "Memory/noise-03.md",
    "Memory/noise-04.md",
    "Memory/noise-05.md",
    "Memory/noise-06.md",
    "Memory/noise-07.md",
    "Memory/noise-08.md",
    "Memory/noise-09.md",
    "Memory/noise-10.md",
    "Memory/noise-11.md",
    "Memory/noise-12.md",
    "Memory/noise-13.md",
    "Memory/noise-14.md",
    "Memory/must-late.md",
  ];
  const expandedFiles = ["Memory/must-late.md", ...pipelineFiles.slice(0, 19)];
  const pipelineScore = scoreResults(pipelineFiles, must, 10);
  const expandedScoreAt20 = scoreResults(expandedFiles, must, 20);
  const dropped = droppedMustFromExpandedPool(expandedScoreAt20, pipelineScore, 10);
  const attribution = failureAttributionForPipelineCase(
    { id: "late-rerank" },
    {
      pipelineMissedAtTopKCount: Math.max(0, pipelineScore.total_expected - pipelineScore.hits_at_k),
      droppedMustCount: dropped.length,
      missingFromExpandedPool: expandedScoreAt20.unmatched_expected_files.length,
      sourceNoteRank: null,
      queryFallback: false,
      rerankFallback: false,
    },
  );

  assert.equal(attribution.primary, "rerank_failure");
  assert.deepEqual(attribution.flags, ["dropped_must_from_final_top_k"]);
});

test("pipeline summary groups failure attributions by primary category and flags", () => {
  const base = {
    qmd: {
      score: scoreResults([], ["Memory/must.md"], 10),
    },
    pipeline: {
      score: scoreResults([], ["Memory/must.md"], 10),
      nice_to_have: scoreNiceToHave([], [], 20),
      eval_v2: scoreEvalV2([], {
        topK: 10,
        mustRecallFiles: ["Memory/must.md"],
        niceToHaveFiles: [],
        negativeFiles: [],
      }),
      stability_at_k: 1,
    },
    must_recall_sources: [
      { file: "Memory/must.md", source: "missing", in_expanded_pool: false },
    ],
  };
  const summary = summarizePipelineEvaluation([
    {
      ...base,
      expanded_pool: {
        score: scoreResults([], ["Memory/must.md"], 20),
        score_at_20: scoreResults([], ["Memory/must.md"], 20),
        recall_at_20: 0,
        dropped_from_final_top_k: [],
        dropped_must_count: 0,
      },
      failure_attribution: {
        primary: "retrieval_failure",
        flags: ["missing_from_expanded_pool"],
      },
    },
    {
      ...base,
      expanded_pool: {
        score: scoreResults(["Memory/must.md"], ["Memory/must.md"], 20),
        score_at_20: scoreResults(["Memory/must.md"], ["Memory/must.md"], 20),
        recall_at_20: 1,
        dropped_from_final_top_k: ["Memory/must.md"],
        dropped_must_count: 1,
      },
      failure_attribution: {
        primary: "rerank_failure",
        flags: ["dropped_must_from_final_top_k"],
      },
    },
  ]);

  assert.equal(summary.failure_attribution_counts.retrieval_failure, 1);
  assert.equal(summary.failure_attribution_counts.rerank_failure, 1);
  assert.equal(summary.failure_attribution_counts.query_failure, 0);
  assert.equal(summary.failure_flag_counts.missing_from_expanded_pool, 1);
  assert.equal(summary.failure_flag_counts.dropped_must_from_final_top_k, 1);
});

test("summarize-report displays pipeline eval-v2 diagnostics", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "aha-eval-v2-report-"));
  const reportPath = path.join(root, "pipeline.json");
  await writeFile(reportPath, JSON.stringify({
    results: [{ id: "case-1", pipeline: true }],
    summary: {
      cases: 1,
      eval_v2: {
        avg_must_recall_at_k: 0.5,
        avg_useful_precision_at_k: 0.2,
        avg_ndcg_at_k: 0.75,
        avg_negative_rate_at_k: 0.1,
      },
      avg_expanded_pool_recall_at_20: 1,
      dropped_must_count: 1,
      avg_stability_at_10: 1,
      failure_attribution_counts: {
        retrieval_failure: 1,
        rerank_failure: 1,
      },
    },
  }, null, 2));

  const result = spawnSync("node", ["scripts/bench/summarize-report.mjs", reportPath], {
    cwd: repoRoot,
    encoding: "utf-8",
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Must Recall@10/);
  assert.match(result.stdout, /Useful Precision@10/);
  assert.match(result.stdout, /Expanded Pool Recall@20/);
  assert.match(result.stdout, /Dropped Must Count/);
  assert.match(result.stdout, /Stability@10/);
  assert.match(result.stdout, /Failure Attribution: retrieval_failure/);
  await rm(root, { recursive: true, force: true });
});
