import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { mapWithBoundedConcurrency, relationJudgeCandidatesForCase } from "../relation-judge.mjs";

const previousKey = process.env.AHA_TEST_OPENAI_KEY;
const previousChunk = process.env.AHA_RELATION_JUDGE_CHUNK_SIZE;
const previousConcurrency = process.env.AHA_RELATION_JUDGE_CONCURRENCY;

test.after(() => {
  for (const [name, value] of [
    ["AHA_TEST_OPENAI_KEY", previousKey],
    ["AHA_RELATION_JUDGE_CHUNK_SIZE", previousChunk],
    ["AHA_RELATION_JUDGE_CONCURRENCY", previousConcurrency],
  ]) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

test("mapWithBoundedConcurrency keeps order, bounds lanes, and settles before rethrow", async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const results = await mapWithBoundedConcurrency([1, 2, 3, 4, 5], 2, async (item) => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 10 + (item % 2) * 20));
    inFlight -= 1;
    return item * 10;
  });
  assert.deepEqual(results, [10, 20, 30, 40, 50]);
  assert.ok(maxInFlight <= 2, `max in flight was ${maxInFlight}`);
  assert.ok(maxInFlight >= 2, "expected at least two concurrent lanes");

  let settledAfterError = 0;
  await assert.rejects(
    mapWithBoundedConcurrency([1, 2, 3], 3, async (item) => {
      if (item === 1) throw new Error("boom");
      await new Promise((resolveSleep) => setTimeout(resolveSleep, 20));
      settledAfterError += 1;
      return item;
    }),
    /boom/,
  );
  assert.equal(settledAfterError, 2, "other lanes must settle before rethrow");
});

test("chunked relation judging fans out concurrently and reassembles all candidates", async () => {
  process.env.AHA_TEST_OPENAI_KEY = "test-key";
  process.env.AHA_RELATION_JUDGE_CHUNK_SIZE = "4";
  process.env.AHA_RELATION_JUDGE_CONCURRENCY = "3";
  const server = await startEchoJudgeServer();
  try {
    const candidates = Array.from({ length: 9 }, (_, i) => ({
      title: `Memory ${i + 1}`,
      file: `Memory/note-${i + 1}.md`,
      content: `Old note ${i + 1} records a durable judgment about feedback loop ${i + 1}.`,
      source: "qmd_query",
    }));
    const reranked = await relationJudgeCandidatesForCase({
      id: "concurrency-case",
      _resolved_insight_input: "反馈闭环如何帮助修正判断",
      must_recall: [],
    }, candidates, {
      reranker: "agent",
      llmProvider: "openai",
      rerankAgentProvider: "openai",
      llmBaseUrl: server.baseUrl,
      llmModel: "gpt-test",
      llmApiKeyEnv: "AHA_TEST_OPENAI_KEY",
      rerankAgentCache: "",
      rerankAgentFallback: false,
    });

    assert.equal(reranked.rerank_generated_by, "agent");
    assert.equal(reranked.rerank_fallback, false);
    assert.equal(reranked.candidates.length, 9);
    // Every candidate must come back judged (echo server labels all supports).
    assert.ok(reranked.candidates.every((candidate) => candidate.relation === "supports"));
    // Equal strength everywhere -> retrieval pool order must be preserved.
    assert.deepEqual(
      reranked.candidates.map((candidate) => candidate.notePath),
      candidates.map((candidate) => candidate.file),
    );

    const requests = await server.requests();
    // 9 candidates at chunk size 4 -> exactly 3 judge calls, no tournament (strong <= 10).
    assert.equal(requests.length, 3);
    assert.ok(server.sawOverlap(requests), "expected at least two judge calls in flight together");
  } finally {
    await server.stop();
  }
});

async function startEchoJudgeServer() {
  const temp = await mkdtemp(path.join(tmpdir(), "aha-judge-echo-"));
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
    const startedAt = Date.now();
    const parsed = JSON.parse(body || "{}");
    const input = String(parsed.input ?? "");
    const marker = "candidates:";
    const begin = input.indexOf(marker);
    const end = input.indexOf("Return this JSON shape:");
    const candidates = JSON.parse(input.slice(begin + marker.length, end).trim());
    const output = {
      ok: true,
      sourcePath: "concurrency-case",
      generatedAt: null,
      summary: "echo",
      warnings: [],
      error: null,
      candidates: candidates.map((candidate) => ({
        notePath: candidate.notePath,
        noteTitle: candidate.noteTitle,
        relation: "supports",
        hit: candidate.excerpt.slice(0, 24),
        why: "回显判定：" + candidate.noteTitle,
        quotes: [candidate.excerpt.slice(0, 24)],
        selected: true,
      })),
    };
    setTimeout(() => {
      appendFileSync(requestsPath, JSON.stringify({ startedAt, finishedAt: Date.now(), count: candidates.length }) + "\\n");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ output_text: JSON.stringify(output) }));
    }, 120);
  });
});
server.listen(0, "127.0.0.1", () => {
  process.stdout.write(JSON.stringify({ baseUrl: "http://127.0.0.1:" + server.address().port + "/v1" }) + "\\n");
});
process.on("SIGTERM", () => server.close(() => process.exit(0)));
`);

  const child = spawn(process.execPath, [serverPath, requestsPath], { stdio: ["ignore", "pipe", "inherit"] });
  const baseUrl = await new Promise((resolveUrl, rejectUrl) => {
    let buffer = "";
    const timer = setTimeout(() => rejectUrl(new Error("echo server did not start")), 5_000);
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      const line = buffer.split("\n").find((item) => item.trim().startsWith("{"));
      if (line) {
        clearTimeout(timer);
        resolveUrl(JSON.parse(line).baseUrl);
      }
    });
  });

  return {
    baseUrl,
    async requests() {
      const raw = await readFile(requestsPath, "utf-8").catch(() => "");
      return raw.split("\n").filter(Boolean).map((line) => JSON.parse(line));
    },
    sawOverlap(requests) {
      const sorted = [...requests].sort((left, right) => left.startedAt - right.startedAt);
      return sorted.some((item, index) => index > 0 && item.startedAt < sorted[index - 1].finishedAt);
    },
    async stop() {
      child.kill("SIGTERM");
      await new Promise((resolveStop) => child.on("exit", resolveStop));
      await rm(temp, { recursive: true, force: true });
    },
  };
}
