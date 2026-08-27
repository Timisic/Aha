import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { validateAhaResult } from "./lib/result-validator.mjs";
import { compactLine } from "./query-plan.mjs";
import {
  DEFAULT_DEEPSEEK_API_KEY_ENV,
  DEFAULT_DEEPSEEK_BASE_URL,
  DEFAULT_DEEPSEEK_MODEL,
} from "../lib/openai-json-agent.mjs";
// The LLM round-trip (prompt construction, the llmJsonCall call, the
// validation-repair retry, quote-backed relation enforcement, merge, and
// final-slate composition/ordering) now lives in
// obsidian-plugin/src/core/relation-judge.ts (ADR 0005, issue #57) and is
// consumed here through the compiled core artifact — plugin and bench judge
// relations identically. Everything that stays local below is bench/Node
// infrastructure: file-based caching, chunking/concurrency across candidate
// batches, and CLI option parsing around the core LLM path.
import {
  AHA_RESULT_SCHEMA,
  RELATION_JUDGE_PROMPT_VERSION,
  annotateCandidateRerankIds as annotateCandidates,
  buildRelationJudgePrompt,
  buildRelationJudgeRepairPrompt,
  candidatePath,
  candidateSourceLabel,
  candidateSourceList,
  composeFinalSlate,
  enforceQuoteBackedRelation,
  hasQuoteEvidence,
  judgeRelationsRawViaLlm,
  mergeJudgedCandidates,
  normalizeStructuredResult,
  orderJudgedCandidates,
} from "../lib/core-artifact.mjs";

export const RELATION_JUDGE_SCHEMA_NAME = "aha_relation_judge";
export const DEFAULT_RELATION_JUDGE_CHUNK_SIZE = 20;
export const DEFAULT_RELATION_JUDGE_CONCURRENCY = 3;

export {
  RELATION_JUDGE_PROMPT_VERSION,
  buildRelationJudgePrompt,
  composeFinalSlate,
  enforceQuoteBackedRelation,
  hasQuoteEvidence,
  mergeJudgedCandidates,
  normalizeStructuredResult,
  orderJudgedCandidates,
};

export function defaultRelationJudgeOptions(overrides = {}) {
  const cleanOverrides = Object.fromEntries(
    Object.entries(overrides).filter(([, value]) => value !== undefined),
  );
  // AHA_BENCH_RERANK* names remain readable as deprecated fallbacks.
  const env = (name, legacy) => process.env[name] ?? process.env[legacy];
  return {
    relationJudgeMode: env("AHA_BENCH_RELATION_JUDGE_MODE", "AHA_BENCH_RERANKER") || "agent",
    llmProvider: process.env.AHA_BENCH_LLM_PROVIDER || "deepseek",
    llmBaseUrl: process.env.AHA_BENCH_LLM_BASE_URL || DEFAULT_DEEPSEEK_BASE_URL,
    llmModel: process.env.AHA_BENCH_LLM_MODEL || DEFAULT_DEEPSEEK_MODEL,
    llmApiKeyEnv: process.env.AHA_BENCH_LLM_API_KEY_ENV || DEFAULT_DEEPSEEK_API_KEY_ENV,
    relationJudgeAgentProvider: env("AHA_BENCH_RELATION_JUDGE_AGENT_PROVIDER", "AHA_BENCH_RERANK_AGENT_PROVIDER") || process.env.AHA_BENCH_LLM_PROVIDER || "deepseek",
    relationJudgeAgentModel: env("AHA_BENCH_RELATION_JUDGE_AGENT_MODEL", "AHA_BENCH_RERANK_AGENT_MODEL") || "",
    relationJudgeAgentCache: env("AHA_BENCH_RELATION_JUDGE_AGENT_CACHE", "AHA_BENCH_RERANK_AGENT_CACHE") || "bench/generated/relation-judge-cache.json",
    relationJudgeAgentFallback: env("AHA_BENCH_RELATION_JUDGE_AGENT_FALLBACK", "AHA_BENCH_RERANK_AGENT_FALLBACK") !== "0",
    relationJudgeAgentTimeoutMs: Number(env("AHA_BENCH_RELATION_JUDGE_AGENT_TIMEOUT_MS", "AHA_BENCH_RERANK_AGENT_TIMEOUT_MS") || 300_000),
    ...cleanOverrides,
  };
}

