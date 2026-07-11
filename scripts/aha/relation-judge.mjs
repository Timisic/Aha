import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { validateAhaResult } from "./lib/result-validator.mjs";
import {
  annotateCandidateRerankIds as annotateCandidates,
  candidatePath,
  candidateSourceLabel,
  candidateSourceList,
} from "../lib/candidate-fields.mjs";
import { compactLine } from "./query-plan.mjs";
import {
  DEFAULT_OPENAI_API_KEY_ENV,
  DEFAULT_OPENAI_BASE_URL,
  DEFAULT_OPENAI_MODEL,
  runOpenAiJsonAsync,
  runOpenAiJsonSync,
} from "../lib/openai-json-agent.mjs";

export const RELATION_JUDGE_PROMPT_VERSION = "aha-relation-judge-v4";
export const RELATION_JUDGE_SCHEMA_NAME = "aha_relation_judge";
export const DEFAULT_RELATION_JUDGE_CHUNK_SIZE = 20;
export const DEFAULT_RELATION_JUDGE_CONCURRENCY = 3;

const RELATION_STRENGTH = {
  supports: 3,
  challenges: 3,
  bounds: 2.5,
  resembles: 2.5,
  weak: 1,
};

const RESULT_SCHEMA = JSON.parse(readFileSync(
  new URL("./aha-result.schema.json", import.meta.url),
  "utf-8",
));

