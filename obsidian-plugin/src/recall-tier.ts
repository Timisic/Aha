// Recall Tier (issue #58; CONTEXT.md "Recall Tier"): the capability tier
// used when the retrieval backend works but no LLM access is available.
// Wires core's deterministic pieces together -- queryPlanFromFallbackRules
// (no LLM query planning) -> the plugin's qmd CLI adapter + runQmdPlanQueries
// -> mergeAndRankQueryResults/pipelineCandidate (pool merge/rank, no LLM) --
// into a ranked, unjudged (`relation: "weak"`) candidate list. Review
// feedback (accept/reject_as_noise/should_have_found) still works on these
// candidates because review-panel.ts's feedback actions operate generically
// on ReviewPanelCandidate regardless of how a candidate was produced.

import {
  DEFAULT_EXCLUDED_CANDIDATE_FOLDERS,
  formatTierHeader,
  mergeAndRankQueryResults,
  pipelineCandidate,
  queryPlanFromFallbackRules,
  runQmdPlanQueries,
  type CandidateFilterArgs,
  type DeterministicPlanArgs,
  type PipelineCandidateShape,
  type QmdDeps,
  type VaultBoundaryDeps,
} from "./core";
import type { AhaCandidate, AhaWrapperResult } from "./schema";

export interface RecallTierArgs extends CandidateFilterArgs, DeterministicPlanArgs {
  sourcePath: string;
  targetCandidates?: number;
  excludedFolders?: readonly string[];
  vaultRootPrefix?: unknown;
}

const DEFAULT_TARGET_CANDIDATES = 20;

function stripRawLocations(candidate: PipelineCandidateShape): AhaCandidate {
  const { _rawLocations, ...rest } = candidate;
  void _rawLocations;
  return rest;
}

/**
 * Runs the Recall Tier pipeline: deterministic multi-query plan, qmd
 * retrieval per query, pool merge/rank -- exactly the deterministic half of
 * runFullPipeline (core/orchestrator.ts), stopping before LLM query planning
 * and Relation Judge. Never throws: per-query qmd failures are already
 * caught by runQmdPlanQueries and surfaced as warnings, so a partial or even
 * total retrieval failure still resolves to an honest ok:true result with
 * whatever candidates (possibly zero) survived -- Recall Tier is not an
 * error state.
 */
export async function runRecallTier(
  args: RecallTierArgs,
  deps: QmdDeps & VaultBoundaryDeps,
): Promise<AhaWrapperResult> {
  const targetCandidates = args.targetCandidates ?? DEFAULT_TARGET_CANDIDATES;
  const plan = queryPlanFromFallbackRules(args);
  const { queryResults, warnings: queryWarnings, errors: queryErrors } = await runQmdPlanQueries(plan.queries, deps);
  const pooled = await mergeAndRankQueryResults(
    args,
    queryResults,
    {
      excludedFolders: args.excludedFolders ?? DEFAULT_EXCLUDED_CANDIDATE_FOLDERS,
      vaultRootPrefix: args.vaultRootPrefix,
    },
    deps,
  );
  const candidates = pooled.slice(0, targetCandidates).map((candidate) => stripRawLocations(pipelineCandidate(candidate)));

  const header = formatTierHeader("recall", "no LLM configured");
  const summary = `${header}. Deterministic multi-query retrieval plus graph expansion ranked ${candidates.length} candidate(s) by retrieval prior; relation judging did not run, and review feedback is still collected as seed material.`;

  return {
    ok: true,
    sourcePath: args.sourcePath,
    generatedAt: new Date().toISOString(),
    summary,
    warnings: [...queryWarnings, ...queryErrors.map((error) => `Skipped failed query: ${error}`)],
    candidates,
  };
}
