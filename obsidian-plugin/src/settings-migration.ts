// Settings migration (issue #59): a pure function from the old (32-field,
// pre-#59) settings object shape to the new AhaPluginSettings shape. No I/O,
// no `this.app`/`this.plugin` access -- takes a plain old-settings-shaped
// object and returns a plain new-settings-shaped object, so it is directly
// unit-testable and safely idempotent (migrating an already-migrated object
// is a no-op).
//
// Field categories (see the issue's resolved ambiguity #1, recapped in
// settings.ts's module comment):
//   - Carried: still-migratable fields keep their old value when present and
//     of the right type, falling back to DEFAULT_SETTINGS otherwise.
//   - Dead-field group (ahaWorkspace, wrapperRelativePath, nodeCommand,
//     codexCommand, codexModel, codexReasoningEffort, codexSandbox,
//     obsidianCommand, qmdRunner, qmdSdkModule): always reset to
//     DEFAULT_SETTINGS regardless of the old object's stored value. These
//     fields stay in the AhaPluginSettings *interface* (process.ts's frozen
//     legacy-wrapper rollback path still reads them), but migration does not
//     carry old values forward into them -- that is what "dropped" means for
//     this migration function specifically.
//   - qmdRemote* (six per-endpoint fields): carried verbatim into their own
//     (now UI-invisible) fields -- process.ts's frozen wrapperChildEnv /
//     qmdRemoteEnvironment still reads them directly for the legacy
//     wrapper's rollback path, so resetting them to empty on migration would
//     silently break a configured legacy-wrapper remote endpoint, the exact
//     failure mode the dead-field-group resolution was written to avoid for
//     the other fields. They are *also* converted into the new
//     `qmdEnvironment` multi-line field for the new internalized pipeline
//     (qmd-request.ts no longer reads the discrete fields at all).
//   - New fields (excludedFolders, queryPromptOverride, traceDirectory) not
//     present in the old shape: set to their DEFAULT_SETTINGS value.

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

/**
 * The exact env-var names qmdChildEnv (qmd-request.ts) and wrapperChildEnv
 * (process.ts) already use for these six endpoints -- kept as a literal
 * lookup here (not imported) because qmd-request.ts's own
 * `parseQmdEnvironment` is the *parsing* half of this convention, not the
 * naming source of truth; the naming lives wherever it was first
 * established (process.ts's wrapperChildEnv, pre-#58).
 */
