import assert from "node:assert/strict";
import test from "node:test";

import { judgeCandidateRelations } from "../../relation-judge.mjs";

const retrievalCandidates = [
  {
    notePath: "Memory/Feedback.md",
    noteTitle: "Feedback",
    relation: "weak",
    hit: "retrieval hit",
    why: "Retrieval surfaced this candidate.",
    quotes: [],
    selected: true,
  },
];

const candidateInputs = [
  {
    notePath: "Memory/Feedback.md",
    noteTitle: "Feedback",
    retrievalHit: "retrieval hit",
    retrievalWhy: "retrieval why",
    excerpt: "Feedback loops expose experience gaps and help judgment improve.",
  },
];

test("shared relation judge preserves quote-backed strong relations", async () => {
  const result = await judgeCandidateRelations({
    sourcePath: "Source.md",
    sourceText: "I need old notes about feedback loops.",
    candidates: retrievalCandidates,
    candidateInputs,
    adapterName: "fake-agent",
    adapter: async () => resultPayload({
      relation: "supports",
      hit: "\"Feedback loops expose experience gaps\"",
      quotes: ["Feedback loops expose experience gaps"],
    }),
  });

  assert.equal(result.ok, true);
  assert.equal(result.relation_judge_generated_by, "fake-agent");
  assert.equal(result.candidates[0].relation, "supports");
  assert.deepEqual(result.candidates[0].quotes, ["Feedback loops expose experience gaps"]);
});

test("shared relation judge downgrades hallucinated quote evidence to weak", async () => {
  const result = await judgeCandidateRelations({
    sourcePath: "Source.md",
    sourceText: "I need old notes about feedback loops.",
    candidates: retrievalCandidates,
    candidateInputs,
    adapter: async () => resultPayload({
      relation: "supports",
      hit: "\"This quote is not in the excerpt\"",
      quotes: ["This quote is not in the excerpt"],
    }),
  });

  assert.equal(result.ok, true);
  assert.equal(result.candidates[0].relation, "weak");
  assert.deepEqual(result.candidates[0].quotes, []);
  assert.match(result.candidates[0].why, /Downgraded to weak/);
});

test("shared relation judge retries one schema-invalid non-thinking response", async () => {
  let calls = 0;
  const result = await judgeCandidateRelations({
    sourcePath: "Source.md",
    sourceText: "I need old notes about feedback loops.",
    candidates: retrievalCandidates,
    candidateInputs,
    adapterName: "deepseek",
    adapter: async ({ prompt }) => {
      calls += 1;
      if (calls === 1) return resultPayload({ why: "太短" });
      assert.match(prompt, /previous JSON failed validation/i);
      return resultPayload({ why: "旧笔记里的反馈闭环说明，沉默或缺少回应本身也可以成为修正当前判断的具体证据。" });
    },
  });

  assert.equal(calls, 2);
  assert.equal(result.ok, true);
  assert.equal(result.relation_judge_generated_by, "deepseek");
});

test("shared relation judge returns structured failure when adapter output is malformed", async () => {
  const result = await judgeCandidateRelations({
    sourcePath: "Source.md",
    sourceText: "I need old notes about feedback loops.",
    candidates: retrievalCandidates,
    candidateInputs,
    adapterName: "fake-agent",
    adapter: async () => ({ ok: true, candidates: [{ notePath: "Memory/Feedback.md" }] }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.tool, "fake-agent");
  assert.match(result.error, /malformed|relation|hit|why/i);
  assert.deepEqual(result.candidates, retrievalCandidates);
});

function resultPayload(candidatePatch) {
  return {
    ok: true,
    sourcePath: "Source.md",
    generatedAt: null,
    summary: "Fixture relation judge output.",
    warnings: [],
    error: null,
    candidates: [
      {
        notePath: "Memory/Feedback.md",
        noteTitle: "Feedback",
        relation: "weak",
        hit: "\"Feedback loops expose experience gaps\"",
        why: "Feedback evidence connects the old note to the current source insight.",
        quotes: ["Feedback loops expose experience gaps"],
        selected: true,
        ...candidatePatch,
      },
    ],
  };
}
