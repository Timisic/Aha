#!/usr/bin/env node
import { dirname, resolve } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { parseLineRange, readNoteExcerpt } from "../lib/note-excerpt.mjs";
import { benchVaultRoot } from "../lib/vault-paths.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function usage() {
  return [
    "Usage:",
    "  node scripts/bench/extract-note-excerpt.mjs --note <path> --lines <start:end> [--vault-root <path>] [--json]",
    "  node scripts/bench/extract-note-excerpt.mjs --case <id> [--cases bench/aha-memory-cases.json] [--vault-root <path>] [--full-input] [--json]",
    "",
    "Safety:",
    "  When a note path is used, line ranges are required unless --allow-full-note is explicit.",
    "  Line numbers are 1-based and inclusive.",
  ].join("\n");
}

function parseArgs(argv) {
  const options = {
    cases: "bench/aha-memory-cases.json",
    vaultRoot: benchVaultRoot(),
    json: false,
    fullInput: false,
    allowFullNote: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];
    switch (arg) {
      case "--note":
        options.note = value;
        index += 1;
        break;
      case "--lines":
        options.lines = value;
        index += 1;
        break;
      case "--case":
        options.caseId = value;
        index += 1;
        break;
      case "--cases":
        options.cases = value;
        index += 1;
        break;
      case "--vault-root":
        options.vaultRoot = value;
        index += 1;
        break;
      case "--json":
        options.json = true;
        break;
      case "--full-input":
        options.fullInput = true;
        break;
      case "--allow-full-note":
        options.allowFullNote = true;
        break;
      case "--help":
      case "-h":
        console.log(usage());
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown argument: ${arg}\n\n${usage()}`);
    }
  }
  return options;
}

function caseInput(caseItem) {
  const input = caseItem.input && typeof caseItem.input === "object" ? caseItem.input : {};
  const note = input.note ?? caseItem.source_note_path;
  const lineRange = input.lines ?? (
    caseItem.source_note_start_line || caseItem.source_note_end_line
      ? [caseItem.source_note_start_line, caseItem.source_note_end_line]
      : undefined
  );
  const thought = input.thought ?? caseItem.insight_thought ?? (!note ? caseItem.insight_input : "");
  const wholeNote = input.whole_note === true || caseItem.allow_full_note === true;
  return { note, lineRange, thought, wholeNote };
}

function loadCase(options) {
  const casesPath = resolve(repoRoot, options.cases);
  const document = JSON.parse(readFileSync(casesPath, "utf-8"));
  const cases = Array.isArray(document.cases) ? document.cases : [];
  const found = cases.find((item) => item.id === options.caseId);
  if (!found) {
    throw new Error(`Case ${options.caseId} not found in ${options.cases}.`);
  }
  return { caseItem: found, casesDir: dirname(casesPath) };
}

function rangeFromOptions(options, lineRange) {
  if (options.lines) return parseLineRange(options.lines);
  if (lineRange !== undefined) return parseLineRange(lineRange);
  if (options.allowFullNote) return {};
  throw new Error("A line range is required for note extraction. Pass --lines START:END, set input.lines/source_note_*_line, or explicitly set input.whole_note: true on the case.");
}

function emit(result, options) {
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  process.stdout.write(result.text);
  if (!result.text.endsWith("\n")) process.stdout.write("\n");
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  let note = options.note;
  let thought = "";
  let lineRange = options.lines;
  let casesDir = repoRoot;
  let caseId = null;
  let wholeNote = false;

  if (options.caseId) {
    const loaded = loadCase(options);
    const input = caseInput(loaded.caseItem);
    note = input.note;
    thought = String(input.thought ?? "");
    lineRange = input.lineRange;
    casesDir = loaded.casesDir;
    caseId = loaded.caseItem.id;
    wholeNote = input.wholeNote;
  }

  if (!note) {
    if (!thought.trim()) throw new Error("Provide --note, --case with input.note, or a case with standalone input.thought.");
    emit({
      case_id: caseId,
      source: "thought",
      text: thought.trim(),
    }, options);
    return;
  }

  const range = rangeFromOptions({ ...options, allowFullNote: options.allowFullNote || wholeNote }, lineRange);
  const excerpt = readNoteExcerpt(note, range, {
    casesDir,
    vaultRoot: options.vaultRoot,
  });
  const parts = [excerpt.excerpt.trim()];
  if (options.fullInput && thought.trim()) {
    parts.push("", "Fresh thought:", thought.trim());
  }
  emit({
    case_id: caseId,
    source: "note",
    note,
    resolved_path: excerpt.path,
    lines: range.start && range.end ? [range.start, range.end] : null,
    whole_note: !range.start && !range.end,
    text: parts.join("\n"),
  }, options);
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