export function defaultRelationJudgeOptions(overrides = {}) {
  const cleanOverrides = Object.fromEntries(
    Object.entries(overrides).filter(([, value]) => value !== undefined),
  );
  // AHA_BENCH_RERANK* names remain readable as deprecated fallbacks.
  const env = (name, legacy) => process.env[name] ?? process.env[legacy];
  return {
    relationJudgeMode: env("AHA_BENCH_RELATION_JUDGE_MODE", "AHA_BENCH_RERANKER") || "agent",
    llmProvider: process.env.AHA_BENCH_LLM_PROVIDER || "openai",
    llmBaseUrl: process.env.AHA_BENCH_LLM_BASE_URL || DEFAULT_OPENAI_BASE_URL,
    llmModel: process.env.AHA_BENCH_LLM_MODEL || DEFAULT_OPENAI_MODEL,
    llmApiKeyEnv: process.env.AHA_BENCH_LLM_API_KEY_ENV || DEFAULT_OPENAI_API_KEY_ENV,
    relationJudgeAgentProvider: env("AHA_BENCH_RELATION_JUDGE_AGENT_PROVIDER", "AHA_BENCH_RERANK_AGENT_PROVIDER") || process.env.AHA_BENCH_LLM_PROVIDER || "openai",
    relationJudgeAgentBin: env("AHA_BENCH_RELATION_JUDGE_AGENT_BIN", "AHA_BENCH_RERANK_AGENT_BIN") || "codex",
    relationJudgeAgentModel: env("AHA_BENCH_RELATION_JUDGE_AGENT_MODEL", "AHA_BENCH_RERANK_AGENT_MODEL") || "",
    relationJudgeAgentCache: env("AHA_BENCH_RELATION_JUDGE_AGENT_CACHE", "AHA_BENCH_RERANK_AGENT_CACHE") || "bench/generated/relation-judge-cache.json",
    relationJudgeAgentFallback: env("AHA_BENCH_RELATION_JUDGE_AGENT_FALLBACK", "AHA_BENCH_RERANK_AGENT_FALLBACK") !== "0",
    relationJudgeAgentTimeoutMs: Number(env("AHA_BENCH_RELATION_JUDGE_AGENT_TIMEOUT_MS", "AHA_BENCH_RERANK_AGENT_TIMEOUT_MS") || 300_000),
    ...cleanOverrides,
  };
}

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
      schema: RESULT_SCHEMA,
      schemaName: RELATION_JUDGE_SCHEMA_NAME,
      outputFileName: "relation-judge.json",
      timeoutMs: 120_000,
    });
    const parsed = normalizeStructuredResult(parseJsonOutput(output));
    const validation = validateAhaResult(parsed);
    if (!validation.ok) {
      throw new Error(validation.errors.join("; "));
    }
    const judged = mergeJudgedCandidates(candidates, parsed.candidates ?? [], inputs, { preserveOrder });
    return {
      ok: true,
      reviewedCount: inputs.length,
      warnings: (parsed.warnings ?? []).map((warning) => `Relation Judge: ${warning}`),
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

export function buildRelationJudgePrompt({ sourcePath, sourceText, candidateInputs }) {
  return [
    "You are the bounded Aha Relation Judge.",
    "Do not read files, run tools, or use external knowledge. Judge only from the source summary and candidate excerpts below.",
    "Return JSON only. It must match the output schema.",
    "",
    "Relation rules:",
    "- Use supports, challenges, resembles, or bounds only when the candidate excerpt contains a concrete quote that justifies the label.",
    "- A strong label means the quoted evidence acts on the current insight's judgment: supports it, challenges it, bounds it, or maps its structure. Topical closeness with no such action is weak.",
    "- Counter-material is first-class: when the source insight is looking for its own patterns, lessons, or things to improve, old notes recording failures, conflicts, or opposite experiences act on that judgment directly — label them challenges or bounds, not weak.",
    "- When ranking candidates, prefer notes that deposit durable judgments, lessons, patterns, or boundaries over notes that merely log events, market moves, or daily happenings on the same topic.",
    "- Use weak when the excerpt is only topically similar, too thin, or lacks quote evidence.",
    "- hit must be a short quote or exact snippet from the candidate excerpt.",
    "- why must explain why this old note matters for the current source insight, not just restate retrieval score.",
    "- why and summary should be written primarily in Chinese when the source or candidate excerpt is Chinese. Keep JSON keys and relation labels in English.",
    "- Write why as a compact, note-like bridge: lead with the concrete idea or tension, not with a generic phrase about the candidate.",
    "- Avoid formulaic openings such as “这条旧笔记…”, “这条笔记…”, “这条候选…”, or “直接支撑当前 source…”. Do not reuse the same sentence frame across candidates.",
    "- Preserve the candidate notePath values exactly.",
    "",
    `sourcePath: ${sourcePath}`,
    "sourceSummary:",
    sourceSummaryForRelationJudge(sourcePath, sourceText).slice(0, 3500),
    "",
    "candidates:",
    JSON.stringify(candidateInputs, null, 2),
    "",
    "Return this JSON shape:",
    JSON.stringify({
      ok: true,
      sourcePath,
      generatedAt: null,
      summary: "简短说明这一轮关系判断的结果",
      warnings: [],
      error: null,
      candidates: [
        {
          notePath: "same candidate notePath",
          noteTitle: "candidate title",
          relation: "weak",
          hit: "short quote/snippet from excerpt",
          why: "用自然中文点出旧判断和当前 insight 的具体连接，或说明为什么只能算 weak。",
          quotes: ["optional exact quote from excerpt"],
          selected: true,
        },
      ],
    }, null, 2),
  ].join("\n");
}

export function mergeJudgedCandidates(retrievalCandidates, judgedCandidates, candidateInputs, options = {}) {
  const preserveOrder = options.preserveOrder !== false;
  const excerpts = new Map(candidateInputs.map((candidate) => [
    candidate.notePath,
    `${candidate.excerpt}\n${candidate.retrievalHit ?? ""}`,
  ]));
  const retrievalByPath = new Map((retrievalCandidates ?? []).map((candidate) => [candidate.notePath, candidate]));
  const judgedByPath = new Map();
  for (const candidate of judgedCandidates ?? []) {
    if (!candidate?.notePath) continue;
    judgedByPath.set(candidate.notePath, candidate);
  }

  const mergeOne = (retrievalCandidate) => {
    const judged = judgedByPath.get(retrievalCandidate.notePath);
    if (!judged) return retrievalCandidate;
    const merged = {
      ...retrievalCandidate,
      ...judged,
      notePath: retrievalCandidate.notePath,
      noteTitle: judged.noteTitle || retrievalCandidate.noteTitle || retrievalCandidate.title,
      selected: judged.selected ?? true,
      quotes: Array.isArray(judged.quotes) ? judged.quotes : [],
    };
    return enforceQuoteBackedRelation(merged, excerpts.get(retrievalCandidate.notePath) || "");
  };

  if (preserveOrder) return (retrievalCandidates ?? []).map(mergeOne);

  const ordered = [];
  const seen = new Set();
  for (const judged of judgedCandidates ?? []) {
    const retrievalCandidate = retrievalByPath.get(judged?.notePath);
    if (!retrievalCandidate || seen.has(retrievalCandidate.notePath)) continue;
    ordered.push(mergeOne(retrievalCandidate));
    seen.add(retrievalCandidate.notePath);
  }
  for (const retrievalCandidate of retrievalCandidates ?? []) {
    if (seen.has(retrievalCandidate.notePath)) continue;
    ordered.push(mergeOne(retrievalCandidate));
  }
  return ordered;
}

export function enforceQuoteBackedRelation(candidate, excerpt) {
  if (candidate.relation === "weak") return candidate;
  if (hasQuoteEvidence(candidate, excerpt)) return candidate;
  return {
    ...candidate,
    relation: "weak",
    why: `${candidate.why} Downgraded to weak because the bounded excerpt did not contain the returned quote evidence.`,
    quotes: [],
  };
}

export function hasQuoteEvidence(candidate, excerpt) {
  const haystack = normalizeEvidenceText(excerpt);
  const haystackFingerprint = evidenceFingerprint(excerpt);
  const needles = [
    candidate.hit,
    ...(Array.isArray(candidate.quotes) ? candidate.quotes : []),
  ]
    .map((value) => normalizeEvidenceText(value).replace(/^["'“”‘’]+|["'“”‘’]+$/g, ""))
    .filter((value) => value.length >= 8);
  return needles.some((needle) => {
    if (haystack.includes(needle)) return true;
    const fingerprint = evidenceFingerprint(needle);
    return fingerprint.length >= 8 && haystackFingerprint.includes(fingerprint);
  });
}

export async function relationJudgeCandidatesForCase(caseItem, candidates, options = {}) {
  const judgeOptions = defaultRelationJudgeOptions(options);
  const annotatedCandidates = annotateCandidates(candidates);
  const annotated = annotatedCandidates.map(ensureBenchmarkCandidateShape);
  const judgeMode = String(judgeOptions.relationJudgeMode || "agent").toLowerCase();

  if (judgeMode === "none") {
    return relationJudgeResult({
      candidates: annotated,
      reviewedCandidates: [],
      generatedBy: "none",
      fallback: false,
      error: null,
    });
  }
  if (judgeMode !== "agent") {
    throw new Error(`Unknown relation judge mode: ${judgeOptions.relationJudgeMode}`);
  }

  const candidateInputs = relationJudgeInputsForCase(caseItem, annotatedCandidates);
  if (candidateInputs.length === 0) {
    const error = new Error("No candidate excerpts were readable, so Relation Judge did not run.");
    if (!judgeOptions.relationJudgeAgentFallback) throw error;
    return relationJudgeResult({
      candidates: annotated,
      reviewedCandidates: [],
      generatedBy: "none",
      fallback: true,
      error: error.message,
    });
  }
  const cachePath = judgeOptions.relationJudgeAgentCache ? resolve(judgeOptions.relationJudgeAgentCache) : "";
  const cache = readRelationJudgeCache(cachePath);
  const cacheKey = relationJudgeCacheKey(caseItem, annotated, judgeOptions);
  const cachedCandidates = cache.entries[cacheKey]?.candidates;
  if (Array.isArray(cachedCandidates) && cachedCandidates.length > 0) {
    return relationJudgeResult({
      candidates: mergeJudgedCandidates(annotated, cachedCandidates, candidateInputs, { preserveOrder: false }),
      reviewedCandidates: candidateInputs,
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
      generator: relationJudgeProvider(judgeOptions) === "openai" ? "openai-responses" : "codex-exec",
      prompt_version: RELATION_JUDGE_PROMPT_VERSION,
      agent_provider: relationJudgeProvider(judgeOptions),
      agent_bin: judgeOptions.relationJudgeAgentBin,
      agent_model: relationJudgeModel(judgeOptions),
      candidates: judgedCandidates,
    };
    writeRelationJudgeCache(cachePath, cache);
    return relationJudgeResult({
      candidates: mergeJudgedCandidates(annotated, judgedCandidates, candidateInputs, { preserveOrder: false }),
      reviewedCandidates: candidateInputs,
      generatedBy: "agent",
      fallback: false,
      error: null,
    });
  } catch (error) {
    if (!judgeOptions.relationJudgeAgentFallback) throw error;
    return relationJudgeResult({
      candidates: annotated,
      reviewedCandidates: candidateInputs,
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
export function composeFinalSlate(judgedOrdered, retrievalCandidates, options = {}) {
  const reserve = Math.max(0, options.reservedPoolSlots ?? Number(process.env.AHA_SLATE_POOL_RESERVE ?? 2));
  const blockSize = 10;
  if (reserve === 0) return judgedOrdered;
  const poolOrder = (retrievalCandidates ?? []).map((candidate) => candidate.notePath).filter(Boolean);
  const judgedByPath = new Map(judgedOrdered.map((candidate) => [candidate.notePath, candidate]));
  const placed = new Set();
  const slate = [];
  let judgedIdx = 0;
  let poolIdx = 0;
  const nextJudged = () => {
    while (judgedIdx < judgedOrdered.length) {
      const candidate = judgedOrdered[judgedIdx];
      judgedIdx += 1;
      if (!placed.has(candidate.notePath)) return candidate;
    }
    return null;
  };
  const nextPool = () => {
    while (poolIdx < poolOrder.length) {
      const notePath = poolOrder[poolIdx];
      poolIdx += 1;
      if (!placed.has(notePath) && judgedByPath.has(notePath)) return judgedByPath.get(notePath);
    }
    return null;
  };
  while (slate.length < judgedOrdered.length) {
    const blockStart = slate.length;
    for (let i = 0; i < blockSize - reserve && slate.length < judgedOrdered.length; i += 1) {
      const candidate = nextJudged();
      if (!candidate) break;
      placed.add(candidate.notePath);
      slate.push(candidate);
    }
    for (let i = 0; i < reserve && slate.length < judgedOrdered.length; i += 1) {
      const candidate = nextPool() ?? nextJudged();
      if (!candidate) break;
      placed.add(candidate.notePath);
      slate.push(candidate);
    }
    if (slate.length === blockStart) break;
  }
  return slate;
}

export function orderJudgedCandidates(judgedCandidates, retrievalCandidates) {
  const poolRank = new Map((retrievalCandidates ?? []).map((candidate, index) => [candidate.notePath, index]));
  return (judgedCandidates ?? [])
    .filter((candidate) => candidate?.notePath)
    .map((candidate, judgedIndex) => ({ candidate, judgedIndex }))
    .sort((left, right) => {
      const strengthDiff = relationStrength(right.candidate) - relationStrength(left.candidate);
      if (strengthDiff !== 0) return strengthDiff;
      const leftRank = poolRank.get(left.candidate.notePath) ?? Number.MAX_SAFE_INTEGER;
      const rightRank = poolRank.get(right.candidate.notePath) ?? Number.MAX_SAFE_INTEGER;
      if (leftRank !== rightRank) return leftRank - rightRank;
      return left.judgedIndex - right.judgedIndex;
    })
    .map((entry) => entry.candidate);
}

export function orderJudgedCandidatesForPolicy(judgedCandidates, retrievalCandidates, policy = {}) {
  if (policy.relationOrdering !== "strength-with-pool-reserve") return judgedCandidates ?? [];
  return composeFinalSlate(
    orderJudgedCandidates(judgedCandidates, retrievalCandidates),
    retrievalCandidates,
  );
}

function relationStrength(candidate) {
  return RELATION_STRENGTH[candidate?.relation] ?? RELATION_STRENGTH.weak;
}

function relationJudgeInputsForCase(caseItem, candidates) {
  return candidates.map((candidate) => {
    const notePath = candidatePath(candidate);
    const noteTitle = candidate.title
      || candidate.noteTitle
      || notePath.split("/").pop()?.replace(/\.md$/i, "")
      || notePath;
    return {
      notePath,
      noteTitle,
      retrievalHit: candidate.hit,
      retrievalWhy: candidate.why,
      excerpt: compactLine(candidate.content ?? candidate.snippet ?? candidate.hit ?? "", 1400),
    };
  }).filter((candidate) => candidate.notePath && candidate.excerpt);
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

function relationJudgeResult({ candidates, reviewedCandidates = [], generatedBy, fallback, error }) {
  const rankedIds = candidates.map((candidate) => candidate.rerankId).filter(Boolean);
  return {
    candidates,
    relation_judge_reviewed_candidates: reviewedCandidates.map((candidate) => ({
      notePath: candidate.notePath,
      noteTitle: candidate.noteTitle,
    })),
    relation_judge_generated_by: generatedBy,
    relation_judge_fallback: fallback,
    relation_judge_error: error,
    relation_judge_ranked_ids: rankedIds,
    relation_judge_prompt_version: RELATION_JUDGE_PROMPT_VERSION,
  };
}

function relationJudgeConcurrency(options) {
  // Concurrency only helps the async OpenAI transport; the Codex CLI path
  // shells out synchronously, so keep it at one lane.
  if (relationJudgeProvider(options) !== "openai") return 1;
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

async function generateRelationJudgeWithAgentAsync(caseItem, candidateInputs, options) {
  if (relationJudgeProvider(options) === "openai") {
    const prompt = buildRelationJudgePrompt({
      sourcePath: caseItem.source_note_path || caseItem.id,
      sourceText: caseItem._resolved_insight_input,
      candidateInputs,
    });
    return parseRelationJudgeOutput(await runOpenAiJsonAsync({
      baseUrl: options.llmBaseUrl,
      model: relationJudgeModel(options),
      apiKeyEnv: options.llmApiKeyEnv,
      prompt,
      schema: RESULT_SCHEMA,
      schemaName: RELATION_JUDGE_SCHEMA_NAME,
      timeoutMs: options.relationJudgeAgentTimeoutMs,
    }), caseItem.id);
  }
  return generateRelationJudgeWithAgent(caseItem, candidateInputs, options);
}

function generateRelationJudgeWithAgent(caseItem, candidateInputs, options) {
  const prompt = buildRelationJudgePrompt({
    sourcePath: caseItem.source_note_path || caseItem.id,
    sourceText: caseItem._resolved_insight_input,
    candidateInputs,
  });
  if (relationJudgeProvider(options) === "openai") {
    return parseRelationJudgeOutput(runOpenAiJsonSync({
      baseUrl: options.llmBaseUrl,
      model: relationJudgeModel(options),
      apiKeyEnv: options.llmApiKeyEnv,
      prompt,
      schema: RESULT_SCHEMA,
      schemaName: RELATION_JUDGE_SCHEMA_NAME,
      timeoutMs: options.relationJudgeAgentTimeoutMs,
    }), caseItem.id);
  }

  if (!["codex", "codex-cli"].includes(relationJudgeProvider(options))) {
    throw new Error(`${caseItem.id}: unknown relation judge provider: ${options.relationJudgeAgentProvider}`);
  }

  const tmpRoot = mkdtempSync(join(tmpdir(), "aha-relation-judge-"));
  const schemaPath = join(tmpRoot, "schema.json");
  const outputPath = join(tmpRoot, "relation-judge.json");
  writeFileSync(schemaPath, `${JSON.stringify(RESULT_SCHEMA, null, 2)}\n`);

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
  if (options.relationJudgeAgentModel) {
    args.push("-m", options.relationJudgeAgentModel);
  }
  args.push("-");

  try {
    const result = spawnSync(options.relationJudgeAgentBin || "codex", args, {
      input: prompt,
      encoding: "utf-8",
      timeout: options.relationJudgeAgentTimeoutMs,
      env: process.env,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      const stderr = String(result.stderr ?? "").trim();
      const stdout = String(result.stdout ?? "").trim();
      throw new Error(stderr || stdout || `relation judge exited with ${result.status}`);
    }
    const output = existsSync(outputPath) ? readFileSync(outputPath, "utf-8") : result.stdout;
    return parseRelationJudgeOutput(output, caseItem.id);
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
}

function parseRelationJudgeOutput(output, caseId) {
  const parsed = normalizeStructuredResult(parseJsonOutput(output));
  const validation = validateAhaResult(parsed);
  if (!validation.ok) {
    throw new Error(`${caseId}: relation judge returned malformed output: ${validation.errors.join("; ")}`);
  }
  return parsed.candidates ?? [];
}

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

export function normalizeStructuredResult(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const normalized = { ...value };
  for (const key of ["sourcePath", "generatedAt", "summary", "warnings", "error", "candidates"]) {
    if (normalized[key] === null) delete normalized[key];
  }
  if (Array.isArray(normalized.candidates)) {
    normalized.candidates = normalized.candidates.map((candidate) => {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return candidate;
      const next = { ...candidate };
      for (const key of ["noteTitle", "quotes", "selected"]) {
        if (next[key] === null) delete next[key];
      }
      return next;
    });
  }
  if (normalized.error && typeof normalized.error === "object" && !Array.isArray(normalized.error)) {
    normalized.error = { ...normalized.error };
    for (const key of ["tool", "details"]) {
      if (normalized.error[key] === null) delete normalized.error[key];
    }
  }
  return normalized;
}

function sourceSummaryForRelationJudge(sourcePath, sourceText) {
  return [
    `sourcePath: ${sourcePath}`,
    compactLine(sourceText, 3500),
  ].join("\n");
}

function normalizeEvidenceText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function evidenceFingerprint(value) {
  return String(value ?? "").replace(/[\s\p{P}\p{S}]+/gu, "");
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
  return String(options.relationJudgeAgentProvider || options.llmProvider || "openai").toLowerCase();
}

function relationJudgeModel(options) {
  return String(options.relationJudgeAgentModel || options.llmModel || DEFAULT_OPENAI_MODEL).trim() || DEFAULT_OPENAI_MODEL;
}

function relationJudgeProviderCacheShape(options) {
  const provider = relationJudgeProvider(options);
  if (provider === "openai") {
    return JSON.stringify({
      provider,
      baseUrl: options.llmBaseUrl || DEFAULT_OPENAI_BASE_URL,
      model: relationJudgeModel(options),
    });
  }
  return JSON.stringify({
    provider,
    bin: options.relationJudgeAgentBin || "codex",
    model: options.relationJudgeAgentModel || "",
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
