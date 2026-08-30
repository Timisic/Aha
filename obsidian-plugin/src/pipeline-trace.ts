// Compact runtime Pipeline Trace shared by Obsidian searches and the batch
// runner (ADR 0003). Both use the same schema as benchmark traces, with an
// explicit origin and no invented gold labels. Graph-expansion details and
// gold-driven diagnosis are not captured here; their null fields do not mean
// that graph expansion did not run. Node builtins remain external in the
// plugin build and also work in the session artifact's native Node ESM.

import type { AhaWrapperResult } from "./schema";
import type { QmdQueryObject } from "./core/query-plan-deterministic";
import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";

/** Duplicated from scripts/lib/pipeline-trace.mjs; kept in sync by a guard test. */
export const TRACE_SCHEMA = "PipelineTrace";
export const TRACE_VERSION = 1;

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function compactWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function boundedSnippet(value: string, maxChars = 300): string {
  const compact = compactWhitespace(value);
  return compact.length <= maxChars ? compact : `${compact.slice(0, maxChars).trimEnd()}...`;
}

export interface PluginTraceQuery {
  id: string;
  kind: string;
  command: string;
  text: string;
  qmd?: QmdQueryObject;
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
  query_id: string | null;
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
  generated_at: string;
  schema: typeof TRACE_SCHEMA;
  version: typeof TRACE_VERSION;
  origin: "plugin" | "batch";
  case: {
    id: string;
    title: string;
    resolved_input_hash: string;
    resolved_input_preview: string;
  };
  steps: {
    query_generation: PluginTraceQueryGeneration;
    qmd_runs: PluginTraceQmdRun[];
    /** Graph expansion can run; this compact trace does not capture its detail. */
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
  origin?: "plugin" | "batch";
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
    queries?: Array<{ kind: string; command: string; text: string; qmd?: QmdQueryObject }>;
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
        queries: (input.queryPlan.queries ?? []).map((q, i) => ({ id: `q${i + 1}`, kind: q.kind, command: q.command, text: q.text, qmd: q.qmd ? { ...q.qmd, lex: [...q.qmd.lex] } : undefined })),
      }
    : {
        generated_by: input.tier === "recall" ? "rules" : null,
        fallback: input.tier === "recall" ? false : null,
        error: null,
        prompt_version: null,
        queries: [],
      };

  const qmdRuns: PluginTraceQmdRun[] = (input.qmdQueryResults ?? []).map((qr) => {
    const queryIndex = (input.queryPlan?.queries ?? []).findIndex(q => q.kind === qr.query.kind && q.command === qr.query.command && q.text === qr.query.text);
    const rows: PluginTraceQmdRow[] = qr.rows.map((row, i) => ({
      file: String(row.file ?? row.path ?? ""),
      title: String(row.title ?? ""),
      score: typeof row.score === "number" && Number.isFinite(row.score) ? row.score : null,
      rank: i + 1,
    }));
    return {
      query_id: queryIndex < 0 ? null : `q${queryIndex + 1}`,
      kind: qr.query.kind,
      command: qr.query.command,
      query_text: String(qr.query.query ?? qr.query.text ?? ""),
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
    generated_at: input.result.generatedAt ?? new Date().toISOString(),
    schema: TRACE_SCHEMA,
    version: TRACE_VERSION,
    origin: input.origin ?? "plugin",
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

export function traceFileBaseName(title: string, generatedAt: string): string {
  const safe = Array.from(String(title).normalize("NFC").replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-").replace(/\s+/g, " ").trim()).slice(0, 50).join("").replace(/[. ]+$/g, "") || "未命名";
  const date = new Date(generatedAt);
  if (!Number.isFinite(date.getTime())) throw new Error("Invalid trace timestamp");
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  return `${safe}__${stamp}`;
}

/**
 * Writes the trace JSON file under `traceDirectory` (creating it if
 * missing), mirroring writePipelineTraceForReport's naming/safety
 * conventions (safe filename derived from the source path plus a short
 * hash, here also suffixed with a timestamp since a plugin session can
 * write many traces for the same source note across rounds, unlike bench's
 * one-trace-per-case-per-report model). Callers must only invoke this when
 * `traceDirectory` is a non-empty string -- see tier-pipeline.ts's
 * writePluginTraceIfConfigured and the batch runner both gate writes on it.
 */
export function writePluginPipelineTrace(trace: PluginPipelineTrace, traceDirectory: string): string {
  fs.mkdirSync(traceDirectory, { recursive: true });
  const baseName = traceFileBaseName(trace.case.title || path.basename(trace.case.id, ".md"), trace.generated_at);
  for (let attempt = 1; attempt <= 1000; attempt++) {
    const tracePath = path.join(traceDirectory, `${baseName}${attempt === 1 ? "" : `-${attempt}`}.json`);
    try {
      fs.writeFileSync(tracePath, `${JSON.stringify(trace, null, 2)}\n`, { mode: 0o600, flag: "wx" });
      return tracePath;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  throw new Error("Too many trace filename collisions");
}
