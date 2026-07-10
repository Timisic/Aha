import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  applyBenchEvaluationPolicy,
  droppedMustFromExpandedPool,
  normalizeFailureAttribution,
  readBenchmarkCases,
  scoreEvalV2,
  scoreNiceToHave,
  scoreResults,
  summarizePipelineEvaluation,
  validateCase,
} from "../../lib/bench-cases.mjs";

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

test("benchmark validation reports cross-label canonical identity conflicts without scoring them", async () => {
  const vaultRoot = await mkdtemp(path.join(tmpdir(), "aha-eval-v2-vault-"));
  process.env.AHA_BENCH_VAULT_ROOT = vaultRoot;
  await mkdir(path.join(vaultRoot, "Memory"), { recursive: true });
  await writeFile(path.join(vaultRoot, "Memory/same.md"), "same note\n");

  const identity = validateCase({
    id: "duplicate-negative",
    _resolved_insight_input: "input",
    must_recall: ["Memory/same.md"],
    nice_to_have: [],
    negative: ["qmd://obsidian/Memory/same.md"],
  });

  assert.equal(identity.status, "not_scored");
  assert.equal(identity.diagnostics.label_conflicts.length, 1);
  assert.deepEqual(identity.diagnostics.label_conflicts[0].labels, ["must", "noise"]);
  await rm(vaultRoot, { recursive: true, force: true });
});

test("benchmark reader resolves current and legacy labels through one canonical vault identity", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "aha-canonical-cases-"));
  const vaultRoot = path.join(root, "vault");
  process.env.AHA_BENCH_VAULT_ROOT = vaultRoot;
  await mkdir(path.join(vaultRoot, "Moved/New Folder"), { recursive: true });
  await mkdir(path.join(vaultRoot, "Memory/A"), { recursive: true });
  await mkdir(path.join(vaultRoot, "Memory/B"), { recursive: true });
  await writeFile(path.join(vaultRoot, "Moved/New Folder/Moved Note.md"), "moved note\n");
  await writeFile(path.join(vaultRoot, "Memory/A/Same.md"), "first\n");
  await writeFile(path.join(vaultRoot, "Memory/B/Same.md"), "second\n");
  const casesPath = path.join(root, "cases.json");
  await writeFile(casesPath, JSON.stringify({
    collection: "obsidian",
    cases: [
      {
        id: "equivalent-current-legacy",
        state: "active",
        input: { thought: "same logical gold note through two path forms" },
        gold: {
          must: ["Moved/Old Folder/Moved Note.md"],
          nice: [],
          noise: [],
        },
        must_recall: [path.join(vaultRoot, "Moved/New Folder/Moved Note.md")],
      },
      {
        id: "conflicting-current-legacy",
        state: "active",
        input: { thought: "conflicting migration labels" },
        gold: {
          must: ["Moved/New Folder/Moved Note.md"],
          nice: [],
          noise: [],
        },
        must_recall: ["Memory/A/Same.md"],
      },
      {
        id: "ambiguous-gold",
        state: "active",
        input: { thought: "ambiguous basename" },
        gold: { must: ["Same.md"], nice: [], noise: [] },
      },
      {
        id: "missing-gold",
        state: "active",
        input: { thought: "missing note" },
        gold: { must: ["Memory/Does Not Exist.md"], nice: [], noise: [] },
      },
    ],
  }, null, 2));

  const { cases } = readBenchmarkCases(casesPath);
  const byId = new Map(cases.map((item) => [item.id, item]));
  assert.equal(byId.get("equivalent-current-legacy").identity_evaluation.status, "ready");
  assert.deepEqual(
    byId.get("equivalent-current-legacy").identity_evaluation.gold.must,
    ["Moved/New Folder/Moved Note.md"],
  );
  assert.equal(byId.get("conflicting-current-legacy").identity_evaluation.status, "not_scored");
  assert.equal(byId.get("conflicting-current-legacy").identity_evaluation.diagnostics.schema_conflicts.length, 1);
  assert.equal(byId.get("ambiguous-gold").identity_evaluation.status, "not_scored");
  assert.equal(byId.get("ambiguous-gold").identity_evaluation.diagnostics.ambiguous.length, 1);
  assert.equal(byId.get("missing-gold").identity_evaluation.status, "not_scored");
  assert.equal(byId.get("missing-gold").identity_evaluation.diagnostics.not_found.length, 1);

  await rm(root, { recursive: true, force: true });
});

