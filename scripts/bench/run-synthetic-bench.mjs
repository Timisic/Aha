#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const CASES = "bench/synthetic/aha-memory-cases.json";
const VAULT_ROOT = resolve("bench/synthetic/vault");
const PROVIDER = resolve("scripts/bench/synthetic-provider.mjs");
const BASELINE = "bench/baselines/synthetic-baseline.json";
const QMD_REPORT = "bench/reports/latest/synthetic-qmd.json";
const PIPELINE_REPORT = "bench/reports/latest/synthetic-pipeline.json";
const L3_REPORT = "bench/reports/latest/l3-core-loop.json";
const SUMMARY_REPORT = "bench/reports/latest/synthetic-summary.json";

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: resolve("."),
    encoding: "utf-8",
    env: {
      ...process.env,
      AHA_BENCH_VAULT_ROOT: VAULT_ROOT,
      AHA_BENCH_QUERY_GENERATOR: "rules",
      AHA_BENCH_RERANKER: "none",
      HOME: process.env.HOME || "",
      ...options.env,
    },
    timeout: options.timeoutMs ?? 180_000,
  });
  const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
  if (output.trim()) process.stdout.write(output.endsWith("\n") ? output : `${output}\n`);
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status}`);
  }
}

function readJson(path) {
  return JSON.parse(readFileSync(resolve(path), "utf-8"));
}

function assertAtLeast(label, actual, expected) {
  if (!(actual >= expected)) {
    throw new Error(`${label} ${actual} is below required ${expected}`);
  }
}

function assertEqual(label, actual, expected) {
  if (actual !== expected) {
    throw new Error(`${label} ${actual} did not equal required ${expected}`);
  }
}

function main() {
  const baseline = readJson(BASELINE);

  run("node", [
    "scripts/bench/run-qmd-bench.mjs",
    "--cases", CASES,
    "--fixture", "bench/generated/synthetic-qmd-fixture.json",
    "--report", QMD_REPORT,
    "--index", "synthetic",
    "--qmd", PROVIDER,
    "--query-generator", "rules",
  ]);

  run("node", [
    "scripts/bench/run-pipeline-bench.mjs",
    "--cases", CASES,
    "--report", PIPELINE_REPORT,
    "--index", "synthetic",
    "--collection", "synthetic",
    "--qmd", PROVIDER,
    "--obsidian", PROVIDER,
    "--query-generator", "rules",
    "--reranker", "none",
    "--limit", "12",
    "--seed-limit", "8",
  ]);

  run("node", ["scripts/bench/run-l3-core-loop.mjs", "--report", L3_REPORT], { timeoutMs: 180_000 });

  const qmd = readJson(QMD_REPORT);
  const pipeline = readJson(PIPELINE_REPORT);
  const l3 = readJson(L3_REPORT);
  const thresholds = baseline.thresholds;

  const l1Recall = qmd.summary?.full?.avg_recall_at_k ?? 0;
  const l2Recall = pipeline.summary?.avg_pipeline_recall_at_k ?? 0;
  const l2Missing = pipeline.summary?.missing_matches ?? 0;

  assertAtLeast("L1 avg_recall_at_k", l1Recall, thresholds.l1_min_avg_recall_at_k);
  assertAtLeast("L2 avg_pipeline_recall_at_k", l2Recall, thresholds.l2_min_avg_pipeline_recall_at_k);
  assertEqual("L2 missing_matches", l2Missing, thresholds.l2_max_missing_matches);
  assertEqual("L3 core-loop ok", Boolean(l3.ok), Boolean(thresholds.l3_core_loop_ok));

  const summary = {
    generated_at: new Date().toISOString(),
    baseline: baseline.name,
    deterministic: true,
    private_data_allowed: false,
    networked_model_calls_allowed: false,
    reports: {
      qmd: QMD_REPORT,
      pipeline: PIPELINE_REPORT,
      l3: L3_REPORT,
    },
    metrics: {
      l1_avg_recall_at_k: l1Recall,
      l2_avg_pipeline_recall_at_k: l2Recall,
      l2_missing_matches: l2Missing,
      l3_ok: Boolean(l3.ok),
    },
    thresholds,
    status: "pass",
  };
  mkdirSync(dirname(resolve(SUMMARY_REPORT)), { recursive: true });
  writeFileSync(resolve(SUMMARY_REPORT), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(`Synthetic benchmark status: pass (${SUMMARY_REPORT})`);
}

main();
