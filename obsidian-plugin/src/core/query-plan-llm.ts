// LLM-based query planning shared between the plugin and bench (ADR 0005,
// issue #57). This is the LLM half of scripts/aha/query-plan.mjs: prompt
// construction (buildQueryPlanPrompt / queryPlanSourceSummary, moved here
// verbatim so a future prompt-override diff (issue #59) can work against
// these exports) and the LLM round-trip orchestration
// (generateQueryPlanViaLlm), which calls llmJsonCall and falls back to the
// deterministic rules plan (queryPlanFromFallbackRules, core since #56) on
// any failure — mirroring the fallback semantics of the legacy
// resolveQmdQueriesForCase/generateQueryPlanWithAgentSync chain.
//
// Caching (bench-side, file-based) and CLI option parsing stay in
// scripts/aha/query-plan.mjs, which calls this module through the compiled
// core artifact exactly like the deterministic pieces from #56.
//
// This module must stay free of `obsidian` imports, node imports, and
// module-level I/O: the actual HTTP POST and the retry sleep are injected via
// LlmTransportDeps (llm-transport.ts), issue #57's single LLM call path.

import {
  type LlmJsonCallRequest,
  type LlmTransportDeps,
  llmJsonCall,
} from "./llm-transport";
import {
  type DeterministicPlanArgs,
  type PlanQuery,
  MAX_QMD_HYDE_CHARS,
  MAX_QMD_INTENT_CHARS,
  MAX_QMD_LEX_CHARS,
  MAX_QMD_LEX_TERMS,
  MAX_QMD_VEC_CHARS,
  QUERY_PLAN_COMMANDS,
  QUERY_PLAN_KINDS,
  compactLine,
  normalizeQueryPlan,
  queryPlanFromFallbackRules,
} from "./query-plan-deterministic";

export const QUERY_PLAN_PROMPT_VERSION = "aha-query-plan-v7";
export const QUERY_PLAN_SCHEMA_NAME = "aha_qmd_query_plan_agent";

export const QUERY_PLAN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["queries"],
  properties: {
    queries: {
      type: "array",
      minItems: 1,
      maxItems: 5,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["kind", "command", "text", "qmd"],
        properties: {
          kind: {
            type: "string",
            enum: QUERY_PLAN_KINDS,
          },
          command: {
            type: "string",
            enum: QUERY_PLAN_COMMANDS,
          },
          text: { type: "string", minLength: 1 },
          qmd: {
            type: "object",
            additionalProperties: false,
            required: ["intent", "lex", "vec", "hyde"],
            properties: {
              intent: { type: "string", minLength: 1, maxLength: MAX_QMD_INTENT_CHARS },
              lex: {
                type: "array",
                minItems: 1,
                maxItems: MAX_QMD_LEX_TERMS,
                items: { type: "string", minLength: 1, maxLength: MAX_QMD_LEX_CHARS },
              },
              vec: { type: "string", minLength: 1, maxLength: MAX_QMD_VEC_CHARS },
              hyde: { type: "string", minLength: 1, maxLength: MAX_QMD_HYDE_CHARS },
            },
          },
        },
      },
    },
  },
};

/**
 * Verbatim port of buildQueryPlanPrompt from scripts/aha/query-plan.mjs, plus
 * an additive optional `promptOverrideText` parameter (issue #59): when a
 * non-empty override string is passed, it is returned as-is instead of the
 * built-in template below. Omitting the parameter (or passing
 * `undefined`/an empty/whitespace-only string) preserves the exact existing
 * behavior byte-for-byte -- bench's call site (buildQueryPlanPrompt({
 * sourcePath }, sourceText), no third argument) is therefore unaffected by
 * this change.
 */
