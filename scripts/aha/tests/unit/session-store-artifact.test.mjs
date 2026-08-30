// Tests for the compiled session-store Node artifact
// (BATCH-VAULT-RUNNER-PLAN.md, scripts/lib/session-artifact.mjs). Imports go
// through the artifact loader on purpose: it rebuilds
// obsidian-plugin/dist/session.mjs from obsidian-plugin/src/session-index.ts
// before importing, so this test also exercises the rebuild path every run --
// the same convention as scripts/aha/tests/unit/core-note-identity.test.mjs
// for the "core" target.

import assert from "node:assert/strict";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createEmptySessionStore,
  normalizeSessionStore,
  recordFailedSessionRound,
  recordRunningSessionRound,
  recordSuccessfulSessionRound,
  sessionRecordKeyForSource,
  sourceIdentityForFile,
  appendSessionFeedback,
} from "../../../lib/session-artifact.mjs";

function fakeSource(overrides = {}) {
  return {
    id: "srcfs:test-id",
    path: "个人复盘/2026-01-01.md",
    title: "2026-01-01",
    ctime: 1_700_000_000_000,
    mtime: 1_700_000_100_000,
    size: 42,
    ...overrides,
  };
}

function fakeSuccessResult(overrides = {}) {
  return {
    ok: true,
    sourcePath: "个人复盘/2026-01-01.md",
    generatedAt: new Date().toISOString(),
    summary: "Found related notes.",
    warnings: [],
    error: null,
    candidates: [
      {
        notePath: "Memory/Old.md",
        noteTitle: "Old",
        relation: "supports",
        hit: "hit text",
        why: "why text",
        quotes: ["a quote"],
      },
    ],
    ...overrides,
  };
}

test("createEmptySessionStore has schemaVersion 1 and no records", () => {
  const store = createEmptySessionStore();
  assert.deepEqual(store, { schemaVersion: 1, records: {} });
});

test("recordSuccessfulSessionRound writes a success round with the candidates and summary", () => {
  const store = createEmptySessionStore();
  const source = fakeSource();
  const result = fakeSuccessResult();

  const record = recordSuccessfulSessionRound(store, { generatedAt: new Date(), result, source });

  assert.equal(record.source.id, source.id);
  assert.equal(record.rounds.length, 1);
  assert.equal(record.rounds[0].status, "success");
  assert.equal(record.rounds[0].summary, "Found related notes.");
  assert.equal(record.rounds[0].candidates.length, 1);
  assert.equal(record.rounds[0].candidates[0].notePath, "Memory/Old.md");
  assert.equal(record.latestSuccessfulRoundId, record.rounds[0].id);

  const key = sessionRecordKeyForSource(source.id, source.path);
  assert.equal(store.records[key], record);
});

test("recordFailedSessionRound writes a failed round without aborting the record", () => {
  const store = createEmptySessionStore();
  const source = fakeSource();

  const record = recordFailedSessionRound(store, {
    generatedAt: new Date(),
    source,
    failure: { message: "QMD timed out.", tool: "qmd", details: "boom" },
  });

  assert.equal(record.rounds.length, 1);
  assert.equal(record.rounds[0].status, "failed");
  assert.equal(record.rounds[0].error?.message, "QMD timed out.");
  assert.equal(record.rounds[0].candidates.length, 0);
  assert.equal(record.latestSuccessfulRoundId, undefined);
});

test("a failed round after a success does not clear the latest successful round", () => {
  const store = createEmptySessionStore();
  const source = fakeSource();

  recordSuccessfulSessionRound(store, { generatedAt: new Date(), result: fakeSuccessResult(), source });
  const key = sessionRecordKeyForSource(source.id, source.path);
  const successRoundId = store.records[key].latestSuccessfulRoundId;

  recordFailedSessionRound(store, {
    generatedAt: new Date(),
    source,
    failure: { message: "second run failed", tool: "pipeline" },
  });

  assert.equal(store.records[key].latestSuccessfulRoundId, successRoundId);
  assert.equal(store.records[key].rounds.length, 2);
});

test("rounds are pruned to a bounded count per record instead of growing unbounded", () => {
  const store = createEmptySessionStore();
  const source = fakeSource();
  const key = sessionRecordKeyForSource(source.id, source.path);

  for (let i = 0; i < 15; i += 1) {
    recordRunningSessionRound(store, { startedAt: new Date(Date.now() + i), source });
  }
  const lengthAt15 = store.records[key].rounds.length;
  assert.ok(lengthAt15 < 15, "rounds should already be capped before reaching 15 running rounds");

  for (let i = 15; i < 30; i += 1) {
    recordRunningSessionRound(store, { startedAt: new Date(Date.now() + i), source });
  }
  const lengthAt30 = store.records[key].rounds.length;
  assert.equal(lengthAt30, lengthAt15, "the cap should stay constant as more rounds are recorded");
});

