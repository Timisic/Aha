// Neighborhood Tier (issue #58; CONTEXT.md "Neighborhood Tier"): the
// capability tier used when no retrieval backend is available. Recall comes
// only from the link and backlink neighborhood of the source note, read
// straight out of Obsidian's metadata cache -- no qmd, no LLM, no
// subprocess, no vault-boundary/realpath I/O at all.
//
// Deliberately duck-typed against a minimal metadataCache/source-file shape
// (not the real obsidian `App`/`TFile`/`MetadataCache` types) so this stays
// obsidian-import-free and directly unit-testable with plain fakes; the real
// `this.app.metadataCache` and `TFile` structurally satisfy these shapes.

import { DEFAULT_EXCLUDED_CANDIDATE_FOLDERS, formatTierHeader, isExcludedCandidatePath } from "./core";
import type { AhaCandidate, AhaWrapperResult } from "./schema";

export interface NeighborhoodSourceLike {
  path: string;
  basename: string;
}

export interface NeighborhoodMetadataCacheLike {
  /** Obsidian's MetadataCache.resolvedLinks: sourcePath -> targetPath -> link count. */
  resolvedLinks: Record<string, Record<string, number>>;
}

export interface NeighborhoodTierArgs {
  sourceFile: NeighborhoodSourceLike;
  metadataCache: NeighborhoodMetadataCacheLike;
  targetCandidates?: number;
  excludedFolders?: readonly string[];
}

const DEFAULT_TARGET_CANDIDATES = 20;

export interface NeighborEntry {
  notePath: string;
  isBacklink: boolean;
  isOutlink: boolean;
  count: number;
}

/**
 * Collects the source note's outlinks (resolvedLinks[sourcePath]) and
 * backlinks (scanning resolvedLinks for entries whose target is the source
 * path -- Obsidian's metadataCache does not expose a direct backlinks-by-file
 * API reliably across API surfaces, so scanning is the standard technique),
 * merging a note that is both a backlink and an outlink into one entry.
 *
 * Exported so tier-pipeline.ts's Full Tier can reuse it to build core's
 * OrchestratorDeps.listGraphNeighbors from the same metadataCache, giving
 * Full Tier the same Obsidian graph-expansion candidates Neighborhood Tier
 * and bench already get (see core/graph-expansion.ts).
 */
export function collectNeighbors(sourcePath: string, resolvedLinks: Record<string, Record<string, number>>): NeighborEntry[] {
  const byPath = new Map<string, NeighborEntry>();

  const outlinks = resolvedLinks[sourcePath] ?? {};
  for (const [target, count] of Object.entries(outlinks)) {
    if (target === sourcePath || !count) continue;
    const entry = byPath.get(target) ?? { notePath: target, isBacklink: false, isOutlink: false, count: 0 };
    entry.isOutlink = true;
    entry.count += count;
    byPath.set(target, entry);
  }

  for (const [fromPath, targets] of Object.entries(resolvedLinks)) {
    if (fromPath === sourcePath) continue;
    const count = targets[sourcePath];
    if (!count) continue;
    const entry = byPath.get(fromPath) ?? { notePath: fromPath, isBacklink: false, isOutlink: false, count: 0 };
    entry.isBacklink = true;
    entry.count += count;
    byPath.set(fromPath, entry);
  }

  return [...byPath.values()];
}

/**
 * Stable, simple ranking: backlinks before pure outlinks (a note that
 * explicitly points at the source is a stronger neighborhood signal than one
 * the source merely mentions), then by link count descending, then
 * alphabetically by path for determinism.
 */
function rankNeighbors(neighbors: NeighborEntry[]): NeighborEntry[] {
  return neighbors.slice().sort((a, b) => {
    if (a.isBacklink !== b.isBacklink) return a.isBacklink ? -1 : 1;
    if (b.count !== a.count) return b.count - a.count;
    return a.notePath.localeCompare(b.notePath);
  });
}

function neighborKindLabel(entry: NeighborEntry): string {
  if (entry.isBacklink && entry.isOutlink) return "backlink and outlink";
  return entry.isBacklink ? "backlink" : "outlink";
}

function neighborCandidate(entry: NeighborEntry): AhaCandidate {
  const kind = neighborKindLabel(entry);
  return {
    notePath: entry.notePath,
    noteTitle: titleFromPath(entry.notePath),
    relation: "weak",
    hit: `Linked via ${kind} (${entry.count} link${entry.count === 1 ? "" : "s"}) from the source note's neighborhood.`,
    why: "Neighborhood Tier: no retrieval backend is available this round, so this candidate comes from the source note's link/backlink neighborhood rather than retrieval or relation judging.",
    quotes: [],
    selected: true,
  };
}

function titleFromPath(notePath: string): string {
  const lastSegment = notePath.split("/").pop() ?? notePath;
  return lastSegment.replace(/\.md$/i, "");
}

/**
 * Builds the Neighborhood Tier result. Never a failure: an empty
 * neighborhood is an honest ok:true result with zero candidates and a
 * summary saying so (CONTEXT.md: "no tier is an error state").
 */
export function buildNeighborhoodTierResult(args: NeighborhoodTierArgs): AhaWrapperResult {
  const targetCandidates = args.targetCandidates ?? DEFAULT_TARGET_CANDIDATES;
  const excludedFolders = args.excludedFolders ?? DEFAULT_EXCLUDED_CANDIDATE_FOLDERS;

  const neighbors = rankNeighbors(collectNeighbors(args.sourceFile.path, args.metadataCache.resolvedLinks ?? {}))
    .filter((entry) => !isExcludedCandidatePath(entry.notePath, excludedFolders, ""));

  const candidates = neighbors.slice(0, targetCandidates).map(neighborCandidate);
  const header = formatTierHeader("neighborhood", "qmd unavailable");
  const summary = candidates.length > 0
    ? `${header}. Recall comes only from the source note's link and backlink neighborhood (${candidates.length} candidate(s)); no retrieval backend was available this round.`
    : `${header}. No retrieval backend was available this round, and the source note has no linked or backlinked notes to surface as neighborhood recall.`;

  return {
    ok: true,
    sourcePath: args.sourceFile.path,
    generatedAt: new Date().toISOString(),
    summary,
    warnings: [],
    candidates,
  };
}
