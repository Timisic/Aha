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
  activeSession: ActiveSession,
): InsightUpdatePolicyResult {
  const previousStage = activeSession.session.stage;
  const targetStage = params.stage ?? previousStage;
  const candidateIds = new Set(activeSession.session.memoryCandidates.map((candidate) => candidate.id));
  const incomingReviews = [
    ...(params.memoryReview ? [params.memoryReview] : []),
    ...(params.memoryReviews ?? []),
  ];
  const hasMemoryReview =
    activeSession.session.memoryReviews.some((review) => candidateIds.has(review.candidateId)) ||
    incomingReviews.some((review) => candidateIds.has(review.candidateId));

  if (params.stage && params.stage !== previousStage) {
    const allowed =
      previousStage === "memory_review" && params.stage === "review_grill" ? hasMemoryReview :
      previousStage === "review_grill" && params.stage === "memory" ? Boolean(params.newInsight?.triggeredMemorySearch) :
      previousStage === "summary" && params.stage === "complete" ? true :
      false;

    if (!allowed) {
      if (params.stage === "review_grill" && previousStage === "memory_review" && !hasMemoryReview) {
        throw new Error("Cannot enter review_grill until at least one memoryReview has recorded the user's candidate review.");
      }
      if (params.stage === "summary") {
        throw new Error("Cannot enter summary through insight_update_state. Use insight_confirm_readiness after explicit user readiness.");
      }
      if (previousStage === "complete") {
        throw new Error("Cannot change a complete insight session without an explicit reopen flow.");
      }
      throw new Error(`Cannot transition insight stage from ${previousStage} to ${params.stage}.`);
    }
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

export function assertCanConfirmReadiness(activeSession: ActiveSession): void {
  if (activeSession.session.stage !== "review_grill") {
    throw new Error(`Cannot confirm summary readiness while stage is ${activeSession.session.stage}. Enter review_grill first.`);
  }
}

export function assertCanSaveSummary(activeSession: ActiveSession): void {
  if (activeSession.session.stage !== "summary") {
    throw new Error(`Cannot save summary while stage is ${activeSession.session.stage}. Use insight_confirm_readiness first.`);
  }
  if (!activeSession.session.summaryReadiness) {
    throw new Error("Cannot save summary without recorded summaryReadiness evidence.");
  }
}

export function assertCanSearchMemory(activeSession: ActiveSession): void {
  if (activeSession.session.stage === "summary" || activeSession.session.stage === "complete") {
    throw new Error(`Cannot search memory while stage is ${activeSession.session.stage}.`);
  }
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
