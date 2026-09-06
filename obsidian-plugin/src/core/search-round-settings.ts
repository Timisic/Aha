// Memory Search Round settings (CONTEXT.md "Memory Search Round"): the one
// module that interprets the saved settings a search round depends on --
// excluded folders, candidate target, Relation Judge budget, and the
// query-plan prompt override.
//
// Before this module the same saved settings were translated twice: once by
// tier-pipeline.ts for the plugin and once by scripts/dev/run-batch-vault.mjs
// for batch runs, and the two had drifted (batch resurrected the "templates"
// default over a deliberately cleared field, and never forwarded the prompt
// override at all, so batch rounds silently ran the built-in prompt). Empty
// values, defaults and prompt-version naming are now decided once here;
// adapters keep only the environment difference they genuinely own.
//
// This module must stay free of `obsidian` imports, node imports, and
// module-level I/O -- hence the injected `sha256Hex`: the prompt-override
// version is a content hash, and hashing is the caller's environment
// (node:crypto on both sides today).

import type { QueryPlanPromptOverride } from "./query-plan-llm";

/** Candidates carried out of one search round when settings say nothing. */
export const DEFAULT_TARGET_CANDIDATES = 20;
/** Candidate excerpts Relation Judge may review in one round by default. */
export const DEFAULT_RELATION_JUDGE_BUDGET = 40;
/**
 * The excluded-folders value a vault that has never touched the setting
 * behaves as. Mirrors settings.ts's DEFAULT_SETTINGS.excludedFolders; a
 * *present but empty* field is a deliberate "exclude nothing" and is never
 * replaced by this default.
 */
export const DEFAULT_EXCLUDED_FOLDERS_SETTING = "templates";
/** Prefix distinguishing an override's version from QUERY_PLAN_PROMPT_VERSION at a glance. */
export const QUERY_PROMPT_OVERRIDE_VERSION_PREFIX = "aha-query-plan-custom-";

export interface SearchRoundSettingsDeps {
  /** Full lowercase hex SHA-256 digest of `value`. */
  sha256Hex(value: string): string;
}

/** The saved-settings shape a search round reads; every field is optional so an unmigrated data.json is readable. */
export interface SearchRoundSettingsSource {
  excludedFolders?: unknown;
  targetCandidates?: unknown;
  relationJudgeBudget?: unknown;
  queryPromptOverride?: unknown;
}

export interface SearchRoundSettings {
  excludedFolders: readonly string[];
  targetCandidates: number;
  relationJudgeBudget: number;
  /** Undefined means "use the built-in query-plan prompt and its version". */
  queryPromptOverride?: QueryPlanPromptOverride;
}

/**
 * Parses the visible "Excluded folders" settings field (issue #59): comma or
 * newline separated vault-relative folder paths.
 *
 * A missing field (undefined/null -- possible when reading a raw data.json
 * that predates the setting) falls back to DEFAULT_EXCLUDED_FOLDERS_SETTING,
 * which is what the plugin sees anyway after DEFAULT_SETTINGS merging. A
 * present but empty/whitespace-only field returns an empty array on purpose:
 * an intentionally cleared field means "exclude nothing via this mechanism"
 * (core/pool.ts's isGeneratedReviewCandidate check still unconditionally
 * excludes the review folder regardless of this list).
 */
export function excludedFoldersFromSettings(raw: unknown): readonly string[] {
  const value = raw === undefined || raw === null ? DEFAULT_EXCLUDED_FOLDERS_SETTING : String(raw);
  return value
    .split(/[,\n]/)
    .map((folder) => folder.trim())
    .filter(Boolean);
}

/**
 * Computes the query-plan prompt-override parameter for
 * generateQueryPlanViaLlm (core/query-plan-llm.ts's additive optional
 * parameter, issue #59): undefined when the setting is empty/whitespace-only
 * (preserving the built-in prompt and version exactly), otherwise
 * `{ text, version }` with the version computed from the trimmed override
 * text as `aha-query-plan-custom-<first 16 hex chars of its SHA-256>`. 16 hex
 * chars (64 bits) is ample to distinguish override revisions in a Pipeline
 * Trace without the version string becoming unwieldy.
 */
export function queryPromptOverrideFromSettings(
  raw: unknown,
  deps: SearchRoundSettingsDeps,
): QueryPlanPromptOverride | undefined {
  const text = String(raw ?? "").trim();
  if (!text) return undefined;
  return { text, version: `${QUERY_PROMPT_OVERRIDE_VERSION_PREFIX}${deps.sha256Hex(text).slice(0, 16)}` };
}

/**
 * Interprets one saved-settings object into the effective settings for a
 * Memory Search Round. Both the plugin and the batch runner go through this,
 * so a round started from either side reads the same configuration the same
 * way; only `deps.sha256Hex` differs between them.
 */
export function searchRoundSettings(
  source: SearchRoundSettingsSource,
  deps: SearchRoundSettingsDeps,
): SearchRoundSettings {
  return {
    excludedFolders: excludedFoldersFromSettings(source.excludedFolders),
    targetCandidates: positiveInteger(source.targetCandidates, DEFAULT_TARGET_CANDIDATES),
    relationJudgeBudget: positiveInteger(source.relationJudgeBudget, DEFAULT_RELATION_JUDGE_BUDGET),
    queryPromptOverride: queryPromptOverrideFromSettings(source.queryPromptOverride, deps),
  };
}

/** Shared numeric-setting rule: a finite positive number, floored; anything else is the default. */
export function positiveInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}
