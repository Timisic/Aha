import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import { COMMAND_OUTPUT_MAX_BYTES, OBSIDIAN_TIMEOUT_MS, SECTION_NAMES, SOURCE_NOTE_MAX_BYTES, configuredSourceRoots, isPathInside, type InsightSession } from "./domain.ts";

export function stripMarkdownExtension(name: string): string {
  return name.replace(/\.md$/i, "");
}

export function extractMarkdownPath(input: string): string | undefined {
  const match = input.match(/\/[^\n\r]+?\.md/i);
  return match?.[0]?.trim();
}

export function extractWikiLink(input: string): string | undefined {
  const match = input.match(/\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/);
  return match?.[1]?.trim();
}

export function titleFromMarkdownPath(path: string): string {
  return stripMarkdownExtension(basename(path)).trim();
}

export function isExplicitSourceNoteInput(input: string): boolean {
  return Boolean(
    extractSection(input, [
      "source note",
      "原始笔记",
      "obsidian 原始笔记",
      "obsidian笔记",
    ]) ||
      /(?:source\s*note|obsidian\s*(?:source\s*)?note|原始笔记|原文笔记|源笔记|包含了?我的?\s*insight)/i.test(input),
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function obsidianCommand(): string {
  return process.env.OBSIDIAN_BIN?.trim() || "obsidian";
}

export function readObsidianSync(args: string[], cwd: string): string | undefined {
  const result = spawnSync(obsidianCommand(), args, {
    cwd,
    encoding: "utf-8",
    maxBuffer: COMMAND_OUTPUT_MAX_BYTES,
    timeout: OBSIDIAN_TIMEOUT_MS,
    windowsHide: true,
  });
  const output = result.stdout?.trim();
  if (result.status !== 0 || result.error || !output || /^Error:\s+/i.test(output)) {
    return undefined;
  }
  return output;
}

export function readSourceNoteFileFallback(path: string, cwd: string): string | undefined {
  const resolved = resolve(path);
  const allowedRoot = configuredSourceRoots(cwd).some((root) => isPathInside(root, resolved));
  if (!allowedRoot) return undefined;

  try {
    const stat = statSync(resolved);
    if (!stat.isFile() || stat.size > SOURCE_NOTE_MAX_BYTES) return undefined;
    return readFileSync(resolved, "utf-8");
  } catch {
    return undefined;
  }
}

export function readSourceNoteWithObsidian(
  input: string,
  cwd: string,
  options: { allowPathRead?: boolean; allowFileFallback?: boolean } = {},
): { path?: string; content: string } | undefined {
  const markdownPath = extractMarkdownPath(input);
  if (markdownPath && options.allowPathRead !== false) {
    const cliContent = readObsidianSync(["read", `path=${markdownPath}`], cwd);
    if (cliContent) return { path: markdownPath, content: cliContent };
    if (options.allowFileFallback === true) {
      const fileContent = readSourceNoteFileFallback(markdownPath, cwd);
      if (fileContent) return { path: markdownPath, content: fileContent };
    }
  }

  const wikiTitle = extractWikiLink(input);
  if (wikiTitle) {
    const cliContent = readObsidianSync(["read", `file=${wikiTitle}`], cwd);
    if (cliContent) return { content: cliContent };
  }

  return undefined;
}

export function extractSection(input: string, names: string[]): string | undefined {
  const lines = input.split(/\r?\n/);
  const wanted = new Set(names.map((name) => name.toLowerCase()));
  const allNames = SECTION_NAMES.map((name) => name.toLowerCase());

  let capture = false;
  const captured: string[] = [];

  for (const line of lines) {
    const match = line.match(/^\s*(?:#+\s*)?([^:：]+?)\s*[:：]\s*(.*)$/);
    const heading = match?.[1]?.trim().toLowerCase();

    if (heading && allNames.includes(heading)) {
      if (capture) break;
      capture = wanted.has(heading);
      if (capture && match?.[2]) {
        captured.push(match[2].trim());
      }
      continue;
    }

    if (capture) {
      captured.push(line);
    }
  }

  const value = captured.join("\n").trim();
  return value || undefined;
}

export function parseInsightInput(input: string, cwd: string): {
  rawInsight: string;
  context: string;
  sourceNote?: { path?: string; content: string };
  explicitMemoryCues: string[];
} {
  const trimmed = input.replace(/\\n/g, "\n").trim();
  const referencedPath = extractMarkdownPath(trimmed);
  const rawInsight =
    extractSection(trimmed, ["raw insight", "insight", "原始洞察", "洞察", "启发"]) ??
    trimmed.split(/\n{2,}/)[0]?.trim() ??
    trimmed;

  const context =
    extractSection(trimmed, ["context", "上下文", "背景"]) ??
    (trimmed === rawInsight ? trimmed : trimmed.replace(rawInsight, "").trim()) ??
    trimmed;

  const sourceNoteContent = extractSection(trimmed, [
    "source note",
    "原始笔记",
    "obsidian 原始笔记",
    "obsidian笔记",
  ]);
  const explicitSourceNoteInput = isExplicitSourceNoteInput(trimmed);
  const sourceNote =
    sourceNoteContent
      ? readSourceNoteWithObsidian(`Source note:\n${sourceNoteContent}`, cwd, {
          allowPathRead: true,
          allowFileFallback: true,
        }) ??
        { path: referencedPath, content: sourceNoteContent }
      : readSourceNoteWithObsidian(trimmed, cwd, {
          allowPathRead: explicitSourceNoteInput,
          allowFileFallback: explicitSourceNoteInput,
        });

  const explicitCueText = extractSection(trimmed, [
    "connected history notes",
    "相关旧笔记",
    "历史笔记",
  ]);
  const explicitMemoryCues = explicitCueText
    ? explicitCueText
        .split(/\n|,|，|;/)
        .map((line) => line.replace(/^[-*]\s*/, "").trim())
        .filter(Boolean)
    : [];

  return {
    rawInsight,
    context: context || trimmed,
    sourceNote,
    explicitMemoryCues,
  };
}

export function sourceNoteHeadingTitles(session: InsightSession): string[] {
  const content = session.sourceNote?.content;
  if (!content) return [];
  return Array.from(
    new Set(
      content
        .split(/\r?\n/)
        .map((line) => line.match(/^#{1,6}\s+(.+?)\s*$/)?.[1]?.trim())
        .filter((line): line is string => Boolean(line)),
    ),
  ).slice(0, 20);
}

export function missingSourceNoteSummaryHeadings(summaryDraft: string, session: InsightSession): string[] {
  return sourceNoteHeadingTitles(session).filter((heading) => {
    const pattern = new RegExp(`^#{1,6}\\s+${escapeRegExp(heading)}\\s*$`, "m");
    return !pattern.test(summaryDraft);
  });
}

export function sourceNoteStructureHint(session: InsightSession): string {
  const content = session.sourceNote?.content;
  if (!content) {
    return "No original Obsidian source note structure is available. Ask the user for the source note if summary structure matters.";
  }
  const headings = content
    .split(/\r?\n/)
    .map((line) => line.match(/^(#{1,6})\s+(.+?)\s*$/)?.[0]?.trim())
    .filter((line): line is string => Boolean(line))
    .slice(0, 20);
  if (headings.length === 0) {
    return [
      "Original Obsidian source note has no explicit Markdown headings.",
      "When drafting summary, preserve the note's rough order and weave new judgments into the relevant original paragraphs instead of inventing a new top-level structure.",
      session.sourceNote?.path ? `Source note path: ${session.sourceNote.path}` : "",
    ].filter(Boolean).join("\n");
  }
  return [
    "Original Obsidian source note heading order:",
    ...headings.map((heading) => `- ${heading}`),
    "When drafting summary, follow this source-note structure and place new judgments under the relevant original sections instead of inventing a separate generic summary outline.",
  ].join("\n");
}

export function sourceNoteMemoryContext(session: InsightSession): string {
  const sourceNote = session.sourceNote;
  if (!sourceNote?.content) return "Source note: none provided or not readable.";
  const excerpt = sourceNote.content.trim().slice(0, 6000);
  return [
    "Source note for memory search:",
    sourceNote.path ? `Path: ${sourceNote.path}` : undefined,
    excerpt,
  ].filter(Boolean).join("\n");
}

export function refreshSourceNoteFromObsidian(session: InsightSession, cwd: string): void {
  const sourcePath = session.sourceNote?.path;
  if (!sourcePath) return;
  const content = readSourceNoteWithObsidian(sourcePath, cwd)?.content;
  if (!content) return;
  session.sourceNote = {
    path: sourcePath,
    content,
  };
}
