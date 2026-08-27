import assert from "node:assert/strict";
import test from "node:test";

import { composeFinalSlate } from "../../relation-judge.mjs";

function judged(paths) {
  return paths.map((p) => ({ notePath: p, relation: "supports" }));
}

function pool(paths) {
  return paths.map((p) => ({ notePath: p }));
}

test("reserved slots pull pool-top candidates into each block of ten", () => {
  const judgedOrdered = judged(Array.from({ length: 15 }, (_, i) => `j${i + 1}.md`));
  // pool-top note ranked #12 by the judge would miss the top-10 without reservation
  const poolOrder = pool(["j12.md", "j13.md", ...Array.from({ length: 13 }, (_, i) => `j${i + 1}.md`)]);
  const slate = composeFinalSlate(judgedOrdered, poolOrder, { reservedPoolSlots: 2 }).map((c) => c.notePath);
  assert.deepEqual(slate.slice(0, 10), ["j1.md", "j2.md", "j3.md", "j4.md", "j5.md", "j6.md", "j7.md", "j8.md", "j12.md", "j13.md"]);
  assert.equal(slate.length, 15);
  assert.equal(new Set(slate).size, 15);
});

test("reservation is a no-op when pool-top already sits in the judge top", () => {
  const judgedOrdered = judged(["a.md", "b.md", "c.md"]);
  const poolOrder = pool(["a.md", "b.md", "c.md"]);
  const slate = composeFinalSlate(judgedOrdered, poolOrder, { reservedPoolSlots: 2 }).map((c) => c.notePath);
  assert.deepEqual(slate, ["a.md", "b.md", "c.md"]);
});

test("zero reserve returns the judged order untouched", () => {
  const judgedOrdered = judged(["a.md", "b.md"]);
  const slate = composeFinalSlate(judgedOrdered, pool(["b.md", "a.md"]), { reservedPoolSlots: 0 });
  assert.deepEqual(slate.map((c) => c.notePath), ["a.md", "b.md"]);
});
