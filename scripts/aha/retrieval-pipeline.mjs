/**
 * Run the complete Aha retrieval orchestration through injected runtime seams.
 *
 * @param {object} input
 * @param {object} input.insight Current insight text and optional source identity.
 * @param {object} input.policy Retrieval budgets and enabled strategies. Supported
 * keys are queryLimit, finalCandidateLimit, and graphExpansion; adapters may read
 * additional profile-specific policy without changing the orchestration.
 * @param {object} input.adapters Runtime operations for query planning, retrieval,
 * graph expansion, candidate selection, relation judging, result formatting, and
 * trace construction. Benchmark labels, scoring, diagnosis, reports, and promotion
 * deliberately have no adapter seam here and remain outside this module.
 * @returns {Promise<{result: object, trace: object, state: object}>}
 */
export async function runRetrievalPipeline({ insight, policy = {}, adapters }) {
  if (!insight || typeof insight !== "object") throw new TypeError("insight must be an object.");
  if (!adapters || typeof adapters !== "object") throw new TypeError("adapters must be an object.");

  const state = {
    insight,
    policy,
    generatedQuery: null,
    queries: [],
    retrievalRuns: [],
    retrievalCandidates: [],
    retrievalErrors: [],
    retrievalWarnings: [],
    graphExpansion: null,
    effectiveBudgets: null,
    selectedCandidates: [],
    relationJudge: null,
    finalCandidates: [],
    errors: [],
  };

  const fail = async (stage, error) => {
    state.errors.push({ stage, error });
    const result = adapters.onFailure
      ? await adapters.onFailure({ stage, error, insight, policy, state })
      : { ok: false, error: { stage, message: error instanceof Error ? error.message : String(error) } };
    return finish(result);
  };
  const finish = async (result) => {
    const trace = adapters.buildTrace
      ? await adapters.buildTrace({ insight, policy, state, result })
      : defaultTrace(state, result);
    return { result, trace, state };
  };

  try {
    state.generatedQuery = await requiredAdapter(adapters, "planQueries")({ insight, policy, state });
    state.generatedQuery = mergeSupplementalQueries({
      generatedPlan: state.generatedQuery,
      sourceExcerpt: insight.sourceExcerpt ?? insight.text,
      thought: insight.thought,
      policy: policy.supplements ?? { sourceExcerpt: false, thought: false },
    });
    state.queries = (state.generatedQuery?.queries ?? []).slice(0, positiveLimit(policy.queryLimit));
  } catch (error) {
    return fail("query_generation", error);
  }

  try {
    const retrieval = await requiredAdapter(adapters, "retrieve")({
      insight, policy, state, queries: state.queries,
    });
    state.retrievalRuns = retrieval?.runs ?? [];
    state.retrievalCandidates = retrieval?.candidates
      ?? state.retrievalRuns.flatMap((run) => run.candidates ?? run.rows ?? []);
    state.retrievalErrors = retrieval?.errors ?? state.retrievalRuns.flatMap((run) => run.errors ?? []);
    state.retrievalWarnings = retrieval?.warnings ?? [];
  } catch (error) {
    return fail("qmd_retrieval", error);
  }

  if (policy.graphExpansion !== false && (adapters.expandGraph || adapters.graphAdapters)) {
    try {
      state.graphExpansion = adapters.graphAdapters
        ? await expandGraphCandidates({
          sourcePath: insight.sourcePath,
          rankedSeeds: state.retrievalCandidates,
          policy,
          adapters: adapters.graphAdapters({ insight, policy, state }),
        })
        : await adapters.expandGraph({ insight, policy, state });
    } catch (error) {
      return fail("source_expansion", error);
    }
  }

  try {
    const graphCandidates = state.graphExpansion?.candidates ?? state.graphExpansion?.rows ?? [];
    state.selectedCandidates = await requiredAdapter(adapters, "selectCandidates")({
      insight,
      policy,
      state,
      retrievalCandidates: state.retrievalCandidates,
      graphCandidates,
    });
  } catch (error) {
    return fail(error?.pipelineStage ?? "candidate_selection", error);
  }

  try {
    if (policy.chunkedJudge !== false && policy.candidateBudgets && adapters.judgeRelationChunk) {
      state.effectiveBudgets = validateChunkedJudgePolicy(policy.candidateBudgets);
      state.relationJudge = await runChunkedRelationJudge({
        candidates: state.selectedCandidates,
        policy: state.effectiveBudgets,
        judgeChunk: (candidates, context) => adapters.judgeRelationChunk({ insight, policy, state, candidates, context }),
        compareGlobally: adapters.compareRelationsGlobally
          ? (candidates, context) => adapters.compareRelationsGlobally({ insight, policy, state, candidates, context })
          : undefined,
        validateEvidence: adapters.validateRelationEvidence,
        candidateId: adapters.candidateId,
      });
    } else {
      state.relationJudge = await requiredAdapter(adapters, "judgeRelations")({
        insight, policy, state, candidates: state.selectedCandidates,
      });
    }
    state.finalCandidates = state.relationJudge?.ok === false && policy.failClosed !== false
      ? []
      : (state.relationJudge?.candidates ?? state.selectedCandidates)
        .slice(0, positiveLimit(policy.finalCandidateLimit));
  } catch (error) {
    return fail("relation_judge", error);
  }

  try {
    const result = adapters.formatResult
      ? await adapters.formatResult({ insight, policy, state, finalCandidates: state.finalCandidates })
      : { ok: true, candidates: state.finalCandidates };
    return finish(result);
  } catch (error) {
    return fail("result_formatting", error);
  }
}

function requiredAdapter(adapters, name) {
  if (typeof adapters[name] !== "function") throw new TypeError(`adapters.${name} must be a function.`);
  return adapters[name];
}

function positiveLimit(value) {
  return Number.isInteger(value) && value > 0 ? value : Number.POSITIVE_INFINITY;
}

function defaultTrace(state, result) {
  return {
    schema: "PipelineTrace",
    version: 2,
    status: result?.ok === false ? "failed" : "success",
    source: { file: state.insight.sourcePath ?? null },
    errors: state.errors.map(({ stage, error }) => ({
      stage,
      message: error instanceof Error ? error.message : String(error),
    })),
  };
}
import { runChunkedRelationJudge, validateChunkedJudgePolicy } from "./chunked-relation-judge.mjs";
import { expandGraphCandidates } from "./graph-expansion.mjs";
import { mergeSupplementalQueries } from "./supplemental-queries.mjs";
