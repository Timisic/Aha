import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { INSIGHT_STATE_SCHEMA_VERSION, SESSION_BINDING_CUSTOM_TYPE, STAGES, type ActiveSession, type InsightSession, type InsightSessionBinding, type Stage, nowIso, dateStamp, shortId, slugify, isPathInside, textFromUnknown } from "./domain.ts";
import { extractMarkdownPath, parseInsightInput, readSourceNoteWithObsidian, titleFromMarkdownPath } from "./source-note.ts";

export function cleanSessionTitle(value: string): string {
  const firstLine = value
    .replace(/\\n/g, "\n")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) ?? value;
  const path = extractMarkdownPath(firstLine);
  const raw = path ? titleFromMarkdownPath(path) : firstLine;
  return raw
    .replace(/^#+\s*/, "")
    .replace(/^[-*]\s*/, "")
    .replace(/^\d{4}-\d{2}-\d{2}\s+/, "")
    .replace(/\binside\b/gi, "")
    .replace(/\binsight\b/gi, "")
    .replace(/里面包含了?我的?/g, "")
    .replace(/原始笔记|上下文|背景/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 40) || "insight";
}

export function sessionTitleFor(session: InsightSession): string {
  if (session.sourceNote?.path) return cleanSessionTitle(session.sourceNote.path);
  return cleanSessionTitle(session.context || session.rawInsight);
}

export function sessionSlugFor(session: InsightSession): string {
  return slugify(sessionTitleFor(session)).slice(0, 40) || "insight";
}

export function sessionsRoot(cwd: string): string {
  return join(insightRoot(cwd), "sessions");
}

export function insightRoot(cwd: string): string {
  const configured = process.env.INSIGHT_HOME?.trim();
  if (configured) return configured;

  const agentDir =
    process.env.PI_CODING_AGENT_DIR?.trim() ||
    join(process.env.HOME ?? "", ".pi", "agent");
  return join(agentDir, "insights");
}

export function indexPath(cwd: string): string {
  return join(insightRoot(cwd), "index.json");
}

export function statePathFor(sessionDir: string): string {
  return join(sessionDir, "state.json");
}

export function grillContextPathFor(sessionDir: string): string {
  return join(sessionDir, "grill-context.md");
}

export function grillBriefingPathFor(sessionDir: string): string {
  return join(sessionDir, "grill-briefing.md");
}

export function summaryDraftPathFor(sessionDir: string): string {
  return join(sessionDir, "summary-draft.md");
}

export function createInitialState(input: string, cwd: string): InsightSession {
  const parsed = parseInsightInput(input, cwd);
  const timestamp = nowIso();
  return {
    schemaVersion: INSIGHT_STATE_SCHEMA_VERSION,
    id: shortId(),
    stage: "memory",
    originCwd: cwd,
    rawInsight: parsed.rawInsight,
    context: parsed.context,
    sourceNote: parsed.sourceNote,
    memoryQueries: [],
    explicitMemoryCues: parsed.explicitMemoryCues,
    missingExplicitCues: [],
    explicitCueResults: [],
    memoryCandidatePool: [],
    memoryCandidates: [],
    memoryReviews: [],
    usedMemoryIds: [],
    newInsights: [],
    grillTurns: [],
    candidateJudgments: [],
    unresolvedQuestions: [],
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export function readJsonFile<T>(path: string): T | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as T;
  } catch {
    return undefined;
  }
}

export function isInsightSession(value: unknown): value is InsightSession {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === "string" &&
    /^[a-f0-9]{6,32}$/i.test(record.id) &&
    typeof record.originCwd === "string" &&
    typeof record.rawInsight === "string" &&
    typeof record.context === "string" &&
    typeof record.createdAt === "string" &&
    typeof record.updatedAt === "string" &&
    typeof record.stage === "string" &&
    STAGES.has(record.stage as Stage)
  );
}

export function migrateInsightSession(session: InsightSession): InsightSession {
  return {
    ...session,
    schemaVersion: INSIGHT_STATE_SCHEMA_VERSION,
    memoryQueries: Array.isArray(session.memoryQueries) ? session.memoryQueries : [],
    explicitMemoryCues: Array.isArray(session.explicitMemoryCues) ? session.explicitMemoryCues : [],
    missingExplicitCues: Array.isArray(session.missingExplicitCues) ? session.missingExplicitCues : [],
    explicitCueResults: Array.isArray(session.explicitCueResults) ? session.explicitCueResults : [],
    memoryCandidatePool: Array.isArray(session.memoryCandidatePool)
      ? session.memoryCandidatePool
      : Array.isArray(session.memoryCandidates) ? session.memoryCandidates : [],
    memoryCandidates: Array.isArray(session.memoryCandidates) ? session.memoryCandidates : [],
    memoryReviews: Array.isArray(session.memoryReviews) ? session.memoryReviews : [],
    usedMemoryIds: Array.isArray(session.usedMemoryIds) ? session.usedMemoryIds : [],
    newInsights: Array.isArray(session.newInsights) ? session.newInsights : [],
    grillTurns: Array.isArray(session.grillTurns) ? session.grillTurns : [],
    candidateJudgments: Array.isArray(session.candidateJudgments) ? session.candidateJudgments : [],
    unresolvedQuestions: Array.isArray(session.unresolvedQuestions) ? session.unresolvedQuestions : [],
  };
}

