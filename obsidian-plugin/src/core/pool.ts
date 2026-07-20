// Candidate pool merge and ranking shared between the plugin and bench (ADR
// 0005, issue #56). Ports rerankPipelineCandidates and pipelineCandidate from
// the frozen legacy wrapper scripts/aha/run-insight-search.mjs verbatim,
// including the filter ORDER and the scoring float-math order — both are
// deliberate quirks preserved for equivalence.
//
// This module must stay free of `obsidian` imports, node imports, and
// module-level I/O: vault-containment checks flow through the injected deps
// from ./candidates.

import { notePathForObsidian } from "./note-identity";
import {
  type CandidateFilterArgs,
  type CandidateRowLike,
  type VaultBoundaryDeps,
  isCandidatePathAllowed,
  isExcludedCandidatePath,
  isGeneratedReviewCandidate,
  isSourceCandidate,
} from "./candidates";

export interface QueryResultLike {
  query: { kind: string; command: string };
  rows: CandidateRowLike[];
}

export interface PooledCandidateSource {
  kind: string;
  command: string;
  rank: number;
  score: number | null;
}

export interface PooledCandidate {
  notePath: string;
  noteTitle: string;
  hit: string;
  bestScore: number;
  rankScore: number;
  queryKinds: Set<string>;
  commands: Set<string>;
  rawLocations: Set<string>;
  sources: PooledCandidateSource[];
  finalScore: number;
}

export interface PipelineCandidateShape {
  notePath: string;
  noteTitle: string;
  relation: "weak";
  hit: string;
  why: string;
  quotes: never[];
  selected: true;
  _rawLocations: string[];
}

export interface PoolPolicy {
  excludedFolders: readonly string[];
  vaultRootPrefix: unknown;
}

/**
 * Verbatim port of rerankPipelineCandidates: merges rows across query results
 * by note path, accumulating best score, reciprocal-rank score, and query
 * diversity, then sorts descending by finalScore. The per-row filter order
 * (path-allowed -> source self-hit -> generated-review -> excluded folder) is
 * preserved exactly as in the legacy wrapper.
 */
export async function mergeAndRankQueryResults(
  args: CandidateFilterArgs,
  queryResults: QueryResultLike[],
  policy: PoolPolicy,
  deps: VaultBoundaryDeps,
): Promise<PooledCandidate[]> {
  const byPath = new Map<string, PooledCandidate>();
  for (const queryResult of queryResults) {
    for (const [index, row] of queryResult.rows.entries()) {
      const notePath = notePathForObsidian(args, row, deps.path);
      if (!(await isCandidatePathAllowed(args, notePath, row, deps))) continue;
      if (isSourceCandidate(args, notePath, row, deps.path)) continue;
      if (isGeneratedReviewCandidate(args, notePath, row, deps.path)) continue;
      if (isExcludedCandidatePath(notePath, policy.excludedFolders, policy.vaultRootPrefix)) continue;

      const existing: PooledCandidate = byPath.get(notePath) ?? {
        notePath,
        noteTitle: typeof row.title === "string" && row.title.trim()
          ? row.title.trim()
          : deps.path.basename(notePath, ".md"),
        hit: firstSnippetLine(row.snippet) || `QMD score ${row.score ?? "unknown"}`,
        bestScore: 0,
        rankScore: 0,
        queryKinds: new Set<string>(),
        commands: new Set<string>(),
        rawLocations: new Set<string>(),
        sources: [],
        finalScore: 0,
      };
      const score = Number(row.score ?? 0);
      existing.bestScore = Math.max(existing.bestScore, Number.isFinite(score) ? score : 0);
      existing.rankScore += 1 / (index + 1);
      existing.queryKinds.add(queryResult.query.kind);
      existing.commands.add(queryResult.query.command);
      for (const location of [row.file, row.path, row.uri]) {
        if (typeof location === "string" && location.trim()) existing.rawLocations.add(location.trim());
      }
      existing.sources.push({
        kind: queryResult.query.kind,
        command: queryResult.query.command,
        rank: index + 1,
        score: Number.isFinite(score) ? score : null,
      });
      byPath.set(notePath, existing);
    }
  }

  return [...byPath.values()]
    .map((candidate) => {
      const diversity = candidate.queryKinds.size * 0.12 + candidate.commands.size * 0.04;
      return {
        ...candidate,
        finalScore: candidate.bestScore + candidate.rankScore * 0.18 + diversity,
      };
    })
    .sort((a, b) => b.finalScore - a.finalScore);
}

/** Verbatim port of pipelineCandidate: shapes a pooled candidate for output. */
export function pipelineCandidate(candidate: PooledCandidate): PipelineCandidateShape {
  const kinds = [...candidate.queryKinds].filter(Boolean);
  const commands = [...candidate.commands].filter(Boolean);
  const strongest = candidate.sources
    .slice()
    .sort((a, b) => (a.rank ?? 999) - (b.rank ?? 999))
    .slice(0, 3)
    .map((source) => `${source.kind}/${source.command}#${source.rank}`)
    .join(", ");
  return {
    notePath: candidate.notePath,
    noteTitle: candidate.noteTitle,
    relation: "weak",
    hit: candidate.hit,
    why: `Mixed QMD retrieval ranked this candidate from ${kinds.length} query kind(s) (${kinds.join(", ")}) via ${commands.join(", ")}. Strongest retrieval signals: ${strongest}. Relation is weak pending quote-backed judging.`,
    quotes: [],
    selected: true,
    _rawLocations: [...candidate.rawLocations],
  };
}

/** Verbatim port of firstSnippetLine: first non-frontmatter content line. */
export function firstSnippetLine(snippet: unknown): string {
  if (typeof snippet !== "string") return "";
  return (
    snippet
      .split(/\r?\n/)
      .map((line) => line.replace(/^\d+:\s*/, "").trim())
      .find(
        (line) =>
          line &&
          !line.startsWith("@@") &&
          line !== "---" &&
          !/^(create|cssclasses|tags|categories|emotion):\s*/.test(line),
      ) ?? ""
  );
}