// Generic-adapter Relation Judge orchestration (covered by
// scripts/aha/tests/unit/relation-judge.test.mjs). The adapter callback
// stays provider-agnostic here; prompt construction, validation,
// quote-enforcement, and merging all come from core.
export async function judgeCandidateRelations({
  sourcePath,
  sourceText,
  candidates,
  candidateInputs,
  adapter,
  adapterName = "agent",
  preserveOrder = true,
} = {}) {
  const inputs = Array.isArray(candidateInputs) ? candidateInputs : [];
  if (inputs.length === 0) {
    return {
      ok: false,
      reviewedCount: 0,
      warnings: [],
      message: "Aha Relation Judge had no bounded candidate excerpts.",
      tool: "qmd",
      error: "No candidate excerpts were readable, so Relation Judge did not run.",
      candidates,
      relation_judge_prompt_version: RELATION_JUDGE_PROMPT_VERSION,
    };
  }

  const prompt = buildRelationJudgePrompt({ sourcePath, sourceText, candidateInputs: inputs });
  try {
    const output = await adapter({
      prompt,
      schema: AHA_RESULT_SCHEMA,
      schemaName: RELATION_JUDGE_SCHEMA_NAME,
      outputFileName: "relation-judge.json",
      timeoutMs: 120_000,
    });
    let parsed;
    let repaired = false;
    try {
      parsed = validatedRelationJudgeOutput(output);
    } catch (validationError) {
      repaired = true;
      const repairedOutput = await adapter({
        prompt: buildRelationJudgeRepairPrompt(prompt, validationError.message),
        schema: AHA_RESULT_SCHEMA,
        schemaName: RELATION_JUDGE_SCHEMA_NAME,
        outputFileName: "relation-judge.json",
        timeoutMs: 120_000,
      });
      parsed = validatedRelationJudgeOutput(repairedOutput);
    }
    const judged = mergeJudgedCandidates(candidates, parsed.candidates ?? [], inputs, { preserveOrder });
    return {
      ok: true,
      reviewedCount: inputs.length,
      warnings: [
        ...(repaired ? ["Relation Judge retried once after schema validation failed."] : []),
        ...(parsed.warnings ?? []).map((warning) => `Relation Judge: ${warning}`),
      ],
      candidates: judged,
      summary: parsed.summary,
      relation_judge_prompt_version: RELATION_JUDGE_PROMPT_VERSION,
      relation_judge_generated_by: adapterName,
    };
  } catch (error) {
    return {
      ok: false,
      reviewedCount: inputs.length,
      warnings: [],
      tool: adapterName,
      error: error.message,
      candidates,
      relation_judge_prompt_version: RELATION_JUDGE_PROMPT_VERSION,
      relation_judge_generated_by: adapterName,
    };
  }
}

function validatedRelationJudgeOutput(output) {
  const parsed = normalizeStructuredResult(parseJsonOutput(output));
  const validation = validateAhaResult(parsed);
  if (!validation.ok) throw new Error(validation.errors.join("; "));
  return parsed;
}

