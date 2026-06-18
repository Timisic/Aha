import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { InsightSession, MemoryRelation } from "./domain.ts";
import { compactLine } from "./domain.ts";
import { relationLabel, sourceLabel } from "./memory.ts";

const RERANK_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["ranked"],
  properties: {
    ranked: {
      type: "array",
      minItems: 1,
      maxItems: 40,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "relation", "hit", "why"],
        properties: {
          id: { type: "string", minLength: 1, maxLength: 16 },
          relation: {
            type: "string",
            enum: ["supports", "challenges", "resembles", "bounds"],
          },
          hit: { type: "string", minLength: 1, maxLength: 180 },
          why: { type: "string", minLength: 1, maxLength: 180 },
        },
      },
    },
  },
};

export interface MemoryRerankResult {
  candidates: InsightSession["memoryCandidates"];
  generatedBy: "agent" | "none";
  fallback: boolean;
  error?: string;
}

type MemoryCandidate = InsightSession["memoryCandidates"][number] & { rerankId?: string };

function rerankerMode(): string {
  return process.env.INSIGHT_MEMORY_RERANKER?.trim().toLowerCase() || "agent";
}

function rerankAgentBin(): string {
  return process.env.INSIGHT_MEMORY_RERANK_AGENT_BIN?.trim() || "codex";
}

function rerankAgentModel(): string {
  return process.env.INSIGHT_MEMORY_RERANK_AGENT_MODEL?.trim() || "";
}

function rerankAgentTimeoutMs(): number {
  return Number(process.env.INSIGHT_MEMORY_RERANK_TIMEOUT_MS) || 300_000;
}

function annotateCandidates(candidates: InsightSession["memoryCandidates"]): MemoryCandidate[] {
  return candidates.map((candidate, index) => ({
    ...candidate,
    rerankId: `c${String(index + 1).padStart(3, "0")}`,
  }));
}

function candidatePrompt(candidate: MemoryCandidate): string {
  return [
    `id: ${candidate.rerankId}`,
    `title: ${compactLine(candidate.title, 100)}`,
    `path: ${compactLine(candidate.slug ?? "", 180)}`,
    `source: ${sourceLabel(candidate)}`,
    candidate.searchSignals?.expansionFroms?.length
      ? `linked_from: ${compactLine(candidate.searchSignals.expansionFroms.join("; "), 220)}`
      : candidate.searchSignals?.expansionFrom
        ? `linked_from: ${compactLine(candidate.searchSignals.expansionFrom, 180)}`
        : "",
    `current_relation: ${relationLabel(candidate.relation)}`,
    `snippet: ${compactLine(candidate.reason, 400)}`,
  ].filter(Boolean).join("\n");
}

function promptFor(session: InsightSession, candidates: MemoryCandidate[], limit: number): string {
  return [
    "你是 Pi /insight memory_review 阶段的候选笔记排序 agent。",
    "",
    "任务：根据用户原始 insight、上下文和候选笔记，输出最值得用户优先看的候选排序，并为最终表格写 Relation / Hit / Why。",
    "",
    "硬性约束：",
    "- 只能使用下面提供的 raw insight、context、explicit cues 和候选信息。",
    "- 不要按来源机械排序；QMD 命中和 backlink 都只是证据。",
    "- 优先级：能直接支持/挑战/限定当前 insight 的旧判断 > 具体相似经历 > 相关但泛泛的主题页 > 当前 source note 本身。",
    "- Relation 必须是 supports、challenges、resembles、bounds 之一。",
    `- 尽量包含全部候选；前 ${limit} 个会作为最终给用户的 Note / Relation / Hit / Why。`,
    "- 输出必须是 JSON，字段只包含 ranked。",
    "",
    "<raw_insight>",
    session.rawInsight,
    "</raw_insight>",
    "",
    "<context>",
    session.context,
    "</context>",
    "",
    "<explicit_memory_cues>",
    session.explicitMemoryCues.length > 0 ? session.explicitMemoryCues.map((cue) => `- ${cue}`).join("\n") : "none",
    "</explicit_memory_cues>",
    "",
    "<candidates>",
    candidates.map(candidatePrompt).join("\n\n---\n\n"),
    "</candidates>",
  ].join("\n");
}

