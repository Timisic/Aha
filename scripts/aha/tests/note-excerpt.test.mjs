import assert from "node:assert/strict";
import test from "node:test";

import { excerptNoteMarkdown } from "../../lib/note-excerpt.mjs";

test("excerptNoteMarkdown strips frontmatter, line numbers, and metadata lines", () => {
  const markdown = [
    "---",
    "create: 2026-06-21T00:00:00",
    "tags: []",
    "---",
    "1: 第一行正文内容",
    "2: 第二行正文内容",
    "",
    "emotion: Calm",
    "第三行没有行号",
  ].join("\n");
  const excerpt = excerptNoteMarkdown(markdown);
  assert.equal(excerpt.includes("create:"), false);
  assert.equal(excerpt.includes("emotion:"), false);
  assert.equal(excerpt.includes("1:"), false);
  assert.match(excerpt, /第一行正文内容/);
  assert.match(excerpt, /第三行没有行号/);
});

test("excerptNoteMarkdown passes through full content without truncation", () => {
  const longNote = Array.from({ length: 200 }, (_, i) => `第 ${i + 1} 行内容`).join("\n");
  const excerpt = excerptNoteMarkdown(longNote);
  assert.equal(excerpt.split("\n").length, 200);
  assert.match(excerpt, /第 200 行内容/);
});

test("excerptNoteMarkdown handles qmd get header prefix", () => {
  const markdown = [
    "qmd://obsidian/some-note.md",
    "---",
    "正文开始",
  ].join("\n");
  assert.match(excerptNoteMarkdown(markdown), /正文开始/);
});
