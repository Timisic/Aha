import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  benchmarkCaseFingerprint,
  benchmarkHoldoutSnapshot,
  readBenchmarkCases,
  validateBenchmarkSuiteDocument,
  validateHoldoutTransition,
  validatePublicBenchmarkFixture,
} from "../../lib/bench-cases.mjs";

const previousVaultRoot = process.env.AHA_BENCH_VAULT_ROOT;

test.after(() => {
  if (previousVaultRoot === undefined) {
    delete process.env.AHA_BENCH_VAULT_ROOT;
  } else {
    process.env.AHA_BENCH_VAULT_ROOT = previousVaultRoot;
  }
});

test("legacy v3 cases remain readable but expose explicit suite migration diagnostics", async () => {
  const root = await benchmarkRoot("aha-legacy-suite-");
  const casesPath = path.join(root, "cases.json");
  await writeFile(casesPath, JSON.stringify({
    version: 3,
    collection: "obsidian",
    cases: [benchmarkCase({ id: "legacy-case" })],
  }, null, 2));

  const benchmark = readBenchmarkCases(casesPath);

  assert.equal(benchmark.cases.length, 1);
  assert.equal(benchmark.suiteEvaluation.status, "not_scored");
  assert.equal(benchmark.cases[0].suite_evaluation.status, "not_scored");
  assert.deepEqual(benchmark.cases[0].suite_evaluation.diagnostics.missing_suite, ["legacy-case"]);
  assert.deepEqual(benchmark.cases[0].suite_evaluation.diagnostics.missing_evaluation_mode, ["legacy-case"]);
  assert.deepEqual(benchmark.cases[0].suite_evaluation.diagnostics.missing_provenance, ["legacy-case"]);
  assert.throws(
    () => validateBenchmarkSuiteDocument(benchmark.input, benchmark.cases, { strict: true }),
    /benchmark suite validation failed/i,
  );

  await rm(root, { recursive: true, force: true });
});

test("strict suite validation accepts versioned development and frozen holdout cases", async () => {
  const root = await benchmarkRoot("aha-valid-suite-");
  const document = suiteDocument([
    benchmarkCase({
      id: "dev-discovery",
      suite: "development",
      evaluation_mode: "discovery",
      provenance: provenance("human_authored", "Curated development discovery case."),
    }),
    benchmarkCase({
      id: "holdout-graph",
      suite: "holdout",
      evaluation_mode: "graph_assisted",
      graph_evidence: [{ target: "Memory/Must.md", kind: "backlink" }],
      provenance: provenance("human_authored", "Frozen graph-assisted holdout case."),
    }),
  ]);

  const validation = validateBenchmarkSuiteDocument(document, document.cases, { strict: true });

  assert.equal(validation.status, "ready");
  assert.deepEqual(validation.suite_versions, {
    development: "dev-v1",
    holdout: "holdout-v1",
  });
  assert.deepEqual(
    validation.case_evaluations.map((item) => [item.id, item.suite, item.suite_version, item.evaluation_mode, item.status]),
    [
      ["dev-discovery", "development", "dev-v1", "discovery", "ready"],
      ["holdout-graph", "holdout", "holdout-v1", "graph_assisted", "ready"],
    ],
  );

  await rm(root, { recursive: true, force: true });
});

test("strict suite validation includes off cases even when runners pass only active cases", async () => {
  const root = await benchmarkRoot("aha-off-suite-validation-");
  const document = suiteDocument([
    benchmarkCase({
      id: "active-valid",
      suite: "development",
      evaluation_mode: "discovery",
      provenance: provenance("human_authored", "Runnable development case."),
    }),
    benchmarkCase({
      id: "off-invalid",
      state: "off",
      suite: "development",
      evaluation_mode: "discovery",
    }),
  ]);

  assert.throws(
    () => validateBenchmarkSuiteDocument(document, [document.cases[0]], { strict: true }),
    /missing_provenance/i,
  );

  await rm(root, { recursive: true, force: true });
});

