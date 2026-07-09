import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  migrateLegacyReviewNote,
  migrateLegacyReviews,
  sessionRecordKeyForSource,
  sourcePathFromFrontmatter,
} from "../legacy-review-migration.mjs";

const execFileAsync = promisify(execFile);
const migrationScriptPath = new URL("../legacy-review-migration.mjs", import.meta.url);

test("legacy selected-memory review notes migrate into compact recoverable session records", () => {
  const result = migrateLegacyReviewNote({
    reviewPath: "Aha/Reviews/Insight Review.md",
    content: selectedMemoryReviewNote(),
    migratedAt: "2026-07-09T00:00:00.000Z",
  });

  assert.equal(result.ok, true);
  assert.equal(result.record.key, "srcfs:selected");
  assert.equal(result.record.source.path, "Source/Insight.md");
  assert.equal(result.record.source.title, "Insight");
  assert.equal(result.record.latestSuccessfulRoundId, "success:2026-07-08T12:00:00.000Z");
  assert.equal(result.record.rounds.length, 1);
  assert.equal(result.record.rounds[0].candidates.length, 2);
  assert.deepEqual(result.record.rounds[0].candidates.map((candidate) => candidate.selected), [true, false]);
  assert.equal(result.record.rounds[0].candidates[0].relation, "supports");
  assert.equal(result.record.rounds[0].candidates[0].hit, "\"Strong hit.\"");
  assert.deepEqual(result.record.rounds[0].candidates[0].quotes, ["\"Strong quote.\""]);
  assert.equal(result.record.feedback.length, 1);
  assert.equal(result.record.feedback[0].action, "should_have_found");
  assert.equal(result.record.feedback[0].seedLabel, "must_recall");
  assert.equal(result.record.feedback[0].memory, "Memory/Missing.md");

  const persisted = JSON.stringify(result.record);
  assert.doesNotMatch(persisted, /aha:selected-memories/);
  assert.doesNotMatch(persisted, /Review Benchmark Seed/);
  assert.doesNotMatch(persisted, /FULL_SOURCE_BODY_SHOULD_NOT_PERSIST/);
});

test("legacy grill-handoff-only review notes migrate as selected panel candidates", () => {
  const result = migrateLegacyReviewNote({
    reviewPath: "Aha/Reviews/Legacy Grill.md",
    content: grillOnlyReviewNote(),
    migratedAt: "2026-07-09T00:00:00.000Z",
  });

  assert.equal(result.ok, true);
  assert.equal(result.record.key, "srcfs:grill-only");
  assert.equal(result.record.source.path, "Source/Legacy.md");
  assert.equal(result.record.rounds[0].generatedAt, "2026-06-29T08:13:39.429Z");
  assert.equal(result.record.rounds[0].candidates.length, 2);
  assert.deepEqual(result.record.rounds[0].candidates.map((candidate) => candidate.selected), [true, true]);
  assert.equal(result.record.rounds[0].candidates[0].notePath, "Memory/First.md");
  assert.equal(result.record.rounds[0].candidates[0].relation, "supports");
  assert.equal(result.record.rounds[0].candidates[0].hit, "first hit");
  assert.match(result.record.rounds[0].candidates[0].why, /first candidate/);
});

