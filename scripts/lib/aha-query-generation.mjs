import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

export function compactLine(value, max = 900) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trim()}...`;
}

export function unique(values) {
  return Array.from(new Set(values.filter(Boolean)));
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
      .split(/[\n\r，。；;、,.!?！？|/（）()【】\[\]《》<>：:]+/)
      .map((part) =>
        compactLine(
          part
            .replace(/^#+\s*/, "")
            .replace(/^>+\s*/, "")
            .replace(/\bWhy It Resonates\b/gi, "")
            .replace(/[*_`=]+/g, "")
            .trim(),
          32,
        ),
      )
      .filter((part) => part.length >= 2)
      .filter((part) => !/^[-#>*\s]+$/.test(part))
      .filter((part) => !/^(insight|why it resonates|summary)$/i.test(part))
      .filter((part) => !/^(source note|fresh thought)$/i.test(part)),
  ).slice(0, 5);
}

export function normalizeLex(lex) {
  if (Array.isArray(lex)) return lex.map((item) => compactLine(item, 48)).filter(Boolean);
  if (typeof lex === "string" && lex.trim()) return [compactLine(lex, 48)];
  return [];
}

const DEFAULT_INTENT =
  "只根据这段原始 /insight 输入，召回过往笔记中相关的旧经验、旧判断、反例、边界条件和相似关系模式；不要依赖人工标注答案。";

const DEFAULT_HYDE =
  "一篇相关旧笔记可能记录了与当前输入相似的经历、情绪结构、关系模式、旧判断变化、失败反例、边界条件或可复用的判断框架；它能帮助判断当前 insight 改变了什么、哪里不成立、下一步如何验证。";

const QMD_QUERY_OBJECT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["intent", "lex", "vec", "hyde"],
  properties: {
    intent: {
      type: "string",
      minLength: 8,
      maxLength: 500,
    },
    lex: {
      type: "array",
      minItems: 4,
      maxItems: 7,
      items: {
        type: "string",
        minLength: 2,
        maxLength: 48,
      },
    },
    vec: {
      type: "string",
      minLength: 20,
      maxLength: 900,
    },
    hyde: {
      type: "string",
      minLength: 20,
      maxLength: 900,
    },
  },
};

const AGENT_QUERY_SCHEMA = QMD_QUERY_OBJECT_SCHEMA;

const AGENT_QUERY_PLAN_SCHEMA = {
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
            enum: ["raw", "abstracted_judgment", "contextual", "explicit_cue", "bounds", "open-ended"],
          },
          command: {
            type: "string",
            enum: ["qmd query", "qmd vsearch", "qmd search"],
          },
          text: {
            type: "string",
            minLength: 2,
            maxLength: 300,
          },
          qmd: QMD_QUERY_OBJECT_SCHEMA,
        },
      },
    },
  },
};

const QUERY_AGENT_PROMPT_VERSION = "aha-qmd-query-agent-v1";
const QUERY_PLAN_AGENT_PROMPT_VERSION = "aha-qmd-query-plan-agent-v1";
const QUERY_PLAN_KINDS = ["raw", "abstracted_judgment", "contextual", "explicit_cue", "bounds", "open-ended"];
const QUERY_PLAN_FALLBACK_KINDS = ["raw", "abstracted_judgment", "contextual", "explicit_cue"];
const QUERY_PLAN_COMMANDS = ["qmd query", "qmd vsearch", "qmd search"];

export function defaultQueryGenerationOptions(overrides = {}) {
  const cleanOverrides = Object.fromEntries(
    Object.entries(overrides).filter(([, value]) => value !== undefined),
  );
  return {
    queryGenerator: process.env.AHA_BENCH_QUERY_GENERATOR || "agent",
    queryAgentBin: process.env.AHA_BENCH_QUERY_AGENT_BIN || "codex",
    queryAgentModel: process.env.AHA_BENCH_QUERY_AGENT_MODEL || "",
    queryAgentCache: process.env.AHA_BENCH_QUERY_AGENT_CACHE || "bench/generated/qmd-query-agent-cache.json",
    queryAgentFallback: process.env.AHA_BENCH_QUERY_AGENT_FALLBACK !== "0",
    queryAgentTimeoutMs: Number(process.env.AHA_BENCH_QUERY_AGENT_TIMEOUT_MS || 120_000),
    ...cleanOverrides,
  };
}

