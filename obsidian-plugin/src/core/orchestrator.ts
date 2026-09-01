// Full-pipeline orchestration shared between the plugin and bench (ADR 0005,
// issue #57). Wires the deterministic retrieval path (qmd.ts + pool.ts, core
// since #56) together with the LLM path (query-plan-llm.ts, relation-judge.ts,
// this ticket), producing the aha-result.schema.json shape end to end —
// mirroring the assembly order of the frozen legacy wrapper
// scripts/aha/run-insight-search.mjs's pipelineRecall (read-only reference;
// not imported here). Issue #58 wires this into the actual Obsidian plugin;
// for #57 this only needs to exist in core, be tested, and be ready for #58
// to call.
//
// This module must stay free of `obsidian` imports, node imports, and
// module-level I/O: every effect (LLM HTTP calls, QMD query execution, vault
// reads, realpath) flows through injected deps.

import {
  DEFAULT_EXCLUDED_CANDIDATE_FOLDERS,
  type CandidateFilterArgs,
  type VaultBoundaryDeps,
  isObsidianQmdUri,
  qmdUriVaultPath,
  resolveVaultContainedPath,
} from "./candidates";
import { type GraphExpansionDeps, graphExpansionRows } from "./graph-expansion";
import { type LlmProtocol, type LlmThinking, type LlmTransportDeps } from "./llm-transport";
import { excerptNoteMarkdown, isSubstantiveExcerpt } from "./note-excerpt";
import { mergeAndRankQueryResults, pipelineCandidate } from "./pool";
import { type QmdDeps, runQmdPlanQueries } from "./qmd";
import { type DeterministicPlanArgs, type PlanQuery, compactLine } from "./query-plan-deterministic";
import { generateQueryPlanViaLlm, type QueryPlanPromptOverride } from "./query-plan-llm";
import type { PooledCandidate } from "./pool";
import type { QmdQueryOutcome } from "./qmd";
import {
  type RelationJudgeCandidate,
  type RelationJudgeCandidateInput,
  judgeCandidateRelationsViaLlm,
} from "./relation-judge";

export interface OrchestratorArgs extends CandidateFilterArgs, DeterministicPlanArgs {
  sourcePath: string;
  sourceText: string;
  targetCandidates?: number;
  /** Maximum candidate excerpts Relation Judge may review in one round. */
  relationJudgeBudget?: number;
  excludedFolders?: readonly string[];
  vaultRootPrefix?: unknown;
  /**
   * Additive (issue #59): a settings-level query-plan prompt override,
   * threaded straight through to generateQueryPlanViaLlm's own optional
   * parameter of the same shape. Omitting this field (the default for every
   * existing caller, including bench) preserves the exact existing
   * query-planning behavior byte-for-byte.
   */
  queryPromptOverride?: QueryPlanPromptOverride;
}

export interface OrchestratorLlmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  protocol: LlmProtocol;
  timeoutMs?: number;
  /**
   * DeepSeek chat-completions thinking control (llm-transport.ts). Optional
   * and omitted from the body when unset -- every existing caller (including
   * the plugin's tier-pipeline.ts, which never set this) keeps behaving
   * exactly as before this field was added.
   */
  thinking?: LlmThinking;
}

export interface OrchestratorDeps extends LlmTransportDeps, QmdDeps, VaultBoundaryDeps, GraphExpansionDeps {
  /** Reads a note's raw markdown given a resolved absolute path. */
  readNote(absolutePath: string): Promise<string>;
}

export interface AhaResultError {
  message: string;
  tool: string;
  details: string;
}

