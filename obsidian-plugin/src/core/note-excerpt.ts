// Line-range parsing/slicing and markdown-excerpt shaping shared between the
// plugin and bench (ADR 0005, issue #56). Ports the pure portion of
// scripts/lib/note-excerpt.mjs: parseLineRange, normalizeLineRange,
// sliceLineRange, lineCount, and excerptNoteMarkdown.
//
// scripts/lib/note-excerpt.mjs's resolveNotePath/readNoteExcerpt (the
// candidate-path search across casesDir/vaultRoot plus the actual fs read)
// intentionally stayed out of core: they are consumed only by the standalone
// bench debug CLI scripts/bench/extract-note-excerpt.mjs, not by the
// deterministic retrieval path this issue re-points (bench-cases.mjs and
// run-pipeline-bench.mjs only ever call the pure range/slice/excerpt
// functions below), so there is no injected-vault-read call site to port here
// yet. Porting them without a real caller would invent an untested seam.
//
// This module must stay free of `obsidian` imports, node imports, and
// module-level I/O.

export interface LineRange {
  start?: number;
  end?: number;
}

export function parseLineRange(value: unknown): LineRange {
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

export function normalizeLineRange(startValue: unknown, endValue: unknown): { start: number; end: number } {
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

export function sliceLineRange(content: string, range: LineRange = {}): string {
  const hasStart = range.start !== undefined && range.start !== null && (range.start as unknown) !== "";
  const hasEnd = range.end !== undefined && range.end !== null && (range.end as unknown) !== "";
  if (!hasStart && !hasEnd) return content;
  const { start, end } = normalizeLineRange(hasStart ? range.start : 1, hasEnd ? range.end : lineCount(content));
  const lines = content.split(/\r?\n/);
  return lines.slice(start - 1, Math.min(lines.length, end)).join("\n");
}

export function lineCount(content: string): number {
  if (!content) return 0;
  return content.split(/\r?\n/).length;
}

/** Returns true when the excerpt has substantive text beyond headings, transclusion links, and metadata. */
export function isSubstantiveExcerpt(excerpt: string, minChars = 30): boolean {
  const stripped = excerpt
    .split(/\r?\n/)
    .map((line) => line
      .replace(/!\[\[[^\]]*\]\]/g, "")
      .replace(/\[\[[^\]]*\]\]/g, "")
      .trim())
    .filter((line) => line && !line.startsWith("#") && !/^[-*]\s*$/.test(line) && !/^\d+\.\s*$/.test(line))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return stripped.length >= minChars;
}

/** Verbatim port of excerptNoteMarkdown: strips frontmatter, qmd get header,
 * line-number prefixes, and metadata lines, then bounds to 60 lines / 1800 chars. */
export function excerptNoteMarkdown(markdown: unknown): string {
  return String(markdown ?? "")
    .replace(/^qmd:\/\/[^\n]+\n(?:Folder Context:[^\n]*\n)?---\n?/m, "")
    .replace(/^---[\s\S]*?---\s*/m, "")
    .split(/\r?\n/)
    .map((line) => line.replace(/^\d+:\s?/, "").trimEnd())
    .filter((line) => line.trim() && !/^(create|cssclasses|tags|categories|emotion):\s*/.test(line.trim()))
    .slice(0, 120)
    .join("\n")
    .slice(0, 3600);
}
