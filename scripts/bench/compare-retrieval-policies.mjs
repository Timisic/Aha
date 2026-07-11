#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { mergeOpenAiTransportStats, normalizeOpenAiTransportStats } from "../lib/openai-transport.mjs";

export function comparePolicyReports(candidate, rollback, decision = null) {
  requireCompatible(candidate, rollback);
  const candidateSummary = summarize(candidate);
  const rollbackSummary = summarize(rollback);
  const tradeoffs = metricDelta(candidateSummary, rollbackSummary);
  return {
    schema: "AhaRetrievalPolicyComparison",
    version: 1,
    suite: candidate.suite,
    candidate: candidateSummary,
    rollback: rollbackSummary,
    tradeoffs,
    promotion: promotionDecision(decision, tradeoffs, evidenceReasons(candidate, rollback)),
    cases: candidate.results.map((current) => {
      const previous = rollback.results.find((item) => item.id === current.id);
      return {
        id: current.id,
        candidate: caseEvidence(current),
        rollback: caseEvidence(previous),
      };
    }),
  };
}

function promotionDecision(decision, tradeoffs, evidence = []) {
  if (evidence.length > 0) {
    return { eligible: false, reasons: evidence, thresholds: decision?.thresholds ?? null, tradeoff_decision: decision?.tradeoff_decision ?? null };
  }
  if (!decision || typeof decision !== "object") {
    return { eligible: false, reasons: ["thresholds_and_tradeoff_decision_not_recorded"], thresholds: null, tradeoff_decision: null };
  }
  const thresholds = decision.thresholds;
  const tradeoffDecision = String(decision.tradeoff_decision ?? "").trim();
  if (!thresholds || typeof thresholds !== "object" || !tradeoffDecision) {
    return { eligible: false, reasons: ["thresholds_and_tradeoff_decision_not_recorded"], thresholds: thresholds ?? null, tradeoff_decision: tradeoffDecision || null };
  }
  const reasons = [];
  for (const [metric, minimum] of Object.entries(thresholds.minimum_quality_delta ?? {})) {
    if (!Number.isFinite(Number(minimum)) || !Number.isFinite(tradeoffs.quality[metric]) || tradeoffs.quality[metric] < Number(minimum)) reasons.push(`quality_threshold_not_met:${metric}`);
  }
  if (Number.isFinite(Number(thresholds.maximum_mean_latency_increase_ms)) && tradeoffs.mean_latency_ms > Number(thresholds.maximum_mean_latency_increase_ms)) reasons.push("latency_threshold_not_met");
  if (Number.isFinite(Number(thresholds.maximum_failure_increase)) && tradeoffs.failures > Number(thresholds.maximum_failure_increase)) reasons.push("failure_threshold_not_met");
  return { eligible: reasons.length === 0, reasons, thresholds, tradeoff_decision: tradeoffDecision };
}

function evidenceReasons(...reports) {
  const reasons = [];
  for (const [index, report] of reports.entries()) {
    const side = index === 0 ? "candidate" : "rollback";
    if (report.metadata?.git_clean !== true) reasons.push(`${side}:dirty_worktree`);
    if (report.suite_validation?.status !== "ready") reasons.push(`${side}:suite_validation_not_ready`);
    if (report.metadata?.privacy_valid !== true) reasons.push(`${side}:privacy_invalid_or_missing`);
    if (report.metadata?.trace_schema !== "PipelineTrace" || report.metadata?.trace_version !== 2) reasons.push(`${side}:trace_incompatible`);
    if (!report.metadata?.effective_config_id || !report.metadata?.effective_configuration?.retrieval_policy?.id) reasons.push(`${side}:config_or_policy_missing`);
    for (const result of report.results ?? []) {
      if (result.evaluation_status !== "scored") reasons.push(`${side}:case_not_scored:${result.id}`);
      if (result.runtime_status !== "success") reasons.push(`${side}:runtime_not_success:${result.id}`);
      if (!String(result.trace_json ?? "").trim()) reasons.push(`${side}:trace_missing:${result.id}`);
      const reportPolicy = report.metadata?.effective_configuration?.retrieval_policy;
      if (result.runtime_policy?.id !== reportPolicy?.id || result.runtime_policy?.version !== reportPolicy?.version) reasons.push(`${side}:trace_policy_mismatch:${result.id}`);
      const stages = caseEvidence(result);
      if (stages.retrieval_top_10.length === 0 || stages.judge_top_10.length === 0 || stages.final_top_10.length === 0) reasons.push(`${side}:stage_evidence_incomplete:${result.id}`);
    }
  }
  const [candidate, rollback] = reports;
  const candidateConfig = { ...candidate.metadata?.effective_configuration, retrieval_policy: null };
  const rollbackConfig = { ...rollback.metadata?.effective_configuration, retrieval_policy: null };
  if (JSON.stringify(candidateConfig) !== JSON.stringify(rollbackConfig)) reasons.push("cross_policy_config_mismatch");
  return [...new Set(reasons)];
}

