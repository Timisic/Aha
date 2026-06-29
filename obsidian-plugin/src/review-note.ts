import { normalizePath } from "obsidian";
import type { AhaCandidate, AhaWrapperFailure, AhaWrapperResult } from "./schema";
import { sourceIdentityAllowsPathDrift } from "./source-identity";

export interface ReviewNoteInit {
  createdAt: Date;
  sourceId: string;
  sourcePath: string;
  sourceTitle: string;
}

export interface RenderSearchRoundInput {
  generatedAt: Date;
  result: AhaWrapperResult;
  sourcePath: string;
  sourceTitle: string;
}

export interface ReviewPanelCandidate extends AhaCandidate {
  index: number;
  selected: boolean;
  quotes: string[];
}

export interface LatestSelectedMemoriesRound {
  generatedAt: string;
  candidates: ReviewPanelCandidate[];
}

export interface SyncReviewSelectionResult {
  content: string;
  generatedAt: string;
  candidates: ReviewPanelCandidate[];
  handoff: string;
}

export function reviewFolderPath(folder: string): string {
  return normalizePath(folder.trim().replace(/^\/+|\/+$/g, "") || "Aha/Reviews");
}

export function makeReviewFileName(sourceTitle: string, createdAt: Date): string {
  const stamp = formatDate(createdAt);
  const title = sanitizeFileName(sourceTitle).slice(0, 90) || "Untitled Insight";
  return `${stamp} ${title}.md`;
}

export function makeReviewNoteContent(input: ReviewNoteInit): string {
  const created = input.createdAt.toISOString();
  const sourceLink = obsidianLink(input.sourcePath, input.sourceTitle);

  return [
    "---",
    "aha: review",
    `source_id: "${escapeYaml(input.sourceId)}"`,
    `source_path: "${escapeYaml(input.sourcePath)}"`,
    `source: "${escapeYaml(sourceLink)}"`,
    `created: "${created}"`,
    "status: memory_review",
    "---",
    "",
    `# Aha 记忆审阅：${input.sourceTitle}`,
    "",
    "## 当前 insight",
    "",
    `来源：${sourceLink}`,
    "",
    "## 搜索结果",
    "",
    "<!-- aha:search-results:start -->",
    "_还没有完成的搜索轮次。_",
    "<!-- aha:search-results:end -->",
    "",
    "## 纳入 Handoff 的记忆",
    "",
    "<!-- aha:selected-memories:start -->",
    "_检索完成后，Aha 会在这里列出默认纳入 handoff 的候选记忆。_",
    "<!-- aha:selected-memories:end -->",
    "",
    "## Grill Handoff",
    "",
    "<!-- aha:grill-handoff:start -->",
    "_检索完成后，Aha 会在这里准备可复制的 handoff。_",
    "<!-- aha:grill-handoff:end -->",
    "",
  ].join("\n");
}

export function appendSuccessfulSearchRound(content: string, input: RenderSearchRoundInput): string {
  let nextContent = setFrontmatterStatus(content, "handoff_ready");
  nextContent = appendToGeneratedBlock(nextContent, "search-results", "搜索结果", renderSearchRound(input));
  nextContent = appendToGeneratedBlock(nextContent, "selected-memories", "纳入 Handoff 的记忆", renderSelectedMemoriesRound(input));
  nextContent = appendToGeneratedBlock(nextContent, "grill-handoff", "Grill Handoff", renderGrillHandoffRound(input));
  return `${nextContent.trimEnd()}\n`;
}

export function appendRunningSearchRound(content: string, generatedAt: Date): string {
  const block = [
    `### 正在检索 - ${generatedAt.toISOString()}`,
    "",
    "- 状态：running",
    "- 信息：Aha wrapper 正在后台运行，结束后会把成功结果或失败记录写回这里。",
  ].join("\n");
  return `${appendToGeneratedBlock(content, "search-results", "搜索结果", block).trimEnd()}\n`;
}

