import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path, { dirname, join, resolve } from "node:path";
import {
  DEFAULT_OPENAI_API_KEY_ENV,
  DEFAULT_OPENAI_BASE_URL,
  DEFAULT_OPENAI_MODEL,
  runOpenAiJsonSync,
} from "../lib/openai-json-agent.mjs";

export const QUERY_PLAN_PROMPT_VERSION = "aha-query-plan-v2";
export const QUERY_PLAN_SCHEMA_NAME = "aha_qmd_query_plan_agent";

const QUERY_PLAN_KINDS = ["raw", "abstracted_judgment", "contextual", "explicit_cue", "bounds"];
const QUERY_PLAN_FALLBACK_KINDS = ["raw", "abstracted_judgment", "contextual", "explicit_cue"];
const QUERY_PLAN_COMMANDS = ["qmd query", "qmd search"];
const MAX_QMD_LEX_TERMS = 4;
const MAX_QMD_LEX_CHARS = 32;
const MAX_QMD_INTENT_CHARS = 180;
const MAX_QMD_VEC_CHARS = 360;
const MAX_QMD_HYDE_CHARS = 320;

const DEFAULT_INTENT =
  "只根据这段原始 /insight 输入，召回过往笔记中相关的旧经验、旧判断、反例、边界条件和相似关系模式；不要依赖人工标注答案。";

const DEFAULT_HYDE =
  "一篇相关旧笔记可能记录了与当前输入相似的经历、情绪结构、关系模式、旧判断变化、失败反例、边界条件或可复用的判断框架；它能帮助判断当前 insight 改变了什么、哪里不成立、下一步如何验证。";

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