test("suite validation surfaces graph-mode contradictions and pending draft mode review", async () => {
  const root = await benchmarkRoot("aha-mode-suite-");
  const document = suiteDocument([
    benchmarkCase({
      id: "discovery-with-graph",
      suite: "development",
      evaluation_mode: "discovery",
      graph_evidence: [{ target: "Memory/Must.md", kind: "source_link" }],
      provenance: provenance("human_authored", "Needs mode correction."),
    }),
    benchmarkCase({
      id: "graph-without-evidence",
      suite: "development",
      evaluation_mode: "graph_assisted",
      provenance: provenance("human_authored", "Missing declared graph evidence."),
    }),
    benchmarkCase({
      id: "draft-seed",
      state: "draft",
      suite: "development",
      evaluation_mode: "discovery",
      mode_review_required: true,
      provenance: provenance("session_feedback", "Uncurated feedback seed."),
    }),
  ]);

  const validation = validateBenchmarkSuiteDocument(document, document.cases);

  assert.equal(validation.status, "not_scored");
  assert.deepEqual(
    validation.diagnostics.graph_evidence_conflicts.map((item) => item.case_id),
    ["discovery-with-graph", "graph-without-evidence"],
  );
  assert.deepEqual(validation.diagnostics.mode_review_required, [{ case_id: "draft-seed" }]);

  await rm(root, { recursive: true, force: true });
});

test("canonical case fingerprints expose cross-suite leakage without banning shared gold alone", async () => {
  const root = await benchmarkRoot("aha-leakage-suite-");
  const leaked = benchmarkCase({
    id: "dev-leaked",
    suite: "development",
    evaluation_mode: "discovery",
    provenance: provenance("human_authored", "Development copy."),
  });
  const document = suiteDocument([
    leaked,
    { ...structuredClone(leaked), id: "holdout-leaked", suite: "holdout", provenance: provenance("human_authored", "Holdout copy.") },
    benchmarkCase({
      id: "holdout-shared-gold-only",
      suite: "holdout",
      evaluation_mode: "discovery",
      input: { thought: "A different input may legitimately target the same memory." },
      provenance: provenance("human_authored", "Different case sharing one gold note."),
    }),
  ]);

  const validation = validateBenchmarkSuiteDocument(document, document.cases);

  assert.equal(validation.status, "not_scored");
  assert.equal(validation.diagnostics.cross_suite_leakage.length, 1);
  assert.deepEqual(validation.diagnostics.cross_suite_leakage[0].case_ids, ["dev-leaked", "holdout-leaked"]);

  await rm(root, { recursive: true, force: true });
});

test("duplicate case ids invalidate a suite even when every copy stays in development", async () => {
  const root = await benchmarkRoot("aha-duplicate-id-suite-");
  const document = suiteDocument([
    benchmarkCase({
      id: "duplicate-development-id",
      suite: "development",
      evaluation_mode: "discovery",
      input: { thought: "First development case body." },
      provenance: provenance("human_authored", "First development case."),
    }),
    benchmarkCase({
      id: "duplicate-development-id",
      suite: "development",
      evaluation_mode: "discovery",
      input: { thought: "Second development case body." },
      provenance: provenance("human_authored", "Second development case."),
    }),
  ]);

  const validation = validateBenchmarkSuiteDocument(document, document.cases);

  assert.equal(validation.status, "not_scored");
  assert.deepEqual(validation.diagnostics.duplicate_case_ids, [{
    case_id: "duplicate-development-id",
    suites: ["development"],
  }]);
  assert.equal(validation.diagnostics.cross_suite_leakage.length, 0);
  assert.deepEqual(
    validation.case_evaluations.map((item) => item.status),
    ["not_scored", "not_scored"],
  );

  await rm(root, { recursive: true, force: true });
});

