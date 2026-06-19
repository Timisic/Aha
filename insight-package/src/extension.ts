import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ACTIVE_STATUS_KEY } from "./domain.ts";
import { Type } from "./runtime-paths.ts";
import { registerInsightCommands } from "./commands.ts";
import { registerInsightTools } from "./tools.ts";
import { buildStagePrompt } from "./prompts.ts";
import { restoreActiveSessionFromPiSession } from "./session.ts";
import { createInsightRuntime, insightStatusText, prepareAgentPrompt } from "./runtime.ts";
import { evaluateStageToolPolicy } from "./stage-policy.ts";
import { recordTrajectoryEvent, stableTrajectoryHash, summarizeTrajectoryValue, writeTrajectoryArtifact } from "./trajectory.ts";

export function registerInsightExtension(pi: ExtensionAPI): void {
  const runtime = createInsightRuntime();

  pi.on("session_start", (_event, ctx) => {
    runtime.activeSession = undefined;
    runtime.pendingAgentPrompt = undefined;

    const restored = restoreActiveSessionFromPiSession(ctx);
    if (!restored) {
      ctx.ui.setStatus(ACTIVE_STATUS_KEY, "");
      return;
    }

    runtime.activeSession = restored;
    ctx.ui.setStatus(ACTIVE_STATUS_KEY, insightStatusText(restored.session));
    recordTrajectoryEvent(restored, "session_restored", {
      source: "session_start",
      reason: (_event as { reason?: unknown }).reason,
      sessionDir: restored.sessionDir,
      statePath: restored.statePath,
    });
    prepareAgentPrompt(runtime, restored, buildStagePrompt(restored));
  });

  pi.on("context", (event) => {
    if (!runtime.pendingAgentPrompt) return undefined;

    const injection = runtime.pendingAgentPrompt;
    runtime.pendingAgentPrompt = undefined;
    const active = runtime.activeSession?.session.id === injection.sessionId
      ? runtime.activeSession
      : undefined;
    recordTrajectoryEvent(active, "context_seen", {
      compact: Boolean(injection.compact),
      beforeMessageCount: event.messages.length,
      pendingPromptHash: stableTrajectoryHash(injection.text),
    });
    const hiddenMessage = {
      role: "user" as const,
      content: [
        "<hidden-insight-session-context>",
        "This is hidden context prepared by the /insight extension. Do not mention that it was injected.",
        "",
        injection.text,
        "</hidden-insight-session-context>",
      ].join("\n"),
      timestamp: Date.now(),
    };

    const messages = injection.compact ? event.messages.slice(-1) : [...event.messages];
    const insertAt = Math.max(messages.length - 1, 0);
    messages.splice(insertAt, 0, hiddenMessage);
    const artifact = writeTrajectoryArtifact(active, "contexts", "context-injection", {
      compact: Boolean(injection.compact),
      insertAt,
      beforeMessages: event.messages,
      hiddenMessage,
      afterMessages: messages,
    });
    recordTrajectoryEvent(active, "context_built", {
      compact: Boolean(injection.compact),
      beforeMessageCount: event.messages.length,
      afterMessageCount: messages.length,
      insertAt,
      contextHash: stableTrajectoryHash(hiddenMessage.content),
      beforeMessages: summarizeTrajectoryValue(event.messages),
      hiddenMessage: summarizeTrajectoryValue(hiddenMessage),
      artifact,
    });
    return { messages };
  });

  pi.on("tool_call", (event) => {
    const policy = evaluateStageToolPolicy(event.toolName, event.input, runtime.activeSession);
    const inputArtifact = writeTrajectoryArtifact(
      runtime.activeSession,
      "tool-calls",
      `tool-call-${event.toolName}-input`,
      event.input,
    );
    recordTrajectoryEvent(
      runtime.activeSession,
      policy ? "tool_call_blocked" : "tool_call_requested",
      {
        toolName: event.toolName,
        toolCallId: (event as { toolCallId?: unknown }).toolCallId,
        activeStage: runtime.activeSession?.session.stage,
        input: summarizeTrajectoryValue(event.input),
        inputArtifact,
        blockReason: policy?.reason,
      },
    );
    return policy;
  });

  registerInsightCommands(pi, runtime);
  registerInsightTools(pi, runtime, Type);
}

export default registerInsightExtension;
