import { benchVaultRoot, expandHome } from "./vault-paths.mjs";
import {
  normalizeNoteIdentity,
  resolveVaultPath,
} from "../aha/lib/note-identity.mjs";

export { expandHome };

export function normalizePathForScore(path) {
  return normalizeNoteIdentity(path).replace(/^\/+|\/+$/g, "");
}

function vaultRelativePath(path) {
  const normalized = normalizePathForScore(expandHome(String(path ?? "")));
  const vaultRoot = normalizePathForScore(benchVaultRoot());
  if (normalized === vaultRoot) return "";
  if (normalized.startsWith(`${vaultRoot}/`)) return normalized.slice(vaultRoot.length + 1);
  return normalized;
}

function slugPath(path) {
  return vaultRelativePath(path)
    .split("/")
    .map((segment) =>
      segment
        .replace(/\.md$/i, "")
        .replace(/[\u{1F000}-\u{1FBFF}\u{2600}-\u{27BF}]/gu, (ch) => ch.codePointAt(0).toString(16))
        .replace(/[\s，。；;、：:（）()【】\[\]《》<>!?！？“”‘’「」『』'—–]+/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-+|-+$/g, ""),
    )
    .join("/");
}

export function qmdExpectedPath(path) {
  return slugPath(path);
}

export function pathsMatch(result, expected, options = {}) {
  if (options.resolver) {
    const resolvedResult = resolveVaultPath(result, options.resolver);
    const resolvedExpected = resolveVaultPath(expected, options.resolver);
    return resolvedResult.status === "resolved"
      && resolvedExpected.status === "resolved"
      && resolvedResult.identity === resolvedExpected.identity;
  }
  const nr = normalizePathForScore(result);
  const ne = normalizePathForScore(expected);
  const sr = slugPath(result);
  const se = slugPath(expected);
  if (!nr || !ne) return false;
  if (nr === ne) return true;
  if (sr === se) return true;
  return false;
}

export function canonicalizeResultFiles(resultFiles, options = {}) {
  const files = [];
  const seen = new Map();
  const diagnostics = {
    ambiguous: [],
    not_found: [],
    duplicates: [],
  };
  for (const rawFile of resultFiles ?? []) {
    const file = String(rawFile ?? "").trim();
    if (!file) continue;
    let canonicalFile = file;
    let identity = qmdExpectedPath(file);
    if (options.resolver) {
      const resolved = resolveVaultPath(file, options.resolver);
      if (resolved.status === "resolved") {
        canonicalFile = resolved.path;
        identity = `resolved:${resolved.identity}`;
      } else {
        identity = `${resolved.status}:${normalizeNoteIdentity(file)}`;
        diagnostics[resolved.status].push({ reference: file, matches: resolved.matches ?? [] });
      }
    }
    const first = seen.get(identity);
    if (first) {
      diagnostics.duplicates.push({ identity, references: [first, file] });
      continue;
    }
    seen.set(identity, file);
    files.push(canonicalFile);
  }
  return { files, diagnostics };
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

export function filterSourceNoteFromResults(resultFiles, sourceNotePath, options = {}) {
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
    if (pathsMatch(file, sourcePath, options)) {
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

function hitsWithin(resultFiles, expectedFiles, k, options = {}) {
  const topKResults = resultFiles.slice(0, k);
  let hits = 0;
  for (const expected of expectedFiles) {
    if (topKResults.some((result) => pathsMatch(result, expected, options))) hits += 1;
  }
  return hits;
}

function targetRanks(resultFiles, expectedFiles, options = {}) {
  return expectedFiles.map((expected) => {
    const index = resultFiles.findIndex((result) => pathsMatch(result, expected, options));
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

function firstMatchingLabel(path, labelSets, options = {}) {
  for (const labelSet of labelSets) {
    if (labelSet.files.some((expected) => pathsMatch(path, expected, options))) {
      return labelSet;
    }
  }
  return null;
}

function targetHitsWithin(resultFiles, expectedFiles, topK, options = {}) {
  const topKResults = resultFiles.slice(0, topK);
  return targetRanks(topKResults, expectedFiles, options)
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
  const matchOptions = { resolver: config.resolver };
  const canonicalResults = canonicalizeResultFiles(resultFiles, matchOptions).files;
  const mustRecallFiles = canonicalizeResultFiles(config.mustRecallFiles ?? config.must_recall ?? [], matchOptions).files;
  const niceToHaveFiles = canonicalizeResultFiles(config.niceToHaveFiles ?? config.nice_to_have ?? [], matchOptions).files;
  const negativeFiles = canonicalizeResultFiles(config.negativeFiles ?? config.negative ?? [], matchOptions).files;
  const topKResults = canonicalResults.slice(0, topK);
  const mustHits = targetHitsWithin(topKResults, mustRecallFiles, topK, matchOptions);
  const niceHits = targetHitsWithin(topKResults, niceToHaveFiles, topK, matchOptions);
  const negativeHits = targetHitsWithin(topKResults, negativeFiles, topK, matchOptions);
  const usefulHitCount = new Set(
    [...mustHits, ...niceHits].map((file) => qmdExpectedPath(file)),
  ).size;

  const relevanceLabels = [
    { label: "must_recall", relevance: 2, files: mustRecallFiles },
    { label: "nice_to_have", relevance: 1, files: niceToHaveFiles },
  ];
  const rankedRelevance = topKResults.map((file) => firstMatchingLabel(file, relevanceLabels, matchOptions)?.relevance ?? 0);
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

export function comparePipelineStability(currentReport, comparisonReport, options = {}) {
  const currentResults = currentReport?.results ?? [];
  const currentBudgets = stabilityBudgets(currentResults, currentReport);
  const notMeasured = (reason) => ({
    summary: stabilitySummary(
      "not_measured",
      reason,
      currentBudgets.topK,
      0,
      null,
      currentBudgets.topKs,
    ),
    by_case: Object.fromEntries(currentResults.map((result) => [
      result.id,
      stabilityCase("not_measured", reason, resultTopK(result, currentReport), null),
    ])),
  });

  if (!comparisonReport) return notMeasured("no_comparison_report");
  const incompatibility = stabilityIncompatibility(currentReport, comparisonReport);
  if (incompatibility) return notMeasured(incompatibility);

  const comparisonById = new Map((comparisonReport.results ?? []).map((result) => [result.id, result]));
  const byCase = {};
  const measured = [];
  for (const current of currentResults) {
    const comparison = comparisonById.get(current.id);
    if (!comparison) {
      byCase[current.id] = stabilityCase(
        "not_measured",
        "comparison_case_missing",
        resultTopK(current, currentReport),
        null,
      );
      continue;
    }
    const currentTopK = resultTopK(current, currentReport);
    const comparisonTopK = resultTopK(comparison, comparisonReport);
    if (currentTopK !== comparisonTopK) {
      byCase[current.id] = stabilityCase("not_measured", "incompatible_top_k", currentTopK, null, {
        comparison_top_k: comparisonTopK,
      });
      continue;
    }
    const currentFiles = pipelineCandidateFiles(current).slice(0, currentTopK);
    const comparisonFiles = pipelineCandidateFiles(comparison).slice(0, currentTopK);
    if (currentFiles.length === 0 || comparisonFiles.length === 0) {
      byCase[current.id] = stabilityCase("not_measured", "empty_candidate_set", currentTopK, null);
      continue;
    }
    const currentIdentities = canonicalIdentitySet(currentFiles, options);
    const comparisonIdentities = canonicalIdentitySet(comparisonFiles, options);
    const overlap = Array.from(currentIdentities).filter((identity) => comparisonIdentities.has(identity)).length;
    const denominator = Math.max(currentIdentities.size, comparisonIdentities.size);
    const score = denominator > 0 ? overlap / denominator : null;
    byCase[current.id] = stabilityCase("measured", null, currentTopK, score, {
      overlap_count: overlap,
      current_count: currentIdentities.size,
      comparison_count: comparisonIdentities.size,
    });
    if (typeof score === "number") measured.push(score);
  }

  if (measured.length === 0) {
    return {
      summary: stabilitySummary(
        "not_measured",
        "no_comparable_cases",
        currentBudgets.topK,
        0,
        null,
        currentBudgets.topKs,
      ),
      by_case: byCase,
    };
  }
  return {
    summary: stabilitySummary(
      "measured",
      null,
      currentBudgets.topK,
      measured.length,
      average(measured, null),
      currentBudgets.topKs,
    ),
    by_case: byCase,
  };
}

export function failureAttributionFromTrace(caseItem, trace, options = {}) {
  const explicit = normalizeFailureAttribution(caseItem.failure_attribution, caseItem.id);
  if (explicit) {
    return attributedFailure(explicit.primary, explicit.flags, {
      stage: "human_review",
      source: "explicit_case_attribution",
    });
  }

  const identityDiagnostics = caseItem.identity_evaluation?.diagnostics ?? {};
  if ((identityDiagnostics.schema_conflicts?.length ?? 0) > 0 || (identityDiagnostics.label_conflicts?.length ?? 0) > 0) {
    return attributedFailure("case_label_failure", [], {
      stage: "case_validation",
      schema_conflict_count: identityDiagnostics.schema_conflicts?.length ?? 0,
      label_conflict_count: identityDiagnostics.label_conflicts?.length ?? 0,
    });
  }
  if ((identityDiagnostics.ambiguous?.length ?? 0) > 0 || (identityDiagnostics.not_found?.length ?? 0) > 0) {
    return attributedFailure("input_representation_failure", [], {
      stage: "identity_resolution",
      ambiguous_count: identityDiagnostics.ambiguous?.length ?? 0,
      not_found_count: identityDiagnostics.not_found?.length ?? 0,
    });
  }

  const mustFiles = caseItem.identity_evaluation?.gold?.must ?? caseItem.must_recall ?? [];
  if (mustFiles.length === 0) return null;
  const topK = Number(options.topK ?? 10);
  const steps = trace?.steps;
  if (!steps) return unattributedFailure(["steps"]);

  const finalCandidates = Array.isArray(steps.final_candidates) ? steps.final_candidates : [];
  const missedMust = mustFiles.filter((file) => {
    const rank = traceRank(finalCandidates, file, options);
    return rank === null || rank > topK;
  });
  if (missedMust.length === 0) return null;

  if (steps.query_generation?.status === "failed" || (steps.query_generation?.errors?.length ?? 0) > 0) {
    return attributedFailure("query_failure", [], {
      stage: "query_generation",
      missed_must_count: missedMust.length,
      error_categories: traceErrorCategories(steps.query_generation?.errors),
    });
  }

  const qmdRuns = steps.qmd_runs;
  const hasPreJudgeCandidates = Array.isArray(steps.pre_judge_candidates);
  const hasPreRerankCandidates = Array.isArray(steps.pre_rerank_candidates);
  const missingCandidatePathFields = [
    ...(!Array.isArray(qmdRuns) ? ["qmd_runs"] : []),
    ...(!hasPreJudgeCandidates && !hasPreRerankCandidates ? ["pre_judge_candidates"] : []),
    ...(!Array.isArray(steps.final_candidates) ? ["final_candidates"] : []),
  ];
  if (missingCandidatePathFields.length > 0) {
    return unattributedFailure(missingCandidatePathFields);
  }

  const reviewed = steps.relation_judge?.reviewed_candidates;
  if (!Array.isArray(reviewed)) {
    return unattributedFailure(["relation_judge.reviewed_candidates"]);
  }
  const judgeBudget = Number(options.judgeBudget ?? 20);
  const reviewedWithinBudget = reviewed.slice(0, judgeBudget);
  const preJudge = hasPreJudgeCandidates
    ? steps.pre_judge_candidates
    : steps.pre_rerank_candidates;
  const reviewedMisses = missedMust.filter((file) => traceRank(reviewedWithinBudget, file, options) !== null);
  const beyondJudgeBudget = missedMust.filter((file) =>
    traceRank(preJudge, file, options) !== null && traceRank(reviewedWithinBudget, file, options) === null,
  );
  if (reviewedMisses.length < missedMust.length) {
    const flags = [];
    if (beyondJudgeBudget.length > 0) flags.push("found_beyond_judge_budget");
    if (beyondJudgeBudget.length === 0) flags.push("missing_from_expanded_pool");
    return attributedFailure("retrieval_failure", flags, {
      stage: "candidate_selection",
      missed_must_count: missedMust.length,
      reviewed_must_count: reviewedMisses.length,
      must_found_beyond_judge_budget: beyondJudgeBudget.length,
      judge_budget: judgeBudget,
      qmd_run_count: qmdRuns.length,
    });
  }

  const judgeFailed = steps.relation_judge?.status === "failed" || steps.relation_judge?.fallback === true;
  const relationMismatches = relationTargetMismatches(caseItem, steps.relation_judge?.decisions, options);
  if (judgeFailed || relationMismatches > 0) {
    return attributedFailure("relation_failure", judgeFailed ? ["relation_judge_failed"] : ["relation_mismatch"], {
      stage: "relation_judge",
      reviewed_must_count: reviewedMisses.length,
      judge_budget: judgeBudget,
      relation_mismatch_count: relationMismatches,
      fallback: steps.relation_judge?.fallback === true,
      error_categories: traceErrorCategories(steps.relation_judge?.errors),
    });
  }

  return attributedFailure("rerank_failure", ["dropped_must_from_final_top_k"], {
    stage: "ordering",
    missed_must_count: missedMust.length,
    reviewed_must_count: reviewedMisses.length,
    judge_budget: judgeBudget,
  });
}

function stabilityIncompatibility(current, comparison) {
  const checks = [
    ["profile", current?.profile, comparison?.profile],
    ["suite", current?.suite?.kind, comparison?.suite?.kind],
    ["suite_version", current?.suite?.version, comparison?.suite?.version],
    ["trace_schema", current?.metadata?.trace_schema, comparison?.metadata?.trace_schema],
    ["trace_version", current?.metadata?.trace_version, comparison?.metadata?.trace_version],
    ["effective_config", current?.metadata?.effective_config_id, comparison?.metadata?.effective_config_id],
    ["candidate_limit", current?.candidate_limit, comparison?.candidate_limit],
  ];
  for (const [label, left, right] of checks) {
    if (left === undefined || left === null || right === undefined || right === null || left !== right) {
      return `incompatible_${label}`;
    }
  }
  const currentIds = (current.results ?? []).map((result) => result.id).sort();
  const comparisonIds = (comparison.results ?? []).map((result) => result.id).sort();
  if (currentIds.length !== comparisonIds.length || currentIds.some((id, index) => id !== comparisonIds[index])) {
    return "incompatible_case_set";
  }
  return null;
}

function stabilitySummary(status, reason, topK, measuredCases, score, topKs = []) {
  return {
    status,
    ...(reason ? { reason } : {}),
    metric: "top_k_overlap",
    top_k: topK,
    ...(topKs.length > 1 ? { top_ks: topKs } : {}),
    measured_cases: measuredCases,
    score,
  };
}

function resultTopK(result, report) {
  const value = Number(
    result?.pipeline?.eval_v2?.top_k
      ?? result?.pipeline?.score?.top_k
      ?? result?.expected_in_top_k
      ?? report?.summary?.eval_v2?.top_k
      ?? 10,
  );
  return Number.isFinite(value) && value > 0 ? value : 10;
}

function stabilityBudgets(results, report) {
  const topKs = Array.from(new Set((results ?? []).map((result) => resultTopK(result, report))))
    .sort((left, right) => left - right);
  if (topKs.length === 0) topKs.push(10);
  return {
    topK: topKs.length === 1 ? topKs[0] : null,
    topKs,
  };
}

function stabilityCase(status, reason, topK, score, counts = {}) {
  return {
    status,
    ...(reason ? { reason } : {}),
    metric: "top_k_overlap",
    top_k: topK,
    score,
    ...counts,
  };
}

function pipelineCandidateFiles(result) {
  return (result?.pipeline?.top_candidates ?? result?.candidates ?? [])
    .map((candidate) => typeof candidate === "string"
      ? candidate
      : candidate?.file ?? candidate?.notePath ?? candidate?.path ?? "")
    .filter(Boolean);
}

function canonicalIdentitySet(files, options) {
  const canonical = canonicalizeResultFiles(files, { resolver: options.resolver }).files;
  return new Set(canonical.map((file) => normalizeNoteIdentity(file)));
}

function traceRank(candidates, expected, options) {
  const index = (candidates ?? []).findIndex((candidate) => {
    const file = typeof candidate === "string" ? candidate : candidate?.file ?? candidate?.notePath ?? candidate?.path;
    return pathsMatch(file, expected, { resolver: options.resolver });
  });
  return index < 0 ? null : Number(candidates[index]?.rank ?? index + 1);
}

function relationTargetMismatches(caseItem, decisions, options) {
  if (!Array.isArray(caseItem.relation_targets) || !Array.isArray(decisions)) return 0;
  let mismatches = 0;
  for (const target of caseItem.relation_targets) {
    if (!target?.relation) continue;
    const path = target.note_path ?? target.notePath;
    const decision = decisions.find((candidate) => {
      const file = candidate?.file ?? candidate?.notePath ?? candidate?.path;
      return pathsMatch(file, path, { resolver: options.resolver });
    });
    if (decision && decision.relation !== target.relation) mismatches += 1;
  }
  return mismatches;
}

function traceErrorCategories(errors) {
  return Array.from(new Set((errors ?? []).map((error) => error?.category).filter(Boolean)));
}

function attributedFailure(primary, flags, evidence) {
  return {
    status: "attributed",
    primary,
    evidence,
    flags: Array.from(new Set(flags ?? [])),
  };
}

function unattributedFailure(missingTraceFields) {
  return {
    status: "unattributed",
    primary: null,
    reason: "insufficient_trace_evidence",
    evidence: {
      stage: "unknown",
      missing_trace_fields: missingTraceFields,
    },
    flags: [],
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

export function scoreResults(resultFiles, expectedFiles, topK, options = {}) {
  const canonicalResults = canonicalizeResultFiles(resultFiles, options).files;
  const canonicalExpected = canonicalizeResultFiles(expectedFiles, options).files;
  resultFiles = canonicalResults;
  expectedFiles = canonicalExpected;
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
  const mustRecallRanks = targetRanks(resultFiles, expectedFiles, options);
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
    recall_at_1: expectedFiles.length > 0 ? hitsWithin(resultFiles, expectedFiles, 1, options) / expectedFiles.length : 0,
    recall_at_3: expectedFiles.length > 0 ? hitsWithin(resultFiles, expectedFiles, 3, options) / expectedFiles.length : 0,
    recall_at_5: expectedFiles.length > 0 ? hitsWithin(resultFiles, expectedFiles, 5, options) / expectedFiles.length : 0,
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

export function scoreNiceToHave(resultFiles, niceToHaveFiles, topK, options = {}) {
  resultFiles = canonicalizeResultFiles(resultFiles, options).files;
  niceToHaveFiles = canonicalizeResultFiles(niceToHaveFiles, options).files;
  const niceRanks = targetRanks(resultFiles, niceToHaveFiles, options);
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

function identityDiagnostics(caseDiagnostics = {}, resultDiagnostics = {}) {
  return {
    ambiguous: caseDiagnostics.ambiguous ?? [],
    not_found: caseDiagnostics.not_found ?? [],
    duplicates: caseDiagnostics.duplicates ?? [],
    schema_conflicts: caseDiagnostics.schema_conflicts ?? [],
    label_conflicts: caseDiagnostics.label_conflicts ?? [],
    result_ambiguous: resultDiagnostics.ambiguous ?? [],
    result_not_found: resultDiagnostics.not_found ?? [],
    result_duplicates: resultDiagnostics.duplicates ?? [],
  };
}

function markStatsNotScored(stats, config) {
  const topK = Number(config.topK ?? 10);
  const niceTopK = Number(config.niceTopK ?? 20);
  for (const key of [
    "precision_at_k",
    "target_coverage_at_k",
    "recall",
    "recall_at_1",
    "recall_at_3",
    "recall_at_5",
    "recall_at_k",
    "worst_must_rank",
    "all_must_recalled_at_k",
    "missing_must_count",
    "hits_at_k",
    "total_expected",
    "f1",
  ]) {
    stats[key] = null;
  }
  stats.must_recall_ranks = [];
  stats.found_must_recall_ranks = [];
  stats.matched_files = [];
  stats.unmatched_expected_files = [];
  stats.nice_to_have = {
    status: "not_scored",
    top_k: niceTopK,
    total_nice_to_have: null,
    hits_at_k: null,
    recall: null,
    recall_at_k: null,
    nice_to_have_ranks: [],
    found_nice_to_have_ranks: [],
    matched_files: [],
    missing_nice_to_have_files: [],
  };
  stats.eval_v2 = {
    status: "not_scored",
    top_k: topK,
    must_recall_at_k: null,
    useful_precision_at_k: null,
    ndcg_at_k: null,
    negative_rate_at_k: null,
  };
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
    result.suite = caseConfig.suite ?? null;
    result.suite_version = caseConfig.suiteVersion ?? null;
    result.evaluation_mode = caseConfig.evaluationMode ?? null;
    result.suite_evaluation = caseConfig.suiteEvaluation ?? { status: "ready" };
    for (const stats of Object.values(result.backends ?? {})) {
      const scoringOptions = { resolver: config.identityResolver };
      const canonicalResults = canonicalizeResultFiles(stats.top_files ?? [], scoringOptions);
      const filtered = filterSourceNoteFromResults(canonicalResults.files, caseConfig.sourceNotePath, scoringOptions);
      const caseIdentity = caseConfig.identityEvaluation ?? { status: "ready", diagnostics: {} };
      const suiteEvaluation = caseConfig.suiteEvaluation ?? { status: "ready" };
      stats.evaluation_status = caseIdentity.status === "ready" && suiteEvaluation.status === "ready"
        ? "scored"
        : "not_scored";
      stats.evaluation_reason = caseIdentity.status !== "ready"
        ? "identity_validation"
        : suiteEvaluation.status !== "ready"
          ? "suite_validation"
          : null;
      stats.identity_diagnostics = identityDiagnostics(caseIdentity.diagnostics, canonicalResults.diagnostics);
      stats.duplicate_result_count = canonicalResults.diagnostics.duplicates.length;
      stats.evaluation_top_files = filtered.files;
      stats.top_k = topK;
      stats.nice_top_k = niceTopK;
      stats.evaluation_excludes_source_note = !!caseConfig.sourceNotePath;
      stats.source_note_rank = filtered.source_note_rank;
      if (stats.evaluation_status === "not_scored") {
        markStatsNotScored(stats, { topK, niceTopK });
        delete stats[String.fromCharCode(109, 114, 114)];
        continue;
      }
      const score = scoreResults(filtered.files, expectedFiles, topK, scoringOptions);
      const niceScore = scoreNiceToHave(filtered.files, niceToHaveFiles, niceTopK, scoringOptions);
      const evalV2Score = scoreEvalV2(filtered.files, {
        topK,
        mustRecallFiles: expectedFiles,
        niceToHaveFiles,
        negativeFiles,
        resolver: config.identityResolver,
      });
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

  const backendNames = Object.keys(report.summary ?? {}).filter((backend) => !["by_suite", "by_mode"].includes(backend));
  for (const backend of backendNames) {
    const summary = report.summary[backend];
    Object.assign(summary, summarizeBenchBackend(report.results ?? [], backend));
    delete summary[`avg_${String.fromCharCode(109, 114, 114)}`];
  }

  const bySuite = groupBenchResults(report.results ?? [], (result) => result.suite || "unassigned");
  report.by_suite = Object.fromEntries(Object.entries(bySuite).map(([suite, suiteResults]) => [suite, {
    summary: summarizeBenchBackends(suiteResults, backendNames),
    by_mode: Object.fromEntries(Object.entries(groupBenchResults(
      suiteResults,
      (result) => result.evaluation_mode || "unassigned",
    )).map(([mode, modeResults]) => [mode, summarizeBenchBackends(modeResults, backendNames)])),
  }]));
  report.by_mode = Object.fromEntries(Object.entries(groupBenchResults(
    report.results ?? [],
    (result) => result.evaluation_mode || "unassigned",
  )).map(([mode, modeResults]) => [mode, summarizeBenchBackends(modeResults, backendNames)]));

  return report;
}

function groupBenchResults(results, keyForResult) {
  const groups = {};
  for (const result of results) {
    const key = keyForResult(result);
    groups[key] ??= [];
    groups[key].push(result);
  }
  return groups;
}

function summarizeBenchBackends(results, backendNames) {
  return Object.fromEntries(backendNames.map((backend) => [backend, summarizeBenchBackend(results, backend)]));
}

function summarizeBenchBackend(results, backend) {
  const allBackendStats = results.map((result) => result.backends?.[backend]).filter(Boolean);
  const backendStats = allBackendStats.filter((stats) => stats.evaluation_status !== "not_scored");
  const topKValues = numericValues(allBackendStats.map((stats) => stats.top_k));
  const niceTopKValues = numericValues(allBackendStats.map((stats) => stats.nice_top_k));
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
  const topK = topKValues[0] ?? 10;
  return {
    scored_cases: backendStats.length,
    not_scored_cases: allBackendStats.length - backendStats.length,
    top_k: topK,
    nice_top_k: niceTopKValues[0] ?? 20,
    avg_recall_at_k: average(recallValues, null),
    avg_precision: average(precisionValues, null),
    avg_target_coverage_at_k: average(coverageValues, null),
    avg_f1: average(f1Values, null),
    avg_worst_must_rank: average(worstRankValues, null),
    cases_with_must_miss: missingCountValues.filter((count) => count > 0).length,
    avg_nice_to_have_recall_at_k: niceRecallValues.length > 0 ? average(niceRecallValues, 0) : null,
    eval_v2: {
      top_k: topK,
      avg_must_recall_at_k: average(evalV2MustRecallValues, null),
      avg_useful_precision_at_k: average(evalV2UsefulPrecisionValues, null),
      avg_ndcg_at_k: average(evalV2NdcgValues, null),
      avg_negative_rate_at_k: average(evalV2NegativeRateValues, null),
    },
  };
}

export function summarizePipelineEvaluation(results) {
  if (results.length === 0) {
    return {
      cases: 0,
      scored_cases: 0,
      not_scored_cases: 0,
      avg_qmd_recall_at_k: 0,
      avg_pipeline_recall_at_k: 0,
      avg_pipeline_nice_to_have_recall_at_k: 0,
      avg_worst_must_rank: 0,
      avg_expanded_pool_recall: 0,
      avg_expanded_pool_recall_at_20: 0,
      dropped_must_count: 0,
      avg_stability_at_10: null,
      stability: stabilitySummary("not_measured", "no_results", 10, 0, null),
      failure_attribution_counts: emptyFailureAttributionCounts(),
      failure_flag_counts: {},
      unattributed_failure_count: 0,
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

  const scoredResults = results.filter((result) => result.evaluation_status !== "not_scored");
  const failureSummary = summarizeFailureAttributions(results);
  if (scoredResults.length === 0) {
    return {
      cases: results.length,
      scored_cases: 0,
      not_scored_cases: results.length,
      avg_qmd_recall_at_k: null,
      avg_pipeline_recall_at_k: null,
      avg_pipeline_nice_to_have_recall_at_k: null,
      avg_worst_must_rank: null,
      avg_expanded_pool_recall: null,
      avg_expanded_pool_recall_at_20: null,
      dropped_must_count: 0,
      avg_stability_at_10: null,
      stability: stabilitySummary("not_measured", "no_scored_cases", 10, 0, null),
      ...failureSummary,
      eval_v2: {
        top_k: results[0]?.pipeline?.eval_v2?.top_k ?? results[0]?.pipeline?.score?.top_k ?? 10,
        avg_must_recall_at_k: null,
        avg_useful_precision_at_k: null,
        avg_ndcg_at_k: null,
        avg_negative_rate_at_k: null,
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
  const stabilityValues = [];
  const stabilityAt10Values = [];
  const stabilityTopKs = [];
  let stabilityReason = null;
  let evalV2MustRecall = 0;
  let evalV2UsefulPrecision = 0;
  let evalV2Ndcg = 0;
  let evalV2NegativeRate = 0;
  let qmdDirectMatches = 0;
  let backlinkMatches = 0;
  let missingMatches = 0;
  let expandedPoolDroppedTopK = 0;
  let droppedMustCount = 0;

  for (const result of scoredResults) {
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
    if (result.pipeline.stability?.status === "measured" && typeof result.pipeline.stability.score === "number") {
      stabilityValues.push(result.pipeline.stability.score);
      stabilityTopKs.push(result.pipeline.stability.top_k);
      if (result.pipeline.stability.top_k === 10) stabilityAt10Values.push(result.pipeline.stability.score);
    } else if (!stabilityReason && result.pipeline.stability?.reason) {
      stabilityReason = result.pipeline.stability.reason;
    }
    expandedPoolDroppedTopK += result.expanded_pool.dropped_from_final_top_k?.length ?? 0;
    droppedMustCount += result.expanded_pool.dropped_must_count ?? result.expanded_pool.dropped_from_final_top_k?.length ?? 0;
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
    scored_cases: scoredResults.length,
    not_scored_cases: results.length - scoredResults.length,
    avg_qmd_recall_at_k: qmdRecallAtK / scoredResults.length,
    avg_pipeline_recall_at_k: pipelineRecallAtK / scoredResults.length,
    avg_pipeline_nice_to_have_recall_at_k: pipelineNiceRecallCount > 0
      ? pipelineNiceRecallAtK / pipelineNiceRecallCount
      : null,
    avg_worst_must_rank: worstMustRankCount > 0 ? worstMustRank / worstMustRankCount : 0,
    avg_expanded_pool_recall: expandedRecall / scoredResults.length,
    avg_expanded_pool_recall_at_20: expandedRecallAt20 / scoredResults.length,
    dropped_must_count: droppedMustCount,
    avg_stability_at_10: average(stabilityAt10Values, null),
    stability: stabilityValues.length > 0
      ? stabilitySummary(
          "measured",
          null,
          Array.from(new Set(stabilityTopKs)).length === 1 ? stabilityTopKs[0] : null,
          stabilityValues.length,
          average(stabilityValues, null),
          Array.from(new Set(stabilityTopKs)).sort((left, right) => left - right),
        )
      : stabilitySummary(
          "not_measured",
          stabilityReason ?? "no_comparison_report",
          scoredResults[0]?.pipeline?.stability?.top_k ?? 10,
          0,
          null,
        ),
    ...failureSummary,
    eval_v2: {
      top_k: scoredResults[0]?.pipeline?.eval_v2?.top_k ?? scoredResults[0]?.pipeline?.score?.top_k ?? 10,
      avg_must_recall_at_k: evalV2MustRecall / scoredResults.length,
      avg_useful_precision_at_k: evalV2UsefulPrecision / scoredResults.length,
      avg_ndcg_at_k: evalV2Ndcg / scoredResults.length,
      avg_negative_rate_at_k: evalV2NegativeRate / scoredResults.length,
    },
    qmd_direct_matches: qmdDirectMatches,
    backlink_matches: backlinkMatches,
    missing_matches: missingMatches,
    expanded_pool_dropped_topk_count: expandedPoolDroppedTopK,
  };
}

function summarizeFailureAttributions(results) {
  const failureAttributionCounts = emptyFailureAttributionCounts();
  const failureFlagCounts = {};
  let unattributedFailureCount = 0;
  for (const result of results) {
    if (result.failure_attribution?.primary) {
      failureAttributionCounts[result.failure_attribution.primary] =
        (failureAttributionCounts[result.failure_attribution.primary] ?? 0) + 1;
      for (const flag of result.failure_attribution.flags ?? []) {
        failureFlagCounts[flag] = (failureFlagCounts[flag] ?? 0) + 1;
      }
    } else if (result.failure_attribution?.status === "unattributed") {
      unattributedFailureCount += 1;
    }
  }
  return {
    failure_attribution_counts: failureAttributionCounts,
    failure_flag_counts: failureFlagCounts,
    unattributed_failure_count: unattributedFailureCount,
  };
}

export function summarizePipelineEvaluationGroups(results) {
  const bySuite = {};
  for (const result of results ?? []) {
    const suite = result.suite || "unassigned";
    const mode = result.evaluation_mode || "unassigned";
    bySuite[suite] ??= { results: [], by_mode: {} };
    bySuite[suite].results.push(result);
    bySuite[suite].by_mode[mode] ??= [];
    bySuite[suite].by_mode[mode].push(result);
  }
  return Object.fromEntries(Object.entries(bySuite).map(([suite, group]) => [suite, {
    summary: summarizePipelineEvaluation(group.results),
    by_mode: Object.fromEntries(Object.entries(group.by_mode).map(([mode, modeResults]) => [
      mode,
      summarizePipelineEvaluation(modeResults),
    ])),
  }]));
}