test("relation targets are not scored as discovery and graph-assisted evidence must cover every target", async () => {
  const root = await benchmarkRoot("aha-relation-mode-suite-");
  await writeFile(path.join(root, "vault/Memory/Second.md"), "second\n");
  const document = suiteDocument([
    benchmarkCase({
      id: "relation-as-discovery",
      suite: "development",
      evaluation_mode: "discovery",
      relation_targets: [{ note_path: "Memory/Must.md", relation: "supports" }],
      provenance: provenance("human_authored", "Relation judgment is graph-assisted."),
    }),
    benchmarkCase({
      id: "relation-with-incomplete-evidence",
      suite: "development",
      evaluation_mode: "graph_assisted",
      gold: {
        must: ["Memory/Must.md", "Memory/Second.md"],
        nice: ["Memory/Nice.md"],
        noise: ["Memory/Noise.md"],
      },
      relation_targets: [
        { note_path: "Memory/Must.md", relation: "supports" },
        { note_path: "Memory/Second.md", relation: "contradicts" },
      ],
      graph_evidence: [{ target: "Memory/Must.md", kind: "backlink" }],
      provenance: provenance("human_authored", "One relation target is not evidenced."),
    }),
    benchmarkCase({
      id: "relation-with-complete-evidence",
      suite: "development",
      evaluation_mode: "graph_assisted",
      gold: {
        must: ["Memory/Must.md", "Memory/Second.md"],
        nice: ["Memory/Nice.md"],
        noise: ["Memory/Noise.md"],
      },
      relation_targets: [
        { note_path: "Memory/Must.md", relation: "supports" },
        { note_path: "Memory/Second.md", relation: "contradicts" },
      ],
      graph_evidence: [
        { target: "Memory/Must.md", kind: "backlink" },
        { target: "Memory/Second.md", kind: "obsidian_graph" },
      ],
      provenance: provenance("human_authored", "Every relation target has graph evidence."),
    }),
  ]);

  const validation = validateBenchmarkSuiteDocument(document, document.cases);

  assert.equal(validation.status, "not_scored");
  assert.deepEqual(
    validation.diagnostics.graph_evidence_conflicts.filter((item) => item.reason.startsWith("relation_")),
    [
      {
        case_id: "relation-as-discovery",
        reason: "relation_targets_require_graph_assisted",
      },
      {
        case_id: "relation-with-incomplete-evidence",
        reason: "relation_target_missing_graph_evidence",
        target: "Memory/Second.md",
      },
    ],
  );
  assert.deepEqual(
    validation.case_evaluations.map((item) => [item.id, item.status]),
    [
      ["relation-as-discovery", "not_scored"],
      ["relation-with-incomplete-evidence", "not_scored"],
      ["relation-with-complete-evidence", "ready"],
    ],
  );

  await rm(root, { recursive: true, force: true });
});

test("holdout changes require a version change and an auditable reason", async () => {
  const root = await benchmarkRoot("aha-holdout-transition-");
  const previous = suiteDocument([
    benchmarkCase({
      id: "holdout-case",
      suite: "holdout",
      evaluation_mode: "discovery",
      provenance: provenance("human_authored", "Initial frozen holdout."),
    }),
  ]);
  const unchanged = structuredClone(previous);
  const changedWithoutVersion = structuredClone(previous);
  changedWithoutVersion.cases[0].input.thought = "Changed holdout input.";
  const changedWithoutReason = structuredClone(changedWithoutVersion);
  changedWithoutReason.suites.holdout.version = "holdout-v2";
  changedWithoutReason.suites.holdout.change_reason = "";
  const versionedChange = structuredClone(changedWithoutReason);
  versionedChange.suites.holdout.change_reason = "Replace an ambiguous input before the next frozen evaluation cycle.";

  assert.equal(validateHoldoutTransition(previous, unchanged).status, "unchanged");
  assert.deepEqual(
    validateHoldoutTransition(previous, changedWithoutVersion).diagnostics.holdout_version_not_changed,
    [{ previous_version: "holdout-v1", current_version: "holdout-v1" }],
  );
  assert.deepEqual(
    validateHoldoutTransition(previous, changedWithoutReason).diagnostics.missing_change_reason,
    [{ version: "holdout-v2" }],
  );
  assert.equal(validateHoldoutTransition(previous, versionedChange, { strict: true }).status, "versioned_change");

  await rm(root, { recursive: true, force: true });
});

