import assert from "node:assert/strict";
import test from "node:test";

import { orderJudgedCandidates, orderJudgedCandidatesForPolicy } from "../relation-judge.mjs";

const pool = [
  { notePath: "A.md" },
  { notePath: "B.md" },
  { notePath: "C.md" },
  { notePath: "D.md" },
];

test("strong relations from deep pool positions outrank shallow weak ones", () => {
  const judged = [
    { notePath: "A.md", relation: "weak" },
    { notePath: "B.md", relation: "weak" },
    { notePath: "D.md", relation: "supports" },
    { notePath: "C.md", relation: "bounds" },
  ];
  const ordered = orderJudgedCandidates(judged, pool).map((c) => c.notePath);
  assert.deepEqual(ordered, ["D.md", "C.md", "A.md", "B.md"]);
});

test("ties within the same strength keep retrieval pool order", () => {
  const judged = [
    { notePath: "C.md", relation: "supports" },
    { notePath: "A.md", relation: "supports" },
    { notePath: "D.md", relation: "challenges" },
  ];
  const ordered = orderJudgedCandidates(judged, pool).map((c) => c.notePath);
  assert.deepEqual(ordered, ["A.md", "C.md", "D.md"]);
});

test("unknown relations rank as weak and missing notePath entries are dropped", () => {
  const judged = [
    { notePath: "B.md" },
    { relation: "supports" },
    { notePath: "A.md", relation: "resembles" },
  ];
  const ordered = orderJudgedCandidates(judged, pool).map((c) => c.notePath);
  assert.deepEqual(ordered, ["A.md", "B.md"]);
});

test("policy-gated ordering promotes strong relations while preserving rollback order", () => {
  const retrieval = Array.from({ length: 12 }, (_, index) => ({
    notePath: `${index + 1}.md`,
    relation: index < 10 ? "weak" : "supports",
  }));

  const rollback = orderJudgedCandidatesForPolicy(retrieval, retrieval, { relationOrdering: "retrieval" });
  const ranked = orderJudgedCandidatesForPolicy(retrieval, retrieval, {
    relationOrdering: "strength-with-pool-reserve",
  });

  assert.deepEqual(rollback.map(({ notePath }) => notePath), retrieval.map(({ notePath }) => notePath));
  assert.deepEqual(ranked.slice(0, 4).map(({ notePath }) => notePath), ["11.md", "12.md", "1.md", "2.md"]);
  assert.equal(ranked.length, retrieval.length);
  assert.equal(new Set(ranked.map(({ notePath }) => notePath)).size, retrieval.length);
});
