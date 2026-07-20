import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type AhaPlugin from "./main";
import { testProviderConnection, type LlmApiProvider } from "./llm-request";
import {
  decideIndexCoverageLight,
  decideLlmConnectivityLight,
  decideQmdBinaryLight,
  decideQmdEndpointsLight,
  runEmbedSequence,
  type HealthLight,
} from "./health-checks";
import { parseQmdEnvironment, probeQmdAvailable, runQmdEmbed, runQmdStatus, runQmdUpdate } from "./qmd-request";

// Settings convergence (issue #59). Field categories, recapped here so
// display() and settings-migration.ts stay consistent with each other:
//
//   - Visible (exactly five `new Setting(...)`-groups, at most six per the
//     issue): LLM service group (provider dropdown + OpenAI/DeepSeek
//     sub-fields, counted as ONE conceptual item), query-plan prompt
//     override, review folder, target candidates, excluded folders.
//   - Advanced (collapsed, exactly two items): qmd path override
//     (qmdCommand -- confirmed by reading qmd-request.ts: this is the one
//     field controlling both the CLI fallback command and SDK-module
//     inference path, so it is the "qmd path override" the issue means) and
//     the single multi-line qmd environment field (qmdEnvironment, replacing
//     the six discrete qmdRemote* fields in the UI).
//   - Hidden developer settings (no UI row at all, data.json-only):
//     traceDirectory, useFixtureResult, useLegacyWrapper.
//   - Truly invisible / dead-but-still-functional (no UI row, data.json-only,
//     NOT carried forward by migration): ahaWorkspace, wrapperRelativePath,
//     nodeCommand, codexCommand, codexModel, codexReasoningEffort,
//     codexSandbox, obsidianCommand, qmdRunner, qmdSdkModule. These stay in
//     the TS interface/DEFAULT_SETTINGS only because process.ts's frozen
//     runAhaWrapper/runReadinessCheck (the #58 legacy-wrapper rollback path)
//     hard-require them.
//   - Invisible but still alive for BOTH the legacy and internalized paths
//     (no UI row, but carried forward by migration): qmdIndex, qmdRerank,
//     and the six qmdRemote* fields (process.ts's frozen wrapperChildEnv
//     still reads the qmdRemote* fields directly for the legacy wrapper's
//     remote-endpoint config; qmdRerank still gates qmd-request.ts's
//     `--no-rerank` flag for the internalized path). qmdIndex in particular
//     lost its old "QMD index" settings-page row here even though it is
//     load-bearing for both paths and for the health section's `qmd status
//     --index <qmdIndex>` probe -- the issue's acceptance criterion pins
//     Advanced to *exactly* qmd path + qmd environment, and qmdIndex is not
//     named in either the visible-six or advanced-two lists, so this is a
//     deliberate, spec-driven scope decision (flagged in the #59 report) to
//     drop its UI row rather than invent a place for it.
export interface AhaPluginSettings {
  ahaWorkspace: string;
  llmProvider: string;
  llmBaseUrl: string;
  llmModel: string;
  llmApiKey: string;
  llmApiKeyEnv: string;
  deepseekBaseUrl: string;
  deepseekModel: string;
  deepseekApiKey: string;
  deepseekApiKeyEnv: string;
  codexModel: string;
  codexReasoningEffort: string;
  codexSandbox: string;
  reviewFolder: string;
  nodeCommand: string;
  codexCommand: string;
  qmdRunner: string;
  qmdCommand: string;
  qmdIndex: string;
  qmdSdkModule: string;
  qmdRerank: boolean;
  qmdRemoteEmbedUrl: string;
  qmdRemoteEmbedModel: string;
  qmdRemoteGenerateUrl: string;
  qmdRemoteGenerateModel: string;
  qmdRemoteRerankUrl: string;
  qmdRemoteRerankModel: string;
  obsidianCommand: string;
  wrapperRelativePath: string;
  targetCandidates: number;
  useFixtureResult: boolean;
  /**
   * Hidden dev-only rollback switch (issue #58, now truly invisible per
   * #59): when true, searchFromCurrentNote calls the frozen legacy
   * runAhaWrapper exactly as before instead of the internalized Capability
   * Tier pipeline. Default off. No settings-page row; only reachable via
   * this data.json field.
   */
  useLegacyWrapper: boolean;
  /**
   * Advanced (issue #59): multi-line `KEY=VALUE` lines injected verbatim
   * into the qmd subprocess environment, replacing the six discrete
   * qmdRemote* fields' UI. General-purpose -- not restricted to the old
   * QMD_REMOTE_* key allowlist. See qmd-request.ts's parseQmdEnvironment.
   */
  qmdEnvironment: string;
  /**
   * Visible (issue #59): comma or newline separated vault folders excluded
   * from candidate retrieval, absorbing the old bench-side
   * AHA_EXCLUDED_FOLDERS environment-variable convention into a plugin
   * settings field. Defaults to excluding "templates" only (the issue's
   * literal wording), narrower than core's
   * DEFAULT_EXCLUDED_CANDIDATE_FOLDERS = ["templates", "Aha/Reviews"] --
   * "Aha/Reviews" is excluded unconditionally elsewhere (isGeneratedReviewCandidate)
   * regardless of this field, so defaulting this field to "templates" alone
   * does not reopen that exclusion.
   */
  excludedFolders: string;
  /**
   * Visible (issue #59): multi-line query-plan prompt override. Empty means
   * the built-in default prompt (core/query-plan-llm.ts's
   * buildQueryPlanPrompt). Only applies to the Full Tier's LLM query
   * planning; Recall/Neighborhood Tier never use an LLM prompt at all.
   */
  queryPromptOverride: string;
  /**
   * Hidden developer setting (issue #59): when non-empty, each plugin
   * search round writes a Pipeline Trace (ADR 0003, origin: "plugin") as a
   * JSON file under this directory. Empty/unset (the default) writes
   * nothing. No settings-page row; only reachable via data.json.
   */
  traceDirectory: string;
}