function queryObjectCacheKey(caseItem, options) {
  const hash = createHash("sha256")
    .update(QUERY_AGENT_PROMPT_VERSION)
    .update("\0")
    .update(String(options.queryAgentBin || "codex"))
    .update("\0")
    .update(String(options.queryAgentModel || ""))
    .update("\0")
    .update(String(caseItem._resolved_insight_input ?? ""))
    .digest("hex");
  return `${caseItem.id}:${hash}`;
}

function queryPlanCacheKey(caseItem, options) {
  const hash = createHash("sha256")
    .update(QUERY_PLAN_AGENT_PROMPT_VERSION)
    .update("\0")
    .update(String(options.queryAgentBin || "codex"))
    .update("\0")
    .update(String(options.queryAgentModel || ""))
    .update("\0")
    .update(String(caseItem._resolved_insight_input ?? ""))
    .digest("hex");
  return `${caseItem.id}:${hash}`;
}

function readQueryObjectCache(cachePath) {
  if (!cachePath || !existsSync(cachePath)) {
    return {
      version: 1,
      prompt_version: QUERY_AGENT_PROMPT_VERSION,
      entries: {},
    };
  }
  try {
    const parsed = JSON.parse(readFileSync(cachePath, "utf-8"));
    return {
      version: 1,
      prompt_version: QUERY_AGENT_PROMPT_VERSION,
      entries: parsed?.entries && typeof parsed.entries === "object" ? parsed.entries : {},
    };
  } catch {
    return {
      version: 1,
      prompt_version: QUERY_AGENT_PROMPT_VERSION,
      entries: {},
    };
  }
}

function writeQueryObjectCache(cachePath, cache) {
  if (!cachePath) return;
  mkdirSync(dirname(resolve(cachePath)), { recursive: true });
  writeFileSync(resolve(cachePath), `${JSON.stringify(cache, null, 2)}\n`);
}

function normalizeQueryObject(query) {
  return {
    intent: compactLine(query?.intent || DEFAULT_INTENT, 500),
    lex: unique(normalizeLex(query?.lex)).slice(0, 7),
    vec: compactLine(query?.vec || "", 900),
    hyde: compactLine(query?.hyde || DEFAULT_HYDE, 900),
  };
}

function assertAgentQueryObject(query, caseId) {
  if (!query || typeof query !== "object" || Array.isArray(query)) {
    throw new Error(`${caseId}: query agent did not return an object.`);
  }
  const normalized = normalizeQueryObject(query);
  if (!normalized.intent || normalized.intent.length < 8) {
    throw new Error(`${caseId}: query agent returned an invalid intent.`);
  }
  if (!Array.isArray(normalized.lex) || normalized.lex.length < 1) {
    throw new Error(`${caseId}: query agent returned no usable lex items.`);
  }
  if (!normalized.vec || normalized.vec.length < 20) {
    throw new Error(`${caseId}: query agent returned an invalid vec query.`);
  }
  if (!normalized.hyde || normalized.hyde.length < 20) {
    throw new Error(`${caseId}: query agent returned an invalid hyde query.`);
  }
  return normalized;
}

function queryAgentPrompt(caseItem) {
  return [
    "你是 Aha/Pi /insight 的检索查询生成子 agent。",
    "",
    "任务：只根据下面的 raw /insight input，生成一个 QMD 可用的结构化检索 query JSON。",
    "",
    "硬性约束：",
    "- 只能使用 raw input；不要读取本地文件，不要运行工具，不要搜索外部资料。",
    "- 你看不到、也不应该推断 must_recall / nice_to_have 标注答案。",
    "- 不要为了命中特定笔记而写标题式关键词；要抽取用户真实想找的旧经验、旧判断、关系模式、反例和边界条件。",
    "- 输出必须是 JSON，字段只包含 intent、lex、vec、hyde。",
    "",
    "字段要求：",
    "- intent: 中文一句话，说明这次要召回什么类型的旧笔记。",
    "- lex: 4-7 条短 lexical probes，每条 2-48 字；优先概念词、关系模式、重要实体或可搜索短语，不要整句照抄。",
    "- vec: 80-220 字左右的语义检索改写，保留核心判断和问题意识。",
    "- hyde: 80-220 字左右，描述一篇理想相关旧笔记可能长什么样。",
    "",
    `case_id: ${caseItem.id}`,
    "",
    "<raw_insight_input>",
    String(caseItem._resolved_insight_input ?? "").trim(),
    "</raw_insight_input>",
  ].join("\n");
}

