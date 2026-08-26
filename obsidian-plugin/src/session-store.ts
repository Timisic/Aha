import type { AhaCandidate, AhaWrapperFailure, AhaWrapperResult } from "./schema";
import {
  renderGrillHandoff,
  seedLabelForAction,
  type ReviewBenchmarkSeedAction,
  type ReviewBenchmarkSeedInput,
  type ReviewBenchmarkSeedLabel,
  type ReviewPanelCandidate,
} from "./review-note";
import { sourceIdentityAllowsPathDrift, sourceReviewIndexKey } from "./source-identity";

export interface AhaSessionStoreData {
  schemaVersion: 1;
  records: Record<string, AhaSessionRecord>;
}

export interface AhaSessionRecord {
  schemaVersion: 1;
  key: string;
  source: AhaSessionSource;
  rounds: AhaSessionRound[];
  latestSuccessfulRoundId?: string;
  feedback: AhaSessionFeedback[];
  updatedAt: string;
}

export interface AhaSessionSource {
  id: string;
  path: string;
  title: string;
  fallbackPath: string;
  ctime?: number;
  mtime?: number;
  size?: number;
}

export type AhaSessionRoundStatus = "running" | "success" | "failed";

export interface AhaSessionRound {
  id: string;
  status: AhaSessionRoundStatus;
  generatedAt: string;
  sourcePath: string;
  sourceTitle: string;
  sourceSnapshot: AhaSessionSourceSnapshot;
  summary?: string;
  warnings: string[];
  candidates: ReviewPanelCandidate[];
  error?: AhaWrapperFailure;
}

export interface AhaSessionSourceSnapshot {
  path: string;
  ctime?: number;
  mtime?: number;
  size?: number;
}

export interface AhaSessionSourceInput {
  id: string;
  path: string;
  title: string;
  ctime?: number;
  mtime?: number;
  size?: number;
}

export interface RecordRunningSessionRoundInput {
  startedAt: Date;
  source: AhaSessionSourceInput;
}

export interface RecordSuccessfulSessionRoundInput {
  generatedAt: Date;
  result: AhaWrapperResult;
  source: AhaSessionSourceInput;
}

export interface RecordFailedSessionRoundInput {
  generatedAt: Date;
  failure: AhaWrapperFailure;
  source: AhaSessionSourceInput;
}

export interface SyncSessionSelectionResult {
  generatedAt: string;
  candidates: ReviewPanelCandidate[];
  handoff: string;
}

export interface AhaSessionStaleState {
  stale: boolean;
  pathChanged: boolean;
  mtimeChanged: boolean;
  sizeChanged: boolean;
}

export interface AhaSessionFeedbackInput {
  action: ReviewBenchmarkSeedAction;
  createdAt: Date;
  sourcePath: string;
  sourceTitle: string;
  candidate?: Pick<AhaCandidate, "notePath" | "noteTitle" | "relation" | "hit" | "why" | "quotes">;
  missingMemory?: string;
  note?: string;
}

export interface AhaSessionFeedback {
  action: ReviewBenchmarkSeedAction;
  status: "draft";
  seedLabel: ReviewBenchmarkSeedLabel;
  createdAt: string;
  sourcePath: string;
  sourceTitle: string;
  memory?: string;
  relation?: string;
  hit?: string;
  why?: string;
  note?: string;
}

const MAX_ROUNDS_PER_RECORD = 12;
const MAX_SUMMARY_LENGTH = 1000;
const MAX_WARNING_LENGTH = 500;
const MAX_FAILURE_DETAILS_LENGTH = 2000;
const MAX_WARNINGS_PER_ROUND = 8;

export function createEmptySessionStore(): AhaSessionStoreData {
  return {
    schemaVersion: 1,
    records: {},
  };
}

export function normalizeSessionStore(value: unknown): AhaSessionStoreData {
  if (!isRecord(value) || value.schemaVersion !== 1 || !isRecord(value.records)) {
    return createEmptySessionStore();
  }

  const records: Record<string, AhaSessionRecord> = {};
  for (const [key, record] of Object.entries(value.records)) {
    if (!isRecord(record)) continue;
    const normalized = normalizeRecord(key, record);
    if (normalized) records[key] = normalized;
  }
  return {
    schemaVersion: 1,
    records,
  };
}

