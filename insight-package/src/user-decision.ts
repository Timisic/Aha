import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  type InsightSession,
  type UserDecisionProvenance,
  nowIso,
  textFromUnknown,
  textHash,
} from "./domain.ts";

type BranchEntry = {
  id?: unknown;
  role?: unknown;
  content?: unknown;
  text?: unknown;
  message?: {
    role?: unknown;
    content?: unknown;
  };
};

export function actionIdFor(toolName: string, toolCallId: string, userTurnRef?: string, decisionKey?: string): string {
  return [toolName, toolCallId, userTurnRef, decisionKey].filter(Boolean).join(":");
}

function entryRole(entry: BranchEntry): string | undefined {
  const role = entry.role ?? entry.message?.role;
  return typeof role === "string" ? role : undefined;
}

function entryId(entry: BranchEntry, index: number): string {
  const id = entry.id;
  if (typeof id === "string" && id.trim()) return id.trim();
  return `branch-entry-${index + 1}`;
}

function contentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (typeof item === "string") return item;
        if (item && typeof item === "object" && typeof (item as { text?: unknown }).text === "string") {
          return (item as { text: string }).text;
        }
        return textFromUnknown(item);
      })
      .join("\n");
  }
  return textFromUnknown(value);
}

function entryText(entry: BranchEntry): string {
  if (entry.content !== undefined) return contentText(entry.content);
  if (entry.text !== undefined) return contentText(entry.text);
  if (entry.message?.content !== undefined) return contentText(entry.message.content);
  return "";
}

function activeBranchEntries(ctx: ExtensionCommandContext): BranchEntry[] {
  const manager = ctx.sessionManager as {
    getBranch?: () => unknown[];
    getEntries?: () => unknown[];
  };
  const entries = typeof manager.getBranch === "function"
    ? manager.getBranch()
    : typeof manager.getEntries === "function"
      ? manager.getEntries()
      : [];
  return entries.filter((entry): entry is BranchEntry => Boolean(entry && typeof entry === "object"));
}

function knownDecisionUses(session: InsightSession): Array<{
  userTurnRef: string;
  kind: string;
  key: string;
}> {
  return [
    ...session.reviewedMemoryEvidence.map((item) => ({
      userTurnRef: item.userTurnRef,
      kind: "memory_review",
      key: `${item.candidateId}:${item.status}`,
    })),
    ...(session.noRelevantMemory ? [{
      userTurnRef: session.noRelevantMemory.userTurnRef,
      kind: "no_relevant_memory",
      key: "confirmed",
    }] : []),
    ...(session.summaryReadiness?.userTurnRef ? [{
      userTurnRef: session.summaryReadiness.userTurnRef,
      kind: "summary_readiness",
      key: "confirmed",
    }] : []),
    ...session.candidateJudgments
      .filter((item) => item.userTurnRef)
      .map((item) => ({
        userTurnRef: item.userTurnRef as string,
        kind: "candidate_judgment",
        key: `${item.text}:${item.userStatus ?? item.status ?? "pending"}`,
      })),
  ];
}

export function verifyUserDecision(
  ctx: ExtensionCommandContext,
  session: InsightSession,
  params: {
    userText: string;
    userTurnRef?: string;
    decisionKind: string;
    decisionKey: string;
  },
): UserDecisionProvenance {
  const suppliedText = params.userText.trim();
  if (!suppliedText) {
    throw new Error(`Cannot record ${params.decisionKind}; userText is required for verified user provenance.`);
  }

  const entries = activeBranchEntries(ctx);
  const userEntries = entries
    .map((entry, index) => ({ entry, index, id: entryId(entry, index), text: entryText(entry).trim() }))
    .filter((item) => entryRole(item.entry) === "user");
  const match = params.userTurnRef
    ? userEntries.find((item) => item.id === params.userTurnRef)
    : [...userEntries].reverse().find((item) => item.text === suppliedText);

  if (!match) {
    throw new Error(
      params.userTurnRef
        ? `Cannot record ${params.decisionKind}; user turn ${params.userTurnRef} was not found as a user message in the active Pi branch.`
        : `Cannot record ${params.decisionKind}; supplied userText does not match any user message in the active Pi branch.`,
    );
  }
  if (match.text !== suppliedText) {
    throw new Error(`Cannot record ${params.decisionKind}; supplied userText does not match user turn ${match.id}.`);
  }

  const conflicting = knownDecisionUses(session).find((item) =>
    item.userTurnRef === match.id &&
    item.kind !== params.decisionKind
  );
  if (conflicting) {
    throw new Error(
      `Cannot record ${params.decisionKind}; user turn ${match.id} is already bound to ${conflicting.kind}.`,
    );
  }

  return {
    userTurnRef: match.id,
    userText: suppliedText,
    userTextHash: textHash(match.text),
    verifiedAt: nowIso(),
  };
}