export function readSessionState(path: string): InsightSession | undefined {
  const session = readJsonFile<unknown>(path);
  return isInsightSession(session) ? migrateInsightSession(session) : undefined;
}

function writeJsonAtomic(path: string, value: unknown): void {
  const tmpPath = join(dirname(path), `.${basename(path)}.${process.pid}.${Date.now()}.tmp`);
  writeFileSync(tmpPath, JSON.stringify(value, null, 2) + "\n", "utf-8");
  renameSync(tmpPath, path);
}

export function writeState(path: string, session: InsightSession): void {
  session.updatedAt = nowIso();
  writeJsonAtomic(path, session);
}

export function writeIndex(cwd: string, sessionDir: string, session: InsightSession): void {
  const root = insightRoot(cwd);
  mkdirSync(root, { recursive: true });
  const path = indexPath(cwd);
  const current =
    readJsonFile<Array<{ id: string; dir: string; title: string; stage: Stage; updatedAt: string }>>(path) ?? [];
  const entry = {
    id: session.id,
    dir: sessionDir,
    title: sessionTitleFor(session),
    stage: session.stage,
    updatedAt: session.updatedAt,
  };
  const next = [entry, ...current.filter((item) => item.id !== session.id && item.dir !== sessionDir)]
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, 50);
  writeJsonAtomic(path, next);
}

export function writeInitialGrillContext(path: string, session: InsightSession): void {
  if (existsSync(path)) return;
  const body = [
    "# Insight Grill 上下文",
    "",
    "这个文档用于记录本次 Review-Grill 循环中逐渐稳定下来的语言、判断和小型决策。它不是完整对话记录，也不是最终 summary。",
    "",
    "## Language",
    "",
    "**Insight**:",
    session.rawInsight || "待补充。",
    "_Avoid_: Observation, thought",
    "",
    "**Judgment**:",
    "尚未稳定。只在用户明确认可、修正或边界变清楚后再写入。",
    "_Avoid_: Feeling, temporary reaction",
    "",
    "**Evidence**:",
    "待通过 memory review、源材料和用户修正补充。",
    "_Avoid_: Vibes, association",
    "",
    "## Decision Records",
    "",
    "暂无。只有当某个判断明显更新、替代或细化旧理解时再记录。",
    "",
  ].join("\n");
  writeFileSync(path, body, "utf-8");
}