export interface AhaResultSuccess {
  ok: true;
  sourcePath: string;
  generatedAt: string;
  summary: string;
  warnings: string[];
  error: null;
  candidates: RelationJudgeCandidate[];
  /**
   * Additive (issue #59): query-plan generation metadata, carried out of the
   * one-shot pipeline so plugin-side callers can build a Pipeline Trace
   * (ADR 0003) without re-running query planning themselves. Not part of the
   * frozen aha-result.schema.json shape -- plugin code copies only the
   * fields it needs into a fresh object rather than passing this AhaResult
   * straight through to result validation (see tier-result.ts).
   */
  queryPlanGeneratedBy: "llm" | "rules";
  queryPlanFallback: boolean;
  queryPlanPromptVersion: string;
  queryPlanQueries: PlanQuery[];
  /** Per-query QMD retrieval results for trace diagnostics. */
  qmdQueryResults: QmdQueryOutcome[];
  /** Pool-merged candidates before Relation Judge, for trace diagnostics. */
  pooledCandidates: PooledCandidate[];
  relationJudgeTrace: RelationJudgeTrace;
}

export interface AhaResultFailure {
  ok: false;
  sourcePath: string;
  generatedAt: string;
  summary: string;
  warnings: string[];
  error: AhaResultError;
  candidates: RelationJudgeCandidate[];
  queryPlanGeneratedBy: "llm" | "rules";
  queryPlanFallback: boolean;
  queryPlanPromptVersion: string;
  queryPlanQueries: PlanQuery[];
  /** Per-query QMD retrieval results for trace diagnostics. */
  qmdQueryResults: QmdQueryOutcome[];
  /** Pool-merged candidates before Relation Judge, for trace diagnostics. */
  pooledCandidates: PooledCandidate[];
  relationJudgeTrace: RelationJudgeTrace;
}

export type AhaResult = AhaResultSuccess | AhaResultFailure;

const DEFAULT_TARGET_CANDIDATES = 20;
export const DEFAULT_RELATION_JUDGE_BUDGET = 40;

export type RelationJudgeStopReason = "target_reached" | "pool_exhausted" | "budget_exhausted";

export interface RelationJudgeBatchTrace {
  batchIndex: number;
  refillSource: "initial" | "weak_backfill";
  poolStartRank: number;
  poolEndRank: number;
  candidatePaths: string[];
  reviewedCount: number;
  nonWeakCount: number;
  weakCount: number;
  failedCount: number;
  repairedCount: number;
  callCount: number;
  elapsedMs: number;
}

export interface RelationJudgeTrace {
  targetNonWeakCount: number;
  budget: number;
  poolSize: number;
  reviewedCount: number;
  nonWeakCount: number;
  weakCount: number;
  failedCount: number;
  repairedCount: number;
  callCount: number;
  elapsedMs: number;
  stopReason: RelationJudgeStopReason;
  batches: RelationJudgeBatchTrace[];
}

/**
 * Runs the full Aha pipeline: LLM query planning (falling back to
 * deterministic rules on failure, #56/#57), QMD retrieval, candidate pool
 * merge/rank, candidate excerpt loading, and LLM Relation Judging — returning
 * the aha-result.schema.json shape on success or a structured failure. There
 * Weak results are backfilled from the retrieval-ordered pool until the
 * non-weak target, pool end, or review budget is reached. There is no
 * fake-success path: if every attempted Relation Judge call fails, `ok` is
 * false and `error` is populated even though weak candidates stay attached
 * for diagnostics.
 */
