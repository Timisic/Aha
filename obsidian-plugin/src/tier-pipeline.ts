// Capability Tier orchestration entry point (issue #58). Wires the readiness
// pre-check, decideCapabilityTier, and the three tiers (Neighborhood/Recall/
// Full, with Full's Runtime Tier Fallback) into one call main.ts's
// searchFromCurrentNote can use in place of the legacy runAhaWrapper.
//
// The readiness pre-check re-probes qmd and re-resolves the LLM profile
// fresh on every call (no caching anywhere in this module or its deps), so
// an environment repair (installing qmd, fixing an API key) upgrades the
// tier on the very next round without restarting Obsidian.

import {
  DEFAULT_LLM_TIMEOUT_MS,
  decideCapabilityTier,
  runFullPipeline,
  type CandidateFilterArgs,
  type DeterministicPlanArgs,
  type OrchestratorDeps,
} from "./core";
import { resolveLlmRequestProfile, requestUrlHttpPost } from "./llm-request";
import { buildNeighborhoodTierResult, type NeighborhoodMetadataCacheLike, type NeighborhoodSourceLike } from "./neighborhood-tier";
import { createQmdRequestDeps, probeQmdAvailable } from "./qmd-request";
import { runRecallTier } from "./recall-tier";
import type { AhaPluginSettings } from "./settings";
import { shapeFullTierResult, type TieredOutcome } from "./tier-result";
import { createVaultBoundaryDeps } from "./vault-boundary";

export type { TieredOutcome } from "./tier-result";

export interface TieredSearchInput {
  settings: AhaPluginSettings;
  sourceFile: NeighborhoodSourceLike;
  /** Raw markdown of the source note, already read by the caller (main.ts's vault.cachedRead). */
  sourceText: string;
  sourceAbsolutePath: string;
  vaultRoot: string;
  reviewPath: string;
  metadataCache: NeighborhoodMetadataCacheLike;
  /** OrchestratorDeps.readNote -- Obsidian Vault API backed (see vault-read.ts), injected by main.ts. */
  readNote(absolutePath: string): Promise<string>;
}

function waitMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function filterArgsFor(input: TieredSearchInput): CandidateFilterArgs {
  return {
    vaultRoot: input.vaultRoot,
    sourcePath: input.sourceFile.path,
    sourceAbsolutePath: input.sourceAbsolutePath,
    reviewPath: input.reviewPath,
  };
}

function planArgsFor(input: TieredSearchInput): DeterministicPlanArgs {
  return {
    sourcePath: input.sourceFile.path,
    id: input.sourceFile.path,
    displayName: "Aha",
    _resolved_insight_input: input.sourceText,
  };
}

async function recallOutcome(input: TieredSearchInput): Promise<TieredOutcome> {
  const qmdDeps = createQmdRequestDeps(input.settings);
  const vaultBoundaryDeps = createVaultBoundaryDeps();
  const result = await runRecallTier(
    {
      ...filterArgsFor(input),
      ...planArgsFor(input),
      sourcePath: input.sourceFile.path,
      targetCandidates: input.settings.targetCandidates,
    },
    { ...qmdDeps, ...vaultBoundaryDeps },
  );
  return { tier: "recall", result };
}

/**
 * Runs one Capability Tier search round: readiness pre-check -> tier
 * decision -> the matching tier's pipeline. The returned tier is what the
 * round actually landed on (see TieredOutcome), which can differ from the
 * originally decided tier only via Runtime Tier Fallback out of Full Tier.
 */
export async function runTieredSearch(input: TieredSearchInput): Promise<TieredOutcome> {
  const { settings } = input;
  const qmdAvailable = await probeQmdAvailable(settings);
  const llmProfile = resolveLlmRequestProfile(settings, settings.llmProvider);
  const tier = decideCapabilityTier({ qmdAvailable, llmConfigured: llmProfile.ok });

  if (tier === "neighborhood") {
    return {
      tier,
      result: buildNeighborhoodTierResult({
        sourceFile: input.sourceFile,
        metadataCache: input.metadataCache,
        targetCandidates: settings.targetCandidates,
      }),
    };
  }

  if (tier === "recall") {
    return recallOutcome(input);
  }

  if (!llmProfile.ok) {
    // Structurally unreachable: decideCapabilityTier used this same
    // llmProfile.ok value as llmConfigured, so tier === "full" implies
    // llmProfile.ok === true. Kept as a TS narrowing guard and a defensive
    // fallback in case that invariant is ever broken by a future edit.
    return recallOutcome(input);
  }

  const vaultBoundaryDeps = createVaultBoundaryDeps();
  const orchestratorDeps: OrchestratorDeps = {
    ...createQmdRequestDeps(settings),
    ...vaultBoundaryDeps,
    httpPost: requestUrlHttpPost,
    sleep: waitMs,
    readNote: input.readNote,
  };
  const fullResult = await runFullPipeline(
    {
      ...filterArgsFor(input),
      ...planArgsFor(input),
      sourcePath: input.sourceFile.path,
      sourceText: input.sourceText,
      targetCandidates: settings.targetCandidates,
    },
    {
      baseUrl: llmProfile.request.baseUrl,
      apiKey: llmProfile.request.apiKey,
      model: llmProfile.request.model,
      protocol: llmProfile.request.protocol,
      timeoutMs: DEFAULT_LLM_TIMEOUT_MS,
    },
    orchestratorDeps,
  );
  return shapeFullTierResult(fullResult);
}
