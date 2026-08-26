// Obsidian link/backlink graph expansion (ADR 0005 follow-up). Ports
// obsidianGraphExpansion from the frozen legacy wrapper
// scripts/aha/run-insight-search.mjs: the one structural difference between
// the legacy pipeline and this core orchestration (see
// docs/architecture-audit-serendipity.md section 1). Surfaces the source
// note's 1-hop outlinks and backlinks as synthetic QMD rows so they flow
// through the same pool merge/rerank (pool.ts) as real retrieval results.
//
// This module must stay free of `obsidian` imports, node imports, and
// module-level I/O: the neighbor lookup itself is an injected dep
// (GraphExpansionDeps.listGraphNeighbors); only row-shaping is done here.

import { normalizeNoteIdentity, sameNotePath } from "./note-identity";

export interface GraphNeighbor {
  notePath: string;
  kind: "outlink" | "backlink";
}

export interface GraphExpansionOutcome {
  neighbors: GraphNeighbor[];
  warnings: string[];
}

export interface GraphExpansionDeps {
  /**
   * Optional: resolves the source note's outlink/backlink neighbors for
   * graph expansion. Deps that omit this (e.g. today's plugin wiring, and
   * any test double that doesn't set it) get exactly today's behavior --
   * runFullPipeline skips graph expansion entirely, with no warning, the
   * same as before this module existed.
   */
  listGraphNeighbors?(sourcePath: string): Promise<GraphExpansionOutcome>;
}

export interface GraphExpansionRow {
  score: number;
  file: string;
  title: string;
  snippet: string;
  [key: string]: unknown;
}

const OUTLINK_SCORE = 0.14;
const BACKLINK_SCORE = 0.18;

function titleFromPath(notePath: string): string {
  const lastSegment = notePath.split("/").pop() ?? notePath;
  return lastSegment.replace(/\.md$/i, "");
}

/**
 * Converts raw graph neighbors into QMD-row-shaped candidates: verbatim port
 * of the row-building half of obsidianGraphExpansion (same scores, same
 * qmd:// URI shape, same .md-only filter, same self-exclusion and dedup-by-
 * normalized-identity), so pool.ts's merge/rerank treats these identically
 * to a real QMD query result.
 */
export function graphExpansionRows(sourcePath: string, neighbors: readonly GraphNeighbor[]): GraphExpansionRow[] {
  const seen = new Set<string>();
  const rows: GraphExpansionRow[] = [];
  for (const neighbor of neighbors) {
    const notePath = neighbor.notePath;
    if (!notePath.endsWith(".md")) continue;
    if (sameNotePath(notePath, sourcePath)) continue;
    const key = normalizeNoteIdentity(notePath);
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({
      score: neighbor.kind === "backlink" ? BACKLINK_SCORE : OUTLINK_SCORE,
      file: `qmd://obsidian/${notePath}?index=obsidian`,
      title: titleFromPath(notePath),
      snippet: `Obsidian ${neighbor.kind}: ${notePath}`,
    });
  }
  return rows;
}