export const DEFAULT_SETTINGS: AhaPluginSettings = {
  ahaWorkspace: "",
  llmProvider: "openai",
  llmBaseUrl: "https://api.openai.com/v1",
  llmModel: "gpt-5.5",
  llmApiKey: "",
  llmApiKeyEnv: "OPENAI_API_KEY",
  deepseekBaseUrl: "https://api.deepseek.com",
  deepseekModel: "deepseek-v4-pro",
  deepseekApiKey: "",
  deepseekApiKeyEnv: "DEEPSEEK_API_KEY",
  codexModel: "gpt-5.3-codex-spark",
  codexReasoningEffort: "low",
  codexSandbox: "danger-full-access",
  reviewFolder: "Aha/Reviews",
  nodeCommand: "",
  codexCommand: "codex",
  qmdRunner: "sdk",
  qmdCommand: "qmd",
  qmdIndex: "obsidian",
  qmdSdkModule: "",
  qmdRerank: false,
  qmdRemoteEmbedUrl: "",
  qmdRemoteEmbedModel: "",
  qmdRemoteGenerateUrl: "",
  qmdRemoteGenerateModel: "",
  qmdRemoteRerankUrl: "",
  qmdRemoteRerankModel: "",
  obsidianCommand: "obsidian",
  wrapperRelativePath: "scripts/aha/run-insight-search.mjs",
  targetCandidates: 20,
  useFixtureResult: false,
  useLegacyWrapper: false,
  qmdEnvironment: "",
  excludedFolders: "templates",
  queryPromptOverride: "",
  traceDirectory: "",
};

type StringSettingKey = {
  [K in keyof AhaPluginSettings]: AhaPluginSettings[K] extends string ? K : never;
}[keyof AhaPluginSettings];

export class AhaSettingTab extends PluginSettingTab {
  plugin: AhaPlugin;

