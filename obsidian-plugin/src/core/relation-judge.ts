// LLM-based Relation Judge shared between the plugin and bench (ADR 0005,
// issue #57). Ports the LLM-orchestration half of scripts/aha/relation-judge.mjs:
// prompt construction, the llmJsonCall round-trip with a validation-repair
// retry, quote-backed relation enforcement (the decision-for-decision-critical
// demotion to weak), candidate merging, and final-slate composition/ordering.
//
// Cache-file management, CLI option parsing, per-chunk concurrency, and the
// codex-CLI legacy adapter stay in scripts/aha/relation-judge.mjs (bench/Node
// infrastructure); this module offers the LLM round-trip + validation +
// quote-enforcement + merge primitives that infrastructure calls into,
// mirroring the query-plan split in query-plan-llm.ts.
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
import { AHA_RESULT_SCHEMA, validateAhaResult } from "./result-validator";

export const RELATION_JUDGE_PROMPT_VERSION = "aha-relation-judge-v4";
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

/** Verbatim port of buildRelationJudgePrompt from scripts/aha/relation-judge.mjs. */
export function buildRelationJudgePrompt({ sourcePath, sourceText, candidateInputs }: BuildRelationJudgePromptArgs): string {
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
  if (Array.isArray(normalized.candidates)) {
    normalized.candidates = normalized.candidates.map((candidate) => {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return candidate;
      const next: Record<string, unknown> = { ...(candidate as Record<string, unknown>) };
      for (const key of ["noteTitle", "quotes", "selected"]) {
        if (next[key] === null) delete next[key];
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
    .map((value) => normalizeEvidenceText(value).replace(/^["'“”‘’]+|["'“”‘’]+$/g, ""))
    .filter((value) => value.length >= 8);
  return needles.some((needle) => {
    if (haystack.includes(needle)) return true;
    const fingerprint = evidenceFingerprint(needle);
    return fingerprint.length >= 8 && haystackFingerprint.includes(fingerprint);
  });
}

function normalizeEvidenceText(value: unknown): string {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function evidenceFingerprint(value: unknown): string {
  return String(value ?? "").replace(/[\s\p{P}\p{S}]+/gu, "");
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
): { ok: true; value: NormalizedRelationJudgeOutput } | { ok: false; errors: string[] } {
  const parsed = normalizeStructuredResult(output) as NormalizedRelationJudgeOutput;
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

  let repaired = false;
  let validated = validatedRelationJudgeOutput(attempt.json);
  if (!validated.ok) {
    const repairAttempt = await callLlm(buildRelationJudgeRepairPrompt(prompt, validated.errors.join("; ")));
    if (!repairAttempt.ok) return { ok: false, error: repairAttempt.error };
    repaired = true;
    validated = validatedRelationJudgeOutput(repairAttempt.json);
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

/**
 * One-shot (non-chunked) Relation Judge orchestration: LLM round-trip +
 * validate + repair-retry + merge, returning the same ok:true/ok:false shape
 * as the legacy adapter-based judgeCandidateRelations in
 * scripts/aha/relation-judge.mjs. This is the structured failed-search
 * record the issue's acceptance criteria requires on LLM failure: it is never
 * shaped like a success (`ok:true`) when the LLM call, validation, or repair
 * retry all fail.
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

  const raw = await judgeRelationsRawViaLlm(
    { sourcePath: input.sourcePath, sourceText: input.sourceText, candidateInputs: inputs },
    transportRequest,
    deps,
  );
  if (!raw.ok) {
    return {
      ok: false,
      reviewedCount: inputs.length,
      warnings: [],
      tool: generatedBy,
      error: raw.error,
      candidates: input.candidates,
      relation_judge_prompt_version: RELATION_JUDGE_PROMPT_VERSION,
      relation_judge_generated_by: generatedBy,
    };
  }

  const preserveOrder = input.preserveOrder !== false;
  const judged = mergeJudgedCandidates(input.candidates, raw.candidates, inputs, { preserveOrder });
  return {
    ok: true,
    reviewedCount: inputs.length,
    warnings: [
      ...(raw.repaired ? ["Relation Judge retried once after schema validation failed."] : []),
      ...raw.warnings.map((warning) => `Relation Judge: ${warning}`),
    ],
    candidates: judged,
    summary: raw.summary,
    relation_judge_prompt_version: RELATION_JUDGE_PROMPT_VERSION,
    relation_judge_generated_by: generatedBy,
  };
}
