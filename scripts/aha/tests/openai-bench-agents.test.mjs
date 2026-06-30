import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { resolveQmdQueriesForCase } from "../../lib/aha-bench-common.mjs";
import { rerankCandidatesForCase } from "../../lib/aha-agent-rerank.mjs";

const previousKey = process.env.AHA_TEST_OPENAI_KEY;

test.after(() => {
  if (previousKey === undefined) {
    delete process.env.AHA_TEST_OPENAI_KEY;
  } else {
    process.env.AHA_TEST_OPENAI_KEY = previousKey;
  }
});

test("benchmark query and rerank agents can use OpenAI Responses API without Codex", async () => {
  process.env.AHA_TEST_OPENAI_KEY = "test-key";
  const requests = [];
  const server = await startOpenAiFixtureServer(requests);

  try {
    const caseItem = {
      id: "openai-case",
      _resolved_insight_input: "我想从旧笔记里找到关于反馈闭环和学习改进的判断。",
      must_recall: ["Memory/Feedback.md"],
    };
    const commonOptions = {
      llmProvider: "openai",
      llmBaseUrl: server.baseUrl,
      llmModel: "gpt-test",
      llmApiKeyEnv: "AHA_TEST_OPENAI_KEY",
      queryAgentBin: "/definitely/missing/codex",
      rerankAgentBin: "/definitely/missing/codex",
    };

    const queryPlan = resolveQmdQueriesForCase(caseItem, {
      ...commonOptions,
      queryGenerator: "agent",
      queryAgentProvider: "openai",
      queryAgentCache: "",
    });

    assert.equal(queryPlan.query_generated_by, "agent");
    assert.equal(queryPlan.query_generation_fallback, false);
    assert.equal(queryPlan.queries.length, 3);
    assert.match(queryPlan.queries[0].query, /intent:/);

    const reranked = rerankCandidatesForCase({
      ...caseItem,
      query_object: queryPlan.query_object,
      queries: queryPlan.queries,
    }, [
      candidate("Memory/Feedback.md", "Feedback"),
      candidate("Memory/Noise.md", "Noise"),
    ], {
      ...commonOptions,
      reranker: "agent",
      rerankAgentProvider: "openai",
      rerankAgentCache: "",
      limit: 2,
    });

    assert.equal(reranked.rerank_generated_by, "agent");
    assert.equal(reranked.rerank_fallback, false);
    assert.deepEqual(reranked.rerank_ranked_ids, ["c002", "c001"]);
    assert.deepEqual(reranked.candidates.map((item) => item.file), ["Memory/Noise.md", "Memory/Feedback.md"]);

    const recordedRequests = await server.requests();
    assert.equal(recordedRequests.length, 2);
    assert.ok(recordedRequests.every((request) => request.headers.authorization === "Bearer test-key"));
    assert.ok(recordedRequests.every((request) => request.body.model === "gpt-test"));
    assert.ok(recordedRequests.every((request) => request.body.text?.format?.type === "json_schema"));
    assert.deepEqual(recordedRequests.map((request) => request.body.text.format.name), [
      "aha_qmd_query_plan_agent",
      "aha_agent_rerank",
    ]);
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

async function startOpenAiFixtureServer() {
  const temp = await mkdtemp(path.join(tmpdir(), "aha-openai-bench-fixture-"));
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
    const schemaName = parsed?.text?.format?.name;
    let output;
    if (schemaName === "aha_qmd_query_plan_agent") {
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
    } else if (schemaName === "aha_agent_rerank") {
      output = { ranked_ids: ["c002", "c001"] };
    } else {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unexpected schema " + schemaName }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ output_text: JSON.stringify(output) }));
  });
});
server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  process.stdout.write(JSON.stringify({ baseUrl: "http://127.0.0.1:" + address.port + "/v1" }) + "\\n");
});
process.on("SIGTERM", () => server.close(() => process.exit(0)));
`);

  const child = spawn(process.execPath, [serverPath, requestsPath], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const baseUrl = await new Promise((resolve, reject) => {
    let stdout = "";
    const timer = setTimeout(() => reject(new Error("OpenAI fixture server did not start.")), 5000);
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
      if (code !== 0) reject(new Error(`OpenAI fixture server exited early with ${code}`));
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
