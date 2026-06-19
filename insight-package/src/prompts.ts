import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { GRILL_INSIGHT_PATH, type ActiveSession, type InsightSession, compactLine } from "./domain.ts";
import { formatMemoryCandidateTable, sourceLabel } from "./memory.ts";
import { sourceNoteMemoryContext, sourceNoteStructureHint } from "./source-note.ts";

export function selectedMemoryForGrillBriefing(session: InsightSession): InsightSession["memoryCandidates"] {
  const used = new Set(session.usedMemoryIds);
  const selected = [
    ...session.memoryCandidates.filter((candidate) => used.has(candidate.id)),
    ...session.memoryCandidates.filter((candidate) => !used.has(candidate.id)),
  ];
  const unique = new Map<string, InsightSession["memoryCandidates"][number]>();
  for (const candidate of selected) {
    unique.set(candidate.id, candidate);
  }
  return Array.from(unique.values()).slice(0, 5);
}

export function buildGrillBriefing(active: ActiveSession): string {
  const { session, sessionDir, statePath, grillContextPath, grillBriefingPath } = active;
  const memoryLines = selectedMemoryForGrillBriefing(session).map((candidate) => {
    return [
      `- ${candidate.title}`,
      `  关系: ${candidate.relation}; 来源: ${sourceLabel(candidate)}`,
      `  可形成的认知阻力: ${compactLine(candidate.reason || candidate.whyReadFirst)}`,
    ].join("\n");
  });
  const judgmentLines = session.candidateJudgments.map((judgment) => {
    return `- [${judgment.userStatus}] ${compactLine(judgment.text)}`;
  });
  const insightLines = session.newInsights.map((insight) => `- ${compactLine(insight.text)}`);
  const unresolvedLines = session.unresolvedQuestions.map((question) => `- ${compactLine(question)}`);
  const grillTurnLines = session.grillTurns.slice(-3).map((turn) => {
    return [
      `- 问: ${compactLine(turn.question)}`,
      turn.answer ? `  答: ${compactLine(turn.answer)}` : undefined,
      turn.resultingInsight ? `  结果: ${compactLine(turn.resultingInsight)}` : undefined,
    ].filter(Boolean).join("\n");
  });

  return [
    "# Grill Briefing",
    "",
    "这是进入 review_grill 时使用的阶段切换 compact。它保留有用判断材料，降低前一阶段 memory search 表格、工具轨迹和展示格式指令的影响。",
    "",
    "## Session Files",
    "",
    `- Session directory: ${sessionDir}`,
    `- State JSON: ${statePath}`,
    `- Grill context: ${grillContextPath}`,
    `- Grill briefing: ${grillBriefingPath}`,
    "",
    "## 原始 Insight",
    "",
    session.rawInsight,
    "",
    "## 当前语境",
    "",
    session.context,
    "",
    "## 可用的旧笔记阻力",
    "",
    memoryLines.length > 0 ? memoryLines.join("\n") : "- 暂无已确认有用的旧笔记候选。",
    "",
    "## 正在形成的候选判断",
    "",
    judgmentLines.length > 0 ? judgmentLines.join("\n") : "- 暂无稳定候选判断。",
    "",
    "## 新方向",
    "",
    insightLines.length > 0 ? insightLines.join("\n") : "- 暂无记录。",
    "",
    "## 最近的 Grill Turn",
    "",
    grillTurnLines.length > 0 ? grillTurnLines.join("\n") : "- 暂无记录。",
    "",
    "## 未解决问题",
    "",
    unresolvedLines.length > 0 ? unresolvedLines.join("\n") : "- 暂无。",
    "",
    "## Grill 模式规则",
    "",
    "- 一次只推进一个有用的追问。",
    "- 焦点放在当前判断，而不是 memory retrieval 的技术过程。",
    "- 如果给推荐倾向，保持短、暂定、可修正。",
    "- 目标是形成认知阻力：帮助用户自己生成、修正或限定一个判断。",
    "- 只有有意义的 turn 或稳定候选判断，才用 insight_update_state 记录。",
  ].join("\n");
}

