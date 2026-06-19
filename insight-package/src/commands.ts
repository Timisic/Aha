import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { buildAgentPrompt, buildStagePrompt } from "./prompts.ts";
import { createSession } from "./session.ts";
import { clearInsightMode, persistActiveSessionBinding, persistInactiveSessionBinding, prepareAgentPrompt, saveActiveState, setActiveSession, type InsightRuntime } from "./runtime.ts";
import { normalizeInsightArgs, nowIso, textHash, type MemoryReviewStatus, type Stage, STAGES } from "./domain.ts";
import { recordTrajectorySessionCancelled, recordTrajectorySessionRestored, recordTrajectorySessionStarted } from "./trajectory.ts";
import { formatCandidateInspection, formatCandidateOpen, formatCandidatePath, parseBatchReviewArgs, resolveCandidateSelector } from "./candidate-selection.ts";
import { deleteSession, formatSessionResolutionError, inspectSession, listSessions, renameSession, resolveSession, setSessionArchived, type SessionListFilters, type SessionResolution } from "./session-lifecycle.ts";
import { formatSummaryInspection } from "./summary-artifacts.ts";
import { insightCommandHelp } from "./user-facing.ts";
import { formatDoctorTable, runInsightDoctor } from "./doctor.ts";

function parseTokens(input: string): string[] {
  return input.match(/"[^"]*"|'[^']*'|\S+/g)?.map((token) => token.replace(/^(["'])(.*)\1$/, "$2")) ?? [];
}

function readOption(tokens: string[], name: string): string | undefined {
  const index = tokens.indexOf(name);
  return index >= 0 ? tokens[index + 1] : undefined;
}

function listFilters(tokens: string[]): SessionListFilters {
  const stage = readOption(tokens, "--stage");
  return {
    stage: stage && STAGES.has(stage as Stage) ? stage as Stage : undefined,
    date: readOption(tokens, "--date"),
    title: readOption(tokens, "--title"),
    archived: tokens.includes("--archived") ? true : undefined,
    includeArchived: tokens.includes("--all"),
  };
}

function loadCommandSession(ctx: ExtensionCommandContext, selector: string | undefined, runtime: InsightRuntime): SessionResolution {
  if (!selector && runtime.activeSession) return { ok: true, active: runtime.activeSession };
  return resolveSession(ctx.cwd, selector ?? "");
}

function showResolutionError(ctx: ExtensionCommandContext, result: Exclude<SessionResolution, { ok: true }>): void {
  ctx.ui.notify(result.reason === "ambiguous" ? "Ambiguous insight session selector." : result.message, "warning");
  ctx.ui.setEditorText(formatSessionResolutionError(result));
}

function parseCandidateTableVersion(tokens: string[]): string | undefined {
  return readOption(tokens, "--table");
}

function selectorWithoutOptions(tokens: string[]): string | undefined {
  return tokens.find((token, index) => !token.startsWith("--") && tokens[index - 1] !== "--confirm" && tokens[index - 1] !== "--table");
}

