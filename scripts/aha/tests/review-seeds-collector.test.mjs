import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildReviewSeedCaseDocument,
  parseReviewBenchmarkSeedsFromContent,
} from "../../lib/aha-review-seeds.mjs";
import { readBenchmarkCases } from "../../lib/aha-bench-common.mjs";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const previousVaultRoot = process.env.AHA_BENCH_VAULT_ROOT;

test.after(() => {
  if (previousVaultRoot === undefined) {
    delete process.env.AHA_BENCH_VAULT_ROOT;
  } else {
    process.env.AHA_BENCH_VAULT_ROOT = previousVaultRoot;
  }
});

test("review benchmark seeds aggregate into benchmark-like draft cases", () => {
  const content = reviewNoteWithSeeds([
    seedSection("2026-06-30T01:00:00.000Z", "accept", "nice_to_have", "[[Memory/Nice Candidate|Nice Candidate]]"),
    seedSection("2026-06-30T01:01:00.000Z", "reject_as_noise", "negative", "[[Memory/False Friend|False Friend]]"),
    seedSection("2026-06-30T01:02:00.000Z", "should_have_found", "must_recall", "[[Memory/Missing Must|Missing Must]]"),
  ]);

  const seeds = parseReviewBenchmarkSeedsFromContent(content, { reviewNotePath: "Aha/Reviews/Insight.md" });
  assert.deepEqual(seeds.map((seed) => [seed.action, seed.seedLabel, seed.memoryPath]), [
    ["accept", "nice_to_have", "Memory/Nice Candidate.md"],
    ["reject_as_noise", "negative", "Memory/False Friend.md"],
    ["should_have_found", "must_recall", "Memory/Missing Must.md"],
  ]);

  const document = buildReviewSeedCaseDocument([
    { path: "Aha/Reviews/Insight.md", content },
  ], { generatedAt: new Date("2026-06-30T02:00:00Z") });

  assert.equal(document.source, "review-benchmark-seeds");
  assert.equal(document.version, 3);
  assert.equal(document.cases.length, 1);
  assert.equal(document.cases[0].state, "draft");
  assert.deepEqual(document.cases[0].input, {
    note: "Source/Insight.md",
    whole_note: true,
  });
  assert.deepEqual(document.cases[0].gold.must, ["Memory/Missing Must.md"]);
  assert.deepEqual(document.cases[0].gold.nice, ["Memory/Nice Candidate.md"]);
  assert.deepEqual(document.cases[0].gold.noise, ["Memory/False Friend.md"]);
  assert.equal(document.cases[0].expected_no_recall, undefined);
  assert.equal(document.cases[0].seed_provenance.seed_count, 3);
  assert.deepEqual(document.cases[0].seed_provenance.review_note_paths, ["Aha/Reviews/Insight.md"]);
});

test("collector keeps accept-only seeds as valid expected-no-must draft cases", () => {
  const content = reviewNoteWithSeeds([
    seedSection("2026-06-30T01:00:00.000Z", "accept", "nice_to_have", "[[Memory/Nice Candidate]]"),
  ]);

  const document = buildReviewSeedCaseDocument([
    { path: "Aha/Reviews/Insight.md", content },
  ], { generatedAt: new Date("2026-06-30T02:00:00Z") });

  assert.equal(document.cases.length, 1);
  assert.equal(document.cases[0].expected_no_recall, true);
  assert.deepEqual(document.cases[0].gold.must, []);
  assert.deepEqual(document.cases[0].gold.nice, ["Memory/Nice Candidate.md"]);
});

test("collector resolves conflicting labels without emitting duplicate benchmark gold identities", () => {
  const content = reviewNoteWithSeeds([
    seedSection("2026-06-30T01:00:00.000Z", "accept", "nice_to_have", "[[Memory/Conflict]]"),
    seedSection("2026-06-30T01:01:00.000Z", "reject_as_noise", "negative", "[[Memory/Conflict]]"),
  ]);

  const document = buildReviewSeedCaseDocument([
    { path: "Aha/Reviews/Insight.md", content },
  ], { generatedAt: new Date("2026-06-30T02:00:00Z") });

  assert.deepEqual(document.cases[0].gold.nice, []);
  assert.deepEqual(document.cases[0].gold.noise, ["Memory/Conflict.md"]);
  assert.deepEqual(document.cases[0].seed_label_conflicts, [
    {
      memory: "Memory/Conflict.md",
      labels: ["noise", "nice"],
      resolution: "noise",
    },
  ]);
});

