import assert from "node:assert/strict";
import test from "node:test";
import { thoughtNoteBlock, applyThoughtNoteWrite, normalizeThoughtNoteWrite, normalizeSessionStore, savedThoughtText } from "../../../lib/session-artifact.mjs";

const write = (block, previousBlock) => ({ path: "Current.md", block, previousBlock, status: "pending" });

test("append contains only the wikilink and user text and preserves all original bytes", () => {
  const original = "---\ntitle: 原笔记\n---\n\n手写正文。  \n";
  const block = thoughtNoteBlock("Folder/过去.md", "我的想法。\n第二行。");
  assert.equal(block, "[[Folder/过去]]\n\n我的想法。\n第二行。");
  assert.equal(applyThoughtNoteWrite(original, write(block)), original + "\n" + block + "\n");
  assert.equal(applyThoughtNoteWrite("", write(block)), block + "\n");
});

test("editing replaces the saved paragraph without duplicating the link or touching later text", () => {
  const old = thoughtNoteBlock("Past.md", "第一次想法");
  const next = thoughtNoteBlock("Past.md", "修改后的想法");
  const original = `正文\n\n${old}\n\n后来写的段落。\n`;
  assert.equal(applyThoughtNoteWrite(original, write(next, old)), `正文\n\n${next}\n\n后来写的段落。\n`);
});

test("a pending append or edit can be retried after the note write succeeded", () => {
  const old = thoughtNoteBlock("Past.md", "原想法");
  const next = thoughtNoteBlock("Past.md", "新想法");
  const appended = applyThoughtNoteWrite("正文", write(old));
  assert.equal(applyThoughtNoteWrite(appended, write(old)), appended);
  const edited = applyThoughtNoteWrite(appended, write(next, old));
  assert.equal(applyThoughtNoteWrite(edited, write(next, old)), edited);
});

test("clearing and expanding a thought updates the link-only block correctly", () => {
  const link = thoughtNoteBlock("Past.md", "");
  const prose = thoughtNoteBlock("Past.md", "我的想法");
  const full = `正文\n\n${prose}\n`;
  const cleared = applyThoughtNoteWrite(full, write(link, prose));
  assert.equal(cleared, `正文\n\n${link}\n`);
  assert.equal(applyThoughtNoteWrite(cleared, write(link, prose)), cleared);
  assert.equal(applyThoughtNoteWrite(cleared, write(prose, link)), full);
  assert.equal(applyThoughtNoteWrite(full, write(prose, link)), full);
});

test("external edits and duplicate blocks fail closed instead of overwriting or appending", () => {
  const old = thoughtNoteBlock("Past.md", "原想法");
  const next = thoughtNoteBlock("Past.md", "新想法");
  assert.throws(() => applyThoughtNoteWrite("正文\n\n[[Past]]\n\n手动改写", write(next, old)), /已在原笔记中改动/);
  assert.throws(() => applyThoughtNoteWrite(`${old}\n\n${old}`, write(next, old)), /多段相同内容/);
  assert.throws(() => applyThoughtNoteWrite(`${old}\n\n${next}`, write(next, old)), /多段相同内容/);
});

test("the pending write journal survives session reload and malformed locators are ignored", () => {
  const pending = write(thoughtNoteBlock("Past.md", "想法"));
  const feedback = { action: "surprise", createdAt: new Date().toISOString(), sourcePath: "Current.md", sourceTitle: "Current", memory: "Past.md", noteWrite: pending };
  const loaded = normalizeSessionStore({ schemaVersion: 1, records: { test: { schemaVersion: 1, key: "test", source: { id: "test", path: "Current.md", title: "Current" }, rounds: [], feedback: [feedback] } } });
  const item = Object.values(loaded.records)[0].feedback[0];
  assert.deepEqual(item.noteWrite, pending);
  assert.equal(savedThoughtText(item), "想法", "an interrupted save must reopen the latest writing, not the old note field");
  assert.equal(normalizeThoughtNoteWrite({ path: "x", block: "", status: "saved" }), undefined);
  assert.throws(() => thoughtNoteBlock("bad\npath.md", "text"));
});