test("pruning retains the latest successful round even after many later failures", () => {
  const store = createEmptySessionStore();
  const source = fakeSource();
  const key = sessionRecordKeyForSource(source.id, source.path);

  recordSuccessfulSessionRound(store, { generatedAt: new Date(0), result: fakeSuccessResult(), source });
  const successRoundId = store.records[key].latestSuccessfulRoundId;

  for (let i = 0; i < 20; i += 1) {
    recordFailedSessionRound(store, {
      generatedAt: new Date(1000 + i),
      source,
      failure: { message: `failure ${i}`, tool: "pipeline" },
    });
  }

  const rounds = store.records[key].rounds;
  assert.ok(rounds.some((round) => round.id === successRoundId), "the successful round must survive pruning");
});

test("normalizeSessionStore round-trips through JSON and keeps schemaVersion 1", () => {
  const store = createEmptySessionStore();
  const source = fakeSource();
  recordSuccessfulSessionRound(store, { generatedAt: new Date(), result: fakeSuccessResult(), source });

  const roundTripped = normalizeSessionStore(JSON.parse(JSON.stringify(store)));
  assert.equal(roundTripped.schemaVersion, 1);
  const key = sessionRecordKeyForSource(source.id, source.path);
  assert.equal(roundTripped.records[key].rounds.length, 1);
  assert.equal(roundTripped.records[key].rounds[0].candidates[0].notePath, "Memory/Old.md");
});

test("trace reference survives warning limits, JSON reload and later panel feedback", () => {
  const store = createEmptySessionStore();
  const source = fakeSource();
  const trace = { path: "/private/traces/笔记__20260830-220000.json", origin: "batch" };
  const result = { ...fakeSuccessResult(), trace, warnings: Array.from({ length: 20 }, (_, i) => `warning ${i}`) };
  recordSuccessfulSessionRound(store, { generatedAt: new Date(), result, source });
  const reopened = normalizeSessionStore(JSON.parse(JSON.stringify(store)));
  const key = sessionRecordKeyForSource(source.id, source.path);
  const record = reopened.records[key];
  assert.deepEqual(record.rounds[0].trace, trace);
  appendSessionFeedback(record, { action: "surprise", createdAt: new Date(), sourcePath: source.path, sourceTitle: source.title, candidate: record.rounds[0].candidates[0] });
  const reloaded = normalizeSessionStore(JSON.parse(JSON.stringify(reopened)));
  assert.deepEqual(reloaded.records[key].rounds[0].trace, trace);
  assert.equal(reloaded.records[key].feedback[0].action, "surprise");
  assert.equal(reloaded.records[key].rounds[0].candidates.length, 1);
});

test("normalizeSessionStore discards a malformed value instead of throwing", () => {
  assert.deepEqual(normalizeSessionStore(null), createEmptySessionStore());
  assert.deepEqual(normalizeSessionStore({ schemaVersion: 2, records: {} }), createEmptySessionStore());
  assert.deepEqual(normalizeSessionStore("not an object"), createEmptySessionStore());
});

test("sourceIdentityForFile is stable across repeated calls for the same file", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "aha-session-artifact-"));
  try {
    const filePath = path.join(dir, "note.md");
    await writeFile(filePath, "hello");
    const metadata = await stat(filePath);
    const fakeFile = { stat: { ctime: metadata.birthtimeMs } };

    const first = await sourceIdentityForFile(fakeFile, filePath);
    const second = await sourceIdentityForFile(fakeFile, filePath);
    assert.equal(first, second);
    assert.match(first, /^srcfs:/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("sessionRecordKeyForSource is stable for the same note across repeated runs", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "aha-session-artifact-"));
  try {
    const filePath = path.join(dir, "note.md");
    await writeFile(filePath, "hello");
    const metadata = await stat(filePath);
    const fakeFile = { stat: { ctime: metadata.birthtimeMs } };
    const id = await sourceIdentityForFile(fakeFile, filePath);

    const store = createEmptySessionStore();
    const source = fakeSource({ id, path: "note.md" });

    recordSuccessfulSessionRound(store, { generatedAt: new Date(), result: fakeSuccessResult(), source });
    recordSuccessfulSessionRound(store, { generatedAt: new Date(), result: fakeSuccessResult(), source });

    assert.equal(Object.keys(store.records).length, 1, "re-running the same note must reuse one record key");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