export function buildQueryPlanPrompt(args: DeterministicPlanArgs, sourceText: string, promptOverrideText?: string): string {
  const override = promptOverrideText?.trim();
  if (override) return override;
  const sourceSummary = queryPlanSourceSummary(args, sourceText);
  return [
    "Aha 检索查询生成器。根据 source summary 生成 3-5 条 QMD 结构化查询。系统自动追加一条保留原文的确定性兜底查询。",
    "",
    "目标：召回旧笔记中的旧判断、反例、边界条件、相似结构和明确线索。",
    "",
    "查询形态：",
    "- raw：贴近原文的语义检索。",
    "- abstracted_judgment：剥掉 source 的领域名词，用领域中性的词描述机制本身，召回其他领域里结构相同的旧笔记。两条结构抽象取不同侧面——一条抽象现象层（表层行为如何变化），一条抽象机制层（背后的过程如何运作）。至少一条跳出 source 的表层机制，搜索共享同一隐含前提但讨论完全不同现象的旧笔记。",
    "- contextual：保留具体语境的检索。",
    "- explicit_cue：source 中有明确实体、概念、短语时可用。text 与 lex 只使用 source summary 中实际出现的词。",
    "- bounds：主动搜索不成立条件、限制条件、相反经验。",
    "",
    "覆盖要求：",
    "- 旧笔记往往用与 source 不同的词记录同一件事。lex 和 vec 主动展开同义与口语变体，尤其是情绪和行为词。",
    "- hyde 写成「被找的那篇旧笔记」的口吻，按 kind 区分语气：raw/contextual 用第一人称复盘语气含情绪词和场景词；abstracted_judgment 用冷静结构化分析语气；bounds 用自我质疑或反思语气，模拟「我以为 X 是对的，但在 Y 情况下发现行不通」的经验记录。",
    "- 至少一条查询专门服务 bounds/反例方向。",
    "- source 里指向具体旧笔记、旧事件、书名或自造概念的名词，为最重要的 1-2 个各生成一条 qmd search，text 保持 1-3 个词的短查询。",
    "- 笔记库里存在英文 Clippings。当 insight 的核心概念有惯用英文表达时，为它生成一条独立的 qmd search，text 就是英文短语（1-3 个英文词）。",
    "",
    "command 选择：",
    "- 默认使用 qmd query，填写 qmd.intent / qmd.lex / qmd.vec / qmd.hyde。",
    "- raw、abstracted_judgment、contextual、bounds 使用 qmd query。",
    "- qmd search 用于明确的短实体、概念、原句线索。",
    "",
    "QMD 字段长度约束：lex 最多 4 条短词或短短语；intent ≤ 180 字；vec ≤ 360 字；hyde ≤ 320 字。字段内容为纯文本。",
    "",
    "输出 JSON 只包含 queries 字段，匹配 output schema。",
    `source path: ${args.sourcePath}`,
    "",
    "<source_summary>",
    sourceSummary,
    "</source_summary>",
  ].join("\n");
}

