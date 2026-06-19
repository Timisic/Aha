import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { ExplicitCueStatus, InsightSearchMemoryParams, InsightSession, MemoryCandidate, MemoryQueryKind } from "./domain.ts";
import { normalizeMemoryQueryKind, shouldExpandBacklinks } from "./domain.ts";
import {
  expandBacklinkCandidates,
  formatMemoryCandidateTable,
  mergeCandidateEvidence,
  normalizeMemoryQueryCommand,
  parseMemorySearchCandidates,
  qmdConnectivityIssue,
  runQmdCall,
  structuredQmdQuery,
  structuredQmdQueryFromObject,
  toMemoryCandidate,
} from "./memory.ts";
import { rerankMemoryCandidates } from "./memory-rerank.ts";
import { persistActiveSessionBinding, saveActiveState, type InsightRuntime } from "./runtime.ts";
import { assertCanSearchMemory } from "./stage-policy.ts";
import { recordTrajectoryEvent, recordTrajectoryMemoryQueryStarted, recordTrajectoryQmdCallFinished } from "./trajectory.ts";

const MEMORY_CANDIDATE_POOL_LIMIT = 100;

function normalizedIdentity(value: string | undefined): string {
  return String(value ?? "")
    .trim()
    .replace(/^qmd:\/\/[^/]+\//, "")
    .replace(/[?#].*$/, "")
    .replace(/\\/g, "/")
    .replace(/\.md$/i, "")
    .replace(/^\/+|\/+$/g, "")
    .toLowerCase();
}

function candidateIdentityText(candidate: MemoryCandidate): string {
  return [
    candidate.id,
    candidate.title,
    candidate.slug,
    candidate.reason,
  ].filter(Boolean).join("\n").toLowerCase();
}

function isSourceNoteSelfHit(session: InsightSession, candidate: MemoryCandidate): boolean {
  const sourcePath = normalizedIdentity(session.sourceNote?.path);
  if (!sourcePath) return false;
  const sourceTitle = normalizedIdentity(sourcePath.split("/").at(-1));
  const candidateSlug = normalizedIdentity(candidate.slug);
  const candidateId = normalizedIdentity(candidate.id);
  const candidateTitle = normalizedIdentity(candidate.title);
  return Boolean(
    (candidateSlug && candidateSlug === sourcePath) ||
    (candidateId && candidateId === sourcePath) ||
    (candidateTitle && candidateTitle === sourceTitle),
  );
}

function explicitCueResults(
  cues: string[],
  displayed: MemoryCandidate[],
  rankedPool: MemoryCandidate[],
): InsightSession["explicitCueResults"] {
  return cues.map((cue) => {
    const normalizedCue = cue.toLowerCase();
    const poolMatches = rankedPool.filter((candidate) =>
      candidateIdentityText(candidate).includes(normalizedCue),
    );
    if (poolMatches.length === 0) {
      return { cue, status: "not_found" as ExplicitCueStatus };
    }
    if (poolMatches.length > 1) {
      return {
        cue,
        status: "ambiguous" as ExplicitCueStatus,
        matchedCandidateIds: poolMatches.map((candidate) => candidate.id),
      };
    }
    const [candidate] = poolMatches;
    const topIndex = displayed.findIndex((item) => item.id === candidate.id);
    if (topIndex >= 0) {
      return {
        cue,
        status: "found_top_k" as ExplicitCueStatus,
        candidateId: candidate.id,
        rank: topIndex + 1,
      };
    }
    const poolIndex = rankedPool.findIndex((item) => item.id === candidate.id);
    return {
      cue,
      status: "found_pool" as ExplicitCueStatus,
      candidateId: candidate.id,
      rank: poolIndex >= 0 ? poolIndex + 1 : undefined,
    };
  });
}

function selectBacklinkSeeds(candidates: MemoryCandidate[], limit: number): MemoryCandidate[] {
  const grouped = new Map<MemoryQueryKind | "unknown", MemoryCandidate[]>();
  for (const candidate of candidates) {
    const kinds = candidate.searchSignals?.queryKinds ??
      (candidate.searchSignals?.queryKind ? [candidate.searchSignals.queryKind] : []);
    const key = kinds[0] ?? "unknown";
    grouped.set(key, [...(grouped.get(key) ?? []), candidate]);
  }

  const seeds: MemoryCandidate[] = [];
  const seen = new Set<string>();
  const groups = Array.from(grouped.values());
  for (let offset = 0; seeds.length < limit; offset += 1) {
    let added = false;
    for (const group of groups) {
      const candidate = group[offset];
      if (!candidate || seen.has(candidate.id)) continue;
      seen.add(candidate.id);
      seeds.push(candidate);
      added = true;
      if (seeds.length >= limit) break;
    }
    if (!added) break;
  }
  return seeds;
}

export async function runInsightMemoryRetrieval(
  pi: ExtensionAPI,
  runtime: InsightRuntime,
  params: InsightSearchMemoryParams,
  signal: AbortSignal | undefined,
  ctx: ExtensionCommandContext,
) {
  if (!runtime.activeSession) {
    return {
      content: [{ type: "text" as const, text: "No active /insight session." }],
      details: { ok: false },
    };
  }

  const limit = Math.max(1, Math.min(params.limit ?? 10, 20));
  const retrievalLimit = Math.max(limit, 20);
  const found: InsightSession["memoryCandidates"] = [];
  const errors: string[] = [];
  const active = runtime.activeSession;
  assertCanSearchMemory(active);
  const previousStage = active.session.stage;

  for (const query of params.queries) {
    const kind = normalizeMemoryQueryKind(query.kind);
    const command = normalizeMemoryQueryCommand(query.command, kind);
    const text = String(query.text ?? query.qmd?.vec ?? query.qmd?.intent ?? "").trim();
    if (!text) {
      errors.push(`${kind}: missing query text or qmd.vec`);
      continue;
    }

    active.session.memoryQueries.push({
      text,
      kind,
      command,
      qmd: query.qmd,
    });

    const qmdQuery = command === "qmd search"
      ? text
      : query.qmd
        ? structuredQmdQueryFromObject(query.qmd, text, kind)
        : structuredQmdQuery(text, kind);
    recordTrajectoryMemoryQueryStarted(active, {
      kind,
      command,
      text,
      qmd: query.qmd,
      qmdQuery,
      retrievalLimit,
    });
    const qmdStartedAt = Date.now();
    const result = await runQmdCall(command, text, retrievalLimit, ctx, signal, undefined, kind, query.qmd);

    const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    const connectivityIssue = qmdConnectivityIssue(output);
    const parsedCandidates = parseMemorySearchCandidates(
      result.stdout || output,
      text,
      result.code === 0 && !result.killed && !connectivityIssue,
    ).map((candidate) =>
      toMemoryCandidate(
        {
          ...candidate,
          source:
            command === "qmd search" ? "qmd_search" :
            command === "qmd vsearch" ? "qmd_vsearch" :
            "qmd_query",
          queryKind: kind,
        },
        active.session,
      ),
    );
    recordTrajectoryQmdCallFinished(active, {
      kind,
      command,
      text,
      startedAt: qmdStartedAt,
      result,
      connectivityIssue,
      parsedCandidates,
    });

    if (connectivityIssue && parsedCandidates.length === 0) {
      errors.push(`${text}: ${connectivityIssue}`);
      continue;
    }

    if (parsedCandidates.length === 0 && (result.code !== 0 || result.killed)) {
      errors.push(`${text}: ${result.killed ? "timed out" : output || `exit ${result.code}`}`);
      continue;
    }

    if (result.killed) {
      errors.push(`${text}: QMD returned results but did not exit before timeout`);
    } else if (result.code !== 0) {
      errors.push(`${text}: QMD returned parseable JSON but exited with ${result.code}`);
    }

    found.push(...parsedCandidates);
  }

  const qmdSeeds = selectBacklinkSeeds(mergeCandidateEvidence(found), 10);
  recordTrajectoryEvent(active, "backlink_expansion_started", {
    enabled: shouldExpandBacklinks(),
    seedCount: qmdSeeds.length,
    seedIds: qmdSeeds.map((candidate) => candidate.id),
    seedKinds: qmdSeeds.map((candidate) => candidate.searchSignals?.queryKinds ?? candidate.searchSignals?.queryKind ?? "unknown"),
  });
  const backlinkStartedAt = Date.now();
  const backlinkResult = shouldExpandBacklinks()
    ? await expandBacklinkCandidates(
        qmdSeeds,
        active.session,
        ctx,
        signal,
      )
    : { candidates: [], resolutionWarnings: [] };
  const backlinkCandidates = backlinkResult.candidates;
  recordTrajectoryEvent(active, "backlink_expansion_finished", {
    enabled: shouldExpandBacklinks(),
    durationMs: Date.now() - backlinkStartedAt,
    seedCount: qmdSeeds.length,
    outputCount: backlinkCandidates.length,
    candidateIds: backlinkCandidates.map((candidate) => candidate.id),
    resolutionWarnings: backlinkResult.resolutionWarnings,
  });

  const mergedPool = mergeCandidateEvidence([
    active.session.memoryCandidatePool.length > 0 ? active.session.memoryCandidatePool : active.session.memoryCandidates,
    found,
    backlinkCandidates,
  ].flat());
  const sourceNoteSelfHits = mergedPool.filter((candidate) => isSourceNoteSelfHit(active.session, candidate));
  const candidatePool = mergedPool
    .filter((candidate) => !isSourceNoteSelfHit(active.session, candidate))
    .slice(0, MEMORY_CANDIDATE_POOL_LIMIT);
  if (sourceNoteSelfHits.length > 0) {
    recordTrajectoryEvent(active, "source_note_self_hits_filtered", {
      count: sourceNoteSelfHits.length,
      sourceNotePath: active.session.sourceNote?.path,
      candidates: sourceNoteSelfHits.map((candidate) => ({
        id: candidate.id,
        title: candidate.title,
        slug: candidate.slug,
        poolRank: mergedPool.findIndex((item) => item.id === candidate.id) + 1,
      })),
    });
  }
  recordTrajectoryEvent(active, "memory_candidates_merged", {
    previousCandidateCount: active.session.memoryCandidatePool.length || active.session.memoryCandidates.length,
    qmdCandidateCount: found.length,
    backlinkCandidateCount: backlinkCandidates.length,
    mergedCandidateCount: mergedPool.length,
    sourceNoteSelfHitCount: sourceNoteSelfHits.length,
    boundedPoolCount: candidatePool.length,
  });
  const rerankStartedAt = Date.now();
  const rerank = rerankMemoryCandidates(active.session, candidatePool, limit);
  recordTrajectoryEvent(active, "rerank_finished", {
    durationMs: Date.now() - rerankStartedAt,
    inputCount: candidatePool.length,
    outputCount: rerank.candidates.length,
    selectedCount: Math.min(rerank.candidates.length, limit),
    generatedBy: rerank.generatedBy,
    fallback: rerank.fallback,
    error: rerank.error,
  });
  if (rerank.error) errors.push(rerank.error);

  const rankedPool = rerank.candidates.slice(0, MEMORY_CANDIDATE_POOL_LIMIT);
  active.session.memoryCandidatePool = rankedPool;
  active.session.memoryCandidates = rankedPool.slice(0, limit);

  if (active.session.explicitMemoryCues.length > 0) {
    active.session.explicitCueResults = explicitCueResults(
      active.session.explicitMemoryCues,
      active.session.memoryCandidates,
      rankedPool,
    );
    active.session.missingExplicitCues = active.session.explicitCueResults
      .filter((result) => result.status === "not_found")
      .map((result) => result.cue);
  }

  if (active.session.memoryCandidates.length === 0) {
    const unresolved = errors.length > 0
      ? `Memory search did not return candidates: ${errors.join("; ")}`
      : "Memory search completed but did not return candidates.";
    if (!active.session.unresolvedQuestions.includes(unresolved)) {
      active.session.unresolvedQuestions.push(unresolved);
    }
  } else {
    active.session.stage = "memory_review";
  }
  saveActiveState(ctx, active);
  persistActiveSessionBinding(pi, active);
  recordTrajectoryEvent(active, "state_saved", {
    previousStage,
    stage: active.session.stage,
    statePath: active.statePath,
    candidateCount: active.session.memoryCandidates.length,
    candidatePoolCount: active.session.memoryCandidatePool.length,
    explicitCueResults: active.session.explicitCueResults,
    errorCount: errors.length,
    errors,
  });

  return {
    content: [
      {
        type: "text" as const,
        text: [
          `Memory search complete. Candidates: ${active.session.memoryCandidates.length}.`,
          `Stage: ${active.session.stage}.`,
          "",
          "Candidate table to present to the user:",
          formatMemoryCandidateTable(active.session.memoryCandidates),
          "",
          "Present this table to the user, then ask whether to search more memory or enter grill.",
          "Do not enter review_grill until the user explicitly chooses grill.",
          active.session.missingExplicitCues.length > 0
            ? `\nMissing explicit cues: ${active.session.missingExplicitCues.join(", ")}`
            : "",
          errors.length > 0 ? `\nSearch issues:\n${errors.map((error) => `- ${error}`).join("\n")}` : "",
        ]
          .filter(Boolean)
          .join("\n\n"),
      },
    ],
    details: {
      ok: errors.length === 0,
      statePath: active.statePath,
          stage: active.session.stage,
          candidateCount: active.session.memoryCandidates.length,
          errors,
          rerank: {
            generatedBy: rerank.generatedBy,
            fallback: rerank.fallback,
            error: rerank.error,
          },
          memoryCandidates: active.session.memoryCandidates,
          memoryCandidatePool: active.session.memoryCandidatePool,
          explicitCueResults: active.session.explicitCueResults,
        },
      };
}
