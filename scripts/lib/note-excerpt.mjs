import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { sliceLineRange } from "./core-artifact.mjs";

// parseLineRange / normalizeLineRange / sliceLineRange / lineCount /
// excerptNoteMarkdown are pure and now live in
// obsidian-plugin/src/core/note-excerpt.ts (ADR 0005, issue #56); re-exported
// here so every existing consumer (scripts/lib/bench-cases.mjs,
// scripts/bench/run-pipeline-bench.mjs, the test suite) keeps working
// unchanged.
//
// resolveNotePath/readNoteExcerpt stay local: they do real file-system search
// across casesDir/vaultRoot candidates and a real read, and are consumed only
// by the standalone bench debug CLI scripts/bench/extract-note-excerpt.mjs,
// not by the deterministic retrieval path this issue re-points. Porting them
// to core would mean inventing an injected-vault-read seam with no real
// caller yet, so they were left as-is; they call the (now core-backed)
// sliceLineRange synchronously, same as before.
export {
  excerptNoteMarkdown,
  lineCount,
  normalizeLineRange,
  parseLineRange,
  sliceLineRange,
} from "./core-artifact.mjs";

export function resolveNotePath(notePath, options = {}) {
  const rawPath = expandHome(String(notePath ?? "").trim());
  if (!rawPath) {
    throw new Error("note path is required.");
  }
  const candidates = isAbsolute(rawPath)
    ? [rawPath]
    : [
        options.casesDir ? resolve(options.casesDir, rawPath) : "",
        options.vaultRoot ? resolve(expandHome(options.vaultRoot), rawPath) : "",
      ].filter(Boolean);

  const errors = [];
  for (const candidate of candidates) {
    try {
      readFileSync(candidate, "utf-8");
      return candidate;
    } catch (error) {
      errors.push(`${candidate}: ${error.message}`);
    }
  }
  throw new Error(`could not resolve note path ${notePath}. Tried:\n${errors.join("\n")}`);
}

export function readNoteExcerpt(notePath, range = {}, options = {}) {
  const resolvedPath = resolveNotePath(notePath, options);
  const content = readFileSync(resolvedPath, "utf-8");
  return {
    path: resolvedPath,
    start: range.start,
    end: range.end,
    excerpt: sliceLineRange(content, range),
  };
}

export function expandHome(value) {
  const raw = String(value ?? "");
  if (raw === "~") return process.env.HOME || raw;
  if (raw.startsWith("~/")) return resolve(process.env.HOME || "", raw.slice(2));
  return raw;
}
