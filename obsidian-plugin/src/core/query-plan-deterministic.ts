// Deterministic query-planning logic shared between the plugin and bench
// (ADR 0005, issue #56). This is the non-LLM portion of
// scripts/aha/query-plan.mjs: fallback qmd object construction, sanitization
// and length limits, the deterministic source fallback query, and the
// rules-based query plan. LLM prompt construction, adapters, and caching stay
// in scripts/aha/query-plan.mjs (issue #57).
//
// This module must stay free of `obsidian` imports, node imports, and
// module-level I/O. Behavior is a 1:1 port of the legacy module; any drift is
// a migration bug. Constants are byte-identical to the legacy values.

export const QUERY_PLAN_KINDS = ["raw", "abstracted_judgment", "contextual", "explicit_cue", "bounds"];
export const QUERY_PLAN_FALLBACK_KINDS = ["raw", "abstracted_judgment", "contextual", "explicit_cue"];
export const QUERY_PLAN_COMMANDS = ["qmd query", "qmd search"];
export const MAX_QMD_LEX_TERMS = 4;
export const MAX_QMD_LEX_CHARS = 32;
export const MAX_QMD_INTENT_CHARS = 180;
export const MAX_QMD_VEC_CHARS = 360;
export const MAX_QMD_HYDE_CHARS = 320;

const DEFAULT_INTENT =
  "只根据这段原始 /insight 输入，召回过往笔记中相关的旧经验、旧判断、反例、边界条件和相似关系模式；不要依赖人工标注答案。";

const DEFAULT_HYDE =
  "一篇相关旧笔记可能记录了与当前输入相似的经历、情绪结构、关系模式、旧判断变化、失败反例、边界条件或可复用的判断框架；它能帮助判断当前 insight 改变了什么、哪里不成立、下一步如何验证。";

export interface QmdQueryObject {
  intent: string;
  lex: string[];
  vec: string;
  hyde: string;
}

export interface DeterministicPlanArgs {
  sourcePath?: string | null;
  id?: string | null;
  displayName?: string | null;
  _resolved_insight_input?: unknown;
}

export interface PlanQuery {
  kind: string;
  command: string;
  text: string;
  query: string;
  qmd: QmdQueryObject;
}

export interface NormalizedQueryPlan {
  queries: PlanQuery[];
  model_query_count: number;
}

export function compactLine(value: unknown, max = 900): string {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trim()}...`;
}

export function unique(values: unknown[]): string[] {
  return Array.from(new Set(values.map((value) => String(value ?? "").trim()).filter(Boolean)));
}

export function splitLexCandidates(input: unknown): string[] {
  const rawInput = String(input ?? "");
  const freshThoughtMatch = rawInput.match(/\bFresh thought:\s*([\s\S]*)$/i);
  const sourcePart = freshThoughtMatch ? rawInput.slice(0, freshThoughtMatch.index) : rawInput;
  const lexInput = freshThoughtMatch
    ? `${freshThoughtMatch[1]}\n${sourcePart}`
    : rawInput;
  return unique(
    compactLine(lexInput, 1200)
      .replace(/^Source note:\s*/i, "")
      .replace(/\bFresh thought:\b/gi, "\n")
      .split(/[\n\r，。；;、,.!?！？|/（）()【】\[\]《》<>：:\s]+/)
      .map((part) =>
        compactLine(
          part
            .replace(/^#+\s*/, "")
            .replace(/^>+\s*/, "")
            .replace(/\bWhy It Resonates\b/gi, "")
            .replace(/[*_`=]+/g, "")
            .trim(),
          MAX_QMD_LEX_CHARS,
        ),
      )
      .filter((part) => part.length >= 2)
      .filter((part) => !/^[-#>*\s]+$/.test(part))
      .filter((part) => !/^(insight|why it resonates|summary)$/i.test(part))
      .filter((part) => !/^(source note|fresh thought)$/i.test(part)),
  ).slice(0, MAX_QMD_LEX_TERMS);
}

export function normalizeLex(lex: unknown): string[] {
  if (Array.isArray(lex)) return lex.map((item) => compactLine(item, MAX_QMD_LEX_CHARS)).filter(Boolean);
  if (typeof lex === "string" && lex.trim()) return [compactLine(lex, MAX_QMD_LEX_CHARS)];
  return [];
}

export function deterministicSourceFallbackQuery(args: DeterministicPlanArgs = {}, sourceText = ""): PlanQuery {
  const qmd = normalizeQmdObject(fallbackQmdObject(args, sourceText), args, sourceText);
  return {
    kind: "source_fallback",
    command: "qmd query",
    text: qmd.vec,
    query: qmdQueryFromObject(qmd),
    qmd,
  };
}