export function localizedGrillHeading(heading: string | undefined): string {
  const trimmed = heading?.trim();
  if (!trimmed) return "记录";
  const known: Record<string, string> = {
    "Resolved Term": "已稳定术语",
    "Stable Term": "已稳定术语",
    "Emerging Language": "正在形成的语言",
    "Emerging Rule": "正在形成的规则",
    "Emerging Definition": "正在形成的定义",
    "Memory Review Notes": "旧笔记 Review 记录",
    "Memory Review Synthesis": "旧笔记综合",
    "Expanded Memory Search": "扩展 Memory Search",
    "Process Preference": "流程偏好",
    "Scope Adjustment": "范围调整",
  };
  return known[trimmed] ?? trimmed;
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function appendMarkdownSection(existing: string, heading: string, body: string): string {
  const normalizedBody = body.trim();
  if (!normalizedBody) return existing;

  const headingPattern = new RegExp(`^##\\s+${escapeRegExp(heading)}\\s*$`, "m");
  const match = headingPattern.exec(existing);
  if (!match) {
    return [existing.trimEnd(), "", `## ${heading}`, "", normalizedBody, ""].join("\n");
  }

  const sectionContentStart = match.index + match[0].length;
  const afterHeading = existing.slice(sectionContentStart);
  const nextHeadingOffset = afterHeading.search(/\n##\s+/);
  const insertAt = nextHeadingOffset === -1 ? existing.length : sectionContentStart + nextHeadingOffset;

  const before = existing.slice(0, insertAt).trimEnd();
  const after = existing.slice(insertAt).trimStart();
  return after
    ? [before, "", normalizedBody, "", after].join("\n")
    : [before, "", normalizedBody, ""].join("\n");
}

export function createUniqueSessionDir(cwd: string, session: InsightSession): string {
  const root = sessionsRoot(cwd);
  mkdirSync(root, { recursive: true });

  for (let attempt = 0; attempt < 8; attempt += 1) {
    if (attempt > 0) session.id = shortId();
    const dirName = `${dateStamp()}-${sessionSlugFor(session)}-${session.id}`;
    const sessionDir = join(root, dirName);
    try {
      mkdirSync(sessionDir);
      return sessionDir;
    } catch (error) {
      if ((error as { code?: string }).code === "EEXIST") continue;
      throw error;
    }
  }

  throw new Error("Unable to create a unique insight session directory.");
}

export function createSession(cwd: string, input: string): ActiveSession {
  const session = createInitialState(input, cwd);
  const sessionDir = createUniqueSessionDir(cwd, session);

  const statePath = statePathFor(sessionDir);
  const grillContextPath = grillContextPathFor(sessionDir);
  const grillBriefingPath = grillBriefingPathFor(sessionDir);
  writeState(statePath, session);
  writeInitialGrillContext(grillContextPath, session);
  writeIndex(cwd, sessionDir, session);

  return { sessionDir, statePath, grillContextPath, grillBriefingPath, session };
}

export function findSessionDirs(cwd: string): string[] {
  const root = sessionsRoot(cwd);
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .map((name) => join(root, name))
    .filter((path) => {
      try {
        return isPathInside(root, path) && statSync(path).isDirectory() && existsSync(statePathFor(path));
      } catch {
        return false;
      }
    })
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
}

export function safeSessionDir(cwd: string, sessionDir: string): string | undefined {
  const root = sessionsRoot(cwd);
  const resolved = resolve(sessionDir);
  if (!isPathInside(root, resolved)) return undefined;
  if (!existsSync(resolved)) return undefined;
  try {
    if (!statSync(resolved).isDirectory()) return undefined;
  } catch {
    return undefined;
  }
  return resolved;
}

export function loadSessionDir(cwd: string, sessionDir: string): ActiveSession | undefined {
  const safeDir = safeSessionDir(cwd, sessionDir);
  if (!safeDir) return undefined;
  const statePath = statePathFor(safeDir);
  const session = readSessionState(statePath);
  if (!session) return undefined;
  return {
    sessionDir: safeDir,
    statePath,
    grillContextPath: grillContextPathFor(safeDir),
    grillBriefingPath: grillBriefingPathFor(safeDir),
    session,
  };
}

export function loadSession(cwd: string, selector: string): ActiveSession | undefined {
  const dirs = findSessionDirs(cwd);
  const needle = selector.trim();
  const sessionDir =
    dirs.find((dir) => basename(dir) === needle) ??
    dirs.find((dir) => basename(dir).includes(needle)) ??
    dirs.find((dir) => readSessionState(statePathFor(dir))?.id === needle);
  if (!sessionDir) return undefined;
  return loadSessionDir(cwd, sessionDir);
}

export function bindingFor(active: ActiveSession): InsightSessionBinding {
  return {
    active: true,
    sessionId: active.session.id,
    sessionDir: active.sessionDir,
    statePath: active.statePath,
    updatedAt: active.session.updatedAt,
  };
}

export function restoreSessionFromBinding(cwd: string, binding: InsightSessionBinding): ActiveSession | undefined {
  if (binding.sessionId) {
    const active = loadSession(cwd, binding.sessionId);
    if (active) return active;
  }
  if (binding.sessionDir) {
    const active = loadSessionDir(cwd, binding.sessionDir);
    if (active) return active;
  }
  if (binding.statePath?.endsWith("/state.json")) {
    const active = loadSessionDir(cwd, binding.statePath.slice(0, -"/state.json".length));
    if (active) return active;
  }
  return undefined;
}

export function findInsightStatePathsInSessionEntries(entries: unknown[]): string[] {
  const found: string[] = [];
  const pattern = /\/[^"'\n\r]*(?:\/insights)?\/sessions\/[^"'\n\r]+\/state\.json/g;
  for (const entry of entries) {
    const text = textFromUnknown(entry);
    for (const match of text.matchAll(pattern)) {
      found.push(match[0]);
    }
  }
  return found;
}

export function restoreActiveSessionFromPiSession(ctx: ExtensionContext): ActiveSession | undefined {
  const entries =
    typeof ctx.sessionManager.getBranch === "function"
      ? ctx.sessionManager.getBranch()
      : ctx.sessionManager.getEntries();

  for (const entry of [...entries].reverse()) {
    const record = entry as { type?: string; customType?: string; data?: InsightSessionBinding };
    if (record.type === "custom" && record.customType === SESSION_BINDING_CUSTOM_TYPE) {
      if (record.data?.active === false) return undefined;
      const active = restoreSessionFromBinding(ctx.cwd, record.data ?? {});
      if (active) return active;
      return undefined;
    }
  }

  for (const statePath of findInsightStatePathsInSessionEntries([...entries].reverse())) {
    const active = restoreSessionFromBinding(ctx.cwd, { statePath });
    if (active) return active;
  }

  return undefined;
}

export function listSessionSummary(cwd: string, limit = 10): string {
  const dirs = findSessionDirs(cwd).slice(0, limit);
  if (dirs.length === 0) return "No insight sessions found.";
  return [
    "| Session | Stage | Updated | Title |",
    "| --- | --- | --- | --- |",
    ...dirs.map((dir) => {
      const session = readJsonFile<InsightSession>(statePathFor(dir));
      const name = basename(dir);
      return `| ${name} | ${session?.stage ?? "unknown"} | ${session?.updatedAt ?? ""} | ${(session ? sessionTitleFor(session) : "").replace(/\|/g, "/").slice(0, 80)} |`;
    }),
  ].join("\n");
}
