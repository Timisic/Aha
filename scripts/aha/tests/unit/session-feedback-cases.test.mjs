// Tests for scripts/lib/session-feedback-cases.mjs, the successor to the
// removed scripts/lib/review-seeds.mjs (see git history for
// "Remove Review Note markdown feature entirely"). Same job -- turn
// accept/reject_as_noise/should_have_found feedback into draft benchmark
// cases -- but the source is now Session Store feedback records (data.json
// shape) instead of parsed Review Note markdown.

import assert from "node:assert/strict";
import test from "node:test";
import { buildSessionFeedbackCaseDocument } from "../../../lib/session-feedback-cases.mjs";

function feedback(overrides = {}) {
  return {
    action: "accept",
    status: "draft",
    seedLabel: "nice_to_have",
    createdAt: "2026-06-30T01:00:00.000Z",
    sourcePath: "Source/Insight.md",
    sourceTitle: "Insight",
    memory: "Memory/Nice Candidate.md",
    relation: "resembles",
    hit: "hit text",
    why: "why text",
    ...overrides,
  };
}

function record(overrides = {}) {
  return {
    key: "srcfs:test-key",
    source: { path: "Source/Insight.md", title: "Insight" },
    feedback: [],
    ...overrides,
  };
}

test("aggregates accept/reject_as_noise/should_have_found feedback into one draft case per record", () => {
  const rec = record({
    feedback: [
      feedback({ action: "accept", seedLabel: "nice_to_have", memory: "Memory/Nice Candidate.md", createdAt: "2026-06-30T01:00:00.000Z" }),
      feedback({ action: "reject_as_noise", seedLabel: "negative", memory: "Memory/False Friend.md", createdAt: "2026-06-30T01:01:00.000Z" }),
      feedback({ action: "should_have_found", seedLabel: "must_recall", memory: "Memory/Missing Must.md", createdAt: "2026-06-30T01:02:00.000Z" }),
    ],
  });

  const document = buildSessionFeedbackCaseDocument([rec], { generatedAt: new Date("2026-06-30T02:00:00Z") });

  assert.equal(document.source, "session-store-feedback");
  assert.equal(document.version, 3);
  assert.equal(document.cases.length, 1);
  const caseItem = document.cases[0];
  assert.equal(caseItem.state, "draft");
  assert.deepEqual(caseItem.input, { note: "Source/Insight.md", whole_note: true });
  assert.deepEqual(caseItem.gold.must, ["Memory/Missing Must.md"]);
  assert.deepEqual(caseItem.gold.nice, ["Memory/Nice Candidate.md"]);
  assert.deepEqual(caseItem.gold.noise, ["Memory/False Friend.md"]);
  assert.equal(caseItem.expected_no_recall, undefined);
  assert.equal(caseItem.feedback_provenance.record_key, "srcfs:test-key");
  assert.equal(caseItem.feedback_provenance.feedback_count, 3);
});

test("accept-only feedback produces an expected-no-must draft case", () => {
  const rec = record({ feedback: [feedback()] });
  const document = buildSessionFeedbackCaseDocument([rec], { generatedAt: new Date("2026-06-30T02:00:00Z") });

  assert.equal(document.cases[0].expected_no_recall, true);
  assert.deepEqual(document.cases[0].gold.must, []);
  assert.deepEqual(document.cases[0].gold.nice, ["Memory/Nice Candidate.md"]);
});

test("a records with no feedback entries produces no case", () => {
  const document = buildSessionFeedbackCaseDocument([record({ feedback: [] })], { generatedAt: new Date() });
  assert.deepEqual(document.cases, []);
});

test("conflicting labels for the same memory resolve to the most recent feedback, with history recorded", () => {
  const rec = record({
    feedback: [
      feedback({ action: "accept", seedLabel: "nice_to_have", memory: "Memory/Conflict.md", createdAt: "2026-06-30T01:00:00.000Z" }),
      feedback({ action: "reject_as_noise", seedLabel: "negative", memory: "Memory/Conflict.md", createdAt: "2026-06-30T01:01:00.000Z" }),
    ],
  });

  const document = buildSessionFeedbackCaseDocument([rec], { generatedAt: new Date("2026-06-30T02:00:00Z") });
  const caseItem = document.cases[0];

  assert.deepEqual(caseItem.gold.nice, []);
  assert.deepEqual(caseItem.gold.noise, ["Memory/Conflict.md"]);
  assert.deepEqual(caseItem.feedback_label_conflicts, [
    { memory: "Memory/Conflict.md", seen_labels: ["nice", "noise"], resolved: "noise" },
  ]);
});

test("a later re-acceptance overturns an earlier reject_as_noise, not the other way around", () => {
  const rec = record({
    feedback: [
      feedback({ action: "reject_as_noise", seedLabel: "negative", memory: "Memory/Changed Mind.md", createdAt: "2026-06-30T01:00:00.000Z" }),
      feedback({ action: "accept", seedLabel: "nice_to_have", memory: "Memory/Changed Mind.md", createdAt: "2026-06-30T01:05:00.000Z" }),
    ],
  });

  const document = buildSessionFeedbackCaseDocument([rec], { generatedAt: new Date("2026-06-30T02:00:00Z") });
  const caseItem = document.cases[0];

  assert.deepEqual(caseItem.gold.nice, ["Memory/Changed Mind.md"]);
  assert.deepEqual(caseItem.gold.noise, []);
});