export async function relationJudgeCandidatesForCase(caseItem, candidates, options = {}) {
  const judgeOptions = defaultRelationJudgeOptions(options);
  const annotated = annotateCandidates(candidates).map(ensureBenchmarkCandidateShape);
  const judgeMode = String(judgeOptions.relationJudgeMode || "agent").toLowerCase();

  if (judgeMode === "none") {
    return relationJudgeResult({
      candidates: annotated,
      generatedBy: "none",
      fallback: false,
      error: null,
    });
  }
  if (judgeMode !== "agent") {
    throw new Error(`Unknown relation judge mode: ${judgeOptions.relationJudgeMode}`);
  }

  const candidateInputs = relationJudgeInputsForCase(caseItem, annotated);
  const cachePath = judgeOptions.relationJudgeAgentCache ? resolve(judgeOptions.relationJudgeAgentCache) : "";
  const cache = readRelationJudgeCache(cachePath);
  const cacheKey = relationJudgeCacheKey(caseItem, annotated, judgeOptions);
  const cachedCandidates = cache.entries[cacheKey]?.candidates;
  if (Array.isArray(cachedCandidates) && cachedCandidates.length > 0) {
    return relationJudgeResult({
      candidates: mergeJudgedCandidates(annotated, cachedCandidates, candidateInputs, { preserveOrder: false }),
      generatedBy: "agent-cache",
      fallback: false,
      error: null,
    });
  }

  try {
    const chunkSize = Math.max(4, Number(process.env.AHA_RELATION_JUDGE_CHUNK_SIZE || DEFAULT_RELATION_JUDGE_CHUNK_SIZE));
    const chunkCount = Math.ceil(candidateInputs.length / chunkSize);
    const chunks = [];
    for (let start = 0; start < candidateInputs.length; start += chunkSize) {
      chunks.push(candidateInputs.slice(start, start + chunkSize));
    }
    const chunkResults = await mapWithBoundedConcurrency(
      chunks,
      relationJudgeConcurrency(judgeOptions),
      (chunk) => generateRelationJudgeWithAgentAsync(caseItem, chunk, judgeOptions),
    );
    const judgedChunks = chunkResults.flat();
    let judgedCandidates = orderJudgedCandidates(judgedChunks, annotated);
    // Chunked judging grades on per-chunk curves; when several chunks each promote
    // many candidates, a final single-batch pass re-compares the strong ones globally.
    const strong = judgedCandidates.filter((candidate) => candidate.relation && candidate.relation !== "weak");
    if (chunkCount > 1 && strong.length > 10) {
      const inputByPath = new Map(candidateInputs.map((input) => [input.notePath, input]));
      const strongInputs = strong
        .map((candidate) => inputByPath.get(candidate.notePath))
        .filter(Boolean)
        .slice(0, 2 * chunkSize);
      if (strongInputs.length > 0) {
        const rejudged = await generateRelationJudgeWithAgentAsync(caseItem, strongInputs, judgeOptions);
        const rejudgedPaths = new Set(rejudged.map((candidate) => candidate.notePath));
        const rest = judgedCandidates.filter((candidate) => !rejudgedPaths.has(candidate.notePath));
        judgedCandidates = [
          ...rejudged.filter((candidate) => candidate.relation && candidate.relation !== "weak"),
          ...orderJudgedCandidates([
            ...rejudged.filter((candidate) => !candidate.relation || candidate.relation === "weak"),
            ...rest,
          ], annotated),
        ];
      }
    }
    judgedCandidates = composeFinalSlate(judgedCandidates, annotated);
    cache.entries[cacheKey] = {
      generated_at: new Date().toISOString(),
      generator: "deepseek-chat-completions",
      prompt_version: RELATION_JUDGE_PROMPT_VERSION,
      agent_provider: relationJudgeProvider(judgeOptions),
      agent_model: relationJudgeModel(judgeOptions),
      candidates: judgedCandidates,
    };
    writeRelationJudgeCache(cachePath, cache);
    return relationJudgeResult({
      candidates: mergeJudgedCandidates(annotated, judgedCandidates, candidateInputs, { preserveOrder: false }),
      generatedBy: "agent",
      fallback: false,
      error: null,
    });
  } catch (error) {
    if (!judgeOptions.relationJudgeAgentFallback) throw error;
    return relationJudgeResult({
      candidates: annotated,
      generatedBy: "none",
      fallback: true,
      error: error.message,
    });
  }
}

