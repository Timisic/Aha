import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { sliceLineRange } from "./core-artifact.mjs";

// resolveNotePath/readNoteExcerpt do real file-system search across
// casesDir/vaultRoot candidates and a real read; consumed only by the
// standalone bench debug CLI scripts/bench/extract-note-excerpt.mjs, not by
// the deterministic retrieval path (ADR 0005, issue #56). Porting them to
// core would mean inventing an injected-vault-read seam with no real caller
// yet, so they stay local, calling the core-backed sliceLineRange directly
// from core-artifact.mjs.
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
