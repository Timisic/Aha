#!/usr/bin/env node

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  qmdExpectedPath,
  readBenchmarkCases,
  resolveQmdQueryForCase,
} from "../lib/aha-bench-common.mjs";

const USAGE = [
  "Usage:",
  "  node scripts/bench/build-fixture.mjs <cases.json> <fixture.json> [options]",
  "",
  "Options:",
  "  --include-draft",
  "  --query-generator <agent|rules>        Default: agent",
  "  --query-agent-bin <bin>                Default: codex",
  "  --query-agent-model <model>",
  "  --query-agent-cache <path>             Default: bench/generated/qmd-query-agent-cache.json",
  "  --no-query-agent-cache",
  "  --no-query-agent-fallback",
  "  --query-agent-timeout-ms <n>           Default: 120000",
  "",
  "Active cases are converted into a qmd bench fixture.",
].join("\n");

function parseArgs() {
  const options = {
    includeDraft: false,
    queryGenerator: undefined,
    queryAgentBin: undefined,
    queryAgentModel: undefined,
    queryAgentCache: undefined,
    queryAgentFallback: undefined,
    queryAgentTimeoutMs: undefined,
  };
  const positional = [];
  const args = process.argv.slice(2);

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--include-draft") {
      options.includeDraft = true;
      continue;
    }
    if (arg === "--no-query-agent-cache") {
      options.queryAgentCache = "";
      continue;
    }
    if (arg === "--no-query-agent-fallback") {
      options.queryAgentFallback = false;
      continue;
    }
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }

    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      console.error(USAGE);
      process.exit(1);
    }
    index += 1;

    switch (arg) {
      case "--query-generator":
        options.queryGenerator = value;
        break;
      case "--query-agent-bin":
        options.queryAgentBin = value;
        break;
      case "--query-agent-model":
        options.queryAgentModel = value;
        break;
      case "--query-agent-cache":
        options.queryAgentCache = value;
        break;
      case "--query-agent-timeout-ms":
        options.queryAgentTimeoutMs = Number(value);
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (positional.length !== 2) {
    console.error(USAGE);
    process.exit(1);
  }

  return {
    inputPath: positional[0],
    outputPath: positional[1],
    options,
  };
}

function main() {
  const { inputPath, outputPath, options } = parseArgs();
  const { input, cases, collection, expectedInTopK, expectedNiceInTopK } = readBenchmarkCases(inputPath, {
    includeDraft: options.includeDraft,
  });
  const fixture = {
    description: input.description || "Aha Memory Candidate Recall Benchmark",
    version: input.version ?? 1,
    collection,
    queries: cases.map((caseItem) => {
      const generatedQuery = resolveQmdQueryForCase(caseItem, options);
      return {
        id: caseItem.id,
        query: generatedQuery.query,
        query_object: generatedQuery.query_object,
        query_generated_by: generatedQuery.query_generated_by,
        query_generation_fallback: generatedQuery.query_generation_fallback,
        query_generation_error: generatedQuery.query_generation_error,
        type: caseItem.type || "semantic",
        description: caseItem.description || caseItem.annotation_note || caseItem.id,
        expected_files: caseItem.must_recall.map(qmdExpectedPath),
        expected_in_top_k: Math.max(
          Number(caseItem.expected_in_top_k ?? expectedInTopK),
          Number(caseItem.nice_expected_in_top_k ?? expectedNiceInTopK),
        ),
        must_expected_in_top_k: Number(caseItem.expected_in_top_k ?? expectedInTopK),
        nice_expected_in_top_k: Number(caseItem.nice_expected_in_top_k ?? expectedNiceInTopK),
      };
    }),
  };

  mkdirSync(dirname(resolve(outputPath)), { recursive: true });
  writeFileSync(resolve(outputPath), `${JSON.stringify(fixture, null, 2)}\n`);
  console.log(`Wrote ${fixture.queries.length} active benchmark queries to ${outputPath}`);
}

main();