/** Verbatim port of queryPlanSourceSummary from scripts/aha/query-plan.mjs. */
export function queryPlanSourceSummary(args: DeterministicPlanArgs, sourceText: string): string {
  const title = titleFromSourcePath(args.sourcePath);
  const headings = [...String(sourceText ?? "").matchAll(/^#{1,4}\s+(.+)$/gm)]
    .map((match) => compactLine(match[1], 120))
    .slice(0, 12);
  const wikiLinks = [...String(sourceText ?? "").matchAll(/\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]/g)]
    .map((match) => compactLine(match[1], 80))
    .slice(0, 20);
  const bodyLines = String(sourceText ?? "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/^---[\s\S]*?---/m, " ")
    .split(/\r?\n/)
    .map((line) => line.replace(/^[-*]\s+/, "").replace(/^\d+\.\s+/, "").trim())
    .filter((line) => line.length >= 12 && line.length <= 220)
    .slice(0, 60);
  return [
    `title: ${title}`,
    headings.length > 0 ? `headings: ${headings.join(" | ")}` : "",
    wikiLinks.length > 0 ? `wiki links: ${wikiLinks.join(" | ")}` : "",
    "salient lines:",
    ...bodyLines.map((line) => `- ${line}`),
  ].filter(Boolean).join("\n").slice(0, 5_000);
}

// This is a display-only title fed into the prompt text (not used by any
// scored/compared retrieval field), so it does not need the full posix
// path.basename edge-case fidelity that query-plan-deterministic.ts's
// fallbackQmdObject relies on for real behavior.
function titleFromSourcePath(sourcePath: unknown): string {
  const raw = String(sourcePath || "source");
  const lastSlash = raw.lastIndexOf("/");
  const base = lastSlash >= 0 ? raw.slice(lastSlash + 1) : raw;
  return base.toLowerCase().endsWith(".md") ? base.slice(0, -3) : base;
}

export interface QueryPlanLlmOutcome {
  queries: PlanQuery[];
  model_query_count: number;
  generatedBy: "llm" | "rules";
  fallback: boolean;
  error: string | null;
  /**
   * The prompt-version string configured for this attempt: the built-in
   * QUERY_PLAN_PROMPT_VERSION when no override was supplied, or the
   * override's own version string when one was (issue #59). This mirrors the
   * bench convention (scripts/aha/query-plan.mjs's withQueryPlanMetadata),
   * which always records "whichever prompt version was configured", not
   * "whichever prompt version actually produced the returned queries" -- so
   * this field stays set to the override's version even on a rules fallback,
   * exactly like bench's unconditional QUERY_PLAN_PROMPT_VERSION assignment.
   */
  promptVersion: string;
}

export type QueryPlanLlmTransportRequest = Omit<LlmJsonCallRequest, "prompt" | "schema" | "schemaName">;

/**
 * Additive parameter shape (issue #59) for a settings-level query-plan
 * prompt override. `text` replaces the built-in prompt verbatim when
 * non-empty; `version` is the prompt-version string to record instead of
 * QUERY_PLAN_PROMPT_VERSION -- computed by the caller (plugin-side, via
 * Node's `crypto` through getNodeRequire(), the same pattern process.ts and
 * qmd-request.ts already use for other Node built-ins) because this core
 * module must stay free of node imports and therefore cannot hash the
 * override text itself.
 */
export interface QueryPlanPromptOverride {
  text: string;
  version: string;
}

/**
 * Builds the query-plan prompt, calls llmJsonCall, and normalizes the result
 * via normalizeQueryPlan (core since #56). On any failure (transport failure,
 * malformed/short model output), falls back to the deterministic rules plan
 * (queryPlanFromFallbackRules, core since #56) rather than surfacing a raw
 * error to the caller — mirroring the legacy resolveQmdQueriesForCase /
 * generateQueryPlanWithAgentSync fallback chain. Callers that need to
 * distinguish "an agent-fallback toggle disabled fallback" from "the LLM
 * succeeded" should inspect the `fallback` flag; this function itself always
 * returns a usable plan because the rules fallback is unconditionally safe
 * (established by #56).
 *
 * `promptOverride` (issue #59) is an additive optional parameter: omitting
 * it (or passing `undefined`, or `{ text: "" }` / whitespace-only text)
 * preserves the exact existing behavior byte-for-byte -- the built-in prompt
 * is built and QUERY_PLAN_PROMPT_VERSION is recorded, exactly as before this
 * parameter existed. When a non-empty `promptOverride.text` is supplied, it
 * replaces the built-in prompt verbatim and `promptOverride.version` is
 * recorded in `promptVersion` instead.
 */
export async function generateQueryPlanViaLlm(
  args: DeterministicPlanArgs,
  sourceText: string,
  transportRequest: QueryPlanLlmTransportRequest,
  deps: LlmTransportDeps,
  promptOverride?: QueryPlanPromptOverride,
): Promise<QueryPlanLlmOutcome> {
  const overrideText = promptOverride?.text?.trim();
  const promptVersion = overrideText ? promptOverride!.version : QUERY_PLAN_PROMPT_VERSION;
  const prompt = buildQueryPlanPrompt(args, sourceText, overrideText);
  const result = await llmJsonCall(
    { ...transportRequest, prompt, schema: QUERY_PLAN_SCHEMA, schemaName: QUERY_PLAN_SCHEMA_NAME },
    deps,
  );
  if (result.ok) {
    try {
      const plan = normalizeQueryPlan(result.json, args, sourceText);
      return {
        queries: plan.queries,
        model_query_count: plan.model_query_count,
        generatedBy: "llm",
        fallback: false,
        error: null,
        promptVersion,
      };
    } catch (error) {
      return fallbackQueryPlanOutcome(args, errorMessage(error), promptVersion);
    }
  }
  return fallbackQueryPlanOutcome(args, result.error, promptVersion);
}

function fallbackQueryPlanOutcome(args: DeterministicPlanArgs, error: string, promptVersion: string): QueryPlanLlmOutcome {
  const plan = queryPlanFromFallbackRules(args);
  return {
    queries: plan.queries,
    model_query_count: plan.queries.filter((query) => query.kind !== "source_fallback").length,
    generatedBy: "rules",
    fallback: true,
    error,
    promptVersion,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
