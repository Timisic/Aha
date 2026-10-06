export interface SourceSpan { readonly from: number; readonly to: number }
export interface ExcerptDocument { readonly path: string; readonly source: string; readonly sentences: readonly SourceSpan[] }
export type ExcerptPick = { readonly path: string; readonly coverage: "complete" | "bounded" } & (
  | { readonly method: "semantic" | "lexical"; readonly span: SourceSpan }
  | { readonly method: "none"; readonly span: null }
);
export interface RerankScore { readonly index: number; readonly score: number }
export type ScoreTexts = (query: string, texts: readonly string[], signal: AbortSignal) => Promise<readonly RerankScore[]>;

export const EXCERPT_MAX_TEXTS = 128;
export const EXCERPT_MAX_BYTES = 192 * 1024;
const DEADLINE_MS = 2_500;
const planningSection = /日程|待办|(?:本周|下周|本月|下月|今日|明日|工作|项目)安排|(?:^|[^a-z])(?:todo|schedule)(?:$|[^a-z])/i;
const planning = /计划|规划|路线图|(?:^|[^a-z])(?:plans?|planning|roadmap)(?:$|[^a-z])/i;

export function excludesQuickLinkNote(path: string): boolean {
  return planning.test(path) || path.split(/[\\/]/).some((part) => /^readme(?:[._-][a-z0-9-]+)*\.(?:md|markdown)$/i.test(part));
}

