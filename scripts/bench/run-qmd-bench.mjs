#!/usr/bin/env node

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
  applyBenchEvaluationPolicy,
  sourceNotePathForCase,
} from "../lib/aha-bench-common.mjs";

function parseArgs() {
  const defaults = {
    cases: "bench/aha-memory-cases.json",
    fixture: "bench/generated/qmd-fixture.json",
    report: "bench/reports/latest/qmd.json",
    index: "obsidian",
    qmd: "qmd",
    queryGenerator: "agent",
    queryAgentBin: "codex",
    queryAgentModel: "",
    queryAgentCache: "bench/generated/qmd-query-agent-cache.json",
    queryAgentFallback: true,
    queryAgentTimeoutMs: 120_000,
  };
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i += 1) {
    const key = args[i];
    if (key === "--no-query-agent-cache") {
      defaults.queryAgentCache = "";
      continue;
    }
    if (key === "--no-query-agent-fallback") {
      defaults.queryAgentFallback = false;
      continue;
    }
    const value = args[i + 1];
    if (!key?.startsWith("--") || !value || value.startsWith("--")) {
      console.error("Usage: node scripts/bench/run-qmd-bench.mjs [--cases path] [--fixture path] [--report path] [--index obsidian] [--qmd qmd] [--query-generator agent|rules]");
      process.exit(1);
    }
    i += 1;
    const name = key.slice(2);
    switch (name) {
      case "query-generator":
        defaults.queryGenerator = value;
        break;
      case "query-agent-bin":
        defaults.queryAgentBin = value;
        break;
      case "query-agent-model":
        defaults.queryAgentModel = value;
        break;
      case "query-agent-cache":
        defaults.queryAgentCache = value;
        break;
      case "query-agent-timeout-ms":
        defaults.queryAgentTimeoutMs = Number(value);
        break;
      default:
        if (!(name in defaults)) {
          throw new Error(`Unknown option: ${key}`);
        }
        defaults[name] = value;
    }
  }
  return defaults;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: resolve("."),
    encoding: "utf-8",
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status}`);
  }
  return result;
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function caseConfigById(casesPath) {
  const input = JSON.parse(readFileSync(resolve(casesPath), "utf-8"));
  const defaultTopK = Number(input.expected_in_top_k ?? 10);
  const defaultNiceTopK = Number(input.nice_expected_in_top_k ?? 20);
  return new Map(
    (input.cases ?? [])
      .filter((caseItem) => String(caseItem.status ?? "active").toLowerCase() === "active")
      .map((caseItem) => [
        caseItem.id,
        {
          topK: Number(caseItem.expected_in_top_k ?? defaultTopK),
          niceTopK: Number(caseItem.nice_expected_in_top_k ?? defaultNiceTopK),
          niceToHave: Array.isArray(caseItem.nice_to_have) ? caseItem.nice_to_have : [],
          sourceNotePath: sourceNotePathForCase(caseItem),
        },
      ]),
  );
}

function fixtureConfig(fixturePath, casesPath) {
  const fixture = JSON.parse(readFileSync(resolve(fixturePath), "utf-8"));
  const values = (fixture.queries ?? [])
    .map((query) => Number(query.expected_in_top_k))
    .filter((value) => Number.isFinite(value) && value > 0);
  const expectedById = new Map(
    (fixture.queries ?? []).map((query) => [query.id, Array.isArray(query.expected_files) ? query.expected_files : []]),
  );
  const queryMetaById = new Map(
    (fixture.queries ?? []).map((query) => [
      query.id,
      {
        query_object: query.query_object,
        query_generated_by: query.query_generated_by,
        query_generation_fallback: query.query_generation_fallback,
        query_generation_error: query.query_generation_error,
      },
    ]),
  );
  return {
    retrievalTopK: values[0] || 20,
    expectedById,
    queryMetaById,
    caseById: caseConfigById(casesPath),
  };
}

function normalizeBenchJson(stdout, config) {
  const report = JSON.parse(stdout);
  return `${JSON.stringify(applyBenchEvaluationPolicy(report, config), null, 2)}\n`;
}

function main() {
  const options = parseArgs();
  const fixtureArgs = [
    "scripts/bench/build-fixture.mjs",
    options.cases,
    options.fixture,
    "--query-generator",
    options.queryGenerator,
    "--query-agent-bin",
    options.queryAgentBin,
    "--query-agent-timeout-ms",
    String(options.queryAgentTimeoutMs),
  ];
  if (options.queryAgentModel) {
    fixtureArgs.push("--query-agent-model", options.queryAgentModel);
  }
  if (options.queryAgentCache) {
    fixtureArgs.push("--query-agent-cache", options.queryAgentCache);
  } else {
    fixtureArgs.push("--no-query-agent-cache");
  }
  if (!options.queryAgentFallback) {
    fixtureArgs.push("--no-query-agent-fallback");
  }
  run("node", fixtureArgs, {
    stdio: "inherit",
  });

  const bench = run(options.qmd, ["--index", options.index, "bench", options.fixture, "--json"]);
  const reportJson = normalizeBenchJson(bench.stdout, fixtureConfig(options.fixture, options.cases));
  mkdirSync(dirname(resolve(options.report)), { recursive: true });
  writeFileSync(resolve(options.report), reportJson);

  const stampedReport = resolve("bench/reports/archive", `qmd-${timestamp()}.json`);
  mkdirSync(dirname(stampedReport), { recursive: true });
  writeFileSync(stampedReport, reportJson);

  run("node", ["scripts/bench/summarize-report.mjs", options.report], {
    stdio: "inherit",
  });
}

main();
