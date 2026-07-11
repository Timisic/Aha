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

test("supplement budgets survive a max-size generated plan and trace only sees executed queries", async () => {
  let executed = [];
  const { state } = await runRetrievalPipeline({
    insight: { text: "source excerpt", thought: "separate thought" },
    policy: { queryLimit: 2, supplements: { sourceExcerpt: true, thought: true, queryBudget: 2 }, graphExpansion: false },
    adapters: {
      planQueries: async () => ({ queries: Array.from({ length: 7 }, (_, index) => ({ kind: "generated", text: `plan-${index}` })) }),
      retrieve: async ({ queries }) => { executed = queries; return { candidates: [] }; },
      selectCandidates: async () => [],
      judgeRelations: async () => ({ ok: true, candidates: [] }),
    },
  });
  assert.deepEqual(executed.map((query) => query.provenance ?? "generated"), ["generated", "generated", "deterministic", "deterministic"]);
  assert.deepEqual(state.generatedQuery.queries, executed);
});

test("v2 pipeline composes supplements, graph seeds, and chunked fail-closed judging", async () => {
  const reviewed = [];
  const { result, state } = await runRetrievalPipeline({
    insight: { text: "source excerpt", thought: "fresh distinct thought", sourcePath: "Source.md" },
    policy: {
      queryLimit: 4,
      supplements: { sourceExcerpt: true, thought: true },
      graphExpansion: { enabled: true, seedLimit: 1, linksLimit: 1, backlinksLimit: 0, globalCandidateLimit: 1 },
      candidateBudgets: {
        retrievalPoolBudget: 4,
        judgeReviewBudget: 4,
        finalDisplayBudget: 2,
        chunkSize: 2,
        concurrency: 2,
        globalComparisonBudget: 4,
      },
    },
    adapters: {
      planQueries: async () => ({ queries: [{ kind: "generated", text: "model query" }] }),
      retrieve: async ({ queries }) => ({
        runs: queries.map((query, index) => ({ query, rows: [{ file: `${index}.md` }] })),
      }),
      graphAdapters: () => ({
        links: async () => ["Graph.md"],
        admitCandidate: async (file) => ({ file }),
        canonicalIdentity: (candidate) => candidate.file.toLowerCase(),
      }),
      selectCandidates: async ({ retrievalCandidates, graphCandidates }) => [
        ...retrievalCandidates,
        ...graphCandidates,
      ],
      judgeRelationChunk: async ({ candidates, context }) => {
        reviewed.push({ index: context.chunkIndex, files: candidates.map((candidate) => candidate.file) });
        return candidates;
      },
      compareRelationsGlobally: async ({ candidates }) => candidates,
      candidateId: (candidate) => candidate.file,
      validateRelationEvidence: (candidate) => candidate,
    },
  });

  assert.deepEqual(state.queries.map((query) => query.provenance ?? "generated"), [
    "generated", "deterministic", "deterministic",
  ]);
  assert.equal(state.graphExpansion.seeds.length, 1);
  assert.equal(state.relationJudge.counts.chunk_count, 2);
  assert.deepEqual(reviewed.map((chunk) => chunk.files.length), [2, 2]);
  assert.deepEqual(result.candidates.map((candidate) => candidate.file), ["0.md", "1.md"]);
});
