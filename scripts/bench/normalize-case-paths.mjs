#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { benchVaultRoot, normalizeVaultRelativePaths } from "../lib/vault-paths.mjs";

const DEFAULT_CASE_FILES = [
  "bench/aha-memory-cases.json",
  "bench/aha-memory-regression-cases.json",
  "bench/aha-memory-seed-cases.json",
];

function usage() {
  return [
    "Usage:",
    "  node scripts/bench/normalize-case-paths.mjs [case-file ...] [options]",
    "",
    "Options:",
    "  --vault-root <path>   Vault root to strip. Default: $AHA_BENCH_VAULT_ROOT or ~/Obsidian Notes",
    "  --check               Do not write; exit non-zero if files would change.",
    "  -h, --help            Show this help.",
    "",
    "If no case files are passed, existing local benchmark case files under bench/ are normalized.",
  ].join("\n");
}

function parseArgs(argv) {
  const options = {
    files: [],
    vaultRoot: benchVaultRoot(),
    check: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "-h" || arg === "--help") {
      options.help = true;
    } else if (arg === "--check") {
      options.check = true;
    } else if (arg === "--vault-root") {
      const value = argv[++index];
      if (!value || value.startsWith("--")) throw new Error("--vault-root requires a value.");
      options.vaultRoot = value;
    } else if (arg.startsWith("--")) {
      throw new Error(`Unknown option: ${arg}\n\n${usage()}`);
    } else {
      options.files.push(arg);
    }
  }
  if (options.files.length === 0) {
    options.files = DEFAULT_CASE_FILES.filter((file) => existsSync(resolve(file)));
  }
  return options;
}

function normalizeFile(file, options) {
  const resolved = resolve(file);
  const before = readFileSync(resolved, "utf-8");
  const parsed = JSON.parse(before);
  const normalized = normalizeVaultRelativePaths(parsed, { vaultRoot: options.vaultRoot });
  const after = `${JSON.stringify(normalized, null, 2)}\n`;
  const changed = before !== after;
  if (changed && !options.check) writeFileSync(resolved, after);
  return { file, changed };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  if (options.files.length === 0) {
    console.log("No existing benchmark case files found.");
    return;
  }

  let changedCount = 0;
  for (const file of options.files) {
    const result = normalizeFile(file, options);
    if (result.changed) changedCount += 1;
    console.log(`${result.changed ? "normalized" : "unchanged"}: ${result.file}`);
  }
  if (options.check && changedCount > 0) {
    throw new Error(`${changedCount} file${changedCount === 1 ? "" : "s"} contain vault-absolute paths.`);
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