export function appendFailureRecord(content: string, failure: AhaWrapperFailure, generatedAt: Date): string {
  const message = failure.message.trim() || "Aha wrapper 执行失败。";
  const details = failure.details?.trim();
  const tool = failure.tool?.trim();
  const lines = [
    "",
    `### 检索失败 - ${generatedAt.toISOString()}`,
    "",
    `- 状态：failed`,
    tool ? `- 工具：${tool}` : undefined,
    `- 信息：${message}`,
    details ? `- 详情：${details}` : undefined,
  ].filter(Boolean);

  return `${appendToGeneratedBlock(content, "search-results", "搜索结果", lines.join("\n")).trimEnd()}\n`;
}

export function renderSearchRound(input: RenderSearchRoundInput): string {
  const candidates = input.result.candidates ?? [];
  const generatedAt = input.result.generatedAt ?? input.generatedAt.toISOString();
  const warnings = input.result.warnings ?? [];
  const summary = input.result.summary?.trim() || "Aha 已完成一轮记忆检索。";

  return [
    `### 搜索轮次 - ${generatedAt}`,
    "",
    `- 状态：success`,
    `- 候选数量：${candidates.length}`,
    `- 摘要：${summary}`,
    ...warnings.map((warning) => `- 警告：${warning}`),
    "",
    "#### 候选",
    "",
    ...renderCandidateList(candidates),
  ].join("\n");
}

export function renderSelectedMemoriesRound(input: RenderSearchRoundInput): string {
  const candidates = input.result.candidates ?? [];
  const generatedAt = input.result.generatedAt ?? input.generatedAt.toISOString();
  return [
    `### 纳入 Handoff 的记忆 - ${generatedAt}`,
    "",
    ...renderCandidateList(candidates),
  ].join("\n");
}

export function renderGrillHandoffRound(input: RenderSearchRoundInput): string {
  const candidates = input.result.candidates ?? [];
  const generatedAt = input.result.generatedAt ?? input.generatedAt.toISOString();
  return [
    `### Grill Handoff - ${generatedAt}`,
    "",
    ...renderGrillHandoff(input.sourcePath, input.sourceTitle, candidates),
  ].join("\n");
}

export function renderCandidateList(candidates: AhaCandidate[]): string[] {
  if (candidates.length === 0) {
    return ["_没有返回候选。_"];
  }

  return candidates.map((candidate, index) => {
    const title = noteDisplayTitleFromPath(candidate.notePath);
    const selected = candidate.selected === false ? "[ ]" : "[x]";
    const link = obsidianLink(candidate.notePath, title);
    const quotes = candidate.quotes?.filter((quote) => quote.trim()).map((quote) => `   - quote: ${quote.trim()}`) ?? [];

    return [
      `${index + 1}. ${selected} ${link}`,
      `   - relation: \`${candidate.relation}\``,
      `   - hit: ${candidate.hit.trim()}`,
      `   - why: ${candidate.why.trim()}`,
      ...quotes,
    ].join("\n");
  });
}

export function renderGrillHandoff(sourcePath: string, sourceTitle: string, candidates: AhaCandidate[]): string[] {
  const selected = candidates.filter((candidate) => candidate.selected !== false);

  return [
    `当前 insight：${obsidianLink(sourcePath, sourceTitle)}`,
    "",
    "纳入 handoff 的旧笔记：",
    ...(selected.length === 0
      ? ["- _还没有纳入 handoff 的记忆。_"]
      : selected.map((candidate) => {
          const title = noteDisplayTitleFromPath(candidate.notePath);
          return `- ${obsidianLink(candidate.notePath, title)} (${candidate.relation}): ${candidate.why.trim()}${candidate.hit ? ` hit: ${candidate.hit.trim()}` : ""}`;
        })),
  ];
}

export function latestSelectedMemoriesRound(content: string): LatestSelectedMemoriesRound | null {
  const section = latestRoundSectionInGeneratedBlock(content, "selected-memories", ["纳入 Handoff 的记忆", "Selected Memories"]);
  if (!section) return null;
  return {
    generatedAt: section.generatedAt,
    candidates: parseCandidateList(section.text),
  };
}

