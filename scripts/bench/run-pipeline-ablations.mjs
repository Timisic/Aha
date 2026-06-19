#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";

const DEFAULTS = {
  cases: "bench/aha-memory-cases.json",
  report: "bench/reports/latest/pipeline-ablations.json",
  reportDir: "bench/reports/latest/pipeline-ablations",
  includeDraft: false,
  dryRun: false,
  passthrough: [],
};

const VARIANTS = [
  {
    id: "baseline",
    label: "multi-query + backlinks on + fair seeds + source-note filter on + configured reranker",
    args: [],
  },
  {
    id: "raw-only",
    label: "raw query only vs multi-query",
    args: ["--query-mode", "raw-only"],
  },
  {
    id: "backlinks-off",
    label: "backlinks off vs on",
    args: ["--no-backlinks"],
  },
  {
    id: "reranker-none",
    label: "no agent reranker vs configured reranker",
    args: ["--reranker", "none"],
  },
  {
    id: "first-10-seeds",
    label: "first-10 backlink seeds vs fair seeds",
    args: ["--seed-strategy", "first"],
  },
  {
    id: "source-note-filter-off",
    label: "source-note filter off vs on",
    args: ["--no-source-note-filter"],
  },
];

function usage() {
  return [
    "Usage:",
    "  node scripts/bench/run-pipeline-ablations.mjs [options] [-- <pipeline bench options>]",
    "",
    "Options:",
    "  --cases <path>       Default: bench/aha-memory-cases.json",
    "  --report <path>      Default: bench/reports/latest/pipeline-ablations.json",
    "  --report-dir <path>  Default: bench/reports/latest/pipeline-ablations",
    "  --include-draft      Include draft cases",
    "  --dry-run            Write the plan without running child reports",
  ].join("\n");
}

function parseArgs() {
  const options = { ...DEFAULTS };
  const args = process.argv.slice(2);
  const passthroughIndex = args.indexOf("--");
  const ownArgs = passthroughIndex >= 0 ? args.slice(0, passthroughIndex) : args;
  options.passthrough = passthroughIndex >= 0 ? args.slice(passthroughIndex + 1) : [];

  for (let index = 0; index < ownArgs.length; index += 1) {
    const arg = ownArgs[index];
    if (arg === "--include-draft") {
      options.includeDraft = true;
      continue;
    }
    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (!arg.startsWith("--")) {
      console.error(usage());
      process.exit(1);
    }

    const value = ownArgs[index + 1];
    if (!value || value.startsWith("--")) {
      console.error(usage());
      process.exit(1);
    }
    index += 1;

    switch (arg) {
      case "--cases":
        options.cases = value;
        break;
      case "--report":
        options.report = value;
        break;
      case "--report-dir":
        options.reportDir = value;
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }

  return options;
}

function timestampForPath() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function archiveReportPath(reportPath) {
  return resolve("bench/reports/archive", `${basename(reportPath, ".json")}-${timestampForPath()}.json`);
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(resolve(path), "utf-8"));
  } catch {
    return null;
  }
}

function pipelineArgsForVariant(options, variant) {
  return [
    "scripts/bench/run-pipeline-bench.mjs",
    "--cases",
    options.cases,
    "--report",
    `${options.reportDir}/${variant.id}.json`,
    ...(options.includeDraft ? ["--include-draft"] : []),
    ...options.passthrough,
    ...variant.args,
  ];
}

function runVariant(options, variant) {
  const reportPath = `${options.reportDir}/${variant.id}.json`;
  const args = pipelineArgsForVariant(options, variant);
  if (options.dryRun) {
    return {
      id: variant.id,
      label: variant.label,
      status: "planned",
      report: reportPath,
      args,
    };
  }

  const startedAt = Date.now();
  const result = spawnSync("node", args, {
    cwd: resolve("."),
    encoding: "utf-8",
    timeout: 30 * 60 * 1000,
    env: process.env,
  });
  const report = readJson(reportPath);
  return {
    id: variant.id,
    label: variant.label,
    status: result.status === 0 && report ? "passed" : "failed",
    report: reportPath,
    args,
    exit_code: result.status,
    error: result.error?.message ?? null,
    stderr_tail: String(result.stderr ?? "").trim().slice(-2000),
    stdout_tail: String(result.stdout ?? "").trim().slice(-2000),
    latency_ms: Date.now() - startedAt,
    summary: report?.summary ?? null,
    diagnostics: report?.diagnostics ?? null,
  };
}

function printSummary(report) {
  console.log("# Aha Pipeline Ablation Summary");
  console.log("");
  console.log(`Report: ${report.report}`);
  console.log(`Cases: ${report.cases}`);
  console.log("");
  console.log("| Variant | Status | Pipeline R@K | Expanded pool R | Dropped top-K | Fallbacks | Timeouts |");
  console.log("|---|---|---:|---:|---:|---:|---:|");
  for (const variant of report.variants) {
    const summary = variant.summary ?? {};
    const diagnostics = variant.diagnostics ?? {};
    console.log(`| ${variant.id} | ${variant.status} | ${Number(summary.avg_pipeline_recall_at_k ?? 0).toFixed(3)} | ${Number(summary.avg_expanded_pool_recall ?? 0).toFixed(3)} | ${String(summary.expanded_pool_dropped_topk_count ?? "-")} | ${String(diagnostics.fallback_count ?? "-")} | ${String(diagnostics.timeout_count ?? "-")} |`);
  }
}

function main() {
  const options = parseArgs();
  mkdirSync(resolve(options.reportDir), { recursive: true });

  const variants = VARIANTS.map((variant) => runVariant(options, variant));
  const report = {
    timestamp: new Date().toISOString(),
    report: options.report,
    cases: options.cases,
    report_dir: options.reportDir,
    dry_run: options.dryRun,
    passthrough: options.passthrough,
    variants,
  };

  mkdirSync(dirname(resolve(options.report)), { recursive: true });
  writeFileSync(resolve(options.report), `${JSON.stringify(report, null, 2)}\n`);
  const archivePath = archiveReportPath(options.report);
  mkdirSync(dirname(archivePath), { recursive: true });
  writeFileSync(archivePath, `${JSON.stringify(report, null, 2)}\n`);
  printSummary(report);

  if (!options.dryRun && variants.some((variant) => variant.status !== "passed")) {
    process.exit(1);
  }
}

main();