export function compactLine(value, max = 900) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trim()}...`;
}

export function unique(values) {
  return Array.from(new Set(values.map((value) => String(value ?? "").trim()).filter(Boolean)));
}

export function splitLexCandidates(input) {
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

export function normalizeLex(lex) {
  if (Array.isArray(lex)) return lex.map((item) => compactLine(item, MAX_QMD_LEX_CHARS)).filter(Boolean);
  if (typeof lex === "string" && lex.trim()) return [compactLine(lex, MAX_QMD_LEX_CHARS)];
  return [];
}

export function defaultQueryGenerationOptions(overrides = {}) {
  const cleanOverrides = Object.fromEntries(
    Object.entries(overrides).filter(([, value]) => value !== undefined),
  );
  return {
    queryGenerator: process.env.AHA_BENCH_QUERY_GENERATOR || "agent",
    llmProvider: process.env.AHA_BENCH_LLM_PROVIDER || "openai",
    llmBaseUrl: process.env.AHA_BENCH_LLM_BASE_URL || DEFAULT_OPENAI_BASE_URL,
    llmModel: process.env.AHA_BENCH_LLM_MODEL || DEFAULT_OPENAI_MODEL,
    llmApiKeyEnv: process.env.AHA_BENCH_LLM_API_KEY_ENV || DEFAULT_OPENAI_API_KEY_ENV,
    queryAgentProvider: process.env.AHA_BENCH_QUERY_AGENT_PROVIDER || process.env.AHA_BENCH_LLM_PROVIDER || "openai",
    queryAgentBin: process.env.AHA_BENCH_QUERY_AGENT_BIN || "codex",
    queryAgentModel: process.env.AHA_BENCH_QUERY_AGENT_MODEL || "",
    queryAgentCache: process.env.AHA_BENCH_QUERY_AGENT_CACHE || "bench/generated/qmd-query-agent-cache.json",
    queryAgentFallback: process.env.AHA_BENCH_QUERY_AGENT_FALLBACK !== "0",
    queryAgentTimeoutMs: Number(process.env.AHA_BENCH_QUERY_AGENT_TIMEOUT_MS || 120_000),
    ...cleanOverrides,
  };
}

export async function generateQueryPlanWithAdapter({
  sourcePath,
  sourceText,
  adapter,
  fallbackAdapter = null,
  primaryName = "agent",
  fallbackName = "agent-fallback",
  displayName = primaryName,
} = {}) {
  const prompt = buildQueryPlanPrompt({ sourcePath }, sourceText);
  try {
    const output = await adapter({
      prompt,
      schema: QUERY_PLAN_SCHEMA,
      schemaName: QUERY_PLAN_SCHEMA_NAME,
      outputFileName: "query-plan.json",
      timeoutMs: 60_000,
    });
    return withQueryPlanMetadata(normalizeQueryPlan(parseJsonOutput(output), { sourcePath, displayName }, sourceText), {
      generatedBy: primaryName,
      fallback: false,
      error: null,
    });
  } catch (primaryError) {
    if (!fallbackAdapter) {
      throw new Error(`${displayName} query plan failed: ${primaryError.message}`);
    }
    try {
      const output = await fallbackAdapter({
        prompt,
        schema: QUERY_PLAN_SCHEMA,
        schemaName: QUERY_PLAN_SCHEMA_NAME,
        outputFileName: "query-plan.json",
        timeoutMs: 60_000,
      });
      return withQueryPlanMetadata(normalizeQueryPlan(parseJsonOutput(output), { sourcePath, displayName: fallbackName }, sourceText), {
        generatedBy: fallbackName,
        fallback: true,
        error: `${displayName} query plan failed: ${primaryError.message}; ${fallbackName} fallback used.`,
      });
    } catch (fallbackError) {
      throw new Error(`${displayName} query plan failed: ${primaryError.message}; ${fallbackName} fallback failed: ${fallbackError.message}`);
    }
  }
}

export function buildQueryPlanPrompt(args, sourceText) {
  const sourceSummary = queryPlanSourceSummary(args, sourceText);
  return [
    "你是 Aha/Pi /insight 的检索查询生成子 agent。",
    "只根据下面 source summary 生成 3-5 条 QMD 检索查询计划；不要读取文件、不要运行命令、不要搜索外部资料、不要检查仓库。",
    "",
    "目标：让 Aha 后续用 QMD 混合召回旧笔记中的旧判断、反例、边界条件、相似结构和明确线索。",
    "",
    "查询形态：",
    "- raw: 贴近原文的语义检索。",
    "- abstracted_judgment: 抽象出判断结构、关系模式、反例或边界。",
    "- contextual: 保留具体语境，但不引入 source note 之外的新事实。",
    "- explicit_cue: source note 里有明确实体、概念、短语时可用。",
    "- bounds: 主动找不成立、限制条件、相反经验。",
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

export function queryPlanSourceSummary(args, sourceText) {
  const title = path.basename(args.sourcePath || "source", ".md");
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

export function normalizeQueryPlan(value, args = {}, sourceText = "") {
  const rawQueries = Array.isArray(value?.queries) ? value.queries : [];
  const queries = [];
  const seen = new Set();
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
  return { queries };
}

export function normalizeQueryPlanItem(item, args = {}, sourceText = "", index = 0) {
  const kind = normalizeQueryKind(item?.kind, index);
  const command = normalizeQueryCommand(item?.command, kind);
  const qmd = normalizeQmdObject(item?.qmd, args, sourceText);
  const text = compactLine(item?.text || qmd.vec || qmd.lex.join(" "), 300);
  const query = queryTextForCommand(command, text, qmd);
  return {
    kind,
    command,
    text,
    query,
    qmd,
  };
}

export function normalizeQmdObject(value, args = {}, sourceText = "") {
  const fallback = fallbackQmdObject(args, sourceText);
  const lex = unique(Array.isArray(value?.lex) ? [...value.lex, ...fallback.lex] : fallback.lex)
    .map((item) => sanitizeQmdLine(item, MAX_QMD_LEX_CHARS))
    .filter((item) => item.length >= 1)
    .slice(0, MAX_QMD_LEX_TERMS);
  return {
    intent: sanitizeQmdLine(value?.intent || fallback.intent, MAX_QMD_INTENT_CHARS),
    lex: lex.length > 0 ? lex : fallback.lex.slice(0, MAX_QMD_LEX_TERMS),
    vec: sanitizeQmdLine(value?.vec || fallback.vec, MAX_QMD_VEC_CHARS),
    hyde: sanitizeQmdLine(value?.hyde || fallback.hyde, MAX_QMD_HYDE_CHARS),
  };
}

export function fallbackQmdObject(args = {}, sourceText = "") {
  const title = path.basename(args.sourcePath || args.id || "source", ".md");
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

export function qmdQueryFromObject(qmd) {
  const normalized = normalizeQmdObject(qmd);
  return [
    `intent: ${normalized.intent}`,
    ...normalized.lex.map((item) => `lex: ${item}`),
    `vec: ${normalized.vec}`,
    `hyde: ${normalized.hyde}`,
  ].join("\n");
}

export function resolveQmdQueryForCase(caseItem, options = {}) {
  const plan = resolveQmdQueriesForCase(caseItem, options);
  const first = plan.queries[0];
  return {
    query: first.query,
    query_object: first.qmd,
    query_generated_by: plan.query_generated_by,
    query_generation_fallback: plan.query_generation_fallback,
    query_generation_error: plan.query_generation_error,
    query_plan_prompt_version: plan.query_plan_prompt_version,
  };
}

export function resolveQmdQueriesForCase(caseItem, options = {}) {
  const queryOptions = defaultQueryGenerationOptions(options);
  const generator = String(queryOptions.queryGenerator || "agent").toLowerCase();
  const sourceText = String(caseItem._resolved_insight_input ?? "");
  if (generator === "rules") {
    return withQueryPlanMetadata(queryPlanFromFallbackRules(caseItem), {
      generatedBy: "rules",
      fallback: false,
      error: null,
    });
  }
  if (generator !== "agent") {
    throw new Error(`Unknown query generator: ${queryOptions.queryGenerator}`);
  }

  const cachePath = queryOptions.queryAgentCache ? resolve(queryOptions.queryAgentCache) : "";
  const cache = readQueryPlanCache(cachePath);
  const cacheKey = queryPlanCacheKey(caseItem, queryOptions);
  const cached = cache.entries[cacheKey]?.queries;
  if (Array.isArray(cached) && cached.length > 0) {
    return withQueryPlanMetadata(normalizeQueryPlan({ queries: cached }, caseItem, sourceText), {
      generatedBy: "agent-cache",
      fallback: false,
      error: null,
    });
  }

  try {
    const plan = generateQueryPlanWithAgentSync(caseItem, queryOptions);
    cache.entries[cacheKey] = {
      generated_at: new Date().toISOString(),
      generator: queryAgentProvider(queryOptions) === "openai" ? "openai-responses" : "codex-exec",
      prompt_version: QUERY_PLAN_PROMPT_VERSION,
      agent_provider: queryAgentProvider(queryOptions),
      agent_bin: queryOptions.queryAgentBin,
      agent_model: queryAgentModel(queryOptions),
      queries: plan.queries,
    };
    writeQueryPlanCache(cachePath, cache);
    return withQueryPlanMetadata(plan, {
      generatedBy: "agent",
      fallback: false,
      error: null,
    });
  } catch (error) {
    if (!queryOptions.queryAgentFallback) throw error;
    return withQueryPlanMetadata(queryPlanFromFallbackRules(caseItem), {
      generatedBy: "rules",
      fallback: true,
      error: error.message,
    });
  }
}

export function qmdQueryForCase(caseItem, options = {}) {
  return resolveQmdQueryForCase(caseItem, options).query;
}

function generateQueryPlanWithAgentSync(caseItem, options) {
  const prompt = buildQueryPlanPrompt({ sourcePath: caseItem.source_note_path || caseItem.id }, caseItem._resolved_insight_input);
  if (queryAgentProvider(options) === "openai") {
    return normalizeQueryPlan(parseJsonOutput(runOpenAiJsonSync({
      baseUrl: options.llmBaseUrl,
      model: queryAgentModel(options),
      apiKeyEnv: options.llmApiKeyEnv,
      prompt,
      schema: QUERY_PLAN_SCHEMA,
      schemaName: QUERY_PLAN_SCHEMA_NAME,
      timeoutMs: options.queryAgentTimeoutMs,
    })), caseItem, caseItem._resolved_insight_input);
  }

  if (!["codex", "codex-cli"].includes(queryAgentProvider(options))) {
    throw new Error(`${caseItem.id}: unknown query agent provider: ${options.queryAgentProvider}`);
  }

  const tmpRoot = mkdtempSync(join(tmpdir(), "aha-query-plan-agent-"));
  const schemaPath = join(tmpRoot, "schema.json");
  const outputPath = join(tmpRoot, "queries.json");
  writeFileSync(schemaPath, `${JSON.stringify(QUERY_PLAN_SCHEMA, null, 2)}\n`);

  const args = [
    "--ask-for-approval",
    "never",
    "exec",
    "--skip-git-repo-check",
    "--ephemeral",
    "--ignore-rules",
    "--sandbox",
    "read-only",
    "--output-schema",
    schemaPath,
    "-o",
    outputPath,
    "-C",
    tmpRoot,
  ];
  if (options.queryAgentModel) {
    args.push("-m", options.queryAgentModel);
  }
  args.push("-");

  try {
    const result = spawnSync(options.queryAgentBin || "codex", args, {
      input: prompt,
      encoding: "utf-8",
      timeout: options.queryAgentTimeoutMs,
      env: process.env,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      const stderr = String(result.stderr ?? "").trim();
      const stdout = String(result.stdout ?? "").trim();
      throw new Error(stderr || stdout || `query plan agent exited with ${result.status}`);
    }
    const output = existsSync(outputPath) ? readFileSync(outputPath, "utf-8") : result.stdout;
    return normalizeQueryPlan(parseJsonOutput(output), caseItem, caseItem._resolved_insight_input);
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
}

function queryPlanFromFallbackRules(caseItem) {
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

function queryObjectFromFallbackRules(caseItem) {
  return {
    intent: DEFAULT_INTENT,
    lex: splitLexCandidates(caseItem._resolved_insight_input),
    vec: compactLine(caseItem._resolved_insight_input, MAX_QMD_VEC_CHARS),
    hyde: DEFAULT_HYDE,
  };
}

function normalizeQueryKind(kind, index) {
  const value = String(kind ?? "").trim();
  if (QUERY_PLAN_KINDS.includes(value)) return value;
  return QUERY_PLAN_FALLBACK_KINDS[index] || "contextual";
}

function normalizeQueryCommand(command, kind) {
  const value = String(command ?? "").trim();
  if (QUERY_PLAN_COMMANDS.includes(value)) return value;
  return kind === "explicit_cue" ? "qmd search" : "qmd query";
}

function queryTextForCommand(command, text, qmd) {
  if (command === "qmd search") return compactLine(text || qmd.lex.join(" "), 300);
  return qmdQueryFromObject(qmd);
}

function sanitizeQmdLine(value, maxLength) {
  return compactLine(value, maxLength)
    .replace(/^(?:intent|lex|vec|hyde)\s*:\s*/i, "")
    .replace(/["`]+/g, "'")
    .replace(/^[*-]\s+/, "")
    .trim();
}