function queryPlanAgentPrompt(caseItem) {
  return [
    "你是 Aha/Pi /insight 的检索查询生成子 agent。",
    "",
    "任务：只根据下面的 raw /insight input，生成 3-5 条 QMD 检索查询计划 JSON。",
    "",
    "硬性约束：",
    "- 只能使用 raw input；不要读取本地文件，不要运行工具，不要搜索外部资料。",
    "- 你看不到、也不应该推断 must_recall / nice_to_have 标注答案。",
    "- 不要为了命中特定笔记而写标题式关键词；要抽取用户真实想找的旧经验、旧判断、关系模式、反例和边界条件。",
    "- 每条查询都要包含 kind、command、text、qmd；qmd 字段只包含 intent、lex、vec、hyde。",
    "- command 默认用 qmd query；只有非常短的明确实体、概念、原句线索才用 qmd search。",
    "- text: qmd search 时是实际关键词；qmd query / qmd vsearch 时写这条查询的简短人类可读说明或 vec 摘要。",
    "- 输出必须是 JSON，字段只包含 queries。",
    "",
    "建议的 queries 形态：",
    "- raw: 贴近原始输入的语义检索。",
    "- abstracted_judgment: 抽出判断结构、关系模式、边界或反例。",
    "- contextual: 加入场景语境，但不要引入 raw input 之外的新事实。",
    "- explicit_cue: 如果 raw input 里有明确人名、概念、笔记式短语，可用 qmd search；否则继续用 qmd query。",
    "",
    "qmd 字段要求：",
    "- intent: 中文一句话，说明这条查询要召回什么类型的旧笔记。",
    "- lex: 4-7 条短 lexical probes，每条 2-48 字。",
    "- vec: 80-220 字左右的语义检索改写。",
    "- hyde: 80-220 字左右，描述一篇理想相关旧笔记可能长什么样。",
    "",
    `case_id: ${caseItem.id}`,
    "",
    "<raw_insight_input>",
    String(caseItem._resolved_insight_input ?? "").trim(),
    "</raw_insight_input>",
  ].join("\n");
}

function parseQueryAgentOutput(output, caseId) {
  const text = String(output ?? "").trim();
  if (!text) throw new Error(`${caseId}: query agent produced empty output.`);
  try {
    return assertAgentQueryObject(JSON.parse(text), caseId);
  } catch (firstError) {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw firstError;
    return assertAgentQueryObject(JSON.parse(match[0]), caseId);
  }
}

function generateQueryObjectWithAgent(caseItem, options) {
  const tmpRoot = mkdtempSync(join(tmpdir(), "aha-query-agent-"));
  const schemaPath = join(tmpRoot, "schema.json");
  const outputPath = join(tmpRoot, "query.json");
  writeFileSync(schemaPath, `${JSON.stringify(AGENT_QUERY_SCHEMA, null, 2)}\n`);

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
      input: queryAgentPrompt(caseItem),
      encoding: "utf-8",
      timeout: options.queryAgentTimeoutMs,
      env: process.env,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      const stderr = String(result.stderr ?? "").trim();
      const stdout = String(result.stdout ?? "").trim();
      throw new Error(stderr || stdout || `query agent exited with ${result.status}`);
    }
    const output = existsSync(outputPath) ? readFileSync(outputPath, "utf-8") : result.stdout;
    return parseQueryAgentOutput(output, caseItem.id);
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
}

function parseQueryPlanAgentOutput(output, caseItem) {
  const text = String(output ?? "").trim();
  if (!text) throw new Error(`${caseItem.id}: query plan agent produced empty output.`);
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (firstError) {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw firstError;
    parsed = JSON.parse(match[0]);
  }
  return assertQueryPlan(parsed, caseItem);
}

function generateQueryPlanWithAgent(caseItem, options) {
  const tmpRoot = mkdtempSync(join(tmpdir(), "aha-query-plan-agent-"));
  const schemaPath = join(tmpRoot, "schema.json");
  const outputPath = join(tmpRoot, "queries.json");
  writeFileSync(schemaPath, `${JSON.stringify(AGENT_QUERY_PLAN_SCHEMA, null, 2)}\n`);

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
      input: queryPlanAgentPrompt(caseItem),
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
    return parseQueryPlanAgentOutput(output, caseItem);
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
}

