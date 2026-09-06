// Capability Tier orchestration entry point (issue #58). Wires the readiness
// pre-check, decideCapabilityTier, and the three tiers (Neighborhood/Recall/
// Full, with Full's Runtime Tier Fallback) into one call main.ts's
// searchFromCurrentNote can use in place of the legacy runAhaWrapper.
//
// The readiness pre-check re-probes qmd and re-resolves the LLM profile
// fresh on every call (no caching anywhere in this module or its deps), so
// an environment repair (installing qmd, fixing an API key) upgrades the
// tier on the very next round without restarting Obsidian.
//
// Issue #59 additions: settings.excludedFolders is parsed and threaded into
// every tier's candidate filtering; the Full Tier branch threads a computed
// query-plan prompt-override version (settings.queryPromptOverride) into
// core's additive parameter; and, when settings.traceDirectory is set, every
// round writes a plugin-origin Pipeline Trace (pipeline-trace.ts) after the
// tier's result is computed.

import {
  DEFAULT_LLM_TIMEOUT_MS,
  decideCapabilityTier,
  runFullPipeline,
  searchRoundSettings,
  excludedFoldersFromSettings as coreExcludedFoldersFromSettings,
  queryPromptOverrideFromSettings as coreQueryPromptOverrideFromSettings,
  type CandidateFilterArgs,
  type DeterministicPlanArgs,
  type OrchestratorDeps,
  type QueryPlanPromptOverride,
  type SearchRoundSettings,
} from "./core";
import { resolveLlmRequestProfile, requestUrlHttpPost } from "./llm-request";
import { buildNeighborhoodTierResult, collectNeighbors, type NeighborhoodMetadataCacheLike, type NeighborhoodSourceLike } from "./neighborhood-tier";
import { fullPipelineTraceFields, recordPipelineTrace, type FullPipelineTraceFields } from "./pipeline-trace";
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

/**
 * Builds core's OrchestratorDeps.listGraphNeighbors from the same
 * metadataCache Neighborhood Tier already reads (neighborhood-tier.ts's
 * collectNeighbors) -- no subprocess, no I/O, just an in-memory cache scan.
 * Gives Full Tier the same Obsidian graph-expansion recall (1-hop outlinks +
 * backlinks) that bench and the CLI wrapper already get via
 * core-artifact.mjs's createObsidianGraphNeighborsRunner.
 */
function listGraphNeighborsFor(input: TieredSearchInput) {
  return async (sourcePath: string) => ({
    neighbors: collectNeighbors(sourcePath, input.metadataCache.resolvedLinks ?? {}).map((entry) => ({
      notePath: entry.notePath,
      kind: (entry.isBacklink ? "backlink" : "outlink") as "backlink" | "outlink",
    })),
    warnings: [] as string[],
  });
}

function getNodeRequire(): NodeRequire {
  const globalRequire = (globalThis as { require?: NodeRequire }).require;
  if (typeof globalRequire === "function") return globalRequire;
  const windowRequire = (globalThis as { window?: { require?: NodeRequire } }).window?.require;
  if (typeof windowRequire === "function") return windowRequire;
  throw new Error("Node require is unavailable.");
}

/**
 * Node's SHA-256, the plugin-side half of core's SearchRoundSettingsDeps:
 * core/search-round-settings.ts owns *what* the prompt-override version
 * looks like, this owns *how* a hash is computed in this runtime.
 */
function searchRoundSettingsDeps(): { sha256Hex(value: string): string } {
  return {
    sha256Hex: (value) => {
      const crypto = getNodeRequire()("crypto") as typeof import("crypto");
      return crypto.createHash("sha256").update(value).digest("hex");
    },
  };
}

/**
 * Reads the plugin's saved settings as Memory Search Round settings, through
 * the same core module the batch vault runner uses -- so a round started from
 * either side interprets excluded folders, candidate counts and the
 * query-plan prompt override identically.
 */
export function searchRoundSettingsFor(settings: AhaPluginSettings): SearchRoundSettings {
  return searchRoundSettings(settings, searchRoundSettingsDeps());
}

/** Thin binding of core's rule (see core/search-round-settings.ts). */
export function excludedFoldersFromSettings(raw: string): readonly string[] {
  return coreExcludedFoldersFromSettings(raw);
}

