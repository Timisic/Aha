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
//   - Visible (four `new Setting(...)`-groups in display(), outside
//     Advanced): DeepSeek LLM group (base URL/model/key/key-env + test
//     button, counted as ONE conceptual item -- the OpenAI provider option
//     and its generic llm* fields were removed; DeepSeek is now the only
//     supported API provider), review folder, target candidates, excluded
//     folders.
//   - Advanced (collapsed, three items -- query-plan prompt override lives
//     here too, not in the visible section above; this note previously
//     claimed otherwise): query-plan prompt override, qmd path override
//     (qmdCommand -- confirmed by reading qmd-request.ts: this is the one
//     field controlling both the CLI fallback command and SDK-module
//     inference path, so it is the "qmd path override" the issue means), and
//     the single multi-line qmd environment field (qmdEnvironment, replacing
//     the six discrete qmdRemote* fields in the UI).
//   - Hidden developer settings (no UI row at all, data.json-only):
//     traceDirectory, useFixtureResult, useLegacyWrapper.
//   - Truly invisible / dead-but-still-functional (no UI row, data.json-only,
//     NOT carried forward by migration): llmProvider (fixed to "deepseek";
//     the only other value process.ts's wrapper accepts is "codex-cli",
//     which was never reachable from this settings UI either), ahaWorkspace,
//     wrapperRelativePath, nodeCommand, codexCommand, codexModel,
//     codexReasoningEffort, codexSandbox, obsidianCommand, qmdRunner,
//     qmdSdkModule. These stay in the TS interface/DEFAULT_SETTINGS only
//     because process.ts's frozen runAhaWrapper/runReadinessCheck (the #58
//     legacy-wrapper rollback path) hard-require them.
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
  /**
   * Fixed to "deepseek" (DeepSeek is the only supported API provider; the
   * only other value process.ts's frozen wrapper accepts is "codex-cli",
   * never reachable from this settings UI). No settings-page row.
   */
  llmProvider: string;
  deepseekBaseUrl: string;
  deepseekModel: string;
  deepseekApiKey: string;
  deepseekApiKeyEnv: string;
  codexModel: string;
  codexReasoningEffort: string;
  codexSandbox: string;
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
  llmProvider: "deepseek",
  deepseekBaseUrl: "https://api.deepseek.com",
  deepseekModel: "deepseek-v4-pro",
  deepseekApiKey: "",
  deepseekApiKeyEnv: "DEEPSEEK_API_KEY",
  codexModel: "gpt-5.3-codex-spark",
  codexReasoningEffort: "low",
  codexSandbox: "danger-full-access",
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

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Aha" });

    const providerContainer = containerEl.createDiv();
    this.renderProviderFields(providerContainer);

    containerEl.createEl("h3", { text: "Search" });

    new Setting(containerEl)
      .setName("Target candidates")
      .setDesc("候选笔记数量上限。")
      .addSlider((slider) => slider
        .setLimits(15, 20, 1)
        .setValue(this.plugin.settings.targetCandidates)
        .setDynamicTooltip()
        .onChange(async (value) => {
          this.plugin.settings.targetCandidates = value;
          await this.plugin.saveSettings();
        }));

    this.textSetting("excludedFolders", "Excluded folders", "逗号分隔，排除这些文件夹的笔记。", { placeholder: DEFAULT_SETTINGS.excludedFolders });

    // --- Advanced (collapsed, exactly two items) --------------------------
    this.renderAdvancedSection(containerEl);

    // --- Health section (separate concern, not counted against the six
    // visible items per the issue's own paragraph structure) --------------
    this.renderHealthSection(containerEl);
  }

  private renderProviderFields(container: HTMLElement): void {
    container.empty();
    this.textSettingInto(container, "deepseekBaseUrl", "Base URL", "DeepSeek API 地址。");
    this.textSettingInto(container, "deepseekModel", "Model", "DeepSeek 模型。");
    this.apiKeySettingInto(container, "deepseekApiKey", "API key", "留空则读取下方环境变量。");
    this.textSettingInto(container, "deepseekApiKeyEnv", "Key env var", "API key 环境变量名。");
    this.providerTestSettingInto(container, "deepseek", "DeepSeek");
  }

  private textSettingInto(container: HTMLElement, key: StringSettingKey, name: string, desc: string): void {
    new Setting(container)
      .setName(name)
      .setDesc(desc)
      .addText((text) => text
        .setPlaceholder(DEFAULT_SETTINGS[key])
        .setValue(this.plugin.settings[key])
        .onChange(async (value) => {
          const trimmed = value.trim();
          this.plugin.settings[key] = trimmed || DEFAULT_SETTINGS[key];
          await this.plugin.saveSettings();
        }));
  }

  private apiKeySettingInto(container: HTMLElement, key: "deepseekApiKey", name: string, desc: string): void {
    new Setting(container)
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

  private providerTestSettingInto(container: HTMLElement, provider: LlmApiProvider, label: string): void {
    new Setting(container)
      .setName(`Test ${label}`)
      .setDesc(`验证 ${label} 连接。`)
      .addButton((button) => button
        .setButtonText(`Test`)
        .onClick(async () => {
          button.setDisabled(true).setButtonText("Testing...");
          try {
            const result = await testProviderConnection(this.plugin.settings, provider);
            new Notice(result.ok ? result.message : `${label} test failed: ${result.message}`, result.ok ? 6000 : 12000);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            new Notice(`${label} test failed: ${message}`, 12000);
          } finally {
            button.setDisabled(false).setButtonText(`Test`);
          }
        }));
  }

  // Obsidian's Setting API has no built-in collapsible section, so this
  // implements one directly: a toggle button that shows/hides a dedicated
  // sub-container. Collapsed by default (these are advanced, rarely-touched
  // settings). Three items live inside: query-plan prompt override, qmd
  // path override (qmdCommand), and the qmd environment field
  // (qmdEnvironment).
  private renderAdvancedSection(containerEl: HTMLElement): void {
    const advancedContainer = containerEl.createDiv({ cls: "aha-advanced-section" });
    let expanded = false;

    const body = advancedContainer.createDiv();
    body.style.display = "none";

    const toggle = new Setting(advancedContainer)
      .setName("Advanced")
      .setDesc("QMD 路径与环境变量。")
      .addButton((button) => button
        .setButtonText("Show advanced")
        .onClick(() => {
          expanded = !expanded;
          body.style.display = expanded ? "" : "none";
          button.setButtonText(expanded ? "Hide advanced" : "Show advanced");
        }));
    void toggle;

    new Setting(body)
      .setName("Query prompt override")
      .setDesc("自定义 query-plan prompt，留空使用默认。")
      .addTextArea((text) => {
        text.inputEl.rows = 4;
        text.inputEl.cols = 48;
        text
          .setPlaceholder("留空使用内置 prompt")
          .setValue(this.plugin.settings.queryPromptOverride)
          .onChange(async (value) => {
            this.plugin.settings.queryPromptOverride = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(body)
      .setName("QMD path override")
      .setDesc("qmd 可执行文件路径，留空使用 PATH 中的 qmd。")
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
      .setDesc("每行 KEY=VALUE，注入 qmd 子进程环境。")
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
      .setDesc("重新检测所有状态。")
      .addButton((button) => button
        .setButtonText("Recheck")
        .onClick(() => {
          lightsContainer.setText("Checking...");
          void this.refreshHealthLights(lightsContainer);
        }));

    const embedStatus = containerEl.createDiv({ cls: "aha-embed-status" });
    new Setting(containerEl)
      .setName("Embed vault into QMD index")
      .setDesc("执行 qmd update + embed，更新索引并嵌入向量。")
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
      testProviderConnection(settings, "deepseek"),
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
