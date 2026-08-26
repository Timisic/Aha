// Plugin-side, lighter Pipeline Trace writer (issue #59; ADR 0003). The
// bench-side scripts/lib/pipeline-trace.mjs builds a much richer trace
// (backlink expansion, gold-label positions, rerank chunking with
// `rerankId`s) that only makes sense for benchmark cases with gold labels --
// none of that exists on the plugin's internalized search path (#58 never
// does backlink expansion or gold-label scoring). This module builds a
// plugin-appropriate trace that reuses the SAME top-level schema/version
// markers plus the additive `origin` field, with honest `null`/empty values
// for the parts that genuinely don't apply or aren't available from the
// plugin's one-shot tier-pipeline calls (see the module comment on
// buildPluginPipelineTrace below for exactly which fields are approximated
// and why).
//
// Deliberately NOT importing scripts/lib/pipeline-trace.mjs directly: that
// file has static `node:crypto`/`node:fs`/`node:path` imports, the same
// bundling hazard #57 hit with result-validator.mjs (see core/result-validator.ts's
// comment). TRACE_SCHEMA/TRACE_VERSION are duplicated as literals here and
// kept in sync via a dedicated guard test
// (scripts/aha/tests/pipeline-trace-plugin.test.mjs) that imports both this
// file and the exported constants from pipeline-trace.mjs and asserts they
// are equal -- the same pattern core-result-validator.test.mjs established
// for AHA_RESULT_SCHEMA.
//
// This module uses Node's `crypto`/`fs`/`path` via getNodeRequire(), the
// same pattern process.ts and qmd-request.ts already use for other Node
// built-ins, so it is safe to bundle into the plugin (no static node:*
// imports).

import type { AhaWrapperResult } from "./schema";

/** Duplicated from scripts/lib/pipeline-trace.mjs; kept in sync by a guard test. */
export const TRACE_SCHEMA = "PipelineTrace";
export const TRACE_VERSION = 1;

function getNodeRequire(): NodeRequire {
  const globalRequire = (globalThis as { require?: NodeRequire }).require;
  if (typeof globalRequire === "function") return globalRequire;
  const windowRequire = (globalThis as { window?: { require?: NodeRequire } }).window?.require;
  if (typeof windowRequire === "function") return windowRequire;
  throw new Error("Node require is unavailable.");
}

function sha256Hex(value: string): string {
  const crypto = getNodeRequire()("crypto") as typeof import("crypto");
  return crypto.createHash("sha256").update(value).digest("hex");
}

function compactWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function boundedSnippet(value: string, maxChars = 300): string {
  const compact = compactWhitespace(value);
  return compact.length <= maxChars ? compact : `${compact.slice(0, maxChars).trimEnd()}...`;
}

export interface PluginTraceQuery {
  kind: string;
  command: string;
  text: string;
}

export interface PluginTraceQueryGeneration {
  generated_by: "llm" | "rules" | null;
  fallback: boolean | null;
  error: string | null;
  prompt_version: string | null;
  queries: PluginTraceQuery[];
}

export interface PluginTraceFinalCandidate {
  rank: number;
  title: string | undefined;
  file: string;
  relation: string | undefined;
  hit: string | undefined;
  why: string | undefined;
  quotes: string[] | undefined;
  content_hash: string;
}

export interface PluginTraceQmdRow {
  file: string;
  title: string;
  score: number | null;
  rank: number;
}

export interface PluginTraceQmdRun {
  kind: string;
  command: string;
  query_text: string;
  row_count: number;
  rows: PluginTraceQmdRow[];
}

export interface PluginTracePooledCandidate {
  rank: number;
  file: string;
  title: string;
  best_score: number;
  rank_score: number;
  final_score: number;
  query_kinds: string[];
  sources: Array<{ kind: string; command: string; rank: number; score: number | null }>;
}

export interface PluginPipelineTrace {
  schema: typeof TRACE_SCHEMA;
  version: typeof TRACE_VERSION;
  origin: "plugin";
  case: {
    id: string;
    title: string;
    resolved_input_hash: string;
    resolved_input_preview: string;
  };
  steps: {
    query_generation: PluginTraceQueryGeneration;
    qmd_runs: PluginTraceQmdRun[];
    /** The plugin path never does backlink expansion (issue #58). */
    backlink_expansion: null;
    pre_rerank_candidates: PluginTracePooledCandidate[] | null;
    rerank: {
      generated_by: "llm" | "none";
      fallback: null;
      error: null;
      ranked_ids: [];
    };
    final_candidates: PluginTraceFinalCandidate[];
  };
  /** The plugin path has no gold labels to position candidates against. */
  gold_positions: null;
  /** Trace diagnosis is a gold-label-driven bench concept; not applicable here. */
  diagnosis: null;
}

export interface BuildPluginPipelineTraceInput {
  sourcePath: string;
  sourceTitle: string;
  sourceText: string;
  tier: "neighborhood" | "recall" | "full";
  result: AhaWrapperResult;
  queryPlan?: {
    generatedBy: "llm" | "rules";
    fallback: boolean;
    error: string | null;
    promptVersion: string;
    queries?: Array<{ kind: string; command: string; text: string }>;
  };
  qmdQueryResults?: Array<{
    query: { kind: string; command: string; query?: string; text?: string };
    rows: Array<{ file?: unknown; path?: unknown; title?: unknown; score?: unknown }>;
  }>;
  pooledCandidates?: Array<{
    notePath: string;
    noteTitle: string;
    bestScore: number;
    rankScore: number;
    finalScore: number;
    queryKinds: Set<string> | string[];
    sources: Array<{ kind: string; command: string; rank: number; score: number | null }>;
  }>;
}

