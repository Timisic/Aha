#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const USAGE = [
  "Usage:",
  "  node scripts/bench/summarize-report.mjs <bench-report.json> [--backend full]",
].join("\n");

function number(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function fixed(value, digits = 3) {
  return number(value).toFixed(digits);
}

function parseArgs() {
  const args = process.argv.slice(2);
  const backendIndex = args.indexOf("--backend");
  const backend = backendIndex >= 0 ? args[backendIndex + 1] : "full";
  const positional = args.filter((arg, index) => {
    if (arg === "--backend") return false;
    if (backendIndex >= 0 && index === backendIndex + 1) return false;
    return !arg.startsWith("--");
  });
  if (positional.length !== 1 || !backend) {
    console.error(USAGE);
    process.exit(1);
  }
  return { reportPath: positional[0], backend };
}

function health(summary) {
  if (!summary) return "not enough data";
  const recall = number(summary?.avg_recall_at_k ?? summary?.avg_recall_at_10 ?? summary?.avg_recall_at_5);
  if (recall >= 0.8) return "green";
  if (recall >= 0.6) return "yellow";
  return "red";
}

function backendRows(summary) {
  return Object.entries(summary ?? {}).map(([name, stats]) => ({
    backend: name,
    topK: number(stats.top_k) || (stats.avg_recall_at_10 !== undefined ? 10 : 5),
    niceTopK: number(stats.nice_top_k) || 20,
    recall: number(stats.avg_recall_at_k ?? stats.avg_recall_at_10 ?? stats.avg_recall_at_5),
    mustRecall: stats.eval_v2?.avg_must_recall_at_k,
    usefulPrecision: stats.eval_v2?.avg_useful_precision_at_k,
    ndcg: stats.eval_v2?.avg_ndcg_at_k,
    negativeRate: stats.eval_v2?.avg_negative_rate_at_k,
    niceRecall: stats.avg_nice_to_have_recall_at_k,
    worstMustRank: number(stats.avg_worst_must_rank),
    precision: number(stats.avg_precision),
    f1: number(stats.avg_f1),
    latency: Math.round(number(stats.avg_latency_ms)),
  }));
}

function printBackendTable(rows) {
  console.log("| Backend | Must K | R@K | Must Recall@K | Useful Precision@K | nDCG@K | Negative Rate@K | Nice K | Nice R@K | Avg worst must-rank | Precision | F1 | Avg ms |");
  console.log("|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
  for (const row of rows) {
    const niceRecall = typeof row.niceRecall === "number" ? fixed(row.niceRecall) : "-";
    const mustRecall = typeof row.mustRecall === "number" ? fixed(row.mustRecall) : "-";
    const usefulPrecision = typeof row.usefulPrecision === "number" ? fixed(row.usefulPrecision) : "-";
    const ndcg = typeof row.ndcg === "number" ? fixed(row.ndcg) : "-";
    const negativeRate = typeof row.negativeRate === "number" ? fixed(row.negativeRate) : "-";
    console.log(`| ${row.backend} | ${row.topK} | ${fixed(row.recall)} | ${mustRecall} | ${usefulPrecision} | ${ndcg} | ${negativeRate} | ${row.niceTopK} | ${niceRecall} | ${fixed(row.worstMustRank, 1)} | ${fixed(row.precision)} | ${fixed(row.f1)} | ${row.latency} |`);
  }
}

function printMisses(results, backend) {
  console.log("");
  console.log(`Misses for backend: ${backend}`);
  console.log("");
  console.log("| Case | Must K | R@K | Nice K | Nice R@K | Must-recall ranks | Nice ranks | Missing must-recall files |");
  console.log("|---|---:|---:|---:|---:|---|---|---|");
  for (const result of results ?? []) {
    const stats = result.backends?.[backend];
    if (!stats) {
      console.log(`| ${result.id} | - | 0.000 | - | backend not present |`);
      continue;
    }
    const missing = Array.isArray(stats.unmatched_expected_files)
      ? stats.unmatched_expected_files.join("<br>")
      : "";
    const topK = number(stats.top_k) || (stats.recall_at_10 !== undefined ? 10 : 5);
    const niceTopK = number(stats.nice_to_have?.top_k) || number(stats.nice_top_k) || 20;
    const recall = stats.recall_at_k ?? stats.recall_at_10 ?? stats.recall_at_5;
    const ranks = Array.isArray(stats.found_must_recall_ranks)
      ? stats.found_must_recall_ranks.join(", ")
      : "-";
    const niceRecall = stats.nice_to_have?.recall_at_k;
    const niceRanks = Array.isArray(stats.nice_to_have?.found_nice_to_have_ranks)
      ? stats.nice_to_have.found_nice_to_have_ranks.join(", ")
      : "-";
    console.log(`| ${result.id} | ${topK} | ${fixed(recall)} | ${niceTopK} | ${typeof niceRecall === "number" ? fixed(niceRecall) : "-"} | [${ranks}] | [${niceRanks}] | ${missing || "-"} |`);
  }
}

function printPipelineSummary(report) {
  const summary = report.summary ?? {};
  console.log("| Metric | Value |");
  console.log("|---|---:|");
  console.log(`| Must Recall@10 | ${fixed(summary.eval_v2?.avg_must_recall_at_k)} |`);
  console.log(`| Useful Precision@10 | ${fixed(summary.eval_v2?.avg_useful_precision_at_k)} |`);
  console.log(`| nDCG@10 | ${fixed(summary.eval_v2?.avg_ndcg_at_k)} |`);
  console.log(`| Negative Rate@10 | ${fixed(summary.eval_v2?.avg_negative_rate_at_k)} |`);
  console.log(`| Expanded Pool Recall@20 | ${fixed(summary.avg_expanded_pool_recall_at_20 ?? summary.avg_expanded_pool_recall)} |`);
  console.log(`| Dropped Must Count | ${number(summary.dropped_must_count ?? summary.expanded_pool_dropped_topk_count)} |`);
  console.log(`| Stability@10 | ${fixed(summary.avg_stability_at_10)} |`);
  for (const [group, count] of Object.entries(summary.failure_attribution_counts ?? {})) {
    console.log(`| Failure Attribution: ${group} | ${count} |`);
  }
}

function main() {
  const { reportPath, backend } = parseArgs();
  const report = JSON.parse(readFileSync(resolve(reportPath), "utf-8"));
  const rows = backendRows(report.summary);
  const selectedSummary = report.summary?.[backend];

  console.log(`# Aha Memory Bench Summary`);
  console.log("");
  console.log(`Report: ${reportPath}`);
  console.log(`Primary backend: ${backend}`);
  console.log(`Health: ${health(selectedSummary)}`);
  console.log("");

  if ((report.results ?? []).some((result) => result.pipeline) && typeof report.summary?.cases === "number") {
    printPipelineSummary(report);
    return;
  }

  if (rows.length === 0) {
    console.log("No benchmark results found. Add active cases to bench/aha-memory-cases.json first.");
    return;
  }

  printBackendTable(rows);
  printMisses(report.results, backend);
}

main();