export function sessionRecordKeyForSource(sourceId: string, sourcePath: string): string {
  return sourceIdentityAllowsPathDrift(sourceId)
    ? sourceId
    : sourceReviewIndexKey(sourceId, sourcePath);
}

export function findSessionRecord(store: AhaSessionStoreData, sourceId: string, sourcePath: string): AhaSessionRecord | null {
  const key = sessionRecordKeyForSource(sourceId, sourcePath);
  const direct = store.records[key];
  if (direct) return direct;

  return Object.values(store.records).find((record) => {
    if (record.source.id !== sourceId) return false;
    return sourceIdentityAllowsPathDrift(sourceId) || record.source.path === sourcePath || record.source.fallbackPath === sourcePath;
  }) ?? null;
}

export function recordRunningSessionRound(store: AhaSessionStoreData, input: RecordRunningSessionRoundInput): AhaSessionRecord {
  const record = ensureRecord(store, input.source, input.startedAt.toISOString());
  record.rounds = [
    ...record.rounds,
    {
      id: roundId("running", input.startedAt.toISOString()),
      status: "running",
      generatedAt: input.startedAt.toISOString(),
      sourcePath: input.source.path,
      sourceTitle: input.source.title,
      sourceSnapshot: sourceSnapshot(input.source),
      summary: "Aha wrapper is running.",
      warnings: [],
      candidates: [],
    },
  ];
  pruneRounds(record);
  touchRecord(record, input.source, input.startedAt.toISOString());
  return record;
}

export function recordSuccessfulSessionRound(store: AhaSessionStoreData, input: RecordSuccessfulSessionRoundInput): AhaSessionRecord {
  const generatedAt = input.result.generatedAt ?? input.generatedAt.toISOString();
  const record = ensureRecord(store, input.source, generatedAt);
  const candidates = candidatesForPanel(input.result.candidates ?? [], latestSuccessfulRound(record)?.candidates ?? []);
  const round: AhaSessionRound = {
    id: roundId("success", generatedAt),
    status: "success",
    generatedAt,
    sourcePath: input.source.path,
    sourceTitle: input.source.title,
    sourceSnapshot: sourceSnapshot(input.source),
    summary: compactText(input.result.summary?.trim() || "Aha completed a memory search round.", MAX_SUMMARY_LENGTH),
    warnings: compactWarnings(input.result.warnings ?? []),
    candidates,
    // Runtime Tier Fallback (issue #58): a successful round can still carry
    // a structured failure record (e.g. Full Tier's Relation Judge failing
    // mid-round, landing on Recall Tier results) attached in result.error.
    // Ordinary success results never set this, so this is additive.
    error: input.result.error ? compactFailure(input.result.error) : undefined,
  };
  replaceRound(record, round);
  record.latestSuccessfulRoundId = round.id;
  pruneRounds(record);
  touchRecord(record, input.source, generatedAt);
  return record;
}

export function recordFailedSessionRound(store: AhaSessionStoreData, input: RecordFailedSessionRoundInput): AhaSessionRecord {
  const generatedAt = input.generatedAt.toISOString();
  const record = ensureRecord(store, input.source, generatedAt);
  replaceRound(record, {
    id: roundId("failed", generatedAt),
    status: "failed",
    generatedAt,
    sourcePath: input.source.path,
    sourceTitle: input.source.title,
    sourceSnapshot: sourceSnapshot(input.source),
    summary: input.failure.message.trim() || "Aha wrapper failed.",
    warnings: [],
    candidates: [],
    error: compactFailure(input.failure),
  });
  pruneRounds(record);
  touchRecord(record, input.source, generatedAt);
  return record;
}

export function latestSuccessfulRound(record: AhaSessionRecord): AhaSessionRound | null {
  if (record.latestSuccessfulRoundId) {
    const matched = record.rounds.find((round) => round.id === record.latestSuccessfulRoundId && round.status === "success");
    if (matched) return matched;
  }
  return [...record.rounds].reverse().find((round) => round.status === "success") ?? null;
}

export function handoffForRound(record: AhaSessionRecord, round: AhaSessionRound): string {
  return renderGrillHandoff(record.source.path, record.source.title, round.candidates).join("\n");
}

