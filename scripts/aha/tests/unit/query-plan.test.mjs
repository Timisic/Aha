import assert from "node:assert/strict";
import test from "node:test";

import {
  generateQueryPlanWithAdapter,
  resolveQmdQueriesForCase,
} from "../../query-plan.mjs";

const validPlan = {
  queries: ["raw", "abstracted_judgment", "contextual"].map((kind) => ({
    kind,
    command: "qmd query",
    text: `${kind} query`,
    qmd: {
      intent: `召回 ${kind} 相关的旧判断`,
      lex: ["反馈", "闭环", "学习", "改进", "extra"],
      vec: "围绕反馈闭环和学习改进寻找旧判断。",
      hyde: "一篇旧笔记讨论反馈如何帮助学习改进。",
    },
  })),
};

test("shared query-plan module normalizes valid adapter output with production bounds", async () => {
  const plan = await generateQueryPlanWithAdapter({
    sourcePath: "Source.md",
    sourceText: "# Source\n\n反馈闭环暴露经验差距，也帮助下一次行动修正。",
    primaryName: "fake-agent",
    adapter: async () => validPlan,
  });

  assert.equal(plan.query_generated_by, "fake-agent");
  assert.equal(plan.query_generation_fallback, false);
  assert.equal(plan.queries.length, 4);
  assert.ok(plan.queries.every((query) => query.command === "qmd query"));
  assert.ok(plan.queries.every((query) => query.qmd.lex.length <= 4));
  assert.match(plan.queries[0].query, /intent:/);
  assert.equal(plan.query_objects.length, 4);
  assert.equal(plan.model_query_count, 3);
  assert.equal(plan.queries.at(-1).kind, "source_fallback");
  assert.match(plan.queries.at(-1).qmd.vec, /反馈闭环暴露经验差距/);
});

test("shared query-plan keeps five model rewrites plus one deterministic source fallback", async () => {
  const plan = await generateQueryPlanWithAdapter({
    sourcePath: "Source.md",
    sourceText: "# 原始判断\n\n事情没有回应时，也许要把沉默看作现实的一部分，而不是继续等待解释。",
    primaryName: "fake-agent",
    adapter: async () => ({
      queries: Array.from({ length: 5 }, (_, index) => ({
        ...validPlan.queries[index % validPlan.queries.length],
        text: `rewrite-${index + 1}`,
        qmd: {
          ...validPlan.queries[index % validPlan.queries.length].qmd,
          vec: `rewritten vector ${index + 1}`,
        },
      })),
    }),
  });

  assert.equal(plan.model_query_count, 5);
  assert.equal(plan.queries.length, 6);
  assert.equal(plan.queries.at(-1).kind, "source_fallback");
  assert.match(plan.queries.at(-1).qmd.vec, /事情没有回应/);
});

test("shared query-plan module records fallback provenance", async () => {
  const plan = await generateQueryPlanWithAdapter({
    sourcePath: "Source.md",
    sourceText: "A short but valid source insight.",
    primaryName: "primary",
    fallbackName: "fallback",
    adapter: async () => {
      throw new Error("primary broke");
    },
    fallbackAdapter: async () => validPlan,
  });

  assert.equal(plan.query_generated_by, "fallback");
  assert.equal(plan.query_generation_fallback, true);
  assert.match(plan.query_generation_error, /primary broke/);
});

test("benchmark rules path uses the same query-plan bounds", async () => {
  const plan = await resolveQmdQueriesForCase({
    id: "rules-case",
    _resolved_insight_input: "Source note:\n反馈闭环和行动修正。\n\nFresh thought:\n要找旧判断里的反例。",
  }, {
    queryGenerator: "rules",
  });

  assert.equal(plan.query_generated_by, "rules");
  assert.equal(plan.queries.length, 4);
  assert.ok(plan.queries.every((query) => query.qmd.lex.length <= 4));
  assert.ok(plan.queries.every((query) => ["qmd query", "qmd search"].includes(query.command)));
});
