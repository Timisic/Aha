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

export type ReviewBenchmarkSeedAction = "accept" | "reject_as_noise" | "should_have_found";

export type ReviewBenchmarkSeedLabel = "nice_to_have" | "negative" | "must_recall";

export interface ReviewBenchmarkSeedInput {
  action: ReviewBenchmarkSeedAction;
  createdAt: Date;
  sourcePath: string;
  sourceTitle: string;
  candidate?: Pick<AhaCandidate, "notePath" | "noteTitle" | "relation" | "hit" | "why" | "quotes">;
  missingMemory?: string;
  note?: string;
}

export interface ReviewBenchmarkSeed {
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
    "## Review Benchmark Seeds",
    "",
    "<!-- aha:review-benchmark-seeds:start -->",
    "_审阅动作会在这里保存为草稿 benchmark seed；不会自动写入私有 benchmark。_",
    "<!-- aha:review-benchmark-seeds:end -->",
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
  nextContent = replaceGeneratedBlock(nextContent, "search-results", "搜索结果", renderSearchRound(input));
  nextContent = replaceGeneratedBlock(nextContent, "selected-memories", "纳入 Handoff 的记忆", renderSelectedMemoriesRound(input));
  nextContent = replaceGeneratedBlock(nextContent, "grill-handoff", "Grill Handoff", renderGrillHandoffRound(input));
  return `${nextContent.trimEnd()}\n`;
}

export function appendRunningSearchRound(content: string, generatedAt: Date): string {
  const block = [
    `### 正在检索 - ${generatedAt.toISOString()}`,
    "",
    "- 状态：running",
    "- 信息：Aha wrapper 正在后台运行，结束后会把成功结果或失败记录写回这里。",
  ].join("\n");
  return `${replaceGeneratedBlock(content, "search-results", "搜索结果", block).trimEnd()}\n`;
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

  return `${replaceGeneratedBlock(content, "search-results", "搜索结果", lines.join("\n")).trimEnd()}\n`;
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

  let nextContent = replaceGeneratedBlock(content, "selected-memories", "纳入 Handoff 的记忆", selectedRound);
  nextContent = replaceGeneratedBlock(nextContent, "grill-handoff", "Grill Handoff", handoffRound);

  return {
    content: `${nextContent.trimEnd()}\n`,
    generatedAt: latest.generatedAt,
    candidates,
    handoff,
  };
}

export function appendReviewBenchmarkSeed(content: string, input: ReviewBenchmarkSeedInput): string {
  const blockName = "review-benchmark-seeds";
  const heading = "Review Benchmark Seeds";
  const withBlock = contentHasGeneratedBlock(content, blockName) ? content : ensureGeneratedBlock(content, blockName, heading);
  const body = generatedBlockBody(withBlock, blockName)?.value.trim();
  const existing = body && !body.includes("审阅动作会在这里保存为草稿 benchmark seed") ? body : "";
  const nextBlock = [existing, renderReviewBenchmarkSeed(input)].filter((part) => part.trim()).join("\n\n");
  return `${replaceGeneratedBlock(withBlock, blockName, heading, nextBlock).trimEnd()}\n`;
}

export function renderReviewBenchmarkSeed(input: ReviewBenchmarkSeedInput): string {
  const seedLabel = seedLabelForAction(input.action);
  const memory = input.action === "should_have_found"
    ? input.missingMemory?.trim()
    : input.candidate?.notePath;
  const lines = [
    `### Review Benchmark Seed - ${input.createdAt.toISOString()}`,
    "",
    `- action: \`${input.action}\``,
    "- status: draft",
    `- seed_label: \`${seedLabel}\``,
    `- source: ${obsidianLink(input.sourcePath, input.sourceTitle)}`,
    memory ? `- memory: ${formatSeedMemory(memory, input.candidate?.noteTitle)}` : undefined,
    input.candidate?.relation ? `- relation: \`${oneLine(input.candidate.relation)}\`` : undefined,
    input.candidate?.hit ? `- hit: ${oneLine(input.candidate.hit)}` : undefined,
    input.candidate?.why ? `- why: ${oneLine(input.candidate.why)}` : undefined,
    input.note?.trim() ? `- note: ${oneLine(input.note)}` : undefined,
  ].filter(Boolean);
  return lines.join("\n");
}

export function parseReviewBenchmarkSeeds(content: string): ReviewBenchmarkSeed[] {
  const body = generatedBlockBody(content, "review-benchmark-seeds");
  if (!body) return [];
  const sections = body.value
    .split(/\n(?=### Review Benchmark Seed - )/)
    .map((section) => section.trim())
    .filter((section) => section.startsWith("### Review Benchmark Seed - "));

  return sections.map((section) => {
    const createdAt = section.match(/^### Review Benchmark Seed - (.+)$/m)?.[1]?.trim() || "";
    const fields = new Map<string, string>();
    for (const line of section.split("\n")) {
      const field = line.match(/^-\s*([^:]+):\s*(.*)$/);
      if (field) fields.set(field[1].trim(), stripWrappingBackticks(field[2].trim()));
    }
    const source = fields.get("source") || "";
    const parsedSource = parseObsidianMarkdownLink(source);
    return {
      action: (fields.get("action") || "accept") as ReviewBenchmarkSeedAction,
      status: "draft",
      seedLabel: (fields.get("seed_label") || "nice_to_have") as ReviewBenchmarkSeedLabel,
      createdAt,
      sourcePath: parsedSource?.path || source,
      sourceTitle: parsedSource?.title || "",
      memory: fields.get("memory"),
      relation: fields.get("relation"),
      hit: fields.get("hit"),
      why: fields.get("why"),
      note: fields.get("note"),
    };
  });
}

export function seedLabelForAction(action: ReviewBenchmarkSeedAction): ReviewBenchmarkSeedLabel {
  if (action === "reject_as_noise") return "negative";
  if (action === "should_have_found") return "must_recall";
  return "nice_to_have";
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

function replaceGeneratedBlock(content: string, blockName: string, heading: string, block: string): string {
  const withMarkers = contentHasGeneratedBlock(content, blockName) ? content : ensureGeneratedBlock(content, blockName, heading);
  const startMarker = `<!-- aha:${blockName}:start -->`;
  const endMarker = `<!-- aha:${blockName}:end -->`;
  const startIndex = withMarkers.indexOf(startMarker);
  const endIndex = withMarkers.indexOf(endMarker);
  if (startIndex === -1 || endIndex === -1 || endIndex < startIndex) return appendToSection(withMarkers, heading, block);
  const bodyStart = startIndex + startMarker.length;
  const before = withMarkers.slice(0, bodyStart).trimEnd();
  const after = withMarkers.slice(endIndex);
  return `${before}\n${block.trim()}\n${after}`;
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

function formatSeedMemory(memory: string, title?: string): string {
  const trimmed = memory.trim();
  if (!trimmed) return "";
  if (/^\[\[.+\]\]$/.test(trimmed)) return trimmed;
  return obsidianLink(trimmed, title);
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
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