test("case and holdout fingerprints include relation judgments and per-case scoring contracts", async () => {
  const root = await benchmarkRoot("aha-semantic-fingerprint-");
  await writeFile(path.join(root, "vault/Memory/Second.md"), "second\n");
  const baseCase = benchmarkCase({
    id: "holdout-semantic-contract",
    suite: "holdout",
    evaluation_mode: "graph_assisted",
    gold: {
      must: ["Memory/Must.md", "Memory/Second.md"],
      nice: ["Memory/Nice.md"],
      noise: ["Memory/Noise.md"],
    },
    graph_evidence: [{ target: "Memory/Must.md", kind: "backlink" }],
    relation_targets: [{ note_path: "Memory/Must.md", relation: "supports" }],
    expected_no_recall: false,
    expected_in_top_k: 10,
    nice_expected_in_top_k: 20,
    expanded_pool_expected_in_top_k: 30,
    provenance: provenance("human_authored", "Frozen semantic scoring contract."),
  });
  const baseDocument = suiteDocument([baseCase]);
  const baseFingerprint = benchmarkCaseFingerprint(baseCase);
  const holdoutSnapshot = benchmarkHoldoutSnapshot(baseDocument);
  const absoluteAlias = structuredClone(baseCase);
  absoluteAlias.relation_targets[0].note_path = path.join(root, "vault/Memory/Must.md");

  assert.equal(benchmarkCaseFingerprint(absoluteAlias), baseFingerprint);
  assert.deepEqual(holdoutSnapshot, {
    version: "holdout-v1",
    frozen: true,
    change_reason: "Initial frozen holdout suite.",
    fingerprint: holdoutSnapshot.fingerprint,
  });
  assert.match(holdoutSnapshot.fingerprint, /^[a-f0-9]{64}$/);

  const mutations = [
    (caseItem) => { caseItem.relation_targets[0].relation = "contradicts"; },
    (caseItem) => { caseItem.relation_targets[0].note_path = "Memory/Second.md"; },
    (caseItem) => { caseItem.expected_no_recall = true; },
    (caseItem) => { caseItem.expected_in_top_k = 11; },
    (caseItem) => { caseItem.nice_expected_in_top_k = 21; },
    (caseItem) => { caseItem.expanded_pool_expected_in_top_k = 31; },
  ];
  for (const mutate of mutations) {
    const changed = structuredClone(baseDocument);
    mutate(changed.cases[0]);
    assert.notEqual(benchmarkCaseFingerprint(changed.cases[0]), baseFingerprint);
    const transition = validateHoldoutTransition(baseDocument, changed);
    assert.equal(transition.changed, true);
    assert.deepEqual(transition.diagnostics.holdout_version_not_changed, [{
      previous_version: "holdout-v1",
      current_version: "holdout-v1",
    }]);
  }

  await rm(root, { recursive: true, force: true });
});

