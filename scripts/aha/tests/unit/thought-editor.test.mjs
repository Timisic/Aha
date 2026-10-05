import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "../../../..");
const require = createRequire(path.join(root, "obsidian-plugin/package.json"));
const temporary = await mkdtemp(path.join(tmpdir(), "aha-thought-editor-test-"));
const output = path.join(temporary, "editor.mjs");
await require("esbuild").build({
  entryPoints: [path.join(root, "obsidian-plugin/src/thought-editor.ts")],
  bundle: true, format: "esm", platform: "node", outfile: output,
});
const { renderThoughtEditor, ThoughtEditorShortcuts } = await import(pathToFileURL(output).href);
await rm(temporary, { recursive: true, force: true });

class Element extends EventTarget {
  constructor(document, options = {}) {
    super();
    this.ownerDocument = document;
    this.isConnected = true;
    this.children = [];
    this.className = options.cls ?? "";
    this.textContent = options.text ?? "";
    this.value = "";
    this.disabled = false;
  }
  createEl(_tag, options = {}) {
    const child = new Element(this.ownerDocument, options);
    this.children.push(child);
    return child;
  }
  createDiv(options) { return this.createEl("div", options); }
  createSpan(options) { return this.createEl("span", options); }
  setText(value) { this.textContent = value; }
  find(className) {
    return this.className === className ? this : this.children.map(child => child.find(className)).find(Boolean);
  }
}

function fixture(save) {
  const document = { activeElement: null };
  const parent = new Element(document);
  const shortcuts = new ThoughtEditorShortcuts();
  const entry = { recordKey: "source", feedbackId: "surprise", feedback: { note: "original", noteWrite: { status: "saved" } } };
  const drafts = new Map();
  const input = renderThoughtEditor(parent, entry, drafts, save, shortcuts);
  document.activeElement = input;
  input.value = "new thought";
  input.dispatchEvent(new Event("input"));
  const key = (options = {}) => shortcuts.handleKey({
    target: input, key: "Enter", metaKey: false, ctrlKey: false,
    shiftKey: false, altKey: false, isComposing: false, ...options,
  });
  return { input, document, drafts, key, status: parent.find("aha-thought-status") };
}

test("native scope Cmd+Enter saves once while pending and reports the written thought", async () => {
  const written = [];
  let complete;
  const pending = new Promise(resolve => { complete = resolve; });
  const { key, status, drafts } = fixture(async (entry, text) => {
    written.push({ feedbackId: entry.feedbackId, text });
    await pending;
  });
  assert.equal(key({ metaKey: true }), false);
  assert.equal(key({ metaKey: true }), false);
  assert.deepEqual(written, [{ feedbackId: "surprise", text: "new thought" }]);
  assert.equal(status.textContent, "保存中…");
  complete();
  await pending;
  await Promise.resolve();
  assert.equal(status.textContent, "已保存");
  assert.equal(drafts.size, 0);
  assert.equal(key({ metaKey: true }), false);
  assert.equal(written.length, 1);
});

test("plain Enter, IME, modified Enter and other targets remain available to parent scope", async () => {
  const written = [];
  const { key, input, document, status } = fixture(async (_entry, text) => { written.push(text); });
  for (const options of [
    {}, { metaKey: true, isComposing: true }, { metaKey: true, altKey: true },
    { ctrlKey: true, shiftKey: true }, { metaKey: true, key: "k" },
    { metaKey: true, target: new Element(document) },
  ]) assert.equal(key(options), undefined);
  document.activeElement = null;
  assert.equal(key({ metaKey: true }), undefined);
  document.activeElement = input;
  input.isConnected = false;
  assert.equal(key({ metaKey: true }), undefined);
  assert.deepEqual(written, []);
  assert.equal(status.textContent, "未保存到笔记");
  input.isConnected = true;
  assert.equal(key({ ctrlKey: true }), false);
  await Promise.resolve();
  assert.deepEqual(written, ["new thought"]);
  assert.equal(status.textContent, "已保存");
});
