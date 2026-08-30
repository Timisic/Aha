import { sameNotePath } from "./note-identity";

/** A note locator is not evidence. Also handles records saved by older builds. */
export function candidateHit(candidate: { notePath?: unknown; hit?: unknown; quotes?: unknown }): string {
  const values = [candidate.hit, ...(Array.isArray(candidate.quotes) ? candidate.quotes : [])];
  for (const value of values) {
    if (typeof value !== "string" || !value.trim()) continue;
    const text = value.trim();
    const locator = text.replace(/^\[\[|\]\]$/g, "").split("|")[0];
    try {
      if (sameNotePath(locator, candidate.notePath)) continue;
    } catch {
      // Ordinary prose may contain a literal percent sign, not URI encoding.
    }
    return text;
  }
  return "";
}
