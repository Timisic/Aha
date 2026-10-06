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
  const owner = "与主题无关的引言".repeat(60) + "，证据推翻错误假设；随后继续思考。";
  const note = extract("长句.md", "错误。" + owner);
  const [pick] = await select("错误假设", [note], null, signal());
  assert.equal(pick.method, "lexical");
  assert.equal(text(note, pick.span), owner);
  assert.equal(note.source.slice(pick.span.from, pick.span.to), owner);
});

test("natural display sentences keep connectors, commas, and unpunctuated long prose", () => {
  const owner = "观察使我们重新检查推论，".repeat(30) + "也就是说，原有认识需要调整。";
  const unpunctuated = "继续观察真实结果".repeat(60);
  const note = extract("观察.md", `${owner}\n\n${unpunctuated}`);
  assert.deepEqual(note.sentences.map((span) => text(note, span)), [owner, unpunctuated]);
});

test("standalone inline-code labels are removed before joining and empty bodies return null", () => {
  const note = extract("观察.md", "`category`\n继续观察\n``label.with.punctuation!``\n- 短句。\n> 对。\n**成立**\n解释 `token!` 的作用。");
  assert.deepEqual(note.sentences.map((span) => text(note, span)), ["继续观察", "短句。", "对。", "**成立** 解释 `token!` 的作用。"]);
  for (const source of ["", "# 标题\n`label`", "``label!``\n`another_label`", "**`label`**", "(`label`)", "---\nkind: test\n---\n- [[导航]]", "```text\n代码\n```", "## 规划\n隐藏正文。"])
    assert.equal(extract("空文.md", source), null, source);
});

test("English sentence periods keep closing quotes and decimal periods intact", () => {
  const note = extract("观察.md", '“The value is 3.14.” Next observation ends.');
  assert.deepEqual(note.sentences.map((span) => text(note, span)), ['“The value is 3.14.”', "Next observation ends."]);
});

test("nested and uncertain inline formatting retain complete source constructs", () => {
  for (const owner of ["观察 *其中 **强调！** 仍在同一段*，最后结束。", "观察 **其中 *强调！* 仍在同一段**，最后结束。", "观察 ***共同强调！仍在同一段***，最后结束。", "观察 ~~删除！仍在同一段~~，最后结束。", "观察 ==强调！仍在同一段==，最后结束。", "观察 **尚未关闭。后文继续说明。"])
    assert.deepEqual(extract("观察.md", owner).sentences, [{ from: 0, to: owner.length }], owner);
});

test("inline code within long prose stays eligible in private scoring leaves", async () => {
  const owner = "unrelated content ".repeat(30) + ", `marker!`; subsequent observation.";
  const note = extract("观察.md", "天气晴朗。" + owner);
  const [lexical] = await select("marker", [note], null, signal());
  assert.equal(text(note, lexical.span), owner);
  const [semantic] = await select("marker", [note], async (_query, documents) => {
    assert.ok(documents.includes("`marker!`;"));
    return documents.map((document, index) => ({ index, score: document.includes("marker") ? 1 : 0 }));
  }, signal());
  assert.equal(text(note, semantic.span), owner);
});

test("markup, links, emoji, escapes, and multiline offsets remain exact", () => {
  const owner = "前文".repeat(119) + "😀使用 `a! b。 c`、[说明](https://example.test/" + "long.path/".repeat(40) + "a(b)?q=x)、[[页面!#标题|显示。]]、**强调。仍然成立**，值为 3.14，继续\\!\r\n第二行才结束！？。";
  const note = extract("原文.md", `${owner}\r\n“随后确认。”`);
  assert.equal(note.sentences.length, 2);
  assert.equal(note.source.slice(note.sentences[0].from, note.sentences[0].to), owner);
  assert.equal(text(note, note.sentences[0]), owner.replace(/\s+/g, " "));
  assert.equal(text(note, note.sentences[1]), "“随后确认。”");
});

test("short-tail leaves below grouping size beat a distractor lexically and semantically", async () => {
  const owner = Array.from({ length: 95 }, (_, index) => `unrelated${index}`).join(" ") + "，证据推翻错误假设；随后继续思考。";
  assert.ok(owner.length > 300 && owner.length < 1600);
  const note = extract("长句.md", "错误。" + owner);
  const [lexical] = await select("错误假设", [note], null, signal());
  assert.equal(text(note, lexical.span), owner);
  let calls = 0;
  const [semantic] = await select("错误假设", [note], async (_query, documents) => {
    calls++;
    assert.ok(documents.includes("证据推翻错误假设；"));
    return documents.map((document, index) => ({ index, score: document === "证据推翻错误假设；" ? 10 : document === "错误。" ? 5 : 0 }));
  }, signal());
  assert.equal(semantic.method, "semantic");
  assert.equal(text(note, semantic.span), owner);
  assert.ok(calls <= 2);
});