const QMD_REMOTE_FIELD_ENV_NAMES: ReadonlyArray<[keyof AhaPluginSettings, string]> = [
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

/**
 * Pure migration: old-settings-shaped object in, new AhaPluginSettings out.
 * Safe on `undefined`/`null`/non-object input (treated as an empty old
 * object, so every field falls back to DEFAULT_SETTINGS). Safe to call on an
 * already-new-shape object: every carried/qmdRemote* field round-trips
 * unchanged, and `qmdEnvironment` is left as-is whenever it is already a
 * non-empty string (only re-derived from the legacy qmdRemote* fields when
 * qmdEnvironment itself is absent/empty), so repeated migration is a no-op.
 */
export function migrateAhaPluginSettings(oldSettings: unknown): AhaPluginSettings {
  const old = isPlainObject(oldSettings) ? oldSettings : {};

  const qmdRemoteEmbedUrl = stringField(old.qmdRemoteEmbedUrl, DEFAULT_SETTINGS.qmdRemoteEmbedUrl);
  const qmdRemoteEmbedModel = stringField(old.qmdRemoteEmbedModel, DEFAULT_SETTINGS.qmdRemoteEmbedModel);
  const qmdRemoteGenerateUrl = stringField(old.qmdRemoteGenerateUrl, DEFAULT_SETTINGS.qmdRemoteGenerateUrl);
  const qmdRemoteGenerateModel = stringField(old.qmdRemoteGenerateModel, DEFAULT_SETTINGS.qmdRemoteGenerateModel);
  const qmdRemoteRerankUrl = stringField(old.qmdRemoteRerankUrl, DEFAULT_SETTINGS.qmdRemoteRerankUrl);
  const qmdRemoteRerankModel = stringField(old.qmdRemoteRerankModel, DEFAULT_SETTINGS.qmdRemoteRerankModel);

  const existingQmdEnvironment = typeof old.qmdEnvironment === "string" ? old.qmdEnvironment : "";
  const qmdEnvironment = existingQmdEnvironment.trim()
    ? existingQmdEnvironment
    : qmdEnvironmentFromLegacyRemoteFields(old);

  return {
    // --- carried fields (still-migratable) ---
    llmProvider: stringField(old.llmProvider, DEFAULT_SETTINGS.llmProvider),
    llmBaseUrl: stringField(old.llmBaseUrl, DEFAULT_SETTINGS.llmBaseUrl),
    llmModel: stringField(old.llmModel, DEFAULT_SETTINGS.llmModel),
    llmApiKey: stringField(old.llmApiKey, DEFAULT_SETTINGS.llmApiKey),
    llmApiKeyEnv: stringField(old.llmApiKeyEnv, DEFAULT_SETTINGS.llmApiKeyEnv),
    deepseekBaseUrl: stringField(old.deepseekBaseUrl, DEFAULT_SETTINGS.deepseekBaseUrl),
    deepseekModel: stringField(old.deepseekModel, DEFAULT_SETTINGS.deepseekModel),
    deepseekApiKey: stringField(old.deepseekApiKey, DEFAULT_SETTINGS.deepseekApiKey),
    deepseekApiKeyEnv: stringField(old.deepseekApiKeyEnv, DEFAULT_SETTINGS.deepseekApiKeyEnv),
    reviewFolder: stringField(old.reviewFolder, DEFAULT_SETTINGS.reviewFolder),
    targetCandidates: numberField(old.targetCandidates, DEFAULT_SETTINGS.targetCandidates),
    qmdCommand: stringField(old.qmdCommand, DEFAULT_SETTINGS.qmdCommand),
    qmdIndex: stringField(old.qmdIndex, DEFAULT_SETTINGS.qmdIndex),
    qmdRerank: boolField(old.qmdRerank, DEFAULT_SETTINGS.qmdRerank),
    useFixtureResult: boolField(old.useFixtureResult, DEFAULT_SETTINGS.useFixtureResult),
    useLegacyWrapper: boolField(old.useLegacyWrapper, DEFAULT_SETTINGS.useLegacyWrapper),

    // --- dead-field group: reset to DEFAULT_SETTINGS regardless of old value ---
    ahaWorkspace: DEFAULT_SETTINGS.ahaWorkspace,
    wrapperRelativePath: DEFAULT_SETTINGS.wrapperRelativePath,
    nodeCommand: DEFAULT_SETTINGS.nodeCommand,
    codexCommand: DEFAULT_SETTINGS.codexCommand,
    codexModel: DEFAULT_SETTINGS.codexModel,
    codexReasoningEffort: DEFAULT_SETTINGS.codexReasoningEffort,
    codexSandbox: DEFAULT_SETTINGS.codexSandbox,
    obsidianCommand: DEFAULT_SETTINGS.obsidianCommand,
    qmdRunner: DEFAULT_SETTINGS.qmdRunner,
    qmdSdkModule: DEFAULT_SETTINGS.qmdSdkModule,

    // --- qmdRemote* fields: carried verbatim (legacy wrapper still reads them) ---
    qmdRemoteEmbedUrl,
    qmdRemoteEmbedModel,
    qmdRemoteGenerateUrl,
    qmdRemoteGenerateModel,
    qmdRemoteRerankUrl,
    qmdRemoteRerankModel,

    // --- converted / new fields ---
    qmdEnvironment,
    excludedFolders: stringField(old.excludedFolders, DEFAULT_SETTINGS.excludedFolders),
    queryPromptOverride: stringField(old.queryPromptOverride, DEFAULT_SETTINGS.queryPromptOverride),
    traceDirectory: stringField(old.traceDirectory, DEFAULT_SETTINGS.traceDirectory),
  };
}

export const CURRENT_SETTINGS_SCHEMA_VERSION = 2;

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
