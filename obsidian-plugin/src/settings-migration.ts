import { DEFAULT_SETTINGS, type AhaPluginSettings } from "./settings";

function stringField(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function boolField(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function numberField(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

// Legacy input names; endpoint values migrate into qmdEnvironment before removal.
const QMD_REMOTE_FIELD_ENV_NAMES: ReadonlyArray<[string, string]> = [
  ["qmdRemoteEmbedUrl", "QMD_REMOTE_EMBED_URL"],
  ["qmdRemoteEmbedModel", "QMD_REMOTE_EMBED_MODEL"],
  ["qmdRemoteGenerateUrl", "QMD_REMOTE_GENERATE_URL"],
  ["qmdRemoteGenerateModel", "QMD_REMOTE_GENERATE_MODEL"],
  ["qmdRemoteRerankUrl", "QMD_REMOTE_RERANK_URL"],
  ["qmdRemoteRerankModel", "QMD_REMOTE_RERANK_MODEL"],
];

/** Converts the six old per-endpoint qmd fields into `KEY=VALUE` lines, skipping blank values. */
export function qmdEnvironmentFromLegacyRemoteFields(old: Record<string, unknown>): string {
  const lines: string[] = [];
  for (const [field, envName] of QMD_REMOTE_FIELD_ENV_NAMES) {
    const value = old[field as string];
    if (typeof value === "string" && value.trim()) {
      lines.push(`${envName}=${value.trim()}`);
    }
  }
  return lines.join("\n");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Pure, idempotent migration. Existing modern QMD environment values win. */
export function migrateAhaPluginSettings(oldSettings: unknown): AhaPluginSettings {
  const old = isPlainObject(oldSettings) ? oldSettings : {};

  const qmdEnvironment = typeof old.qmdEnvironment === "string"
    ? old.qmdEnvironment
    : qmdEnvironmentFromLegacyRemoteFields(old);

  return {
    // --- carried fields (still-migratable) ---
    deepseekBaseUrl: stringField(old.deepseekBaseUrl, DEFAULT_SETTINGS.deepseekBaseUrl),
    deepseekModel: stringField(old.deepseekModel, DEFAULT_SETTINGS.deepseekModel),
    deepseekApiKey: stringField(old.deepseekApiKey, DEFAULT_SETTINGS.deepseekApiKey),
    deepseekApiKeyEnv: stringField(old.deepseekApiKeyEnv, DEFAULT_SETTINGS.deepseekApiKeyEnv),
    targetCandidates: numberField(old.targetCandidates, DEFAULT_SETTINGS.targetCandidates),
    relationJudgeBudget: numberField(old.relationJudgeBudget, DEFAULT_SETTINGS.relationJudgeBudget),
    qmdCommand: stringField(old.qmdCommand, DEFAULT_SETTINGS.qmdCommand),
    qmdIndex: stringField(old.qmdIndex, DEFAULT_SETTINGS.qmdIndex),
    qmdRerank: boolField(old.qmdRerank, DEFAULT_SETTINGS.qmdRerank),

    // Only DeepSeek is supported; discard any old provider selection.
    llmProvider: DEFAULT_SETTINGS.llmProvider,

    // --- converted / new fields ---
    qmdEnvironment,
    excludedFolders: stringField(old.excludedFolders, DEFAULT_SETTINGS.excludedFolders),
    queryPromptOverride: stringField(old.queryPromptOverride, DEFAULT_SETTINGS.queryPromptOverride),
    traceDirectory: stringField(old.traceDirectory, DEFAULT_SETTINGS.traceDirectory),
  };
}

// Version 4 removes wrapper settings from persisted data on the next load.
export const CURRENT_SETTINGS_SCHEMA_VERSION = 4;

/**
 * Pure trigger logic for the one-time "settings simplified" notice (issue
 * #59). `storedVersion` is whatever schemaVersion was in the previously
 * saved plugin data (undefined for any data saved before this field
 * existed, which always counts as older). True exactly once per upgrade --
 * callers must persist CURRENT_SETTINGS_SCHEMA_VERSION immediately after
 * showing the notice so it never fires again.
 */
export function shouldShowSimplificationNotice(storedVersion: number | undefined, currentVersion: number = CURRENT_SETTINGS_SCHEMA_VERSION): boolean {
  return storedVersion === undefined || storedVersion < currentVersion;
}
