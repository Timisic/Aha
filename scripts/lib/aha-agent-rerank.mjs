import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { compactLine } from "./aha-query-generation.mjs";

const RERANK_AGENT_PROMPT_VERSION = "aha-agent-rerank-v1";

const RERANK_AGENT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["ranked_ids"],
  properties: {
    ranked_ids: {
      type: "array",
      minItems: 1,
      maxItems: 80,
      items: {
        type: "string",
        minLength: 1,
        maxLength: 16,
      },
    },
  },
};

export function defaultRerankOptions(overrides = {}) {
  const cleanOverrides = Object.fromEntries(
    Object.entries(overrides).filter(([, value]) => value !== undefined),
  );
  return {
    reranker: process.env.AHA_BENCH_RERANKER || "agent",
    rerankAgentBin: process.env.AHA_BENCH_RERANK_AGENT_BIN || "codex",
    rerankAgentModel: process.env.AHA_BENCH_RERANK_AGENT_MODEL || "",
    rerankAgentCache: process.env.AHA_BENCH_RERANK_AGENT_CACHE || "bench/generated/agent-rerank-cache.json",
    rerankAgentFallback: process.env.AHA_BENCH_RERANK_AGENT_FALLBACK !== "0",
    rerankAgentTimeoutMs: Number(process.env.AHA_BENCH_RERANK_AGENT_TIMEOUT_MS || 300_000),
    ...cleanOverrides,
  };
}

function candidateCacheShape(candidate) {
  return {
    id: candidate.rerankId,
    title: candidate.title,
    file: candidate.file,
    source: candidate.source,
    sources: candidate.sources,
    expansionFrom: candidate.expansionFrom,
    content: compactLine(candidate.content ?? "", 500),
  };
}

