import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Type } from "typebox";
import { type InsightAppendGrillContextParams, type InsightSaveSummaryParams, type InsightSearchMemoryParams, type InsightUpdateStateParams, nowIso } from "./domain.ts";
import { memorySearchResultComponent } from "./memory.ts";
import { runInsightMemoryRetrieval } from "./memory-retrieval.ts";
import { missingSourceNoteSummaryHeadings, refreshSourceNoteFromObsidian } from "./source-note.ts";
import { appendMarkdownSection, localizedGrillHeading, summaryDraftPathFor } from "./session.ts";
import { buildReviewGrillPrompt, writeGrillBriefing } from "./prompts.ts";
import { persistActiveSessionBinding, prepareAgentPrompt, saveActiveState, type InsightRuntime } from "./runtime.ts";
import { evaluateInsightUpdatePolicy, shouldCreateReviewGrillBriefing } from "./stage-policy.ts";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { recordTrajectoryEvent, summarizeTrajectoryValue, writeTrajectoryArtifact } from "./trajectory.ts";

async function withToolTrajectory<T>(
  runtime: InsightRuntime,
  toolName: string,
  toolCallId: string,
  params: unknown,
  execute: () => Promise<T> | T,
): Promise<T> {
  const startedAt = Date.now();
  const activeAtStart = runtime.activeSession;
  const inputArtifact = writeTrajectoryArtifact(
    activeAtStart,
    "tool-calls",
    `tool-${toolCallId || toolName}-${toolName}-input`,
    params,
  );
  recordTrajectoryEvent(activeAtStart, "tool_started", {
    toolName,
    toolCallId,
    input: summarizeTrajectoryValue(params),
    inputArtifact,
  });

  try {
    const result = await execute();
    const activeAtFinish = runtime.activeSession ?? activeAtStart;
    const outputArtifact = writeTrajectoryArtifact(
      activeAtFinish,
      "tool-results",
      `tool-${toolCallId || toolName}-${toolName}-result`,
      result,
    );
    recordTrajectoryEvent(activeAtFinish, "tool_finished", {
      toolName,
      toolCallId,
      status: "ok",
      durationMs: Date.now() - startedAt,
      output: summarizeTrajectoryValue(result),
      outputArtifact,
      details: summarizeTrajectoryValue((result as { details?: unknown } | undefined)?.details),
    });
    return result;
  } catch (error) {
    recordTrajectoryEvent(runtime.activeSession ?? activeAtStart, "tool_finished", {
      toolName,
      toolCallId,
      status: "error",
      durationMs: Date.now() - startedAt,
      error: error instanceof Error
        ? { name: error.name, message: error.message, stack: error.stack }
        : String(error),
    });
    throw error;
  }
}

export function registerInsightTools(pi: ExtensionAPI, runtime: InsightRuntime, Type: Type): void {
  pi.registerTool({
    name: "insight_search_memory",
    label: "Insight Memory Search",
    description:
      "Run serialized QMD searches for the active /insight session, merge candidates, and update state.json.",
    executionMode: "sequential",
    renderResult(result) {
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
      signal,
      _onUpdate,
      ctx,
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
        }),
      ),
      summaryDraft: Type.Optional(Type.String()),
    }),
    async execute(toolCallId: string, params: InsightUpdateStateParams, _signal, _onUpdate, ctx) {
      return withToolTrajectory(runtime, "insight_update_state", toolCallId, params, () => {
      if (!runtime.activeSession) {
        return {
          content: [{ type: "text", text: "No active /insight session." }],
          details: { ok: false },
        };
      }

      const previousStage = runtime.activeSession.session.stage;
      const policy = evaluateInsightUpdatePolicy(params, previousStage);

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
      if (params.usedMemoryIds) {
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
        runtime.activeSession.session.candidateJudgments = [
          ...runtime.activeSession.session.candidateJudgments,
          {
            text: params.candidateJudgment.text,
            userStatus: params.candidateJudgment.userStatus ?? "pending",
          },
        ].slice(-3);
      }
      if (params.summaryDraft) {
        runtime.activeSession.session.summaryDraft = params.summaryDraft;
      }

      let grillBriefingPath: string | undefined;
      if (shouldCreateReviewGrillBriefing(previousStage, runtime.activeSession.session.stage)) {
        writeGrillBriefing(runtime.activeSession);
        grillBriefingPath = runtime.activeSession.grillBriefingPath;
        prepareAgentPrompt(runtime, runtime.activeSession, buildReviewGrillPrompt(runtime.activeSession), { compact: true });
      }

      saveActiveState(ctx, runtime.activeSession);
      persistActiveSessionBinding(pi, runtime.activeSession);

      return {
        content: [
          {
            type: "text",
            text: grillBriefingPath
              ? [
                  `Updated insight state: ${runtime.activeSession.session.stage}`,
                  `Created grill briefing: ${grillBriefingPath}`,
                  "The next user turn will use a compact Review-Grill context.",
                ].join("\n")
              : `Updated insight state: ${runtime.activeSession.session.stage}`,
          },
        ],
        details: {
          ok: true,
          statePath: runtime.activeSession.statePath,
          stage: runtime.activeSession.session.stage,
          grillBriefingPath,
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
    parameters: Type.Object({
      summaryDraft: Type.String(),
      usedMemoryIds: Type.Optional(Type.Array(Type.String())),
      unresolvedQuestions: Type.Optional(Type.Array(Type.String())),
      markComplete: Type.Optional(Type.Boolean()),
    }),
    async execute(toolCallId: string, params: InsightSaveSummaryParams, _signal, _onUpdate, ctx) {
      return withToolTrajectory(runtime, "insight_save_summary", toolCallId, params, () => {
      if (!runtime.activeSession) {
        return {
          content: [{ type: "text", text: "No active /insight session." }],
          details: { ok: false },
        };
      }

      refreshSourceNoteFromObsidian(runtime.activeSession.session, ctx.cwd);
      const missingHeadings = missingSourceNoteSummaryHeadings(params.summaryDraft, runtime.activeSession.session);
      if (missingHeadings.length > 0) {
        throw new Error(
          `Summary draft must preserve original Obsidian heading structure. Missing headings: ${missingHeadings.join(", ")}`,
        );
      }
      runtime.activeSession.session.summaryDraft = params.summaryDraft;
      if (params.usedMemoryIds) {
        runtime.activeSession.session.usedMemoryIds = Array.from(
          new Set([...runtime.activeSession.session.usedMemoryIds, ...params.usedMemoryIds]),
        );
      }
      if (params.unresolvedQuestions) {
        runtime.activeSession.session.unresolvedQuestions = Array.from(
          new Set([...runtime.activeSession.session.unresolvedQuestions, ...params.unresolvedQuestions]),
        );
      }
      runtime.activeSession.session.stage = params.markComplete === false ? "summary" : "complete";

      const summaryPath = summaryDraftPathFor(runtime.activeSession.sessionDir);
      writeFileSync(summaryPath, params.summaryDraft.trim() + "\n", "utf-8");
      saveActiveState(ctx, runtime.activeSession);
      persistActiveSessionBinding(pi, runtime.activeSession);

      return {
        content: [
          {
            type: "text",
            text: `Saved summary draft: ${summaryPath}\nStage: ${runtime.activeSession.session.stage}`,
          },
        ],
        details: {
          ok: true,
          summaryPath,
          statePath: runtime.activeSession.statePath,
          stage: runtime.activeSession.session.stage,
        },
      };
      });
    },
  });
}
