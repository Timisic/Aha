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

export const QUERY_PLAN_PROMPT_VERSION = "aha-query-plan-v6";
export const QUERY_PLAN_SCHEMA_NAME = "aha_qmd_query_plan_agent";

export const QUERY_PLAN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["queries"],
  properties: {
    queries: {
      type: "array",
      minItems: 3,
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
 * Verbatim port of buildQueryPlanPrompt from scripts/aha/query-plan.mjs.
 * Kept as an exported core constant/function (not just an implementation
 * detail) so a future prompt-override diff (issue #59) can hash and compare
 * this exact prompt text.
 */
export function buildQueryPlanPrompt(args: DeterministicPlanArgs, sourceText: string): string {
  const sourceSummary = queryPlanSourceSummary(args, sourceText);
  return [
    "你是 Aha/Pi /insight 的检索查询生成子 agent。",
    "只根据下面 source summary 生成 3-5 条 QMD 检索查询计划；不要读取文件、不要运行命令、不要搜索外部资料、不要检查仓库。系统会在你的计划之后另加一条保留原笔记表达的确定性兜底查询，你不需要替代它。",
    "",
    "目标：让 Aha 后续用 QMD 混合召回旧笔记中的旧判断、反例、边界条件、相似结构和明确线索。",
    "",
    "查询形态：",
    "- raw: 贴近原文的语义检索。",
    "- abstracted_judgment: 抽象出判断结构、关系模式、反例或边界。剥掉 source 的领域名词，用领域中性的词描述机制本身（例如把「杀球动作不稳定」抽象成「表层表现由更深层机制决定」），这样才能召回其他领域里结构相同的旧笔记。",
    "- contextual: 保留具体语境，但不引入 source note 之外的新事实。",
    "- explicit_cue: source note 里有明确实体、概念、短语时可用。",
    "- bounds: 主动找不成立、限制条件、相反经验。",
    "",
    "覆盖要求：",
    "- 旧笔记往往用与 source 不同的词记录同一件事。lex 和 vec 要主动展开同义与口语变体，尤其是情绪和行为词（例如 赌气→生气/吵架/冷战/不平衡，恐惧→害怕/焦虑/不敢，拖延→懒/摆烂/刷视频）。",
    "- hyde 写成「被找的那篇旧笔记」的口吻：第一人称、过去的复盘语气、含当时可能用到的情绪词和场景词；不要写成对 source 的转述。",
    "- 至少一条查询专门服务 bounds/反例方向。",
    "- 结构抽象生成两条、取不同侧面：一条抽象现象层（表层行为/表现如何变化），一条抽象机制层（背后的过程如何运作，例如「认知更新后重新诠释过去的经验」）。同一 insight 的旧笔记可能只在其中一个侧面留下语义痕迹。",
    "- source 里指向具体旧笔记、旧事件、书名或自造概念的名词（例如某次经历的代号、专有词），很可能就是旧笔记的标题词：为最重要的 1-2 个各生成一条 qmd search，text 保持 1-3 个词的短查询，不要混入其他概念。explicit_cue 的 text 与 lex 只能使用 source summary 中实际出现的词，禁止引入外部词汇。",
    "- 笔记库里存在英文 Clippings。当 insight 的核心概念有惯用英文表达时（例如 外包理解→delegate understanding / outsource understanding，第二大脑→second brain），为它生成一条独立的 qmd search，text 就是那个英文短语（1-3 个英文词），不要把英文词埋进 qmd query 的 lex 里——混合检索会稀释短语命中。",
    "",
    "command 选择：",
    "- 默认使用 qmd query，并填写 qmd.intent / qmd.lex / qmd.vec / qmd.hyde。",
    "- raw、abstracted_judgment、contextual、bounds 都使用 qmd query。",
    "- qmd search 只用于非常明确的短实体、概念、原句线索；text 必须是实际搜索短语。",
    "",
    "QMD 字段长度约束：",
    "- lex 最多 4 条，每条是短词或短短语，不要写整句。",
    "- intent 不超过 180 字；vec 不超过 360 字；hyde 不超过 320 字。",
    "- 字段里不要包含换行、项目符号、Markdown 引号或额外的 intent:/lex:/vec:/hyde: 前缀。",
    "",
    "输出必须是 JSON，只包含 queries 字段，并匹配 output schema。",
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
}

export type QueryPlanLlmTransportRequest = Omit<LlmJsonCallRequest, "prompt" | "schema" | "schemaName">;

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
 */
export async function generateQueryPlanViaLlm(
  args: DeterministicPlanArgs,
  sourceText: string,
  transportRequest: QueryPlanLlmTransportRequest,
  deps: LlmTransportDeps,
): Promise<QueryPlanLlmOutcome> {
  const prompt = buildQueryPlanPrompt(args, sourceText);
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
      };
    } catch (error) {
      return fallbackQueryPlanOutcome(args, errorMessage(error));
    }
  }
  return fallbackQueryPlanOutcome(args, result.error);
}

function fallbackQueryPlanOutcome(args: DeterministicPlanArgs, error: string): QueryPlanLlmOutcome {
  const plan = queryPlanFromFallbackRules(args);
  return {
    queries: plan.queries,
    model_query_count: plan.queries.filter((query) => query.kind !== "source_fallback").length,
    generatedBy: "rules",
    fallback: true,
    error,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