  constructor(app: App, plugin: AhaPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  // Trimmed text setting; empty input falls back to the default unless keepEmpty is set.
  private textSetting(key: StringSettingKey, name: string, desc: string, options: { placeholder?: string; keepEmpty?: boolean } = {}): void {
    new Setting(this.containerEl)
      .setName(name)
      .setDesc(desc)
      .addText((text) => text
        .setPlaceholder(options.placeholder ?? DEFAULT_SETTINGS[key])
        .setValue(this.plugin.settings[key])
        .onChange(async (value) => {
          const trimmed = value.trim();
          this.plugin.settings[key] = options.keepEmpty ? trimmed : trimmed || DEFAULT_SETTINGS[key];
          await this.plugin.saveSettings();
        }));
  }

  private apiKeySetting(key: "llmApiKey" | "deepseekApiKey", name: string, desc: string): void {
    new Setting(this.containerEl)
      .setName(name)
      .setDesc(desc)
      .addText((text) => {
        text.inputEl.type = "password";
        text
          .setPlaceholder("sk-...")
          .setValue(this.plugin.settings[key] ?? "")
          .onChange(async (value) => {
            this.plugin.settings[key] = value.trim();
            await this.plugin.saveSettings();
          });
      });
  }

  // Trimmed multi-line text setting (issue #59): used for the prompt
  // override and the qmd environment fields. Unlike textSetting, empty
  // input is always kept as empty (these fields' whole point is that empty
  // means "use the built-in default" / "inject nothing"), never replaced by
  // a DEFAULT_SETTINGS fallback value.
  private textAreaSetting(key: StringSettingKey, name: string, desc: string, options: { placeholder?: string; rows?: number } = {}): void {
    new Setting(this.containerEl)
      .setName(name)
      .setDesc(desc)
      .addTextArea((text) => {
        text.inputEl.rows = options.rows ?? 4;
        text.inputEl.cols = 48;
        text
          .setPlaceholder(options.placeholder ?? "")
          .setValue(this.plugin.settings[key])
          .onChange(async (value) => {
            this.plugin.settings[key] = value;
            await this.plugin.saveSettings();
          });
      });
  }

  // Runs through the in-plugin requestUrl transport adapter (issue #55), not
  // the legacy external-process wrapper, so the Test buttons exercise the same
  // network path (and proxy behavior) the internalized pipeline will use.
  private providerTestSetting(provider: LlmApiProvider, label: string): void {
    new Setting(this.containerEl)
      .setName(`Test ${label}`)
      .setDesc(`Send a minimal JSON request to verify the configured ${label} key, endpoint, and model.`)
      .addButton((button) => button
        .setButtonText(`Test ${label}`)
        .onClick(async () => {
          button.setDisabled(true).setButtonText("Testing...");
          try {
            const result = await testProviderConnection(this.plugin.settings, provider);
            new Notice(result.ok ? result.message : `${label} test failed: ${result.message}`, result.ok ? 6000 : 12000);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            new Notice(`${label} test failed: ${message}`, 12000);
          } finally {
            button.setDisabled(false).setButtonText(`Test ${label}`);
          }
        }));
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    // --- Visible settings (issue #59: at most six conceptual items) -------
    // Counting method: each `new Setting(...)`-producing call below that
    // introduces a *new user-facing concern* counts as one item. The LLM
    // service group's per-provider sub-fields (base URL/model/key/key-env,
    // and the Test button) are visually grouped under one heading per
    // provider but counted as a single conceptual item ("the LLM service
    // group") because they are all just detail of the one decision "which
    // provider, and how do I reach it" -- exactly like a single form
    // section, not five independent settings. That yields five conceptual
    // items total (LLM group, prompt override, review folder, target
    // candidates, excluded folders), at most six per the acceptance
    // criterion; the issue's own text lists exactly five named items, so a
    // sixth was deliberately not invented to fill the count.
    containerEl.createEl("h2", { text: "Aha" });

    new Setting(containerEl)
      .setName("LLM provider")
      .setDesc("Choose the provider used for query planning and Relation Judge. Provider profiles remain stored separately when switching. (Codex CLI is no longer offered here -- issue #57/#58 made LLM calls HTTP-only; the legacy wrapper's Codex CLI support only remains reachable by hand-editing data.json's llmProvider field for the hidden legacy-wrapper rollback switch.)")
      .addDropdown((dropdown) => dropdown
        .addOption("openai", "OpenAI API")
        .addOption("deepseek", "DeepSeek API")
        .setValue(this.plugin.settings.llmProvider === "deepseek" ? "deepseek" : "openai")
        .onChange(async (value) => {
          this.plugin.settings.llmProvider = value || DEFAULT_SETTINGS.llmProvider;
          await this.plugin.saveSettings();
        }));

    containerEl.createEl("h3", { text: "OpenAI" });
    this.textSetting("llmBaseUrl", "OpenAI base URL", "OpenAI Responses API base URL.");
    this.textSetting("llmModel", "OpenAI model", "Model used for query planning and bounded Relation Judge.");
    this.apiKeySetting("llmApiKey", "OpenAI API key", "Stored in this local vault's plugin data. Leave empty to read the environment variable below.");
    this.textSetting("llmApiKeyEnv", "OpenAI key env", "Environment variable name used when the API key field above is empty.");
    this.providerTestSetting("openai", "OpenAI");

    containerEl.createEl("h3", { text: "DeepSeek" });
    this.textSetting("deepseekBaseUrl", "DeepSeek base URL", "DeepSeek OpenAI-compatible base URL.");
    this.textSetting("deepseekModel", "DeepSeek model", "Model used for query planning and bounded Relation Judge.");
    this.apiKeySetting("deepseekApiKey", "DeepSeek API key", "Stored separately from the OpenAI key. Leave empty to read the environment variable below.");
    this.textSetting("deepseekApiKeyEnv", "DeepSeek key env", "Environment variable name used when the DeepSeek API key field is empty.");
    this.providerTestSetting("deepseek", "DeepSeek");

    containerEl.createEl("h3", { text: "Search" });
    this.textAreaSetting("queryPromptOverride", "Query-plan prompt override", "Advanced: replaces the built-in query-plan prompt verbatim. Leave empty to use the built-in default. Pipeline Traces record a content-hash prompt version while an override is active.", { placeholder: "Leave empty for the built-in prompt", rows: 6 });
    this.textSetting("reviewFolder", "Review note location", "Vault-relative folder for Aha Review Notes.");

    new Setting(containerEl)
      .setName("Target candidates")
      .setDesc("Aha targets 15-20 old-note candidates for the first MVP.")
      .addSlider((slider) => slider
        .setLimits(15, 20, 1)
        .setValue(this.plugin.settings.targetCandidates)
        .setDynamicTooltip()
        .onChange(async (value) => {
          this.plugin.settings.targetCandidates = value;
          await this.plugin.saveSettings();
        }));

    this.textSetting("excludedFolders", "Excluded folders", "Comma or newline separated vault folders excluded from candidate retrieval. Defaults to excluding \"templates\".", { placeholder: DEFAULT_SETTINGS.excludedFolders });

    // --- Advanced (collapsed, exactly two items) --------------------------
    this.renderAdvancedSection(containerEl);

    // --- Health section (separate concern, not counted against the six
    // visible items per the issue's own paragraph structure) --------------
    this.renderHealthSection(containerEl);
  }

  // Obsidian's Setting API has no built-in collapsible section, so this
  // implements one directly: a toggle button that shows/hides a dedicated
  // sub-container. Collapsed by default (these are advanced, rarely-touched
  // settings). Exactly two items live inside: qmd path override
  // (qmdCommand) and the qmd environment field (qmdEnvironment).
  private renderAdvancedSection(containerEl: HTMLElement): void {
    const advancedContainer = containerEl.createDiv({ cls: "aha-advanced-section" });
    let expanded = false;

    const body = advancedContainer.createDiv();
    body.style.display = "none";

    const toggle = new Setting(advancedContainer)
      .setName("Advanced")
      .setDesc("QMD path override and QMD environment.")
      .addButton((button) => button
        .setButtonText("Show advanced")
        .onClick(() => {
          expanded = !expanded;
          body.style.display = expanded ? "" : "none";
          button.setButtonText(expanded ? "Hide advanced" : "Show advanced");
        }));
    void toggle;

    // textSetting always targets `this.containerEl`, but these two rows
    // must render into the collapsible `body` div instead, so they are
    // built directly with Setting(body, ...) rather than reusing that
    // helper.
    new Setting(body)
      .setName("QMD path override")
      .setDesc("Path to the qmd binary (also used for QMD SDK module inference). Leave default to use \"qmd\" from PATH.")
      .addText((text) => text
        .setPlaceholder(DEFAULT_SETTINGS.qmdCommand)
        .setValue(this.plugin.settings.qmdCommand)
        .onChange(async (value) => {
          const trimmed = value.trim();
          this.plugin.settings.qmdCommand = trimmed || DEFAULT_SETTINGS.qmdCommand;
          await this.plugin.saveSettings();
        }));

    new Setting(body)
      .setName("QMD environment")
      .setDesc("Multi-line KEY=VALUE lines injected verbatim into the qmd subprocess environment (e.g. QMD_REMOTE_EMBED_URL=...). One entry per line; blank lines and lines without \"=\" are ignored.")
      .addTextArea((text) => {
        text.inputEl.rows = 6;
        text.inputEl.cols = 48;
        text
          .setPlaceholder("KEY=VALUE")
          .setValue(this.plugin.settings.qmdEnvironment)
          .onChange(async (value) => {
            this.plugin.settings.qmdEnvironment = value;
            await this.plugin.saveSettings();
          });
      });
  }

  // --- Health section (issue #59) -------------------------------------------
  // Four status lights plus the explicit embed button. All decision logic
  // (parsing qmd status text, deciding a light's color) lives in
  // health-checks.ts as pure functions; this method only wires the actual
  // I/O (qmd-request.ts / llm-request.ts) into them and renders the result.
  // The embed button (runEmbedSequence) is the ONLY place embedding is ever
  // triggered from -- nothing here calls it automatically.
  private renderHealthSection(containerEl: HTMLElement): void {
    containerEl.createEl("h3", { text: "Health" });
    const lightsContainer = containerEl.createDiv({ cls: "aha-health-lights" });
    lightsContainer.setText("Checking...");

    void this.refreshHealthLights(lightsContainer);

    new Setting(containerEl)
      .setName("Recheck health")
      .setDesc("Re-run all four health checks against the current settings.")
      .addButton((button) => button
        .setButtonText("Recheck")
        .onClick(() => {
          lightsContainer.setText("Checking...");
          void this.refreshHealthLights(lightsContainer);
        }));

    const embedStatus = containerEl.createDiv({ cls: "aha-embed-status" });
    new Setting(containerEl)
      .setName("Embed vault into QMD index")
      .setDesc("Runs \"qmd update --index " + this.plugin.settings.qmdIndex + "\" then \"qmd embed --index " + this.plugin.settings.qmdIndex + "\" as two separate bounded subprocess calls. This is the only way embedding ever runs -- it is never triggered automatically by a health check, a search round, or plugin load.")
      .addButton((button) => {
        button
          .setButtonText("Embed now")
          .onClick(async () => {
            button.setDisabled(true);
            const settings = this.plugin.settings;
            const outcome = await runEmbedSequence(
              {
                runUpdate: async () => {
                  const result = await runQmdUpdate(settings);
                  return { ok: result.ok, message: result.message };
                },
                runEmbed: async () => {
                  const result = await runQmdEmbed(settings);
                  return { ok: result.ok, message: result.message };
                },
              },
              (step, status, message) => {
                const label = step === "update" ? "qmd update" : "qmd embed";
                if (status === "started") embedStatus.setText(`Running ${label}...`);
                if (status === "succeeded") embedStatus.setText(`${label} succeeded.`);
                if (status === "failed") embedStatus.setText(`${label} failed: ${message ?? ""}`);
              },
            );
            button.setDisabled(false);
            new Notice(
              outcome.ok ? "Aha: embed finished successfully." : `Aha: embed failed -- ${outcome.steps.at(-1)?.message ?? "unknown error"}`,
              outcome.ok ? 6000 : 12000,
            );
            void this.refreshHealthLights(lightsContainer);
          });
      });
  }

  private async refreshHealthLights(container: HTMLElement): Promise<void> {
    const settings = this.plugin.settings;
    const vaultMarkdownFileCount = this.app.vault.getMarkdownFiles().length;

    const [qmdAvailable, statusProbe, llmProbe] = await Promise.all([
      probeQmdAvailable(settings),
      runQmdStatus(settings),
      testProviderConnection(settings, settings.llmProvider === "deepseek" ? "deepseek" : "openai"),
    ]);

    const lights: HealthLight[] = [
      decideQmdBinaryLight(qmdAvailable),
      decideIndexCoverageLight(statusProbe, vaultMarkdownFileCount, settings.qmdIndex),
      decideQmdEndpointsLight(parseQmdEnvironment(settings.qmdEnvironment), statusProbe, settings.qmdIndex),
      decideLlmConnectivityLight(llmProbe),
    ];

    container.empty();
    for (const light of lights) {
      const row = container.createDiv({ cls: "aha-health-light" });
      row.createSpan({ text: `${light.ok ? "🟢" : "🔴"} ${light.label}: ${light.message}` });
      if (!light.ok && light.fixCommand) {
        const code = row.createEl("code", { text: light.fixCommand });
        code.style.userSelect = "all";
        code.title = "Click to copy";
        code.style.cursor = "pointer";
        code.addEventListener("click", () => {
          void navigator.clipboard?.writeText(light.fixCommand ?? "");
          new Notice("Fix command copied.", 3000);
        });
      }
    }
  }
}
