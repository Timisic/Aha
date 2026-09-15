import assert from "node:assert/strict";
import test from "node:test";
import {
  createEmptySessionStore, recordSuccessfulSessionRound, appendSessionFeedback,
  normalizeSessionStore, savedThoughts, updateSavedThought, savedThoughtMarkdown,
} from "../../../lib/session-artifact.mjs";

function fixture() {
  const store = createEmptySessionStore();
  const source = { id: "src:test", path: "当前.md", title: "当前" };
  const candidate = { notePath: "历史.md", relation: "bounds", hit: "当时的历史原文", why: "当时的 AI 解释" };
  const result = { ok: true, sourcePath: source.path, candidates: [candidate] };
  const record = recordSuccessfulSessionRound(store, { source, result, generatedAt: new Date("2026-09-06T00:00:00Z") });
  appendSessionFeedback(record, { action: "surprise", createdAt: new Date("2026-09-06T00:01:00Z"), sourcePath: source.path, sourceTitle: source.title, candidate, sourceExcerpt: "保存时的当前原文" });
  return { store, record, source, result };
}

test("saved thoughts survive edits, JSON reload and reruns without replacing the evidence or growing feedback", () => {
  const { store, record, source, result } = fixture();
  const entry = savedThoughts(store)[0];
  updateSavedThought(record, entry.feedbackId, "我的理解\n第二行", new Date("2026-09-06T00:02:00Z"));
  recordSuccessfulSessionRound(store, { source, result: { ...result, candidates: [{ ...result.candidates[0], why: "重跑后的解释" }] }, generatedAt: new Date("2026-09-06T00:03:00Z") });
  const loaded = normalizeSessionStore(JSON.parse(JSON.stringify(store)));
  const saved = savedThoughts(loaded)[0];
  assert.equal(saved.feedbackId, entry.feedbackId);
  assert.equal(saved.feedback.note, "我的理解\n第二行");
  assert.equal(saved.feedback.why, "当时的 AI 解释");
  assert.equal(saved.feedback.sourceExcerpt, "保存时的当前原文");
  assert.equal(saved.feedback.updatedAt, "2026-09-06T00:02:00.000Z");
  assert.equal(loaded.records[record.key].feedback.length, 1);
  updateSavedThought(loaded.records[record.key], saved.feedbackId, "", new Date());
  assert.equal(savedThoughts(loaded).length, 1, "clearing prose must preserve Surprise and its evidence");
  assert.equal(savedThoughts(loaded)[0].feedback.note, undefined);
});

test("legacy Surprise can be edited after normalization without changing unrelated feedback", () => {
  const { store, record } = fixture();
  delete record.feedback[0].id;
  delete record.feedback[0].sourceExcerpt;
  record.feedback.push({ ...record.feedback[0], action: "accept", note: "保留原有反馈" });
  const loaded = normalizeSessionStore(JSON.parse(JSON.stringify(store)));
  const entry = savedThoughts(loaded)[0];
  assert.equal(savedThoughts(loaded).length, 1);
  updateSavedThought(loaded.records[record.key], entry.feedbackId, "后来补充", new Date());
  const again = normalizeSessionStore(JSON.parse(JSON.stringify(loaded)));
  assert.equal(savedThoughts(again)[0].feedbackId, entry.feedbackId);
  assert.equal(savedThoughts(again)[0].feedback.sourceExcerpt, undefined);
  assert.equal(again.records[record.key].feedback[1].note, "保留原有反馈");
  assert.throws(() => updateSavedThought(again.records[record.key], "missing", "不要写入", new Date()));
});

test("Markdown export distinguishes user writing from AI and preserves both source links", () => {
  const { store, record } = fixture();
  const entry = savedThoughts(store)[0];
  updateSavedThought(record, entry.feedbackId, "我的新想法", new Date());
  const markdown = savedThoughtMarkdown(entry);
  assert.match(markdown, /## 我的想法\n我的新想法/);
  assert.match(markdown, /当前笔记：\[\[当前\]\]/);
  assert.match(markdown, /历史笔记：\[\[历史\]\]/);
  assert.match(markdown, /### 当时的 AI 解释\n当时的 AI 解释/);
  assert.match(markdown, /> 保存时的当前原文/);
});
