import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { InsightSearchMemoryParams, InsightSession } from "./domain.ts";
import { normalizeMemoryQueryKind, shouldExpandBacklinks } from "./domain.ts";
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
import { recordTrajectoryEvent, summarizeTrajectoryValue, writeTrajectoryArtifact } from "./trajectory.ts";

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
    const queryArtifact = writeTrajectoryArtifact(active, "memory", "memory-query", {
      kind,
      command,
      text,
      qmd: query.qmd,
      qmdQuery,
    });
    recordTrajectoryEvent(active, "memory_query_started", {
      kind,
      command,
      text: summarizeTrajectoryValue(text),
      qmd: query.qmd,
      qmdQuery: summarizeTrajectoryValue(qmdQuery),
      queryArtifact,
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
        },
        active.session,
      ),
    );
    const outputArtifact = writeTrajectoryArtifact(active, "memory", "qmd-output", {
      kind,
      command,
      text,
      stdout: result.stdout,
      stderr: result.stderr,
      code: result.code,
      killed: result.killed,
      connectivityIssue,
      parsedCandidates,
    });
    recordTrajectoryEvent(active, "qmd_call_finished", {
      kind,
      command,
      durationMs: Date.now() - qmdStartedAt,
      code: result.code,
      killed: result.killed,
      connectivityIssue,
      stdout: summarizeTrajectoryValue(result.stdout),
      stderr: summarizeTrajectoryValue(result.stderr),
      parsedCandidateCount: parsedCandidates.length,
      outputArtifact,
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

  const qmdSeeds = mergeCandidates([], found).slice(0, 10);
  recordTrajectoryEvent(active, "backlink_expansion_started", {
    enabled: shouldExpandBacklinks(),
    seedCount: qmdSeeds.length,
    seedIds: qmdSeeds.map((candidate) => candidate.id),
  });
  const backlinkStartedAt = Date.now();
  const backlinkCandidates = shouldExpandBacklinks()
    ? await expandBacklinkCandidates(
        qmdSeeds,
        active.session,
        ctx,
        signal,
      )
    : [];
  recordTrajectoryEvent(active, "backlink_expansion_finished", {
    enabled: shouldExpandBacklinks(),
    durationMs: Date.now() - backlinkStartedAt,
    seedCount: qmdSeeds.length,
    outputCount: backlinkCandidates.length,
    candidateIds: backlinkCandidates.map((candidate) => candidate.id),
  });

  const candidatePool = mergeCandidateEvidence(mergeCandidates(
    active.session.memoryCandidates,
    [...found, ...backlinkCandidates],
  ));
  recordTrajectoryEvent(active, "memory_candidates_merged", {
    previousCandidateCount: active.session.memoryCandidates.length,
    qmdCandidateCount: found.length,
    backlinkCandidateCount: backlinkCandidates.length,
    mergedCandidateCount: candidatePool.length,
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

  active.session.memoryCandidates = rerank.candidates.slice(0, limit);

  if (active.session.explicitMemoryCues.length > 0) {
    const candidateText = active.session.memoryCandidates
      .map((candidate) => `${candidate.title} ${candidate.slug ?? ""}`)
      .join("\n")
      .toLowerCase();
    active.session.missingExplicitCues = active.session.explicitMemoryCues.filter(
      (cue) => !candidateText.includes(cue.toLowerCase()),
    );
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
        },
      };
}
