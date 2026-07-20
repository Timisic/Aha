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
// The deterministic portion of query planning (fallback qmd object
// construction, sanitization/length limits, the deterministic source
// fallback query, and the rules-based query plan) now lives in
// obsidian-plugin/src/core/query-plan-deterministic.ts (ADR 0005, issue #56)
// and is consumed here through the compiled core artifact. Everything below
// that stays local (prompt construction, the LLM/agent adapters, caching) is
// the LLM query-planning portion left for issue #57.
import {
  MAX_QMD_HYDE_CHARS,
  MAX_QMD_INTENT_CHARS,
  MAX_QMD_LEX_CHARS,
  MAX_QMD_LEX_TERMS,
  MAX_QMD_VEC_CHARS,
  QUERY_PLAN_COMMANDS,
  QUERY_PLAN_KINDS,
  compactLine,
  deterministicSourceFallbackQuery,
  fallbackQmdObject,
  normalizeLex,
  normalizeQmdObject,
  normalizeQueryPlan,
  normalizeQueryPlanItem,
  qmdQueryFromObject,
  queryPlanFromFallbackRules,
  splitLexCandidates,
  unique,
} from "../lib/core-artifact.mjs";

export const QUERY_PLAN_PROMPT_VERSION = "aha-query-plan-v6";
export const QUERY_PLAN_SCHEMA_NAME = "aha_qmd_query_plan_agent";

export {
  compactLine,
  deterministicSourceFallbackQuery,
  fallbackQmdObject,
  normalizeLex,
  normalizeQmdObject,
  normalizeQueryPlan,
  normalizeQueryPlanItem,
  qmdQueryFromObject,
  splitLexCandidates,
  unique,
};

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

function withQueryPlanMetadata(plan, metadata) {
  const queries = plan.queries ?? [];
  return {
    ...plan,
    queries,
    query_object: queries[0]?.qmd,
    query_objects: queries.map((query) => query.qmd),
    model_query_count: plan.model_query_count ?? queries.filter((query) => query.kind !== "source_fallback").length,
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
