// Shapes a Full Tier orchestrator (core/orchestrator.ts) AhaResult into a
// tiered AhaWrapperResult, applying Runtime Tier Fallback (issue #58;
// CONTEXT.md "Runtime Tier Fallback"). This is the crux of the "Full Tier
// round with a failing LLM lands on Recall Tier results" acceptance
// criterion, split into its own pure, obsidian-import-free function so it is
// directly unit-testable against plain AhaResult fixtures without spinning
// up real qmd/LLM transports.
//
// The distinction that matters: runFullPipeline (frozen, #57) only returns
// ok:false in exactly two shapes --
//   1. qmd retrieval produced zero usable candidates (`candidates: []`) --
//      there is nothing to fall back to, so this stays a genuine failure.
//   2. Relation Judge failed after candidates were retrieved and pooled --
//      the deterministic (weak, pre-judge) candidates are still attached
//      (`candidates.length > 0`), so this lands on Recall Tier results with
//      the Relation Judge failure kept as a structured failure record.
// `candidates.length > 0` on a failure is therefore sufficient and exact to
// tell these two apart (verified against orchestrator.ts's own control
// flow), without needing to pattern-match on error.tool strings.

import { formatTierHeader, type AhaResult, type CapabilityTier } from "./core";
import type { AhaWrapperResult } from "./schema";

export interface TieredOutcome {
  /** The tier the round actually landed on -- not necessarily the tier that was requested. */
  tier: CapabilityTier;
  result: AhaWrapperResult;
}

function withHeader(header: string, body: string | null | undefined): string {
  const trimmed = (body ?? "").trim();
  return trimmed ? `${header}. ${trimmed}` : header;
}

export function shapeFullTierResult(fullResult: AhaResult): TieredOutcome {
  if (fullResult.ok) {
    return {
      tier: "full",
      result: {
        ok: true,
        sourcePath: fullResult.sourcePath,
        generatedAt: fullResult.generatedAt,
        summary: withHeader(formatTierHeader("full"), fullResult.summary),
        warnings: fullResult.warnings,
        candidates: fullResult.candidates as unknown as AhaWrapperResult["candidates"],
      },
    };
  }

  if (fullResult.candidates.length > 0) {
    // Runtime Tier Fallback: Relation Judge failed mid-round, but the
    // deterministic recall-tier candidates survived. Land on Recall Tier
    // results honestly (ok:true, relation stays "weak" on every candidate --
    // no judging happened) with the Relation Judge failure kept as a
    // structured failure record in `error`. Never a fake Full Tier success.
    const reasonDetail = fullResult.error.details?.trim() || fullResult.error.message;
    const reason = `Full Tier fallback: Relation Judge failed - ${reasonDetail}`;
    return {
      tier: "recall",
      result: {
        ok: true,
        sourcePath: fullResult.sourcePath,
        generatedAt: fullResult.generatedAt,
        summary: withHeader(formatTierHeader("recall", reason), fullResult.summary),
        warnings: fullResult.warnings,
        error: fullResult.error,
        candidates: fullResult.candidates as unknown as AhaWrapperResult["candidates"],
      },
    };
  }

  // Genuine Full Tier failure: retrieval itself produced nothing to fall
  // back to. The tier header goes into error.message (not just summary)
  // because recordFailedSessionRound only threads error.message/tool/details
  // through into Search Round History, not the top-level summary/warnings.
  const header = formatTierHeader("full");
  return {
    tier: "full",
    result: {
      ok: false,
      sourcePath: fullResult.sourcePath,
      generatedAt: fullResult.generatedAt,
      summary: withHeader(header, fullResult.summary),
      warnings: fullResult.warnings,
      error: {
        message: withHeader(header, fullResult.error.message),
        tool: fullResult.error.tool,
        details: fullResult.error.details,
      },
      candidates: fullResult.candidates as unknown as AhaWrapperResult["candidates"],
    },
  };
}