const proseContainers = [["", ""], ["**", "**"], ["*", "*"], ["(", ")"], ["（", "）"], ["【", "】"], ["“", "”"]];
function formattedTail(prefix, suffix, repeat) {
  return prefix + "unrelated ".repeat(repeat) + "，证据推翻错误假设；随后继续思考" + suffix + "。";
}

test("private lexical leaves find the relevant tail inside formatted prose containers", async () => {
  for (const [prefix, suffix] of proseContainers) {
    const owner = formattedTail(prefix, suffix, 95);
    const note = extract("长句.md", "错误。" + owner);
    const [pick] = await select("错误假设", [note], null, signal());
    assert.equal(pick.method, "lexical");
    assert.equal(note.source.slice(pick.span.from, pick.span.to), owner, prefix);
  }
});

test("semantic requests retain private tail leaves inside formatted prose containers", async () => {
  for (const [prefix, suffix] of proseContainers) {
    const owner = formattedTail(prefix, suffix, 95);
    const note = extract("长句.md", "错误。" + owner);
    let calls = 0;
    const [pick] = await select("错误假设", [note], async (_query, documents) => {
      calls++;
      assert.ok(documents.includes("证据推翻错误假设；"), prefix);
      return documents.map((document, index) => ({ index, score: document === "证据推翻错误假设；" ? 10 : document === "错误。" ? 5 : 0 }));
    }, signal());
    assert.equal(pick.method, "semantic", prefix);
    assert.equal(note.source.slice(pick.span.from, pick.span.to), owner, prefix);
    assert.ok(calls <= 2);
  }
});

test("overflow fallback scans formatted tail leaves beyond a matching distractor", async () => {
  for (const [prefix, suffix] of proseContainers) {
    const owner = formattedTail(prefix, suffix, 22000);
    const note = extract("巨大.md", "错误。" + owner);
    let calls = 0;
    const [pick] = await select("错误假设", [note], async () => { calls++; return []; }, signal());
    assert.equal(calls, 0, prefix);
    assert.equal(pick.coverage, "bounded");
    assert.equal(pick.method, "lexical");
    assert.equal(note.source.slice(pick.span.from, pick.span.to), owner, prefix);
  }
});

test("balanced Chinese containers and quotations keep whole original display owners", () => {
  for (const [prefix, suffix] of [["（", "）"], ["【", "】"], ["［", "］"], ["「", "」"], ["『", "』"], ["“", "”"], ["‘", "’"]]) {
    const owner = `观察${prefix}数值为 3.14。测量继续${suffix}最后结束。`;
    const note = extract("观察.md", owner);
    assert.deepEqual(note.sentences, [{ from: 0, to: owner.length }], prefix);
    assert.equal(note.source.slice(note.sentences[0].from, note.sentences[0].to), owner);
  }
  const quoted = "他说：“证据暂未成立。继续观察。”随后结束。";
  assert.deepEqual(extract("观察.md", quoted).sentences, [{ from: 0, to: quoted.length }]);
});

test("ASCII contractions do not open containers and curly contractions do not close quotes", () => {
  const plain = extract("观察.md", "We can't assume a result. We'll test it.");
  assert.deepEqual(plain.sentences.map((span) => text(plain, span)), ["We can't assume a result.", "We'll test it."]);
  const quoted = extract("观察.md", "‘We don’t assume. We continue.’ Afterwards.");
  assert.deepEqual(quoted.sentences.map((span) => text(quoted, span)), ["‘We don’t assume. We continue.’", "Afterwards."]);
});

test("grouped semantic refinement scores leaves and returns the full tail owner", async () => {
  const owner = Array.from({ length: 80 }, (_, index) => `unrelated${index}`).join(" ") + "，证据推翻错误假设；随后继续思考。";
  const note = extract("长句.md", "无关内容。".repeat(30) + "错误。" + owner);
  const calls = [];
  const [pick] = await select("错误假设", [note], async (_query, documents) => {
    calls.push(documents);
    return documents.map((document, index) => ({ index, score: document === "证据推翻错误假设；" ? 10 : document === "错误。" ? 5 : document.includes("证据推翻错误假设") ? 8 : 0 }));
  }, signal());
  assert.equal(calls.length, 2);
  assert.ok(calls[1].includes("证据推翻错误假设；"));
  assert.equal(pick.method, "semantic");
  assert.equal(text(note, pick.span), owner);
});

test("oversized unsplittable owner remains whole and full-file lexical fallback reaches its tail", async () => {
  const owner = "unrelated ".repeat(22000) + "证据推翻错误假设。";
  const note = extract("巨大.md", "天气晴朗。" + owner);
  let calls = 0;
  const [pick] = await select("错误假设", [note], async () => { calls++; return []; }, signal());
  assert.equal(calls, 0);
  assert.equal(pick.coverage, "bounded");
  assert.equal(pick.method, "lexical");
  assert.equal(note.source.slice(pick.span.from, pick.span.to), owner);
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
