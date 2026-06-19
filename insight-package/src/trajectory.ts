import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { ActiveSession, CommandResult, MemoryQueryCommand, MemoryQueryKind, QmdStructuredQuery } from "./domain.ts";
import { compactLine, nowIso } from "./domain.ts";

const EVENT_PREVIEW_BYTES = Number(process.env.INSIGHT_TRAJECTORY_EVENT_PREVIEW_BYTES) || 8_192;
const ARTIFACT_MAX_BYTES = Number(process.env.INSIGHT_TRAJECTORY_ARTIFACT_MAX_BYTES) || 512_000;

export interface TrajectoryArtifactRef {
  path: string;
  relativePath: string;
  sha256: string;
  bytes: number;
  truncated: boolean;
}

export interface TrajectorySummary {
  sha256: string;
  bytes: number;
  preview: string;
  truncated: boolean;
}

export function trajectoryEnabled(): boolean {
  const value = (process.env.INSIGHT_TRAJECTORY ?? process.env.INSIGHT_DEBUG_TRAJECTORY ?? "")
    .trim()
    .toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

export function trajectoryDirFor(active: ActiveSession): string {
  return join(active.sessionDir, "trajectory");
}

export function trajectoryEventsPathFor(active: ActiveSession): string {
  return join(trajectoryDirFor(active), "events.jsonl");
}

export function stableTrajectoryHash(value: unknown): string {
  return createHash("sha256").update(stringifyForHash(value)).digest("hex");
}

export function summarizeTrajectoryValue(value: unknown, maxBytes = EVENT_PREVIEW_BYTES): TrajectorySummary {
  const fullText = stringifyForHash(value);
  const bytes = Buffer.byteLength(fullText, "utf-8");
  const truncated = bytes > maxBytes;
  const text = truncated ? stringifyStable(value, maxBytes) : fullText;
  const preview = truncated
    ? Buffer.from(text, "utf-8").subarray(0, maxBytes).toString("utf-8")
    : text;
  return {
    sha256: stableTrajectoryHash(value),
    bytes,
    preview,
    truncated,
  };
}

export function writeTrajectoryArtifact(
  active: ActiveSession | undefined,
  group: string,
  stem: string,
  payload: unknown,
): TrajectoryArtifactRef | undefined {
  if (!active || !trajectoryEnabled()) return undefined;

  try {
    const root = trajectoryDirFor(active);
    const safeGroup = safeName(group || "artifacts");
    const safeStem = safeName(stem || "artifact");
    const dir = join(root, safeGroup);
    mkdirSync(dir, { recursive: true });

    const sequence = nextArtifactSequence(dir, safeStem);
    const path = join(dir, `${safeStem}-${String(sequence).padStart(4, "0")}.json`);
    const summary = summarizeTrajectoryValue(payload, ARTIFACT_MAX_BYTES);
    const body = summary.truncated
      ? {
          sha256: summary.sha256,
          bytes: summary.bytes,
          truncated: true,
          preview: summary.preview,
        }
      : payload;
    const serialized = JSON.stringify(normalizeJsonValue(body, 0, ARTIFACT_MAX_BYTES), null, 2) + "\n";
    writeFileSync(path, serialized, "utf-8");
    return {
      path,
      relativePath: join("trajectory", safeGroup, basename(path)),
      sha256: summary.sha256,
      bytes: summary.bytes,
      truncated: summary.truncated,
    };
  } catch {
    return undefined;
  }
}

export function recordTrajectoryEvent(
  active: ActiveSession | undefined,
  event: string,
  payload: Record<string, unknown> = {},
): void {
  if (!active || !trajectoryEnabled()) return;

  try {
    const root = trajectoryDirFor(active);
    mkdirSync(root, { recursive: true });
    const line = {
      ts: nowIso(),
      event,
      sessionId: active.session.id,
      stage: active.session.stage,
      data: normalizeJsonValue(payload, 0, EVENT_PREVIEW_BYTES),
    };
    appendFileSync(trajectoryEventsPathFor(active), JSON.stringify(line) + "\n", "utf-8");
  } catch {
    // Trajectory is a debug side channel. It must never break the insight workflow.
  }
}

export function recordTrajectorySessionStarted(active: ActiveSession, payload: Record<string, unknown>): void {
  recordTrajectoryEvent(active, "session_started", payload);
}

export function recordTrajectorySessionRestored(active: ActiveSession, payload: Record<string, unknown>): void {
  recordTrajectoryEvent(active, "session_restored", payload);
}

export function recordTrajectorySessionCancelled(active: ActiveSession | undefined, payload: Record<string, unknown>): void {
  recordTrajectoryEvent(active, "session_cancelled", payload);
}

export function recordTrajectoryContextSeen(
  active: ActiveSession | undefined,
  payload: {
    compact: boolean;
    beforeMessageCount: number;
    pendingPromptText: string;
  },
): void {
  recordTrajectoryEvent(active, "context_seen", {
    compact: payload.compact,
    beforeMessageCount: payload.beforeMessageCount,
    pendingPromptHash: stableTrajectoryHash(payload.pendingPromptText),
  });
}

export function recordTrajectoryContextBuilt(
  active: ActiveSession | undefined,
  payload: {
    compact: boolean;
    insertAt: number;
    beforeMessages: unknown[];
    hiddenMessage: unknown;
    afterMessages: unknown[];
  },
): void {
  const artifact = writeTrajectoryArtifact(active, "contexts", "context-injection", payload);
  recordTrajectoryEvent(active, "context_built", {
    compact: payload.compact,
    beforeMessageCount: payload.beforeMessages.length,
    afterMessageCount: payload.afterMessages.length,
    insertAt: payload.insertAt,
    contextHash: stableTrajectoryHash((payload.hiddenMessage as { content?: unknown }).content),
    beforeMessages: summarizeTrajectoryValue(payload.beforeMessages),
    hiddenMessage: summarizeTrajectoryValue(payload.hiddenMessage),
    artifact,
  });
}

export function recordTrajectoryToolPolicy(
  active: ActiveSession | undefined,
  payload: {
    toolName: string;
    toolCallId?: unknown;
    input: unknown;
    blockReason?: string;
  },
): void {
  const inputArtifact = writeTrajectoryArtifact(
    active,
    "tool-calls",
    `tool-call-${payload.toolName}-input`,
    payload.input,
  );
  recordTrajectoryEvent(active, payload.blockReason ? "tool_call_blocked" : "tool_call_requested", {
    toolName: payload.toolName,
    toolCallId: payload.toolCallId,
    activeStage: active?.session.stage,
    input: summarizeTrajectoryValue(payload.input),
    inputArtifact,
    blockReason: payload.blockReason,
  });
}

export function recordTrajectoryToolStarted(
  active: ActiveSession | undefined,
  payload: { toolName: string; toolCallId: string; params: unknown },
): void {
  const inputArtifact = writeTrajectoryArtifact(
    active,
    "tool-calls",
    `tool-${payload.toolCallId || payload.toolName}-${payload.toolName}-input`,
    payload.params,
  );
  recordTrajectoryEvent(active, "tool_started", {
    toolName: payload.toolName,
    toolCallId: payload.toolCallId,
    input: summarizeTrajectoryValue(payload.params),
    inputArtifact,
  });
}

export function recordTrajectoryToolFinished(
  active: ActiveSession | undefined,
  payload: {
    toolName: string;
    toolCallId: string;
    startedAt: number;
    result?: unknown;
    error?: unknown;
  },
): void {
  if (payload.error !== undefined) {
    recordTrajectoryEvent(active, "tool_finished", {
      toolName: payload.toolName,
      toolCallId: payload.toolCallId,
      status: "error",
      durationMs: Date.now() - payload.startedAt,
      error: errorSummary(payload.error),
    });
    return;
  }

  const outputArtifact = writeTrajectoryArtifact(
    active,
    "tool-results",
    `tool-${payload.toolCallId || payload.toolName}-${payload.toolName}-result`,
    payload.result,
  );
  recordTrajectoryEvent(active, "tool_finished", {
    toolName: payload.toolName,
    toolCallId: payload.toolCallId,
    status: "ok",
    durationMs: Date.now() - payload.startedAt,
    output: summarizeTrajectoryValue(payload.result),
    outputArtifact,
    details: summarizeTrajectoryValue((payload.result as { details?: unknown } | undefined)?.details),
  });
}

export function recordTrajectoryMemoryQueryStarted(
  active: ActiveSession,
  payload: {
    kind: MemoryQueryKind;
    command: MemoryQueryCommand;
    text: string;
    qmd?: QmdStructuredQuery;
    qmdQuery: string;
    retrievalLimit: number;
  },
): void {
  const queryArtifact = writeTrajectoryArtifact(active, "memory", "memory-query", payload);
  recordTrajectoryEvent(active, "memory_query_started", {
    kind: payload.kind,
    command: payload.command,
    text: summarizeTrajectoryValue(payload.text),
    qmd: payload.qmd,
    qmdQuery: summarizeTrajectoryValue(payload.qmdQuery),
    queryArtifact,
    retrievalLimit: payload.retrievalLimit,
  });
}

export function recordTrajectoryQmdCallFinished(
  active: ActiveSession,
  payload: {
    kind: MemoryQueryKind;
    command: MemoryQueryCommand;
    text: string;
    startedAt: number;
    result: CommandResult;
    connectivityIssue?: string;
    parsedCandidates: unknown[];
  },
): void {
  const outputArtifact = writeTrajectoryArtifact(active, "memory", "qmd-output", {
    kind: payload.kind,
    command: payload.command,
    text: payload.text,
    stdout: payload.result.stdout,
    stderr: payload.result.stderr,
    code: payload.result.code,
    killed: payload.result.killed,
    connectivityIssue: payload.connectivityIssue,
    parsedCandidates: payload.parsedCandidates,
  });
  recordTrajectoryEvent(active, "qmd_call_finished", {
    kind: payload.kind,
    command: payload.command,
    durationMs: Date.now() - payload.startedAt,
    code: payload.result.code,
    killed: payload.result.killed,
    connectivityIssue: payload.connectivityIssue,
    stdout: summarizeTrajectoryValue(payload.result.stdout),
    stderr: summarizeTrajectoryValue(payload.result.stderr),
    parsedCandidateCount: payload.parsedCandidates.length,
    outputArtifact,
  });
}

function errorSummary(error: unknown): unknown {
  return error instanceof Error
    ? { name: error.name, message: error.message, stack: error.stack }
    : String(error);
}

function safeName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "artifact";
}

