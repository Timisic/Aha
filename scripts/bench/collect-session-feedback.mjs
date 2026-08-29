#!/usr/bin/env node
// Collects Review Panel accept / reject_as_noise / should_have_found
// feedback out of a plugin's data.json Session Store and writes it as draft
// benchmark seed cases -- the successor to the removed
// scripts/bench/collect-review-seeds.mjs (see bench/README.md's "Review
// Feedback Actions" section). Never touches bench/aha-memory-cases.json:
// output is always a separate draft file for a human to inspect and promote
// entries out of by hand.
//
// Usage:
//   node scripts/bench/collect-session-feedback.mjs \
//     --plugin-id aha-memory-surface-dev \
//     --output bench/aha-memory-seed-cases.json

import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { dataJsonPathFor } from "../dev/run-batch-vault.mjs";
import { normalizeSessionStore } from "../lib/session-artifact.mjs";
import {
  DEFAULT_SESSION_FEEDBACK_CASES_PATH,
  collectSessionFeedbackCasesFromSessionStore,
  writeSessionFeedbackCaseDocument,
} from "../lib/session-feedback-cases.mjs";
import { benchVaultRoot, expandHome } from "../lib/vault-paths.mjs";

const DEFAULTS = {
  pluginId: "aha-memory-surface-dev",
  output: DEFAULT_SESSION_FEEDBACK_CASES_PATH,
  dryRun: false,
};

function usage() {
  return [
    "Usage:",
    "  node scripts/bench/collect-session-feedback.mjs [options]",
    "",
    "Options:",
    "  --vault-root <path>   Default: $AHA_BENCH_VAULT_ROOT or ~/Obsidian Notes",
    "  --plugin-id <id>      Default: aha-memory-surface-dev (pass aha-memory-surface for production)",
    "  --data-json <path>    Read this data.json directly, overriding --vault-root/--plugin-id",
    `  --output <path>       Default: ${DEFAULT_SESSION_FEEDBACK_CASES_PATH}`,
    "  --collection <name>   Default: obsidian",
    "  --dry-run             Print the generated document to stdout instead of writing it",
    "  -h, --help            Show this help",
    "",
    "Reads sessionStore.records[*].feedback (accept/reject_as_noise/should_have_found)",
    "and writes one draft benchmark case per source note with feedback. It never",
    "modifies bench/aha-memory-cases.json -- inspect the output, especially",
    "should_have_found gold.must paths, before promoting entries by hand.",
  ].join("\n");
}

export function parseArgs(argv) {
  const options = { ...DEFAULTS };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "-h" || arg === "--help") {
      options.help = true;
      continue;
    }
    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for ${arg}`);
    }
    index += 1;
    switch (arg) {
      case "--vault-root":
        options.vaultRoot = value;
        break;
      case "--plugin-id":
        options.pluginId = value;
        break;
      case "--data-json":
        options.dataJson = value;
        break;
      case "--output":
        options.output = value;
        break;
      case "--collection":
        options.collection = value;
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }
  return options;
}

// Session Store records a note's path as of its last Aha run; if the note
// was moved/renamed afterward without re-running Aha, `record.source.path`
// (and therefore `case.input.note`) is stale even though the record's
// filesystem identity is still correct (see source-identity.ts's `srcfs:`
// path-drift tolerance). This can't be auto-corrected here -- a same-name
// file could exist in more than one place -- so it only ever surfaces as a
// warning for a human to fix before promoting.
export async function warnOnMissingNotes(document, vaultRoot) {
  const checks = [];
  for (const caseItem of document.cases) {
    if (caseItem.input?.note) checks.push({ label: `${caseItem.id}: input.note`, notePath: caseItem.input.note });
    for (const goldKey of ["must", "nice", "noise"]) {
      for (const notePath of caseItem.gold?.[goldKey] ?? []) {
        checks.push({ label: `${caseItem.id}: gold.${goldKey}`, notePath });
      }
    }
  }

  const missing = [];
  await Promise.all(checks.map(async ({ label, notePath }) => {
    try {
      await access(path.resolve(vaultRoot, notePath));
    } catch {
      missing.push(`${label} not found in vault at "${notePath}" -- note may have moved/renamed since this feedback was recorded.`);
    }
  }));

  if (missing.length > 0) {
    document.warnings = [...(document.warnings ?? []), ...missing];
  }
}

export async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }

  const vaultRoot = path.resolve(expandHome(options.vaultRoot || benchVaultRoot()));
  const dataJsonPath = options.dataJson
    ? path.resolve(expandHome(options.dataJson))
    : dataJsonPathFor(vaultRoot, options.pluginId);

  const raw = await readFile(dataJsonPath, "utf-8");
  const data = JSON.parse(raw);
  const store = normalizeSessionStore(data.sessionStore);
  const recordCount = Object.keys(store.records).length;

  const document = collectSessionFeedbackCasesFromSessionStore(store, {
    vaultRoot,
    collection: options.collection,
  });
  await warnOnMissingNotes(document, vaultRoot);

  if (options.dryRun) {
    console.log(JSON.stringify(document, null, 2));
    return;
  }

  const output = writeSessionFeedbackCaseDocument(document, options.output);
  console.log(`Read ${dataJsonPath}`);
  console.log(`Scanned ${recordCount} Session Store record${recordCount === 1 ? "" : "s"}.`);
  console.log(`Wrote ${document.cases.length} draft seed case${document.cases.length === 1 ? "" : "s"} to ${output}`);
  if (document.warnings?.length) {
    console.warn(`Warnings: ${document.warnings.length}`);
    for (const warning of document.warnings) console.warn(`- ${warning}`);
  }
}

const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(`\n${usage()}`);
    process.exit(1);
  }
}
