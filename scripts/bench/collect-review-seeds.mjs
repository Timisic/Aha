#!/usr/bin/env node
import { existsSync } from "node:fs";
import { resolve } from "node:path";

import {
  DEFAULT_PLUGIN_ID,
  DEFAULT_REVIEW_FOLDER,
  DEFAULT_SEED_CASES_PATH,
  collectReviewSeedCasesFromVault,
  collectSessionFeedbackSeedCases,
  writeReviewSeedCaseDocument,
} from "../lib/review-seeds.mjs";

function usage() {
  return [
    "Usage:",
    "  node scripts/bench/collect-review-seeds.mjs [options]",
    "",
    "Options:",
    `  --vault-root <path>       Obsidian vault root. Default: $AHA_BENCH_VAULT_ROOT or ~/Obsidian Notes`,
    `  --plugin-data <path>      Aha plugin data.json. Default: <vault>/.obsidian/plugins/${DEFAULT_PLUGIN_ID}/data.json`,
    "  --legacy-review-notes    Explicitly import legacy Review Note Markdown instead of Session Store feedback.",
    `  --review-folder <path>    Legacy Review Note folder. Requires --legacy-review-notes. Default: ${DEFAULT_REVIEW_FOLDER}`,
    `  --output <path>           Ignored private seed case file. Default: ${DEFAULT_SEED_CASES_PATH}`,
    "  --allow-empty             Allow an empty Session Store collection to replace an existing output file.",
    "  --dry-run                 Print JSON to stdout instead of writing the output file.",
    "  -h, --help                Show this help.",
    "",
    "By default, feedback is collected from compact Aha Session Records in plugin data.",
    "The output is benchmark-like draft case JSON with vault-relative note paths.",
    "It does not modify bench/aha-memory-cases.json.",
  ].join("\n");
}

function parseArgs(argv) {
  const options = {
    output: DEFAULT_SEED_CASES_PATH,
    dryRun: false,
    allowEmpty: false,
    legacyReviewNotes: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "-h" || arg === "--help") {
      options.help = true;
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--allow-empty") {
      options.allowEmpty = true;
    } else if (arg === "--vault-root") {
      options.vaultRoot = requireValue(argv, ++index, arg);
    } else if (arg === "--plugin-data") {
      options.pluginDataPath = requireValue(argv, ++index, arg);
    } else if (arg === "--legacy-review-notes") {
      options.legacyReviewNotes = true;
    } else if (arg === "--review-folder") {
      options.reviewFolder = requireValue(argv, ++index, arg);
    } else if (arg === "--output") {
      options.output = requireValue(argv, ++index, arg);
    } else {
      throw new Error(`Unknown argument: ${arg}\n\n${usage()}`);
    }
  }
  if (options.reviewFolder && !options.legacyReviewNotes) {
    throw new Error("--review-folder requires --legacy-review-notes.");
  }
  if (options.pluginDataPath && options.legacyReviewNotes) {
    throw new Error("--plugin-data cannot be combined with --legacy-review-notes.");
  }
  return options;
}

function requireValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value.`);
  return value;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }

  const result = options.legacyReviewNotes
    ? collectReviewSeedCasesFromVault(options)
    : collectSessionFeedbackSeedCases(options);
  const document = {
    _说明: result._说明,
    description: result.description,
    version: result.version,
    collection: result.collection,
    suites: result.suites,
    expected_in_top_k: result.expected_in_top_k,
    nice_expected_in_top_k: result.nice_expected_in_top_k,
    expanded_pool_expected_in_top_k: result.expanded_pool_expected_in_top_k,
    generated_at: result.generated_at,
    source: result.source,
    review_seed_policy: result.review_seed_policy,
    cases: result.cases,
    warnings: result.warnings,
  };

  if (options.dryRun) {
    console.log(JSON.stringify(document, null, 2));
    return;
  }

  if (
    !options.legacyReviewNotes
    && result.feedbackEventCount === 0
    && existsSync(resolve(options.output))
    && !options.allowEmpty
  ) {
    throw new Error(
      `Refusing to replace ${resolve(options.output)} because collection yielded zero supported Session Store feedback events. `
      + "Inspect the diagnosed empty result with --dry-run, or pass --allow-empty to replace the existing output intentionally.",
    );
  }

  const output = writeReviewSeedCaseDocument(document, options.output);
  if (options.legacyReviewNotes) {
    console.log(`Scanned ${result.reviewNoteCount} legacy Review Notes from ${result.reviewRoot}`);
  } else {
    console.log(`Collected ${result.feedbackEventCount} Session Store feedback event${result.feedbackEventCount === 1 ? "" : "s"} from ${result.pluginDataPath}`);
  }
  console.log(`Wrote ${document.cases.length} draft seed case${document.cases.length === 1 ? "" : "s"} to ${output}`);
  if (document.warnings?.length) {
    console.warn(`Warnings: ${document.warnings.length}`);
    for (const warning of document.warnings) console.warn(`- ${warning}`);
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
