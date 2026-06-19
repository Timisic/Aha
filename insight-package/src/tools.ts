import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { Type } from "typebox";
import { type InsightAppendGrillContextParams, type InsightConfirmReadinessParams, type InsightSaveSummaryParams, type InsightSearchMemoryParams, type InsightUpdateStateParams, nowIso, textHash } from "./domain.ts";
import { memorySearchResultComponent } from "./memory.ts";
import { runInsightMemoryRetrieval } from "./memory-retrieval.ts";
import { missingSourceNoteSummaryHeadings, refreshSourceNoteFromObsidian, sourceNoteSummaryWarnings } from "./source-note.ts";
import { appendMarkdownSection, localizedGrillHeading, summaryDraftPathFor } from "./session.ts";
import { buildReviewGrillPrompt, writeStageBriefing } from "./prompts.ts";
import { persistActiveSessionBinding, prepareAgentPrompt, saveActiveState, type InsightRuntime } from "./runtime.ts";
import { assertCanConfirmReadiness, assertCanSaveSummary, evaluateInsightUpdatePolicy, shouldCreateReviewGrillBriefing } from "./stage-policy.ts";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { recordTrajectoryToolFinished, recordTrajectoryToolStarted } from "./trajectory.ts";

async function withToolTrajectory<T>(
  runtime: InsightRuntime,
  toolName: string,
  toolCallId: string,
  params: unknown,
  execute: () => Promise<T> | T,
): Promise<T> {
  const startedAt = Date.now();
  const activeAtStart = runtime.activeSession;
  recordTrajectoryToolStarted(activeAtStart, {
    toolName,
    toolCallId,
    params,
  });

  try {
    const result = await execute();
    recordTrajectoryToolFinished(activeAtStart, {
      toolName,
      toolCallId,
      startedAt,
      result,
    });
    return result;
  } catch (error) {
    recordTrajectoryToolFinished(activeAtStart, {
      toolName,
      toolCallId,
      startedAt,
      error,
    });
    throw error;
  }
}

function assertKnownMemoryCandidate(active: NonNullable<InsightRuntime["activeSession"]>, candidateId: string): void {
  if (!active.session.memoryCandidates.some((candidate) => candidate.id === candidateId)) {
    throw new Error(`Unknown memory candidate id: ${candidateId}`);
  }
}

function recordMemoryReviews(
  active: NonNullable<InsightRuntime["activeSession"]>,
  reviews: NonNullable<InsightUpdateStateParams["memoryReviews"]>,
): void {
  for (const review of reviews) {
    assertKnownMemoryCandidate(active, review.candidateId);
    const userText = review.userText ?? review.rationale ?? `${review.candidateId}:${review.status}`;
    active.session.memoryReviews = [
      ...active.session.memoryReviews.filter((item) => item.candidateId !== review.candidateId),
      {
        candidateId: review.candidateId,
        status: review.status,
        rationale: review.rationale,
        reviewedAt: nowIso(),
        userTurnRef: review.userTurnRef,
        userTextHash: textHash(userText),
      },
    ];
  }
}

function assertReviewedMemoryUse(
  active: NonNullable<InsightRuntime["activeSession"]>,
  usedMemoryIds: string[],
): void {
  const accepted = new Set(
    active.session.memoryReviews
      .filter((review) => review.status === "accepted")
      .map((review) => review.candidateId),
  );
  for (const candidateId of usedMemoryIds) {
    assertKnownMemoryCandidate(active, candidateId);
    if (!accepted.has(candidateId)) {
      throw new Error(`Cannot use memory ${candidateId}; it has not been accepted by user review.`);
    }
  }
}

