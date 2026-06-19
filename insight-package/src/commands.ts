import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { buildAgentPrompt, buildStagePrompt } from "./prompts.ts";
import { createSession, listSessionSummary, loadSession } from "./session.ts";
import { clearInsightMode, persistActiveSessionBinding, persistInactiveSessionBinding, prepareAgentPrompt, setActiveSession, type InsightRuntime } from "./runtime.ts";
import { normalizeInsightArgs } from "./domain.ts";
import { recordTrajectorySessionCancelled, recordTrajectorySessionRestored, recordTrajectorySessionStarted } from "./trajectory.ts";

export function registerInsightCommands(pi: ExtensionAPI, runtime: InsightRuntime): void {
  pi.registerCommand("insight", {
    description: "Start, list, or resume Insight-to-Judgment sessions",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const pasted = normalizeInsightArgs(args);
      const [subcommand, ...rest] = pasted.split(/\s+/);

      if (subcommand === "list") {
        ctx.ui.setEditorText(listSessionSummary(ctx.cwd));
        return;
      }

      if (subcommand === "resume") {
        const selector = rest.join(" ").trim();
        if (!selector) {
          ctx.ui.notify("Usage: /insight resume <session-id-or-directory>", "warning");
          ctx.ui.setEditorText(listSessionSummary(ctx.cwd));
          return;
        }

        const resumed = loadSession(ctx.cwd, selector);
        if (!resumed) {
          ctx.ui.notify(`No insight session matched: ${selector}`, "warning");
          ctx.ui.setEditorText(listSessionSummary(ctx.cwd));
          return;
        }

        setActiveSession(runtime, ctx, resumed);
        persistActiveSessionBinding(pi, resumed);
        recordTrajectorySessionRestored(resumed, {
          source: "insight_resume_command",
          sessionDir: resumed.sessionDir,
          statePath: resumed.statePath,
        });
        ctx.ui.notify(`Resumed insight session: ${resumed.session.id}`, "info");
        prepareAgentPrompt(runtime, resumed, buildStagePrompt(resumed));
        return;
      }

      if (subcommand === "current") {
        ctx.ui.setEditorText(
          runtime.activeSession
            ? `Active insight session: ${runtime.activeSession.session.id}\n\n${runtime.activeSession.sessionDir}\n\nStage: ${runtime.activeSession.session.stage}`
            : "No active insight session.",
        );
        return;
      }

      if (!pasted && (runtime.activeSession || runtime.pendingAgentPrompt)) {
        const id = runtime.activeSession?.session.id ?? runtime.pendingAgentPrompt?.sessionId;
        recordTrajectorySessionCancelled(runtime.activeSession, {
          source: "blank_insight_command",
          pendingPromptSessionId: runtime.pendingAgentPrompt?.sessionId,
        });
        clearInsightMode(runtime, ctx);
        persistInactiveSessionBinding(pi);
        ctx.ui.notify(`Insight mode cancelled${id ? `: ${id}` : ""}`, "info");
        return;
      }

      const input =
        pasted ||
        (ctx.hasUI
          ? await ctx.ui.editor(
              "New /insight session: paste raw insight, context, and optional source note",
              "",
            )
          : undefined);

      if (!input?.trim()) {
        ctx.ui.notify("Insight session cancelled: no input provided.", "warning");
        return;
      }

      const created = createSession(ctx.cwd, input);
      setActiveSession(runtime, ctx, created);
      persistActiveSessionBinding(pi, created);
      recordTrajectorySessionStarted(created, {
        source: "insight_command",
        sessionDir: created.sessionDir,
        statePath: created.statePath,
        originCwd: ctx.cwd,
      });
      prepareAgentPrompt(runtime, created, buildAgentPrompt(created));
      ctx.ui.notify(`Insight session created: ${created.session.id}`, "info");
      pi.sendUserMessage(input, { deliverAs: "followUp" });
    },
  });

}
