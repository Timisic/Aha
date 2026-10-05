import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const repoRoot = path.resolve(import.meta.dirname, "../../../..");
const requireFromPlugin = createRequire(path.join(repoRoot, "obsidian-plugin/package.json"));
const temp = await mkdtemp(path.join(tmpdir(), "aha-quick-links-test-"));
const output = path.join(temp, "context.mjs");
await requireFromPlugin("esbuild").build({
  entryPoints: [path.join(repoRoot, "obsidian-plugin/src/quick-link-context.ts")],
  bundle: true, format: "esm", platform: "node", outfile: output,
});
const { captureQuickLinkContext, quickLinkInsertion, quickWikiLink } = await import(pathToFileURL(output).href);
await rm(temp, { recursive: true, force: true });

test("selected multiline text remains the query and inserts after either selection direction", () => {
  const document = "Before.\nA related thought\ncontinues here.\nAfter.";
  const start = document.indexOf("A related");
  const end = document.indexOf("\nAfter");
  const expected = { document, query: "A related thought\ncontinues here.", insertOffset: end };
  assert.deepEqual(captureQuickLinkContext(document, start, end), expected);
  assert.deepEqual(captureQuickLinkContext(document, end, start), expected);
});

test("caret uses the full blank-line-delimited paragraph, including text after the caret", () => {
  const document = "Older paragraph.\n\nFirst line.\nSecond line.\n\nLater paragraph.";
  const caret = document.indexOf("line.");
  assert.deepEqual(captureQuickLinkContext(document, caret, caret), {
    document, query: "First line.\nSecond line.", insertOffset: caret,
  });
});

test("blank lines use the nearest preceding paragraph and preserve the caret position", () => {
  const document = "One.\n\nTwo\ncontinued.\n\n  \nThree.";
  const caret = document.indexOf("  ") + 1;
  assert.deepEqual(captureQuickLinkContext(document, caret, caret), {
    document, query: "Two\ncontinued.", insertOffset: caret,
  });
  assert.equal(captureQuickLinkContext("\n\nLater.", 0, 0).query, "");
  assert.equal(captureQuickLinkContext("", 0, 0).query, "");
});

test("insertion preserves all source bytes and separates multiple links in one edit", () => {
  const document = "Before selected text after.";
  const offset = document.indexOf(" after");
  const insertion = quickLinkInsertion(document, offset, ["[[A]]", "[[B]]"]);
  assert.equal(document.slice(0, offset) + insertion + document.slice(offset), "Before selected text [[A]] [[B]] after.");
  assert.equal(quickLinkInsertion("ab", 1, ["[[A]]"]), " [[A]] ");
  assert.equal(quickLinkInsertion("a \nb", 2, ["[[A]]"]), "[[A]]");
  assert.equal(quickLinkInsertion("", 0, ["[[A]]"]), "[[A]]");
  assert.equal(quickLinkInsertion("a", 1, []), "");
});

test("wiki targets preserve native literal hash, percent, caret, folders and Unicode", () => {
  assert.equal(quickWikiLink("Folder/中文 note"), "[[Folder/中文 note]]");
  assert.equal(quickWikiLink("反例 #1"), "[[反例 #1]]");
  assert.equal(quickWikiLink("50% 预算"), "[[50% 预算]]");
  assert.equal(quickWikiLink("Note ^1"), "[[Note ^1]]");
});

test("unrepresentable native wiki targets are skipped instead of percent-encoded", () => {
  for (const target of ["[draft]", "pipe|name", "line\nbreak", "line\rbreak", "tab\tname", "control\u0000", "control\u007f", " "])
    assert.equal(quickWikiLink(target), null, target);
});
