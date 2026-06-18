import type { ActiveSession, InsightUpdateStateParams, Stage } from "./domain.ts";
import { isDirectQmdShellCommand, isInsightMemoryStageReadBlocked, isInsightStateDiscoveryCommand } from "./memory.ts";

export interface InsightUpdatePolicyResult {
  previousStage: Stage;
  targetStage: Stage;
  stageOnlyNoOp: boolean;
}

export interface StageToolBlock {
  block: true;
  reason: string;
}

export function stageLabel(stage: Stage): string {
  switch (stage) {
    case "memory": return "Memory";
    case "memory_review": return "Memory Review";
    case "review_grill": return "Grill";
    case "summary": return "Summary";
    case "complete": return "Complete";
  }
}

export function evaluateInsightUpdatePolicy(
  params: InsightUpdateStateParams,
  previousStage: Stage,
): InsightUpdatePolicyResult {
  const targetStage = params.stage ?? previousStage;

  if (params.stage === "review_grill" && previousStage !== "memory_review" && previousStage !== "review_grill") {
    throw new Error(
      `Cannot enter review_grill from ${previousStage}. Complete memory search and reach memory_review first.`,
    );
  }

  if (params.grillTurn && targetStage !== "review_grill") {
    throw new Error(
      `Cannot record grillTurn while stage is ${previousStage}. First transition to exact stage enum review_grill.`,
    );
  }

  const providedKeys = Object.entries(params).filter(([, value]) => value !== undefined);
  return {
    previousStage,
    targetStage,
    stageOnlyNoOp: Boolean(params.stage && params.stage === previousStage && providedKeys.length === 1),
  };
}

export function shouldCreateReviewGrillBriefing(previousStage: Stage, currentStage: Stage): boolean {
  return previousStage !== "review_grill" && currentStage === "review_grill";
}

export function evaluateStageToolPolicy(
  toolName: string,
  input: unknown,
  activeSession?: ActiveSession,
): StageToolBlock | undefined {
  if (activeSession?.session.stage !== "memory") return undefined;

  if (toolName === "read" && isInsightMemoryStageReadBlocked(input, activeSession)) {
    return {
      block: true,
      reason: "Blocked during /insight memory stage: do not read insight state, grill context/briefing, summary draft, or grill-insight skill files. Use insight_search_memory first, then wait for memory_review.",
    };
  }

  if (toolName !== "bash") return undefined;

  const command = String((input as { command?: unknown }).command ?? "");
  if (isDirectQmdShellCommand(command)) {
    return {
      block: true,
      reason: "Blocked during /insight memory stage: do not call qmd through bash. Use insight_search_memory so the extension applies the obsidian index, remote model environment, and error handling.",
    };
  }

  if (!isInsightStateDiscoveryCommand(command)) return undefined;
  return {
    block: true,
    reason: "Blocked during /insight memory stage: do not search state.json or grill-context.md. Use insight_search_memory with raw, abstracted_judgment, contextual, and explicit_cue queries.",
  };
}