test("collect-review-seeds CLI writes draft cases that benchmark reader can validate", async () => {
  const root = await mkdtempDir("aha-review-seeds-cli-");
  const vault = path.join(root, "vault");
  const output = path.join(root, "aha-memory-seed-cases.json");
  await mkdir(path.join(vault, "Aha/Reviews"), { recursive: true });
  await mkdir(path.join(vault, "Source"), { recursive: true });
  await mkdir(path.join(vault, "Memory"), { recursive: true });
  await writeFile(path.join(vault, "Source/Insight.md"), "Source note text for benchmark input.\n");
  await writeFile(path.join(vault, "Memory/Missing Must.md"), "old memory\n");
  await writeFile(path.join(vault, "Memory/Nice Candidate.md"), "nice memory\n");
  await writeFile(path.join(vault, "Aha/Reviews/2026-06-30 Insight.md"), reviewNoteWithSeeds([
    seedSection("2026-06-30T01:00:00.000Z", "accept", "nice_to_have", "[[Memory/Nice Candidate]]"),
    seedSection("2026-06-30T01:01:00.000Z", "should_have_found", "must_recall", "[[Memory/Missing Must]]"),
  ]));

  const result = spawnSync("node", [
    "scripts/bench/collect-review-seeds.mjs",
    "--vault-root", vault,
    "--output", output,
  ], {
    cwd: repoRoot,
    encoding: "utf-8",
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(existsSync(output), true);
  const document = JSON.parse(await readFile(output, "utf-8"));
  assert.equal(document.cases.length, 1);
  assert.equal(document.cases[0].state, "draft");

  process.env.AHA_BENCH_VAULT_ROOT = vault;
  const bench = readBenchmarkCases(output, { includeDraft: true });
  assert.deepEqual(bench.cases.map((item) => item.id), [document.cases[0].id]);

  await rm(root, { recursive: true, force: true });
});

test("collector accepts an absolute review folder path", async () => {
  const root = await mkdtempDir("aha-review-seeds-absolute-");
  const vault = path.join(root, "vault");
  const reviewFolder = path.join(root, "external-reviews");
  await mkdir(reviewFolder, { recursive: true });
  await mkdir(path.join(vault, "Source"), { recursive: true });
  await mkdir(path.join(vault, "Memory"), { recursive: true });
  await writeFile(path.join(vault, "Source/Insight.md"), "Source note text.\n");
  await writeFile(path.join(vault, "Memory/Missing Must.md"), "old memory\n");
  await writeFile(path.join(reviewFolder, "2026-06-30 Insight.md"), reviewNoteWithSeeds([
    seedSection("2026-06-30T01:01:00.000Z", "should_have_found", "must_recall", "[[Memory/Missing Must]]"),
  ]));

  const result = spawnSync("node", [
    "scripts/bench/collect-review-seeds.mjs",
    "--vault-root", vault,
    "--review-folder", reviewFolder,
    "--dry-run",
  ], {
    cwd: repoRoot,
    encoding: "utf-8",
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const document = JSON.parse(result.stdout);
  assert.equal(document.cases.length, 1);
  assert.equal(document.cases[0].state, "draft");
  assert.deepEqual(document.cases[0].gold.must, ["Memory/Missing Must.md"]);

  await rm(root, { recursive: true, force: true });
});

async function mkdtempDir(prefix) {
  const { mkdtemp } = await import("node:fs/promises");
  return mkdtemp(path.join(tmpdir(), prefix));
}

function reviewNoteWithSeeds(seeds) {
  return [
    "---",
    "aha: review",
    'source_path: "Source/Insight.md"',
    'source: "[[Source/Insight|Insight]]"',
    'created: "2026-06-30T00:00:00.000Z"',
    "status: memory_review",
    "---",
    "",
    "# Aha 记忆审阅：Insight",
    "",
    "## Review Benchmark Seeds",
    "",
    "<!-- aha:review-benchmark-seeds:start -->",
    seeds.join("\n\n"),
    "<!-- aha:review-benchmark-seeds:end -->",
    "",
  ].join("\n");
}

function seedSection(createdAt, action, label, memory) {
  return [
    `### Review Benchmark Seed - ${createdAt}`,
    "",
    `- action: \`${action}\``,
    "- status: draft",
    `- seed_label: \`${label}\``,
    "- source: [[Source/Insight|Insight]]",
    `- memory: ${memory}`,
    "- relation: `supports`",
    "- hit: Evidence quote.",
    "- why: Human review marked this candidate as useful benchmark material.",
  ].join("\n");
}