export function syncLatestSelectedMemoriesAndHandoff(
  content: string,
  sourcePath: string,
  sourceTitle: string,
  selectedByIndex: Map<number, boolean>,
): SyncReviewSelectionResult {
  const latest = latestSelectedMemoriesRound(content);
  if (!latest) {
    throw new Error("No selected memory round found in this review note.");
  }

  const candidates = latest.candidates.map((candidate) => ({
    ...candidate,
    selected: selectedByIndex.get(candidate.index) ?? candidate.selected,
  }));
  const selectedRound = [
    `### 纳入 Handoff 的记忆 - ${latest.generatedAt}`,
    "",
    ...renderCandidateList(candidates),
  ].join("\n");
  const handoff = renderGrillHandoff(sourcePath, sourceTitle, candidates).join("\n");
  const handoffRound = [
    `### Grill Handoff - ${latest.generatedAt}`,
    "",
    handoff,
  ].join("\n");

  let nextContent = replaceLatestRoundInGeneratedBlock(
    content,
    "selected-memories",
    ["纳入 Handoff 的记忆", "Selected Memories"],
    selectedRound,
  ) ?? content;
  nextContent = replaceLatestRoundInGeneratedBlock(
    nextContent,
    "grill-handoff",
    ["Grill Handoff"],
    handoffRound,
  ) ?? appendToGeneratedBlock(nextContent, "grill-handoff", "Grill Handoff", handoffRound);

  return {
    content: `${nextContent.trimEnd()}\n`,
    generatedAt: latest.generatedAt,
    candidates,
    handoff,
  };
}