async function handleInsightSubcommand(
  pi: ExtensionAPI,
  runtime: InsightRuntime,
  ctx: ExtensionCommandContext,
  subcommand: string,
  rest: string[],
): Promise<boolean> {
  if (subcommand === "help" || subcommand === "--help") {
    ctx.ui.setEditorText(insightCommandHelp());
    return true;
  }

  if (subcommand === "doctor") {
    const report = await runInsightDoctor(pi, runtime, ctx);
    ctx.ui.setEditorText(rest.includes("--json") ? JSON.stringify(report, null, 2) : formatDoctorTable(report));
    ctx.ui.notify(`Aha doctor ${report.ok ? "passed" : "found required failures"}.`, report.ok ? "info" : "warning");
    return true;
  }

  if (subcommand === "list") {
    ctx.ui.setEditorText(listSessions(ctx.cwd, listFilters(rest)));
    return true;
  }

  if (subcommand === "search") {
    ctx.ui.setEditorText(listSessions(ctx.cwd, { title: rest.join(" ").trim(), includeArchived: true }));
    return true;
  }

  if (subcommand === "resume") {
    const selector = rest.join(" ").trim();
    if (!selector) {
      ctx.ui.notify("Usage: /insight resume <session-id-or-directory>", "warning");
      ctx.ui.setEditorText(listSessions(ctx.cwd));
      return true;
    }
    const resumed = resolveSession(ctx.cwd, selector);
    if (!resumed.ok) {
      showResolutionError(ctx, resumed);
      return true;
    }
    setActiveSession(runtime, ctx, resumed.active);
    persistActiveSessionBinding(pi, resumed.active);
    recordTrajectorySessionRestored(resumed.active, {
      source: "insight_resume_command",
      sessionDir: resumed.active.sessionDir,
      statePath: resumed.active.statePath,
    });
    ctx.ui.notify(`Resumed insight session: ${resumed.active.session.id}`, "info");
    prepareAgentPrompt(runtime, resumed.active, buildStagePrompt(resumed.active));
    return true;
  }

  if (subcommand === "current") {
    ctx.ui.setEditorText(
      runtime.activeSession
        ? [`Active insight session: ${runtime.activeSession.session.id}`, "", inspectSession(runtime.activeSession)].join("\n")
        : "No active insight session.",
    );
    return true;
  }

  if (subcommand === "rename") {
    const [selector, ...titleParts] = rest;
    const resolved = loadCommandSession(ctx, selector, runtime);
    if (!resolved.ok) { showResolutionError(ctx, resolved); return true; }
    const title = titleParts.join(" ").trim();
    if (!title) {
      ctx.ui.notify("Usage: /insight rename <session> <new title>", "warning");
      return true;
    }
    renameSession(ctx.cwd, resolved.active, title);
    if (runtime.activeSession?.session.id === resolved.active.session.id) setActiveSession(runtime, ctx, resolved.active);
    ctx.ui.notify(`Renamed insight session: ${resolved.active.session.id}`, "info");
    ctx.ui.setEditorText(inspectSession(resolved.active));
    return true;
  }

  if (subcommand === "archive" || subcommand === "unarchive") {
    const resolved = loadCommandSession(ctx, rest.join(" ").trim(), runtime);
    if (!resolved.ok) { showResolutionError(ctx, resolved); return true; }
    setSessionArchived(ctx.cwd, resolved.active, subcommand === "archive");
    if (runtime.activeSession?.session.id === resolved.active.session.id) setActiveSession(runtime, ctx, resolved.active);
    ctx.ui.notify(`${subcommand === "archive" ? "Archived" : "Unarchived"} insight session: ${resolved.active.session.id}`, "info");
    ctx.ui.setEditorText(inspectSession(resolved.active));
    return true;
  }

  if (subcommand === "inspect") {
    const resolved = loadCommandSession(ctx, rest.join(" ").trim() || undefined, runtime);
    if (!resolved.ok) { showResolutionError(ctx, resolved); return true; }
    ctx.ui.setEditorText(inspectSession(resolved.active));
    return true;
  }

  if (subcommand === "delete") {
    const selector = selectorWithoutOptions(rest);
    const confirmation = readOption(rest, "--confirm");
    const resolved = loadCommandSession(ctx, selector, runtime);
    if (!resolved.ok) { showResolutionError(ctx, resolved); return true; }
    try {
      const text = deleteSession(ctx.cwd, resolved.active, confirmation ?? "");
      if (runtime.activeSession?.session.id === resolved.active.session.id) {
        clearInsightMode(runtime, ctx);
        persistInactiveSessionBinding(pi);
      }
      ctx.ui.notify(`Deleted insight session: ${resolved.active.session.id}`, "info");
      ctx.ui.setEditorText(text);
    } catch (error) {
      ctx.ui.notify(String((error as Error).message ?? error), "warning");
    }
    return true;
  }

  if (subcommand === "summary") {
    const action = rest[0] ?? "inspect";
    const selector = rest.slice(1).filter((token) => token !== "--content").join(" ").trim() || undefined;
    const resolved = loadCommandSession(ctx, selector, runtime);
    if (!resolved.ok) { showResolutionError(ctx, resolved); return true; }
    const summaryText = formatSummaryInspection(resolved.active, rest.includes("--content"));
    if (action === "path") {
      ctx.ui.setEditorText(summaryText.split("\n").find((line) => line.startsWith("Path: ")) ?? summaryText);
      return true;
    }
    ctx.ui.setEditorText(summaryText);
    return true;
  }

  if (subcommand === "candidate") {
    if (!runtime.activeSession) {
      ctx.ui.notify("No active /insight session.", "warning");
      return true;
    }
    const action = rest[0] ?? "inspect";
    const tableVersion = parseCandidateTableVersion(rest);
    if (action === "review") {
      const reviews = parseBatchReviewArgs(rest.slice(1));
      if (reviews.length === 0) {
        ctx.ui.notify("Usage: /insight candidate review accepted 1,3 rejected 2 uncertain 4 [--table <version>]", "warning");
        return true;
      }
      for (const review of reviews) {
        const resolved = resolveCandidateSelector(runtime.activeSession, review.selector, tableVersion);
        const userText = `${review.status} ${review.selector}`;
        runtime.activeSession.session.memoryReviews = [
          ...runtime.activeSession.session.memoryReviews.filter((item) => item.candidateId !== resolved.candidate.id),
          {
            candidateId: resolved.candidate.id,
            status: review.status as MemoryReviewStatus,
            rationale: "Recorded through /insight candidate review.",
            reviewedAt: nowIso(),
            userTurnRef: `command:/insight candidate review:${resolved.tableVersion}`,
            userTextHash: textHash(userText),
          },
        ];
      }
      saveActiveState(ctx, runtime.activeSession);
      persistActiveSessionBinding(pi, runtime.activeSession);
      ctx.ui.notify(`Recorded ${reviews.length} candidate review(s).`, "info");
      ctx.ui.setEditorText(`Recorded ${reviews.length} candidate review(s).`);
      return true;
    }
    const selector = rest[1];
    if (!selector) {
      ctx.ui.notify("Usage: /insight candidate inspect <number-or-id> [--table <version>]", "warning");
      return true;
    }
    try {
      const resolved = resolveCandidateSelector(runtime.activeSession, selector, tableVersion);
      ctx.ui.setEditorText(
        action === "open" ? formatCandidateOpen(runtime.activeSession, resolved)
          : action === "path" ? formatCandidatePath(runtime.activeSession, resolved)
            : formatCandidateInspection(runtime.activeSession, resolved),
      );
    } catch (error) {
      ctx.ui.notify(String((error as Error).message ?? error), "warning");
      ctx.ui.setEditorText(String((error as Error).message ?? error));
    }
    return true;
  }

  return false;
}

export function registerInsightCommands(pi: ExtensionAPI, runtime: InsightRuntime): void {
  pi.registerCommand("insight", {
    description: "Start, inspect, review, list, or resume Insight-to-Judgment sessions",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const pasted = normalizeInsightArgs(args);
      const tokens = parseTokens(pasted);
      const [subcommand, ...rest] = tokens;

      if (subcommand && await handleInsightSubcommand(pi, runtime, ctx, subcommand, rest)) return;

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
