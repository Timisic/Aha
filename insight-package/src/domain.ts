import { createHash, randomBytes } from "node:crypto";
import { realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

export type MemoryQueryCommand =
  | "qmd query"
  | "qmd vsearch"
  | "qmd search";
export type MemoryCandidateSource =
  | "qmd_query"
  | "qmd_vsearch"
  | "qmd_search"
  | "obsidian_backlink";
export type Stage = "memory" | "memory_review" | "review_grill" | "summary" | "complete";
export type MemoryQueryKind = "raw" | "abstracted_judgment" | "contextual" | "explicit_cue";
export type MemoryQueryInputKind =
  | MemoryQueryKind
  | "open-ended"
  | "constraint"
  | "challenge"
  | "support"
  | "bounds";
export type MemoryRelation = "supports" | "challenges" | "bounds" | "resembles";
export type MemoryReviewStatus = "accepted" | "rejected" | "uncertain";
export type MemorySearchOutcome = "candidates_found" | "no_candidates" | "failed";
export type ExplicitCueStatus = "found_top_k" | "found_pool" | "not_found" | "ambiguous";

export interface UserDecisionProvenance {
  userTurnRef: string;
  userTextHash: string;
  userText?: string;
  verifiedAt: string;
}

export interface ReviewedMemoryEvidence extends UserDecisionProvenance {
  actionId: string;
  candidateId: string;
  title: string;
  slug?: string;
  relation: MemoryRelation;
  reason: string;
  whyReadFirst: string;
  status: MemoryReviewStatus;
  rationale?: string;
  reviewedAt: string;
  canonicalIdentity?: string;
}

export interface QmdStructuredQuery {
  intent: string;
  lex: string[];
  vec: string;
  hyde: string;
}

export interface InsightSession {
  schemaVersion: number;
  id: string;
  stage: Stage;
  originCwd: string;
  rawInsight: string;
  context: string;
  displayTitle?: string;
  archivedAt?: string;
  sourceNote?: {
    path?: string;
    content: string;
    contentHash?: string;
    headingsSnapshot?: string[];
  };
  memoryQueries: Array<{
    text: string;
    kind: MemoryQueryKind;
    command: MemoryQueryCommand;
    qmd?: QmdStructuredQuery;
  }>;
  explicitMemoryCues: string[];
  missingExplicitCues: string[];
  explicitCueResults: Array<{
    cue: string;
    status: ExplicitCueStatus;
    candidateId?: string;
    rank?: number;
    matchedCandidateIds?: string[];
  }>;
  memorySearchOutcome?: MemorySearchOutcome;
  memoryCandidatePool: MemoryCandidate[];
  memoryCandidates: MemoryCandidate[];
  candidateTable?: {
    version: string;
    createdAt: string;
    candidateIds: string[];
  };
  reviewedMemoryEvidence: ReviewedMemoryEvidence[];
  memoryReviews: Array<{
    candidateId: string;
    status: MemoryReviewStatus;
    rationale?: string;
    reviewedAt: string;
    userTurnRef?: string;
    userTextHash?: string;
    actionId?: string;
  }>;
  noRelevantMemory?: UserDecisionProvenance & {
    actionId: string;
    confirmedAt: string;
  };
  usedMemoryIds: string[];
  appliedActionIds: string[];
  newInsights: Array<{
    actionId?: string;
    text: string;
    openedDirection: boolean;
    triggeredMemorySearch: boolean;
  }>;
  grillTurns: Array<{
    actionId?: string;
    question: string;
    answer?: string;
    resultingInsight?: string;
    createdAt: string;
  }>;
  candidateJudgments: Array<{
    id?: string;
    text: string;
    status?: "pending" | "accepted" | "rejected" | "revised";
    userStatus?: "pending" | "accepted" | "rejected" | "revised";
    evidenceMemoryIds?: string[];
    proposedAt?: string;
    userTurnRef?: string;
    userTextHash?: string;
    confirmedAt?: string;
    actionId?: string;
    replacesId?: string;
  }>;
  summaryReadiness?: {
    actionId?: string;
    confirmedAt: string;
    userText: string;
    userTurnRef?: string;
    userTextHash: string;
    verifiedAt?: string;
  };
  summaryDraft?: string;
  unresolvedQuestions: string[];
  createdAt: string;
  updatedAt: string;
}

export interface MemoryCandidate {
    id: string;
    title: string;
    slug?: string;
    canonicalPath?: string;
    canonicalId?: string;
    identityStatus?: "resolved" | "ambiguous" | "unresolved";
    identityMatches?: string[];
    aliases?: string[];
    relation: MemoryRelation;
    reason: string;
    whyReadFirst: string;
    searchSignals?: {
      queryText?: string;
      rank?: number;
      queryKind?: MemoryQueryKind;
      queryKinds?: MemoryQueryKind[];
      source?: MemoryCandidateSource;
      sources?: MemoryCandidateSource[];
      expansionFrom?: string;
      expansionFroms?: string[];
      expansionType?: "backlink";
    };
}

export interface ActiveSession {
  sessionDir: string;
  statePath: string;
  grillContextPath: string;
  stageBriefingPath: string;
  grillBriefingPath: string;
  session: InsightSession;
}

export interface InsightUpdateStateParams {
  stage?: Stage;
  note?: string;
  usedMemoryIds?: string[];
  newInsight?: {
    text: string;
    openedDirection?: boolean;
    triggeredMemorySearch?: boolean;
  };
  grillTurn?: {
    question: string;
    answer?: string;
    resultingInsight?: string;
  };
  candidateJudgment?: {
    text: string;
    userStatus?: "pending" | "accepted" | "rejected" | "revised";
    evidenceMemoryIds?: string[];
    userText?: string;
    userTurnRef?: string;
    replacesId?: string;
  };
  memoryReview?: {
    candidateId: string;
    status: MemoryReviewStatus;
    rationale?: string;
    userText?: string;
    userTurnRef?: string;
  };
  memoryReviews?: Array<{
    candidateId: string;
    status: MemoryReviewStatus;
    rationale?: string;
    userText?: string;
    userTurnRef?: string;
  }>;
  summaryDraft?: string;
}

export interface InsightConfirmReadinessParams {
  userText: string;
  userTurnRef?: string;
}

export interface InsightConfirmNoRelevantMemoryParams {
  userText: string;
  userTurnRef?: string;
}

export interface InsightSearchMemoryParams {
  queries: Array<{
    text?: string;
    kind: MemoryQueryInputKind;
    command?: MemoryQueryCommand;
    qmd?: QmdStructuredQuery;
  }>;
  limit?: number;
}

export interface MemorySearchCandidate {
  id: string;
  title: string;
  slug?: string;
  canonicalPath?: string;
  canonicalId?: string;
  identityStatus?: "resolved" | "ambiguous" | "unresolved";
  identityMatches?: string[];
  aliases?: string[];
  content?: string;
  rank?: number;
  queryText: string;
  source?: MemoryCandidateSource;
  sources?: MemoryCandidateSource[];
  queryKind?: MemoryQueryKind;
  queryKinds?: MemoryQueryKind[];
  expansionFrom?: string;
  expansionFroms?: string[];
  expansionType?: "backlink";
}

export interface ObsidianBacklink {
  title: string;
  path?: string;
  content?: string;
  count?: number;
  sourceCandidateId: string;
  sourceTitle: string;
}

export type ProviderOutcomeStatus =
  | "ok"
  | "empty"
  | "timeout"
  | "cancelled"
  | "unavailable"
  | "invalid_output"
  | "failed"
  | "partial";

export interface CommandResult {
  stdout: string;
  stderr: string;
  code: number | null;
  killed: boolean;
  cancelled?: boolean;
  timedOut?: boolean;
}

export interface ProviderOutcome<T> {
  status: ProviderOutcomeStatus;
  value: T;
  diagnostics: string[];
  command?: string;
  durationMs?: number;
  timedOut?: boolean;
  cancelled?: boolean;
}

export interface InsightAppendGrillContextParams {
  heading?: string;
  body: string;
}

export interface InsightSaveSummaryParams {
  summaryDraft: string;
  usedMemoryIds?: string[];
  unresolvedQuestions?: string[];
  preserveSourceStructure?: boolean;
  markComplete?: boolean;
}

export interface SimpleComponent {
  invalidate?(): void;
  render(width: number): string[];
}

export interface InsightSessionBinding {
  active?: boolean;
  sessionId?: string;
  sessionDir?: string;
  statePath?: string;
  updatedAt?: string;
}

export const ACTIVE_STATUS_KEY = "insight";
export const SESSION_BINDING_CUSTOM_TYPE = "insight.active_session";
export const SECTION_NAMES = [
  "raw insight",
  "insight",
  "context",
  "source note",
  "connected history notes",
  "原始洞察",
  "洞察",
  "启发",
  "上下文",
  "背景",
  "原始笔记",
  "obsidian 原始笔记",
  "obsidian笔记",
  "相关旧笔记",
  "历史笔记",
];
export const GRILL_INSIGHT_PATH = join(
  process.env.HOME ?? "",
  ".agents",
  "skills",
  "grill-insight",
  "SKILL.md",
);
export const QMD_TIMEOUT_MS = 90_000;
export const OBSIDIAN_TIMEOUT_MS = 8_000;
export const RETRIEVAL_DEADLINE_MS = Number(process.env.INSIGHT_RETRIEVAL_DEADLINE_MS) || QMD_TIMEOUT_MS;
export const QMD_QUERY_CONCURRENCY = Math.max(1, Number(process.env.INSIGHT_QMD_QUERY_CONCURRENCY) || 3);
export const BACKLINK_CONCURRENCY = Math.max(1, Number(process.env.INSIGHT_BACKLINK_CONCURRENCY) || 4);
export const PROCESS_KILL_GRACE_MS = Math.max(25, Number(process.env.INSIGHT_PROCESS_KILL_GRACE_MS) || 250);
export const BACKLINK_SEED_LIMIT = 10;
export const BACKLINKS_PER_SEED_LIMIT = 5;
export const BACKLINK_CANDIDATE_LIMIT = 20;
export const SESSION_ID_BYTES = 8;
export const COMMAND_OUTPUT_MAX_BYTES = Number(process.env.INSIGHT_COMMAND_OUTPUT_MAX_BYTES) || 1_000_000;
export const SOURCE_NOTE_MAX_BYTES = Number(process.env.INSIGHT_SOURCE_NOTE_MAX_BYTES) || 512_000;
export const STAGE_BRIEFING_TOTAL_MAX_BYTES = Number(process.env.INSIGHT_STAGE_BRIEFING_TOTAL_MAX_BYTES) || 96_000;
export const STAGES = new Set<Stage>(["memory", "memory_review", "review_grill", "summary", "complete"]);
export const INSIGHT_STATE_SCHEMA_VERSION = 1;

export function shouldExpandBacklinks(): boolean {
  const value = process.env.INSIGHT_EXPAND_BACKLINKS?.trim().toLowerCase();
  if (!value) return true;
  return !["0", "false", "no", "off"].includes(value);
}

export function textHash(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 32);
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function dateStamp(date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

export function slugify(input: string): string {
  const ascii = input
    .normalize("NFKD")
    .replace(/[^\p{Letter}\p{Number}\s-]/gu, "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 48);
  return ascii || "insight";
}

export function safeRealpath(path: string): string | undefined {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
}

export function isPathInside(parent: string, child: string): boolean {
  const parentPath = safeRealpath(parent) ?? resolve(parent);
  const childPath = safeRealpath(child) ?? resolve(child);
  const rel = relative(parentPath, childPath);
  return rel === "" || (!!rel && !rel.startsWith("..") && !isAbsolute(rel));
}

export function configuredSourceRoots(cwd: string): string[] {
  const configured = process.env.INSIGHT_SOURCE_ROOTS?.trim();
  const roots = configured
    ? configured.split(":").map((item) => item.trim()).filter(Boolean)
    : [join(process.env.HOME ?? "", "Obsidian Notes"), cwd];
  return roots.map((root) => resolve(root));
}

export function shortId(): string {
  return randomBytes(SESSION_ID_BYTES).toString("hex");
}

export function normalizeInsightArgs(args: string): string {
  const trimmed = args.trim();
  if (trimmed === "/insight") return "";
  if (trimmed.startsWith("/insight ")) {
    return trimmed.slice("/insight".length).trim();
  }
  return trimmed;
}

export function normalizeMemoryQueryKind(kind: MemoryQueryInputKind): MemoryQueryKind {
  if (kind === "open-ended" || kind === "constraint") return "contextual";
  if (kind === "challenge" || kind === "support" || kind === "bounds") {
    return "abstracted_judgment";
  }
  return kind;
}

export function textFromUnknown(value: unknown): string {
  if (typeof value === "string") return value;
  if (value == null) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function compactLine(value: string, limit = 180): string {
  return value.replace(/\s+/g, " ").trim().slice(0, limit);
}