export function writeGrillBriefing(active: ActiveSession): string {
  const briefing = buildGrillBriefing(active);
  writeFileSync(active.grillBriefingPath, briefing.trim() + "\n", "utf-8");
  return briefing;
}

export function loadGrillInsightInstructions(): string {
  if (!existsSync(GRILL_INSIGHT_PATH)) {
    return "The grill-insight skill was not found locally; continue with the Review-Grill Loop rules from project context.";
  }
  return readFileSync(GRILL_INSIGHT_PATH, "utf-8").trim();
}

export function buildAgentPrompt(active: ActiveSession): string {
  const { session, sessionDir, statePath } = active;
  return [
    "Start the Insight-to-Judgment workflow for the active /insight session.",
    "",
    "Current stage: memory.",
    "Memory backend: QMD over the configured obsidian index. Use `insight_search_memory` for memory retrieval.",
    "",
    "Session files:",
    `- Session directory: ${sessionDir}`,
    `- State JSON: ${statePath}`,
    "",
    "Raw insight:",
    session.rawInsight,
    "",
    "Context:",
    session.context,
    "",
    sourceNoteMemoryContext(session),
    "",
    session.explicitMemoryCues.length > 0
      ? `Explicit memory cues:\n${session.explicitMemoryCues.map((cue) => `- ${cue}`).join("\n")}`
      : "Explicit memory cues: none provided.",
    "",
    "Your next actions:",
    "0. Stay in the memory stage. Do not run shell commands, search project docs, search state.json/grill-context.md, or invoke grill-insight before memory retrieval.",
    "1. Generate multiple memory query shapes: raw, abstracted_judgment, contextual, plus explicit_cue when explicit memory cues exist.",
    "2. For qmd query / qmd vsearch calls, pass a structured qmd object with intent, lex, vec, and hyde. Use short lex probes and a semantic vec/hyde rather than title-only guesses.",
    "3. For explicit_cue queries, use text with command qmd search when the cue is a concrete name, title, or phrase.",
    "4. Call `insight_search_memory` with only these query kinds: raw, abstracted_judgment, contextual, explicit_cue. The tool will run QMD, expand backlinks from the top QMD seeds, agent-rerank the combined pool, and return Note / Relation / Hit / Why.",
    "5. Present the returned candidates as a clean Markdown table with exactly these fields: Note, Relation, Hit, Why. Why means why this note is worth reading first.",
    "6. Stop after the table and ask the user to choose: search more memory, or enter grill.",
    "7. Do not enter review_grill until the user explicitly chooses to enter grill.",
    "8. When you need exact Obsidian note identity, original note content, backlinks, outlinks, or title/alias resolution, use Obsidian CLI rather than guessing filesystem paths.",
  ].join("\n");
}

export function buildMemoryReviewPrompt(active: ActiveSession): string {
  const { session, sessionDir, statePath, grillContextPath } = active;
  const candidateTable = formatMemoryCandidateTable(session.memoryCandidates);

  return [
    "Continue the Memory Review checkpoint for the active /insight session.",
    "",
    "Current stage: memory_review.",
    "",
    "Session files:",
    `- Session directory: ${sessionDir}`,
    `- State JSON: ${statePath}`,
    `- Grill context: ${grillContextPath}`,
    "",
    "Memory candidates already retrieved:",
    candidateTable,
    "",
    "Your next actions:",
    "1. Present the candidates as a clean Markdown table if the user has not already seen them.",
    "2. Ask the user to review candidates as accepted, rejected, or uncertain, then choose exactly one next move: search more memory, or enter grill.",
    "3. If the user asks to search more, call `insight_search_memory` again and merge the new candidates.",
    "4. Before entering grill, record the user's candidate decisions with `memoryReview` / `memoryReviews` on `insight_update_state`.",
    "5. If the user explicitly chooses grill, call `insight_update_state` with exact stage enum `review_grill` (not `grill`, `questioning`, or `grill-review`).",
    "6. Do not ask grill questions while still in memory_review; if the stage update fails, stay in memory_review and fix the transition first.",
    "7. If you need to open a candidate note, use the QMD file path when available; otherwise use Obsidian CLI or locate the exact file path first.",
    "8. Do not call `insight_update_state` only to restate the current stage.",
    "9. When you need exact Obsidian note identity, source-note content, backlinks, outlinks, or title/alias resolution, use Obsidian CLI.",
  ].join("\n");
}

