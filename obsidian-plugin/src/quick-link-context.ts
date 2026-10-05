export interface QuickLinkContext {
  readonly document: string;
  readonly query: string;
  readonly insertOffset: number;
}

export function captureQuickLinkContext(document: string, anchor: number, head: number): QuickLinkContext {
  const from = Math.min(anchor, head);
  const to = Math.max(anchor, head);
  if (from !== to) return { document, query: document.slice(from, to).trim(), insertOffset: to };
  const lines = document.split("\n");
  let line = document.slice(0, to).split("\n").length - 1;
  while (line >= 0 && !lines[line].trim()) line--;
  if (line < 0) return { document, query: "", insertOffset: to };
  let start = line;
  let end = line;
  while (start > 0 && lines[start - 1].trim()) start--;
  while (end + 1 < lines.length && lines[end + 1].trim()) end++;
  return { document, query: lines.slice(start, end + 1).join("\n").trim(), insertOffset: to };
}

export function quickLinkInsertion(document: string, offset: number, links: readonly string[]): string {
  if (!links.length) return "";
  const before = document.slice(0, offset);
  const after = document.slice(offset);
  return `${before && !/\s$/.test(before) ? " " : ""}${links.join(" ")}${after && !/^\s/.test(after) ? " " : ""}`;
}

export function quickWikiLink(target: string): string | null {
  if (!target.trim() || /[\[\]|\u0000-\u001f\u007f]/.test(target)) return null;
  return `[[${target}]]`;
}