test("public benchmark fixture validation enforces synthetic provenance and sanitized relative paths", () => {
  const valid = {
    privacy: "sanitized-synthetic",
    ...suiteDocument([
      benchmarkCase({
        id: "public-synthetic",
        suite: "development",
        evaluation_mode: "discovery",
        input: { note: "Sanitized/Source.md", lines: [1, 2], thought: "Synthetic thought." },
        gold: {
          must: ["Sanitized/Must.md"],
          nice: ["Sanitized/Nice.md"],
          noise: ["Sanitized/Noise.md"],
        },
        provenance: provenance("synthetic", "Repository-owned sanitized fixture."),
      }),
    ]),
  };
  const invalid = structuredClone(valid);
  invalid.cases[0].provenance.origin = "human_authored";
  invalid.cases[0].gold.must = ["/Users/private/Obsidian Notes/Real Note.md"];
  invalid.cases[0].raw_note_body = "Private note body";

  assert.equal(validatePublicBenchmarkFixture(valid, { strict: true }).status, "ready");
  const validation = validatePublicBenchmarkFixture(invalid);
  assert.equal(validation.status, "unsafe");
  assert.equal(validation.diagnostics.non_synthetic_provenance.length, 1);
  assert.equal(validation.diagnostics.private_paths.length, 1);
  assert.equal(validation.diagnostics.forbidden_content_fields.length, 1);
  assert.throws(
    () => validatePublicBenchmarkFixture(invalid, { strict: true }),
    /public benchmark fixture validation failed/i,
  );
});

test("public fixture privacy validation finds private paths in arbitrary nested strings without flagging prose", () => {
  const document = {
    privacy: "sanitized-synthetic",
    description: "Synthetic prose may discuss retrieval/feedback and link to https://example.com/docs.",
    ...suiteDocument([
      benchmarkCase({
        id: "nested-private-path",
        suite: "development",
        evaluation_mode: "discovery",
        input: { thought: "Synthetic thought with no local path." },
        gold: {
          must: ["Sanitized/Must.md"],
          nice: [],
          noise: [],
        },
        provenance: provenance("synthetic", "Derived from a repository-owned synthetic scenario."),
        metadata: {
          source_description: "Originally copied from /Users/alice/Obsidian Notes/Private.md",
        },
      }),
    ]),
  };

  const validation = validatePublicBenchmarkFixture(document);

  assert.equal(validation.status, "unsafe");
  assert.deepEqual(validation.diagnostics.private_paths, [{
    case_id: "nested-private-path",
    field: "cases[0].metadata.source_description",
    kind: "private_absolute_path",
  }]);
  delete document.cases[0].metadata;
  assert.equal(validatePublicBenchmarkFixture(document, { strict: true }).status, "ready");
});

test("the tracked benchmark example satisfies the public privacy contract", async () => {
  const examplePath = path.resolve(import.meta.dirname, "../../../bench/aha-memory-cases.example.json");
  const document = JSON.parse(await readFile(examplePath, "utf-8"));

  assert.equal(validatePublicBenchmarkFixture(document, { strict: true }).status, "ready");
});

async function benchmarkRoot(prefix) {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  const vault = path.join(root, "vault");
  process.env.AHA_BENCH_VAULT_ROOT = vault;
  await mkdir(path.join(vault, "Memory"), { recursive: true });
  await writeFile(path.join(vault, "Memory/Must.md"), "must\n");
  await writeFile(path.join(vault, "Memory/Nice.md"), "nice\n");
  await writeFile(path.join(vault, "Memory/Noise.md"), "noise\n");
  return root;
}

function suiteDocument(cases) {
  return {
    version: 3,
    collection: "obsidian",
    suites: {
      development: { version: "dev-v1" },
      holdout: {
        version: "holdout-v1",
        frozen: true,
        change_reason: "Initial frozen holdout suite.",
      },
    },
    cases,
  };
}

function benchmarkCase(overrides = {}) {
  return {
    id: "case",
    state: "active",
    title: "Synthetic benchmark case",
    input: { thought: "A synthetic insight input." },
    gold: {
      must: ["Memory/Must.md"],
      nice: ["Memory/Nice.md"],
      noise: ["Memory/Noise.md"],
    },
    why: "Synthetic test fixture.",
    ...overrides,
  };
}

function provenance(origin, reason) {
  return { origin, reason };
}