export function staleStateForRound(round: AhaSessionRound, currentSource?: AhaSessionSourceSnapshot): AhaSessionStaleState {
  const pathChanged = Boolean(currentSource?.path && currentSource.path !== round.sourceSnapshot.path);
  const mtimeChanged = comparableNumberChanged(round.sourceSnapshot.mtime, currentSource?.mtime);
  const sizeChanged = comparableNumberChanged(round.sourceSnapshot.size, currentSource?.size);
  return {
    stale: pathChanged || mtimeChanged || sizeChanged,
    pathChanged,
    mtimeChanged,
    sizeChanged,
  };
}

export function syncSessionSelections(record: AhaSessionRecord, selectedByIndex: Map<number, boolean>, updatedAt = new Date()): SyncSessionSelectionResult {
  const round = latestSuccessfulRound(record);
  if (!round) {
    throw new Error("No successful Aha session round found.");
  }

  round.candidates = round.candidates.map((candidate) => ({
    ...candidate,
    selected: selectedByIndex.get(candidate.index) ?? candidate.selected,
  }));
  record.updatedAt = updatedAt.toISOString();
  return {
    generatedAt: round.generatedAt,
    candidates: round.candidates,
    handoff: handoffForRound(record, round),
  };
}

export function appendSessionFeedback(record: AhaSessionRecord, input: AhaSessionFeedbackInput): AhaSessionFeedback {
  const feedback: AhaSessionFeedback = {
    action: input.action,
    status: "draft",
    seedLabel: seedLabelForAction(input.action),
    createdAt: input.createdAt.toISOString(),
    sourcePath: input.sourcePath,
    sourceTitle: input.sourceTitle,
    memory: input.action === "should_have_found" ? input.missingMemory?.trim() : input.candidate?.notePath,
    relation: input.candidate?.relation,
    hit: input.candidate?.hit,
    why: input.candidate?.why,
    note: input.note?.trim() || undefined,
  };
  record.feedback = [...record.feedback, feedback];
  if (input.action === "reject_as_noise" && input.candidate?.notePath) {
    clearLatestCandidateSelection(record, input.candidate.notePath);
  }
  record.updatedAt = input.createdAt.toISOString();
  return feedback;
}

export function resultForSessionRound(round: AhaSessionRound): AhaWrapperResult {
  return {
    ok: true,
    sourcePath: round.sourcePath,
    generatedAt: round.generatedAt,
    summary: round.summary,
    warnings: round.warnings,
    candidates: round.candidates.map((candidate) => ({
      notePath: candidate.notePath,
      noteTitle: candidate.noteTitle,
      relation: candidate.relation,
      hit: candidate.hit,
      why: candidate.why,
      quotes: candidate.quotes,
      selected: candidate.selected,
    })),
  };
}

export function reviewSeedInputForSessionFeedback(feedback: AhaSessionFeedback): ReviewBenchmarkSeedInput | null {
  const createdAt = new Date(feedback.createdAt);
  if (Number.isNaN(createdAt.getTime())) return null;
  if (feedback.action === "should_have_found") {
    return {
      action: feedback.action,
      createdAt,
      sourcePath: feedback.sourcePath,
      sourceTitle: feedback.sourceTitle,
      missingMemory: feedback.memory,
      note: feedback.note,
    };
  }
  if (!feedback.memory || !feedback.relation || !feedback.hit || !feedback.why) return null;
  return {
    action: feedback.action,
    createdAt,
    sourcePath: feedback.sourcePath,
    sourceTitle: feedback.sourceTitle,
    candidate: {
      notePath: feedback.memory,
      relation: feedback.relation as AhaCandidate["relation"],
      hit: feedback.hit,
      why: feedback.why,
      quotes: [],
    },
    note: feedback.note,
  };
}

function ensureRecord(store: AhaSessionStoreData, source: AhaSessionSourceInput, updatedAt: string): AhaSessionRecord {
  const key = sessionRecordKeyForSource(source.id, source.path);
  const existing = findSessionRecord(store, source.id, source.path);
  if (existing) {
    if (existing.key !== key) {
      delete store.records[existing.key];
      existing.key = key;
      store.records[key] = existing;
    }
    return existing;
  }

  const record: AhaSessionRecord = {
    schemaVersion: 1,
    key,
    source: sourceForRecord(source),
    rounds: [],
    feedback: [],
    updatedAt,
  };
  store.records[key] = record;
  return record;
}

function replaceRound(record: AhaSessionRecord, round: AhaSessionRound): void {
  record.rounds = [
    ...record.rounds.filter((existing) => existing.id !== round.id && existing.status !== "running"),
    round,
  ];
}