export function extractExcerptDocument(path: string, source: string): ExcerptDocument | null {
  if (excludesQuickLinkNote(path)) return null;
  const blocks: SourceSpan[] = [];
  let yaml = false;
  let fence = "";
  let comment: "html" | "obsidian" | null = null;
  let planningDepth = 0;
  let firstH1 = true;
  for (const match of source.matchAll(/[^\n]*(?:\n|$)/g)) {
    const raw = match[0];
    if (!raw) continue;
    const offset = match.index;
    const line = raw.trim();
    if (offset === 0 && /^\uFEFF?---\s*$/.test(line)) { yaml = true; continue; }
    if (yaml) { if (/^(?:---|\.\.\.)$/.test(line)) yaml = false; continue; }
    const containerPrefix = raw.match(/^(?:[ \t]*(?:>[ \t]?|(?:[-+*]|\d+[.)])[ \t]+))*/)?.[0].length ?? 0;
    const content = raw.slice(containerPrefix);
    if (!fence && !comment && /^(?: {4}|\t)/.test(content)) continue;
    const marker = content.trim().match(/^(`{3,}|~{3,})/);
    if (marker && !comment) {
      if (!fence) fence = marker[1];
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = "";
      continue;
    }
    if (fence) continue;
    let hidden = comment !== null;
    let cursor = 0;
    while (cursor < content.length) {
      if (comment) {
        const close = comment === "html" ? "-->" : "%%";
        const end = content.indexOf(close, cursor);
        if (end < 0) break;
        comment = null;
        cursor = end + close.length;
      } else {
        const html = content.indexOf("<!--", cursor);
        const native = content.indexOf("%%", cursor);
        if (html < 0 && native < 0) break;
        const isHtml = html >= 0 && (native < 0 || html < native);
        comment = isHtml ? "html" : "obsidian";
        cursor = (isHtml ? html : native) + (isHtml ? 4 : 2);
        hidden = true;
      }
    }
    if (hidden) continue;
    const heading = content.trim().match(/^(#{1,6})\s+(.+?)\s*#*$/);
    if (heading) {
      const depth = heading[1].length;
      if (depth === 1 && firstH1) { firstH1 = false; if (planning.test(heading[2])) return null; }
      if (planningDepth && depth <= planningDepth) planningDepth = 0;
      if (!planningDepth && (planning.test(heading[2]) || planningSection.test(heading[2]))) planningDepth = depth;
      continue;
    }
    if (planningDepth || !line || /^(?:[-*_]\s*){3,}$/.test(content.trim())) continue;
    const prefix = containerPrefix + (content.match(/^[ \t]*/)?.[0].length ?? 0);
    const body = raw.slice(prefix).trimEnd();
    if (!body || /^\[[ xX]\]\s/.test(body) || /^[\w\p{Script=Han}-]+\s*::?\s+/u.test(body) || /^\[[^\]]+\]:/.test(body)) continue;
    if (!containsProse(body)) continue;
    const span = { from: offset + prefix, to: offset + prefix + body.length };
    const previous = blocks.at(-1);
    if (previous && /^[ \t]*\r?\n[ \t]*$/.test(source.slice(previous.to, span.from))) blocks[blocks.length - 1] = { from: previous.from, to: span.to };
    else blocks.push(span);
  }
  const sentences = blocks.flatMap((block) => sentenceSpans(source, block));
  return sentences.length ? { path, source, sentences } : null;
}

function inlineCodeEnd(body: string, from: number): number | null {
  const run = body.slice(from).match(/^`+/)?.[0] ?? "`";
  let closing = body.indexOf(run, from + run.length);
  while (closing >= 0 && (body[closing - 1] === "`" || body[closing + run.length] === "`")) closing = body.indexOf(run, closing + run.length);
  return closing < 0 ? null : closing + run.length;
}

const sourceContainers = new Map([
  ["[", "]"], ["(", ")"], ["（", "）"], ["【", "】"], ["［", "］"],
  ["「", "」"], ["『", "』"], ["“", "”"], ["‘", "’"],
]);

function protectedSpans(body: string, purpose: "display" | "ranking"): SourceSpan[] {
  const spans: SourceSpan[] = [];
  for (let i = 0; i < body.length; i++) {
    let end = i;
    if (body[i] === "\\") end = Math.min(i + 2, body.length);
    else if (body[i] === "`") {
      const closing = inlineCodeEnd(body, i);
      end = closing ?? body.length;
    } else if (body[i] === "[" || (purpose === "display" && sourceContainers.has(body[i]))) {
      const closing: string[] = [];
      let link = body[i] === "[" && body[i + 1] === "[";
      let cursor = i;
      for (; cursor < body.length; cursor++) {
        const character = body[cursor];
        if (character === "\\") { cursor++; continue; }
        if (character === "`") {
          const codeEnd = inlineCodeEnd(body, cursor);
          if (codeEnd === null) { cursor = body.length; break; }
          cursor = codeEnd - 1;
          continue;
        }
        if (character === "’" && /[\p{L}\p{N}]/u.test(body[cursor - 1] ?? "") && /[\p{L}\p{N}]/u.test(body[cursor + 1] ?? "")) continue;
        const containerEnd = sourceContainers.get(character);
        if (containerEnd) closing.push(containerEnd);
        else if (character === closing.at(-1)) {
          closing.pop();
          if (!closing.length) {
            if (character === "]" && (body[cursor + 1] === "(" || body[cursor + 1] === "[")) link = true;
            else break;
          }
        }
      }
      if (purpose === "display" || link) end = Math.min(cursor + 1, body.length);
    } else if (purpose === "display" && (body[i] === "*" || body[i] === "_" || ((body[i] === "~" || body[i] === "=") && body[i + 1] === body[i])) && !/\w/.test(body[i - 1] ?? "")) {
      const marker = body.slice(i).match(/^(?:\*{1,3}|_{1,3}|~{2}|={2})/)?.[0] ?? body[i];
      let closing = body.indexOf(marker, i + marker.length);
      while (closing >= 0 && (body[closing - 1] === body[i] || body[closing + marker.length] === body[i] || body[closing - 1] === "\\")) closing = body.indexOf(marker, closing + marker.length);
      end = closing < 0 ? body.length : closing + marker.length;
    } else {
      const url = body.slice(i).match(/^https?:\/\/\S+/)?.[0];
      if (url) end = i + url.length;
    }
    if (end > i) {
      spans.push({ from: i, to: end });
      i = end - 1;
    }
  }
  return spans;
}

function containsProse(body: string): boolean {
  let visible = "";
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    if (body[i] === "\\") { i++; continue; }
    if (body[i] !== "`") continue;
    const end = inlineCodeEnd(body, i);
    if (end === null) break;
    visible += body.slice(start, i);
    start = end;
    i = end - 1;
  }
  visible += body.slice(start);
  const withoutNavigation = visible.replace(/!?\[\[[^\]]+\]\]|!?\[[^\]]*\]\([^)]*\)|https?:\/\/\S+/g, "");
  return /[\p{L}\p{N}]/u.test(withoutNavigation);
}