function withQueryPlanMetadata(plan, metadata) {
  const queries = plan.queries ?? [];
  return {
    ...plan,
    queries,
    query_object: queries[0]?.qmd,
    query_objects: queries.map((query) => query.qmd),
    query_generated_by: metadata.generatedBy,
    query_generation_fallback: metadata.fallback,
    query_generation_error: metadata.error,
    query_plan_prompt_version: QUERY_PLAN_PROMPT_VERSION,
  };
}

function parseJsonOutput(output) {
  if (output && typeof output === "object" && !Array.isArray(output)) return output;
  const text = String(output ?? "").trim();
  if (!text) throw new Error("query plan agent produced empty output.");
  try {
    return JSON.parse(text);
  } catch (firstError) {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw firstError;
    return JSON.parse(match[0]);
  }
}

function queryPlanCacheKey(caseItem, options) {
  const hash = createHash("sha256")
    .update(QUERY_PLAN_PROMPT_VERSION)
    .update("\0")
    .update(queryProviderCacheShape(options))
    .update("\0")
    .update(String(caseItem._resolved_insight_input ?? ""))
    .digest("hex");
  return `${caseItem.id}:${hash}`;
}

function queryAgentProvider(options) {
  return String(options.queryAgentProvider || options.llmProvider || "openai").toLowerCase();
}