function pruneRounds(record: AhaSessionRecord): void {
  if (record.rounds.length <= MAX_ROUNDS_PER_RECORD) return;
  const latestSuccess = latestSuccessfulRound(record);
  const retained = record.rounds.slice(-MAX_ROUNDS_PER_RECORD);
  if (latestSuccess && !retained.some((round) => round.id === latestSuccess.id)) {
    retained[0] = latestSuccess;
  }
  record.rounds = retained;
}

function touchRecord(record: AhaSessionRecord, source: AhaSessionSourceInput, updatedAt: string): void {
  record.source = sourceForRecord(source);
  record.updatedAt = updatedAt;
}

function sourceForRecord(source: AhaSessionSourceInput): AhaSessionSource {
  return {
    id: source.id,
    path: source.path,
    title: source.title,
    fallbackPath: source.path,
    ctime: source.ctime,
    mtime: source.mtime,
    size: source.size,
  };
}

function sourceSnapshot(source: AhaSessionSourceInput): AhaSessionSourceSnapshot {
  return {
    path: source.path,
    ctime: source.ctime,
    mtime: source.mtime,
    size: source.size,
  };
}

function candidatesForPanel(candidates: AhaCandidate[], previousCandidates: ReviewPanelCandidate[]): ReviewPanelCandidate[] {
  const previousByPath = new Map(previousCandidates.map((candidate) => [candidate.notePath, candidate]));
  const mapped = candidates.map((candidate, index) => {
    const previous = previousByPath.get(candidate.notePath);
    const selected = previous?.selected ?? candidate.selected ?? candidate.relation !== "weak";
    return {
      index: index + 1,
      notePath: candidate.notePath,
      noteTitle: candidate.noteTitle,
      relation: candidate.relation,
      hit: candidate.hit,
      why: candidate.why,
      quotes: [...(candidate.quotes ?? [])],
      selected,
    };
  });
  mapped.sort((a, b) => {
    const aWeak = a.relation === "weak" ? 1 : 0;
    const bWeak = b.relation === "weak" ? 1 : 0;
    return aWeak - bWeak;
  });
  for (let i = 0; i < mapped.length; i++) mapped[i].index = i + 1;
  return mapped;
}

function clearLatestCandidateSelection(record: AhaSessionRecord, notePath: string): void {
  const round = latestSuccessfulRound(record);
  if (!round) return;
  round.candidates = round.candidates.map((candidate) => candidate.notePath === notePath
    ? { ...candidate, selected: false }
    : candidate);
}

function roundId(status: AhaSessionRoundStatus, generatedAt: string): string {
  return `${status}:${generatedAt}`;
}

function normalizeRecord(key: string, record: Record<string, unknown>): AhaSessionRecord | null {
  if (record.schemaVersion !== 1 || !isRecord(record.source)) return null;
  const source = normalizeSource(record.source);
  if (!source) return null;
  const rounds = Array.isArray(record.rounds)
    ? record.rounds.map(normalizeRound).filter((round): round is AhaSessionRound => Boolean(round))
    : [];
  const feedback = Array.isArray(record.feedback)
    ? record.feedback.map(normalizeFeedback).filter((item): item is AhaSessionFeedback => Boolean(item))
    : [];
  return {
    schemaVersion: 1,
    key,
    source,
    rounds,
    latestSuccessfulRoundId: typeof record.latestSuccessfulRoundId === "string" ? record.latestSuccessfulRoundId : undefined,
    feedback,
    updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : new Date(0).toISOString(),
  };
}

function normalizeSource(source: Record<string, unknown>): AhaSessionSource | null {
  if (typeof source.id !== "string" || typeof source.path !== "string" || typeof source.title !== "string") return null;
  return {
    id: source.id,
    path: source.path,
    title: source.title,
    fallbackPath: typeof source.fallbackPath === "string" ? source.fallbackPath : source.path,
    ctime: finiteNumber(source.ctime),
    mtime: finiteNumber(source.mtime),
    size: finiteNumber(source.size),
  };
}