export function sanitizeFileName(value: string): string {
  return value
    .replace(/[\\/:*?"<>|#^[\]]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function obsidianLink(path: string, title?: string): string {
  const target = stripMarkdownExtension(path).replace(/\|/g, "\\|");
  const alias = title?.trim();
  if (!alias || alias === target || alias === lastPathSegment(target)) {
    return `[[${target}]]`;
  }
  return `[[${target}|${alias.replace(/\|/g, "\\|")}]]`;
}

export function noteDisplayTitleFromPath(path: string): string {
  const target = path.replace(/^\[\[|\]\]$/g, "").split("|")[0].trim();
  const base = target.match(/^([^#^]+)/)?.[1]?.trim() || target;
  return stripMarkdownExtension(lastPathSegment(base)) || target;
}

export function reviewSourceIdFromContent(content: string): string | null {
  const frontmatter = content.match(/^---\n([\s\S]*?)\n---\n?/)?.[1];
  if (!frontmatter) return null;
  return frontmatterValue(frontmatter, "source_id");
}

export function reviewSourcePathFromContent(content: string): string | null {
  const frontmatter = content.match(/^---\n([\s\S]*?)\n---\n?/)?.[1];
  if (!frontmatter) return null;
  return frontmatterValue(frontmatter, "source_path");
}

export function reviewNoteMatchesSource(content: string, sourceId: string, sourcePath: string): boolean {
  const reviewSourceId = reviewSourceIdFromContent(content);
  if (reviewSourceId) {
    if (reviewSourceId !== sourceId) return false;
    const reviewSourcePath = reviewSourcePathFromContent(content);
    return sourceIdentityAllowsPathDrift(sourceId) || !reviewSourcePath || reviewSourcePath === sourcePath;
  }
  return reviewSourcePathFromContent(content) === sourcePath;
}

function setFrontmatterStatus(content: string, status: string): string {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!match) return content;
  const frontmatter = match[1].includes("status:")
    ? match[1].replace(/^status:.*$/m, `status: ${status}`)
    : `${match[1]}\nstatus: ${status}`;
  return `---\n${frontmatter}\n---\n${content.slice(match[0].length)}`;
}

function appendToGeneratedBlock(content: string, blockName: string, heading: string, block: string): string {
  const withMarkers = contentHasGeneratedBlock(content, blockName) ? content : ensureGeneratedBlock(content, blockName, heading);
  const startMarker = `<!-- aha:${blockName}:start -->`;
  const endMarker = `<!-- aha:${blockName}:end -->`;
  const startIndex = withMarkers.indexOf(startMarker);
  const endIndex = withMarkers.indexOf(endMarker);
  if (startIndex === -1 || endIndex === -1 || endIndex < startIndex) return appendToSection(withMarkers, heading, block);
  const bodyStart = startIndex + startMarker.length;
  const before = withMarkers.slice(0, bodyStart).trimEnd();
  const existingBody = stripDefaultGeneratedPlaceholder(blockName, withMarkers.slice(bodyStart, endIndex)).trim();
  const after = withMarkers.slice(endIndex);
  const body = existingBody ? `${existingBody}\n\n${block.trim()}` : block.trim();
  return `${before}\n${body}\n${after}`;
}

function ensureGeneratedBlock(content: string, blockName: string, heading: string): string {
  const startMarker = `<!-- aha:${blockName}:start -->`;
  const endMarker = `<!-- aha:${blockName}:end -->`;
  if (content.includes(startMarker) && content.includes(endMarker)) return content;
  return appendToSection(content, heading, `${startMarker}\n${endMarker}`);
}

function contentHasGeneratedBlock(content: string, blockName: string): boolean {
  return content.includes(`<!-- aha:${blockName}:start -->`) && content.includes(`<!-- aha:${blockName}:end -->`);
}

function appendToSection(content: string, heading: string, block: string): string {
  const marker = `## ${heading}`;
  const sectionPattern = new RegExp(`(^|\\n)## ${escapeRegExp(heading)}\\n`, "m");
  const match = sectionPattern.exec(content);
  if (!match || match.index === undefined) {
    return `${content.trimEnd()}\n\n${marker}\n\n${block.trim()}\n`;
  }

  const headingStart = match.index + match[1].length;
  const sectionStart = headingStart + marker.length + 1;
  const nextHeading = content.slice(sectionStart).search(/\n## /);
  const insertAt = nextHeading === -1 ? content.length : sectionStart + nextHeading;
  const before = content.slice(0, insertAt).trimEnd();
  const after = content.slice(insertAt);
  return `${before}\n\n${block.trim()}\n${after}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function formatDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function lastPathSegment(path: string): string {
  return path.split("/").filter(Boolean).pop() ?? path;
}

function stripMarkdownExtension(path: string): string {
  return path.replace(/\.md$/i, "");
}

function escapeYaml(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function stripDefaultGeneratedPlaceholder(blockName: string, value: string): string {
  const placeholders: Record<string, string[]> = {
    "search-results": ["_还没有完成的搜索轮次。_", "_No search round has completed yet._"],
    "selected-memories": [
      "_检索完成后，Aha 会在这里列出默认纳入 handoff 的候选记忆。_",
      "_Aha will add selected memory candidates here after retrieval._",
    ],
    "grill-handoff": [
      "_检索完成后，Aha 会在这里准备可复制的 handoff。_",
      "_Aha will prepare a compact handoff after retrieval._",
    ],
  };
  return placeholders[blockName]?.includes(value.trim()) ? "" : value;
}

function frontmatterValue(frontmatter: string, key: string): string | null {
  const match = frontmatter.match(new RegExp(`^${escapeRegExp(key)}:\\s*(.+)$`, "m"));
  if (!match) return null;
  return unquoteYamlScalar(match[1]).trim() || null;
}

function unquoteYamlScalar(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  return trimmed;
}

interface GeneratedRoundSection {
  generatedAt: string;
  text: string;
  start: number;
  end: number;
}

function latestRoundSectionInGeneratedBlock(content: string, blockName: string, headings: string[]): GeneratedRoundSection | null {
  const body = generatedBlockBody(content, blockName);
  if (!body) return null;
  const headingPattern = headings.map(escapeRegExp).join("|");
  const pattern = new RegExp(`(^|\\n)### (${headingPattern}) - ([^\\n]+)`, "g");
  let latest: { start: number; generatedAt: string } | null = null;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(body.value)) !== null) {
    latest = {
      start: match.index + (match[1] === "\n" ? 1 : 0),
      generatedAt: match[3].trim(),
    };
  }
  if (!latest) return null;
  const nextHeading = body.value.slice(latest.start + 1).search(/\n### /);
  const end = nextHeading === -1 ? body.value.length : latest.start + 1 + nextHeading;
  return {
    generatedAt: latest.generatedAt,
    text: body.value.slice(latest.start, end).trim(),
    start: body.start + latest.start,
    end: body.start + end,
  };
}

function replaceLatestRoundInGeneratedBlock(content: string, blockName: string, headings: string[], replacement: string): string | null {
  const body = generatedBlockBody(content, blockName);
  const section = latestRoundSectionInGeneratedBlock(content, blockName, headings);
  if (!body || !section) return null;
  const beforeBody = content.slice(body.start, section.start).trim();
  const afterBody = content.slice(section.end, body.end).trim();
  const bodyParts = [beforeBody, replacement.trim(), afterBody].filter(Boolean);
  return `${content.slice(0, body.start).trimEnd()}\n${bodyParts.join("\n\n")}\n${content.slice(body.end)}`;
}

function generatedBlockBody(content: string, blockName: string): { start: number; end: number; value: string } | null {
  const startMarker = `<!-- aha:${blockName}:start -->`;
  const endMarker = `<!-- aha:${blockName}:end -->`;
  const startIndex = content.indexOf(startMarker);
  const endIndex = content.indexOf(endMarker);
  if (startIndex === -1 || endIndex === -1 || endIndex < startIndex) return null;
  const start = startIndex + startMarker.length;
  return {
    start,
    end: endIndex,
    value: content.slice(start, endIndex),
  };
}

function parseCandidateList(section: string): ReviewPanelCandidate[] {
  const candidates: ReviewPanelCandidate[] = [];
  let current: ReviewPanelCandidate | null = null;

  for (const line of section.split("\n")) {
    const candidateMatch = line.match(/^(\d+)\.\s+\[([ xX])\]\s+(.+)$/);
    if (candidateMatch) {
      const parsedLink = parseObsidianMarkdownLink(candidateMatch[3]);
      if (!parsedLink) {
        current = null;
        continue;
      }
      current = {
        index: Number(candidateMatch[1]),
        selected: candidateMatch[2].toLowerCase() === "x",
        notePath: parsedLink.path,
        noteTitle: parsedLink.title,
        relation: "weak",
        hit: "",
        why: "",
        quotes: [],
      };
      candidates.push(current);
      continue;
    }

    if (!current) continue;
    const field = line.match(/^\s*-\s*([^:：]+)\s*[:：]\s*(.*)$/);
    if (!field) continue;
    const key = field[1].trim().toLowerCase();
    const value = stripWrappingBackticks(field[2].trim());
    if (key === "relation" || key === "关系") {
      current.relation = (value || "weak") as AhaCandidate["relation"];
    } else if (key === "hit" || key === "命中") {
      current.hit = value;
    } else if (key === "why" || key === "理由") {
      current.why = value;
    } else if (key === "quote" || key === "引用") {
      current.quotes.push(value);
    }
  }

  return candidates;
}

function parseObsidianMarkdownLink(value: string): { path: string; title?: string } | null {
  const match = value.match(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/);
  if (!match) return null;
  const target = match[1].replace(/\\\|/g, "|").trim();
  const alias = match[2]?.replace(/\\\|/g, "|").trim();
  return {
    path: ensureMarkdownExtension(target),
    title: alias || stripMarkdownExtension(lastPathSegment(target)),
  };
}

function ensureMarkdownExtension(target: string): string {
  const match = target.match(/^([^#^]+)(.*)$/);
  if (!match) return target;
  const base = match[1];
  const suffix = match[2] ?? "";
  return /\.md$/i.test(base) ? `${base}${suffix}` : `${base}.md${suffix}`;
}

function stripWrappingBackticks(value: string): string {
  return value.replace(/^`([^`]+)`$/, "$1").trim();
}