export function normalizeQueryPlan(value: unknown, args: DeterministicPlanArgs = {}, sourceText = ""): NormalizedQueryPlan {
  const rawQueries = Array.isArray((value as { queries?: unknown } | null | undefined)?.queries)
    ? (value as { queries: unknown[] }).queries
    : [];
  const queries: PlanQuery[] = [];
  const seen = new Set<string>();
  for (const item of rawQueries) {
    const query = normalizeQueryPlanItem(item, args, sourceText, queries.length);
    const key = `${query.command}\0${query.query}`;
    if (seen.has(key)) continue;
    seen.add(key);
    queries.push(query);
    if (queries.length >= 5) break;
  }
  if (queries.length < 3) {
    throw new Error(`${args.displayName || "agent"} query plan returned fewer than 3 usable queries.`);
  }
  const modelQueryCount = queries.length;
  queries.push(deterministicSourceFallbackQuery(args, sourceText));
  return { queries, model_query_count: modelQueryCount };
}

export function normalizeQueryPlanItem(item: unknown, args: DeterministicPlanArgs = {}, sourceText = "", index = 0): PlanQuery {
  const record = (item ?? {}) as { kind?: unknown; command?: unknown; text?: unknown; qmd?: unknown };
  const kind = normalizeQueryKind(record.kind, index);
  const command = normalizeQueryCommand(record.command, kind);
  const qmd = normalizeQmdObject(record.qmd, args, sourceText);
  const text = compactLine(record.text || qmd.vec || qmd.lex.join(" "), 300);
  const query = queryTextForCommand(command, text, qmd);
  return {
    kind,
    command,
    text,
    query,
    qmd,
  };
}

export function normalizeQmdObject(value: unknown, args: DeterministicPlanArgs = {}, sourceText = ""): QmdQueryObject {
  const record = (value ?? {}) as { intent?: unknown; lex?: unknown; vec?: unknown; hyde?: unknown };
  const fallback = fallbackQmdObject(args, sourceText);
  const lex = unique(Array.isArray(record.lex) ? [...record.lex, ...fallback.lex] : fallback.lex)
    .map((item) => sanitizeQmdLine(item, MAX_QMD_LEX_CHARS))
    .filter((item) => item.length >= 1)
    .slice(0, MAX_QMD_LEX_TERMS);
  return {
    intent: sanitizeQmdLine(record.intent || fallback.intent, MAX_QMD_INTENT_CHARS),
    lex: lex.length > 0 ? lex : fallback.lex.slice(0, MAX_QMD_LEX_TERMS),
    vec: sanitizeQmdLine(record.vec || fallback.vec, MAX_QMD_VEC_CHARS),
    hyde: sanitizeQmdLine(record.hyde || fallback.hyde, MAX_QMD_HYDE_CHARS),
  };
}