function normalizeRound(value: unknown): AhaSessionRound | null {
  if (!isRecord(value)) return null;
  if (typeof value.id !== "string" || typeof value.generatedAt !== "string") return null;
  if (value.status !== "running" && value.status !== "success" && value.status !== "failed") return null;
  const sourcePath = typeof value.sourcePath === "string" ? value.sourcePath : "";
  const sourceTitle = typeof value.sourceTitle === "string" ? value.sourceTitle : "";
  return {
    id: value.id,
    status: value.status,
    generatedAt: value.generatedAt,
    sourcePath,
    sourceTitle,
    sourceSnapshot: isRecord(value.sourceSnapshot) ? normalizeSourceSnapshot(value.sourceSnapshot, sourcePath) : { path: sourcePath },
    summary: typeof value.summary === "string" ? value.summary : undefined,
    warnings: Array.isArray(value.warnings) ? value.warnings.filter((warning): warning is string => typeof warning === "string") : [],
    candidates: Array.isArray(value.candidates) ? value.candidates.map(normalizeCandidate).filter((candidate): candidate is ReviewPanelCandidate => Boolean(candidate)) : [],
    error: isRecord(value.error) ? normalizeFailure(value.error) : undefined,
  };
}

function normalizeCandidate(value: unknown): ReviewPanelCandidate | null {
  if (!isRecord(value)) return null;
  if (typeof value.notePath !== "string" || typeof value.relation !== "string" || typeof value.hit !== "string" || typeof value.why !== "string") return null;
  return {
    index: typeof value.index === "number" ? value.index : 0,
    notePath: value.notePath,
    noteTitle: typeof value.noteTitle === "string" ? value.noteTitle : undefined,
    relation: value.relation as AhaCandidate["relation"],
    hit: value.hit,
    why: value.why,
    quotes: Array.isArray(value.quotes) ? value.quotes.filter((quote): quote is string => typeof quote === "string") : [],
    selected: value.selected !== false,
  };
}

function normalizeSourceSnapshot(value: Record<string, unknown>, fallbackPath: string): AhaSessionSourceSnapshot {
  return {
    path: typeof value.path === "string" ? value.path : fallbackPath,
    ctime: finiteNumber(value.ctime),
    mtime: finiteNumber(value.mtime),
    size: finiteNumber(value.size),
  };
}

function normalizeFeedback(value: unknown): AhaSessionFeedback | null {
  if (!isRecord(value) || typeof value.action !== "string" || typeof value.createdAt !== "string") return null;
  return {
    action: value.action as ReviewBenchmarkSeedAction,
    status: "draft",
    seedLabel: typeof value.seedLabel === "string" ? value.seedLabel as ReviewBenchmarkSeedLabel : seedLabelForAction(value.action as ReviewBenchmarkSeedAction),
    createdAt: value.createdAt,
    sourcePath: typeof value.sourcePath === "string" ? value.sourcePath : "",
    sourceTitle: typeof value.sourceTitle === "string" ? value.sourceTitle : "",
    memory: typeof value.memory === "string" ? value.memory : undefined,
    relation: typeof value.relation === "string" ? value.relation : undefined,
    hit: typeof value.hit === "string" ? value.hit : undefined,
    why: typeof value.why === "string" ? value.why : undefined,
    note: typeof value.note === "string" ? value.note : undefined,
  };
}

function normalizeFailure(value: Record<string, unknown>): AhaWrapperFailure {
  return compactFailure({
    message: typeof value.message === "string" ? value.message : "Aha wrapper failed.",
    tool: typeof value.tool === "string" ? value.tool : undefined,
    details: typeof value.details === "string" ? value.details : undefined,
  });
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function compactFailure(failure: AhaWrapperFailure): AhaWrapperFailure {
  return {
    message: compactText(failure.message, MAX_SUMMARY_LENGTH),
    tool: failure.tool,
    details: failure.details ? compactText(failure.details, MAX_FAILURE_DETAILS_LENGTH) : undefined,
  };
}

function compactWarnings(warnings: string[]): string[] {
  return warnings
    .filter((warning) => warning.trim())
    .slice(0, MAX_WARNINGS_PER_ROUND)
    .map((warning) => compactText(warning, MAX_WARNING_LENGTH));
}

function compactText(value: string, maxLength: number): string {
  const trimmed = value.replace(/\s+/g, " ").trim();
  if (trimmed.length <= maxLength) return trimmed;
  return `${trimmed.slice(0, maxLength - 3)}...`;
}

function comparableNumberChanged(before: number | undefined, after: number | undefined): boolean {
  return typeof before === "number" && typeof after === "number" && before !== after;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
