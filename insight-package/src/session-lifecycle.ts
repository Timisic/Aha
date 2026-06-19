import { existsSync, rmSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { ActiveSession, InsightSession, Stage } from "./domain.ts";
import { isPathInside, nowIso } from "./domain.ts";
import { formatSummaryInspection } from "./summary-artifacts.ts";
import { insightRoot, readJsonFile, readSessionState, sessionTitleFor, sessionsRoot, statePathFor, writeIndex, writeState, findSessionDirs, loadSessionDir } from "./session.ts";
import { stageLabel, stageListHint } from "./user-facing.ts";

export interface SessionListFilters {
  limit?: number;
  stage?: Stage;
  date?: string;
  title?: string;
  archived?: boolean;
  includeArchived?: boolean;
}

export type SessionResolution =
  | { ok: true; active: ActiveSession }
  | { ok: false; reason: "none"; message: string }
  | { ok: false; reason: "ambiguous"; message: string; matches: Array<{ id: string; dir: string; title: string; stage: Stage; archivedAt?: string }> };


function writeJsonAtomic(path: string, value: unknown): void {
  const tmpPath = join(dirname(path), `.${basename(path)}.${process.pid}.${Date.now()}.tmp`);
  writeFileSync(tmpPath, JSON.stringify(value, null, 2) + "\n", "utf-8");
  renameSync(tmpPath, path);
}

function sessionInfo(dir: string): { session: InsightSession; dir: string; name: string; title: string } | undefined {
  const session = readSessionState(statePathFor(dir));
  if (!session) return undefined;
  return { session, dir, name: basename(dir), title: sessionTitleFor(session) };
}

function allSessionInfos(cwd: string) {
  return findSessionDirs(cwd).map(sessionInfo).filter((item): item is NonNullable<ReturnType<typeof sessionInfo>> => Boolean(item));
}

function compactMatches(matches: ReturnType<typeof allSessionInfos>) {
  return matches.map(({ session, dir, name, title }) => ({
    id: session.id,
    dir: name,
    title,
    stage: session.stage,
    archivedAt: session.archivedAt,
  }));
}

export function resolveSession(cwd: string, selector: string): SessionResolution {
  const needle = selector.trim();
  if (!needle) return { ok: false, reason: "none", message: "Missing session selector." };
  const infos = allSessionInfos(cwd);
  const exact = infos.filter(({ session, name, dir }) => session.id === needle || name === needle || dir === needle);
  if (exact.length === 1) {
    const active = loadSessionDir(cwd, exact[0].dir);
    return active ? { ok: true, active } : { ok: false, reason: "none", message: `Session could not be loaded: ${needle}` };
  }
  if (exact.length > 1) {
    return { ok: false, reason: "ambiguous", message: `Ambiguous exact session selector: ${needle}`, matches: compactMatches(exact) };
  }

  const partial = infos.filter(({ session, name, title }) =>
    session.id.includes(needle) || name.includes(needle) || title.toLowerCase().includes(needle.toLowerCase()),
  );
  if (partial.length === 1) {
    const active = loadSessionDir(cwd, partial[0].dir);
    return active ? { ok: true, active } : { ok: false, reason: "none", message: `Session could not be loaded: ${needle}` };
  }
  if (partial.length > 1) {
    return { ok: false, reason: "ambiguous", message: `Multiple insight sessions match '${needle}'. Use an exact session id or directory.`, matches: compactMatches(partial) };
  }
  return { ok: false, reason: "none", message: `No insight session matched: ${needle}` };
}

export function formatSessionResolutionError(result: Exclude<SessionResolution, { ok: true }>): string {
  if (result.reason !== "ambiguous") return result.message;
  return [
    result.message,
    "",
    "| Session | Stage | Archived | Title |",
    "| --- | --- | --- | --- |",
    ...result.matches.map((match) => `| ${match.id} / ${match.dir} | ${stageLabel(match.stage)} | ${match.archivedAt ? "yes" : "no"} | ${match.title.replace(/\|/g, "/")} |`),
  ].join("\n");
}

export function listSessions(cwd: string, filters: SessionListFilters = {}): string {
  let infos = allSessionInfos(cwd);
  if (filters.archived === true) infos = infos.filter(({ session }) => Boolean(session.archivedAt));
  else if (!filters.includeArchived) infos = infos.filter(({ session }) => !session.archivedAt);
  if (filters.stage) infos = infos.filter(({ session }) => session.stage === filters.stage);
  if (filters.date) {
    const date = filters.date;
    infos = infos.filter(({ session }) => session.updatedAt.startsWith(date) || session.createdAt.startsWith(date));
  }
  if (filters.title) {
    const needle = filters.title.toLowerCase();
    infos = infos.filter(({ title, name, session }) => `${title}\n${name}\n${session.id}`.toLowerCase().includes(needle));
  }
  const limit = filters.limit ?? 20;
  const shown = infos.slice(0, limit);
  const includeCorrupt = !filters.stage && !filters.date && !filters.title && filters.archived !== true;
  const corruptRows = includeCorrupt
    ? findSessionDirs(cwd)
        .filter((dir) => !readSessionState(statePathFor(dir)))
        .map((dir) => `| ${basename(dir)} | unknown |  | corrupt or unreadable state | no |`)
    : [];
  if (shown.length === 0 && corruptRows.length === 0) return ["No insight sessions found.", stageListHint()].join("\n");
  return [
    "| Session | Stage | Updated | Title | Archived |",
    "| --- | --- | --- | --- | --- |",
    ...shown.map(({ session, name, title }) => `| ${name} | ${stageLabel(session.stage)} | ${session.updatedAt} | ${title.replace(/\|/g, "/").slice(0, 80)} | ${session.archivedAt ? "yes" : "no"} |`),
    ...corruptRows,
    "",
    stageListHint(),
  ].join("\n");
}

export function renameSession(cwd: string, active: ActiveSession, title: string): ActiveSession {
  active.session.displayTitle = title.trim();
  writeState(active.statePath, active.session);
  writeIndex(cwd, active.sessionDir, active.session);
  return active;
}

export function setSessionArchived(cwd: string, active: ActiveSession, archived: boolean): ActiveSession {
  active.session.archivedAt = archived ? nowIso() : undefined;
  writeState(active.statePath, active.session);
  writeIndex(cwd, active.sessionDir, active.session);
  return active;
}

export function inspectSession(active: ActiveSession): string {
  return [
    `Session: ${active.session.id}`,
    `Title: ${sessionTitleFor(active.session)}`,
    `Stage: ${stageLabel(active.session.stage)} (${active.session.stage})`,
    active.session.archivedAt ? `Archived: ${active.session.archivedAt}` : "Archived: no",
    `Session dir: ${active.sessionDir}`,
    `State: ${active.statePath}`,
    `Grill context: ${active.grillContextPath}`,
    `Stage briefing: ${active.stageBriefingPath}`,
    formatSummaryInspection(active),
  ].join("\n");
}

export function deleteSession(cwd: string, active: ActiveSession, confirmation: string): string {
  if (confirmation !== active.session.id) {
    throw new Error(`Delete requires exact confirmation: --confirm ${active.session.id}`);
  }
  const root = sessionsRoot(cwd);
  if (!isPathInside(root, active.sessionDir)) {
    throw new Error(`Refusing to delete outside configured insight sessions root: ${active.sessionDir}`);
  }
  rmSync(active.sessionDir, { recursive: true, force: true });
  const path = `${insightRoot(cwd)}/index.json`;
  const current = readJsonFile<Array<{ id: string; dir: string }>>(path) ?? [];
  const next = current.filter((item) => item.id !== active.session.id && item.dir !== active.sessionDir);
  if (next.length === 0) {
    if (existsSync(path)) rmSync(path, { force: true });
  } else {
    writeJsonAtomic(path, next);
  }
  return `Deleted insight session ${active.session.id}: ${active.sessionDir}`;
}
