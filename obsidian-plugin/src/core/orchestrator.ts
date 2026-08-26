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
}

export type AhaResult = AhaResultSuccess | AhaResultFailure;

const DEFAULT_TARGET_CANDIDATES = 20;

/**
 * Runs the full Aha pipeline: LLM query planning (falling back to
 * deterministic rules on failure, #56/#57), QMD retrieval, candidate pool
 * merge/rank, candidate excerpt loading, and LLM Relation Judging — returning
 * the aha-result.schema.json shape on success or a structured failure. There
 * is no fake-success path: if Relation Judge fails, `ok` is false and `error`
 * is populated even though (weak, pre-judge) candidates are still attached
 * for diagnostics, matching the legacy wrapper's failure shape.
 */
export async function runFullPipeline(
  args: OrchestratorArgs,
  llm: OrchestratorLlmConfig,
  deps: OrchestratorDeps,
): Promise<AhaResult> {
  const targetCandidates = args.targetCandidates ?? DEFAULT_TARGET_CANDIDATES;
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
  const candidates = pooled.slice(0, targetCandidates).map(pipelineCandidate) as unknown as RelationJudgeCandidate[];

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
    };
  }

  const candidateInputs: RelationJudgeCandidateInput[] = [];
  const excerptWarnings: string[] = [];
  const substantiveCandidates: RelationJudgeCandidate[] = [];
  for (const candidate of candidates) {
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
    substantiveCandidates.push(candidate);
    candidateInputs.push({
      notePath: candidate.notePath,
      noteTitle: candidate.noteTitle as string | undefined,
      retrievalHit: candidate.hit as string | undefined,
      retrievalWhy: candidate.why as string | undefined,
      excerpt,
    });
  }

  const relationJudge = await judgeCandidateRelationsViaLlm(
    {
      sourcePath: args.sourcePath,
      sourceText: args.sourceText,
      candidates: substantiveCandidates,
      candidateInputs,
      generatedBy: "llm",
    },
    transportRequest,
    deps,
  );

  const finalCandidates = (relationJudge.candidates ?? substantiveCandidates).map(stripInternalFields);
  const plannerSummary = `LLM generated ${planOutcome.model_query_count} QMD query rewrites${
    planOutcome.fallback ? " (fallback rules used)" : ""
  }`;
  const skippedCount = candidates.length - substantiveCandidates.length;
  const summary = `${plannerSummary}; mixed retrieval returned ${candidates.length} reranked candidates${skippedCount > 0 ? ` (${skippedCount} empty/template skipped)` : ""}; Relation Judge reviewed ${relationJudge.reviewedCount} candidate excerpts.`;
  const warnings = [
    planWarning,
    relationJudge.ok
      ? "Relation Judge ran on bounded candidate excerpts; strong relation labels require quote evidence from the excerpt."
      : `Relation Judge unavailable; returning structured failure instead of treating weak candidates as success: ${relationJudge.error}`,
    ...excerptWarnings,
    ...relationJudge.warnings,
    ...queryWarnings,
    ...graphWarnings,
    ...queryErrors.map((error) => `Skipped failed query: ${error}`),
  ];

  if (!relationJudge.ok) {
    return {
      ok: false,
      sourcePath: args.sourcePath,
      generatedAt: new Date().toISOString(),
      summary,
      warnings,
      error: {
        message: "Aha Relation Judge failed.",
        tool: relationJudge.tool ?? "llm",
        details: relationJudge.error,
      },
      candidates: finalCandidates,
      queryPlanGeneratedBy: planOutcome.generatedBy,
      queryPlanFallback: planOutcome.fallback,
      queryPlanPromptVersion: planOutcome.promptVersion,
      queryPlanQueries: planOutcome.queries,
      qmdQueryResults: queryResults,
      pooledCandidates: pooled,
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
