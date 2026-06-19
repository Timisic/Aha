import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { Type } from "typebox";
import { type InsightAppendGrillContextParams, type MemoryCandidate, type InsightConfirmNoRelevantMemoryParams, type InsightConfirmReadinessParams, type InsightSaveSummaryParams, type InsightSearchMemoryParams, type InsightUpdateStateParams, nowIso, textHash } from "./domain.ts";
import { memorySearchResultComponent } from "./memory.ts";
import { runInsightMemoryRetrieval } from "./memory-retrieval.ts";
import { missingSourceNoteSummaryHeadings, refreshSourceNoteFromObsidian, sourceNoteSummaryWarnings } from "./source-note.ts";
import { appendMarkdownSection, localizedGrillHeading, summaryDraftPathFor, writeTextAtomic } from "./session.ts";
import { buildReviewGrillPrompt, writeStageBriefing } from "./prompts.ts";
import { persistActiveSessionBinding, prepareAgentPrompt, saveActiveState, type InsightRuntime } from "./runtime.ts";
import { assertCanConfirmReadiness, assertCanSaveSummary, evaluateInsightUpdatePolicy, shouldCreateReviewGrillBriefing } from "./stage-policy.ts";
import { existsSync, readFileSync } from "node:fs";
import { recordTrajectoryToolFinished, recordTrajectoryToolStarted } from "./trajectory.ts";
import { actionIdFor, verifyUserDecision } from "./user-decision.ts";

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

function hasCandidateIdentity(candidate: MemoryCandidate, candidateId: string): boolean {
  return [candidate.id, candidate.slug, candidate.canonicalId, candidate.canonicalPath].filter(Boolean).includes(candidateId);
}

function findKnownMemoryCandidate(active: NonNullable<InsightRuntime["activeSession"]>, candidateId: string) {
  const matches = (candidate: {
    id?: string;
    candidateId?: string;
    canonicalId?: string;
    canonicalPath?: string;
    slug?: string;
    canonicalIdentity?: string;
  }) => [
    candidate.id,
    candidate.candidateId,
    candidate.canonicalId,
    candidate.canonicalPath,
    candidate.slug,
    candidate.canonicalIdentity,
  ].filter(Boolean).includes(candidateId);
  return active.session.memoryCandidates.find(matches) ??
    active.session.memoryCandidatePool.find(matches) ??
    active.session.reviewedMemoryEvidence.find(matches);
}

function assertKnownMemoryCandidate(active: NonNullable<InsightRuntime["activeSession"]>, candidateId: string): void {
  if (!findKnownMemoryCandidate(active, candidateId)) {
    throw new Error(`Unknown memory candidate id: ${candidateId}`);
  }
}

function recordMemoryReviews(
  active: NonNullable<InsightRuntime["activeSession"]>,
  reviews: NonNullable<InsightUpdateStateParams["memoryReviews"]>,
  toolCallId: string,
  ctx: ExtensionCommandContext,
): void {
  for (const review of reviews) {
    const candidate = findKnownMemoryCandidate(active, review.candidateId);
    if (!candidate) throw new Error(`Unknown memory candidate id: ${review.candidateId}`);
    const userText = review.userText;
    if (!userText) {
      throw new Error(`Cannot record memoryReview for ${review.candidateId}; userText is required.`);
    }
    const decisionKey = `${review.candidateId}:${review.status}`;
    const provenance = verifyUserDecision(ctx, active.session, {
      userText,
      userTurnRef: review.userTurnRef,
      decisionKind: "memory_review",
      decisionKey,
    });
    const actionId = actionIdFor("insight_update_state", toolCallId, provenance.userTurnRef, decisionKey);
    if (active.session.appliedActionIds.includes(actionId)) continue;
    active.session.memoryReviews = [
      ...active.session.memoryReviews.filter((item) => item.candidateId !== review.candidateId),
      {
        candidateId: review.candidateId,
        status: review.status,
        rationale: review.rationale,
        reviewedAt: nowIso(),
        userTurnRef: provenance.userTurnRef,
        userTextHash: provenance.userTextHash,
        actionId,
      },
    ];
    active.session.reviewedMemoryEvidence = [
      ...active.session.reviewedMemoryEvidence.filter((item) => item.candidateId !== review.candidateId),
      {
        ...provenance,
        actionId,
        candidateId: review.candidateId,
        title: candidate.title,
        slug: candidate.slug,
        canonicalIdentity: candidate.slug ?? ("id" in candidate ? candidate.id : candidate.candidateId),
        relation: candidate.relation,
        reason: candidate.reason,
        whyReadFirst: candidate.whyReadFirst,
        status: review.status,
        rationale: review.rationale,
        reviewedAt: nowIso(),
      },
    ];
    active.session.appliedActionIds.push(actionId);
  }
}

