import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { sameNotePath } from "../aha/lib/note-identity.mjs";
import {
  annotateCandidateRerankIds,
  candidatePath,
  candidateSourceLabel,
  candidateSourceList,
} from "./candidate-fields.mjs";
import { normalizeOpenAiTransportStats } from "./openai-transport.mjs";

export const PIPELINE_TRACE_SCHEMA = "PipelineTrace";
export const PIPELINE_TRACE_VERSION = 2;

function sha256(value) {
  return createHash("sha256").update(String(value ?? "")).digest("hex");
}

function candidateIdentityKey(candidate) {
  return candidatePath(candidate).trim().toLowerCase();
}

function rerankIdLookup(candidates) {
  const byKey = new Map();
  for (const candidate of candidates) {
    const key = candidateIdentityKey(candidate);
    if (!key || !candidate?.rerankId || byKey.has(key)) continue;
    byKey.set(key, candidate.rerankId);
  }
  return byKey;
}

function traceCandidate(candidate, index, rerankIdsByKey = new Map(), options = {}) {
  const content = String(candidate?.content ?? "");
  const sources = Array.isArray(candidate?._traceSources)
    ? candidate._traceSources.map((source) => source?.kind || source?.source).filter(Boolean)
    : candidateSourceList(candidate);
  const key = candidateIdentityKey(candidate);
  const file = safeNoteIdentity(candidatePath(candidate), options.vaultRoot);
  const score = firstFiniteNumber(candidate?._traceScore, candidate?.finalScore, candidate?.bestScore, candidate?.score);
  const quoteHashes = Array.isArray(candidate?.quotes)
    ? candidate.quotes.filter((quote) => typeof quote === "string" && quote.trim()).map(sha256)
    : [];
  return {
    rank: index + 1,
    rerank_id: candidate?.rerankId ?? rerankIdsByKey.get(key),
    file,
    identity_hash: sha256(file || key),
    title_hash: candidate?.title || candidate?.noteTitle ? sha256(candidate.title || candidate.noteTitle) : undefined,
    score,
    source: candidateSourceLabel(candidate),
    sources,
    expansion_from_hash: candidate?.expansionFrom ? sha256(candidate.expansionFrom) : undefined,
    query_kind: candidate?.queryKind || undefined,
    query_command: candidate?.queryCommand || undefined,
    relation: candidate?.relation || undefined,
    content_hash: sha256(content),
    evidence: {
      hit_hash: candidate?.hit ? sha256(candidate.hit) : undefined,
      why_hash: candidate?.why ? sha256(candidate.why) : undefined,
      quote_hashes: quoteHashes,
      quote_count: quoteHashes.length,
    },
  };
}

function firstFiniteNumber(...values) {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return null;
}

