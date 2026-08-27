// LLM-based Relation Judge shared between the plugin and bench (ADR 0005,
// issue #57). Ports the LLM-orchestration half of scripts/aha/relation-judge.mjs:
// prompt construction, the llmJsonCall round-trip with a validation-repair
// retry, quote-backed relation enforcement (the decision-for-decision-critical
// demotion to weak), candidate merging, and final-slate composition/ordering.
//
// Cache-file management, CLI option parsing, and per-chunk concurrency stay
// in scripts/aha/relation-judge.mjs (bench/Node infrastructure); this module
// offers the LLM round-trip + validation + quote-enforcement + merge
// primitives that infrastructure calls into, mirroring the query-plan split
// in query-plan-llm.ts.
//
// This module must stay free of `obsidian` imports, node imports, and
// module-level I/O: all LLM network calls flow through llmJsonCall
// (llm-transport.ts) — issue #57's single LLM call path.

import {
  type LlmJsonCallRequest,
  type LlmTransportDeps,
  llmJsonCall,
} from "./llm-transport";
import { compactLine } from "./query-plan-deterministic";
import { AHA_RESULT_SCHEMA, RELATIONS as VALID_RELATIONS, validateAhaResult } from "./result-validator";

export const RELATION_JUDGE_PROMPT_VERSION = "aha-relation-judge-v6";
export const RELATION_JUDGE_SCHEMA_NAME = "aha_relation_judge";
export const DEFAULT_RELATION_JUDGE_CHUNK_SIZE = 20;
export const DEFAULT_RELATION_JUDGE_CONCURRENCY = 3;
export const DEFAULT_SLATE_POOL_RESERVE = 2;

export const RELATION_STRENGTH: Readonly<Record<string, number>> = {
  supports: 3,
  challenges: 3,
  bounds: 2.5,
  resembles: 2.5,
  weak: 1,
};

export type RelationJudgeCandidate = Record<string, unknown> & { notePath: string };

export interface RelationJudgeCandidateInput {
  notePath: string;
  noteTitle?: string;
  retrievalHit?: string;
  retrievalWhy?: string;
  excerpt: string;
  [key: string]: unknown;
}

export interface BuildRelationJudgePromptArgs {
  sourcePath: unknown;
  sourceText: unknown;
  candidateInputs: RelationJudgeCandidateInput[];
}

export function buildRelationJudgePrompt({ sourcePath, sourceText, candidateInputs }: BuildRelationJudgePromptArgs): string {
  return [
    "Aha Relation Judge—根据 source 全文和候选 excerpt 判定一条旧笔记与当前 insight 的论证关系。",
    "",
    "关系标签（每个强标签必须附带候选 excerpt 中的原文引句）：",
    "- supports：旧证据强化当前判断。",
    "- challenges：旧证据反驳、冲突或施加压力。",
    "- bounds：旧证据标注判断的边界、限定条件或适用范围。",
    "- resembles：来自不同领域的结构同构模式。",
    "- weak：候选 excerpt 中没有任何引句直接作用于 source 的判断——只在引句缺失时使用，与话题距离无关。",
    "",
    "反方向材料优先级高：旧的失败、冲突、对立经验只要作用于 source 的判断就应得到 challenges 或 bounds。",
    "跨领域连接高价值：候选话题与 source 完全不同，但论证结构存在 challenges/bounds/resembles 关系时，话题距离是特征而非降级理由。",
    "持久判断和教训优先于同话题的事件流水。",
    "",
    "以 JSON 格式输出，每条候选包含以下字段：",
    "- relation：必填，上面五个关系标签之一（supports/challenges/bounds/resembles/weak），不要省略这个字段。",
    "- hit：候选 excerpt 中的原文短引句。",
    "- why：用自然中文写，以具体观点或张力开头，点出旧判断和当前 insight 之间的具体连接。",
    "- quotes：字符串数组（即使只有一条引句，也要写成 [\"引句\"] 而不是裸字符串）。支撑标签的 excerpt 原文引句。",
    "- notePath：保持传入的 notePath 值不变，必须原样返回。",
    "",
    `sourcePath: ${sourcePath}`,
    "source 全文：",
    sourceSummaryForRelationJudge(sourcePath, sourceText),
    "",
    "candidates:",
    JSON.stringify(candidateInputs, null, 2),
  ].join("\n");
}

