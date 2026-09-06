// Memory Retrieval (CONTEXT.md "Retrieval Orchestration"): the one module
// that owns *how* a Memory Search Round turns a query plan into a ranked
// candidate pool -- QMD execution, Obsidian graph expansion, vault-boundary
// filtering, and pool merge/rank, in that order.
//
// Before this module, Recall Tier (recall-tier.ts) and Full Tier
// (orchestrator.ts) each re-assembled that sequence at their own call site,
// and the two had already drifted: Recall ran QMD only, while its own
// summary told users graph expansion had run. Retrieval order now lives in
// one place; the tiers keep what is genuinely theirs (query planning, result
// wording, Relation Judge).
//
// This module must stay free of `obsidian` imports, node imports, and
// module-level I/O: QMD execution, neighbor lookup and realpath all arrive
// through injected deps (ADR 0005's transport seam).

import {
  DEFAULT_EXCLUDED_CANDIDATE_FOLDERS,
  type CandidateFilterArgs,
  type VaultBoundaryDeps,
} from "./candidates";
import { type GraphExpansionDeps, graphExpansionRows } from "./graph-expansion";
import { type PooledCandidate, mergeAndRankQueryResults } from "./pool";
import { type QmdDeps, type QmdQueryLike, type QmdQueryOutcome, runQmdPlanQueries } from "./qmd";

export interface MemoryRetrievalArgs extends CandidateFilterArgs {
  sourcePath: string;
  /**
   * Folders excluded from candidates. Interpreted by
   * search-round-settings.ts; an empty array intentionally means "exclude
   * nothing via this mechanism" (pool.ts still always drops generated review
   * notes). Omitted entirely falls back to core's built-in default list.
   */
  excludedFolders?: readonly string[];
  vaultRootPrefix?: unknown;
}

export type MemoryRetrievalDeps = QmdDeps & VaultBoundaryDeps & GraphExpansionDeps;

export interface MemoryRetrievalOutcome {
  /** Per-query retrieval results, graph expansion included, for trace diagnostics. */
  queryResults: QmdQueryOutcome[];
  /** Merged, filtered and ranked candidate pool. */
  pooled: PooledCandidate[];
  /** Non-fatal notices from QMD and graph expansion, in execution order. */
  warnings: string[];
  /** Per-query failures; callers decide how to phrase them. */
  errors: string[];
}

/**
 * Runs one round of memory retrieval for an already-generated query plan.
 *
 * Never throws: a failed query, a failed graph expansion, or a completely
 * empty result all resolve to an outcome carrying warnings and whatever
 * candidates survived. Deps without `listGraphNeighbors` simply skip graph
 * expansion, exactly as before this module existed.
 */
export async function retrieveMemoryCandidates(
  args: MemoryRetrievalArgs,
  queries: QmdQueryLike[],
  deps: MemoryRetrievalDeps,
): Promise<MemoryRetrievalOutcome> {
  const { queryResults, warnings, errors } = await runQmdPlanQueries(queries, deps);

  if (deps.listGraphNeighbors) {
    try {
      const graphOutcome = await deps.listGraphNeighbors(args.sourcePath);
      warnings.push(...graphOutcome.warnings);
      const rows = graphExpansionRows(args.sourcePath, graphOutcome.neighbors);
      if (rows.length > 0) {
        queryResults.push({
          query: { kind: "obsidian_graph", command: "obsidian links/backlinks" },
          rows,
        });
      }
    } catch (error) {
      warnings.push(`Obsidian graph expansion failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const pooled = await mergeAndRankQueryResults(
    args,
    queryResults,
    {
      excludedFolders: args.excludedFolders ?? DEFAULT_EXCLUDED_CANDIDATE_FOLDERS,
      vaultRootPrefix: args.vaultRootPrefix,
    },
    deps,
  );

  return { queryResults, pooled, warnings, errors };
}
