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
    `# Aha Review: ${input.sourceTitle}`,
    "",
    "## Insight",
    "",
    `Source: ${sourceLink}`,
    "",
    "## Search Results",
    "",
    "<!-- aha:search-results:start -->",
    "_No search round has completed yet._",
    "<!-- aha:search-results:end -->",
    "",
    "## Selected Memories",
    "",
    "<!-- aha:selected-memories:start -->",
    "_Aha will add selected memory candidates here after retrieval._",
    "<!-- aha:selected-memories:end -->",
    "",
    "## Grill Handoff",
    "",
    "<!-- aha:grill-handoff:start -->",
    "_Aha will prepare a compact handoff after retrieval._",
    "<!-- aha:grill-handoff:end -->",
    "",
  ].join("\n");
}

export function appendSuccessfulSearchRound(content: string, input: RenderSearchRoundInput): string {
  let nextContent = setFrontmatterStatus(content, "handoff_ready");
  nextContent = appendToGeneratedBlock(nextContent, "search-results", "Search Results", renderSearchRound(input));
  nextContent = appendToGeneratedBlock(nextContent, "selected-memories", "Selected Memories", renderSelectedMemoriesRound(input));
  nextContent = appendToGeneratedBlock(nextContent, "grill-handoff", "Grill Handoff", renderGrillHandoffRound(input));
  return `${nextContent.trimEnd()}\n`;
}

export function appendFailureRecord(content: string, failure: AhaWrapperFailure, generatedAt: Date): string {
  const message = failure.message.trim() || "Aha wrapper failed.";
  const details = failure.details?.trim();
  const tool = failure.tool?.trim();
  const lines = [
    "",
    `### Failed Search Round - ${generatedAt.toISOString()}`,
    "",
    `- Status: failed`,
    tool ? `- Tool: ${tool}` : undefined,
    `- Message: ${message}`,
    details ? `- Details: ${details}` : undefined,
  ].filter(Boolean);

  return `${content.trimEnd()}\n${lines.join("\n")}\n`;
}

export function renderSearchRound(input: RenderSearchRoundInput): string {
  const candidates = input.result.candidates ?? [];
  const generatedAt = input.result.generatedAt ?? input.generatedAt.toISOString();
  const warnings = input.result.warnings ?? [];
  const summary = input.result.summary?.trim() || "Aha completed one memory search round.";

  return [
    `### Search Round - ${generatedAt}`,
    "",
    `- Status: success`,
    `- Candidate count: ${candidates.length}`,
    `- Summary: ${summary}`,
    ...warnings.map((warning) => `- Warning: ${warning}`),
    "",
    "#### Candidates",
    "",
    ...renderCandidateList(candidates),
  ].join("\n");
}

export function renderSelectedMemoriesRound(input: RenderSearchRoundInput): string {
  const candidates = input.result.candidates ?? [];
  const generatedAt = input.result.generatedAt ?? input.generatedAt.toISOString();
  return [
    `### Selected Memories - ${generatedAt}`,
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
    return ["_No candidates returned._"];
  }

  return candidates.map((candidate, index) => {
    const title = candidate.noteTitle?.trim() || stripMarkdownExtension(lastPathSegment(candidate.notePath));
    const selected = candidate.selected === false ? "[ ]" : "[x]";
    const link = obsidianLink(candidate.notePath, title);
    const quotes = candidate.quotes?.filter((quote) => quote.trim()).map((quote) => `  - Quote: ${quote.trim()}`) ?? [];

    return [
      `${index + 1}. ${selected} ${link} <button class="aha-open-candidate" data-aha-path="${escapeHtmlAttribute(candidate.notePath)}">Open</button>`,
      `   - Relation: \`${candidate.relation}\``,
      `   - Hit: ${candidate.hit.trim()}`,
      `   - Why: ${candidate.why.trim()}`,
      ...quotes,
    ].join("\n");
  });
}

export function renderGrillHandoff(sourcePath: string, sourceTitle: string, candidates: AhaCandidate[]): string[] {
  const selected = candidates.filter((candidate) => candidate.selected !== false);

  return [
    `Source insight: ${obsidianLink(sourcePath, sourceTitle)}`,
    "",
    "Selected old notes:",
    ...(selected.length === 0
      ? ["- _No selected memories yet._"]
      : selected.map((candidate) => {
          const title = candidate.noteTitle?.trim() || stripMarkdownExtension(lastPathSegment(candidate.notePath));
          return `- ${obsidianLink(candidate.notePath, title)} (${candidate.relation}): ${candidate.why.trim()}${candidate.hit ? ` Hit: ${candidate.hit.trim()}` : ""}`;
        })),
  ];
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
  const placeholder = {
    "search-results": "_No search round has completed yet._",
    "selected-memories": "_Aha will add selected memory candidates here after retrieval._",
    "grill-handoff": "_Aha will prepare a compact handoff after retrieval._",
  }[blockName];
  return placeholder && value.trim() === placeholder ? "" : value;
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

function escapeHtmlAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
