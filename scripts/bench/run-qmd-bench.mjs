#!/usr/bin/env node

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
  applyBenchEvaluationPolicy,
  readBenchmarkCases,
  sourceNotePathForCase,
} from "../lib/bench-cases.mjs";

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
    suite: "all",
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
      console.error("Usage: node scripts/bench/run-qmd-bench.mjs [--cases path] [--fixture path] [--report path] [--suite development|holdout|all] [--index obsidian] [--qmd qmd] [--query-generator agent|rules]");
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
  if (!["development", "holdout", "all"].includes(defaults.suite)) {
    throw new Error("--suite must be development, holdout, or all.");
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

function caseConfigById(casesPath, suite = "all") {
  const benchmark = readBenchmarkCases(casesPath);
  const cases = suite === "all"
    ? benchmark.cases
    : benchmark.cases.filter((caseItem) => caseItem.suite === suite);
  return {
    identityResolver: benchmark.identityResolver,
    suiteEvaluation: benchmark.suiteEvaluation,
    suiteVersions: benchmark.suiteVersions,
    caseById: new Map(
      cases.map((caseItem) => {
        const identityEvaluation = caseItem.identity_evaluation;
        return [
          caseItem.id,
          {
            topK: Number(caseItem.expected_in_top_k ?? benchmark.expectedInTopK),
            niceTopK: Number(caseItem.nice_expected_in_top_k ?? benchmark.expectedNiceInTopK),
            expectedFiles: identityEvaluation.gold.must,
            niceToHave: identityEvaluation.gold.nice,
            negative: identityEvaluation.gold.noise,
            sourceNotePath: sourceNotePathForCase(caseItem),
            identityEvaluation,
            suite: caseItem.suite ?? null,
            suiteVersion: caseItem._suite_version ?? null,
            evaluationMode: caseItem.evaluation_mode ?? null,
            suiteEvaluation: caseItem.suite_evaluation,
          },
        ];
      }),
    ),
  };
}

function fixtureConfig(fixturePath, casesPath, suite = "all") {
  const fixture = JSON.parse(readFileSync(resolve(fixturePath), "utf-8"));
  const caseConfig = caseConfigById(casesPath, suite);
  const values = (fixture.queries ?? [])
    .map((query) => Number(query.expected_in_top_k))
    .filter((value) => Number.isFinite(value) && value > 0);
  const expectedById = new Map(
    Array.from(caseConfig.caseById, ([id, config]) => [id, config.expectedFiles]),
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
    caseById: caseConfig.caseById,
    identityResolver: caseConfig.identityResolver,
    suiteEvaluation: caseConfig.suiteEvaluation,
    suiteVersions: caseConfig.suiteVersions,
  };
}

function normalizeBenchJson(stdout, config, suite) {
  const report = JSON.parse(stdout);
  const evaluated = applyBenchEvaluationPolicy(report, config);
  evaluated.suite = suite === "all"
    ? { kind: "all", versions: config.suiteVersions }
    : { kind: suite, version: config.suiteVersions?.[suite] ?? null };
  evaluated.suite_validation = {
    status: config.suiteEvaluation.status,
    suite_versions: config.suiteVersions,
  };
  return `${JSON.stringify(evaluated, null, 2)}\n`;
}

function main() {
  const options = parseArgs();
  const fixtureArgs = [
    "scripts/bench/build-fixture.mjs",
    options.cases,
    options.fixture,
    "--suite",
    options.suite,
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
  const reportJson = normalizeBenchJson(bench.stdout, fixtureConfig(options.fixture, options.cases, options.suite), options.suite);
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
