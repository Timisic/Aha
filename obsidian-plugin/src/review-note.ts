import type { AhaCandidate } from "./schema";
import { lastPathSegment, noteDisplayTitleFromPath, stripMarkdownExtension } from "./wikilink";

export { noteDisplayTitleFromPath } from "./wikilink";

export interface ReviewPanelCandidate extends AhaCandidate {
  index: number;
  selected: boolean;
  quotes: string[];
}

export type ReviewBenchmarkSeedAction = "accept" | "reject_as_noise" | "should_have_found";

export type ReviewBenchmarkSeedLabel = "nice_to_have" | "negative" | "must_recall";

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

export function seedLabelForAction(action: ReviewBenchmarkSeedAction): ReviewBenchmarkSeedLabel {
  if (action === "reject_as_noise") return "negative";
  if (action === "should_have_found") return "must_recall";
  return "nice_to_have";
}

export function obsidianLink(path: string, title?: string): string {
  const target = stripMarkdownExtension(path).replace(/\|/g, "\\|");
  const alias = title?.trim();
  if (!alias || alias === target || alias === lastPathSegment(target)) {
    return `[[${target}]]`;
  }
  return `[[${target}|${alias.replace(/\|/g, "\\|")}]]`;
}
