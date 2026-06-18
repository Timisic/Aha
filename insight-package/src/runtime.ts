import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { ACTIVE_STATUS_KEY, SESSION_BINDING_CUSTOM_TYPE, type ActiveSession, type InsightSessionBinding, nowIso } from "./domain.ts";
import { bindingFor, writeIndex, writeState } from "./session.ts";
import { stageLabel as policyStageLabel } from "./stage-policy.ts";

export { stageLabel } from "./stage-policy.ts";

export interface PendingAgentPrompt {
  sessionId: string;
  text: string;
  compact?: boolean;
}

export interface InsightRuntime {
  activeSession?: ActiveSession;
  pendingAgentPrompt?: PendingAgentPrompt;
}

export function createInsightRuntime(): InsightRuntime {
  return {};
}

export function insightStatusText(session: ActiveSession["session"]): string {
  return `insight ${session.id} · ${policyStageLabel(session.stage)}`;
}

export function setActiveSession(runtime: InsightRuntime, ctx: ExtensionCommandContext, session: ActiveSession): void {
  runtime.activeSession = session;
  ctx.ui.setStatus(ACTIVE_STATUS_KEY, insightStatusText(session.session));
}

export function clearInsightMode(runtime: InsightRuntime, ctx: ExtensionCommandContext): void {
  runtime.activeSession = undefined;
  runtime.pendingAgentPrompt = undefined;
  ctx.ui.setStatus(ACTIVE_STATUS_KEY, "");
}

export function prepareAgentPrompt(runtime: InsightRuntime, active: ActiveSession, text: string, options: { compact?: boolean } = {}): void {
  runtime.pendingAgentPrompt = { sessionId: active.session.id, text, compact: options.compact };
}

export function saveActiveState(ctx: { cwd: string; ui?: ExtensionCommandContext["ui"] }, session: ActiveSession): void {
  writeState(session.statePath, session.session);
  writeIndex(ctx.cwd, session.sessionDir, session.session);
  ctx.ui?.setStatus(ACTIVE_STATUS_KEY, insightStatusText(session.session));
}

export function persistActiveSessionBinding(pi: ExtensionAPI, active: ActiveSession): void {
  pi.appendEntry<InsightSessionBinding>(SESSION_BINDING_CUSTOM_TYPE, bindingFor(active));
}

export function persistInactiveSessionBinding(pi: ExtensionAPI): void {
  pi.appendEntry<InsightSessionBinding>(SESSION_BINDING_CUSTOM_TYPE, { active: false, updatedAt: nowIso() });
}
