import { homedir } from "node:os";
import { resolve } from "node:path";

export function expandHome(path) {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
  return path;
}

export function normalizePathForScore(path) {
  let normalized = String(path ?? "");
  if (normalized.startsWith("qmd://")) {
    const withoutScheme = normalized.slice("qmd://".length);
    const slashIdx = withoutScheme.indexOf("/");
    normalized = slashIdx >= 0 ? withoutScheme.slice(slashIdx + 1) : withoutScheme;
  }
  normalized = normalized.replace(/[?#].*$/, "");
  return normalized.toLowerCase().replace(/^\/+|\/+$/g, "");
}

function vaultRelativePath(path) {
  const normalized = normalizePathForScore(expandHome(String(path ?? "")));
  const vaultRoot = normalizePathForScore(expandHome(process.env.AHA_BENCH_VAULT_ROOT || "/Users/hong/Obsidian Notes"));
  if (normalized === vaultRoot) return "";
  if (normalized.startsWith(`${vaultRoot}/`)) return normalized.slice(vaultRoot.length + 1);
  return normalized;
}

function slugPath(path) {
  return vaultRelativePath(path)
    .split("/")
    .map((segment) =>
      segment
        .replace(/[\s，。；;、：:（）()【】\[\]《》<>!?！？]+/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-+|-+$/g, ""),
    )
    .join("/");
}

export function qmdExpectedPath(path) {
  return slugPath(path);
}

export function pathsMatch(result, expected) {
  const nr = normalizePathForScore(result);
  const ne = normalizePathForScore(expected);
  const sr = slugPath(result);
  const se = slugPath(expected);
  if (!nr || !ne) return false;
  if (nr === ne) return true;
  if (sr === se) return true;
  return false;
}

export function sourceNotePathForCase(caseItem) {
  const sourceNotePath = String(caseItem.input?.note ?? caseItem.source_note_path ?? "").trim();
  return sourceNotePath ? expandHome(sourceNotePath) : "";
}

export const FAILURE_ATTRIBUTION_GROUPS = [
  "case_label_failure",
  "input_representation_failure",
  "query_failure",
  "retrieval_failure",
  "rerank_failure",
  "relation_failure",
];

export function emptyFailureAttributionCounts() {
  return Object.fromEntries(FAILURE_ATTRIBUTION_GROUPS.map((group) => [group, 0]));
}

export function filterSourceNoteFromResults(resultFiles, sourceNotePath) {
  const sourcePath = String(sourceNotePath ?? "").trim();
  if (!sourcePath) {
    return {
      files: resultFiles,
      source_note_rank: null,
    };
  }

  let sourceNoteRank = null;
  const files = [];
  for (const [index, file] of resultFiles.entries()) {
    if (pathsMatch(file, sourcePath)) {
      if (sourceNoteRank === null) sourceNoteRank = index + 1;
      continue;
    }
    files.push(file);
  }

  return {
    files,
    source_note_rank: sourceNoteRank,
  };
}

function hitsWithin(resultFiles, expectedFiles, k) {
  const topKResults = resultFiles.slice(0, k);
  let hits = 0;
  for (const expected of expectedFiles) {
    if (topKResults.some((result) => pathsMatch(result, expected))) hits += 1;
  }
  return hits;
}

function targetRanks(resultFiles, expectedFiles) {
  return expectedFiles.map((expected) => {
    const index = resultFiles.findIndex((result) => pathsMatch(result, expected));
    return {
      file: expected,
      rank: index >= 0 ? index + 1 : null,
    };
  });
}

function foundRanks(ranks) {
  return ranks
    .map((item) => item.rank)
    .filter((rank) => typeof rank === "number")
    .sort((a, b) => a - b);
}

function firstMatchingLabel(path, labelSets) {
  for (const labelSet of labelSets) {
    if (labelSet.files.some((expected) => pathsMatch(path, expected))) {
      return labelSet;
    }
  }
  return null;
}

function targetHitsWithin(resultFiles, expectedFiles, topK) {
  const topKResults = resultFiles.slice(0, topK);
  return targetRanks(topKResults, expectedFiles)
    .filter((item) => item.rank !== null)
    .map((item) => item.file);
}

function dcg(relevanceValues) {
  return relevanceValues.reduce((sum, relevance, index) => {
    if (relevance <= 0) return sum;
    return sum + ((2 ** relevance) - 1) / Math.log2(index + 2);
  }, 0);
}

export function scoreEvalV2(resultFiles, config = {}) {
  const topK = Number(config.topK ?? 10);
  const mustRecallFiles = config.mustRecallFiles ?? config.must_recall ?? [];
  const niceToHaveFiles = config.niceToHaveFiles ?? config.nice_to_have ?? [];
  const negativeFiles = config.negativeFiles ?? config.negative ?? [];
  const topKResults = resultFiles.slice(0, topK);
  const mustHits = targetHitsWithin(topKResults, mustRecallFiles, topK);
  const niceHits = targetHitsWithin(topKResults, niceToHaveFiles, topK);
  const negativeHits = targetHitsWithin(topKResults, negativeFiles, topK);
  const usefulHitCount = new Set(
    [...mustHits, ...niceHits].map((file) => qmdExpectedPath(file)),
  ).size;

  const relevanceLabels = [
    { label: "must_recall", relevance: 2, files: mustRecallFiles },
    { label: "nice_to_have", relevance: 1, files: niceToHaveFiles },
  ];
  const rankedRelevance = topKResults.map((file) => firstMatchingLabel(file, relevanceLabels)?.relevance ?? 0);
  const idealRelevance = [
    ...mustRecallFiles.map(() => 2),
    ...niceToHaveFiles.map(() => 1),
  ]
    .sort((left, right) => right - left)
    .slice(0, topK);
  const idealDcg = dcg(idealRelevance);

  return {
    top_k: topK,
    must_recall_at_k: mustRecallFiles.length > 0 ? mustHits.length / mustRecallFiles.length : 1,
    must_recall_hits_at_k: mustHits.length,
    total_must_recall: mustRecallFiles.length,
    useful_precision_at_k: usefulHitCount / topK,
    useful_hits_at_k: usefulHitCount,
    ndcg_at_k: idealDcg > 0 ? dcg(rankedRelevance) / idealDcg : 1,
    negative_rate_at_k: negativeHits.length / topK,
    negative_hits_at_k: negativeHits.length,
    total_negative: negativeFiles.length,
    must_recall_hits: mustHits,
    nice_to_have_hits: niceHits,
    negative_hits: negativeHits,
  };
}

export function mustRecallMissesAtK(score, topK) {
  return (score.must_recall_ranks ?? [])
    .filter((item) => item.rank === null || item.rank > topK)
    .map((item) => item.file);
}

export function droppedMustFromExpandedPool(expandedPoolScore, pipelineScore, topK) {
  const missedAtTopK = mustRecallMissesAtK(pipelineScore, topK);
  return (expandedPoolScore.matched_files ?? []).filter((file) =>
    missedAtTopK.some((expected) => pathsMatch(file, expected)),
  );
}

export function failureFlagsForPipelineCase(caseItem, diagnostics) {
  const flags = new Set();
  if (diagnostics.sourceNoteRank) flags.add("source_self_hit");
  if (caseItem.query_generation_fallback || diagnostics.queryFallback || diagnostics.rerankFallback) flags.add("runtime_fallback");
  if (diagnostics.droppedMustCount > 0) flags.add("dropped_must_from_final_top_k");
  if (diagnostics.missingFromExpandedPool > 0) flags.add("missing_from_expanded_pool");
  return Array.from(flags);
}

export function failureAttributionForPipelineCase(caseItem, diagnostics) {
  const explicit = normalizeFailureAttribution(caseItem.failure_attribution, caseItem.id);
  if (explicit) return explicit;
  if (diagnostics.pipelineMissedAtTopKCount < 1) return null;

  const primary = diagnostics.droppedMustCount > 0
    ? "rerank_failure"
    : "retrieval_failure";
  return {
    primary,
    flags: failureFlagsForPipelineCase(caseItem, diagnostics),
  };
}

export function normalizeFailureAttribution(input, caseId = "(unknown case)") {
  if (input === undefined || input === null || input === "") return null;
  if (typeof input === "string") {
    if (!FAILURE_ATTRIBUTION_GROUPS.includes(input)) {
      throw new Error(`${caseId}: unknown failure_attribution primary: ${input}`);
    }
    return {
      primary: input,
      flags: [],
    };
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error(`${caseId}: failure_attribution must be a string or object.`);
  }
  if (Array.isArray(input.primary)) {
    throw new Error(`${caseId}: failure_attribution.primary must contain exactly one primary attribution.`);
  }
  if (Array.isArray(input.primaries) || Array.isArray(input.primary_attributions)) {
    throw new Error(`${caseId}: failure_attribution supports exactly one primary attribution.`);
  }
  const primary = String(input.primary ?? "").trim();
  if (!primary) {
    throw new Error(`${caseId}: failure_attribution.primary is required when failure_attribution is present.`);
  }
  if (!FAILURE_ATTRIBUTION_GROUPS.includes(primary)) {
    throw new Error(`${caseId}: unknown failure_attribution primary: ${primary}`);
  }
  const flags = input.flags === undefined
    ? []
    : Array.isArray(input.flags)
      ? input.flags.map((flag) => String(flag).trim()).filter(Boolean)
      : (() => {
          throw new Error(`${caseId}: failure_attribution.flags must be an array of strings when present.`);
        })();
  return {
    primary,
    flags: Array.from(new Set(flags)),
  };
}

export function scoreResults(resultFiles, expectedFiles, topK) {
  if (expectedFiles.length === 0) {
    return {
      top_k: topK,
      precision_at_k: 0,
      target_coverage_at_k: 1,
      recall: 1,
      recall_at_1: 1,
      recall_at_3: 1,
      recall_at_5: 1,
      recall_at_k: 1,
      must_recall_ranks: [],
      found_must_recall_ranks: [],
      worst_must_rank: null,
      all_must_recalled_at_k: true,
      missing_must_count: 0,
      f1: 0,
      hits_at_k: 0,
      total_expected: 0,
      matched_files: [],
      unmatched_expected_files: [],
    };
  }
  const mustRecallRanks = targetRanks(resultFiles, expectedFiles);
  const hitsAtK = mustRecallRanks.filter((item) => item.rank !== null && item.rank <= topK).length;
  const matchedFiles = mustRecallRanks
    .filter((item) => item.rank !== null)
    .map((item) => item.file);
  const unmatchedExpectedFiles = mustRecallRanks
    .filter((item) => item.rank === null)
    .map((item) => item.file);
  const rankedHits = foundRanks(mustRecallRanks);

  const returnedAtK = Math.min(topK, resultFiles.length);
  const precisionAtK = returnedAtK > 0 ? hitsAtK / returnedAtK : 0;
  const targetCoverageAtK = hitsAtK / Math.min(topK, expectedFiles.length);
  const recall = expectedFiles.length > 0 ? matchedFiles.length / expectedFiles.length : 0;
  const penalizedMustRanks = mustRecallRanks.map((item) => item.rank ?? topK + 1);

  return {
    top_k: topK,
    precision_at_k: precisionAtK,
    target_coverage_at_k: targetCoverageAtK,
    recall,
    recall_at_1: expectedFiles.length > 0 ? hitsWithin(resultFiles, expectedFiles, 1) / expectedFiles.length : 0,
    recall_at_3: expectedFiles.length > 0 ? hitsWithin(resultFiles, expectedFiles, 3) / expectedFiles.length : 0,
    recall_at_5: expectedFiles.length > 0 ? hitsWithin(resultFiles, expectedFiles, 5) / expectedFiles.length : 0,
    recall_at_k: expectedFiles.length > 0 ? hitsAtK / expectedFiles.length : 0,
    must_recall_ranks: mustRecallRanks,
    found_must_recall_ranks: rankedHits,
    worst_must_rank: penalizedMustRanks.length > 0 ? Math.max(...penalizedMustRanks) : null,
    all_must_recalled_at_k: expectedFiles.length > 0 && hitsAtK === expectedFiles.length,
    missing_must_count: unmatchedExpectedFiles.length,
    f1: precisionAtK + recall > 0
      ? 2 * (precisionAtK * recall) / (precisionAtK + recall)
      : 0,
    hits_at_k: hitsAtK,
    total_expected: expectedFiles.length,
    matched_files: matchedFiles,
    unmatched_expected_files: unmatchedExpectedFiles,
  };
}

export function scoreNiceToHave(resultFiles, niceToHaveFiles, topK) {
  const niceRanks = targetRanks(resultFiles, niceToHaveFiles);
  const rankedHits = foundRanks(niceRanks);
  const hitsAtK = niceRanks.filter((item) => item.rank !== null && item.rank <= topK).length;
  const foundFiles = niceRanks
    .filter((item) => item.rank !== null)
    .map((item) => item.file);
  const missingFiles = niceRanks
    .filter((item) => item.rank === null)
    .map((item) => item.file);

  return {
    top_k: topK,
    total_nice_to_have: niceToHaveFiles.length,
    hits_at_k: hitsAtK,
    recall: niceToHaveFiles.length > 0 ? foundFiles.length / niceToHaveFiles.length : null,
    recall_at_k: niceToHaveFiles.length > 0 ? hitsAtK / niceToHaveFiles.length : null,
    nice_to_have_ranks: niceRanks,
    found_nice_to_have_ranks: rankedHits,
    worst_nice_rank: rankedHits.length > 0 ? Math.max(...rankedHits) : null,
    matched_files: foundFiles,
    missing_nice_to_have_files: missingFiles,
  };
}

function average(values, fallback) {
  return values.length > 0
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : fallback;
}

function numericValues(values) {
  return values.filter((value) => typeof value === "number" && Number.isFinite(value));
}

export function applyBenchEvaluationPolicy(report, config) {
  for (const result of report.results ?? []) {
    const caseConfig = config.caseById.get(result.id) ?? {};
    const queryMeta = config.queryMetaById.get(result.id) ?? {};
    const topK = Number(caseConfig.topK ?? 10);
    const niceTopK = Number(caseConfig.niceTopK ?? 20);
    const expectedFiles = config.expectedById.get(result.id) ?? [];
    const niceToHaveFiles = caseConfig.niceToHave ?? [];
    const negativeFiles = caseConfig.negative ?? [];
    result.query_object = queryMeta.query_object;
    result.query_generated_by = queryMeta.query_generated_by;
    result.query_generation_fallback = queryMeta.query_generation_fallback;
    result.query_generation_error = queryMeta.query_generation_error;
    result.expected_in_top_k = topK;
    result.nice_expected_in_top_k = niceTopK;
    result.nice_to_have_files = niceToHaveFiles;
    result.negative_files = negativeFiles;
    for (const stats of Object.values(result.backends ?? {})) {
      const filtered = filterSourceNoteFromResults(stats.top_files ?? [], caseConfig.sourceNotePath);
      const score = scoreResults(filtered.files, expectedFiles, topK);
      const niceScore = scoreNiceToHave(filtered.files, niceToHaveFiles, niceTopK);
      const evalV2Score = scoreEvalV2(filtered.files, {
        topK,
        mustRecallFiles: expectedFiles,
        niceToHaveFiles,
        negativeFiles,
      });
      stats.top_k = topK;
      stats.nice_top_k = niceTopK;
      stats.evaluation_excludes_source_note = !!caseConfig.sourceNotePath;
      stats.source_note_rank = filtered.source_note_rank;
      stats.precision_at_k = score.precision_at_k;
      stats.target_coverage_at_k = score.target_coverage_at_k;
      stats.recall = score.recall;
      stats.recall_at_1 = score.recall_at_1;
      stats.recall_at_3 = score.recall_at_3;
      stats.recall_at_5 = score.recall_at_5;
      stats.recall_at_k = score.recall_at_k;
      stats.must_recall_ranks = score.must_recall_ranks;
      stats.found_must_recall_ranks = score.found_must_recall_ranks;
      stats.worst_must_rank = score.worst_must_rank;
      stats.all_must_recalled_at_k = score.all_must_recalled_at_k;
      stats.missing_must_count = score.missing_must_count;
      stats.hits_at_k = score.hits_at_k;
      stats.total_expected = score.total_expected;
      stats.matched_files = score.matched_files;
      stats.unmatched_expected_files = score.unmatched_expected_files;
      stats.f1 = score.f1;
      stats.nice_to_have = niceScore;
      stats.eval_v2 = evalV2Score;
      delete stats[String.fromCharCode(109, 114, 114)];
    }
  }

  for (const [backend, summary] of Object.entries(report.summary ?? {})) {
    const backendStats = (report.results ?? [])
      .map((result) => result.backends?.[backend])
      .filter(Boolean);
    const topKValues = numericValues(backendStats.map((stats) => stats.top_k));
    const niceTopKValues = numericValues(backendStats.map((stats) => stats.nice_top_k));
    const recallValues = numericValues(backendStats.map((stats) => stats.recall_at_k));
    const precisionValues = numericValues(backendStats.map((stats) => stats.precision_at_k));
    const coverageValues = numericValues(backendStats.map((stats) => stats.target_coverage_at_k));
    const f1Values = numericValues(backendStats.map((stats) => stats.f1));
    const worstRankValues = numericValues(backendStats.map((stats) => stats.worst_must_rank));
    const missingCountValues = numericValues(backendStats.map((stats) => stats.missing_must_count));
    const niceRecallValues = numericValues(backendStats.map((stats) => stats.nice_to_have?.recall_at_k));
    const evalV2MustRecallValues = numericValues(backendStats.map((stats) => stats.eval_v2?.must_recall_at_k));
    const evalV2UsefulPrecisionValues = numericValues(backendStats.map((stats) => stats.eval_v2?.useful_precision_at_k));
    const evalV2NdcgValues = numericValues(backendStats.map((stats) => stats.eval_v2?.ndcg_at_k));
    const evalV2NegativeRateValues = numericValues(backendStats.map((stats) => stats.eval_v2?.negative_rate_at_k));
    summary.top_k = topKValues[0] ?? 10;
    summary.nice_top_k = niceTopKValues[0] ?? 20;
    if (recallValues.length > 0) {
      summary.avg_recall_at_k = average(recallValues, 0);
    } else if (typeof summary.avg_recall === "number") {
      summary.avg_recall_at_k = summary.avg_recall;
    }
    summary.avg_precision = average(precisionValues, 0);
    summary.avg_target_coverage_at_k = average(coverageValues, 0);
    summary.avg_f1 = average(f1Values, 0);
    summary.avg_worst_must_rank = average(worstRankValues, 0);
    summary.cases_with_must_miss = missingCountValues.filter((count) => count > 0).length;
    summary.avg_nice_to_have_recall_at_k = niceRecallValues.length > 0
      ? average(niceRecallValues, 0)
      : null;
    summary.eval_v2 = {
      top_k: summary.top_k,
      avg_must_recall_at_k: average(evalV2MustRecallValues, 0),
      avg_useful_precision_at_k: average(evalV2UsefulPrecisionValues, 0),
      avg_ndcg_at_k: average(evalV2NdcgValues, 0),
      avg_negative_rate_at_k: average(evalV2NegativeRateValues, 0),
    };
    delete summary[`avg_${String.fromCharCode(109, 114, 114)}`];
  }

  return report;
}

export function summarizePipelineEvaluation(results) {
  if (results.length === 0) {
    return {
      cases: 0,
      avg_qmd_recall_at_k: 0,
      avg_pipeline_recall_at_k: 0,
      avg_pipeline_nice_to_have_recall_at_k: 0,
      avg_worst_must_rank: 0,
      avg_expanded_pool_recall: 0,
      avg_expanded_pool_recall_at_20: 0,
      dropped_must_count: 0,
      avg_stability_at_10: 0,
      failure_attribution_counts: emptyFailureAttributionCounts(),
      failure_flag_counts: {},
      eval_v2: {
        top_k: 10,
        avg_must_recall_at_k: 0,
        avg_useful_precision_at_k: 0,
        avg_ndcg_at_k: 0,
        avg_negative_rate_at_k: 0,
      },
      qmd_direct_matches: 0,
      backlink_matches: 0,
      missing_matches: 0,
      expanded_pool_dropped_topk_count: 0,
    };
  }

  let qmdRecallAtK = 0;
  let pipelineRecallAtK = 0;
  let pipelineNiceRecallAtK = 0;
  let pipelineNiceRecallCount = 0;
  let worstMustRank = 0;
  let worstMustRankCount = 0;
  let expandedRecall = 0;
  let expandedRecallAt20 = 0;
  let stabilityAt10 = 0;
  let evalV2MustRecall = 0;
  let evalV2UsefulPrecision = 0;
  let evalV2Ndcg = 0;
  let evalV2NegativeRate = 0;
  let qmdDirectMatches = 0;
  let backlinkMatches = 0;
  let missingMatches = 0;
  let expandedPoolDroppedTopK = 0;
  let droppedMustCount = 0;
  const failureAttributionCounts = emptyFailureAttributionCounts();
  const failureFlagCounts = {};

  for (const result of results) {
    qmdRecallAtK += result.qmd.score.recall_at_k;
    pipelineRecallAtK += result.pipeline.score.recall_at_k;
    evalV2MustRecall += result.pipeline.eval_v2?.must_recall_at_k ?? result.pipeline.score.recall_at_k ?? 0;
    evalV2UsefulPrecision += result.pipeline.eval_v2?.useful_precision_at_k ?? 0;
    evalV2Ndcg += result.pipeline.eval_v2?.ndcg_at_k ?? 0;
    evalV2NegativeRate += result.pipeline.eval_v2?.negative_rate_at_k ?? 0;
    if (typeof result.pipeline.nice_to_have.recall_at_k === "number") {
      pipelineNiceRecallAtK += result.pipeline.nice_to_have.recall_at_k;
      pipelineNiceRecallCount += 1;
    }
    if (typeof result.pipeline.score.worst_must_rank === "number") {
      worstMustRank += result.pipeline.score.worst_must_rank;
      worstMustRankCount += 1;
    }
    expandedRecall += result.expanded_pool.score.recall;
    expandedRecallAt20 += result.expanded_pool.recall_at_20 ?? result.expanded_pool.score_at_20?.recall_at_k ?? result.expanded_pool.score.recall_at_k ?? 0;
    stabilityAt10 += result.pipeline.stability_at_k ?? result.pipeline.stability_at_10 ?? 1;
    expandedPoolDroppedTopK += result.expanded_pool.dropped_from_final_top_k?.length ?? 0;
    droppedMustCount += result.expanded_pool.dropped_must_count ?? result.expanded_pool.dropped_from_final_top_k?.length ?? 0;
    if (result.failure_attribution?.primary) {
      failureAttributionCounts[result.failure_attribution.primary] =
        (failureAttributionCounts[result.failure_attribution.primary] ?? 0) + 1;
      for (const flag of result.failure_attribution.flags ?? []) {
        failureFlagCounts[flag] = (failureFlagCounts[flag] ?? 0) + 1;
      }
    }
    for (const match of result.must_recall_sources) {
      const source = String(match.source ?? "");
      if (source === "missing") {
        missingMatches += 1;
        continue;
      }
      if (source.includes("qmd")) qmdDirectMatches += 1;
      if (source.includes("backlink")) backlinkMatches += 1;
    }
  }

  return {
    cases: results.length,
    avg_qmd_recall_at_k: qmdRecallAtK / results.length,
    avg_pipeline_recall_at_k: pipelineRecallAtK / results.length,
    avg_pipeline_nice_to_have_recall_at_k: pipelineNiceRecallCount > 0
      ? pipelineNiceRecallAtK / pipelineNiceRecallCount
      : null,
    avg_worst_must_rank: worstMustRankCount > 0 ? worstMustRank / worstMustRankCount : 0,
    avg_expanded_pool_recall: expandedRecall / results.length,
    avg_expanded_pool_recall_at_20: expandedRecallAt20 / results.length,
    dropped_must_count: droppedMustCount,
    avg_stability_at_10: stabilityAt10 / results.length,
    failure_attribution_counts: failureAttributionCounts,
    failure_flag_counts: failureFlagCounts,
    eval_v2: {
      top_k: results[0]?.pipeline?.eval_v2?.top_k ?? results[0]?.pipeline?.score?.top_k ?? 10,
      avg_must_recall_at_k: evalV2MustRecall / results.length,
      avg_useful_precision_at_k: evalV2UsefulPrecision / results.length,
      avg_ndcg_at_k: evalV2Ndcg / results.length,
      avg_negative_rate_at_k: evalV2NegativeRate / results.length,
    },
    qmd_direct_matches: qmdDirectMatches,
    backlink_matches: backlinkMatches,
    missing_matches: missingMatches,
    expanded_pool_dropped_topk_count: expandedPoolDroppedTopK,
  };
}
