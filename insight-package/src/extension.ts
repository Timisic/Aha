import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ACTIVE_STATUS_KEY } from "./domain.ts";
import { Type } from "./runtime-paths.ts";
import { registerInsightCommands } from "./commands.ts";
import { registerInsightTools } from "./tools.ts";
import { buildStagePrompt } from "./prompts.ts";
import { restoreActiveSessionFromPiSession } from "./session.ts";
import { createInsightRuntime, insightStatusText, prepareAgentPrompt } from "./runtime.ts";
import { evaluateStageToolPolicy } from "./stage-policy.ts";

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
    prepareAgentPrompt(runtime, restored, buildStagePrompt(restored));
  });

  pi.on("context", (event) => {
    if (!runtime.pendingAgentPrompt) return undefined;

    const injection = runtime.pendingAgentPrompt;
    runtime.pendingAgentPrompt = undefined;
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
    return { messages };
  });

  pi.on("tool_call", (event) => {
    return evaluateStageToolPolicy(event.toolName, event.input, runtime.activeSession);
  });

  registerInsightCommands(pi, runtime);
  registerInsightTools(pi, runtime, Type);
}

export default registerInsightExtension;