/** Verbatim port of the repair-retry prompt wrapper from scripts/aha/relation-judge.mjs. */
export function buildRelationJudgeRepairPrompt(originalPrompt: string, validationError: string): string {
  return [
    originalPrompt,
    "",
    "Your previous JSON failed validation:",
    validationError,
    "Return the complete JSON object again. Repair every listed field; do not omit candidates.",
    "Each why must be a concrete, sufficiently detailed bridge between the quoted old-note evidence and the current source insight.",
  ].join("\n");
}

function sourceSummaryForRelationJudge(sourcePath: unknown, sourceText: unknown): string {
  return [
    `sourcePath: ${sourcePath}`,
    compactLine(sourceText, 3500),
  ].join("\n");
}

/** Verbatim port of normalizeStructuredResult from scripts/aha/relation-judge.mjs. */
export function normalizeStructuredResult(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const normalized: Record<string, unknown> = { ...(value as Record<string, unknown>) };
  for (const key of ["sourcePath", "generatedAt", "summary", "warnings", "error", "candidates"]) {
    if (normalized[key] === null) delete normalized[key];
  }
  if (!Array.isArray(normalized.candidates) && typeof normalized.notePath === "string") {
    const candidate = { ...normalized };
    for (const key of Object.keys(normalized)) delete normalized[key];
    normalized.ok = true;
    normalized.candidates = [candidate];
  }
  if (Array.isArray(normalized.candidates)) {
    normalized.candidates = normalized.candidates.map((candidate) => {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return candidate;
      const next: Record<string, unknown> = { ...(candidate as Record<string, unknown>) };
      for (const key of ["noteTitle", "quotes", "selected"]) {
        if (next[key] === null) delete next[key];
      }
      // DeepSeek (chat-completions, no structured-output schema enforcement)
      // frequently returns quotes as a bare string instead of a one-element
      // array, even when the prompt asks for an array -- coerce it rather
      // than fail validation and lose an otherwise well-judged candidate.
      if (typeof next.quotes === "string" && next.quotes.trim()) {
        next.quotes = [next.quotes];
      }
      if (typeof next.hit !== "string" || !next.hit.trim()) {
        const quotes = Array.isArray(next.quotes) ? next.quotes.filter((q): q is string => typeof q === "string" && q.trim().length > 0) : [];
        next.hit = quotes[0] || String(next.notePath || "unknown");
      }
      // A missing relation (not just an invalid one) defaults to "weak", the
      // same safe default the schema and enforceQuoteBackedRelation already
      // use for "no clear evidence-backed relation" -- needed because
      // chat-completions providers (DeepSeek) have no structured-output
      // schema enforcement and can omit the field entirely even when the
      // prompt asks for it.
      if (typeof next.relation !== "string" || !VALID_RELATIONS.has(next.relation)) {
        next.relation = "weak";
      }
      return next;
    });
  }
  if (normalized.error && typeof normalized.error === "object" && !Array.isArray(normalized.error)) {
    const errorRecord: Record<string, unknown> = { ...(normalized.error as Record<string, unknown>) };
    for (const key of ["tool", "details"]) {
      if (errorRecord[key] === null) delete errorRecord[key];
    }
    normalized.error = errorRecord;
  }
  return normalized;
}

// --- Quote-backed relation enforcement (decision-for-decision critical) ---
//
// Verbatim port of enforceQuoteBackedRelation / hasQuoteEvidence /
// normalizeEvidenceText / evidenceFingerprint from
// scripts/aha/relation-judge.mjs (git show 71547be). Every branch here must
// stay byte-identical to that baseline: this is the quote-validation
// demotion-to-Weak logic issue #57 requires "decision-for-decision identical"
// unit coverage for.

export function enforceQuoteBackedRelation(candidate: RelationJudgeCandidate, excerpt: string): RelationJudgeCandidate {
  if (candidate.relation === "weak") return candidate;
  if (hasQuoteEvidence(candidate, excerpt)) return candidate;
  return {
    ...candidate,
    relation: "weak",
    why: `${candidate.why} Downgraded to weak because the bounded excerpt did not contain the returned quote evidence.`,
    quotes: [],
  };
}

