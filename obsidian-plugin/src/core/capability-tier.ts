// Capability Tier decision (ADR 0005, issue #58; CONTEXT.md "Runtime
// Capability Tiers"). A Capability Tier is a per-round runtime determination
// of how much Memory Surface capability is available, decided from which
// dependencies are currently usable -- never an installation-time mode
// switch and never itself an error state.
//
// This module must stay free of `obsidian` imports, node imports, and
// module-level I/O: the caller performs the actual readiness pre-check (a
// cheap qmd probe, LLM profile resolution) and passes the resulting snapshot
// in. decideCapabilityTier only reflects what is configured/available going
// into a round; it never inspects call outcomes. A Full Tier round that
// loses LLM access mid-run is handled by Runtime Tier Fallback at the
// orchestration level (obsidian-plugin/src/tier-result.ts), not here.

export interface CapabilitySnapshot {
  /** True when the qmd CLI answered a lightweight readiness probe. */
  qmdAvailable: boolean;
  /** True when a usable LLM API key/config is resolved, not "did the last call succeed". */
  llmConfigured: boolean;
}

export type CapabilityTier = "neighborhood" | "recall" | "full";

const TIER_LABELS: Readonly<Record<CapabilityTier, string>> = {
  neighborhood: "Neighborhood Tier",
  recall: "Recall Tier",
  full: "Full Tier",
};

/**
 * Decides the Capability Tier from a dependency-availability snapshot taken
 * at round time. Truth table (the full qmd x llm 2x2 matrix):
 *
 *   qmdAvailable | llmConfigured | tier
 *   -------------|----------------|-------------
 *   false        | false          | neighborhood
 *   false        | true           | neighborhood (no retrieval backend; LLM alone cannot substitute for qmd)
 *   true         | false          | recall
 *   true         | true           | full
 *
 * No smaller result is disguised as a full one: the tier this function
 * returns is only what was REQUESTED going into the round from configured
 * availability, not proof of what a round actually produced. A caller (or a
 * user reading a result) learns what a round actually achieved from the
 * round's own result header (see formatTierHeader) -- Full Tier can still
 * land on Recall Tier results via Runtime Tier Fallback if the LLM fails
 * mid-round, and that outcome is named explicitly rather than reported as
 * this function's decided tier.
 */
export function decideCapabilityTier(snapshot: CapabilitySnapshot): CapabilityTier {
  if (!snapshot.qmdAvailable) return "neighborhood";
  if (!snapshot.llmConfigured) return "recall";
  return "full";
}

/** Human-readable label for a tier, with no fallback reason attached. */
export function tierLabel(tier: CapabilityTier): string {
  return TIER_LABELS[tier];
}

/**
 * The one-line result header naming the tier and, when present, the reason a
 * round did not simply run at its requested tier -- an unavailable
 * dependency ("Neighborhood Tier (qmd unavailable)", "Recall Tier (no LLM
 * configured)") or a Runtime Tier Fallback from Full Tier ("Recall Tier (Full
 * Tier fallback: Relation Judge failed - <reason>)"). Callers prefix this
 * onto a result's summary (and, for a genuine failure, onto error.message)
 * so Search Round History never shows a fake success.
 */
export function formatTierHeader(tier: CapabilityTier, reason?: string): string {
  const label = TIER_LABELS[tier];
  const trimmedReason = reason?.trim();
  return trimmedReason ? `${label} (${trimmedReason})` : label;
}