function nextArtifactSequence(dir: string, stem: string): number {
  if (!existsSync(dir)) return 1;
  const pattern = new RegExp(`^${escapeRegExp(stem)}-(\\d{4})\\.json$`);
  let max = 0;
  for (const name of readdirSync(dir)) {
    const match = pattern.exec(name);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return max + 1;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stringifyStable(value: unknown, stringLimit = EVENT_PREVIEW_BYTES): string {
  try {
    return JSON.stringify(normalizeJsonValue(value, 0, stringLimit)) ?? "undefined";
  } catch {
    return String(value);
  }
}

function normalizeJsonValue(value: unknown, depth = 0, stringLimit = EVENT_PREVIEW_BYTES): unknown {
  if (value == null) return value;
  if (typeof value === "string") {
    const bytes = Buffer.byteLength(value, "utf-8");
    if (bytes <= stringLimit) return value;
    return {
      sha256: createHash("sha256").update(value).digest("hex"),
      bytes,
      truncated: true,
      preview: compactLine(value, 1_000),
    };
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "function" || typeof value === "symbol") return String(value);
  if (depth >= 8) return summarizeTrajectoryValue(value, 1_024);
  if (Array.isArray(value)) {
    const items = value.slice(0, 80).map((item) => normalizeJsonValue(item, depth + 1, stringLimit));
    if (value.length > 80) {
      items.push({ truncatedItems: value.length - 80 });
    }
    return items;
  }
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
    };
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort().slice(0, 120)) {
      out[key] = normalizeJsonValue(record[key], depth + 1, stringLimit);
    }
    const keyCount = Object.keys(record).length;
    if (keyCount > 120) out.truncatedKeys = keyCount - 120;
    return out;
  }
  return String(value);
}

function stringifyForHash(value: unknown): string {
  try {
    return JSON.stringify(normalizeJsonValueForHash(value)) ?? "undefined";
  } catch {
    return String(value);
  }
}

function normalizeJsonValueForHash(value: unknown, depth = 0): unknown {
  if (value == null) return value;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "function" || typeof value === "symbol") return String(value);
  if (depth >= 20) return String(value);
  if (Array.isArray(value)) return value.map((item) => normalizeJsonValueForHash(item, depth + 1));
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
    };
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      out[key] = normalizeJsonValueForHash(record[key], depth + 1);
    }
    return out;
  }
  return String(value);
}