/**
 * Builds a plugin-appropriate Pipeline Trace (ADR 0003) for one search
 * round. `queryPlan` is only present for Full Tier rounds (the only tier
 * that runs LLM query planning); Recall/Neighborhood Tier rounds record
 * `query_generation.generated_by: "rules"` (Recall) or `null` (Neighborhood,
 * which does not generate queries at all).
 */
export function buildPluginPipelineTrace(input: BuildPluginPipelineTraceInput): PluginPipelineTrace {
  const candidates = input.result.candidates ?? [];
  const queryGeneration: PluginTraceQueryGeneration = input.queryPlan
    ? {
        generated_by: input.queryPlan.generatedBy,
        fallback: input.queryPlan.fallback,
        error: input.queryPlan.error,
        prompt_version: input.queryPlan.promptVersion,
        queries: (input.queryPlan.queries ?? []).map((q) => ({ kind: q.kind, command: q.command, text: boundedSnippet(q.text, 400) })),
      }
    : {
        generated_by: input.tier === "recall" ? "rules" : null,
        fallback: input.tier === "recall" ? false : null,
        error: null,
        prompt_version: null,
        queries: [],
      };

  const qmdRuns: PluginTraceQmdRun[] = (input.qmdQueryResults ?? []).map((qr) => {
    const rows: PluginTraceQmdRow[] = qr.rows.map((row, i) => ({
      file: String(row.file ?? row.path ?? ""),
      title: String(row.title ?? ""),
      score: typeof row.score === "number" && Number.isFinite(row.score) ? row.score : null,
      rank: i + 1,
    }));
    return {
      kind: qr.query.kind,
      command: qr.query.command,
      query_text: boundedSnippet(String(qr.query.query ?? qr.query.text ?? ""), 500),
      row_count: rows.length,
      rows: rows.slice(0, 30),
    };
  });

  const preRerankCandidates: PluginTracePooledCandidate[] | null = input.pooledCandidates
    ? input.pooledCandidates.map((pc, i) => ({
        rank: i + 1,
        file: pc.notePath,
        title: pc.noteTitle,
        best_score: pc.bestScore,
        rank_score: pc.rankScore,
        final_score: pc.finalScore,
        query_kinds: pc.queryKinds instanceof Set ? [...pc.queryKinds] : pc.queryKinds,
        sources: pc.sources,
      }))
    : null;

  return {
    schema: TRACE_SCHEMA,
    version: TRACE_VERSION,
    origin: "plugin",
    case: {
      id: input.sourcePath,
      title: input.sourceTitle || input.sourcePath,
      resolved_input_hash: sha256Hex(input.sourceText ?? ""),
      resolved_input_preview: boundedSnippet(input.sourceText ?? ""),
    },
    steps: {
      query_generation: queryGeneration,
      qmd_runs: qmdRuns,
      backlink_expansion: null,
      pre_rerank_candidates: preRerankCandidates,
      // Relation Judge only ever runs from inside the Full Tier code path
      // (runFullPipeline) -- decided by whether queryPlan metadata is
      // present (it is only populated by that same code path), not by which
      // tier the round ultimately landed on: Runtime Tier Fallback (#58) can
      // land a round that attempted Full Tier on "recall" results after
      // Relation Judge itself failed, but the attempt still happened.
      rerank: {
        generated_by: input.queryPlan ? "llm" : "none",
        fallback: null,
        error: null,
        ranked_ids: [],
      },
      final_candidates: candidates.map((candidate, index) => ({
        rank: index + 1,
        title: candidate.noteTitle,
        file: candidate.notePath,
        relation: candidate.relation,
        hit: candidate.hit ? boundedSnippet(candidate.hit, 180) : undefined,
        why: candidate.why ? boundedSnippet(candidate.why, 260) : undefined,
        quotes: candidate.quotes?.map((quote) => boundedSnippet(quote, 180)),
        content_hash: sha256Hex(candidate.hit ?? ""),
      })),
    },
    gold_positions: null,
    diagnosis: null,
  };
}

function safeTraceName(sourcePath: string): string {
  const safe = String(sourcePath ?? "round")
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "round";
  return `${safe}-${sha256Hex(sourcePath ?? "").slice(0, 8)}-${Date.now()}`;
}

/**
 * Writes the trace JSON file under `traceDirectory` (creating it if
 * missing), mirroring writePipelineTraceForReport's naming/safety
 * conventions (safe filename derived from the source path plus a short
 * hash, here also suffixed with a timestamp since a plugin session can
 * write many traces for the same source note across rounds, unlike bench's
 * one-trace-per-case-per-report model). Callers must only invoke this when
 * `traceDirectory` is a non-empty string -- see tier-pipeline.ts's
 * writePluginTraceIfConfigured, which is the single call site and the one
 * place that decision is made.
 */
export function writePluginPipelineTrace(trace: PluginPipelineTrace, traceDirectory: string): string {
  const fs = getNodeRequire()("fs") as typeof import("fs");
  const path = getNodeRequire()("path") as typeof import("path");
  fs.mkdirSync(traceDirectory, { recursive: true });
  const baseName = safeTraceName(trace.case.id);
  const tracePath = path.join(traceDirectory, `${baseName}.json`);
  fs.writeFileSync(tracePath, `${JSON.stringify(trace, null, 2)}\n`);
  return tracePath;
}