test("should_have_found memory text that doesn't look like a note path is flagged in warnings", () => {
  const rec = record({
    feedback: [
      feedback({ action: "should_have_found", seedLabel: "must_recall", memory: "那篇关于坚持的笔记", createdAt: "2026-06-30T01:00:00.000Z" }),
    ],
  });

  const document = buildSessionFeedbackCaseDocument([rec], { generatedAt: new Date("2026-06-30T02:00:00Z") });
  assert.equal(document.cases[0].gold.must.length, 1);
  assert.ok(document.warnings.some((warning) => warning.includes("does not look like a note path")));
});

test("should_have_found memory given as a [[wikilink]] resolves to a .md path", () => {
  const rec = record({
    feedback: [
      feedback({ action: "should_have_found", seedLabel: "must_recall", memory: "[[Memory/Missing Must|Missing Must]]", createdAt: "2026-06-30T01:00:00.000Z" }),
    ],
  });

  const document = buildSessionFeedbackCaseDocument([rec], { generatedAt: new Date("2026-06-30T02:00:00Z") });
  assert.deepEqual(document.cases[0].gold.must, ["Memory/Missing Must.md"]);
});

test("multiple records each produce their own case, sorted by id", () => {
  const recordA = record({
    key: "srcfs:a",
    source: { path: "A.md", title: "A" },
    feedback: [feedback({ memory: "Memory/A-target.md", createdAt: "2026-01-01T00:00:00.000Z" })],
  });
  const recordB = record({
    key: "srcfs:b",
    source: { path: "B.md", title: "B" },
    feedback: [feedback({ memory: "Memory/B-target.md", createdAt: "2026-01-01T00:00:00.000Z" })],
  });

  const document = buildSessionFeedbackCaseDocument([recordA, recordB], { generatedAt: new Date() });
  assert.equal(document.cases.length, 2);
  assert.deepEqual([...document.cases].sort((a, b) => a.id.localeCompare(b.id)).map((c) => c.id), document.cases.map((c) => c.id));
});

test("a feedback entry without a usable memory path is skipped with a warning, not a thrown error", () => {
  const rec = record({ feedback: [feedback({ memory: "" })] });
  const document = buildSessionFeedbackCaseDocument([rec], { generatedAt: new Date() });
  assert.deepEqual(document.cases, []);
  assert.ok(document.warnings.some((warning) => warning.includes("skipped")));
});

test("surprise feedback lands in gold.surprise, independent of accept/noise/must", () => {
  const rec = record({
    feedback: [
      feedback({ action: "surprise", seedLabel: "surprise", memory: "Memory/Surprising.md", createdAt: "2026-06-30T01:00:00.000Z" }),
    ],
  });

  const document = buildSessionFeedbackCaseDocument([rec], { generatedAt: new Date("2026-06-30T02:00:00Z") });
  const caseItem = document.cases[0];

  assert.deepEqual(caseItem.gold.surprise, ["Memory/Surprising.md"]);
  assert.deepEqual(caseItem.gold.nice, []);
  assert.equal(caseItem.expected_no_recall, true, "a surprise-only case still has no must-recall entries");
});

test("the same memory can be both accepted and marked surprising -- surprise never overwrites or is overwritten by nice/noise/must", () => {
  const rec = record({
    feedback: [
      feedback({ action: "accept", seedLabel: "nice_to_have", memory: "Memory/Both.md", createdAt: "2026-06-30T01:00:00.000Z" }),
      feedback({ action: "surprise", seedLabel: "surprise", memory: "Memory/Both.md", createdAt: "2026-06-30T01:01:00.000Z" }),
    ],
  });

  const document = buildSessionFeedbackCaseDocument([rec], { generatedAt: new Date("2026-06-30T02:00:00Z") });
  const caseItem = document.cases[0];

  assert.deepEqual(caseItem.gold.nice, ["Memory/Both.md"]);
  assert.deepEqual(caseItem.gold.surprise, ["Memory/Both.md"]);
  assert.equal(caseItem.feedback_label_conflicts, undefined, "surprise overlapping nice is not a label conflict");
});

test("a reject_as_noise on an already-surprising memory still records both, and does not conflict with surprise", () => {
  const rec = record({
    feedback: [
      feedback({ action: "surprise", seedLabel: "surprise", memory: "Memory/NoisySurprise.md", createdAt: "2026-06-30T01:00:00.000Z" }),
      feedback({ action: "reject_as_noise", seedLabel: "negative", memory: "Memory/NoisySurprise.md", createdAt: "2026-06-30T01:01:00.000Z" }),
    ],
  });

  const document = buildSessionFeedbackCaseDocument([rec], { generatedAt: new Date("2026-06-30T02:00:00Z") });
  const caseItem = document.cases[0];

  assert.deepEqual(caseItem.gold.noise, ["Memory/NoisySurprise.md"]);
  assert.deepEqual(caseItem.gold.surprise, ["Memory/NoisySurprise.md"]);
});