export function buildReviewGrillPrompt(active: ActiveSession): string {
  const { session, sessionDir, statePath, grillContextPath, grillBriefingPath } = active;
  const briefing = existsSync(grillBriefingPath)
    ? readFileSync(grillBriefingPath, "utf-8").trim()
    : buildGrillBriefing(active);

  return [
    "Enter the Review-Grill Loop for the active /insight session.",
    "",
    "Current stage: review_grill.",
    "",
    "Session files:",
    `- Session directory: ${sessionDir}`,
    `- State JSON: ${statePath}`,
    `- Grill context: ${grillContextPath}`,
    `- Grill briefing: ${grillBriefingPath}`,
    "",
    "Use this compact grill briefing as the current stage context:",
    briefing,
    "",
    "Your next actions:",
    "1. Continue the Review-Grill loop using the loaded grill-insight guidance.",
    "2. Record only meaningful review actions or emerging judgments; do not call `insight_update_state` only to restate `review_grill`.",
    "3. Use `insight_append_grill_context` for stable language or process notes; write mainly in Chinese and follow Language / Decision Records style.",
    "4. Do not enter summary unless the user explicitly asks for summary or complete.",
    "5. When the user explicitly says they are ready for summary, call `insight_confirm_readiness` with the user's exact readiness text. Do not use `insight_update_state` for summary.",
    "6. Use `insight_save_summary` only after `insight_confirm_readiness` has moved the stage to summary.",
    "7. Use Obsidian CLI when exact note identity, source-note content, backlinks, outlinks, or title/alias resolution matters.",
    "",
    "Summary structure rule:",
    sourceNoteStructureHint(session),
    "",
    "Review-Grill guidance:",
    loadGrillInsightInstructions(),
  ].join("\n");
}

export function buildStagePrompt(active: ActiveSession): string {
  if (active.session.stage === "memory_review") return buildMemoryReviewPrompt(active);
  if (active.session.stage === "review_grill") return buildReviewGrillPrompt(active);
  return buildResumePrompt(active);
}

export function buildResumePrompt(active: ActiveSession): string {
  const { session, sessionDir, statePath, grillContextPath } = active;
  return [
    "Resume the active /insight session.",
    "",
    `Current stage: ${session.stage}.`,
    "",
    "Session files:",
    `- Session directory: ${sessionDir}`,
    `- State JSON: ${statePath}`,
    `- Grill context: ${grillContextPath}`,
    "",
    "Raw insight:",
    session.rawInsight,
    "",
    "Context:",
    session.context,
    "",
    "Continue according to the stage:",
    "- memory: call insight_search_memory if candidates are missing.",
    "- memory_review: show the candidate table, record memoryReview decisions, and ask whether to search more memory or enter grill.",
    "- review_grill: use the Review-Grill loop; do not call insight_update_state only to restate the current stage. Use insight_confirm_readiness before summary.",
    "- summary: continue only if the user asks to revise or save a summary draft. Saving a draft defaults to staying in summary.",
    "- complete: do not continue unless the user asks to revise or reopen.",
    "- Use Obsidian CLI whenever exact note identity, source-note content, backlinks, outlinks, or title/alias resolution matters.",
  ].join("\n");
}
