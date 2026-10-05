import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "../../../..");
const require = createRequire(path.join(root, "obsidian-plugin/package.json"));
globalThis.require = require;
const temporary = await mkdtemp(path.join(tmpdir(), "aha-progressive-module-"));
const entry = path.join(temporary, "entry.ts");
await writeFile(entry, `export { QuickLinks } from ${JSON.stringify(path.join(root, "obsidian-plugin/src/quick-links.ts"))}; export { FileSystemAdapter, TFile } from "obsidian";`);
const bundle = path.join(temporary, "bundle.mjs");
await require("esbuild").build({
  entryPoints: [entry], outfile: bundle, bundle: true, platform: "node", format: "esm",
  plugins: [{ name: "obsidian", setup(build) {
    build.onResolve({ filter: /^obsidian$/ }, () => ({ path: "obsidian", namespace: "fixture" }));
    build.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ loader: "js", contents: `
      export class FileSystemAdapter { constructor(root) { this.root = root; } getBasePath() { return this.root; } }
      export class TFile { constructor(path) { this.path = path; this.basename = path.replace(/\\.md$/, ""); this.extension = "md"; } }
      export const editorInfoField = Symbol("editorInfoField");
    ` }));
  } }],
});
const { QuickLinks, FileSystemAdapter, TFile } = await import(pathToFileURL(bundle));
await rm(temporary, { recursive: true, force: true });

async function fixture(t) {
  const vault = await mkdtemp(path.join(tmpdir(), "aha-progressive-vault-"));
  t.after(() => rm(vault, { recursive: true, force: true }));
  for (const [file, body] of Object.entries({ "Source.md": "错误假设", "A.md": "开场无关。证据推翻原有认识。", "B.md": "实验帮助修正判断。" })) await writeFile(path.join(vault, file), body);
  const command = path.join(vault, "qmd.cjs");
  await writeFile(command, `#!${process.execPath}\nconsole.log(JSON.stringify([{file:${JSON.stringify(path.join(vault, "A.md"))},score:1},{file:${JSON.stringify(path.join(vault, "B.md"))},score:0.5}]));`);
  await chmod(command, 0o755);
  let respond;
  let received;
  const arrived = new Promise((resolve) => { received = resolve; });
  let observeClose;
  const closed = new Promise((resolve) => { observeClose = resolve; });
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const { documents } = JSON.parse(Buffer.concat(chunks).toString());
    respond = () => response.end(JSON.stringify({ results: documents.map((text, index) => ({ index, relevance_score: text.includes("证据") ? 1 : 0 })) }));
    response.on("close", observeClose);
    received();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const editor = {}, files = new Map(["Source.md", "A.md", "B.md"].map((p) => [p, new TFile(p)]));
  const file = files.get("Source.md"), doc = {};
  const app = { vault: { adapter: new FileSystemAdapter(vault), getAbstractFileByPath: (p) => files.get(p), cachedRead: (f) => readFile(path.join(vault, f.path), "utf8") }, metadataCache: { fileToLinktext: (f) => f.basename }, workspace: { activeEditor: { editor } } };
  const links = new QuickLinks(app, () => ({ qmdCommand: command, qmdIndex: "obsidian", qmdEnvironment: `QMD_REMOTE_RERANK_URL=http://127.0.0.1:${server.address().port}/rerank`, excludedFolders: "" }));
  const capture = { query: "错误假设", document: "错误假设", insertOffset: 4, editor, file, sourcePath: file.path, doc, request: new AbortController() };
  let state = { kind: "loading", capture };
  const edits = [];
  const view = { state: { doc, field: (field) => field === links.field ? state : { editor, file } }, dispatch(transaction) {
    for (const effect of Array.isArray(transaction.effects) ? transaction.effects : [transaction.effects]) if (effect?.is(links.change)) state = effect.value;
    if (transaction.changes) edits.push(transaction.changes);
  }, focus() {} };
  links.views.add(view);
  links.active = { view, capture, removeOutside() {} };
  const pending = links.recall(view, capture);
  await arrived;
  return { links, view, capture, pending, state: () => state, respond: () => respond(), closed, edits };
}

function key(links, view, value) {
  assert.equal(links.keydown({ key: value, preventDefault() {} }, view), true);
}

test("ranked candidates are selectable during reranking and excerpt completion preserves choices", async (t) => {
  const f = await fixture(t);
  assert.equal(f.state().kind, "ready");
  assert.deepEqual(f.state().candidates.map((c) => [c.file.path, c.excerpt]), [["A.md", null], ["B.md", null]]);
  key(f.links, f.view, " ");
  key(f.links, f.view, "ArrowDown");
  key(f.links, f.view, " ");
  f.respond();
  await f.pending;
  assert.equal(f.state().highlighted, 1);
  assert.deepEqual([...f.state().checked], ["A.md", "B.md"]);
  assert.deepEqual(f.state().candidates.map((c) => c.excerpt), [
    { text: "证据推翻原有认识。", method: "semantic", coverage: "complete" },
    { text: "实验帮助修正判断。", method: "semantic", coverage: "complete" },
  ]);
});

test("closing a selectable list aborts its pending HTTP request and cannot reopen the popup", async (t) => {
  const f = await fixture(t);
  key(f.links, f.view, "Escape");
  await f.closed;
  await f.pending;
  assert.equal(f.capture.request.signal.aborted, true);
  assert.deepEqual(f.state(), { kind: "closed" });
  assert.deepEqual(f.edits, []);
});

test("inserting while excerpts are pending performs one native link edit and cancels the request", async (t) => {
  const f = await fixture(t);
  key(f.links, f.view, "ArrowDown");
  key(f.links, f.view, "Enter");
  await f.closed;
  await f.pending;
  assert.deepEqual(f.edits, [{ from: 4, insert: " [[B]]" }]);
  assert.deepEqual(f.state(), { kind: "closed" });
  assert.equal(f.capture.request.signal.aborted, true);
});
