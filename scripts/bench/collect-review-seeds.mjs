#!/usr/bin/env node
import {
  DEFAULT_REVIEW_FOLDER,
  DEFAULT_SEED_CASES_PATH,
  collectReviewSeedCasesFromVault,
  writeReviewSeedCaseDocument,
} from "../lib/aha-review-seeds.mjs";

function usage() {
  return [
    "Usage:",
    "  node scripts/bench/collect-review-seeds.mjs [options]",
    "",
    "Options:",
    `  --vault-root <path>       Obsidian vault root. Default: $AHA_BENCH_VAULT_ROOT or /path/to/vault`,
    `  --review-folder <path>    Review note folder inside the vault. Default: ${DEFAULT_REVIEW_FOLDER}`,
    `  --output <path>           Ignored private seed case file. Default: ${DEFAULT_SEED_CASES_PATH}`,
    "  --dry-run                 Print JSON to stdout instead of writing the output file.",
    "  -h, --help                Show this help.",
    "",
    "The output is benchmark-like draft case JSON with vault-relative note paths.",
    "It does not modify bench/aha-memory-cases.json.",
  ].join("\n");
}

function parseArgs(argv) {
  const options = {
    output: DEFAULT_SEED_CASES_PATH,
    reviewFolder: DEFAULT_REVIEW_FOLDER,
    dryRun: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "-h" || arg === "--help") {
      options.help = true;
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--vault-root") {
      options.vaultRoot = requireValue(argv, ++index, arg);
    } else if (arg === "--review-folder") {
      options.reviewFolder = requireValue(argv, ++index, arg);
    } else if (arg === "--output") {
      options.output = requireValue(argv, ++index, arg);
    } else {
      throw new Error(`Unknown argument: ${arg}\n\n${usage()}`);
    }
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

  const result = collectReviewSeedCasesFromVault(options);
  const document = {
    _说明: result._说明,
    description: result.description,
    version: result.version,
    collection: result.collection,
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

  const output = writeReviewSeedCaseDocument(document, options.output);
  console.log(`Scanned ${result.reviewNoteCount} review notes from ${result.reviewRoot}`);
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
