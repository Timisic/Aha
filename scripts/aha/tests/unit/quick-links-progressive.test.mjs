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

async function fixture(t, extraBodies = {}) {
  const vault = await mkdtemp(path.join(tmpdir(), "aha-progressive-vault-"));
  t.after(() => rm(vault, { recursive: true, force: true }));
  const bodies = { "Source.md": "错误假设", ...extraBodies, "A.md": "开场无关。证据推翻原有认识。", "B.md": "实验帮助修正判断。" };
  for (const [file, body] of Object.entries(bodies)) await writeFile(path.join(vault, file), body);
  const command = path.join(vault, "qmd.cjs");
  const rows = Object.keys(bodies).filter((file) => file !== "Source.md").map((file, index) => ({ file: path.join(vault, file), score: 1 - index / 100 }));
  await writeFile(command, `#!${process.execPath}\nconsole.log(${JSON.stringify(JSON.stringify(rows))});`);
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
  const editor = {}, files = new Map(Object.keys(bodies).map((p) => [p, new TFile(p)]));
  const file = files.get("Source.md"), doc = {};
  const app = { vault: { adapter: new FileSystemAdapter(vault), getAbstractFileByPath: (p) => files.get(p), cachedRead: (f) => readFile(path.join(vault, f.path), "utf8") }, metadataCache: { fileToLinktext: (f) => f.basename }, workspace: { activeEditor: { editor } } };
  const links = new QuickLinks(app, () => ({ qmdCommand: command, qmdIndex: "obsidian", qmdEnvironment: `QMD_REMOTE_RERANK_URL=http://127.0.0.1:${server.address().port}/rerank`, excludedFolders: "" }));
  const capture = { query: "错误假设", document: "错误假设", insertOffset: 4, editor, file, sourcePath: file.path, doc, request: new AbortController() };
  let state = { kind: "loading", capture };
  const edits = [];
  const view = { dom: { ownerDocument: { querySelector: () => null } }, state: { doc, field: (field) => field === links.field ? state : { editor, file } }, dispatch(transaction) {
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

function popupFixture(f) {
  class Element {
    constructor(document) {
      this.ownerDocument = document;
      this.children = Object.assign([], { item(index) { return this[index] ?? null; } });
      this.dataset = {};
      this.attributes = new Map();
      this.className = "";
      this.classList = { toggle() {} };
      this.scrollTop = 0;
      this.clientHeight = 200;
      this.scrollHeight = 1000;
      this.top = 0;
      this.textContent = "";
    }
    append(...children) { for (const child of children) { child.parent = this; this.children.push(child); } }
    replaceChildren() { this.children.length = 0; }
    setAttribute(name, value) { this.attributes.set(name, value); }
    addEventListener() {}
    getBoundingClientRect() { return { top: this.top - (this.parent?.scrollTop ?? 0) }; }
    querySelector(selector) {
      const name = selector.slice(1);
      for (const child of this.children) {
        if (child.className.split(" ").includes(name)) return child;
        const match = child.querySelector(selector);
        if (match) return match;
      }
      return null;
    }
  }
  const document = { defaultView: { HTMLElement: Element }, createElement: () => new Element(document), querySelector: (selector) => dom.querySelector(selector) };
  const dom = new Element(document);
  f.view.dom = { ownerDocument: document };
  const dispatch = f.view.dispatch;
  f.view.dispatch = (transaction) => { dispatch(transaction); f.links.render(f.view, dom); };
  f.links.render(f.view, dom);
  return { dom, list: () => dom.querySelector(".aha-quick-links-list") };
}

function clippedPopupFixture({ position = "fixed", scaleX = 1, scaleY = 1, height = 900 } = {}) {
  const ancestor = {
    parentElement: null, offsetWidth: 350, offsetHeight: 702, clientWidth: 350, clientHeight: 702,
    clientLeft: 0, clientTop: 0,
    getBoundingClientRect: () => ({ left: 300, right: 650, top: 78, bottom: 780, width: 350, height: 702 }),
  };
  const origin = position === "absolute" ? { left: 200, top: 30 } : { left: 0, top: 0 };
  const style = { position, left: `${(270 - origin.left) / scaleX}px`, top: `${(0 - origin.top) / scaleY}px`, maxWidth: "", maxHeight: "" };
  const cssWidth = () => Math.min(360, parseFloat(style.maxWidth) || Infinity);
  const cssHeight = () => Math.min(height, parseFloat(style.maxHeight) || Infinity);
  const popup = {
    ownerDocument: { defaultView: { innerWidth: 650, innerHeight: 780, getComputedStyle: (element) => element === popup ? { width: `${cssWidth()}px`, height: `${cssHeight()}px` } : { overflowX: "hidden", overflowY: "auto" } } },
    parentElement: ancestor, style,
    get offsetWidth() { return Math.round(cssWidth()); },
    get offsetHeight() { return Math.round(cssHeight()); },
    getBoundingClientRect() {
      const left = origin.left + parseFloat(style.left) * scaleX;
      const top = origin.top + parseFloat(style.top) * scaleY;
      const width = cssWidth() * scaleX;
      const height = cssHeight() * scaleY;
      return { left, top, right: left + width, bottom: top + height, width, height };
    },
  };
  return popup;
}

test("local tooltip fitting keeps the complete popup inside its clipping ancestor", async (t) => {
  const f = await fixture(t);
  const popup = clippedPopupFixture();
  const before = f.state();
  assert.equal(popup.getBoundingClientRect().top, 0);
  f.links.fitPopup(popup, { left: 0, right: 650, top: 0, bottom: 780 });
  assert.deepEqual(popup.getBoundingClientRect(), { left: 300, top: 78, right: 650, bottom: 780, width: 350, height: 702 });
  assert.equal(f.state(), before);
  assert.deepEqual(f.edits, []);
  f.respond();
  await f.pending;
});

test("local tooltip fitting preserves fractional pixel dimensions when clamping", async (t) => {
  const f = await fixture(t);
  const popup = clippedPopupFixture({ height: 437.4296875 });
  f.links.fitPopup(popup, { left: 0, right: 650, top: 0, bottom: 780 });
  assert.equal(popup.getBoundingClientRect().top, 78);
  assert.equal(popup.getBoundingClientRect().height, 437.4296875);
  f.respond();
  await f.pending;
});

test("local tooltip fitting uses visual deltas under scaled absolute and fixed positioning", async (t) => {
  const f = await fixture(t);
  for (const position of ["absolute", "fixed"]) {
    const popup = clippedPopupFixture({ position, scaleX: 2, scaleY: 1.5 });
    f.links.fitPopup(popup, { left: 0, right: 650, top: 0, bottom: 780 });
    const box = popup.getBoundingClientRect();
    assert.equal(box.left, 300);
    assert.equal(box.top, 78);
    assert.equal(box.right, 650);
    assert.equal(box.bottom, 780);
    assert.equal(popup.style.position, position);
  }
  assert.deepEqual(f.edits, []);
  f.respond();
  await f.pending;
});

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

test("empty and code-only notes free candidate slots and keep excerpt documents aligned", async (t) => {
  const f = await fixture(t, {
    "Empty.md": "# 标题", "Labels.md": "`label`\n``other!``", "Code.md": "```text\n代码\n```",
    "C.md": "第三条观察成立。", "D.md": "第四条观察成立。",
  });
  assert.deepEqual(f.state().candidates.map((candidate) => candidate.file.path), ["C.md", "D.md", "A.md", "B.md"]);
  f.respond();
  await f.pending;
  assert.deepEqual(f.state().candidates.map((candidate) => candidate.excerpt.text), ["第三条观察成立。", "第四条观察成立。", "证据推翻原有认识。", "实验帮助修正判断。"]);
});

test("page keys read the list without changing highlight, checks, or editor content", async (t) => {
  const f = await fixture(t);
  const list = { scrollTop: 120, clientHeight: 200, scrollHeight: 1000, children: { item: () => null } };
  f.view.dom = { ownerDocument: { querySelector: () => list } };
  key(f.links, f.view, " ");
  key(f.links, f.view, "ArrowDown");
  const before = f.state();
  key(f.links, f.view, "PageDown");
  assert.equal(list.scrollTop, 320);
  key(f.links, f.view, "PageUp");
  assert.equal(list.scrollTop, 120);
  assert.equal(f.state(), before);
  assert.deepEqual([...f.state().checked], ["A.md"]);
  assert.deepEqual(f.edits, []);
  f.respond();
  await f.pending;
});

test("checkbox updates and progressive excerpt completion preserve the list scroll", async (t) => {
  const f = await fixture(t);
  const popup = popupFixture(f);
  popup.list().scrollTop = 350;
  key(f.links, f.view, " ");
  assert.equal(popup.list().scrollTop, 350);
  f.respond();
  await f.pending;
  assert.equal(popup.list().scrollTop, 350);
  assert.equal(f.state().highlighted, 0);
  assert.deepEqual([...f.state().checked], ["A.md"]);
  assert.match(popup.dom.querySelector(".aha-quick-links-footer").textContent, /PgUp\/PgDn/);
});

test("arrow navigation reveals a tall row in the list while clicks retain reading position", async (t) => {
  const f = await fixture(t);
  const popup = popupFixture(f);
  const render = f.links.render.bind(f.links);
  f.links.render = (view, dom) => {
    render(view, dom);
    const rows = popup.list().children;
    rows[0].top = 0;
    rows[0].clientHeight = 400;
    rows[1].top = 400;
    rows[1].clientHeight = 450;
  };
  popup.list().scrollTop = 100;
  key(f.links, f.view, "ArrowDown");
  assert.equal(popup.list().scrollTop, 400);
  key(f.links, f.view, "PageDown");
  assert.equal(popup.list().scrollTop, 600);
  f.links.toggle(f.view, 1);
  assert.equal(popup.list().scrollTop, 600);
  key(f.links, f.view, "ArrowUp");
  assert.equal(popup.list().scrollTop, 0);
  assert.deepEqual(f.edits, []);
  f.respond();
  await f.pending;
});

test("no lexical match displays a separate status without inventing an excerpt", async (t) => {
  const f = await fixture(t);
  const popup = popupFixture(f);
  const ready = f.state();
  f.links.show(f.view, { ...ready, candidates: ready.candidates.map((candidate) => ({ ...candidate, excerpt: { text: "", method: "none", coverage: "complete" } })) });
  for (const row of popup.list().children) {
    assert.equal(row.querySelector(".aha-quick-link-excerpt"), null);
    assert.equal(row.querySelector(".aha-quick-link-excerpt-status").textContent, "暂无匹配原文");
  }
  assert.equal(popup.list().children[0].querySelector(".aha-quick-link-title").textContent, "A");
  assert.equal(f.state().candidates[0].excerpt.text, "");
  key(f.links, f.view, "Enter");
  await f.closed;
  await f.pending;
  assert.deepEqual(f.edits, [{ from: 4, insert: " [[A]]" }]);
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
