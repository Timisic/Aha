import assert from "node:assert/strict";
import test from "node:test";

import { judgeCandidateRelations, relationJudgeCandidatesForCase } from "../relation-judge.mjs";

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

test("benchmark relation judge records no reviewed input when judging is disabled", async () => {
  const result = await relationJudgeCandidatesForCase({}, [{
    file: "Memory/Feedback.md",
    content: "Readable feedback evidence.",
  }], { relationJudgeMode: "none" });

  assert.deepEqual(result.relation_judge_reviewed_candidates, []);
});

test("benchmark relation judge excludes unreadable candidates from attempted judge input", async () => {
  const result = await relationJudgeCandidatesForCase({}, [{
    file: "Memory/Unreadable.md",
  }], {
    relationJudgeMode: "agent",
    relationJudgeAgentCache: "",
    relationJudgeAgentFallback: true,
  });

  assert.equal(result.relation_judge_fallback, true);
  assert.match(result.relation_judge_error, /no candidate excerpts/i);
  assert.deepEqual(result.relation_judge_reviewed_candidates, []);
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