test("legacy migration reports unmatched and ambiguous notes instead of guessing", async () => {
  const missing = migrateLegacyReviewNote({
    reviewPath: "Aha/Reviews/Missing.md",
    content: "---\nsource_id: srcfs:missing\nsource: \"[[Source/Missing]]\"\n---\nNo generated candidate block.",
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, "missing-recoverable-candidates");

  const result = await migrateLegacyReviews({
    reviews: [
      {
        reviewPath: "Aha/Reviews/Ambiguous.md",
        content: selectedMemoryReviewNote(),
      },
    ],
    existingData: {
      sessionStore: {
        schemaVersion: 1,
        records: {
          "srcfs:selected": existingRecord("srcfs:selected", "Other/Insight.md"),
        },
      },
    },
  });

  assert.equal(result.migrated.length, 0);
  assert.equal(result.unmatched.length, 1);
  assert.equal(result.unmatched[0].reason, "ambiguous-source-record");
  assert.equal(result.data.sessionStore.records["srcfs:selected"].source.path, "Other/Insight.md");
});

test("legacy migration preserves existing records and indexes migrated sources", async () => {
  const result = await migrateLegacyReviews({
    reviews: [
      {
        reviewPath: "Aha/Reviews/Insight Review.md",
        content: selectedMemoryReviewNote(),
      },
      {
        reviewPath: "Aha/Reviews/Legacy Grill.md",
        content: grillOnlyReviewNote(),
      },
    ],
    existingData: {
      reviewIndex: { "path:Existing/Old.md": "Aha/Reviews/Old.md" },
      sessionStore: {
        schemaVersion: 1,
        records: {
          "srcfs:orphan": existingRecord("srcfs:orphan", "Missing/Orphan.md"),
        },
      },
    },
    sourceStats: {
      "Aha/Reviews/Insight Review.md": { ctimeMs: 10, mtimeMs: 20, size: 30 },
    },
    migratedAt: "2026-07-09T01:00:00.000Z",
  });

  assert.deepEqual(result.unmatched, []);
  assert.equal(result.migrated.length, 2);
  const selectedKey = result.migrated.find((item) => item.reviewPath === "Aha/Reviews/Insight Review.md").key;
  assert.equal(result.data.sessionStore.records["srcfs:orphan"].source.path, "Missing/Orphan.md");
  assert.equal(result.data.sessionStore.records[selectedKey].source.size, 30);
  assert.equal(result.data.reviewIndex[selectedKey], "Aha/Reviews/Insight Review.md");
  assert.equal(result.data.reviewIndex["srcfs:selected\0Source/Insight.md"], "Aha/Reviews/Insight Review.md");
  assert.equal(result.data.reviewIndex["path:Source/Legacy.md"], "Aha/Reviews/Legacy Grill.md");
});

test("legacy migration rekeys existing source notes to the current filesystem identity", async () => {
  const sourceStat = {
    birthtimeMs: 1783497831990,
    ctimeMs: 1783497831990,
    dev: 1,
    ino: 200,
    mtimeMs: 1783583082882,
    size: 1010,
  };
  const currentSourceId = `srcfs:${hashToken([
    "aha-source-v3",
    String(sourceStat.dev),
    String(sourceStat.ino),
    String(Math.trunc(sourceStat.birthtimeMs)),
  ].join("\0"))}`;
  const result = await migrateLegacyReviews({
    reviews: [
      {
        reviewPath: "Aha/Reviews/Insight Review.md",
        content: selectedMemoryReviewNote(),
      },
    ],
    existingData: {
      reviewIndex: {},
      sessionStore: {
        schemaVersion: 1,
        records: {
          "srcfs:selected": existingRecord("srcfs:selected", "Source/Insight.md"),
        },
      },
    },
    sourceStats: {
      "Aha/Reviews/Insight Review.md": sourceStat,
    },
  });

  assert.deepEqual(result.unmatched, []);
  assert.equal(result.migrated[0].key, currentSourceId);
  assert.equal(result.data.sessionStore.records[currentSourceId].source.id, currentSourceId);
  assert.equal(result.data.sessionStore.records[currentSourceId].source.path, "Source/Insight.md");
  assert.equal(result.data.sessionStore.records["srcfs:selected"], undefined);
  assert.equal(result.data.reviewIndex[`srcfs:selected\0Source/Insight.md`], "Aha/Reviews/Insight Review.md");
});

test("legacy migration does not overwrite existing non-migration session records", async () => {
  const existing = existingRecord("srcfs:selected", "Source/Insight.md");
  existing.rounds = [
    {
      id: "success:2026-07-09T00:00:00.000Z",
      status: "success",
      generatedAt: "2026-07-09T00:00:00.000Z",
      sourcePath: "Source/Insight.md",
      sourceTitle: "Insight",
      sourceSnapshot: { path: "Source/Insight.md" },
      summary: "OpenAI generated 5 QMD queries; mixed retrieval returned 20 reranked candidates.",
      warnings: [],
      candidates: [],
    },
  ];
  existing.latestSuccessfulRoundId = "success:2026-07-09T00:00:00.000Z";
  existing.feedback = [
    {
      action: "accept",
      status: "draft",
      seedLabel: "nice_to_have",
      createdAt: "2026-07-09T00:01:00.000Z",
      sourcePath: "Source/Insight.md",
      sourceTitle: "Insight",
      memory: "Memory/Current.md",
    },
  ];

  const result = await migrateLegacyReviews({
    reviews: [
      {
        reviewPath: "Aha/Reviews/Insight Review.md",
        content: selectedMemoryReviewNote(),
      },
    ],
    existingData: {
      sessionStore: {
        schemaVersion: 1,
        records: {
          "srcfs:selected": existing,
        },
      },
    },
  });

  assert.equal(result.migrated.length, 0);
  assert.equal(result.unmatched.length, 1);
  assert.equal(result.unmatched[0].reason, "existing-session-record");
  assert.equal(result.data.sessionStore.records["srcfs:selected"].feedback.length, 1);
  assert.match(result.data.sessionStore.records["srcfs:selected"].rounds[0].summary, /OpenAI generated/);
});

test("legacy migration CLI writes a timestamped backup before mutating plugin data", async () => {
  const vaultRoot = await mkdtemp(path.join(tmpdir(), "aha-legacy-migration-"));
  try {
    const pluginRoot = path.join(vaultRoot, ".obsidian/plugins/aha-memory-surface");
    const reviewRoot = path.join(vaultRoot, "Aha/Reviews");
    await mkdir(pluginRoot, { recursive: true });
    await mkdir(reviewRoot, { recursive: true });
    await mkdir(path.join(vaultRoot, "Source"), { recursive: true });

    const originalData = {
      settings: { reviewFolder: "Aha/Reviews" },
      reviewIndex: {},
      sessionStore: { schemaVersion: 1, records: {} },
    };
    const pluginDataPath = path.join(pluginRoot, "data.json");
    await writeFile(pluginDataPath, `${JSON.stringify(originalData, null, 2)}\n`);
    await writeFile(path.join(vaultRoot, "Source/Insight.md"), "# Insight\n");
    await writeFile(path.join(reviewRoot, "Insight Review.md"), selectedMemoryReviewNote());

    const { stdout } = await execFileAsync(process.execPath, [
      migrationScriptPath.pathname,
      "--vault-root",
      vaultRoot,
      "--write",
    ]);
    const summary = JSON.parse(stdout);
    const nextData = JSON.parse(await readFile(pluginDataPath, "utf8"));
    const backupData = JSON.parse(await readFile(summary.backupPath, "utf8"));

    assert.equal(summary.write, true);
    assert.match(summary.backupPath, /legacy-review-migration-backup-/);
    await access(summary.backupPath);
    assert.deepEqual(backupData, originalData);
    assert.deepEqual(nextData.settings, originalData.settings);
    assert.equal(Object.keys(nextData.sessionStore.records).length, 1);
  } finally {
    await rm(vaultRoot, { recursive: true, force: true });
  }
});

test("legacy source path helpers prefer full wikilink paths and keep fallback keys stable", () => {
  assert.equal(sourcePathFromFrontmatter(selectedMemoryReviewNote()), "Source/Insight.md");
  assert.equal(sessionRecordKeyForSource("srcfs:stable", "Source/Insight.md"), "srcfs:stable");
  assert.equal(sessionRecordKeyForSource("src:fallback", "Source/Insight.md"), "src:fallback\0Source/Insight.md");
});

function selectedMemoryReviewNote() {
  return [
    "---",
    "source_id: srcfs:selected",
    "source_path: Insight.md",
    "source: \"[[Source/Insight]]\"",
    "---",
    "",
    "FULL_SOURCE_BODY_SHOULD_NOT_PERSIST",
    "",
    "<!-- aha:selected-memories:start -->",
    "### 纳入 Handoff 的记忆 - 2026-07-08T12:00:00.000Z",
    "",
    "1. [x] [[Memory/Strong]]",
    "   - relation: `supports`",
    "   - hit: \"Strong hit.\"",
    "   - why: Strong candidate should remain recoverable.",
    "   - quote: \"Strong quote.\"",
    "2. [ ] [[Memory/Weak]]",
    "   - relation: `weak`",
    "   - hit: Weak hit.",
    "   - why: Weak candidate stays visible but unselected.",
    "<!-- aha:selected-memories:end -->",
    "",
    "<!-- aha:review-benchmark-seeds:start -->",
    "### Review Benchmark Seed - 2026-07-08T12:05:00.000Z",
    "",
    "- action: `should_have_found`",
    "- seed_label: `must_recall`",
    "- source: [[Source/Insight]]",
    "- memory: [[Memory/Missing]]",
    "- note: Missing memory should remain a draft seed.",
    "<!-- aha:review-benchmark-seeds:end -->",
  ].join("\n");
}

function grillOnlyReviewNote() {
  return [
    "---",
    "source_id: srcfs:grill-only",
    "source_path: Legacy.md",
    "source: \"[[Source/Legacy]]\"",
    "---",
    "",
    "<!-- aha:grill-handoff:start -->",
    "### Grill Handoff - 2026-06-29T08:13:39.429Z",
    "",
    "当前 insight：[[Source/Legacy]]",
    "",
    "纳入 handoff 的旧笔记：",
    "- [[Memory/First]] (supports): first candidate should be recoverable. hit: first hit",
    "- [[Memory/Second]] (bounds): second candidate should be recoverable. hit: second hit",
    "<!-- aha:grill-handoff:end -->",
  ].join("\n");
}

function existingRecord(key, sourcePath) {
  return {
    schemaVersion: 1,
    key,
    source: {
      id: key,
      path: sourcePath,
      title: "Existing",
      fallbackPath: sourcePath,
    },
    rounds: [],
    feedback: [],
    updatedAt: "2026-07-08T00:00:00.000Z",
  };
}

function hashToken(value) {
  return createHash("sha256").update(value).digest("base64url").slice(0, 24);
}
