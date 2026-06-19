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
  const sourceNotePath = String(caseItem.source_note_path ?? "").trim();
  return sourceNotePath ? expandHome(sourceNotePath) : "";
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
    result.query_object = queryMeta.query_object;
    result.query_generated_by = queryMeta.query_generated_by;
    result.query_generation_fallback = queryMeta.query_generation_fallback;
    result.query_generation_error = queryMeta.query_generation_error;
    result.expected_in_top_k = topK;
    result.nice_expected_in_top_k = niceTopK;
    result.nice_to_have_files = niceToHaveFiles;
    for (const stats of Object.values(result.backends ?? {})) {
      const filtered = filterSourceNoteFromResults(stats.top_files ?? [], caseConfig.sourceNotePath);
      const score = scoreResults(filtered.files, expectedFiles, topK);
      const niceScore = scoreNiceToHave(filtered.files, niceToHaveFiles, niceTopK);
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
  let qmdDirectMatches = 0;
  let backlinkMatches = 0;
  let missingMatches = 0;
  let expandedPoolDroppedTopK = 0;

  for (const result of results) {
    qmdRecallAtK += result.qmd.score.recall_at_k;
    pipelineRecallAtK += result.pipeline.score.recall_at_k;
    if (typeof result.pipeline.nice_to_have.recall_at_k === "number") {
      pipelineNiceRecallAtK += result.pipeline.nice_to_have.recall_at_k;
      pipelineNiceRecallCount += 1;
    }
    if (typeof result.pipeline.score.worst_must_rank === "number") {
      worstMustRank += result.pipeline.score.worst_must_rank;
      worstMustRankCount += 1;
    }
    expandedRecall += result.expanded_pool.score.recall;
    expandedPoolDroppedTopK += result.expanded_pool.dropped_from_final_top_k?.length ?? 0;
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
    qmd_direct_matches: qmdDirectMatches,
    backlink_matches: backlinkMatches,
    missing_matches: missingMatches,
    expanded_pool_dropped_topk_count: expandedPoolDroppedTopK,
  };
}
