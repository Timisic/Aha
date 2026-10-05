import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "../../../..");
const require = createRequire(path.join(root, "obsidian-plugin/package.json"));
const temporary = await mkdtemp(path.join(tmpdir(), "aha-excerpts-"));
for (const name of ["quick-link-excerpts", "excerpt-rerank-request"]) {
  await require("esbuild").build({ entryPoints: [path.join(root, `obsidian-plugin/src/${name}.ts`)], bundle: true, platform: "node", format: "esm", outfile: path.join(temporary, `${name}.mjs`) });
}
const { extractExcerptDocument: extract, selectExcerpts: select, excerptText: text, excludesQuickLinkNote: excludes } = await import(pathToFileURL(path.join(temporary, "quick-link-excerpts.mjs")));
const { createExcerptReranker: reranker } = await import(pathToFileURL(path.join(temporary, "excerpt-rerank-request.mjs")));
await rm(temporary, { recursive: true, force: true });
const signal = () => new AbortController().signal;

async function serverFixture(t, handler) {
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    handler(JSON.parse(Buffer.concat(chunks).toString()), response, request);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return `http://127.0.0.1:${server.address().port}/rerank`;
}
function ranks(response, documents, match) {
  response.end(JSON.stringify({ results: documents.map((document, index) => ({ index, relevance_score: document.includes(match) ? 10 : -1, document: { text: "fabricated summary" } })) }));
}

test("whole-note exclusions match names and first H1 without plan substrings", () => {
  for (const name of ["README.md", "docs/Readme.zh-CN.md", "计划/方法.md", "项目规划.md", "plans/notes.md", "project-plan.md", "Roadmap.md"]) assert.equal(excludes(name), true, name);
  for (const name of ["planet.md", "explanation.md"]) assert.equal(excludes(name), false, name);
  assert.equal(extract("日常.md", "# 项目规划\n执行任务。"), null);
  assert.ok(extract("心理.md", "# 自我调节\n人们会计划自己的行动。"));
});

test("eligible spans remove metadata and planning sections while preserving prose lists and quotes", () => {
  const source = "---\nowner: hidden\n---\n# 思考\nowner: hidden\n```md\n应被隐藏。\n```\n<!-- private\nprivate -->\n- [ ] 隐藏任务。\n- [[导航]]\n## 规划\n隐藏规划。\n### 子任务\n隐藏子任务。\n## 观察\n- 反复尝试让人更新判断。\n> 意外结果能纠正固有认识。\n值为 3.14 时仍成立。";
  const note = extract("试错.md", source);
  assert.deepEqual(note.sentences.map((span) => text(note, span)), ["反复尝试让人更新判断。", "意外结果能纠正固有认识。", "值为 3.14 时仍成立。"]);
  for (const span of note.sentences) assert.equal(text(note, span), source.slice(span.from, span.to));
});

test("real HTTP ranking chooses original Chinese paraphrase after noisy intro and ignores returned prose", async (t) => {
  const wanted = "意外结果能纠正固有认识。";
  const endpoint = await serverFixture(t, ({ documents, model, query }, response, request) => {
    assert.equal(model, "fixture-model"); assert.equal(query, "失败帮助调整心智框架");
    assert.equal(request.headers.authorization, "Bearer fixture-key");
    assert.equal(documents.some((item) => item.includes("owner:")), false);
    ranks(response, documents, wanted);
  });
  const note = extract("试错.md", `---\nowner: unwanted\n---\n今天晴朗。\n${wanted}`);
  const [pick] = await select("失败帮助调整心智框架", [note], reranker(`QMD_REMOTE_RERANK_URL=${endpoint}\nQMD_REMOTE_RERANK_MODEL=fixture-model\nQMD_REMOTE_RERANK_API_KEY=fixture-key`, {}), signal());
  assert.equal(pick.method, "semantic"); assert.equal(pick.coverage, "complete"); assert.equal(text(note, pick.span), wanted);
});

