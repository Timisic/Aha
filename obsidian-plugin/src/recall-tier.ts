// Recall Tier (issue #58; CONTEXT.md "Recall Tier"): the capability tier
// used when the retrieval backend works but no LLM access is available.
// Owns only what is tier-specific -- deterministic query planning
// (queryPlanFromFallbackRules, no LLM) and how the round is reported --
// and delegates the retrieval itself to core's Memory Retrieval module
// (core/memory-retrieval.ts), the same one Full Tier uses. The result is a
// ranked, unjudged (`relation: "weak"`) candidate list. Review feedback
// (accept/reject_as_noise/should_have_found) still works on these candidates
// because review-panel.ts's feedback actions operate generically on
// ReviewPanelCandidate regardless of how a candidate was produced.

import {
  DEFAULT_TARGET_CANDIDATES,
  formatTierHeader,
  pipelineCandidate,
  queryPlanFromFallbackRules,
  retrieveMemoryCandidates,
  type CandidateFilterArgs,
  type DeterministicPlanArgs,
  type MemoryRetrievalDeps,
  type PipelineCandidateShape,
} from "./core";
import type { AhaCandidate, AhaWrapperResult } from "./schema";

export interface RecallTierArgs extends CandidateFilterArgs, DeterministicPlanArgs {
  sourcePath: string;
  targetCandidates?: number;
  excludedFolders?: readonly string[];
  vaultRootPrefix?: unknown;
}

function stripRawLocations(candidate: PipelineCandidateShape): AhaCandidate {
  const { _rawLocations, ...rest } = candidate;
  void _rawLocations;
  return rest;
}

/**
 * Runs the Recall Tier pipeline: deterministic multi-query plan, then the
 * shared Memory Retrieval round (qmd retrieval, graph expansion when the
 * injected deps provide it, pool merge/rank) -- exactly the deterministic
 * half of runFullPipeline (core/orchestrator.ts), stopping before LLM query
 * planning and Relation Judge. Never throws: per-query qmd failures and
 * graph-expansion failures are already caught inside the retrieval module
 * and surfaced as warnings, so a partial or even total retrieval failure
 * still resolves to an honest ok:true result with whatever candidates
 * (possibly zero) survived -- Recall Tier is not an error state.
 */
export async function runRecallTier(
  args: RecallTierArgs,
  deps: MemoryRetrievalDeps,
): Promise<AhaWrapperResult> {
  const targetCandidates = args.targetCandidates ?? DEFAULT_TARGET_CANDIDATES;
  const plan = queryPlanFromFallbackRules(args);
  const retrieval = await retrieveMemoryCandidates(args, plan.queries, deps);
  const candidates = retrieval.pooled
    .slice(0, targetCandidates)
    .map((candidate) => stripRawLocations(pipelineCandidate(candidate)));

  const header = formatTierHeader("recall", "no LLM configured");
  const summary = `${header}. Deterministic multi-query retrieval plus graph expansion ranked ${candidates.length} candidate(s) by retrieval prior; relation judging did not run, and review feedback is still collected as seed material.`;

  return {
    ok: true,
    sourcePath: args.sourcePath,
    generatedAt: new Date().toISOString(),
    summary,
    warnings: [
      ...retrieval.warnings,
      ...retrieval.errors.map((error) => `Skipped failed query: ${error}`),
    ],
    candidates,
  };
}