function queryAgentModel(options) {
  return String(options.queryAgentModel || options.llmModel || DEFAULT_OPENAI_MODEL).trim() || DEFAULT_OPENAI_MODEL;
}

function queryProviderCacheShape(options) {
  const provider = queryAgentProvider(options);
  if (provider === "openai") {
    return JSON.stringify({
      provider,
      baseUrl: options.llmBaseUrl || DEFAULT_OPENAI_BASE_URL,
      model: queryAgentModel(options),
    });
  }
  return JSON.stringify({
    provider,
    bin: options.queryAgentBin || "codex",
    model: options.queryAgentModel || "",
  });
}

function readQueryPlanCache(cachePath) {
  if (!cachePath || !existsSync(cachePath)) {
    return {
      version: 1,
      prompt_version: QUERY_PLAN_PROMPT_VERSION,
      entries: {},
    };
  }
  try {
    const parsed = JSON.parse(readFileSync(cachePath, "utf-8"));
    return {
      version: 1,
      prompt_version: QUERY_PLAN_PROMPT_VERSION,
      entries: parsed?.entries && typeof parsed.entries === "object" ? parsed.entries : {},
    };
  } catch {
    return {
      version: 1,
      prompt_version: QUERY_PLAN_PROMPT_VERSION,
      entries: {},
    };
  }
}

function writeQueryPlanCache(cachePath, cache) {
  if (!cachePath) return;
  mkdirSync(dirname(resolve(cachePath)), { recursive: true });
  writeFileSync(resolve(cachePath), `${JSON.stringify(cache, null, 2)}\n`);
}