function requireCompatible(candidate, rollback) {
  if (candidate.profile !== "product-parity" || rollback.profile !== "product-parity") throw new Error("Both reports must be product-parity.");
  if (candidate.suite?.kind !== rollback.suite?.kind || candidate.suite?.version !== rollback.suite?.version) throw new Error("Reports must use the same suite and version.");
  const candidateIds = candidate.results.map((item) => item.id).sort();
  const rollbackIds = rollback.results.map((item) => item.id).sort();
  if (JSON.stringify(candidateIds) !== JSON.stringify(rollbackIds)) throw new Error("Reports must contain the same case set.");
  const candidatePolicy = candidate.metadata?.effective_configuration?.retrieval_policy?.id;
  const rollbackPolicy = rollback.metadata?.effective_configuration?.retrieval_policy?.id;
  if (candidatePolicy === rollbackPolicy) throw new Error("Reports must use different retrieval policies.");
}

function summarize(report) {
  const scored = report.results.filter((item) => item.evaluation_status === "scored");
  const transport = scored.reduce((total, item) => addTransport(total, item.openai_transport?.total), normalizeOpenAiTransportStats());
  return {
    policy: report.metadata.effective_configuration.retrieval_policy,
    effective_config_id: report.metadata.effective_config_id,
    cases: report.results.length,
    scored_cases: scored.length,
    successful_cases: report.results.filter((item) => item.runtime_status === "success").length,
    quality: {
      must_recall_at_10: average(scored, (item) => item.pipeline?.score?.recall_at_k),
      useful_precision_at_10: average(scored, (item) => item.pipeline?.eval_v2?.useful_precision_at_k),
      ndcg_at_10: average(scored, (item) => item.pipeline?.eval_v2?.ndcg_at_k),
      negative_rate_at_10: average(scored, (item) => item.pipeline?.eval_v2?.negative_rate_at_k),
    },
    stability: average(scored, (item) => item.pipeline?.stability?.score),
    latency_ms: { mean: average(scored, (item) => item.latency_ms), total: scored.reduce((sum, item) => sum + Number(item.latency_ms || 0), 0) },
    logical_requests: transport.request_count,
    attempts: transport.attempt_count,
    retries: transport.retry_count,
    failures: report.results.filter((item) => item.runtime_status !== "success").length,
  };
}

function caseEvidence(item) {
  return {
    status: item.runtime_status,
    evaluation_status: item.evaluation_status,
    latency_ms: item.latency_ms,
    retrieval_top_10: (item.qmd?.top_files ?? []).slice(0, 10),
    judge_top_10: (item.pipeline?.relation_judge_reviewed_candidates ?? []).slice(0, 10).map((candidate) => candidate.file ?? candidate.notePath ?? candidate.note_path),
    final_top_10: (item.pipeline?.top_candidates ?? []).slice(0, 10).map((candidate) => candidate.file),
  };
}

function metricDelta(candidate, rollback) {
  return {
    quality: Object.fromEntries(Object.keys(candidate.quality).map((key) => [key, difference(candidate.quality[key], rollback.quality[key])])),
    stability: difference(candidate.stability, rollback.stability),
    mean_latency_ms: difference(candidate.latency_ms.mean, rollback.latency_ms.mean),
    logical_requests: candidate.logical_requests - rollback.logical_requests,
    attempts: candidate.attempts - rollback.attempts,
    retries: candidate.retries - rollback.retries,
    failures: candidate.failures - rollback.failures,
  };
}

function average(items, pick) {
  const values = items.map(pick).map(Number).filter(Number.isFinite);
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}
function difference(a, b) { return Number.isFinite(a) && Number.isFinite(b) ? a - b : null; }
function addTransport(a, b) { return mergeOpenAiTransportStats(a, normalizeOpenAiTransportStats(b)); }

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const [candidatePath, rollbackPath, outputPath, decisionPath] = process.argv.slice(2);
  if (!candidatePath || !rollbackPath || !outputPath) throw new Error("Usage: compare-retrieval-policies.mjs <candidate-report> <rollback-report> <private-output>");
  const decision = decisionPath ? JSON.parse(readFileSync(decisionPath)) : null;
  const comparison = comparePolicyReports(JSON.parse(readFileSync(candidatePath)), JSON.parse(readFileSync(rollbackPath)), decision);
  writeFileSync(outputPath, `${JSON.stringify(comparison, null, 2)}\n`, { mode: 0o600 });
}