export function hasQuoteEvidence(candidate: RelationJudgeCandidate, excerpt: string): boolean {
  const haystack = normalizeEvidenceText(excerpt);
  const haystackFingerprint = evidenceFingerprint(excerpt);
  const needles = [
    candidate.hit,
    ...(Array.isArray(candidate.quotes) ? (candidate.quotes as unknown[]) : []),
  ]
    .map((value) => normalizeEvidenceText(value).replace(/^["'\u201c\u201d\u2018\u2019]+|["'\u201c\u201d\u2018\u2019]+$/g, ""))
    .filter((value) => value.length >= 8);
  return needles.some((needle) => {
    if (haystack.includes(needle)) return true;
    const fingerprint = evidenceFingerprint(needle);
    if (fingerprint.length >= 8 && haystackFingerprint.includes(fingerprint)) return true;
    const relaxedLen = Math.max(8, Math.floor(fingerprint.length * 0.6));
    if (fingerprint.length >= 12 && haystackFingerprint.includes(fingerprint.slice(0, relaxedLen))) return true;
    return false;
  });
}

function normalizeEvidenceText(value: unknown): string {
  return normalizeWidthVariants(String(value ?? "")).replace(/\s+/g, " ").trim();
}

function evidenceFingerprint(value: unknown): string {
  return normalizeWidthVariants(String(value ?? "")).replace(/[\s\p{P}\p{S}]+/gu, "");
}

function normalizeWidthVariants(text: string): string {
  return text.replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0));
}

// --- Merge, ordering, and final-slate composition ---

export interface MergeJudgedCandidatesOptions {
  preserveOrder?: boolean;
}

/** Verbatim port of mergeJudgedCandidates from scripts/aha/relation-judge.mjs. */
export function mergeJudgedCandidates(
  retrievalCandidates: RelationJudgeCandidate[] | null | undefined,
  judgedCandidates: RelationJudgeCandidate[] | null | undefined,
  candidateInputs: RelationJudgeCandidateInput[],
  options: MergeJudgedCandidatesOptions = {},
): RelationJudgeCandidate[] {
  const preserveOrder = options.preserveOrder !== false;
  const excerpts = new Map(candidateInputs.map((candidate) => [
    candidate.notePath,
    `${candidate.excerpt}\n${candidate.retrievalHit ?? ""}`,
  ]));
  const retrievalByPath = new Map((retrievalCandidates ?? []).map((candidate) => [candidate.notePath, candidate]));
  const judgedByPath = new Map<string, RelationJudgeCandidate>();
  for (const candidate of judgedCandidates ?? []) {
    if (!candidate?.notePath) continue;
    judgedByPath.set(candidate.notePath, candidate);
  }

  const mergeOne = (retrievalCandidate: RelationJudgeCandidate): RelationJudgeCandidate => {
    const judged = judgedByPath.get(retrievalCandidate.notePath);
    if (!judged) return retrievalCandidate;
    const merged: RelationJudgeCandidate = {
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

  const ordered: RelationJudgeCandidate[] = [];
  const seen = new Set<string>();
  for (const judged of judgedCandidates ?? []) {
    const retrievalCandidate = judged?.notePath ? retrievalByPath.get(judged.notePath) : undefined;
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

/** Verbatim port of orderJudgedCandidates from scripts/aha/relation-judge.mjs. */
export function orderJudgedCandidates(
  judgedCandidates: RelationJudgeCandidate[] | null | undefined,
  retrievalCandidates: RelationJudgeCandidate[] | null | undefined,
): RelationJudgeCandidate[] {
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

function relationStrength(candidate: RelationJudgeCandidate): number {
  return RELATION_STRENGTH[candidate?.relation as string] ?? RELATION_STRENGTH.weak;
}

export interface ComposeFinalSlateOptions {
  reservedPoolSlots?: number;
}

/**
 * Verbatim port of composeFinalSlate from scripts/aha/relation-judge.mjs. The
 * legacy default read process.env.AHA_SLATE_POOL_RESERVE; core cannot touch
 * process.env, so the Node binding (scripts/lib/core-artifact.mjs) restores
 * that env override and passes the resolved number as reservedPoolSlots.
 */
export function composeFinalSlate(
  judgedOrdered: RelationJudgeCandidate[],
  retrievalCandidates: RelationJudgeCandidate[] | null | undefined,
  options: ComposeFinalSlateOptions = {},
): RelationJudgeCandidate[] {
  const reserve = Math.max(0, options.reservedPoolSlots ?? DEFAULT_SLATE_POOL_RESERVE);
  const blockSize = 10;
  if (reserve === 0) return judgedOrdered;
  const poolOrder = (retrievalCandidates ?? []).map((candidate) => candidate.notePath).filter(Boolean);
  const judgedByPath = new Map(judgedOrdered.map((candidate) => [candidate.notePath, candidate]));
  const placed = new Set<string>();
  const slate: RelationJudgeCandidate[] = [];
  let judgedIdx = 0;
  let poolIdx = 0;
  const nextJudged = (): RelationJudgeCandidate | null => {
    while (judgedIdx < judgedOrdered.length) {
      const candidate = judgedOrdered[judgedIdx];
      judgedIdx += 1;
      if (!placed.has(candidate.notePath)) return candidate;
    }
    return null;
  };
  const nextPool = (): RelationJudgeCandidate | null => {
    while (poolIdx < poolOrder.length) {
      const notePath = poolOrder[poolIdx];
      poolIdx += 1;
      if (!placed.has(notePath) && judgedByPath.has(notePath)) return judgedByPath.get(notePath) as RelationJudgeCandidate;
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

// --- LLM round-trip orchestration ---

export type RelationJudgeLlmTransportRequest = Omit<LlmJsonCallRequest, "prompt" | "schema" | "schemaName">;

export interface RelationJudgeRawSuccess {
  ok: true;
  candidates: RelationJudgeCandidate[];
  warnings: string[];
  summary?: string | null;
  repaired: boolean;
}
export interface RelationJudgeRawFailure {
  ok: false;
  error: string;
}
export type RelationJudgeRawResult = RelationJudgeRawSuccess | RelationJudgeRawFailure;

interface NormalizedRelationJudgeOutput {
  candidates?: RelationJudgeCandidate[];
  warnings?: string[];
  summary?: string | null;
  [key: string]: unknown;
}

function validatedRelationJudgeOutput(
  output: unknown,
  expectedNotePath?: string,
): { ok: true; value: NormalizedRelationJudgeOutput } | { ok: false; errors: string[] } {
  // When exactly one candidate was asked about (the per-candidate judging
  // path), the caller already knows which notePath the response is for.
  // DeepSeek (chat-completions, no structured-output schema enforcement)
  // sometimes omits notePath entirely, which otherwise defeats
  // normalizeStructuredResult's bare-candidate-object detection (it keys off
  // notePath being a string) and the response fails validation with the
  // unhelpful "Result must include boolean ok." -- backfill the known value
  // onto a bare, unwrapped object before normalizing.
  let patched = output;
  if (
    expectedNotePath
    && output && typeof output === "object" && !Array.isArray(output)
    && !Array.isArray((output as Record<string, unknown>).candidates)
    && typeof (output as Record<string, unknown>).notePath !== "string"
  ) {
    patched = { ...(output as Record<string, unknown>), notePath: expectedNotePath };
  }
  const parsed = normalizeStructuredResult(patched) as NormalizedRelationJudgeOutput;
  const validation = validateAhaResult(parsed);
  if (!validation.ok) return { ok: false, errors: validation.errors };
  return { ok: true, value: parsed };
}

/**
 * Low-level LLM round-trip: builds the prompt, calls llmJsonCall, validates
 * against AHA_RESULT_SCHEMA (result-validator.ts), and retries once with a
 * repair prompt on validation failure — mirroring
 * generateRelationJudgeWithAgentAsync's openai branch plus
 * parseRelationJudgeOutput in scripts/aha/relation-judge.mjs. Returns the raw
 * judged candidates (not yet merged with retrieval candidates); callers that
 * chunk candidateInputs across multiple calls merge once at the end with
 * mergeJudgedCandidates, exactly like the legacy chunked bench path.
 */
export async function judgeRelationsRawViaLlm(
  input: { sourcePath: unknown; sourceText: unknown; candidateInputs: RelationJudgeCandidateInput[] },
  transportRequest: RelationJudgeLlmTransportRequest,
  deps: LlmTransportDeps,
): Promise<RelationJudgeRawResult> {
  const prompt = buildRelationJudgePrompt(input);
  const callLlm = (promptText: string) => llmJsonCall(
    { ...transportRequest, prompt: promptText, schema: AHA_RESULT_SCHEMA, schemaName: RELATION_JUDGE_SCHEMA_NAME },
    deps,
  );

  const attempt = await callLlm(prompt);
  if (!attempt.ok) return { ok: false, error: attempt.error };

  const expectedNotePath = input.candidateInputs.length === 1 ? String(input.candidateInputs[0].notePath ?? "") || undefined : undefined;
  let repaired = false;
  let validated = validatedRelationJudgeOutput(attempt.json, expectedNotePath);
  if (!validated.ok) {
    const repairAttempt = await callLlm(buildRelationJudgeRepairPrompt(prompt, validated.errors.join("; ")));
    if (!repairAttempt.ok) return { ok: false, error: repairAttempt.error };
    repaired = true;
    validated = validatedRelationJudgeOutput(repairAttempt.json, expectedNotePath);
    if (!validated.ok) return { ok: false, error: validated.errors.join("; ") };
  }

  return {
    ok: true,
    candidates: validated.value.candidates ?? [],
    warnings: validated.value.warnings ?? [],
    summary: validated.value.summary,
    repaired,
  };
}

export interface JudgeCandidateRelationsViaLlmInput {
  sourcePath: unknown;
  sourceText: unknown;
  candidates: RelationJudgeCandidate[];
  candidateInputs: RelationJudgeCandidateInput[];
  preserveOrder?: boolean;
  /** Label recorded as relation_judge_generated_by / the failure tool name. */
  generatedBy?: string;
  /** Max parallel LLM calls for per-candidate judging. Default 5. */
  concurrency?: number;
}

export interface RelationJudgeLlmSuccess {
  ok: true;
  reviewedCount: number;
  warnings: string[];
  candidates: RelationJudgeCandidate[];
  summary?: string | null;
  relation_judge_prompt_version: string;
  relation_judge_generated_by: string;
}
export interface RelationJudgeLlmFailure {
  ok: false;
  reviewedCount: number;
  warnings: string[];
  message?: string;
  tool: string;
  error: string;
  candidates: RelationJudgeCandidate[];
  relation_judge_prompt_version: string;
  relation_judge_generated_by?: string;
}
export type RelationJudgeLlmResult = RelationJudgeLlmSuccess | RelationJudgeLlmFailure;

export const DEFAULT_PER_CANDIDATE_CONCURRENCY = 5;

/**
 * Per-candidate Relation Judge: each candidate gets its own LLM call so
 * the full source text and full candidate excerpt travel together without
 * competing for token budget. Runs with bounded concurrency (default 5).
 *
 * Return shape is the same ok:true/ok:false contract as before: a partial
 * failure (some candidates judged, some failed) still returns ok:true with
 * the failed candidates left as weak.
 */
export async function judgeCandidateRelationsViaLlm(
  input: JudgeCandidateRelationsViaLlmInput,
  transportRequest: RelationJudgeLlmTransportRequest,
  deps: LlmTransportDeps,
): Promise<RelationJudgeLlmResult> {
  const generatedBy = input.generatedBy ?? "llm";
  const inputs = Array.isArray(input.candidateInputs) ? input.candidateInputs : [];
  if (inputs.length === 0) {
    return {
      ok: false,
      reviewedCount: 0,
      warnings: [],
      message: "Aha Relation Judge had no bounded candidate excerpts.",
      tool: "qmd",
      error: "No candidate excerpts were readable, so Relation Judge did not run.",
      candidates: input.candidates,
      relation_judge_prompt_version: RELATION_JUDGE_PROMPT_VERSION,
    };
  }

  const concurrency = input.concurrency ?? DEFAULT_PER_CANDIDATE_CONCURRENCY;
  const allJudged: RelationJudgeCandidate[] = [];
  const allWarnings: string[] = [];
  let failedCount = 0;

  const results = await mapConcurrent(inputs, concurrency, async (candidateInput) => {
    return judgeRelationsRawViaLlm(
      { sourcePath: input.sourcePath, sourceText: input.sourceText, candidateInputs: [candidateInput] },
      transportRequest,
      deps,
    );
  });

  for (const raw of results) {
    if (raw.ok) {
      allJudged.push(...raw.candidates);
      if (raw.repaired) allWarnings.push("Relation Judge retried once after schema validation failed.");
      for (const w of raw.warnings) allWarnings.push(`Relation Judge: ${w}`);
    } else {
      failedCount += 1;
    }
  }

  if (allJudged.length === 0 && failedCount > 0) {
    return {
      ok: false,
      reviewedCount: inputs.length,
      warnings: allWarnings,
      tool: generatedBy,
      error: `All ${inputs.length} candidate(s) failed relation judging.`,
      candidates: input.candidates,
      relation_judge_prompt_version: RELATION_JUDGE_PROMPT_VERSION,
      relation_judge_generated_by: generatedBy,
    };
  }

  if (failedCount > 0) {
    allWarnings.push(`${failedCount} of ${inputs.length} candidate(s) failed relation judging; labels remain weak.`);
  }

  const preserveOrder = input.preserveOrder !== false;
  const judged = mergeJudgedCandidates(input.candidates, allJudged, inputs, { preserveOrder });
  return {
    ok: true,
    reviewedCount: inputs.length,
    warnings: allWarnings,
    candidates: judged,
    relation_judge_prompt_version: RELATION_JUDGE_PROMPT_VERSION,
    relation_judge_generated_by: generatedBy,
  };
}

async function mapConcurrent<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;
  const lanes = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index]);
    }
  });
  await Promise.all(lanes);
  return results;
}
