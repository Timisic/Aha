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
    const withoutNavigation = body.replace(/!?\[\[[^\]]+\]\]|!?\[[^\]]*\]\([^)]*\)|https?:\/\/\S+/g, "").replace(/[\s|,，;；·•-]+/g, "");
    if (!/[\p{L}\p{N}]/u.test(withoutNavigation)) continue;
    const span = { from: offset + prefix, to: offset + prefix + body.length };
    const previous = blocks.at(-1);
    if (previous && /^[ \t]*\r?\n[ \t]*$/.test(source.slice(previous.to, span.from))) blocks[blocks.length - 1] = { from: previous.from, to: span.to };
    else blocks.push(span);
  }
  const sentences = blocks.flatMap((block) => sentenceSpans(source, block));
  return { path, source, sentences };
}

function sentenceSpans(source: string, block: SourceSpan): SourceSpan[] {
  const spans: SourceSpan[] = [];
  const body = source.slice(block.from, block.to);
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    const punctuation = /[。！？!?]/.test(body[i]) || (body[i] === "." && (i + 1 === body.length || /\s/.test(body[i + 1])));
    const clause = body.length > 300 && /[,，;；]/.test(body[i]);
    if (!punctuation && !clause && i - start < 239) continue;
    let end = i + 1;
    while (end < body.length && /[”’"'）)】\]]/.test(body[end])) end++;
    if (body.slice(start, end).trim()) spans.push({ from: block.from + start, to: block.from + end });
    start = end;
    while (start < body.length && /\s/.test(body[start])) start++;
    i = start - 1;
  }
  if (body.slice(start).trim()) spans.push({ from: block.from + start, to: block.to });
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
  for (const span of note.sentences) {
    const words = terms(excerptText(note, span));
    let overlap = 0;
    for (const term of queryTerms) if (words.has(term)) overlap++;
    const score = overlap / Math.sqrt(Math.max(words.size, 1));
    if (score > best) { best = score; winner = span; }
  }
  return winner ? { path: note.path, span: winner, method: "lexical", coverage } : { path: note.path, span: null, method: "none", coverage };
}

interface RankUnit { readonly note: ExcerptDocument; readonly span: SourceSpan; readonly sentences: readonly SourceSpan[] }
function unitsFor(note: ExcerptDocument): RankUnit[] {
  if (note.sentences.length <= 24) return note.sentences.map((span) => ({ note, span, sentences: [span] }));
  const units: RankUnit[] = [];
  for (const span of note.sentences) {
    const previous = units.at(-1);
    if (previous && span.to - previous.span.from <= 1600 && /^\s*$/.test(note.source.slice(previous.span.to, span.from))) {
      units[units.length - 1] = { note, span: { from: previous.span.from, to: span.to }, sentences: [...previous.sentences, span] };
    } else units.push({ note, span, sentences: [span] });
  }
  return units;
}
function fits(query: string, units: readonly RankUnit[]): boolean {
  return units.length <= EXCERPT_MAX_TEXTS && new TextEncoder().encode(JSON.stringify({ query, documents: units.map((unit) => excerptText(unit.note, unit.span)) })).length <= EXCERPT_MAX_BYTES - 1024;
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
    const ranked = scoredUnits(units, await score(query, units.map((unit) => excerptText(unit.note, unit.span)), controller.signal));
    controller.signal.throwIfAborted();
    const finalists: RankUnit[] = [];
    for (const note of notes) {
      for (const unit of ranked.filter((unit) => unit.note === note).slice(0, 2)) {
        finalists.push(...unit.sentences.map((span) => ({ note, span, sentences: [span] })));
      }
    }
    const needsRefinement = ranked.some((unit) => unit.sentences.length > 1);
    let winners = ranked;
    if (needsRefinement) {
      if (!fits(query, finalists)) return notes.map((note) => lexical(query, note, "bounded"));
      winners = scoredUnits(finalists, await score(query, finalists.map((unit) => excerptText(unit.note, unit.span)), controller.signal));
      controller.signal.throwIfAborted();
    }
    return notes.map((note): ExcerptPick => {
      const winner = winners.find((unit) => unit.note === note);
      return winner ? { path: note.path, span: winner.span, method: "semantic", coverage: needsRefinement ? "bounded" : "complete" } : lexical(query, note, coverage);
    });
  } catch {
    signal.throwIfAborted();
    return fallback();
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
}