function rerankCacheKey(caseItem, candidates) {
  const hash = createHash("sha256")
    .update(RERANK_AGENT_PROMPT_VERSION)
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

function readRerankCache(cachePath) {
  if (!cachePath || !existsSync(cachePath)) {
    return {
      version: 1,
      prompt_version: RERANK_AGENT_PROMPT_VERSION,
      entries: {},
    };
  }
  try {
    const parsed = JSON.parse(readFileSync(cachePath, "utf-8"));
    return {
      version: 1,
      prompt_version: RERANK_AGENT_PROMPT_VERSION,
      entries: parsed?.entries && typeof parsed.entries === "object" ? parsed.entries : {},
    };
  } catch {
    return {
      version: 1,
      prompt_version: RERANK_AGENT_PROMPT_VERSION,
      entries: {},
    };
  }
}

function writeRerankCache(cachePath, cache) {
  if (!cachePath) return;
  mkdirSync(dirname(resolve(cachePath)), { recursive: true });
  writeFileSync(resolve(cachePath), `${JSON.stringify(cache, null, 2)}\n`);
}

function annotateCandidates(candidates) {
  return candidates.map((candidate, index) => ({
    ...candidate,
    rerankId: `c${String(index + 1).padStart(3, "0")}`,
  }));
}

function rerankAgentPrompt(caseItem, candidates, finalLimit) {
  const candidateLines = candidates.map((candidate) => {
    const sourceLabel = Array.isArray(candidate.sources) && candidate.sources.length > 0
      ? candidate.sources.join("+")
      : candidate.source;
    return [
      `id: ${candidate.rerankId}`,
      `title: ${compactLine(candidate.title, 120)}`,
      `path: ${compactLine(candidate.file ?? "", 180)}`,
      `source: ${sourceLabel}`,
      candidate.expansionFrom ? `linked_from: ${compactLine(candidate.expansionFrom, 180)}` : "",
      `snippet: ${compactLine(candidate.content ?? "", 500)}`,
    ].filter(Boolean).join("\n");
  }).join("\n\n---\n\n");

  return [
    "你是 Pi /insight memory_review 阶段的候选笔记排序 agent。",
    "",
    "任务：根据用户原始 insight input 和候选笔记，输出最值得用户优先看的候选 id 排序。",
    "",
    "硬性约束：",
    "- 只能使用下面提供的 raw input、query object 和候选信息。",
    "- 你看不到 must_recall / nice_to_have 标注答案；不要推断或依赖评测答案。",
    "- 不要按来源机械排序；QMD 命中和 backlink 都只是证据。你要综合判断候选是否能帮助用户形成更好的判断。",
    "- 优先级：能直接支持/挑战/限定当前 insight 的旧判断 > 具体相似经历 > 相关但泛泛的主题页 > 当前 source note 本身。",
    "- 如果 backlink 候选只是 source note 或明显无关，可以排后。",
    `- 输出 ranked_ids，尽量包含全部候选；前 ${finalLimit} 个会作为最终 pipeline top candidates。`,
    "- 输出必须是 JSON，字段只包含 ranked_ids。",
    "",
    `case_id: ${caseItem.id}`,
    "",
    "<raw_insight_input>",
    String(caseItem._resolved_insight_input ?? "").trim(),
    "</raw_insight_input>",
    "",
    "<query_object>",
    JSON.stringify(caseItem.query_object ?? {}, null, 2),
    "</query_object>",
    "",
    "<queries>",
    JSON.stringify(caseItem.queries ?? [], null, 2),
    "</queries>",
    "",
    "<candidates>",
    candidateLines,
    "</candidates>",
  ].join("\n");
}

function parseRerankAgentOutput(output, validIds, caseId) {
  const text = String(output ?? "").trim();
  if (!text) throw new Error(`${caseId}: rerank agent produced empty output.`);
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (firstError) {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw firstError;
    parsed = JSON.parse(match[0]);
  }

  const rankedIds = Array.isArray(parsed?.ranked_ids)
    ? parsed.ranked_ids.map((item) => String(item).trim()).filter(Boolean)
    : [];
  const seen = new Set();
  const validRankedIds = rankedIds.filter((id) => {
    if (!validIds.has(id) || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  if (validRankedIds.length === 0) {
    throw new Error(`${caseId}: rerank agent returned no valid candidate ids.`);
  }
  return validRankedIds;
}

function generateRerankWithAgent(caseItem, candidates, options) {
  const tmpRoot = mkdtempSync(join(tmpdir(), "aha-rerank-agent-"));
  const schemaPath = join(tmpRoot, "schema.json");
  const outputPath = join(tmpRoot, "rerank.json");
  writeFileSync(schemaPath, `${JSON.stringify(RERANK_AGENT_SCHEMA, null, 2)}\n`);

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
  if (options.rerankAgentModel) {
    args.push("-m", options.rerankAgentModel);
  }
  args.push("-");

  try {
    const result = spawnSync(options.rerankAgentBin || "codex", args, {
      input: rerankAgentPrompt(caseItem, candidates, options.limit ?? 20),
      encoding: "utf-8",
      timeout: options.rerankAgentTimeoutMs,
      env: process.env,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      const stderr = String(result.stderr ?? "").trim();
      const stdout = String(result.stdout ?? "").trim();
      throw new Error(stderr || stdout || `rerank agent exited with ${result.status}`);
    }
    const output = existsSync(outputPath) ? readFileSync(outputPath, "utf-8") : result.stdout;
    return parseRerankAgentOutput(
      output,
      new Set(candidates.map((candidate) => candidate.rerankId)),
      caseItem.id,
    );
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
}

function orderByRankedIds(candidates, rankedIds) {
  const byId = new Map(candidates.map((candidate) => [candidate.rerankId, candidate]));
  const seen = new Set();
  const ordered = [];
  for (const id of rankedIds) {
    const candidate = byId.get(id);
    if (!candidate || seen.has(id)) continue;
    seen.add(id);
    ordered.push(candidate);
  }
  for (const candidate of candidates) {
    if (seen.has(candidate.rerankId)) continue;
    ordered.push(candidate);
  }
  return ordered;
}

export function rerankCandidatesForCase(caseItem, candidates, options = {}) {
  const rerankOptions = defaultRerankOptions(options);
  const annotated = annotateCandidates(candidates);
  const reranker = String(rerankOptions.reranker || "agent").toLowerCase();

  if (reranker === "none") {
    return {
      candidates: annotated,
      rerank_generated_by: "none",
      rerank_fallback: false,
      rerank_error: null,
      rerank_ranked_ids: annotated.map((candidate) => candidate.rerankId),
    };
  }
  if (reranker !== "agent") {
    throw new Error(`Unknown reranker: ${rerankOptions.reranker}`);
  }

  const cachePath = rerankOptions.rerankAgentCache ? resolve(rerankOptions.rerankAgentCache) : "";
  const cache = readRerankCache(cachePath);
  const cacheKey = rerankCacheKey(caseItem, annotated);
  const cachedIds = cache.entries[cacheKey]?.ranked_ids;
  if (Array.isArray(cachedIds) && cachedIds.length > 0) {
    const rankedIds = parseRerankAgentOutput(
      JSON.stringify({ ranked_ids: cachedIds }),
      new Set(annotated.map((candidate) => candidate.rerankId)),
      caseItem.id,
    );
    return {
      candidates: orderByRankedIds(annotated, rankedIds),
      rerank_generated_by: "agent-cache",
      rerank_fallback: false,
      rerank_error: null,
      rerank_ranked_ids: rankedIds,
    };
  }

  try {
    const rankedIds = generateRerankWithAgent(caseItem, annotated, rerankOptions);
    cache.entries[cacheKey] = {
      generated_at: new Date().toISOString(),
      generator: "codex-exec",
      prompt_version: RERANK_AGENT_PROMPT_VERSION,
      ranked_ids: rankedIds,
    };
    writeRerankCache(cachePath, cache);
    return {
      candidates: orderByRankedIds(annotated, rankedIds),
      rerank_generated_by: "agent",
      rerank_fallback: false,
      rerank_error: null,
      rerank_ranked_ids: rankedIds,
    };
  } catch (error) {
    if (!rerankOptions.rerankAgentFallback) throw error;
    return {
      candidates: annotated,
      rerank_generated_by: "none",
      rerank_fallback: true,
      rerank_error: error.message,
      rerank_ranked_ids: annotated.map((candidate) => candidate.rerankId),
    };
  }
}
