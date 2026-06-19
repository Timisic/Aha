import { existsSync } from "node:fs";
import { textHash, type ActiveSession, type InsightSession, type MemoryCandidate, type MemoryReviewStatus } from "./domain.ts";
import { sourceLabel } from "./memory.ts";

export function candidateTableVersion(candidates: MemoryCandidate[]): string {
  return textHash(JSON.stringify(candidates.map((candidate, index) => [index + 1, candidate.id]))).slice(0, 12);
}

export function recordCandidateTableSnapshot(session: InsightSession): void {
  session.candidateTable = {
    version: candidateTableVersion(session.memoryCandidates),
    createdAt: new Date().toISOString(),
    candidateIds: session.memoryCandidates.map((candidate) => candidate.id),
  };
}

function reviewStatusFor(active: ActiveSession, candidateId: string): MemoryReviewStatus | "unreviewed" {
  return active.session.memoryReviews.find((review) => review.candidateId === candidateId)?.status ?? "unreviewed";
}

function candidatePath(candidate: MemoryCandidate): string | undefined {
  return candidate.slug || (candidate.id.includes("/") || candidate.id.endsWith(".md") ? candidate.id : undefined);
}

function parseSelectorToken(selector: string): { selector: string; tableVersion?: string } {
  const trimmed = selector.trim();
  const match = /^(.*?)@([a-f0-9]{6,32})$/i.exec(trimmed);
  return match ? { selector: match[1].trim(), tableVersion: match[2] } : { selector: trimmed };
}

export interface CandidateResolution {
  candidate: MemoryCandidate;
  index: number;
  tableVersion: string;
}

export function resolveCandidateSelector(
  active: ActiveSession,
  rawSelector: string,
  expectedTableVersion?: string,
): CandidateResolution {
  const parsed = parseSelectorToken(rawSelector);
  const selector = parsed.selector;
  const tableVersion = active.session.candidateTable?.version ?? candidateTableVersion(active.session.memoryCandidates);
  const expected = expectedTableVersion ?? parsed.tableVersion;
  if (expected && expected !== tableVersion) {
    throw new Error(`Stale candidate selector for table ${expected}. Refresh candidates and use current table ${tableVersion}.`);
  }

  if (/^\d+$/.test(selector)) {
    const index = Number(selector) - 1;
    const candidateId = active.session.candidateTable?.candidateIds[index] ?? active.session.memoryCandidates[index]?.id;
    if (!candidateId) throw new Error(`Unknown candidate number: ${selector}`);
    const candidate = active.session.memoryCandidates.find((item) => item.id === candidateId);
    if (!candidate) throw new Error(`Candidate ${selector} is no longer in the current displayed table. Refresh candidates.`);
    return { candidate, index, tableVersion };
  }

  const matches = active.session.memoryCandidates
    .map((candidate, index) => ({ candidate, index }))
    .filter(({ candidate }) => candidate.id === selector || candidate.slug === selector);
  if (matches.length === 1) return { ...matches[0], tableVersion };
  if (matches.length > 1) {
    throw new Error(`Ambiguous candidate identity '${selector}'. Use the displayed number with table ${tableVersion}.`);
  }
  throw new Error(`Unknown candidate selector: ${selector}`);
}

export function formatCandidateInspection(active: ActiveSession, resolution: CandidateResolution): string {
  const { candidate, index, tableVersion } = resolution;
  const path = candidatePath(candidate);
  const obsidianUri = path ? `obsidian://open?path=${encodeURIComponent(path)}` : undefined;
  return [
    `Candidate ${index + 1} · table ${tableVersion}`,
    `Title: ${candidate.title}`,
    `ID: ${candidate.id}`,
    path ? `Path: ${path}` : "Path: unavailable (candidate has no canonical path yet)",
    `Relation: ${candidate.relation}`,
    `Hit: ${candidate.reason}`,
    `Why: ${candidate.whyReadFirst}`,
    `Source: ${sourceLabel(candidate)}`,
    `Review status: ${reviewStatusFor(active, candidate.id)}`,
    obsidianUri ? `Obsidian URI: ${obsidianUri}` : undefined,
  ].filter(Boolean).join("\n");
}

export function formatCandidatePath(active: ActiveSession, resolution: CandidateResolution): string {
  const path = candidatePath(resolution.candidate);
  if (!path) return `No canonical path is available for candidate ${resolution.candidate.id}.`;
  const exists = existsSync(path) ? "exists" : "not verified locally";
  return [`Path: ${path}`, `Local file: ${exists}`, `ID: ${resolution.candidate.id}`].join("\n");
}

export function formatCandidateOpen(active: ActiveSession, resolution: CandidateResolution): string {
  const path = candidatePath(resolution.candidate);
  if (!path) return `Cannot open candidate ${resolution.candidate.id}: no canonical path is available. Use candidate inspect for details.`;
  const uri = `obsidian://open?path=${encodeURIComponent(path)}`;
  return [`Open candidate ${resolution.index + 1}: ${resolution.candidate.title}`, `Obsidian URI: ${uri}`, `Path: ${path}`].join("\n");
}

export function parseBatchReviewArgs(tokens: string[]): Array<{ selector: string; status: MemoryReviewStatus }> {
  const reviews: Array<{ selector: string; status: MemoryReviewStatus }> = [];
  let status: MemoryReviewStatus | undefined;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === "--table") {
      index += 1;
      continue;
    }
    if (token.startsWith("--")) continue;
    if (token === "accepted" || token === "rejected" || token === "uncertain") {
      status = token;
      continue;
    }
    if (!status) continue;
    for (const selector of token.split(",").map((item) => item.trim()).filter(Boolean)) {
      reviews.push({ selector, status });
    }
  }
  return reviews;
}

export function formatReviewedEvidence(active: ActiveSession): string {
  const rows = active.session.memoryReviews.map((review) => {
    const candidate = active.session.memoryCandidatePool.find((item) => item.id === review.candidateId) ??
      active.session.memoryCandidates.find((item) => item.id === review.candidateId);
    return `- ${review.status}: ${candidate?.title ?? review.candidateId} (${review.candidateId})`;
  });
  return rows.length > 0 ? ["Reviewed evidence:", ...rows].join("\n") : "No reviewed evidence yet.";
}