// The judge can misread a genuinely relevant note; retrieval rank is an
// independent signal. Reserve a couple of slots per block of ten for the
// best remaining retrieval-ranked candidates so a judge false-weak on a
// pool-top note cannot exile it from the review budget.
//
// composeFinalSlate itself now lives in core (imported above); this local
// re-export keeps the AHA_SLATE_POOL_RESERVE env override working exactly as
// before (core cannot read process.env — see core-artifact.mjs's binding).

function relationJudgeInputsForCase(caseItem, candidates) {
  return candidates.map((candidate) => ({
    notePath: candidate.notePath,
    noteTitle: candidate.noteTitle,
    retrievalHit: candidate.hit,
    retrievalWhy: candidate.why,
    excerpt: compactLine(candidate.content ?? candidate.snippet ?? candidate.hit ?? "", 1400),
  })).filter((candidate) => candidate.notePath && candidate.excerpt);
}

function ensureBenchmarkCandidateShape(candidate) {
  const notePath = candidatePath(candidate);
  const noteTitle = candidate.title || candidate.noteTitle || notePath.split("/").pop()?.replace(/\.md$/i, "") || notePath;
  const hit = compactLine(candidate.content ?? candidate.snippet ?? candidate.hit ?? candidateSourceLabel(candidate), 220) || "Candidate surfaced by benchmark retrieval.";
  return {
    ...candidate,
    notePath,
    noteTitle,
    relation: candidate.relation || "weak",
    hit,
    why: candidate.why || `Benchmark retrieval surfaced this candidate from ${candidateSourceLabel(candidate)}; relation is pending quote-backed judging.`,
    quotes: Array.isArray(candidate.quotes) ? candidate.quotes : [],
    selected: candidate.selected ?? true,
  };
}

function relationJudgeResult({ candidates, generatedBy, fallback, error }) {
  const rankedIds = candidates.map((candidate) => candidate.rerankId).filter(Boolean);
  return {
    candidates,
    relation_judge_generated_by: generatedBy,
    relation_judge_fallback: fallback,
    relation_judge_error: error,
    relation_judge_ranked_ids: rankedIds,
    relation_judge_prompt_version: RELATION_JUDGE_PROMPT_VERSION,
  };
}

function relationJudgeConcurrency() {
  return Math.max(1, Number(process.env.AHA_RELATION_JUDGE_CONCURRENCY || DEFAULT_RELATION_JUDGE_CONCURRENCY));
}

// Runs the worker over items with at most `limit` in flight. Results keep
// item order. All lanes settle before an error is rethrown, so a failing
// chunk cannot leave unhandled rejections behind.
export async function mapWithBoundedConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  const errors = [];
  let nextIndex = 0;
  const lanes = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      try {
        results[index] = await worker(items[index], index);
      } catch (error) {
        errors.push({ index, error });
        return;
      }
    }
  });
  await Promise.all(lanes);
  if (errors.length > 0) {
    errors.sort((left, right) => left.index - right.index);
    throw errors[0].error;
  }
  return results;
}

// Dispatches to the core HTTP-only LLM path (issue #57). Throws on any
// failure; relationJudgeCandidatesForCase decides whether to fall back
// (relationJudgeAgentFallback).
async function generateRelationJudgeWithAgentAsync(caseItem, candidateInputs, options) {
  if (relationJudgeProvider(options) !== "deepseek") {
    throw new Error(`${caseItem.id}: unknown relation judge provider: ${options.relationJudgeAgentProvider}`);
  }
  const apiKeyEnv = String(options.llmApiKeyEnv || DEFAULT_DEEPSEEK_API_KEY_ENV).trim() || DEFAULT_DEEPSEEK_API_KEY_ENV;
  const apiKey = process.env[apiKeyEnv];
  if (!apiKey) throw new Error(`${apiKeyEnv} is not set.`);
  const raw = await judgeRelationsRawViaLlm({
    sourcePath: caseItem.source_note_path || caseItem.id,
    sourceText: caseItem._resolved_insight_input,
    candidateInputs,
  }, {
    baseUrl: options.llmBaseUrl,
    apiKey,
    model: relationJudgeModel(options),
    protocol: "chat-completions",
    thinking: "disabled",
    timeoutMs: options.relationJudgeAgentTimeoutMs,
  });
  if (!raw.ok) throw new Error(raw.error);
  return raw.candidates;
}