function parseAgentOutput(output: string, validIds: Set<string>): Array<{
  id: string;
  relation: MemoryRelation;
  hit: string;
  why: string;
}> {
  const text = output.trim();
  if (!text) throw new Error("rerank agent produced empty output");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (firstError) {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw firstError;
    parsed = JSON.parse(match[0]);
  }

  const ranked = (parsed && typeof parsed === "object" && Array.isArray((parsed as { ranked?: unknown }).ranked))
    ? (parsed as { ranked: unknown[] }).ranked
    : [];
  const seen = new Set<string>();
  return ranked.flatMap((item) => {
    const record = item && typeof item === "object" ? item as Record<string, unknown> : {};
    const id = typeof record.id === "string" ? record.id.trim() : "";
    const relation = record.relation;
    if (!validIds.has(id) || seen.has(id)) return [];
    if (relation !== "supports" && relation !== "challenges" && relation !== "resembles" && relation !== "bounds") {
      return [];
    }
    const hit = compactLine(String(record.hit ?? ""), 180);
    const why = compactLine(String(record.why ?? ""), 180);
    if (!hit || !why) return [];
    seen.add(id);
    return [{ id, relation, hit, why }];
  });
}

function runAgent(session: InsightSession, candidates: MemoryCandidate[], limit: number) {
  const tmpRoot = mkdtempSync(join(tmpdir(), "insight-rerank-agent-"));
  const schemaPath = join(tmpRoot, "schema.json");
  const outputPath = join(tmpRoot, "rerank.json");
  writeFileSync(schemaPath, `${JSON.stringify(RERANK_SCHEMA, null, 2)}\n`);

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
  const model = rerankAgentModel();
  if (model) args.push("-m", model);
  args.push("-");

  try {
    const result = spawnSync(rerankAgentBin(), args, {
      input: promptFor(session, candidates, limit),
      encoding: "utf-8",
      timeout: rerankAgentTimeoutMs(),
      env: process.env,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      const stderr = String(result.stderr ?? "").trim();
      const stdout = String(result.stdout ?? "").trim();
      throw new Error(stderr || stdout || `rerank agent exited with ${result.status}`);
    }
    const output = existsSync(outputPath) ? readFileSync(outputPath, "utf-8") : String(result.stdout ?? "");
    const parsed = parseAgentOutput(output, new Set(candidates.map((candidate) => candidate.rerankId ?? "")));
    if (parsed.length === 0) throw new Error("rerank agent returned no valid candidates");
    return parsed;
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
}

function applyRanked(
  candidates: MemoryCandidate[],
  ranked: Array<{ id: string; relation: MemoryRelation; hit: string; why: string }>,
): InsightSession["memoryCandidates"] {
  const byId = new Map(candidates.map((candidate) => [candidate.rerankId, candidate]));
  const seen = new Set<string>();
  const ordered: InsightSession["memoryCandidates"] = [];

  for (const item of ranked) {
    const candidate = byId.get(item.id);
    if (!candidate || seen.has(item.id)) continue;
    seen.add(item.id);
    ordered.push({
      ...candidate,
      relation: item.relation,
      reason: item.hit,
      whyReadFirst: item.why,
    });
  }

  for (const candidate of candidates) {
    if (seen.has(candidate.rerankId ?? "")) continue;
    ordered.push(candidate);
  }
  return ordered;
}

export function rerankMemoryCandidates(
  session: InsightSession,
  candidates: InsightSession["memoryCandidates"],
  limit: number,
): MemoryRerankResult {
  const annotated = annotateCandidates(candidates);
  if (annotated.length === 0) {
    return { candidates: [], generatedBy: "none", fallback: false };
  }

  if (rerankerMode() === "none") {
    return {
      candidates: annotated,
      generatedBy: "none",
      fallback: false,
    };
  }

  try {
    return {
      candidates: applyRanked(annotated, runAgent(session, annotated, limit)),
      generatedBy: "agent",
      fallback: false,
    };
  } catch (error) {
    const hash = createHash("sha1").update(String(error instanceof Error ? error.message : error)).digest("hex").slice(0, 8);
    return {
      candidates: annotated,
      generatedBy: "none",
      fallback: true,
      error: `rerank failed (${hash}): ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
