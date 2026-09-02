import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { resolveQmdQueriesForCase } from "../../../lib/bench-cases.mjs";
import { relationJudgeCandidatesForCase } from "../../../aha/relation-judge.mjs";

const previousKey = process.env.AHA_TEST_DEEPSEEK_KEY;

test.after(() => {
  if (previousKey === undefined) {
    delete process.env.AHA_TEST_DEEPSEEK_KEY;
  } else {
    process.env.AHA_TEST_DEEPSEEK_KEY = previousKey;
  }
});

test("benchmark query and rerank agents use DeepSeek chat completions", async () => {
  process.env.AHA_TEST_DEEPSEEK_KEY = "test-key";
  const requests = [];
  const server = await startDeepSeekFixtureServer(requests);

  try {
    const caseItem = {
      id: "deepseek-case",
      _resolved_insight_input: "我想从旧笔记里找到关于反馈闭环和学习改进的判断。",
      must_recall: ["Memory/Feedback.md"],
    };
    const commonOptions = {
      llmProvider: "deepseek",
      llmBaseUrl: server.baseUrl,
      llmModel: "deepseek-test",
      llmApiKeyEnv: "AHA_TEST_DEEPSEEK_KEY",
    };

    const queryPlan = await resolveQmdQueriesForCase(caseItem, {
      ...commonOptions,
      queryGenerator: "agent",
      queryAgentProvider: "deepseek",
      queryAgentCache: "",
    });

    assert.equal(queryPlan.query_generated_by, "agent");
    assert.equal(queryPlan.query_generation_fallback, false);
    assert.equal(queryPlan.queries.length, 4);
    assert.equal(queryPlan.model_query_count, 3);
    assert.equal(queryPlan.queries.at(-1).kind, "source_fallback");
    assert.match(queryPlan.queries[0].query, /intent:/);

    const reranked = await relationJudgeCandidatesForCase({
      ...caseItem,
      query_object: queryPlan.query_object,
      queries: queryPlan.queries,
    }, [
      candidate("Memory/Feedback.md", "Feedback"),
      candidate("Memory/Noise.md", "Noise"),
    ], {
      ...commonOptions,
      relationJudgeMode: "agent",
      relationJudgeAgentProvider: "deepseek",
      relationJudgeAgentCache: "",
      limit: 2,
    });

    assert.equal(reranked.relation_judge_generated_by, "agent");
    assert.equal(reranked.relation_judge_fallback, false);
    // Equal-strength relations fall back to retrieval pool order (c001 before c002).
    assert.deepEqual(reranked.relation_judge_ranked_ids, ["c001", "c002"]);
    assert.deepEqual(reranked.candidates.map((item) => item.file), ["Memory/Feedback.md", "Memory/Noise.md"]);
    assert.deepEqual(reranked.candidates.map((item) => item.relation), ["supports", "challenges"]);
    assert.match(reranked.candidates[1].hit, /Noise candidate/);
    assert.match(reranked.candidates[0].why, /反馈/);

    const recordedRequests = await server.requests();
    assert.equal(recordedRequests.length, 2);
    assert.ok(recordedRequests.every((request) => request.headers.authorization === "Bearer test-key"));
    assert.ok(recordedRequests.every((request) => request.body.model === "deepseek-test"));
    assert.ok(recordedRequests.every((request) => request.body.response_format?.type === "json_object"));
    assert.ok(recordedRequests.every((request) => request.body.thinking?.type === "disabled"));
    assert.match(recordedRequests[0].body.messages[0].content, /检索查询生成/);
    assert.match(recordedRequests[1].body.messages[0].content, /sourcePath/);
  } finally {
    await server.close();
  }
});

function candidate(file, title) {
  return {
    title,
    file,
    source: "qmd",
    sources: ["qmd"],
    content: `${title} candidate excerpt with enough detail for reranking.`,
  };
}

async function startDeepSeekFixtureServer() {
  const temp = await mkdtemp(path.join(tmpdir(), "aha-deepseek-bench-fixture-"));
  const requestsPath = path.join(temp, "requests.jsonl");
  const serverPath = path.join(temp, "server.mjs");
  await writeFile(serverPath, `
import { createServer } from "node:http";
import { appendFileSync } from "node:fs";
const requestsPath = process.argv[2];
const server = createServer((req, res) => {
  let body = "";
  req.setEncoding("utf8");
  req.on("data", (chunk) => { body += chunk; });
  req.on("end", () => {
    const parsed = JSON.parse(body || "{}");
    appendFileSync(requestsPath, JSON.stringify({ method: req.method, url: req.url, headers: req.headers, body: parsed }) + "\\n");
    const prompt = parsed?.messages?.[0]?.content || "";
    const isQueryPlan = prompt.includes("检索查询生成");
    let output;
    if (isQueryPlan) {
      output = {
        queries: ["raw", "abstracted_judgment", "contextual"].map((kind) => ({
          kind,
          command: "qmd query",
          text: kind + " feedback loop query",
          qmd: {
            intent: "召回" + kind + "相关的反馈闭环旧判断",
            lex: ["反馈", "闭环", "学习", "改进"],
            vec: "寻找关于反馈密度、学习改进、旧判断如何帮助当前行动修正的相关笔记。",
            hyde: "一篇旧笔记讨论反馈如何暴露经验差距，并帮助人在学习或行动中形成更好的闭环。"
          }
        }))
      };
    } else if (prompt.includes("sourcePath")) {
      output = {
        ok: true,
        sourcePath: "deepseek-case",
        generatedAt: null,
        summary: "Relation judge fixture result.",
        warnings: [],
        error: null,
        candidates: [
          {
            notePath: "Memory/Noise.md",
            noteTitle: "Noise",
            relation: "challenges",
            hit: "\\"Noise candidate excerpt\\"",
            why: "噪声经验提醒人们，并非每一次反馈都会改善判断，有些回应反而会把注意力带偏。",
            quotes: ["Noise candidate excerpt"],
            selected: true
          },
          {
            notePath: "Memory/Feedback.md",
            noteTitle: "Feedback",
            relation: "supports",
            hit: "\\"Feedback candidate excerpt\\"",
            why: "持续反馈能暴露经验缺口，因此可以帮助人们更快修正下一步行动。",
            quotes: ["Feedback candidate excerpt"],
            selected: true
          }
        ]
      };
    } else {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unexpected prompt shape" }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: JSON.stringify(output) } }] }));
  });
});
server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  process.stdout.write(JSON.stringify({ baseUrl: "http://127.0.0.1:" + address.port }) + "\\n");
});
process.on("SIGTERM", () => server.close(() => process.exit(0)));
`);

  const child = spawn(process.execPath, [serverPath, requestsPath], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const baseUrl = await new Promise((resolve, reject) => {
    let stdout = "";
    const timer = setTimeout(() => reject(new Error("DeepSeek fixture server did not start.")), 5000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      const line = stdout.split(/\r?\n/).find(Boolean);
      if (!line) return;
      clearTimeout(timer);
      try {
        resolve(JSON.parse(line).baseUrl);
      } catch (error) {
        reject(error);
      }
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code !== 0) reject(new Error(`DeepSeek fixture server exited early with ${code}`));
    });
  });

  return {
    baseUrl,
    requests: async () => {
      try {
        const text = await readFile(requestsPath, "utf-8");
        return text.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
      } catch {
        return [];
      }
    },
    close: async () => {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
      await rm(temp, { recursive: true, force: true });
    },
  };
}
