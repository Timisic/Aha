import { existsSync, readFileSync } from "node:fs";
import type { ActiveSession } from "./domain.ts";
import { summaryDraftPathFor } from "./session.ts";

export function summaryArtifacts(active: ActiveSession): { summaryPath: string; exists: boolean; content?: string } {
  const summaryPath = summaryDraftPathFor(active.sessionDir);
  return {
    summaryPath,
    exists: existsSync(summaryPath),
    content: existsSync(summaryPath) ? readFileSync(summaryPath, "utf-8") : active.session.summaryDraft,
  };
}

export function formatSummaryInspection(active: ActiveSession, includeContent = false): string {
  const artifact = summaryArtifacts(active);
  return [
    `Summary draft for session ${active.session.id}`,
    `Stage: ${active.session.stage}`,
    `Path: ${artifact.summaryPath}`,
    `Saved file: ${artifact.exists ? "yes" : "no"}`,
    "Boundary: session-local only; not written to Obsidian and not future memory.",
    includeContent && artifact.content ? ["", "--- summary-draft.md ---", artifact.content.trim()].join("\n") : undefined,
  ].filter(Boolean).join("\n");
}