test("L1 CLI scores v3 and legacy labels through canonical identities and excludes invalid gold", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "aha-l1-canonical-cli-"));
  const vaultRoot = path.join(root, "vault");
  const binDir = path.join(root, "bin");
  const casesPath = path.join(root, "cases.json");
  const fixturePath = path.join(root, "fixture.json");
  const reportPath = path.join(root, "qmd.json");
  const qmdBin = path.join(binDir, "qmd.mjs");
  process.env.AHA_BENCH_VAULT_ROOT = vaultRoot;
  await mkdir(path.join(vaultRoot, "Memory/A"), { recursive: true });
  await mkdir(path.join(vaultRoot, "Memory/B"), { recursive: true });
  await mkdir(binDir, { recursive: true });
  await writeFile(path.join(vaultRoot, "Memory/Must Note.md"), "must\n");
  await writeFile(path.join(vaultRoot, "Memory/Nice Note.md"), "nice\n");
  await writeFile(path.join(vaultRoot, "Memory/Noise Note.md"), "noise\n");
  await writeFile(path.join(vaultRoot, "Memory/A/Same.md"), "first\n");
  await writeFile(path.join(vaultRoot, "Memory/B/Same.md"), "second\n");
  await writeFile(casesPath, JSON.stringify({
    collection: "obsidian",
    expected_in_top_k: 3,
    nice_expected_in_top_k: 3,
    suites: {
      development: { version: "dev-v1" },
      holdout: { version: "holdout-v1", frozen: true, change_reason: "Initial synthetic holdout." },
    },
    cases: [
      {
        id: "v3-case",
        state: "active",
        suite: "development",
        evaluation_mode: "discovery",
        provenance: { origin: "synthetic", reason: "L1 v3 scoring fixture." },
        input: { thought: "current schema" },
        gold: {
          must: [
            "Memory/Must Note.md",
            "qmd://obsidian/Memory/Must%20Note.md?index=obsidian",
          ],
          nice: ["qmd://obsidian/Memory/Nice%20Note.md?index=obsidian"],
          noise: [path.join(vaultRoot, "Memory/Noise Note.md")],
        },
      },
      {
        id: "legacy-case",
        status: "active",
        suite: "development",
        evaluation_mode: "discovery",
        provenance: { origin: "synthetic", reason: "L1 legacy compatibility fixture." },
        insight_input: "legacy schema",
        must_recall: ["Memory/Must Note.md"],
        nice_to_have: ["Memory/Nice Note.md"],
        negative: ["Memory/Noise Note.md"],
      },
      {
        id: "ambiguous-case",
        state: "active",
        suite: "development",
        evaluation_mode: "discovery",
        provenance: { origin: "synthetic", reason: "L1 ambiguous identity fixture." },
        input: { thought: "invalid gold identity" },
        gold: { must: ["Same.md"], nice: [], noise: [] },
      },
    ],
  }, null, 2));
  await writeFile(qmdBin, [
    "#!/usr/bin/env node",
    "import { readFileSync } from 'node:fs';",
    "const args = process.argv.slice(2);",
    "const fixture = JSON.parse(readFileSync(args[args.indexOf('bench') + 1], 'utf8'));",
    `const resultFiles = ${JSON.stringify([
      "qmd://obsidian/Memory/Must%20Note.md?index=obsidian",
      "Memory/Must Note.md",
      "Memory/Nice Note.md",
      path.join(vaultRoot, "Memory/Noise Note.md"),
    ])};`,
    "const results = fixture.queries.map((query) => ({",
    "  id: query.id,",
    "  backends: { full: { top_files: query.id === 'ambiguous-case' ? [] : resultFiles } },",
    "}));",
    "console.log(JSON.stringify({ results, summary: { full: {} } }));",
    "",
  ].join("\n"));
  await chmod(qmdBin, 0o755);

  const result = spawnSync("node", [
    "scripts/bench/run-qmd-bench.mjs",
    "--cases", casesPath,
    "--fixture", fixturePath,
    "--report", reportPath,
    "--qmd", qmdBin,
    "--query-generator", "rules",
  ], {
    cwd: repoRoot,
    encoding: "utf-8",
    env: { ...process.env, AHA_BENCH_VAULT_ROOT: vaultRoot },
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(await readFile(reportPath, "utf-8"));
  const byId = new Map(report.results.map((item) => [item.id, item.backends.full]));
  for (const id of ["v3-case", "legacy-case"]) {
    const stats = byId.get(id);
    assert.equal(stats.evaluation_status, "scored");
    assert.equal(stats.eval_v2.must_recall_at_k, 1);
    assert.equal(stats.eval_v2.useful_precision_at_k, 2 / 3);
    assert.equal(stats.eval_v2.negative_rate_at_k, 1 / 3);
    assert.equal(stats.total_expected, 1);
    assert.equal(stats.eval_v2.total_must_recall, 1);
    assert.equal(stats.duplicate_result_count, 1);
    assert.equal(stats.evaluation_top_files.length, 3);
  }
  assert.equal(byId.get("v3-case").identity_diagnostics.duplicates.length, 1);
  assert.equal(byId.get("ambiguous-case").evaluation_status, "not_scored");
  assert.equal(byId.get("ambiguous-case").eval_v2.must_recall_at_k, null);
  assert.equal(byId.get("ambiguous-case").identity_diagnostics.ambiguous.length, 1);
  assert.equal(report.summary.full.scored_cases, 2);
  assert.equal(report.summary.full.not_scored_cases, 1);
  assert.equal(report.summary.full.eval_v2.avg_must_recall_at_k, 1);

  await rm(root, { recursive: true, force: true });
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

test("normalize-case-paths rewrites vault-absolute case paths to vault-relative paths", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "aha-normalize-case-paths-"));
  const vaultRoot = path.join(root, "vault");
  process.env.AHA_BENCH_VAULT_ROOT = vaultRoot;
  await mkdir(path.join(vaultRoot, "Source"), { recursive: true });
  await mkdir(path.join(vaultRoot, "Memory"), { recursive: true });
  await writeFile(path.join(vaultRoot, "Source/Insight.md"), "line one\nline two\n");
  await writeFile(path.join(vaultRoot, "Memory/Must.md"), "must memory\n");
  await writeFile(path.join(vaultRoot, "Memory/Nice.md"), "nice memory\n");
  const casesPath = path.join(root, "cases.json");
  await writeFile(casesPath, JSON.stringify({
    collection: "obsidian",
    cases: [
      {
        id: "absolute-case",
        state: "active",
        input: {
          note: path.join(vaultRoot, "Source/Insight.md"),
          lines: [1, 1],
        },
        gold: {
          must: [path.join(vaultRoot, "Memory/Must.md")],
          nice: [path.join(vaultRoot, "Memory/Nice.md")],
          noise: [],
        },
      },
    ],
  }, null, 2));

  const result = spawnSync("node", [
    "scripts/bench/normalize-case-paths.mjs",
    casesPath,
    "--vault-root", vaultRoot,
  ], {
    cwd: repoRoot,
    encoding: "utf-8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);

  const document = JSON.parse(await readFile(casesPath, "utf-8"));
  assert.equal(document.cases[0].input.note, "Source/Insight.md");
  assert.deepEqual(document.cases[0].gold.must, ["Memory/Must.md"]);
  assert.deepEqual(document.cases[0].gold.nice, ["Memory/Nice.md"]);
  const bench = readBenchmarkCases(casesPath);
  assert.deepEqual(bench.cases.map((item) => item.id), ["absolute-case"]);

  await rm(root, { recursive: true, force: true });
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

test("pipeline summary exposes eval-v2 metrics and only aggregates measured stability", () => {
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
      stability: {
        status: "measured",
        metric: "top_k_overlap",
        top_k: 10,
        score: 0.75,
      },
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
  assert.equal(summary.avg_stability_at_10, 0.75);
  assert.deepEqual(summary.stability, {
    status: "measured",
    metric: "top_k_overlap",
    top_k: 10,
    measured_cases: 1,
    score: 0.75,
  });
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
      stability: {
        status: "not_measured",
        reason: "no_comparison_report",
        metric: "top_k_overlap",
        top_k: 10,
        score: null,
      },
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
        status: "attributed",
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
        status: "attributed",
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
  assert.equal(summary.unattributed_failure_count, 0);
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
      avg_stability_at_10: null,
      stability: {
        status: "not_measured",
        reason: "no_comparison_report",
        metric: "top_k_overlap",
        top_k: 10,
        measured_cases: 0,
        score: null,
      },
      failure_attribution_counts: {
        retrieval_failure: 1,
        rerank_failure: 1,
      },
      trace_diagnosis_counts: {
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
  assert.match(result.stdout, /not measured \(no_comparison_report\)/i);
  assert.match(result.stdout, /Failure Attribution: retrieval_failure/);
  assert.match(result.stdout, /Trace Diagnosis: rerank_failure/);
  await rm(root, { recursive: true, force: true });
});

test("pipeline benchmark emits structured PipelineTrace artifacts", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pipeline-trace-"));
  const vaultRoot = path.join(root, "vault");
  const binDir = path.join(root, "bin");
  const casesPath = path.join(root, "cases.json");
  const reportPath = path.join(root, "bench/reports/latest/pipeline.json");
  const qmdBin = path.join(binDir, "qmd");
  const obsidianBin = path.join(binDir, "obsidian");
  await mkdir(path.join(vaultRoot, "Memory"), { recursive: true });
  await mkdir(binDir, { recursive: true });
  await writeFile(path.join(vaultRoot, "Memory/must.md"), "Must memory body.\n");
  await writeFile(path.join(vaultRoot, "Memory/noise.md"), "Noise memory body.\n");
  await writeFile(path.join(vaultRoot, "Memory/linked.md"), "Realistic backlink evidence.\n");
  await writeFile(casesPath, JSON.stringify({
    collection: "obsidian",
    expected_in_top_k: 1,
    cases: [
      {
        id: "trace/rerank",
        state: "active",
        title: "Trace rerank miss",
        input: {
          thought: "A realistic insight where the useful old memory is not ranked first.",
        },
        gold: {
          must: ["Memory/must.md"],
          nice: [],
          noise: ["Memory/noise.md"],
        },
        why: "The must memory is present before rerank but outside the top review slot.",
      },
      {
        id: "trace:rerank",
        state: "active",
        title: "Trace rerank miss with colliding safe name",
        input: {
          thought: "A second case whose id sanitizes to the same base filename.",
        },
        gold: {
          must: ["Memory/must.md"],
          nice: [],
          noise: ["Memory/noise.md"],
        },
        why: "The trace artifact name must not collide with trace/rerank.",
      },
      {
        id: "trace-no-must",
        state: "draft",
        expected_no_recall: true,
        title: "Trace expected no recall",
        input: {
          thought: "A draft seed inbox case without required gold memories.",
        },
        gold: {
          must: [],
          nice: [],
          noise: [],
        },
        why: "No-must cases should not claim all required memories were recalled.",
      },
    ],
  }, null, 2));
  await writeFile(qmdBin, [
    "#!/usr/bin/env node",
    "const args = process.argv.slice(2);",
    "if (args.includes('--version')) { console.log('qmd-test 1.0'); process.exit(0); }",
    "console.log(JSON.stringify([",
    "  { file: 'Memory/noise.md', title: 'Noise memory', snippet: 'Noisy but tempting candidate.' },",
    "  { file: 'Memory/must.md', title: 'Must memory', snippet: 'Useful old memory evidence.' }",
    "]));",
    "",
  ].join("\n"));
  await writeFile(obsidianBin, [
    "#!/usr/bin/env node",
    "const args = process.argv.slice(2);",
    "if (args.includes('--version')) { console.log('obsidian-test 1.0'); process.exit(0); }",
    "if (args[0] === 'backlinks') { console.log(JSON.stringify([{ path: 'Memory/linked.md', title: 'Linked realistic memory', count: 1 }])); process.exit(0); }",
    "if (args[0] === 'read') { console.log('Realistic backlink evidence for the insight.'); process.exit(0); }",
    "console.log('ok');",
    "",
  ].join("\n"));
  await chmod(qmdBin, 0o755);
  await chmod(obsidianBin, 0o755);

  const result = spawnSync("node", [
    path.join(repoRoot, "scripts/bench/run-pipeline-bench.mjs"),
    "--cases",
    casesPath,
    "--report",
    reportPath,
    "--qmd",
    qmdBin,
    "--obsidian",
    obsidianBin,
    "--query-generator",
    "rules",
    "--query-mode",
    "raw-only",
    "--relation-judge",
    "none",
    "--include-draft",
  ], {
    cwd: root,
    encoding: "utf-8",
    env: {
      ...process.env,
      AHA_BENCH_VAULT_ROOT: vaultRoot,
    },
  });

  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(await readFile(reportPath, "utf-8"));
  const [caseResult, collidingCaseResult, noMustCaseResult] = report.results;
  assert.match(caseResult.trace_json, /^bench\/reports\/latest\/traces\/trace-rerank-[a-f0-9]{8}\.json$/);
  assert.match(collidingCaseResult.trace_json, /^bench\/reports\/latest\/traces\/trace-rerank-[a-f0-9]{8}\.json$/);
  assert.notEqual(caseResult.trace_json, collidingCaseResult.trace_json);
  assert.equal(report.summary.trace_diagnosis_counts.rerank_failure, 2);
  assert.equal(report.summary.trace_diagnosis_counts.none, 1);

  const trace = JSON.parse(await readFile(path.join(root, caseResult.trace_json), "utf-8"));
  assert.equal(trace.schema, "PipelineTrace");
  assert.equal(trace.case.id, "trace/rerank");
  assert.equal(trace.steps.query_generation.generated_by, "rules");
  assert.equal(trace.steps.qmd_runs[0].results[0].file, "Memory/noise.md");
  assert.equal(trace.steps.qmd_runs[0].results[0].rerank_id, "c001");
  assert.equal(trace.steps.qmd_runs[0].results[1].rerank_id, "c002");
  assert.equal(trace.steps.backlink_expansion.seeds[0].rerank_id, "c001");
  assert.equal(trace.steps.backlink_expansion.candidates[0].file, "Memory/linked.md");
  assert.equal(trace.steps.backlink_expansion.candidates[0].rerank_id, "c003");
  assert.equal(trace.steps.pre_rerank_candidates[0].rerank_id, "c001");
  assert.equal(trace.steps.pre_rerank_candidates[1].rerank_id, "c002");
  assert.equal(trace.steps.pre_rerank_candidates[2].rerank_id, "c003");
  assert.equal(trace.steps.pre_rerank_candidates[1].content_hash.length, 64);
  assert.equal("snippet" in trace.steps.pre_rerank_candidates[1], false);
  assert.equal(trace.steps.final_candidates[0].file, "Memory/noise.md");
  assert.deepEqual(trace.gold_positions.must[0], {
    file: "Memory/must.md",
    qmd_rank: 2,
    expanded_pool_rank: 2,
    final_rank: 2,
    in_review_budget: false,
    source: "qmd_query",
  });
  assert.equal(trace.gold_positions.noise[0].in_review_budget, true);
  assert.equal(trace.diagnosis.primary, "rerank_failure");
  assert.equal(trace.diagnosis.next_target, "rerank");
  assert.ok(trace.diagnosis.signals.includes("Required gold memory reached pre-rerank pool but missed the review attention budget."));

  const noMustTrace = JSON.parse(await readFile(path.join(root, noMustCaseResult.trace_json), "utf-8"));
  assert.equal(noMustTrace.diagnosis.primary, null);
  assert.ok(!noMustTrace.diagnosis.signals.includes("All required gold memories are inside the review attention budget."));

  const archiveFiles = (await readdir(path.join(root, "bench/reports/archive")))
    .filter((name) => name.endsWith(".json"));
  assert.equal(archiveFiles.length, 1);
  const archiveReportFile = archiveFiles[0];
  const archiveReport = JSON.parse(await readFile(path.join(root, "bench/reports/archive", archiveReportFile), "utf-8"));
  const archiveStem = path.basename(archiveReportFile, ".json");
  assert.match(
    archiveReport.results[0].trace_json,
    new RegExp(`^bench/reports/archive/traces/${archiveStem}/trace-rerank-[a-f0-9]{8}\\.json$`),
  );
  assert.notEqual(archiveReport.results[0].trace_json, report.results[0].trace_json);
  await readFile(path.join(root, archiveReport.results[0].trace_json), "utf-8");

  await rm(root, { recursive: true, force: true });
});
