import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  DEFAULT_DEEPSEEK_API_KEY_ENV,
  DEFAULT_DEEPSEEK_BASE_URL,
  DEFAULT_DEEPSEEK_MODEL,
} from "../lib/openai-json-agent.mjs";
// The deterministic portion of query planning (fallback qmd object
// construction, sanitization/length limits, the deterministic source
// fallback query, and the rules-based query plan) lives in
// obsidian-plugin/src/core/query-plan-deterministic.ts (ADR 0005, issue #56).
// The LLM portion (prompt construction, the llmJsonCall round-trip, and
// fallback-on-failure wiring) now lives in
// obsidian-plugin/src/core/query-plan-llm.ts (issue #57) and is consumed here
// through the compiled core artifact, exactly like the deterministic pieces.
// Everything that stays local below is bench/Node infrastructure: file-based
// caching and CLI option parsing around the core LLM path (HTTP-only via
// llmJsonCall).
import {
  QUERY_PLAN_PROMPT_VERSION,
  QUERY_PLAN_SCHEMA,
  QUERY_PLAN_SCHEMA_NAME,
  buildQueryPlanPrompt,
  compactLine,
  deterministicSourceFallbackQuery,
  fallbackQmdObject,
  generateQueryPlanViaLlm,
  normalizeLex,
  normalizeQmdObject,
  normalizeQueryPlan,
  normalizeQueryPlanItem,
  qmdQueryFromObject,
  queryPlanFromFallbackRules,
  queryPlanSourceSummary,
  splitLexCandidates,
  unique,
} from "../lib/core-artifact.mjs";

export {
  QUERY_PLAN_PROMPT_VERSION,
  QUERY_PLAN_SCHEMA,
  QUERY_PLAN_SCHEMA_NAME,
  buildQueryPlanPrompt,
  compactLine,
  deterministicSourceFallbackQuery,
  fallbackQmdObject,
  normalizeLex,
  normalizeQmdObject,
  normalizeQueryPlan,
  normalizeQueryPlanItem,
  qmdQueryFromObject,
  queryPlanSourceSummary,
  splitLexCandidates,
  unique,
};

export function defaultQueryGenerationOptions(overrides = {}) {
  const cleanOverrides = Object.fromEntries(
    Object.entries(overrides).filter(([, value]) => value !== undefined),
  );
  return {
    queryGenerator: process.env.AHA_BENCH_QUERY_GENERATOR || "agent",
    llmProvider: process.env.AHA_BENCH_LLM_PROVIDER || "deepseek",
    llmBaseUrl: process.env.AHA_BENCH_LLM_BASE_URL || DEFAULT_DEEPSEEK_BASE_URL,
    llmModel: process.env.AHA_BENCH_LLM_MODEL || DEFAULT_DEEPSEEK_MODEL,
    llmApiKeyEnv: process.env.AHA_BENCH_LLM_API_KEY_ENV || DEFAULT_DEEPSEEK_API_KEY_ENV,
    queryAgentProvider: process.env.AHA_BENCH_QUERY_AGENT_PROVIDER || process.env.AHA_BENCH_LLM_PROVIDER || "deepseek",
    queryAgentModel: process.env.AHA_BENCH_QUERY_AGENT_MODEL || "",
    queryAgentCache: process.env.AHA_BENCH_QUERY_AGENT_CACHE || "bench/generated/qmd-query-agent-cache.json",
    queryAgentFallback: process.env.AHA_BENCH_QUERY_AGENT_FALLBACK !== "0",
    queryAgentTimeoutMs: Number(process.env.AHA_BENCH_QUERY_AGENT_TIMEOUT_MS || 120_000),
    ...cleanOverrides,
  };
}

// Generic-adapter query-plan orchestration (bench/legacy entry point used
// directly by scripts/aha/run-insight-search.mjs, the frozen legacy wrapper,
// and covered by scripts/aha/tests/unit/query-plan.test.mjs). The adapter callback
// stays provider-agnostic here; prompt construction and normalization come
// from core.
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

export async function resolveQmdQueryForCase(caseItem, options = {}) {
  const plan = await resolveQmdQueriesForCase(caseItem, options);
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

// Resolves the query plan for one benchmark case: rules generator short
// circuits to the deterministic fallback rules (#56); agent generator tries
// the cache, then the configured LLM provider (routed through the core
// llmJsonCall path), falling back to the deterministic rules on failure when
// queryAgentFallback is enabled (the default).
export async function resolveQmdQueriesForCase(caseItem, options = {}) {
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
    const plan = await generateQueryPlanWithAgent(caseItem, queryOptions);
    cache.entries[cacheKey] = {
      generated_at: new Date().toISOString(),
      generator: "deepseek-chat-completions",
      prompt_version: QUERY_PLAN_PROMPT_VERSION,
      agent_provider: queryAgentProvider(queryOptions),
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

export async function qmdQueryForCase(caseItem, options = {}) {
  return (await resolveQmdQueryForCase(caseItem, options)).query;
}

// Dispatches to the core HTTP-only LLM path (issue #57). Throws on any
// failure; the caller (resolveQmdQueriesForCase) decides whether to fall
// back to the deterministic rules plan.
async function generateQueryPlanWithAgent(caseItem, options) {
  if (queryAgentProvider(options) !== "deepseek") {
    throw new Error(`${caseItem.id}: unknown query agent provider: ${options.queryAgentProvider}`);
  }
  const apiKeyEnv = String(options.llmApiKeyEnv || DEFAULT_DEEPSEEK_API_KEY_ENV).trim() || DEFAULT_DEEPSEEK_API_KEY_ENV;
  const apiKey = process.env[apiKeyEnv];
  if (!apiKey) throw new Error(`${apiKeyEnv} is not set.`);
  const outcome = await generateQueryPlanViaLlm(caseItem, caseItem._resolved_insight_input, {
    baseUrl: options.llmBaseUrl,
    apiKey,
    model: queryAgentModel(options),
    protocol: "chat-completions",
    thinking: "disabled",
    timeoutMs: options.queryAgentTimeoutMs,
  });
  if (outcome.fallback) {
    throw new Error(`DeepSeek query plan failed: ${outcome.error}`);
  }
  return { queries: outcome.queries, model_query_count: outcome.model_query_count };
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

// Only used by the generic-adapter path (generateQueryPlanWithAdapter, which
// accepts arbitrary text-returning adapters). The core HTTP-only path
// (generateQueryPlanViaLlm, via llmJsonCall) does its own JSON
// parsing/extraction internally, so this is not a second implementation of
// that parsing — it is the one remaining parser for non-HTTP adapter output.
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
  return String(options.queryAgentProvider || options.llmProvider || "deepseek").toLowerCase();
}

function queryAgentModel(options) {
  return String(options.queryAgentModel || options.llmModel || DEFAULT_DEEPSEEK_MODEL).trim() || DEFAULT_DEEPSEEK_MODEL;
}

function queryProviderCacheShape(options) {
  const provider = queryAgentProvider(options);
  return JSON.stringify({
    provider,
    baseUrl: options.llmBaseUrl || DEFAULT_DEEPSEEK_BASE_URL,
    model: queryAgentModel(options),
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