function queryObjectFromFallbackRules(caseItem) {
  return {
    intent: DEFAULT_INTENT,
    lex: splitLexCandidates(caseItem._resolved_insight_input),
    vec: compactLine(caseItem._resolved_insight_input, 900),
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

function searchTextForQueryObject(query, caseItem) {
  return compactLine(
    String(query?.text ?? "").trim() ||
      normalizeLex(query?.qmd?.lex).slice(0, 4).join(" ") ||
      query?.qmd?.vec ||
      caseItem._resolved_insight_input,
    300,
  );
}

function normalizeQueryPlanItem(item, caseItem, index) {
  const kind = normalizeQueryKind(item?.kind, index);
  const command = normalizeQueryCommand(item?.command, kind);
  const qmd = assertAgentQueryObject(item?.qmd, caseItem.id);
  const query = command === "qmd search"
    ? searchTextForQueryObject({ ...item, qmd }, caseItem)
    : qmdQueryFromObject(qmd, caseItem);
  return {
    kind,
    command,
    text: command === "qmd search" ? query : qmd.vec,
    query,
    qmd,
  };
}

function queryPlanFromFallbackRules(caseItem) {
  const base = normalizeQueryObject(queryObjectFromFallbackRules(caseItem));
  const rawInput = compactLine(caseItem._resolved_insight_input, 900);
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
      qmd: normalizeQueryObject({
        intent: "召回能解释、支持、挑战或限定当前 insight 判断结构的旧笔记。",
        lex: unique([...lex, "旧判断", "边界条件", "反例"]).slice(0, 7),
        vec: rawInput,
        hyde: "一篇相关旧笔记会记录类似判断如何形成、哪里被现实修正、哪些边界条件让原判断不再成立，以及这种变化如何影响后续选择。",
      }),
    },
    {
      kind: "contextual",
      command: "qmd query",
      qmd: normalizeQueryObject({
        intent: "召回和当前语境、经历场景、关系模式或行动选择相似的旧笔记。",
        lex: unique([...lex, "相似经历", "关系模式", "行动选择"]).slice(0, 7),
        vec: rawInput,
        hyde: "一篇相关旧笔记会包含相似场景中的真实经历、情绪线索、关系互动或行动取舍，能帮助用户比较这一次 insight 和过去经验之间的结构关系。",
      }),
    },
    {
      kind: "explicit_cue",
      command: "qmd search",
      text: lex.slice(0, 4).join(" ") || rawInput,
      qmd: normalizeQueryObject({
        intent: "召回 raw input 中出现的明确短语、概念或实体对应的旧笔记。",
        lex,
        vec: rawInput,
        hyde: base.hyde,
      }),
    },
  ];
  return { queries: plan.map((item, index) => normalizeQueryPlanItem(item, caseItem, index)) };
}

function assertQueryPlan(plan, caseItem) {
  const rawQueries = Array.isArray(plan?.queries) ? plan.queries : [];
  const normalized = [];
  const seen = new Set();

  for (const item of rawQueries) {
    const query = normalizeQueryPlanItem(item, caseItem, normalized.length);
    const key = `${query.command}\0${query.query}`;
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(query);
    if (normalized.length >= 5) break;
  }

  if (normalized.length < 3) {
    throw new Error(`${caseItem.id}: query plan agent returned fewer than 3 usable queries.`);
  }
  return { queries: normalized };
}

export function qmdQueryFromObject(query, caseItem) {
  const insight = compactLine(caseItem._resolved_insight_input, 900);
  const rawLex = splitLexCandidates(caseItem._resolved_insight_input);
  const intent =
    compactLine(query?.intent, 500) ||
    DEFAULT_INTENT;
  const providedLex = normalizeLex(query?.lex);
  const lex = unique([
    ...providedLex,
    ...(providedLex.length > 0 ? [] : rawLex),
    "旧判断",
    "反例 边界",
    "相似关系模式",
  ]).slice(0, 7);
  const vec = compactLine(query?.vec, 900) || insight;
  const hyde =
    compactLine(query?.hyde, 900) ||
    DEFAULT_HYDE;

  return [
    `intent: ${intent}`,
    ...lex.map((term) => `lex: ${term}`),
    `vec: ${vec}`,
    `hyde: ${hyde}`,
  ].join("\n");
}