/** Thin binding of core's rule, with this runtime's hash injected. */
export function queryPromptOverrideFromSettings(raw: string): QueryPlanPromptOverride | undefined {
  return coreQueryPromptOverrideFromSettings(raw, searchRoundSettingsDeps());
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

async function recallOutcome(input: TieredSearchInput, round: SearchRoundSettings): Promise<TieredOutcome> {
  const qmdDeps = createQmdRequestDeps(input.settings);
  const vaultBoundaryDeps = createVaultBoundaryDeps();
  const result = await runRecallTier(
    {
      ...filterArgsFor(input),
      ...planArgsFor(input),
      sourcePath: input.sourceFile.path,
      targetCandidates: round.targetCandidates,
      excludedFolders: round.excludedFolders,
    },
    // Recall Tier gets the same in-memory graph-expansion dep as Full Tier:
    // both go through core's Memory Retrieval module, so link/backlink
    // neighbors reach Recall rounds too -- which is what its own summary has
    // always told users happened.
    { ...qmdDeps, ...vaultBoundaryDeps, listGraphNeighbors: listGraphNeighborsFor(input) },
  );
  return { tier: "recall", result };
}

/**
 * Hands one round to the Pipeline Trace module (pipeline-trace.ts's
 * recordPipelineTrace), which owns the whole completion sequence: gating on
 * settings.traceDirectory, building, writing, attaching the trace reference
 * to the result, and turning a write failure into a warning rather than a
 * lost search round.
 */
function writePluginTraceIfConfigured(
  input: TieredSearchInput,
  outcome: TieredOutcome,
  fields: FullPipelineTraceFields = {},
): void {
  recordPipelineTrace({
    traceDirectory: input.settings.traceDirectory,
    sourcePath: input.sourceFile.path,
    sourceTitle: input.sourceFile.basename,
    sourceText: input.sourceText,
    tier: outcome.tier,
    result: outcome.result,
    ...fields,
  });
}

/**
 * Runs one Capability Tier search round: readiness pre-check -> tier
 * decision -> the matching tier's pipeline. The returned tier is what the
 * round actually landed on (see TieredOutcome), which can differ from the
 * originally decided tier only via Runtime Tier Fallback out of Full Tier.
 */
export async function runTieredSearch(input: TieredSearchInput): Promise<TieredOutcome> {
  const { settings } = input;
  const round = searchRoundSettingsFor(settings);
  const qmdAvailable = await probeQmdAvailable(settings);
  const llmProfile = resolveLlmRequestProfile(settings, settings.llmProvider);
  const tier = decideCapabilityTier({ qmdAvailable, llmConfigured: llmProfile.ok });

  if (tier === "neighborhood") {
    const outcome: TieredOutcome = {
      tier,
      result: buildNeighborhoodTierResult({
        sourceFile: input.sourceFile,
        metadataCache: input.metadataCache,
        targetCandidates: round.targetCandidates,
        excludedFolders: round.excludedFolders,
      }),
    };
    writePluginTraceIfConfigured(input, outcome);
    return outcome;
  }

  if (tier === "recall") {
    const outcome = await recallOutcome(input, round);
    writePluginTraceIfConfigured(input, outcome);
    return outcome;
  }

  if (!llmProfile.ok) {
    // Structurally unreachable: decideCapabilityTier used this same
    // llmProfile.ok value as llmConfigured, so tier === "full" implies
    // llmProfile.ok === true. Kept as a TS narrowing guard and a defensive
    // fallback in case that invariant is ever broken by a future edit.
    const outcome = await recallOutcome(input, round);
    writePluginTraceIfConfigured(input, outcome);
    return outcome;
  }

  const vaultBoundaryDeps = createVaultBoundaryDeps();
  const orchestratorDeps: OrchestratorDeps = {
    ...createQmdRequestDeps(settings),
    ...vaultBoundaryDeps,
    httpPost: requestUrlHttpPost,
    sleep: waitMs,
    readNote: input.readNote,
    listGraphNeighbors: listGraphNeighborsFor(input),
  };
  const fullResult = await runFullPipeline(
    {
      ...filterArgsFor(input),
      ...planArgsFor(input),
      sourcePath: input.sourceFile.path,
      sourceText: input.sourceText,
      targetCandidates: round.targetCandidates,
      relationJudgeBudget: round.relationJudgeBudget,
      excludedFolders: round.excludedFolders,
      queryPromptOverride: round.queryPromptOverride,
    },
    {
      baseUrl: llmProfile.request.baseUrl,
      apiKey: llmProfile.request.apiKey,
      model: llmProfile.request.model,
      protocol: llmProfile.request.protocol,
      timeoutMs: DEFAULT_LLM_TIMEOUT_MS,
      thinking: llmProfile.request.thinking,
    },
    orchestratorDeps,
  );
  const outcome = shapeFullTierResult(fullResult);
  writePluginTraceIfConfigured(input, outcome, fullPipelineTraceFields(fullResult));
  return outcome;
}