test("long-note tail participates in window ranking then sentence refinement", async (t) => {
  let calls = 0;
  const endpoint = await serverFixture(t, ({ documents }, response) => { calls++; ranks(response, documents, "意外结果能纠正固有认识。"); });
  const note = extract("长文.md", "天气晴朗。".repeat(400) + "意外结果能纠正固有认识。");
  const [pick] = await select("失败帮助调整心智框架", [note], reranker(`QMD_REMOTE_RERANK_URL=${endpoint}`, {}), signal());
  assert.equal(pick.coverage, "bounded");
  assert.ok(calls <= 2);
  const manageable = extract("长文.md", "今天的观察是窗外的天空很蓝而且没有下雨。".repeat(60) + "意外结果能纠正固有认识。");
  const [tail] = await select("失败帮助调整心智框架", [manageable], reranker(`QMD_REMOTE_RERANK_URL=${endpoint}`, {}), signal());
  assert.equal(tail.method, "semantic"); assert.equal(text(manageable, tail.span), "意外结果能纠正固有认识。");
  assert.equal(calls, 3);
});

test("overflow scans full file lexically, never first-N or an unrelated opening sentence", async () => {
  const note = extract("巨大.md", "## 观察\n开头是不相关的闲聊。\n".repeat(200) + "证据推翻错误假设。");
  let called = false;
  const [pick] = await select("错误假设", [note], async () => { called = true; return []; }, signal());
  assert.equal(called, false); assert.equal(pick.coverage, "bounded"); assert.equal(pick.method, "lexical");
  assert.equal(text(note, pick.span), "证据推翻错误假设。");
  const [none] = await select("quantum", [note], null, signal());
  assert.equal(none.method, "none"); assert.equal(none.span, null);
});

test("blank overrides inherit configured endpoint, malformed service falls back to matched source", async (t) => {
  const endpoint = await serverFixture(t, (_body, response) => response.end("invalid JSON"));
  const rank = reranker("QMD_REMOTE_RERANK_URL=", { QMD_REMOTE_RERANK_URL: endpoint });
  assert.ok(rank);
  const note = extract("方法.md", "开头不相关。\n证据推翻错误假设。");
  const [pick] = await select("错误假设", [note], rank, signal());
  assert.equal(pick.method, "lexical"); assert.equal(text(note, pick.span), "证据推翻错误假设。");
});

test("HTTP boundary rejects duplicate, out-of-range, missing, and nonfinite scores", async (t) => {
  for (const results of [[{ index: 0, relevance_score: 1 }, { index: 0, relevance_score: 2 }], [{ index: 1, relevance_score: 1 }], [{ index: 0 }], [{ index: 0, relevance_score: null }], [{ index: -1, relevance_score: 1 }]]) {
    const endpoint = await serverFixture(t, (_body, response) => response.end(JSON.stringify({ results })));
    await assert.rejects(reranker(`QMD_REMOTE_RERANK_URL=${endpoint}`, {})("q", ["sentence"], signal()), /Invalid rerank/);
  }
});

test("HTTP transport bounds response and outbound payload", async (t) => {
  const endpoint = await serverFixture(t, (_body, response) => response.end("x".repeat(1024 * 1024 + 1)));
  const rank = reranker(`QMD_REMOTE_RERANK_URL=${endpoint}`, {});
  await assert.rejects(rank("q", ["sentence"], signal()), /exceeds bounds/);
  await assert.rejects(rank("q", ["x".repeat(192 * 1024)], signal()), /exceeds bounds/);
});

test("capture cancellation rejects selection and closes active HTTP request", async (t) => {
  let closeObserved;
  const closed = new Promise((resolve) => { closeObserved = resolve; });
  let received;
  const arrived = new Promise((resolve) => { received = resolve; });
  const endpoint = await serverFixture(t, (_body, response) => { response.on("close", closeObserved); received(); });
  const abort = new AbortController();
  const pending = select("错误假设", [extract("方法.md", "证据推翻错误假设。")], reranker(`QMD_REMOTE_RERANK_URL=${endpoint}`, {}), abort.signal);
  await arrived;
  abort.abort();
  await assert.rejects(pending);
  await closed;
});

