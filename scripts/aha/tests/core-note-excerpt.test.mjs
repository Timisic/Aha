// Tests for the shared-core note-excerpt module (ADR 0005, issue #56).
// Imports go through the core artifact loader on purpose: the loader
// rebuilds obsidian-plugin/dist/core.mjs from src/core before importing, so
// this test also exercises the rebuild path every run.
//
// Covers excerptNoteMarkdown / parseLineRange / normalizeLineRange /
// sliceLineRange / lineCount. scripts/lib/note-excerpt.mjs (the old
// bench-facing shim that re-exported these) was removed once every consumer
// switched to importing them from core-artifact.mjs directly.

import assert from "node:assert/strict";
import test from "node:test";
import {
  lineCount,
  normalizeLineRange,
  parseLineRange,
  sliceLineRange,
} from "../../lib/core-artifact.mjs";

test("parseLineRange accepts START:END, START-END, and START,END separators", () => {
  assert.deepEqual(parseLineRange("3:8"), { start: 3, end: 8 });
  assert.deepEqual(parseLineRange("3-8"), { start: 3, end: 8 });
  assert.deepEqual(parseLineRange("3,8"), { start: 3, end: 8 });
});

test("parseLineRange accepts a [start, end] array and returns undefined bounds for empty input", () => {
  assert.deepEqual(parseLineRange([2, 5]), { start: 2, end: 5 });
  assert.deepEqual(parseLineRange(""), { start: undefined, end: undefined });
  assert.deepEqual(parseLineRange(undefined), { start: undefined, end: undefined });
});

test("parseLineRange rejects malformed range strings", () => {
  assert.throws(() => parseLineRange("abc"), /Line range must be START:END/);
  assert.throws(() => parseLineRange("5"), /Line range must be START:END/);
});

test("normalizeLineRange rejects a non-positive start or an end before start", () => {
  assert.throws(() => normalizeLineRange(0, 5), /start must be a positive integer/);
  assert.throws(() => normalizeLineRange(-1, 5), /start must be a positive integer/);
  assert.throws(() => normalizeLineRange(5, 3), /end must be an integer >= start/);
  assert.deepEqual(normalizeLineRange(3, 3), { start: 3, end: 3 });
});

test("sliceLineRange returns the full content when no range is given", () => {
  const content = "a\nb\nc";
  assert.equal(sliceLineRange(content), content);
  assert.equal(sliceLineRange(content, {}), content);
});

test("sliceLineRange slices inclusive 1-based ranges and clamps end past EOF", () => {
  const content = "line1\nline2\nline3\nline4";
  assert.equal(sliceLineRange(content, { start: 2, end: 3 }), "line2\nline3");
  assert.equal(sliceLineRange(content, { start: 3, end: 999 }), "line3\nline4");
  assert.equal(sliceLineRange(content, { start: 1 }), content);
  assert.equal(sliceLineRange(content, { end: 2 }), "line1\nline2");
});

test("lineCount counts \\n-delimited lines and returns 0 for empty content", () => {
  assert.equal(lineCount(""), 0);
  assert.equal(lineCount(null), 0);
  assert.equal(lineCount("a\nb\nc"), 3);
  assert.equal(lineCount("a\r\nb\r\nc"), 3);
});
