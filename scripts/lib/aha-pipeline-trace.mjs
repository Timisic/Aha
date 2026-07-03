import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { pathsMatch } from "./aha-bench-evaluation.mjs";

const TRACE_SCHEMA = "PipelineTrace";
const TRACE_VERSION = 1;
const DEFAULT_SNIPPET_CHARS = 300;

function sha256(value) {
  return createHash("sha256").update(String(value ?? "")).digest("hex");
}

function compactWhitespace(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function boundedSnippet(value, maxChars = DEFAULT_SNIPPET_CHARS) {
  const compact = compactWhitespace(value);
  if (compact.length <= maxChars) return compact;
  return `${compact.slice(0, maxChars).trimEnd()}...`;
}

function candidatePath(candidate) {
  return candidate?.file || candidate?.path || candidate?.slug || candidate?.title || "";
}

function sourceList(candidate) {
  if (Array.isArray(candidate?.sources) && candidate.sources.length > 0) return candidate.sources;
  return candidate?.source ? [candidate.source] : [];
}

function traceCandidate(candidate, index) {
  const content = String(candidate?.content ?? "");
  return {
    rank: index + 1,
    rerank_id: candidate?.rerankId,
    title: candidate?.title,
    file: candidatePath(candidate),
    source: sourceList(candidate).join("+") || candidate?.source || undefined,
    sources: sourceList(candidate),
    expansion_from: candidate?.expansionFrom || undefined,
    query_kind: candidate?.queryKind || undefined,
    query_command: candidate?.queryCommand || undefined,
    snippet: boundedSnippet(content),
    content_hash: sha256(content),
  };
}

function rankOf(candidates, file) {
  const index = candidates.findIndex((candidate) => pathsMatch(candidatePath(candidate), file));
  return index >= 0 ? index + 1 : null;
}

function sourceFor(file, candidateGroups) {
  for (const candidates of candidateGroups) {
    const match = candidates.find((candidate) => pathsMatch(candidatePath(candidate), file));
    if (!match) continue;
    return sourceList(match).join("+") || match.source || "unknown";
  }
  return "missing";
}

function goldPositions(files, qmdCandidates, expandedPool, finalCandidates, topK) {
  return files.map((file) => {
    const finalRank = rankOf(finalCandidates, file);
    return {
      file,
      qmd_rank: rankOf(qmdCandidates, file),
      expanded_pool_rank: rankOf(expandedPool, file),
      final_rank: finalRank,
      in_review_budget: finalRank !== null && finalRank <= topK,
      source: sourceFor(file, [finalCandidates, expandedPool, qmdCandidates]),
    };
  });
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
  const positions = {
    must: goldPositions(caseItem.must_recall ?? [], qmdCandidates, expandedPool, finalCandidates, topK),
    nice: goldPositions(caseItem.nice_to_have ?? [], qmdCandidates, expandedPool, finalCandidates, topK),
    noise: goldPositions(caseItem.negative ?? [], qmdCandidates, expandedPool, finalCandidates, topK),
  };
  const primary = failureAttribution?.primary ?? null;
  const diagnosis = {
    primary,
    flags: failureAttribution?.flags ?? [],
    next_target: nextTargetFor(primary),
    signals: diagnosisSignals(failureAttribution, positions),
  };

  return {
    schema: TRACE_SCHEMA,
    version: TRACE_VERSION,
    case: {
      id: caseItem.id,
      state: caseItem.state,
      title: caseItem.title || caseItem.id,
      input: caseItem.input ?? {},
      resolved_input_hash: sha256(caseItem._resolved_insight_input ?? ""),
      resolved_input_preview: boundedSnippet(caseItem._resolved_insight_input ?? ""),
      why: caseItem.why || undefined,
    },
    steps: {
      query_generation: {
        generated_by: generatedQuery.query_generated_by,
        fallback: !!generatedQuery.query_generation_fallback,
        error: generatedQuery.query_generation_error ?? null,
        query_object: generatedQuery.query_object,
        query_objects: generatedQuery.query_objects,
        queries: querySpecs.map((query) => ({
          kind: query.kind,
          command: query.command,
          text: query.text,
          query: query.query,
          qmd: query.qmd,
        })),
      },
      qmd_runs: qmdRuns.map((runItem) => ({
        index: runItem.index,
        kind: runItem.kind,
        command: runItem.command,
        query: runItem.query,
        qmd: runItem.qmd,
        results: runItem.candidates.map(traceCandidate),
        errors: runItem.errors,
      })),
      backlink_expansion: {
        seed_strategy: seedStrategy,
        seeds: backlinkSeeds.map(traceCandidate),
        candidates: backlinkResult.candidates.map(traceCandidate),
        errors: backlinkResult.errors,
      },
      pre_rerank_candidates: preRerankCandidates.map(traceCandidate),
      rerank: {
        generated_by: rerankResult.rerank_generated_by,
        fallback: !!rerankResult.rerank_fallback,
        error: rerankResult.rerank_error ?? null,
        ranked_ids: rerankResult.rerank_ranked_ids ?? [],
      },
      final_candidates: finalCandidates.map(traceCandidate),
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
  if (normalized.includes("/bench/reports/archive/")) {
    return join(dirname(resolvedReportPath), "traces", basename(resolvedReportPath, ".json"));
  }
  return join(dirname(resolvedReportPath), "traces");
}

export function writePipelineTraceForReport(trace, reportPath) {
  const tracePath = join(traceDirForReport(reportPath), `${safeTraceName(trace.case.id)}.json`);
  mkdirSync(dirname(tracePath), { recursive: true });
  writeFileSync(tracePath, `${JSON.stringify(trace, null, 2)}\n`);
  const normalized = tracePath.replace(/\\/g, "/");
  const benchReportsIndex = normalized.lastIndexOf("/bench/reports/");
  if (benchReportsIndex >= 0) return normalized.slice(benchReportsIndex + 1);
  return relative(resolve("."), tracePath).replace(/\\/g, "/");
}

export function summarizeTraceDiagnoses(results) {
  const counts = {};
  for (const result of results) {
    const primary = result.trace_diagnosis?.primary ?? "none";
    counts[primary] = (counts[primary] ?? 0) + 1;
  }
  return counts;
}
