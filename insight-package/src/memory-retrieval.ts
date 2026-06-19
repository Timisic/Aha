import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { ExplicitCueStatus, InsightSearchMemoryParams, InsightSession, MemoryCandidate, MemoryQueryCommand, MemoryQueryKind, ProviderOutcome, QmdStructuredQuery } from "./domain.ts";
import { BACKLINK_CONCURRENCY, QMD_QUERY_CONCURRENCY, RETRIEVAL_DEADLINE_MS, configuredSourceRoots, isPathInside, normalizeMemoryQueryKind, shouldExpandBacklinks } from "./domain.ts";
import {
  expandBacklinkCandidates,
  formatMemoryCandidateTable,
  mergeCandidateEvidence,
  mergeCandidates,
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
import { formatReviewedEvidence, recordCandidateTableSnapshot } from "./candidate-selection.ts";
import { recordTrajectoryEvent, recordTrajectoryMemoryQueryStarted, recordTrajectoryQmdCallFinished } from "./trajectory.ts";
import { relative } from "node:path";
import { buildVaultPathResolver, normalizeIdentityHint, resolveNoteIdentity } from "./path-resolver.js";

const MEMORY_CANDIDATE_POOL_LIMIT = 100;

function sourceCanonicalId(session: InsightSession): string | undefined {
  const sourcePath = session.sourceNote?.path;
  if (!sourcePath) return undefined;
  for (const root of configuredSourceRoots(session.originCwd)) {
    const resolved = resolveNoteIdentity(sourcePath, buildVaultPathResolver(root));
    if (resolved.status === "resolved") return normalizeIdentityHint(resolved.canonicalId);
    if (isPathInside(root, sourcePath)) {
      return normalizeIdentityHint(relative(root, sourcePath));
    }
  }
  return normalizeIdentityHint(sourcePath) || undefined;
}

function candidatePathKeys(candidate: MemoryCandidate): string[] {
  return [candidate.canonicalId, candidate.canonicalPath, candidate.id, candidate.slug]
    .map((value) => normalizeIdentityHint(value))
    .filter(Boolean);
}

function candidateTitleKeys(candidate: MemoryCandidate): string[] {
  return [candidate.title, ...(candidate.aliases ?? [])]
    .map((value) => normalizeIdentityHint(value))
    .filter(Boolean);
}

function isSourceNoteSelfHit(session: InsightSession, candidate: MemoryCandidate): boolean {
  const sourceId = sourceCanonicalId(session);
  if (!sourceId) return false;
  return candidatePathKeys(candidate).includes(sourceId);
}

function explicitCueMatchResult(
  cue: string,
  matches: MemoryCandidate[],
  displayed: MemoryCandidate[],
  rankedPool: MemoryCandidate[],
): InsightSession["explicitCueResults"][number] {
  if (matches.length === 0) return { cue, status: "not_found" as ExplicitCueStatus };
  if (matches.length > 1) {
    return {
      cue,
      status: "ambiguous" as ExplicitCueStatus,
      matchedCandidateIds: matches.map((candidate) => candidate.id),
    };
  }
  const [candidate] = matches;
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
}

function explicitCueResults(
  cues: string[],
  displayed: MemoryCandidate[],
  rankedPool: MemoryCandidate[],
): InsightSession["explicitCueResults"] {
  return cues.map((cue) => {
    const normalizedCue = normalizeIdentityHint(cue);
    const canonicalMatches = rankedPool.filter((candidate) =>
      candidatePathKeys(candidate).includes(normalizedCue),
    );
    if (canonicalMatches.length > 0) {
      return explicitCueMatchResult(cue, canonicalMatches, displayed, rankedPool);
    }
    const titleMatches = rankedPool.filter((candidate) =>
      candidateTitleKeys(candidate).includes(normalizedCue),
    );
    return explicitCueMatchResult(cue, titleMatches, displayed, rankedPool);
  });
}


function boundedConcurrency(): { qmd: number; backlinks: number } {
  return {
    qmd: Math.max(1, Number(process.env.INSIGHT_QMD_QUERY_CONCURRENCY) || QMD_QUERY_CONCURRENCY),
    backlinks: Math.max(1, Number(process.env.INSIGHT_BACKLINK_CONCURRENCY) || BACKLINK_CONCURRENCY),
  };
}

function configuredRetrievalDeadlineMs(): number {
  return Math.max(1, Number(process.env.INSIGHT_RETRIEVAL_DEADLINE_MS) || RETRIEVAL_DEADLINE_MS);
}

function remainingBudgetMs(deadlineAt: number): number {
  return Math.max(1, deadlineAt - Date.now());
}

function createRetrievalAbort(hostSignal: AbortSignal | undefined, timeoutMs: number): {
  signal: AbortSignal;
  deadlineAt: number;
  cleanup: () => void;
  cancelledByHost: () => boolean;
} {
  const controller = new AbortController();
  const deadlineAt = Date.now() + timeoutMs;
  let hostCancelled = hostSignal?.aborted === true;
  const abort = () => controller.abort();
  const onHostAbort = () => {
    hostCancelled = true;
    abort();
  };
  const timer = setTimeout(abort, timeoutMs);
  hostSignal?.addEventListener("abort", onHostAbort, { once: true });
  if (hostSignal?.aborted) onHostAbort();
  return {
    signal: controller.signal,
    deadlineAt,
    cleanup: () => {
      clearTimeout(timer);
      hostSignal?.removeEventListener("abort", onHostAbort);
    },
    cancelledByHost: () => hostCancelled,
  };
}

async function mapBounded<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

type PreparedQuery = {
  kind: MemoryQueryKind;
  command: MemoryQueryCommand;
  text: string;
  qmdQuery: string;
  qmd?: QmdStructuredQuery;
};

function qmdOutcomeStatus(
  parsedCandidates: MemoryCandidate[],
  result: { code: number | null; killed: boolean; timedOut?: boolean; cancelled?: boolean },
  connectivityIssue: string | undefined,
): ProviderOutcome<MemoryCandidate[]>["status"] {
  if (result.cancelled) return parsedCandidates.length > 0 ? "partial" : "cancelled";
  if (result.timedOut || result.killed) return parsedCandidates.length > 0 ? "partial" : "timeout";
  if (connectivityIssue) return parsedCandidates.length > 0 ? "partial" : "unavailable";
  if (result.code !== 0) return parsedCandidates.length > 0 ? "partial" : "failed";
  return parsedCandidates.length > 0 ? "ok" : "empty";
}

function qmdDiagnostics(
  prepared: PreparedQuery,
  result: { code: number | null; killed: boolean; stdout: string; stderr: string; timedOut?: boolean; cancelled?: boolean },
  connectivityIssue: string | undefined,
  parsedCandidates: MemoryCandidate[],
): string[] {
  const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
  if (connectivityIssue && parsedCandidates.length === 0) return [`${prepared.text}: ${connectivityIssue}`];
  if (parsedCandidates.length === 0 && (result.code !== 0 || result.killed)) {
    return [`${prepared.text}: ${result.cancelled ? "cancelled" : result.timedOut || result.killed ? "timed out" : output || `exit ${result.code}`}`];
  }
  if (result.cancelled) return [`${prepared.text}: QMD returned partial results before cancellation`];
  if (result.timedOut || result.killed) return [`${prepared.text}: QMD returned results but did not exit before timeout`];
  if (result.code !== 0) return [`${prepared.text}: QMD returned parseable JSON but exited with ${result.code}`];
  return [];
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
  const concurrency = boundedConcurrency();
  const retrievalDeadlineMs = configuredRetrievalDeadlineMs();
  const retrievalAbort = createRetrievalAbort(signal, retrievalDeadlineMs);
  const providerOutcomes: Array<ProviderOutcome<MemoryCandidate[]>> = [];

  try {
    const preparedQueries: PreparedQuery[] = [];
    for (const query of params.queries) {
      const kind = normalizeMemoryQueryKind(query.kind);
      const command = normalizeMemoryQueryCommand(query.command, kind);
      const text = String(query.text ?? query.qmd?.vec ?? query.qmd?.intent ?? "").trim();
      if (!text) {
        errors.push(`${kind}: missing query text or qmd.vec`);
        continue;
      }

      active.session.memoryQueries.push({ text, kind, command, qmd: query.qmd });
      const qmdQuery = command === "qmd search"
        ? text
        : query.qmd
          ? structuredQmdQueryFromObject(query.qmd, text, kind)
          : structuredQmdQuery(text, kind);
      preparedQueries.push({ kind, command, text, qmdQuery, qmd: query.qmd });
      recordTrajectoryMemoryQueryStarted(active, { kind, command, text, qmd: query.qmd, qmdQuery, retrievalLimit });
    }

    const qmdOutcomes = await mapBounded(preparedQueries, concurrency.qmd, async (prepared) => {
      const qmdStartedAt = Date.now();
      const result = await runQmdCall(
        prepared.command,
        prepared.text,
        retrievalLimit,
        ctx,
        retrievalAbort.signal,
        remainingBudgetMs(retrievalAbort.deadlineAt),
        prepared.kind,
        prepared.qmd,
      );
      const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
      const connectivityIssue = qmdConnectivityIssue(output);
      const parsedCandidates = parseMemorySearchCandidates(
        result.stdout || output,
        prepared.text,
        result.code === 0 && !result.killed && !connectivityIssue,
      ).map((candidate) =>
        toMemoryCandidate(
          {
            ...candidate,
            source: prepared.command === "qmd search" ? "qmd_search" : prepared.command === "qmd vsearch" ? "qmd_vsearch" : "qmd_query",
            queryKind: prepared.kind,
          },
          active.session,
        ),
      );
      recordTrajectoryQmdCallFinished(active, {
        kind: prepared.kind,
        command: prepared.command,
        text: prepared.text,
        startedAt: qmdStartedAt,
        result,
        connectivityIssue,
        parsedCandidates,
      });
      return {
        status: qmdOutcomeStatus(parsedCandidates, result, connectivityIssue),
        value: parsedCandidates,
        diagnostics: qmdDiagnostics(prepared, result, connectivityIssue, parsedCandidates),
        command: prepared.command,
        durationMs: Date.now() - qmdStartedAt,
        timedOut: result.timedOut,
        cancelled: result.cancelled,
      } satisfies ProviderOutcome<MemoryCandidate[]>;
    });

    for (const outcome of qmdOutcomes) {
      providerOutcomes.push(outcome);
      found.push(...outcome.value);
      errors.push(...outcome.diagnostics);
    }

    if (retrievalAbort.signal.aborted && found.length === 0) {
      errors.push(retrievalAbort.cancelledByHost() ? "Retrieval cancelled by host before usable QMD candidates." : "Retrieval deadline expired before usable QMD candidates.");
    }

    const qmdSeeds = selectBacklinkSeeds(mergeCandidateEvidence(found), 10);
    recordTrajectoryEvent(active, "backlink_expansion_started", {
      enabled: shouldExpandBacklinks(),
      seedCount: qmdSeeds.length,
      seedIds: qmdSeeds.map((candidate) => candidate.id),
      seedKinds: qmdSeeds.map((candidate) => candidate.searchSignals?.queryKinds ?? candidate.searchSignals?.queryKind ?? "unknown"),
      concurrency: concurrency.backlinks,
      remainingBudgetMs: remainingBudgetMs(retrievalAbort.deadlineAt),
    });
    const backlinkStartedAt = Date.now();
    const backlinkResult = shouldExpandBacklinks() && remainingBudgetMs(retrievalAbort.deadlineAt) > 1
      ? await expandBacklinkCandidates(qmdSeeds, active.session, ctx, retrievalAbort.signal, {
          concurrency: concurrency.backlinks,
          timeoutMs: remainingBudgetMs(retrievalAbort.deadlineAt),
        })
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
    const candidatePool = mergedPool.filter((candidate) => !isSourceNoteSelfHit(active.session, candidate)).slice(0, MEMORY_CANDIDATE_POOL_LIMIT);
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
    const rerank = await rerankMemoryCandidates(active.session, candidatePool, limit, {
      signal: retrievalAbort.signal,
      timeoutMs: remainingBudgetMs(retrievalAbort.deadlineAt),
    });
    recordTrajectoryEvent(active, "rerank_finished", {
      durationMs: Date.now() - rerankStartedAt,
      inputCount: candidatePool.length,
      outputCount: rerank.candidates.length,
      selectedCount: Math.min(rerank.candidates.length, limit),
      generatedBy: rerank.generatedBy,
      mode: rerank.mode,
      provider: rerank.provider,
      model: rerank.model,
      processedFields: rerank.processedFields,
      fallback: rerank.fallback,
      error: rerank.error,
    });
    if (rerank.error) errors.push(rerank.error);

    const durableReviewedCandidates: MemoryCandidate[] = active.session.reviewedMemoryEvidence
      .filter((review) => review.status !== "rejected")
      .map((review) => ({
        id: review.candidateId,
        title: review.title,
        slug: review.slug,
        relation: review.relation,
        reason: review.reason,
        whyReadFirst: review.whyReadFirst,
      }));
    const rankedPool = mergeCandidates(durableReviewedCandidates, rerank.candidates).slice(0, MEMORY_CANDIDATE_POOL_LIMIT);
    active.session.memoryCandidatePool = rankedPool;
    active.session.memoryCandidates = rankedPool.slice(0, limit);
    recordCandidateTableSnapshot(active.session);

    if (active.session.explicitMemoryCues.length > 0) {
      active.session.explicitCueResults = explicitCueResults(active.session.explicitMemoryCues, active.session.memoryCandidates, rankedPool);
      active.session.missingExplicitCues = active.session.explicitCueResults.filter((result) => result.status === "not_found").map((result) => result.cue);
    }

    active.session.memorySearchOutcome = active.session.memoryCandidates.length > 0
      ? "candidates_found"
      : errors.length > 0 ? "failed" : "no_candidates";
    if (active.session.memoryCandidates.length === 0) {
      const unresolved = errors.length > 0 ? `Memory search did not return candidates: ${errors.join("; ")}` : "Memory search completed with no relevant prior memory.";
      if (!active.session.unresolvedQuestions.includes(unresolved)) active.session.unresolvedQuestions.push(unresolved);
      active.session.memorySearchOutcome = errors.length > 0 ? "failed" : "no_candidates";
      if (errors.length === 0) active.session.stage = "memory_review";
    } else {
      active.session.memorySearchOutcome = "candidates_found";
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
      providerOutcomes: providerOutcomes.map((outcome) => ({
        status: outcome.status,
        command: outcome.command,
        durationMs: outcome.durationMs,
        diagnostics: outcome.diagnostics,
        candidateCount: outcome.value.length,
      })),
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
          `Candidate table: ${active.session.candidateTable?.version ?? "unknown"}. Inspect with /insight candidate inspect 1 --table ${active.session.candidateTable?.version ?? "unknown"}.`,
          formatReviewedEvidence(active),
          "",
          active.session.memorySearchOutcome === "no_candidates"
            ? "no relevant prior memory was found. Ask the user to choose: search again, or explicitly continue with no relevant prior memory."
            : "Present this table to the user, then ask whether to search more memory or enter grill.",
          active.session.memorySearchOutcome === "no_candidates"
            ? "Do not enter review_grill until the user explicitly confirms no_relevant_memory with insight_confirm_no_relevant_memory."
            : "Do not enter review_grill until the user explicitly chooses grill.",
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
      memorySearchOutcome: active.session.memorySearchOutcome,
      errors,
      retrieval: {
        deadlineMs: retrievalDeadlineMs,
        qmdConcurrency: concurrency.qmd,
        backlinkConcurrency: concurrency.backlinks,
        providerOutcomes: providerOutcomes.map((outcome) => ({
          status: outcome.status,
          command: outcome.command,
          durationMs: outcome.durationMs,
          candidateCount: outcome.value.length,
          diagnostics: outcome.diagnostics,
        })),
      },
      rerank,
      memoryCandidates: active.session.memoryCandidates,
      memoryCandidatePool: active.session.memoryCandidatePool,
      explicitCueResults: active.session.explicitCueResults,
    },
  };
  } finally {
    retrievalAbort.cleanup();
  }
}