export function registerInsightTools(pi: ExtensionAPI, runtime: InsightRuntime, Type: Type): void {
  pi.registerTool({
    name: "insight_search_memory",
    label: "Insight Memory Search",
    description:
      "Run serialized QMD searches for the active /insight session, merge candidates, and update state.json.",
    executionMode: "sequential",
    renderResult(result: { details?: unknown }) {
      return memorySearchResultComponent(result);
    },
    parameters: Type.Object({
      queries: Type.Array(
        Type.Object({
          text: Type.Optional(Type.String()),
          kind: Type.Union([
            Type.Literal("raw"),
            Type.Literal("abstracted_judgment"),
            Type.Literal("contextual"),
            Type.Literal("explicit_cue"),
            Type.Literal("open-ended"),
            Type.Literal("constraint"),
            Type.Literal("challenge"),
            Type.Literal("support"),
            Type.Literal("bounds"),
          ]),
          command: Type.Optional(
            Type.Union([
              Type.Literal("qmd query"),
              Type.Literal("qmd vsearch"),
              Type.Literal("qmd search"),
            ]),
          ),
          qmd: Type.Optional(
            Type.Object({
              intent: Type.String(),
              lex: Type.Array(Type.String()),
              vec: Type.String(),
              hyde: Type.String(),
            }),
          ),
        }),
      ),
      limit: Type.Optional(Type.Number()),
    }),
    async execute(
      toolCallId: string,
      params: InsightSearchMemoryParams,
      signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ExtensionCommandContext,
    ) {
      return withToolTrajectory(runtime, "insight_search_memory", toolCallId, params, () =>
        runInsightMemoryRetrieval(pi, runtime, params, signal, ctx),
      );
    },
  });

  pi.registerTool({
    name: "insight_update_state",
    label: "Insight State",
    description:
      "Update the active Insight-to-Judgment session state JSON. Use only for the current /insight workflow.",
    executionMode: "sequential",
    parameters: Type.Object({
      stage: Type.Optional(
        Type.Union([
          Type.Literal("memory"),
          Type.Literal("memory_review"),
          Type.Literal("review_grill"),
          Type.Literal("summary"),
          Type.Literal("complete"),
        ]),
      ),
      note: Type.Optional(Type.String()),
      usedMemoryIds: Type.Optional(Type.Array(Type.String())),
      newInsight: Type.Optional(
        Type.Object({
          text: Type.String(),
          openedDirection: Type.Optional(Type.Boolean()),
          triggeredMemorySearch: Type.Optional(Type.Boolean()),
        }),
      ),
      grillTurn: Type.Optional(
        Type.Object({
          question: Type.String(),
          answer: Type.Optional(Type.String()),
          resultingInsight: Type.Optional(Type.String()),
        }),
      ),
      candidateJudgment: Type.Optional(
        Type.Object({
          text: Type.String(),
          userStatus: Type.Optional(
            Type.Union([
              Type.Literal("pending"),
              Type.Literal("accepted"),
              Type.Literal("rejected"),
              Type.Literal("revised"),
            ]),
          ),
          evidenceMemoryIds: Type.Optional(Type.Array(Type.String())),
          userTurnRef: Type.Optional(Type.String()),
          replacesId: Type.Optional(Type.String()),
        }),
      ),
      memoryReview: Type.Optional(
        Type.Object({
          candidateId: Type.String(),
          status: Type.Union([
            Type.Literal("accepted"),
            Type.Literal("rejected"),
            Type.Literal("uncertain"),
          ]),
          rationale: Type.Optional(Type.String()),
          userText: Type.Optional(Type.String()),
          userTurnRef: Type.Optional(Type.String()),
        }),
      ),
      memoryReviews: Type.Optional(
        Type.Array(
          Type.Object({
            candidateId: Type.String(),
            status: Type.Union([
              Type.Literal("accepted"),
              Type.Literal("rejected"),
              Type.Literal("uncertain"),
            ]),
            rationale: Type.Optional(Type.String()),
            userText: Type.Optional(Type.String()),
            userTurnRef: Type.Optional(Type.String()),
          }),
        ),
      ),
      summaryDraft: Type.Optional(Type.String()),
    }),
    async execute(toolCallId: string, params: InsightUpdateStateParams, _signal: unknown, _onUpdate: unknown, ctx: ExtensionCommandContext) {
      return withToolTrajectory(runtime, "insight_update_state", toolCallId, params, () => {
      if (!runtime.activeSession) {
        return {
          content: [{ type: "text", text: "No active /insight session." }],
          details: { ok: false },
        };
      }

      const previousStage = runtime.activeSession.session.stage;
      const policy = evaluateInsightUpdatePolicy(params, runtime.activeSession);

      if (policy.stageOnlyNoOp) {
        return {
          content: [
            {
              type: "text",
              text: `Insight stage already ${previousStage}; no state update needed.`,
            },
          ],
          details: {
            ok: true,
            noOp: true,
            statePath: runtime.activeSession.statePath,
            stage: runtime.activeSession.session.stage,
          },
        };
      }

      if (params.stage) {
        runtime.activeSession.session.stage = params.stage;
      }
      if (params.note) {
        runtime.activeSession.session.unresolvedQuestions.push(params.note);
      }
      const memoryReviews = [
        ...(params.memoryReview ? [params.memoryReview] : []),
        ...(params.memoryReviews ?? []),
      ];
      if (memoryReviews.length > 0) {
        recordMemoryReviews(runtime.activeSession, memoryReviews);
      }
      if (params.usedMemoryIds) {
        assertReviewedMemoryUse(runtime.activeSession, params.usedMemoryIds);
        runtime.activeSession.session.usedMemoryIds = Array.from(
          new Set([...runtime.activeSession.session.usedMemoryIds, ...params.usedMemoryIds]),
        );
      }
      if (params.newInsight) {
        runtime.activeSession.session.newInsights.push({
          text: params.newInsight.text,
          openedDirection: params.newInsight.openedDirection ?? true,
          triggeredMemorySearch: params.newInsight.triggeredMemorySearch ?? false,
        });
      }
      if (params.grillTurn) {
        runtime.activeSession.session.grillTurns.push({
          question: params.grillTurn.question,
          answer: params.grillTurn.answer,
          resultingInsight: params.grillTurn.resultingInsight,
          createdAt: nowIso(),
        });
      }
      if (params.candidateJudgment) {
        if (params.candidateJudgment.evidenceMemoryIds) {
          assertReviewedMemoryUse(runtime.activeSession, params.candidateJudgment.evidenceMemoryIds);
        }
        runtime.activeSession.session.candidateJudgments = [
          ...runtime.activeSession.session.candidateJudgments,
          {
            id: `judgment-${nowIso()}`,
            text: params.candidateJudgment.text,
            status: params.candidateJudgment.userStatus ?? "pending",
            userStatus: params.candidateJudgment.userStatus ?? "pending",
            evidenceMemoryIds: params.candidateJudgment.evidenceMemoryIds ?? [],
            proposedAt: nowIso(),
            userTurnRef: params.candidateJudgment.userTurnRef,
            replacesId: params.candidateJudgment.replacesId,
          },
        ].slice(-3);
      }
      if (params.summaryDraft) {
        runtime.activeSession.session.summaryDraft = params.summaryDraft;
      }

      let stageBriefingPath: string | undefined;
      if (shouldCreateReviewGrillBriefing(previousStage, runtime.activeSession.session.stage)) {
        writeStageBriefing(runtime.activeSession);
        stageBriefingPath = runtime.activeSession.stageBriefingPath;
        prepareAgentPrompt(runtime, runtime.activeSession, buildReviewGrillPrompt(runtime.activeSession), { compact: true });
      }

      saveActiveState(ctx, runtime.activeSession);
      persistActiveSessionBinding(pi, runtime.activeSession);

      return {
        content: [
          {
            type: "text",
            text: stageBriefingPath
              ? [
                  `Updated insight state: ${runtime.activeSession.session.stage}`,
                  `Created stage briefing: ${stageBriefingPath}`,
                  "The next user turn will use a compact Review-Grill context.",
                ].join("\n")
              : `Updated insight state: ${runtime.activeSession.session.stage}`,
          },
        ],
        details: {
          ok: true,
          statePath: runtime.activeSession.statePath,
          stage: runtime.activeSession.session.stage,
          stageBriefingPath,
          grillBriefingPath: stageBriefingPath,
        },
      };
      });
    },
  });

  pi.registerTool({
    name: "insight_confirm_readiness",
    label: "Insight Summary Readiness",
    description:
      "Record explicit user readiness to move from review_grill into summary. This is the only tool that opens the summary stage.",
    executionMode: "sequential",
    parameters: Type.Object({
      userText: Type.String(),
      userTurnRef: Type.Optional(Type.String()),
    }),
    async execute(toolCallId: string, params: InsightConfirmReadinessParams, _signal: unknown, _onUpdate: unknown, ctx: ExtensionCommandContext) {
      return withToolTrajectory(runtime, "insight_confirm_readiness", toolCallId, params, () => {
      if (!runtime.activeSession) {
        return {
          content: [{ type: "text", text: "No active /insight session." }],
          details: { ok: false },
        };
      }

      assertCanConfirmReadiness(runtime.activeSession);
      runtime.activeSession.session.summaryReadiness = {
        confirmedAt: nowIso(),
        userText: params.userText,
        userTurnRef: params.userTurnRef,
        userTextHash: textHash(params.userText),
      };
      runtime.activeSession.session.stage = "summary";
      saveActiveState(ctx, runtime.activeSession);
      persistActiveSessionBinding(pi, runtime.activeSession);

      return {
        content: [
          {
            type: "text",
            text: `Confirmed summary readiness.\nStage: ${runtime.activeSession.session.stage}`,
          },
        ],
        details: {
          ok: true,
          statePath: runtime.activeSession.statePath,
          stage: runtime.activeSession.session.stage,
        },
      };
      });
    },
  });

  pi.registerTool({
    name: "insight_append_grill_context",
    label: "Insight Grill Context",
    description:
      "Append stable language, questions, or small decisions to the active insight grill-context.md process document. Write mainly in Chinese and follow the Language / Decision Records style; do not use it as an English transcript.",
    executionMode: "sequential",
    parameters: Type.Object({
      heading: Type.Optional(Type.String()),
      body: Type.String(),
    }),
    async execute(toolCallId: string, params: InsightAppendGrillContextParams) {
      return withToolTrajectory(runtime, "insight_append_grill_context", toolCallId, params, () => {
      if (!runtime.activeSession) {
        return {
          content: [{ type: "text", text: "No active /insight session." }],
          details: { ok: false },
        };
      }

      const heading = localizedGrillHeading(params.heading);
      const existing = existsSync(runtime.activeSession.grillContextPath)
        ? readFileSync(runtime.activeSession.grillContextPath, "utf-8")
        : "# Insight Grill 上下文\n";
      writeFileSync(
        runtime.activeSession.grillContextPath,
        appendMarkdownSection(existing, heading, params.body),
        "utf-8",
      );

      return {
        content: [{ type: "text", text: `Updated grill context section '${heading}': ${runtime.activeSession.grillContextPath}` }],
        details: { ok: true, grillContextPath: runtime.activeSession.grillContextPath },
      };
      });
    },
  });

  pi.registerTool({
    name: "insight_save_summary",
    label: "Insight Summary",
    description: "Save the active insight summary draft under the session directory and optionally mark the session complete.",
    executionMode: "sequential",
    parameters: Type.Object({
      summaryDraft: Type.String(),
      usedMemoryIds: Type.Optional(Type.Array(Type.String())),
      unresolvedQuestions: Type.Optional(Type.Array(Type.String())),
      preserveSourceStructure: Type.Optional(Type.Boolean()),
      markComplete: Type.Optional(Type.Boolean()),
    }),
    async execute(toolCallId: string, params: InsightSaveSummaryParams, _signal: unknown, _onUpdate: unknown, ctx: ExtensionCommandContext) {
      return withToolTrajectory(runtime, "insight_save_summary", toolCallId, params, () => {
      if (!runtime.activeSession) {
        return {
          content: [{ type: "text", text: "No active /insight session." }],
          details: { ok: false },
        };
      }

      assertCanSaveSummary(runtime.activeSession);
      refreshSourceNoteFromObsidian(runtime.activeSession.session, ctx.cwd);
      const missingHeadings = missingSourceNoteSummaryHeadings(params.summaryDraft, runtime.activeSession.session);
      if (params.preserveSourceStructure === true && missingHeadings.length > 0) {
        throw new Error(
          `Summary draft must preserve original Obsidian heading structure. Missing headings: ${missingHeadings.join(", ")}`,
        );
      }
      const warnings = sourceNoteSummaryWarnings(params.summaryDraft, runtime.activeSession.session);
      runtime.activeSession.session.summaryDraft = params.summaryDraft;
      if (params.usedMemoryIds) {
        assertReviewedMemoryUse(runtime.activeSession, params.usedMemoryIds);
        runtime.activeSession.session.usedMemoryIds = Array.from(
          new Set([...runtime.activeSession.session.usedMemoryIds, ...params.usedMemoryIds]),
        );
      }
      if (params.unresolvedQuestions) {
        runtime.activeSession.session.unresolvedQuestions = Array.from(
          new Set([...runtime.activeSession.session.unresolvedQuestions, ...params.unresolvedQuestions]),
        );
      }
      runtime.activeSession.session.stage = params.markComplete === true ? "complete" : "summary";

      const summaryPath = summaryDraftPathFor(runtime.activeSession.sessionDir);
      writeFileSync(summaryPath, params.summaryDraft.trim() + "\n", "utf-8");
      saveActiveState(ctx, runtime.activeSession);
      persistActiveSessionBinding(pi, runtime.activeSession);

      return {
        content: [
          {
            type: "text",
            text: [
              `Saved summary draft: ${summaryPath}`,
              `Stage: ${runtime.activeSession.session.stage}`,
              warnings.length > 0 ? `Warnings:\n${warnings.map((warning) => `- ${warning}`).join("\n")}` : "",
            ].filter(Boolean).join("\n"),
          },
        ],
        details: {
          ok: true,
          summaryPath,
          statePath: runtime.activeSession.statePath,
          stage: runtime.activeSession.session.stage,
          warnings,
        },
      };
      });
    },
  });
}