export async function runFullPipeline(
  args: OrchestratorArgs,
  llm: OrchestratorLlmConfig,
  deps: OrchestratorDeps,
): Promise<AhaResult> {
  const targetCandidates = positiveInteger(args.targetCandidates, DEFAULT_TARGET_CANDIDATES);
  const relationJudgeBudget = positiveInteger(args.relationJudgeBudget, DEFAULT_RELATION_JUDGE_BUDGET);
  const transportRequest = {
    baseUrl: llm.baseUrl,
    apiKey: llm.apiKey,
    model: llm.model,
    protocol: llm.protocol,
    timeoutMs: llm.timeoutMs,
    thinking: llm.thinking,
  };

  const planOutcome = await generateQueryPlanViaLlm(args, args.sourceText, transportRequest, deps, args.queryPromptOverride);
  const planWarning = `Query plan generated by ${planOutcome.generatedBy}${
    planOutcome.fallback ? ` after fallback: ${planOutcome.error}` : ""
  }.`;

  const { queryResults, warnings: queryWarnings, errors: queryErrors } = await runQmdPlanQueries(
    planOutcome.queries,
    deps,
  );

  const graphWarnings: string[] = [];
  if (deps.listGraphNeighbors) {
    try {
      const graphOutcome = await deps.listGraphNeighbors(args.sourcePath);
      graphWarnings.push(...graphOutcome.warnings);
      const rows = graphExpansionRows(args.sourcePath, graphOutcome.neighbors);
      if (rows.length > 0) {
        queryResults.push({
          query: { kind: "obsidian_graph", command: "obsidian links/backlinks" },
          rows,
        });
      }
    } catch (error) {
      graphWarnings.push(`Obsidian graph expansion failed: ${error instanceof Error ? error.message : String(error)}`);
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
  const candidates = pooled.map(pipelineCandidate) as unknown as RelationJudgeCandidate[];

  if (candidates.length === 0) {
    return {
      ok: false,
      sourcePath: args.sourcePath,
      generatedAt: new Date().toISOString(),
      summary: "Aha mixed retrieval returned no usable candidates.",
      warnings: [
        planWarning,
        ...graphWarnings,
        ...queryErrors.map((error) => `Skipped failed query: ${error}`),
      ],
      error: {
        message: "Aha retrieval returned no usable candidates.",
        tool: "qmd",
        details: queryErrors.length > 0
          ? queryErrors.join("; ")
          : "QMD retrieval returned no vault-contained candidates after self-hit and path-boundary filtering.",
      },
      candidates: [],
      queryPlanGeneratedBy: planOutcome.generatedBy,
      queryPlanFallback: planOutcome.fallback,
      queryPlanPromptVersion: planOutcome.promptVersion,
      queryPlanQueries: planOutcome.queries,
      qmdQueryResults: queryResults,
      pooledCandidates: pooled,
      relationJudgeTrace: emptyRelationJudgeTrace(targetCandidates, relationJudgeBudget, 0, "pool_exhausted"),
    };
  }

  const excerptWarnings: string[] = [];
  const judgedCandidates: RelationJudgeCandidate[] = [];
  const judgeWarnings: string[] = [];
  const batches: RelationJudgeBatchTrace[] = [];
  const judgeErrors: string[] = [];
  let poolCursor = 0;
  let reviewedCount = 0;
  let nonWeakCount = 0;
  let callCount = 0;
  let failedCount = 0;
  let repairedCount = 0;
  let successfulJudgmentCount = 0;
  const judgeStartedAt = Date.now();

  while (
    nonWeakCount < targetCandidates
    && poolCursor < candidates.length
    && reviewedCount < relationJudgeBudget
  ) {
    const batchIndex = batches.length + 1;
    const poolStartRank = poolCursor + 1;
    const desiredReviews = Math.min(
      targetCandidates - nonWeakCount,
      relationJudgeBudget - reviewedCount,
    );
    const batchCandidates: RelationJudgeCandidate[] = [];
    const candidateInputs: RelationJudgeCandidateInput[] = [];

    while (poolCursor < candidates.length && candidateInputs.length < desiredReviews) {
      const candidate = candidates[poolCursor];
      poolCursor += 1;
      const excerpt = await readCandidateExcerpt(args, candidate, deps);
      if (!excerpt) {
        excerptWarnings.push(
          `Could not read a vault-contained excerpt for ${candidate.notePath}; relation judging skipped this candidate.`,
        );
        continue;
      }
      if (!isSubstantiveExcerpt(excerpt)) {
        excerptWarnings.push(
          `Skipped ${candidate.notePath}: excerpt has no substantive text (template or empty note).`,
        );
        continue;
      }
      batchCandidates.push(candidate);
      candidateInputs.push({
        notePath: candidate.notePath,
        noteTitle: candidate.noteTitle as string | undefined,
        retrievalHit: candidate.hit as string | undefined,
        retrievalWhy: candidate.why as string | undefined,
        excerpt,
      });
    }

    if (candidateInputs.length === 0) continue;

    const batchStartedAt = Date.now();
    const relationJudge = await judgeCandidateRelationsViaLlm(
      {
        sourcePath: args.sourcePath,
        sourceText: args.sourceText,
        candidates: batchCandidates,
        candidateInputs,
        generatedBy: "llm",
      },
      transportRequest,
      deps,
    );
    const batchElapsedMs = Date.now() - batchStartedAt;
    const batchFinalCandidates = relationJudge.candidates ?? batchCandidates;
    const batchNonWeakCount = batchFinalCandidates.filter(isNonWeakCandidate).length;
    const batchFailedCount = relationJudge.failedCount;

    judgedCandidates.push(...batchFinalCandidates);
    reviewedCount += candidateInputs.length;
    nonWeakCount += batchNonWeakCount;
    callCount += relationJudge.callCount;
    failedCount += batchFailedCount;
    repairedCount += relationJudge.repairedCount;
    successfulJudgmentCount += candidateInputs.length - batchFailedCount;
    judgeWarnings.push(...relationJudge.warnings);
    if (!relationJudge.ok) judgeErrors.push(relationJudge.error);
    batches.push({
      batchIndex,
      refillSource: batchIndex === 1 ? "initial" : "weak_backfill",
      poolStartRank,
      poolEndRank: poolCursor,
      candidatePaths: batchCandidates.map((candidate) => candidate.notePath),
      reviewedCount: candidateInputs.length,
      nonWeakCount: batchNonWeakCount,
      weakCount: Math.max(0, candidateInputs.length - batchNonWeakCount - batchFailedCount),
      failedCount: batchFailedCount,
      repairedCount: relationJudge.repairedCount,
      callCount: relationJudge.callCount,
      elapsedMs: batchElapsedMs,
    });
  }

  const stopReason: RelationJudgeStopReason = nonWeakCount >= targetCandidates
    ? "target_reached"
    : reviewedCount >= relationJudgeBudget
      ? "budget_exhausted"
      : "pool_exhausted";
  const relationJudgeTrace: RelationJudgeTrace = {
    targetNonWeakCount: targetCandidates,
    budget: relationJudgeBudget,
    poolSize: candidates.length,
    reviewedCount,
    nonWeakCount,
    weakCount: Math.max(0, reviewedCount - nonWeakCount - failedCount),
    failedCount,
    repairedCount,
    callCount,
    elapsedMs: Date.now() - judgeStartedAt,
    stopReason,
    batches,
  };
  const finalCandidates = judgedCandidates.map(stripInternalFields);
  const plannerSummary = `LLM generated ${planOutcome.model_query_count} QMD query rewrites${
    planOutcome.fallback ? " (fallback rules used)" : ""
  }`;
  const skippedCount = poolCursor - reviewedCount;
  const summary = `${plannerSummary}; mixed retrieval returned ${candidates.length} pooled candidates${skippedCount > 0 ? ` (${skippedCount} empty/template skipped)` : ""}; Relation Judge reviewed ${reviewedCount} candidate excerpts in ${batches.length} batch(es), found ${nonWeakCount} non-weak candidate(s), and stopped because ${stopReason}.`;
  const relationJudgeFailed = reviewedCount === 0 || successfulJudgmentCount === 0;
  const warnings = [
    planWarning,
    !relationJudgeFailed
      ? "Relation Judge ran on bounded candidate excerpts; strong relation labels require quote evidence from the excerpt."
      : `Relation Judge unavailable; returning structured failure instead of treating weak candidates as success: ${judgeErrors.join("; ") || "No candidate excerpts were readable."}`,
    ...excerptWarnings,
    ...judgeWarnings,
    ...queryWarnings,
    ...graphWarnings,
    ...queryErrors.map((error) => `Skipped failed query: ${error}`),
  ];

  if (relationJudgeFailed) {
    return {
      ok: false,
      sourcePath: args.sourcePath,
      generatedAt: new Date().toISOString(),
      summary,
      warnings,
      error: {
        message: "Aha Relation Judge failed.",
        tool: reviewedCount === 0 ? "qmd" : "llm",
        details: judgeErrors.join("; ") || "No candidate excerpts were readable, so Relation Judge did not run.",
      },
      candidates: finalCandidates,
      queryPlanGeneratedBy: planOutcome.generatedBy,
      queryPlanFallback: planOutcome.fallback,
      queryPlanPromptVersion: planOutcome.promptVersion,
      queryPlanQueries: planOutcome.queries,
      qmdQueryResults: queryResults,
      pooledCandidates: pooled,
      relationJudgeTrace,
    };
  }

  return {
    ok: true,
    sourcePath: args.sourcePath,
    generatedAt: new Date().toISOString(),
    summary,
    warnings,
    error: null,
    candidates: finalCandidates,
    queryPlanGeneratedBy: planOutcome.generatedBy,
    queryPlanFallback: planOutcome.fallback,
    queryPlanPromptVersion: planOutcome.promptVersion,
    queryPlanQueries: planOutcome.queries,
    qmdQueryResults: queryResults,
    pooledCandidates: pooled,
    relationJudgeTrace,
  };
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

function isNonWeakCandidate(candidate: RelationJudgeCandidate): boolean {
  return candidate.relation !== "weak";
}

function emptyRelationJudgeTrace(
  targetNonWeakCount: number,
  budget: number,
  poolSize: number,
  stopReason: RelationJudgeStopReason,
): RelationJudgeTrace {
  return {
    targetNonWeakCount,
    budget,
    poolSize,
    reviewedCount: 0,
    nonWeakCount: 0,
    weakCount: 0,
    failedCount: 0,
    repairedCount: 0,
    callCount: 0,
    elapsedMs: 0,
    stopReason,
    batches: [],
  };
}

// Mirrors readPipelineCandidateExcerpt in the frozen legacy wrapper: try the
// candidate's raw retrieval locations (obsidian qmd:// URIs resolved through
// the vault graph, or plain vault-relative/absolute paths) before falling
// back to the candidate's own notePath, returning the first vault-contained
// excerpt that reads successfully.
async function readCandidateExcerpt(
  args: OrchestratorArgs,
  candidate: RelationJudgeCandidate,
  deps: OrchestratorDeps,
): Promise<string> {
  const raw = String(candidate.notePath ?? "");
  if (!raw) return "";
  const rawLocations = Array.isArray(candidate._rawLocations) ? (candidate._rawLocations as string[]) : [];
  const locations = Array.from(new Set([...rawLocations, raw]));

  for (const location of locations) {
    if (isObsidianQmdUri(location)) {
      try {
        const filePath = await qmdUriVaultPath(args, location, deps);
        if (filePath) return excerptNoteMarkdown(await deps.readNote(filePath));
      } catch {
        // Try the next plausible location.
      }
      continue;
    }
    try {
      const filePath = await resolveVaultContainedPath(args, location, deps);
      if (filePath) return excerptNoteMarkdown(await deps.readNote(filePath));
    } catch {
      // Try the next plausible location.
    }
  }
  return "";
}

function stripInternalFields(candidate: RelationJudgeCandidate): RelationJudgeCandidate {
  const { _rawLocations, ...publicCandidate } = candidate;
  return publicCandidate as RelationJudgeCandidate;
}
