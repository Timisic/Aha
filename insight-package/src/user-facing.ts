import type { Stage } from "./domain.ts";

export function stageLabel(stage: Stage): string {
  switch (stage) {
    case "memory": return "Memory";
    case "memory_review": return "Memory Review";
    case "review_grill": return "Grill";
    case "summary": return "Summary";
    case "complete": return "Complete";
  }
}

export function stageListHint(): string {
  return "Stages: memory, memory_review (Review checkpoint), review_grill, summary, complete; archived sessions are hidden unless requested.";
}

export function insightCommandHelp(): string {
  return [
    "# /insight commands",
    "",
    "Start: /insight <raw insight plus context>",
    "",
    "Session management:",
    "- /insight list [--all] [--archived] [--stage <stage>] [--date YYYY-MM-DD] [--title <text>]",
    "- /insight search <text>",
    "- /insight current",
    "- /insight resume <exact-id-or-directory> (ambiguous matches are shown, never silently selected)",
    "- /insight rename <session> <new title>",
    "- /insight archive <session>",
    "- /insight unarchive <session>",
    "- /insight inspect [session]",
    "- /insight delete <session> --confirm <session-id>",
    "",
    "Candidate review:",
    "- /insight candidate inspect <number-or-id> [--table <version>]",
    "- /insight candidate open <number-or-id> [--table <version>]",
    "- /insight candidate path <number-or-id> [--table <version>]",
    "- /insight candidate review accepted 1,3 rejected 2 uncertain 4 [--table <version>]",
    "",
    "Summary handoff:",
    "- /insight summary inspect [session]",
    "- /insight summary path [session]",
    "",
    "Summary stays local: the draft is stored as summary-draft.md inside the session directory and is not written to Obsidian.",
    stageListHint(),
  ].join("\n");
}