export function fallbackQmdObject(args: DeterministicPlanArgs = {}, sourceText = ""): QmdQueryObject {
  const title = basename(String(args.sourcePath || args.id || "source"), ".md");
  const source = String(sourceText || args._resolved_insight_input || "");
  const heading = source.match(/^#{1,3}\s+(.+)$/m)?.[1]?.trim() || title;
  const wikiLinks = [...source.matchAll(/\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]/g)]
    .map((match) => match[1].trim())
    .filter(Boolean);
  const lineSignals = source
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/^---[\s\S]*?---/m, " ")
    .split(/\r?\n/)
    .map((line) => line.replace(/^#+\s*/, "").trim())
    .filter((line) => line.length > 12 && line.length < 180);
  const lex = unique([heading, title, ...wikiLinks, ...lineSignals.flatMap((line) => line.split(/[，。；;、,.!?！？|/（）()【】\[\]《》<>：:\s]+/).slice(0, 2))])
    .filter((item) => item.length >= 1 && item.length <= 48)
    .slice(0, MAX_QMD_LEX_TERMS);
  const vec = lineSignals.slice(0, 6).join(" ") || source || heading;
  return {
    intent: "召回与当前 Aha insight/source note 相关的旧判断、反例、边界和相似结构。",
    lex: lex.length > 0 ? lex : splitLexCandidates(source || heading),
    vec: compactLine(vec, MAX_QMD_VEC_CHARS),
    hyde: `一篇旧笔记讨论与「${heading}」相关的经验、判断变化、产品边界或记忆检索线索。`,
  };
}

export function qmdQueryFromObject(qmd: unknown): string {
  const normalized = normalizeQmdObject(qmd);
  return [
    `intent: ${normalized.intent}`,
    ...normalized.lex.map((item) => `lex: ${item}`),
    `vec: ${normalized.vec}`,
    `hyde: ${normalized.hyde}`,
  ].join("\n");
}

export function queryPlanFromFallbackRules(caseItem: DeterministicPlanArgs): { queries: PlanQuery[] } {
  const rawInput = compactLine(caseItem._resolved_insight_input, 900);
  const base = normalizeQmdObject(queryObjectFromFallbackRules(caseItem), caseItem, rawInput);
  const lex = base.lex.length > 0 ? base.lex : splitLexCandidates(rawInput);
  const plan = [
    {
      kind: "raw",
      command: "qmd query",
      qmd: base,
    },
    {
      kind: "abstracted_judgment",
      command: "qmd query",
      qmd: normalizeQmdObject({
        intent: "召回能解释、支持、挑战或限定当前 insight 判断结构的旧笔记。",
        lex: unique([...lex, "旧判断", "边界条件", "反例"]).slice(0, MAX_QMD_LEX_TERMS),
        vec: rawInput,
        hyde: "一篇相关旧笔记会记录类似判断如何形成、哪里被现实修正、哪些边界条件让原判断不再成立，以及这种变化如何影响后续选择。",
      }, caseItem, rawInput),
    },
    {
      kind: "contextual",
      command: "qmd query",
      qmd: normalizeQmdObject({
        intent: "召回和当前语境、经历场景、关系模式或行动选择相似的旧笔记。",
        lex: unique([...lex, "相似经历", "关系模式", "行动选择"]).slice(0, MAX_QMD_LEX_TERMS),
        vec: rawInput,
        hyde: "一篇相关旧笔记会包含相似场景中的真实经历、情绪线索、关系互动或行动取舍，能帮助用户比较这一次 insight 和过去经验之间的结构关系。",
      }, caseItem, rawInput),
    },
    {
      kind: "explicit_cue",
      command: "qmd search",
      text: lex.slice(0, MAX_QMD_LEX_TERMS).join(" ") || rawInput,
      qmd: normalizeQmdObject({
        intent: "召回 raw input 中出现的明确短语、概念或实体对应的旧笔记。",
        lex,
        vec: rawInput,
        hyde: base.hyde,
      }, caseItem, rawInput),
    },
  ];
  return { queries: plan.map((item, index) => normalizeQueryPlanItem(item, caseItem, rawInput, index)) };
}

function queryObjectFromFallbackRules(caseItem: DeterministicPlanArgs): QmdQueryObject {
  return {
    intent: DEFAULT_INTENT,
    lex: splitLexCandidates(caseItem._resolved_insight_input),
    vec: compactLine(caseItem._resolved_insight_input, MAX_QMD_VEC_CHARS),
    hyde: DEFAULT_HYDE,
  };
}

export function normalizeQueryKind(kind: unknown, index: number): string {
  const value = String(kind ?? "").trim();
  if (QUERY_PLAN_KINDS.includes(value)) return value;
  return QUERY_PLAN_FALLBACK_KINDS[index] || "contextual";
}

export function normalizeQueryCommand(command: unknown, kind: string): string {
  const value = String(command ?? "").trim();
  if (QUERY_PLAN_COMMANDS.includes(value)) return value;
  return kind === "explicit_cue" ? "qmd search" : "qmd query";
}

export function queryTextForCommand(command: string, text: string, qmd: QmdQueryObject): string {
  if (command === "qmd search") return compactLine(text || qmd.lex.join(" "), 300);
  return qmdQueryFromObject(qmd);
}

export function sanitizeQmdLine(value: unknown, maxLength: number): string {
  return compactLine(value, maxLength)
    .replace(/^(?:intent|lex|vec|hyde)\s*:\s*/i, "")
    .replace(/["`]+/g, "'")
    .replace(/^[*-]\s+/, "")
    .trim();
}

// Verbatim port of Node's posix path.basename algorithm, so the legacy
// `path.basename(value, ".md")` semantics (including the ".md" / "dir/.md"
// edge cases) survive without a node import. The legacy modules ran on
// darwin/linux where path.basename is the posix implementation.
function basename(path: string, suffix?: string): string {
  let start = 0;
  let end = -1;
  let matchedSlash = true;

  if (suffix !== undefined && suffix.length > 0 && suffix.length <= path.length) {
    if (suffix === path) return "";
    let extIdx = suffix.length - 1;
    let firstNonSlashEnd = -1;
    for (let i = path.length - 1; i >= 0; --i) {
      const code = path.charCodeAt(i);
      if (code === 47) {
        if (!matchedSlash) {
          start = i + 1;
          break;
        }
      } else {
        if (firstNonSlashEnd === -1) {
          matchedSlash = false;
          firstNonSlashEnd = i + 1;
        }
        if (extIdx >= 0) {
          if (code === suffix.charCodeAt(extIdx)) {
            if (--extIdx === -1) {
              end = i;
            }
          } else {
            extIdx = -1;
            end = firstNonSlashEnd;
          }
        }
      }
    }
    if (start === end) end = firstNonSlashEnd;
    else if (end === -1) end = path.length;
    return path.slice(start, end);
  }
  for (let i = path.length - 1; i >= 0; --i) {
    if (path.charCodeAt(i) === 47) {
      if (!matchedSlash) {
        start = i + 1;
        break;
      }
    } else if (end === -1) {
      matchedSlash = false;
      end = i + 1;
    }
  }
  if (end === -1) return "";
  return path.slice(start, end);
}
