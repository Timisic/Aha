import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

export function parseLineRange(value) {
  if (Array.isArray(value)) {
    return normalizeLineRange(value[0], value[1]);
  }
  const raw = String(value ?? "").trim();
  if (!raw) return { start: undefined, end: undefined };
  const match = raw.match(/^(\d+)(?::|-|,)(\d+)$/);
  if (!match) {
    throw new Error(`Line range must be START:END, got ${JSON.stringify(raw)}.`);
  }
  return normalizeLineRange(Number(match[1]), Number(match[2]));
}

export function normalizeLineRange(startValue, endValue) {
  const start = Number(startValue);
  const end = Number(endValue);
  if (!Number.isInteger(start) || start < 1) {
    throw new Error(`Line range start must be a positive integer, got ${JSON.stringify(startValue)}.`);
  }
  if (!Number.isInteger(end) || end < start) {
    throw new Error(`Line range end must be an integer >= start, got ${JSON.stringify(endValue)}.`);
  }
  return { start, end };
}

export function sliceLineRange(content, range = {}) {
  const hasStart = range.start !== undefined && range.start !== null && range.start !== "";
  const hasEnd = range.end !== undefined && range.end !== null && range.end !== "";
  if (!hasStart && !hasEnd) return content;
  const { start, end } = normalizeLineRange(hasStart ? range.start : 1, hasEnd ? range.end : lineCount(content));
  const lines = content.split(/\r?\n/);
  return lines.slice(start - 1, Math.min(lines.length, end)).join("\n");
}

export function lineCount(content) {
  if (!content) return 0;
  return content.split(/\r?\n/).length;
}

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