function assertReviewedMemoryUse(
  active: NonNullable<InsightRuntime["activeSession"]>,
  usedMemoryIds: string[],
): void {
  const accepted = new Set(
    active.session.reviewedMemoryEvidence
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

function hasConfirmedFinalJudgment(active: NonNullable<InsightRuntime["activeSession"]>): boolean {
  return active.session.candidateJudgments.some((judgment) =>
    (judgment.userStatus === "accepted" || judgment.userStatus === "revised") &&
    Boolean(judgment.userTurnRef) &&
    Boolean(judgment.userTextHash) &&
    Boolean(judgment.confirmedAt)
  );
}

function assertCanMarkComplete(active: NonNullable<InsightRuntime["activeSession"]>, usedMemoryIds: string[] | undefined): void {
  if (!active.session.summaryReadiness?.userTurnRef || !active.session.summaryReadiness.userTextHash) {
    throw new Error("Cannot complete insight session without verified summary readiness provenance.");
  }
  if (!hasConfirmedFinalJudgment(active)) {
    throw new Error("Cannot complete insight session without a verified user-confirmed final judgment.");
  }
  const hasAcceptedEvidence = active.session.reviewedMemoryEvidence.some((evidence) => evidence.status === "accepted");
  if (!hasAcceptedEvidence && !active.session.noRelevantMemory) {
    throw new Error("Cannot complete insight session without accepted reviewed evidence or explicit no_relevant_memory confirmation.");
  }
  if (usedMemoryIds) {
    assertReviewedMemoryUse(active, usedMemoryIds);
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
          userText: Type.String(),
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
            userText: Type.String(),
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
        recordMemoryReviews(runtime.activeSession, memoryReviews, toolCallId, ctx);
      }
      if (params.usedMemoryIds) {
        assertReviewedMemoryUse(runtime.activeSession, params.usedMemoryIds);
        runtime.activeSession.session.usedMemoryIds = Array.from(
          new Set([...runtime.activeSession.session.usedMemoryIds, ...params.usedMemoryIds]),
        );
      }
      if (params.newInsight) {
        const actionId = actionIdFor("insight_update_state", toolCallId, undefined, `newInsight:${textHash(params.newInsight.text)}`);
        if (!runtime.activeSession.session.appliedActionIds.includes(actionId)) {
        runtime.activeSession.session.newInsights.push({
          actionId,
          text: params.newInsight.text,
          openedDirection: params.newInsight.openedDirection ?? true,
          triggeredMemorySearch: params.newInsight.triggeredMemorySearch ?? false,
        });
        runtime.activeSession.session.appliedActionIds.push(actionId);
        }
      }
      if (params.grillTurn) {
        const actionId = actionIdFor("insight_update_state", toolCallId, undefined, `grillTurn:${textHash(params.grillTurn.question)}`);
        if (!runtime.activeSession.session.appliedActionIds.includes(actionId)) {
        runtime.activeSession.session.grillTurns.push({
          actionId,
          question: params.grillTurn.question,
          answer: params.grillTurn.answer,
          resultingInsight: params.grillTurn.resultingInsight,
          createdAt: nowIso(),
        });
        runtime.activeSession.session.appliedActionIds.push(actionId);
        }
      }
      if (params.candidateJudgment) {
        if (params.candidateJudgment.evidenceMemoryIds) {
          assertReviewedMemoryUse(runtime.activeSession, params.candidateJudgment.evidenceMemoryIds);
        }
        const provenance = params.candidateJudgment.userText
          ? verifyUserDecision(ctx, runtime.activeSession.session, {
              userText: params.candidateJudgment.userText,
              userTurnRef: params.candidateJudgment.userTurnRef,
              decisionKind: "candidate_judgment",
              decisionKey: `${params.candidateJudgment.text}:${params.candidateJudgment.userStatus ?? "pending"}`,
            })
          : undefined;
        const actionId = actionIdFor(
          "insight_update_state",
          toolCallId,
          provenance?.userTurnRef,
          `candidateJudgment:${textHash(params.candidateJudgment.text)}:${params.candidateJudgment.userStatus ?? "pending"}`,
        );
        if (!runtime.activeSession.session.appliedActionIds.includes(actionId)) {
        runtime.activeSession.session.candidateJudgments = [
          ...runtime.activeSession.session.candidateJudgments,
          {
            id: actionId,
            actionId,
            text: params.candidateJudgment.text,
            status: params.candidateJudgment.userStatus ?? "pending",
            userStatus: params.candidateJudgment.userStatus ?? "pending",
            evidenceMemoryIds: params.candidateJudgment.evidenceMemoryIds ?? [],
            proposedAt: nowIso(),
            userTurnRef: provenance?.userTurnRef ?? params.candidateJudgment.userTurnRef,
            userTextHash: provenance?.userTextHash,
            confirmedAt: params.candidateJudgment.userStatus === "accepted" || params.candidateJudgment.userStatus === "revised"
              ? nowIso()
              : undefined,
            replacesId: params.candidateJudgment.replacesId,
          },
        ].slice(-3);
        runtime.activeSession.session.appliedActionIds.push(actionId);
        }
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
      const provenance = verifyUserDecision(ctx, runtime.activeSession.session, {
        userText: params.userText,
        userTurnRef: params.userTurnRef,
        decisionKind: "summary_readiness",
        decisionKey: "confirmed",
      });
      const actionId = actionIdFor("insight_confirm_readiness", toolCallId, provenance.userTurnRef, "confirmed");
      if (runtime.activeSession.session.appliedActionIds.includes(actionId) && runtime.activeSession.session.stage === "summary") {
        return {
          content: [{ type: "text", text: `Summary readiness already confirmed.\nStage: ${runtime.activeSession.session.stage}` }],
          details: {
            ok: true,
            noOp: true,
            statePath: runtime.activeSession.statePath,
            stage: runtime.activeSession.session.stage,
          },
        };
      }
      runtime.activeSession.session.summaryReadiness = {
        actionId,
        confirmedAt: nowIso(),
        userText: params.userText,
        userTurnRef: provenance.userTurnRef,
        userTextHash: provenance.userTextHash,
        verifiedAt: provenance.verifiedAt,
      };
      runtime.activeSession.session.appliedActionIds.push(actionId);
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
    name: "insight_confirm_no_relevant_memory",
    label: "Insight No Relevant Memory",
    description:
      "Record explicit user confirmation that a successful empty memory search has no relevant prior memory; this permits memory_review to enter review_grill without candidate evidence.",
    executionMode: "sequential",
    parameters: Type.Object({
      userText: Type.String(),
      userTurnRef: Type.Optional(Type.String()),
    }),
    async execute(toolCallId: string, params: InsightConfirmNoRelevantMemoryParams, _signal: unknown, _onUpdate: unknown, ctx: ExtensionCommandContext) {
      return withToolTrajectory(runtime, "insight_confirm_no_relevant_memory", toolCallId, params, () => {
      if (!runtime.activeSession) {
        return {
          content: [{ type: "text", text: "No active /insight session." }],
          details: { ok: false },
        };
      }
      if (runtime.activeSession.session.stage !== "memory_review") {
        throw new Error(`Cannot confirm no_relevant_memory while stage is ${runtime.activeSession.session.stage}.`);
      }
      if (runtime.activeSession.session.memorySearchOutcome !== "no_candidates") {
        throw new Error("Cannot confirm no_relevant_memory unless the latest memory search completed successfully with no candidates.");
      }
      const provenance = verifyUserDecision(ctx, runtime.activeSession.session, {
        userText: params.userText,
        userTurnRef: params.userTurnRef,
        decisionKind: "no_relevant_memory",
        decisionKey: "confirmed",
      });
      const actionId = actionIdFor("insight_confirm_no_relevant_memory", toolCallId, provenance.userTurnRef, "confirmed");
      if (!runtime.activeSession.session.appliedActionIds.includes(actionId)) {
        runtime.activeSession.session.noRelevantMemory = {
          ...provenance,
          actionId,
          confirmedAt: nowIso(),
        };
        runtime.activeSession.session.appliedActionIds.push(actionId);
        saveActiveState(ctx, runtime.activeSession);
        persistActiveSessionBinding(pi, runtime.activeSession);
      }

      return {
        content: [
          {
            type: "text",
            text: "Confirmed no_relevant_memory. The session may now enter review_grill.",
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
      writeTextAtomic(
        runtime.activeSession.grillContextPath,
        appendMarkdownSection(existing, heading, params.body),
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
      if (params.markComplete === true) {
        assertCanMarkComplete(runtime.activeSession, params.usedMemoryIds);
      }
      runtime.activeSession.session.stage = params.markComplete === true ? "complete" : "summary";

      const summaryPath = summaryDraftPathFor(runtime.activeSession.sessionDir);
      writeTextAtomic(summaryPath, params.summaryDraft.trim() + "\n");
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
