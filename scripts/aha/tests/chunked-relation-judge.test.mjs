import assert from "node:assert/strict";
import test from "node:test";

import { runChunkedRelationJudge, validateChunkedJudgePolicy } from "../chunked-relation-judge.mjs";

const candidates = (count) => Array.from({ length: count }, (_, index) => ({
  notePath: `Memory/${index}.md`,
  excerpt: `private evidence ${index}`,
}));
const judged = (items) => items.map((item) => ({ ...item, relation: "supports", hit: item.excerpt }));

test("policy keeps retrieval, judge, and display budgets distinct and bounded", () => {
  assert.deepEqual(validateChunkedJudgePolicy({ retrievalPoolBudget: 80, judgeReviewBudget: 60, finalDisplayBudget: 20 }), {
    retrievalPoolBudget: 80, judgeReviewBudget: 60, finalDisplayBudget: 20, chunkSize: 20, concurrency: 3, globalComparisonBudget: 40,
  });
  assert.throws(() => validateChunkedJudgePolicy({ judgeReviewBudget: 81 }), /must not exceed retrieval/);
  assert.throws(() => validateChunkedJudgePolicy({ judgeReviewBudget: 40, finalDisplayBudget: 41 }), /must not exceed judge/);
  assert.throws(() => validateChunkedJudgePolicy({ concurrency: 9 }), /between 1 and 8/);
});

test("bounded chunks preserve stable retrieval order and expose distinct actual counts", async () => {
  let inFlight = 0;
  let maximum = 0;
  const result = await runChunkedRelationJudge({
    candidates: candidates(90),
    policy: { retrievalPoolBudget: 80, judgeReviewBudget: 60, finalDisplayBudget: 20, chunkSize: 13, concurrency: 2, globalComparisonBudget: 40 },
    judgeChunk: async (items) => {
      inFlight += 1; maximum = Math.max(maximum, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return judged([...items].reverse());
    },
  });
  assert.equal(result.ok, true);
  assert.ok(maximum <= 2 && maximum > 1);
  assert.deepEqual(result.counts, { retrieval_pool_count: 80, judge_input_count: 60, reviewed_count: 60, chunk_count: 5, successful_chunk_count: 5, final_count: 20 });
  assert.deepEqual(result.candidates.map((item) => item.notePath), candidates(20).map((item) => item.notePath));
});

test("global comparison creates a coherent order and evidence hook is shared", async () => {
  let evidenceChecks = 0;
  const result = await runChunkedRelationJudge({
    candidates: candidates(8),
    policy: { retrievalPoolBudget: 8, judgeReviewBudget: 8, finalDisplayBudget: 4, chunkSize: 2, concurrency: 2, globalComparisonBudget: 6 },
    judgeChunk: async (items) => judged(items),
    compareGlobally: async (items) => [...items].reverse(),
    validateEvidence(candidate, input) {
      evidenceChecks += 1;
      assert.equal(candidate.hit, input.excerpt);
      return candidate;
    },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.candidates.map((item) => item.notePath), ["Memory/5.md", "Memory/4.md", "Memory/3.md", "Memory/2.md"]);
  assert.equal(evidenceChecks, 14);
});

test("partial chunk failure fails closed with content-free trace evidence", async () => {
  const result = await runChunkedRelationJudge({
    candidates: candidates(7),
    policy: { retrievalPoolBudget: 7, judgeReviewBudget: 7, finalDisplayBudget: 3, chunkSize: 3, concurrency: 2, globalComparisonBudget: 7 },
    judgeChunk: async (items, { chunkIndex }) => {
      if (chunkIndex === 1) throw Object.assign(new Error("private evidence must never enter trace"), { code: "UPSTREAM_TIMEOUT" });
      return judged(items);
    },
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.candidates, []);
  assert.deepEqual(result.failures, [{ chunk_index: 1, error_name: "Error", error_code: "UPSTREAM_TIMEOUT" }]);
  assert.equal(result.counts.reviewed_count, 4);
  assert.equal(result.counts.final_count, 0);
  assert.doesNotMatch(JSON.stringify(result), /private evidence/);
});

test("missing identity or evidence fails closed", async () => {
  const result = await runChunkedRelationJudge({
    candidates: candidates(2),
    policy: { retrievalPoolBudget: 2, judgeReviewBudget: 2, finalDisplayBudget: 1, chunkSize: 2, concurrency: 1, globalComparisonBudget: 2 },
    judgeChunk: async (items) => judged(items).slice(0, 1),
  });
  assert.equal(result.ok, false);
  assert.equal(result.counts.reviewed_count, 0);
  assert.deepEqual(result.candidates, []);
});