function sentenceSpans(source: string, block: SourceSpan, clauses = false): SourceSpan[] {
  const spans: SourceSpan[] = [];
  const body = source.slice(block.from, block.to);
  const protectedRanges = protectedSpans(body, clauses ? "ranking" : "display");
  let protectedIndex = 0;
  let start = 0;
  const append = (to: number) => {
    let from = start;
    while (from < to && /\s/.test(body[from])) from++;
    while (to > from && /\s/.test(body[to - 1])) to--;
    if (from < to && (clauses || containsProse(body.slice(from, to)))) spans.push({ from: block.from + from, to: block.from + to });
  };
  for (let i = 0; i < body.length; i++) {
    const protectedRange = protectedRanges[protectedIndex];
    if (protectedRange && i === protectedRange.from) {
      i = protectedRange.to - 1;
      protectedIndex++;
      const quoted = body.slice(protectedRange.from, protectedRange.to);
      if (!clauses && /^[“‘「『]/.test(quoted) && /[。！？!?\.][”’」』]+$/.test(quoted) && (protectedRange.to === body.length || /\s/.test(body[protectedRange.to]))) {
        append(protectedRange.to);
        start = protectedRange.to;
        while (start < body.length && /\s/.test(body[start])) start++;
        i = start - 1;
      }
      continue;
    }
    const punctuation = /[。！？!?]/.test(body[i]) || (body[i] === "." && (i + 1 === body.length || /[\s”’"'）)】\]]/.test(body[i + 1])));
    const clause = clauses && /[,，;；]/.test(body[i]);
    if (!punctuation && !clause) continue;
    let end = i + 1;
    while (end < body.length && /[。！？!?”’"'）)】\]]/.test(body[end])) end++;
    append(end);
    start = end;
    while (start < body.length && /\s/.test(body[start])) start++;
    i = start - 1;
  }
  append(body.length);
  return spans;
}

export function excerptText(note: ExcerptDocument, span: SourceSpan): string {
  return note.source.slice(span.from, span.to).replace(/\s+/g, " ").trim();
}

function terms(text: string): Set<string> {
  const stop = new Set(["this", "that", "with", "from", "have", "what", "when", "where", "which", "about", "there", "their", "the", "and", "for", "are", "如何", "什么", "一个", "我们", "可以", "这个", "进行", "相关", "笔记", "以及", "就是", "因为", "所以", "通过", "需要"]);
  const result = new Set<string>();
  for (const match of text.toLowerCase().matchAll(/[a-z]{3,}|[\p{Script=Han}]+/gu)) {
    const word = match[0];
    if (/^[a-z]/.test(word)) { if (!stop.has(word)) result.add(word); }
    else for (let i = 0; i + 1 < word.length; i++) { const term = word.slice(i, i + 2); if (!stop.has(term)) result.add(term); }
  }
  return result;
}

function lexical(query: string, note: ExcerptDocument, coverage: ExcerptPick["coverage"]): ExcerptPick {
  const queryTerms = terms(query);
  let winner: SourceSpan | null = null;
  let best = 0;
  for (const leaf of leavesFor(note)) {
    const words = terms(excerptText(note, leaf.scoreSpan));
    let overlap = 0;
    for (const term of queryTerms) if (words.has(term)) overlap++;
    const score = overlap / Math.sqrt(Math.max(words.size, 1));
    if (score > best) { best = score; winner = leaf.sentence; }
  }
  return winner ? { path: note.path, span: winner, method: "lexical", coverage } : { path: note.path, span: null, method: "none", coverage };
}

interface SentenceLeaf { readonly scoreSpan: SourceSpan; readonly sentence: SourceSpan }
interface RankUnit { readonly note: ExcerptDocument; readonly scoreSpan: SourceSpan; readonly leaves: readonly SentenceLeaf[] }
function leavesFor(note: ExcerptDocument): SentenceLeaf[] {
  return note.sentences.flatMap((sentence) => {
    const spans = sentence.to - sentence.from > 300 ? sentenceSpans(note.source, sentence, true) : [sentence];
    return spans.map((scoreSpan) => ({ scoreSpan, sentence }));
  });
}
function unitsFor(note: ExcerptDocument): RankUnit[] {
  const leaves = leavesFor(note);
  if (leaves.length <= 24) return leaves.map((leaf) => ({ note, scoreSpan: leaf.scoreSpan, leaves: [leaf] }));
  const units: RankUnit[] = [];
  for (const leaf of leaves) {
    const span = leaf.scoreSpan;
    const previous = units.at(-1);
    if (previous && span.to - previous.scoreSpan.from <= 1600 && /^\s*$/.test(note.source.slice(previous.scoreSpan.to, span.from))) {
      units[units.length - 1] = { note, scoreSpan: { from: previous.scoreSpan.from, to: span.to }, leaves: [...previous.leaves, leaf] };
    } else units.push({ note, scoreSpan: span, leaves: [leaf] });
  }
  return units;
}
function fits(query: string, units: readonly RankUnit[]): boolean {
  return units.length <= EXCERPT_MAX_TEXTS && new TextEncoder().encode(JSON.stringify({ query, documents: units.map((unit) => excerptText(unit.note, unit.scoreSpan)) })).length <= EXCERPT_MAX_BYTES - 1024;
}
function scoredUnits(units: readonly RankUnit[], scores: readonly RerankScore[]): RankUnit[] {
  const seen = new Set<number>();
  return [...scores].filter(({ index, score }) => {
    if (!Number.isInteger(index) || index < 0 || index >= units.length || !Number.isFinite(score) || seen.has(index)) throw new Error("Invalid excerpt scores.");
    seen.add(index); return true;
  }).sort((a, b) => b.score - a.score).map(({ index }) => units[index]);
}

export async function selectExcerpts(query: string, notes: readonly ExcerptDocument[], score: ScoreTexts | null, signal: AbortSignal): Promise<readonly ExcerptPick[]> {
  signal.throwIfAborted();
  const units = notes.flatMap(unitsFor);
  const coverage = fits(query, units) ? "complete" : "bounded";
  const fallback = () => notes.map((note) => lexical(query, note, coverage));
  if (!score || !units.length || coverage === "bounded") return fallback();
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error("Excerpt deadline exceeded.")), DEADLINE_MS);
  try {
    const ranked = scoredUnits(units, await score(query, units.map((unit) => excerptText(unit.note, unit.scoreSpan)), controller.signal));
    controller.signal.throwIfAborted();
    const finalists: RankUnit[] = [];
    for (const note of notes) {
      for (const unit of ranked.filter((unit) => unit.note === note).slice(0, 2)) {
        finalists.push(...unit.leaves.map((leaf) => ({ note, scoreSpan: leaf.scoreSpan, leaves: [leaf] })));
      }
    }
    const needsRefinement = ranked.some((unit) => unit.leaves.length > 1);
    let winners = ranked;
    if (needsRefinement) {
      if (!fits(query, finalists)) return notes.map((note) => lexical(query, note, "bounded"));
      winners = scoredUnits(finalists, await score(query, finalists.map((unit) => excerptText(unit.note, unit.scoreSpan)), controller.signal));
      controller.signal.throwIfAborted();
    }
    return notes.map((note): ExcerptPick => {
      const winner = winners.find((unit) => unit.note === note)?.leaves[0];
      return winner ? { path: note.path, span: winner.sentence, method: "semantic", coverage: needsRefinement ? "bounded" : "complete" } : lexical(query, note, coverage);
    });
  } catch {
    signal.throwIfAborted();
    return fallback();
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
}
