import assert from "node:assert/strict";
import test from "node:test";

import { runRetrievalPipeline } from "../retrieval-pipeline.mjs";

test("shared retrieval pipeline owns stage order and applies policy budgets", async () => {
  const calls = [];
  const candidates = [{ file: "A.md" }, { file: "B.md" }, { file: "C.md" }];
  const { result, trace, state } = await runRetrievalPipeline({
    insight: { text: "new insight", sourcePath: "Source.md" },
    policy: { queryLimit: 1, finalCandidateLimit: 2, graphExpansion: false },
    adapters: {
      planQueries: async () => {
        calls.push("plan");
        return { queries: [{ text: "one" }, { text: "two" }] };
      },
      retrieve: async ({ queries }) => {
        calls.push(`retrieve:${queries.length}`);
        return { runs: [{ query: queries[0], candidates }] };
      },
      expandGraph: async () => {
        calls.push("graph");
        return { candidates: [{ file: "graph.md" }] };
      },
      selectCandidates: async ({ retrievalCandidates, graphCandidates }) => {
        calls.push(`select:${graphCandidates.length}`);
        return retrievalCandidates;
      },
      judgeRelations: async ({ candidates: selected }) => {
        calls.push(`judge:${selected.length}`);
        return { candidates: [...selected].reverse() };
      },
      formatResult: async ({ finalCandidates }) => {
        calls.push(`format:${finalCandidates.length}`);
        return { ok: true, candidates: finalCandidates };
      },
      buildTrace: ({ state: pipelineState }) => ({
        schema: "PipelineTrace",
        version: 2,
        files: pipelineState.finalCandidates.map((candidate) => candidate.file),
      }),
    },
  });

  assert.deepEqual(calls, ["plan", "retrieve:1", "select:0", "judge:3", "format:2"]);
  assert.deepEqual(result.candidates.map((candidate) => candidate.file), ["C.md", "B.md"]);
  assert.deepEqual(state.finalCandidates, result.candidates);
  assert.deepEqual(trace, { schema: "PipelineTrace", version: 2, files: ["C.md", "B.md"] });
});

test("shared retrieval pipeline preserves structured stage failures in its trace", async () => {
  const { result, trace } = await runRetrievalPipeline({
    insight: { text: "new insight", sourcePath: "Source.md" },
    policy: {},
    adapters: {
      planQueries: async () => {
        throw new Error("planner unavailable");
      },
      onFailure: ({ stage, error }) => ({ ok: false, error: { stage, message: error.message } }),
      buildTrace: ({ state }) => ({
        schema: "PipelineTrace",
        version: 2,
        status: "failed",
        errors: state.errors.map(({ stage, error }) => ({ stage, message: error.message })),
      }),
    },
  });

  assert.deepEqual(result, { ok: false, error: { stage: "query_generation", message: "planner unavailable" } });
  assert.deepEqual(trace.errors, [{ stage: "query_generation", message: "planner unavailable" }]);
});