// Only used by the generic-adapter path (judgeCandidateRelations, which
// accepts arbitrary text-returning adapters). The core HTTP-only path
// (judgeRelationsRawViaLlm / judgeCandidateRelationsViaLlm, via llmJsonCall)
// does its own JSON parsing/extraction internally, so this is not a second
// implementation of that parsing — it is the one remaining parser for
// non-HTTP adapter output.
function parseJsonOutput(output) {
  if (output && typeof output === "object" && !Array.isArray(output)) return output;
  const text = String(output ?? "").trim();
  if (!text) throw new Error("relation judge produced empty output.");
  try {
    return JSON.parse(text);
  } catch (firstError) {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw firstError;
    return JSON.parse(match[0]);
  }
}

function relationJudgeCacheKey(caseItem, candidates, options) {
  const hash = createHash("sha256")
    .update(RELATION_JUDGE_PROMPT_VERSION)
    .update("\0")
    .update(relationJudgeProviderCacheShape(options))
    .update("\0")
    .update(String(caseItem._resolved_insight_input ?? ""))
    .update("\0")
    .update(JSON.stringify(caseItem.query_object ?? {}))
    .update("\0")
    .update(JSON.stringify(caseItem.query_objects ?? []))
    .update("\0")
    .update(JSON.stringify(caseItem.queries ?? []))
    .update("\0")
    .update(JSON.stringify(candidates.map(candidateCacheShape)))
    .digest("hex");
  return `${caseItem.id}:${hash}`;
}

function candidateCacheShape(candidate) {
  return {
    id: candidate.rerankId,
    title: candidate.title,
    file: candidatePath(candidate),
    source: candidate.source,
    sources: candidateSourceList(candidate),
    expansionFrom: candidate.expansionFrom,
    content: compactLine(candidate.content ?? candidate.hit ?? "", 500),
  };
}

function relationJudgeProvider(options) {
  return String(options.relationJudgeAgentProvider || options.llmProvider || "deepseek").toLowerCase();
}

function relationJudgeModel(options) {
  return String(options.relationJudgeAgentModel || options.llmModel || DEFAULT_DEEPSEEK_MODEL).trim() || DEFAULT_DEEPSEEK_MODEL;
}

function relationJudgeProviderCacheShape(options) {
  const provider = relationJudgeProvider(options);
  return JSON.stringify({
    provider,
    baseUrl: options.llmBaseUrl || DEFAULT_DEEPSEEK_BASE_URL,
    model: relationJudgeModel(options),
  });
}

function readRelationJudgeCache(cachePath) {
  if (!cachePath || !existsSync(cachePath)) {
    return {
      version: 1,
      prompt_version: RELATION_JUDGE_PROMPT_VERSION,
      entries: {},
    };
  }
  try {
    const parsed = JSON.parse(readFileSync(cachePath, "utf-8"));
    return {
      version: 1,
      prompt_version: RELATION_JUDGE_PROMPT_VERSION,
      entries: parsed?.entries && typeof parsed.entries === "object" ? parsed.entries : {},
    };
  } catch {
    return {
      version: 1,
      prompt_version: RELATION_JUDGE_PROMPT_VERSION,
      entries: {},
    };
  }
}

function writeRelationJudgeCache(cachePath, cache) {
  if (!cachePath) return;
  mkdirSync(dirname(resolve(cachePath)), { recursive: true });
  writeFileSync(resolve(cachePath), `${JSON.stringify(cache, null, 2)}\n`);
}