export function resolveQmdQueryForCase(caseItem, options = {}) {
  const queryOptions = defaultQueryGenerationOptions(options);
  const generator = String(queryOptions.queryGenerator || "agent").toLowerCase();

  if (generator === "rules") {
    const queryObject = queryObjectFromFallbackRules(caseItem);
    return {
      query: qmdQueryFromObject(queryObject, caseItem),
      query_object: normalizeQueryObject(queryObject),
      query_generated_by: "rules",
      query_generation_fallback: false,
      query_generation_error: null,
    };
  }

  if (generator !== "agent") {
    throw new Error(`Unknown query generator: ${queryOptions.queryGenerator}`);
  }

  const cachePath = queryOptions.queryAgentCache ? resolve(queryOptions.queryAgentCache) : "";
  const cacheKey = queryObjectCacheKey(caseItem, queryOptions);
  const cache = readQueryObjectCache(cachePath);
  const cached = cache.entries[cacheKey]?.query;
  if (cached) {
    const queryObject = assertAgentQueryObject(cached, caseItem.id);
    return {
      query: qmdQueryFromObject(queryObject, caseItem),
      query_object: queryObject,
      query_generated_by: "agent-cache",
      query_generation_fallback: false,
      query_generation_error: null,
    };
  }

  try {
    const queryObject = generateQueryObjectWithAgent(caseItem, queryOptions);
    cache.entries[cacheKey] = {
      generated_at: new Date().toISOString(),
      generator: "codex-exec",
      prompt_version: QUERY_AGENT_PROMPT_VERSION,
      agent_bin: queryOptions.queryAgentBin,
      agent_model: queryOptions.queryAgentModel,
      query: queryObject,
    };
    writeQueryObjectCache(cachePath, cache);
    return {
      query: qmdQueryFromObject(queryObject, caseItem),
      query_object: queryObject,
      query_generated_by: "agent",
      query_generation_fallback: false,
      query_generation_error: null,
    };
  } catch (error) {
    if (!queryOptions.queryAgentFallback) throw error;
    const queryObject = queryObjectFromFallbackRules(caseItem);
    return {
      query: qmdQueryFromObject(queryObject, caseItem),
      query_object: normalizeQueryObject(queryObject),
      query_generated_by: "rules",
      query_generation_fallback: true,
      query_generation_error: error.message,
    };
  }
}

export function resolveQmdQueriesForCase(caseItem, options = {}) {
  const queryOptions = defaultQueryGenerationOptions(options);
  const generator = String(queryOptions.queryGenerator || "agent").toLowerCase();

  if (generator === "rules") {
    const plan = queryPlanFromFallbackRules(caseItem);
    return {
      queries: plan.queries,
      query: plan.queries[0]?.query ?? "",
      query_object: plan.queries[0]?.qmd ?? normalizeQueryObject(queryObjectFromFallbackRules(caseItem)),
      query_objects: plan.queries.map((query) => query.qmd),
      query_generated_by: "rules",
      query_generation_fallback: false,
      query_generation_error: null,
    };
  }

  if (generator !== "agent") {
    throw new Error(`Unknown query generator: ${queryOptions.queryGenerator}`);
  }

  const cachePath = queryOptions.queryAgentCache ? resolve(queryOptions.queryAgentCache) : "";
  const cacheKey = queryPlanCacheKey(caseItem, queryOptions);
  const cache = readQueryObjectCache(cachePath);
  const cached = cache.entries[cacheKey]?.queries;
  if (cached) {
    const plan = assertQueryPlan({ queries: cached }, caseItem);
    return {
      queries: plan.queries,
      query: plan.queries[0]?.query ?? "",
      query_object: plan.queries[0]?.qmd ?? null,
      query_objects: plan.queries.map((query) => query.qmd),
      query_generated_by: "agent-cache",
      query_generation_fallback: false,
      query_generation_error: null,
    };
  }

  try {
    const plan = generateQueryPlanWithAgent(caseItem, queryOptions);
    cache.entries[cacheKey] = {
      generated_at: new Date().toISOString(),
      generator: "codex-exec",
      prompt_version: QUERY_PLAN_AGENT_PROMPT_VERSION,
      agent_bin: queryOptions.queryAgentBin,
      agent_model: queryOptions.queryAgentModel,
      queries: plan.queries,
    };
    writeQueryObjectCache(cachePath, cache);
    return {
      queries: plan.queries,
      query: plan.queries[0]?.query ?? "",
      query_object: plan.queries[0]?.qmd ?? null,
      query_objects: plan.queries.map((query) => query.qmd),
      query_generated_by: "agent",
      query_generation_fallback: false,
      query_generation_error: null,
    };
  } catch (error) {
    if (!queryOptions.queryAgentFallback) throw error;
    const plan = queryPlanFromFallbackRules(caseItem);
    return {
      queries: plan.queries,
      query: plan.queries[0]?.query ?? "",
      query_object: plan.queries[0]?.qmd ?? normalizeQueryObject(queryObjectFromFallbackRules(caseItem)),
      query_objects: plan.queries.map((query) => query.qmd),
      query_generated_by: "rules",
      query_generation_fallback: true,
      query_generation_error: error.message,
    };
  }
}

export function qmdQueryForCase(caseItem, options = {}) {
  return resolveQmdQueryForCase(caseItem, options).query;
}