function safeNoteIdentity(value, vaultRoot = "") {
  let raw = String(value ?? "").trim().replace(/\\/g, "/");
  if (!raw) return "";
  if (/^qmd:\/\//i.test(raw)) {
    const withoutScheme = raw.slice("qmd://".length);
    const slash = withoutScheme.indexOf("/");
    raw = slash >= 0 ? withoutScheme.slice(slash + 1) : withoutScheme;
    try {
      raw = decodeURIComponent(raw);
    } catch {
      // Keep the original encoded identity when decoding fails.
    }
  }
  raw = raw.replace(/[?#].*$/, "").replace(/^\/+/, "");
  const resolvedVault = String(vaultRoot || "").trim();
  if (resolvedVault && isAbsolute(String(value ?? ""))) {
    const relativePath = relative(resolve(resolvedVault), resolve(String(value))).replace(/\\/g, "/");
    if (relativePath && !relativePath.startsWith("../") && !isAbsolute(relativePath)) return relativePath;
  }
  if (isAbsolute(String(value ?? ""))) return `private-${sha256(value).slice(0, 16)}`;
  const normalized = raw.replace(/^\.\//, "");
  return normalized === ".." || normalized.startsWith("../")
    ? `private-${sha256(value).slice(0, 16)}`
    : normalized;
}

function queryTrace(query) {
  const payload = query?.query || query?.text || JSON.stringify(query?.qmd ?? {});
  return {
    kind: query?.kind || "unknown",
    command: query?.command || "qmd query",
    query_hash: sha256(payload),
  };
}

function errorCategory(value) {
  const text = String(value ?? "").toLowerCase();
  if (text.includes("timed out") || text.includes("timeout")) return "timeout";
  if (text.includes("no usable candidates") || text.includes("no vault-contained")) return "empty_candidates";
  return "stage_error";
}

function traceError(stage, value) {
  const detail = value instanceof Error ? value.message : String(value ?? "");
  return {
    stage,
    category: errorCategory(detail),
    detail_hash: sha256(detail),
  };
}

function traceErrors(stage, values) {
  return (values ?? []).filter(Boolean).map((value) => traceError(stage, value));
}

function rankOf(candidates, file) {
  const index = candidates.findIndex((candidate) => sameNotePath(candidatePath(candidate), file));
  return index >= 0 ? index + 1 : null;
}

function sourceFor(file, candidateGroups) {
  for (const candidates of candidateGroups) {
    const match = candidates.find((candidate) => sameNotePath(candidatePath(candidate), file));
    if (!match) continue;
    return candidateSourceLabel(match) || "unknown";
  }
  return "missing";
}

function goldPositions(files, qmdCandidates, expandedPool, finalCandidates, topK, vaultRoot = "") {
  return files.map((file) => {
    const finalRank = rankOf(finalCandidates, file);
    return {
      file: safeNoteIdentity(file, vaultRoot),
      qmd_rank: rankOf(qmdCandidates, file),
      expanded_pool_rank: rankOf(expandedPool, file),
      final_rank: finalRank,
      in_review_budget: finalRank !== null && finalRank <= topK,
      source: sourceFor(file, [finalCandidates, expandedPool, qmdCandidates]),
    };
  });
}

export function buildRuntimePipelineTrace({
  profile = "product-runtime",
  status = "success",
  sourcePath = "",
  vaultRoot = "",
  generatedQuery = null,
  queryResults = [],
  queryErrors = [],
  graphExpansion = null,
  preJudgeCandidates = [],
  relationJudge = null,
  finalCandidates = [],
  openAiTransport = {},
  errors = [],
} = {}) {
  const tracePreJudgeCandidates = annotateCandidateRerankIds(preJudgeCandidates ?? []);
  const rerankIdsByKey = rerankIdLookup([...tracePreJudgeCandidates, ...(finalCandidates ?? [])]);
  const toTraceCandidate = (candidate, index) => traceCandidate(candidate, index, rerankIdsByKey, { vaultRoot });
  const normalizedErrors = [
    ...traceErrors("qmd_retrieval", queryErrors),
    ...traceErrors("source_expansion", graphExpansion?.errors ?? graphExpansion?.warnings),
    ...(errors ?? []).map((error) => traceError(error?.stage || "runtime", error?.error ?? error?.detail ?? error)),
  ];
  if (relationJudge && relationJudge.ok === false && relationJudge.error) {
    normalizedErrors.push(traceError("relation_judge", relationJudge.error));
  }

  const sourceFile = safeNoteIdentity(sourcePath, vaultRoot);
  const relationCandidates = relationJudge?.candidates ?? finalCandidates ?? [];
  const reviewedCandidates = Array.isArray(relationJudge?.reviewedCandidates)
    ? relationJudge.reviewedCandidates
    : relationCandidates;
  return {
    schema: PIPELINE_TRACE_SCHEMA,
    version: PIPELINE_TRACE_VERSION,
    profile,
    status,
    source: {
      file: sourceFile,
      identity_hash: sha256(sourceFile),
    },
    steps: {
      query_generation: {
        status: generatedQuery ? "success" : "failed",
        generated_by: generatedQuery?.query_generated_by ?? null,
        fallback: !!generatedQuery?.query_generation_fallback,
        prompt_version: generatedQuery?.query_plan_prompt_version ?? null,
        query_count: generatedQuery?.queries?.length ?? 0,
        queries: (generatedQuery?.queries ?? []).map(queryTrace),
        errors: generatedQuery?.query_generation_error
          ? [traceError("query_generation", generatedQuery.query_generation_error)]
          : [],
        ...normalizeOpenAiTransportStats(openAiTransport.query_generation),
      },
      qmd_runs: (queryResults ?? []).map((runItem, index) => ({
        index: runItem.index ?? index,
        ...queryTrace(runItem.query ?? runItem),
        status: (runItem.errors ?? []).length > 0 ? "partial" : "success",
        result_count: (runItem.rows ?? runItem.candidates ?? []).length,
        results: (runItem.rows ?? runItem.candidates ?? []).map(toTraceCandidate),
        errors: traceErrors("qmd_retrieval", runItem.errors),
      })),
      source_expansion: {
        mode: graphExpansion?.mode ?? "source-links-and-backlinks",
        candidate_count: (graphExpansion?.rows ?? graphExpansion?.candidates ?? []).length,
        candidates: (graphExpansion?.rows ?? graphExpansion?.candidates ?? []).map(toTraceCandidate),
        errors: traceErrors("source_expansion", graphExpansion?.errors ?? graphExpansion?.warnings),
      },
      pre_judge_candidates: tracePreJudgeCandidates.map(toTraceCandidate),
      relation_judge: {
        status: relationJudge ? (relationJudge.ok === false ? "failed" : "success") : "not_run",
        generated_by: relationJudge?.relation_judge_generated_by ?? null,
        fallback: !!relationJudge?.relation_judge_fallback,
        prompt_version: relationJudge?.relation_judge_prompt_version ?? null,
        reviewed_count: Number(relationJudge?.reviewedCount ?? reviewedCandidates.length ?? 0),
        reviewed_candidates: reviewedCandidates.map(toTraceCandidate),
        decisions: relationCandidates.map(toTraceCandidate),
        errors: relationJudge?.error ? [traceError("relation_judge", relationJudge.error)] : [],
        ...normalizeOpenAiTransportStats(openAiTransport.relation_judge),
      },
      final_candidates: (finalCandidates ?? []).map(toTraceCandidate),
    },
    errors: normalizedErrors,
  };
}

function nextTargetFor(primary) {
  switch (primary) {
    case "query_failure":
      return "query_generation";
    case "retrieval_failure":
      return "retrieval";
    case "rerank_failure":
      return "rerank";
    case "case_label_failure":
      return "case_labels";
    case "input_representation_failure":
      return "input_representation";
    case "relation_failure":
      return "relation_judge";
    default:
      return "none";
  }
}

function diagnosisSignals(failureAttribution, positions) {
  const signals = new Set();
  const flags = new Set(failureAttribution?.flags ?? []);
  if (flags.has("dropped_must_from_final_top_k")) {
    signals.add("Required gold memory reached pre-rerank pool but missed the review attention budget.");
  }
  if (flags.has("missing_from_expanded_pool")) {
    signals.add("Required gold memory was missing from the pre-rerank candidate pool.");
  }
  if (flags.has("source_self_hit")) {
    signals.add("Source note self-hit affected the candidate path.");
  }
  if (flags.has("runtime_fallback")) {
    signals.add("Runtime fallback affected query generation or reranking.");
  }
  if (
    !failureAttribution?.primary &&
    positions.must.length > 0 &&
    positions.must.every((position) => position.in_review_budget)
  ) {
    signals.add("All required gold memories are inside the review attention budget.");
  }
  if (positions.noise.some((position) => position.in_review_budget)) {
    signals.add("Noise gold memory surfaced inside the review attention budget.");
  }
  return Array.from(signals);
}

export function buildPipelineTrace({
  caseItem,
  generatedQuery,
  querySpecs,
  qmdRuns,
  qmdCandidates,
  backlinkSeeds,
  backlinkResult,
  seedStrategy,
  expandedPool,
  preRerankCandidates,
  rerankResult,
  finalCandidates,
  failureAttribution,
  topK,
}) {
  const vaultRoot = process.env.AHA_BENCH_VAULT_ROOT || "";
  const tracePreRerankCandidates = annotateCandidateRerankIds(preRerankCandidates ?? expandedPool ?? []);
  const rerankIdsByKey = rerankIdLookup([...tracePreRerankCandidates, ...(finalCandidates ?? [])]);
  const toTraceCandidate = (candidate, index) => traceCandidate(candidate, index, rerankIdsByKey, { vaultRoot });
  const positions = {
    must: goldPositions(caseItem.must_recall ?? [], qmdCandidates, expandedPool, finalCandidates, topK, vaultRoot),
    nice: goldPositions(caseItem.nice_to_have ?? [], qmdCandidates, expandedPool, finalCandidates, topK, vaultRoot),
    noise: goldPositions(caseItem.negative ?? [], qmdCandidates, expandedPool, finalCandidates, topK, vaultRoot),
  };
  const primary = failureAttribution?.primary ?? null;
  const diagnosis = {
    primary,
    status: failureAttribution?.status ?? "not_applicable",
    flags: failureAttribution?.flags ?? [],
    next_target: nextTargetFor(primary),
    signals: diagnosisSignals(failureAttribution, positions),
  };

  const runtimeTrace = buildRuntimePipelineTrace({
    profile: "diagnostic-enhanced",
    status: "success",
    sourcePath: caseItem.source_note_path ?? caseItem.input?.note ?? "",
    vaultRoot,
    generatedQuery: {
      ...generatedQuery,
      queries: querySpecs,
    },
    queryResults: qmdRuns.map((runItem) => ({
      index: runItem.index,
      query: runItem,
      candidates: runItem.candidates,
      errors: runItem.errors,
    })),
    queryErrors: qmdRuns.flatMap((runItem) => runItem.errors ?? []),
    graphExpansion: {
      mode: "diagnostic-top-seeds-and-source-neighbors",
      candidates: backlinkResult.candidates,
      errors: backlinkResult.errors,
    },
    preJudgeCandidates: tracePreRerankCandidates,
    relationJudge: {
      ok: !rerankResult.relation_judge_error,
      candidates: rerankResult.candidates,
      reviewedCandidates: rerankResult.relation_judge_reviewed_candidates ?? [],
      relation_judge_generated_by: rerankResult.relation_judge_generated_by,
      relation_judge_fallback: rerankResult.relation_judge_fallback,
      relation_judge_prompt_version: rerankResult.relation_judge_prompt_version,
      error: rerankResult.relation_judge_error,
    },
    finalCandidates,
  });

  return {
    ...runtimeTrace,
    case: {
      id: caseItem.id,
      state: caseItem.state,
      title_hash: sha256(caseItem.title || caseItem.id),
      resolved_input_hash: sha256(caseItem._resolved_insight_input ?? ""),
    },
    steps: {
      ...runtimeTrace.steps,
      backlink_expansion: {
        seed_strategy: seedStrategy,
        seeds: backlinkSeeds.map(toTraceCandidate),
        candidates: backlinkResult.candidates.map(toTraceCandidate),
        errors: traceErrors("source_expansion", backlinkResult.errors),
      },
      pre_rerank_candidates: tracePreRerankCandidates.map(toTraceCandidate),
      rerank: {
        generated_by: rerankResult.relation_judge_generated_by,
        fallback: !!rerankResult.relation_judge_fallback,
        errors: rerankResult.relation_judge_error ? [traceError("relation_judge", rerankResult.relation_judge_error)] : [],
        ranked_ids: rerankResult.relation_judge_ranked_ids ?? [],
        relation_judge_generated_by: rerankResult.relation_judge_generated_by,
        relation_judge_fallback: !!rerankResult.relation_judge_fallback,
        relation_judge_ranked_ids: rerankResult.relation_judge_ranked_ids ?? [],
        relation_judge_prompt_version: rerankResult.relation_judge_prompt_version,
      },
    },
    gold_positions: positions,
    diagnosis,
  };
}

function safeTraceName(caseId) {
  const raw = String(caseId ?? "case");
  const safe = raw
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "case";
  return `${safe}-${sha256(raw).slice(0, 8)}`;
}

function traceDirForReport(reportPath) {
  const resolvedReportPath = resolve(reportPath);
  const normalized = resolvedReportPath.replace(/\\/g, "/");
  if (normalized.includes("/bench/reports/archive/") || basename(dirname(resolvedReportPath)) === "archive") {
    return join(dirname(resolvedReportPath), "traces", basename(resolvedReportPath, ".json"));
  }
  return join(dirname(resolvedReportPath), "traces");
}

export function writePipelineTraceForReport(trace, reportPath) {
  const tracePath = join(traceDirForReport(reportPath), `${safeTraceName(trace.case.id)}.json`);
  mkdirSync(dirname(tracePath), { recursive: true });
  writeFileSync(tracePath, `${JSON.stringify(trace, null, 2)}\n`);
  return relative(dirname(resolve(reportPath)), tracePath).replace(/\\/g, "/");
}

export function summarizeTraceDiagnoses(results) {
  const counts = {};
  for (const result of results) {
    const primary = result.trace_diagnosis?.primary ?? "none";
    counts[primary] = (counts[primary] ?? 0) + 1;
  }
  return counts;
}
