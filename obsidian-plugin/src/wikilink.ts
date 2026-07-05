// Shared wikilink parsing used by main, review-note, and review-panel.

export interface ParsedWikiLink {
  path: string;
  title?: string;
}

const WIKI_LINK_PATTERN = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/;

export function parseWikiLink(value: string): ParsedWikiLink | null {
  const match = value.match(WIKI_LINK_PATTERN);
  if (!match) return null;
  const target = match[1].replace(/\\\|/g, "|").trim();
  const alias = match[2]?.replace(/\\\|/g, "|").trim();
  return {
    path: ensureMarkdownExtension(target),
    title: alias || stripMarkdownExtension(lastPathSegment(target)),
  };
}

export function firstWikiLinkTarget(line: string): string | null {
  const match = line.match(WIKI_LINK_PATTERN);
  return match?.[1] ?? null;
}

// "[[Note#h|alias]]" or a bare path → the note path without alias or #^ suffix.
export function linkTargetBase(value: string): string {
  const target = value.replace(/^\[\[|\]\]$/g, "").split("|")[0];
  return target.match(/^([^#^]+)/)?.[1]?.trim() || target.trim();
}

export function markdownFilePathForLink(value: string): string {
  const base = linkTargetBase(value) || value.trim();
  return /\.md$/i.test(base) ? base : `${base}.md`;
}

export function noteDisplayTitleFromPath(path: string): string {
  const target = path.replace(/^\[\[|\]\]$/g, "").split("|")[0].trim();
  const base = target.match(/^([^#^]+)/)?.[1]?.trim() || target;
  return stripMarkdownExtension(lastPathSegment(base)) || target;
}

export function ensureMarkdownExtension(target: string): string {
  const match = target.match(/^([^#^]+)(.*)$/);
  if (!match) return target;
  const base = match[1];
  const suffix = match[2] ?? "";
  return /\.md$/i.test(base) ? `${base}${suffix}` : `${base}.md${suffix}`;
}

export function stripMarkdownExtension(path: string): string {
  return path.replace(/\.md$/i, "");
}

export function lastPathSegment(path: string): string {
  return path.split("/").filter(Boolean).pop() ?? path;
}
