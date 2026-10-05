import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type AhaPlugin from "./main";
import { testProviderConnection, type LlmApiProvider } from "./llm-request";
import {
  decideIndexCoverageLight,
  decideLlmConnectivityLight,
  decideQmdBinaryLight,
  decideQmdEndpointsLight,
  type HealthLight,
} from "./health-checks";
import { parseQmdEnvironment, probeQmdAvailable, runQmdStatus } from "./qmd-request";

import { normalizeIndexThreshold } from "./index-coordinator";

// Product settings are shared by the plugin and batch runner. Legacy wrapper
// fields are accepted only by settings-migration.ts, then discarded.
export interface AhaPluginSettings {
  /**
   * Fixed to "deepseek" (the only supported API provider). No settings-page
   * row.
   */
  llmProvider: string;
  deepseekBaseUrl: string;
  deepseekModel: string;
  deepseekApiKey: string;
  deepseekApiKeyEnv: string;
  qmdCommand: string;
  qmdIndex: string;
  qmdRerank: boolean;
  autoIndexEnabled: boolean;
  autoIndexNoteThreshold: number;
  targetCandidates: number;
  /** Maximum candidate excerpts Relation Judge may review while backfilling weak results. */
  relationJudgeBudget: number;
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
   * Advanced setting: when non-empty, each plugin
   * search round writes a Pipeline Trace (ADR 0003, origin: "plugin") as a
   * JSON file under this directory. Empty/unset (the default) writes
   * nothing. Batch runs honor the same directory, with origin: "batch".
   */
  traceDirectory: string;
}

export const DEFAULT_SETTINGS: AhaPluginSettings = {
  llmProvider: "deepseek",
  deepseekBaseUrl: "https://api.deepseek.com",
  deepseekModel: "deepseek-v4-pro",
  deepseekApiKey: "",
  deepseekApiKeyEnv: "DEEPSEEK_API_KEY",
  qmdCommand: "qmd",
  qmdIndex: "obsidian",
  qmdRerank: false,
  autoIndexEnabled: false,
  autoIndexNoteThreshold: 10,
  targetCandidates: 20,
  relationJudgeBudget: 40,
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
  private unsubscribeIndex?: () => void;

  hide(): void { this.unsubscribeIndex?.(); this.unsubscribeIndex = undefined; }

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
    this.hide();
    containerEl.empty();

    containerEl.createEl("h2", { text: "Aha" });

    const providerContainer = containerEl.createDiv();
    this.renderProviderFields(providerContainer);

    containerEl.createEl("h3", { text: "Search" });

    new Setting(containerEl)
      .setName("Target candidates")
      .setDesc("每轮希望得到的非 weak 候选数量。")
      .addSlider((slider) => slider
        .setLimits(15, 20, 1)
        .setValue(this.plugin.settings.targetCandidates)
        .setDynamicTooltip()
        .onChange(async (value) => {
          this.plugin.settings.targetCandidates = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("Relation Judge budget")
      .setDesc("补位时最多判断的候选摘录数；达到目标、耗尽候选池或用完预算即停止。")
      .addSlider((slider) => slider
        .setLimits(20, 60, 1)
        .setValue(this.plugin.settings.relationJudgeBudget)
        .setDynamicTooltip()
        .onChange(async (value) => {
          this.plugin.settings.relationJudgeBudget = value;
          await this.plugin.saveSettings();
        }));

    this.textSetting("excludedFolders", "Excluded folders", "逗号分隔，排除这些文件夹的笔记。", { placeholder: DEFAULT_SETTINGS.excludedFolders });

    // --- Advanced (collapsed) ---------------------------------------------
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
  // settings). Items include trace directory, query-plan prompt override, qmd
  // path override (qmdCommand), and the qmd environment field
  // (qmdEnvironment).
  private renderAdvancedSection(containerEl: HTMLElement): void {
    const advancedContainer = containerEl.createDiv({ cls: "aha-advanced-section" });
    let expanded = false;

    const body = advancedContainer.createDiv();
    body.style.display = "none";

    const toggle = new Setting(advancedContainer)
      .setName("Advanced")
      .setDesc("查询提示词、Trace 保存目录、QMD 路径与环境变量。")
      .addButton((button) => button
        .setButtonText("Show advanced")
        .onClick(() => {
          expanded = !expanded;
          body.style.display = expanded ? "" : "none";
          button.setButtonText(expanded ? "Hide advanced" : "Show advanced");
        }));
    void toggle;

    new Setting(body)
      .setName("Trace directory")
      .setDesc("每轮搜索保存 JSON trace 的绝对目录；留空关闭。包含笔记摘录，建议放在 vault 外。")
      .addText((text) => text
        .setPlaceholder("/absolute/path/to/traces")
        .setValue(this.plugin.settings.traceDirectory)
        .onChange(async (value) => {
          this.plugin.settings.traceDirectory = value.trim();
          await this.plugin.saveSettings();
        }));

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

    new Setting(containerEl)
      .setName("Automatic QMD index updates")
      .setDesc("累计新增笔记达到阈值后更新索引。关闭只停止后续自动更新，不中断正在运行的任务。")
      .addToggle(toggle => {
        toggle.toggleEl.setAttribute("aria-label", "Automatic QMD index updates");
        toggle.setValue(this.plugin.settings.autoIndexEnabled).onChange(async value => {
          this.plugin.settings.autoIndexEnabled = value;
          await this.plugin.saveSettings();
        });
      });
    new Setting(containerEl)
      .setName("New notes per index update")
      .setDesc("按新增 Markdown 笔记计数，修改和重命名不计数。默认 10 篇。")
      .addText(text => {
        text.inputEl.type = "number";
        text.inputEl.min = "1";
        text.inputEl.step = "1";
        text.inputEl.setAttribute("aria-label", "New notes per index update");
        text.setValue(String(this.plugin.settings.autoIndexNoteThreshold)).onChange(async value => {
          this.plugin.settings.autoIndexNoteThreshold = normalizeIndexThreshold(Number(value));
          await this.plugin.saveSettings();
        });
      });
    containerEl.createEl("p", { cls: "setting-item-description", text: "更新范围由 QMD 索引的 collections 决定。配置远程 embedding 时，新增或修改笔记的原文会发送给该服务。Excluded folders 仅过滤召回候选，不阻止索引或发送原文。" });
    const embedStatus = containerEl.createDiv({ cls: "aha-embed-status" });
    embedStatus.setAttribute("role", "status");
    this.unsubscribeIndex = this.plugin.indexUpdates?.subscribe(status => {
      const pending = `待更新 ${status.pending} 篇`;
      if (status.kind === "running") embedStatus.setText(`${pending} · 正在运行 qmd ${status.step}…`);
      else if (status.kind === "failed") embedStatus.setText(`${pending} · 更新失败：${status.message}`);
      else embedStatus.setText(`${pending}${status.lastSuccess ? ` · 上次成功 ${new Date(status.lastSuccess).toLocaleString()}` : " · 尚未完成索引更新"}`);
    });
    new Setting(containerEl)
      .setName("Embed vault into QMD index")
      .setDesc("执行 qmd update + embed，更新索引并嵌入向量。")
      .addButton((button) => {
        button
          .setButtonText("Embed now")
          .onClick(async () => {
            button.setDisabled(true);
            const outcome = await this.plugin.indexUpdates.refresh();
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