test("one shared deadline aborts stalled HTTP then returns lexical fallback", async (t) => {
  const endpoint = await serverFixture(t, () => {});
  const note = extract("方法.md", "证据推翻错误假设。");
  const [pick] = await select("错误假设", [note], reranker(`QMD_REMOTE_RERANK_URL=${endpoint}`, {}), signal());
  assert.equal(pick.method, "lexical");
  assert.equal(text(note, pick.span), "证据推翻错误假设。");
});

test("multiline paragraphs keep original sentence and explicit schedule sections are omitted", () => {
  const note = extract("方法.md", "第一行没有结束\n第二行结束。\n## 下周安排\n这是需要隐藏的安排。\n## 原理\n人们安排实验来检验假设。");
  assert.deepEqual(note.sentences.map((span) => text(note, span)), ["第一行没有结束 第二行结束。", "人们安排实验来检验假设。"]);
});

test("long-line tail receives a source span instead of showing unrelated sentence prefix", async () => {
  const note = extract("长句.md", "与主题无关的引言".repeat(60) + "，证据推翻错误假设；随后继续思考。");
  const [pick] = await select("错误假设", [note], null, signal());
  assert.equal(pick.method, "lexical");
  assert.equal(text(note, pick.span), "证据推翻错误假设；");
  assert.equal(note.source.slice(pick.span.from, pick.span.to), "证据推翻错误假设；");
});

test("native hidden comments never enter source spans or semantic requests", async (t) => {
  const endpoint = await serverFixture(t, ({ documents }, response) => {
    assert.deepEqual(documents, ["证据可以推翻原有认识。"]);
    ranks(response, documents, "证据可以推翻原有认识。");
  });
  const note = extract("方法.md", "# 方法\n%%\n内部备注：错误假设。\n%%\n表面文字 %%隐藏的错误假设%% 其余文字。\n证据可以推翻原有认识。");
  assert.deepEqual(note.sentences.map((span) => text(note, span)), ["证据可以推翻原有认识。"]);
  const [pick] = await select("错误假设", [note], reranker(`QMD_REMOTE_RERANK_URL=${endpoint}`, {}), signal());
  assert.equal(pick.method, "semantic");
  assert.equal(text(note, pick.span), "证据可以推翻原有认识。");
});

test("quoted and listed fences hide code while comment literals in code do not leak state", () => {
  const sources = [
    "> ```text\n> 错误假设属于代码样例。\n> ```\n证据可以推翻错误假设。",
    "- ```text\n  错误假设属于代码样例。\n  ```\n证据可以推翻错误假设。",
    "```html\n<!--\n%%\n```\n证据可以推翻错误假设。",
    "    <!--\n    %%\n证据可以推翻错误假设。",
    "<!--\n```text\n-->\n证据可以推翻错误假设。",
    "%%\n```text\n%%\n证据可以推翻错误假设。",
  ];
  for (const source of sources) {
    const note = extract("方法.md", source);
    assert.deepEqual(note.sentences.map((span) => text(note, span)), ["证据可以推翻错误假设。"], source);
  }
});

test("nested prose bullets survive while indented code and quoted planning sections do not", () => {
  const note = extract("方法.md", "    - 证据可以推翻原有认识。\n\t- 重复检验可以帮助修正认识。\n    hidden_code()\n> ## 下周安排\n> 隐藏的安排。\n> ## 原理\n> 实验帮助人们观察真实结果。");
  assert.deepEqual(note.sentences.map((span) => text(note, span)), ["证据可以推翻原有认识。", "重复检验可以帮助修正认识。", "实验帮助人们观察真实结果。"]);
});
