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
  private refreshHealth?: () => Promise<void>;

  hide(): void {
    this.unsubscribeIndex?.();
    this.unsubscribeIndex = undefined;
    this.refreshHealth = undefined;
  }

  constructor(app: App, plugin: AhaPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  private textSetting(container: HTMLElement, key: StringSettingKey, name: string, desc: string, options: { placeholder?: string; keepEmpty?: boolean } = {}): void {
    new Setting(container)
      .setName(name)
      .setDesc(desc)
      .addText((text) => {
        text.inputEl.setAttribute("aria-label", name);
        text
          .setPlaceholder(options.placeholder ?? DEFAULT_SETTINGS[key])
          .setValue(this.plugin.settings[key])
          .onChange(async (value) => {
            const trimmed = value.trim();
            this.plugin.settings[key] = options.keepEmpty ? trimmed : trimmed || DEFAULT_SETTINGS[key];
            await this.plugin.saveSettings();
          });
      });
  }

  private textAreaSetting(container: HTMLElement, key: StringSettingKey, name: string, desc: string, options: { placeholder?: string; rows?: number } = {}): void {
    const setting = new Setting(container).setName(name).setDesc(desc);
    setting.settingEl.addClass("aha-settings-multiline");
    setting.addTextArea((text) => {
      text.inputEl.rows = options.rows ?? 4;
      text.inputEl.setAttribute("aria-label", name);
      text
        .setPlaceholder(options.placeholder ?? "")
        .setValue(this.plugin.settings[key])
        .onChange(async (value) => {
          this.plugin.settings[key] = value;
          await this.plugin.saveSettings();
        });
    });
  }

  private disclosure(container: HTMLElement, name: string, cls?: string): HTMLDetailsElement {
    const details = container.createEl("details", { cls: `aha-settings-disclosure ${cls ?? ""}`.trim() });
    details.createEl("summary", { text: name });
    return details;
  }

  display(): void {
    const { containerEl } = this;
    this.hide();
    containerEl.empty();
    containerEl.addClass("aha-settings");
    containerEl.createEl("h2", { text: "Aha" });

    containerEl.createEl("h3", { text: "搜索" });
    this.textSetting(containerEl, "excludedFolders", "排除文件夹", "逗号或换行分隔。仅过滤候选，不影响索引范围。");
    const searchTuning = this.disclosure(containerEl, "完整回顾：数量与判断预算");
    new Setting(searchTuning)
      .setName("目标候选数")
      .setDesc("每轮希望保留的有效候选数量。")
      .addSlider((slider) => {
        slider.sliderEl.setAttribute("aria-label", "Target candidates");
        slider
          .setLimits(15, 20, 1)
          .setValue(this.plugin.settings.targetCandidates)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.targetCandidates = value;
            await this.plugin.saveSettings();
          });
      });
    new Setting(searchTuning)
      .setName("关系判断预算")
      .setDesc("最多判断的摘录数。达到目标、候选耗尽或用完预算后停止。")
      .addSlider((slider) => {
        slider.sliderEl.setAttribute("aria-label", "Relation Judge budget");
        slider
          .setLimits(20, 60, 1)
          .setValue(this.plugin.settings.relationJudgeBudget)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.relationJudgeBudget = value;
            await this.plugin.saveSettings();
          });
      });

    this.renderIndexSection(containerEl);
    this.renderProviderFields(containerEl);
    this.renderAdvancedSection(containerEl);
    this.renderHealthSection(containerEl);
  }

  private renderProviderFields(container: HTMLElement): void {
    const connection = this.disclosure(container, "关系判断（DeepSeek，可选）");
    new Setting(connection)
      .setName("DeepSeek API key（可选）")
      .setDesc("用于回顾时的关系判断，会发送笔记摘录。留空可用环境变量；直接填写会保存到本 vault 的插件设置。")
      .addText((text) => {
        text.inputEl.type = "password";
        text.inputEl.setAttribute("aria-label", "API key");
        text
          .setPlaceholder("sk-...")
          .setValue(this.plugin.settings.deepseekApiKey)
          .onChange(async (value) => {
            this.plugin.settings.deepseekApiKey = value.trim();
            await this.plugin.saveSettings();
          });
      });
    this.textSetting(connection, "deepseekBaseUrl", "API 地址", "", { placeholder: DEFAULT_SETTINGS.deepseekBaseUrl });
    this.textSetting(connection, "deepseekModel", "模型", "");
    this.textSetting(connection, "deepseekApiKeyEnv", "密钥环境变量", "未直接填写 API key 时读取此变量。");
    this.providerTestSettingInto(connection, "deepseek", "DeepSeek");
  }

  private providerTestSettingInto(container: HTMLElement, provider: LlmApiProvider, label: string): void {
    new Setting(container)
      .setName("测试连接")
      .addButton((button) => {
        button.buttonEl.setAttribute("aria-label", `Test ${label}`);
        button
          .setButtonText("测试")
          .onClick(async () => {
            button.setDisabled(true).setButtonText("测试中…");
            try {
              const result = await testProviderConnection(this.plugin.settings, provider);
              new Notice(result.ok ? result.message : `${label} 连接失败：${result.message}`, result.ok ? 6000 : 12000);
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              new Notice(`${label} 连接失败：${message}`, 12000);
            } finally {
              button.setDisabled(false).setButtonText("测试");
            }
          });
      });
  }

  private renderAdvancedSection(container: HTMLElement): void {
    const advanced = this.disclosure(container, "高级设置", "aha-advanced-section");
    this.textSetting(advanced, "qmdCommand", "QMD 路径", "留空使用 PATH 中的 qmd。");
    this.textAreaSetting(advanced, "qmdEnvironment", "QMD 环境变量", "每行 KEY=VALUE，传给 QMD。", { placeholder: "KEY=VALUE", rows: 4 });
    this.textAreaSetting(advanced, "queryPromptOverride", "查询提示词", "仅用于完整回顾的查询规划。留空使用默认。", { placeholder: "留空使用内置提示词" });
    this.textSetting(advanced, "traceDirectory", "Trace 保存目录", "绝对路径，保存每轮搜索记录。含笔记摘录，建议放在 vault 外。留空关闭。", { placeholder: "/absolute/path/to/traces", keepEmpty: true });
  }

  private renderIndexSection(container: HTMLElement): void {
    container.createEl("h3", { text: "索引" });
    new Setting(container)
      .setName("自动更新索引")
      .setDesc("新增笔记达到阈值后更新。关闭不打断正在运行的任务。")
      .addToggle(toggle => {
        toggle.toggleEl.setAttribute("aria-label", "Automatic QMD index updates");
        toggle.setValue(this.plugin.settings.autoIndexEnabled).onChange(async value => {
          this.plugin.settings.autoIndexEnabled = value;
          await this.plugin.saveSettings();
        });
      });
    new Setting(container)
      .setName("新增笔记阈值")
      .setDesc("只计新增笔记，修改和重命名不计。")
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
    new Setting(container)
      .setName("更新索引")
      .setDesc("让新笔记能被联想找到，失败时可重试。")
      .addButton((button) => {
        button.buttonEl.setAttribute("aria-label", "Embed now");
        button
          .setButtonText("立即更新")
          .onClick(async () => {
            button.setDisabled(true).setButtonText("更新中…");
            try {
              const outcome = await this.plugin.indexUpdates.refresh();
              new Notice(
                outcome.ok ? "Aha：索引已更新。" : `Aha：索引更新失败。${outcome.steps.at(-1)?.message ?? "未知错误"}`,
                outcome.ok ? 6000 : 12000,
              );
              void this.refreshHealth?.();
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              new Notice(`Aha：索引更新失败。${message}`, 12000);
            } finally {
              button.setDisabled(false).setButtonText("立即更新");
            }
          });
      });
    const embedStatus = container.createDiv({ cls: "aha-embed-status" });
    embedStatus.setAttribute("role", "status");
    this.unsubscribeIndex = this.plugin.indexUpdates?.subscribe(status => {
      const pending = `待更新 ${status.pending} 篇`;
      embedStatus.toggleClass("is-error", status.kind === "failed");
      if (status.kind === "running") embedStatus.setText(`${pending} · 正在运行 qmd ${status.step}…`);
      else if (status.kind === "failed") embedStatus.setText(`${pending} · 更新失败：${status.message}`);
      else embedStatus.setText(`${pending}${status.lastSuccess ? ` · 上次成功 ${new Date(status.lastSuccess).toLocaleString()}` : " · 尚未完成索引更新"}`);
    });
    container.createEl("p", { cls: "setting-item-description aha-settings-note", text: "远程向量服务会收到新建或修改笔记的原文。排除文件夹只过滤候选，索引范围由 QMD 决定。" });
  }

  private renderHealthSection(container: HTMLElement): void {
    const health = this.disclosure(container, "连接与索引检查", "aha-health-section");
    const summary = health.querySelector("summary");
    const lights = health.createDiv({ cls: "aha-health-lights" });
    lights.setAttribute("role", "status");
    const refresh = async (): Promise<void> => {
      lights.setText("检查中…");
      summary?.setText("连接与索引检查 · 检查中…");
      try {
        const issues = await this.refreshHealthLights(lights);
        summary?.setText(issues ? `连接与索引检查 · ${issues} 项需处理` : "连接与索引检查 · 正常");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        lights.setText(`检查失败：${message}。请重新检查。`);
        summary?.setText("连接与索引检查 · 检查失败");
      }
    };
    new Setting(health)
      .setName("重新检查")
      .addButton(button => {
        button.buttonEl.setAttribute("aria-label", "Recheck health");
        button.setButtonText("重新检查").onClick(async () => {
          button.setDisabled(true).setButtonText("检查中…");
          try {
            await refresh();
          } finally {
            button.setDisabled(false).setButtonText("重新检查");
          }
        });
      });
    this.refreshHealth = refresh;
    void refresh();
  }

  private async refreshHealthLights(container: HTMLElement): Promise<number> {
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
      row.createSpan({ cls: light.ok ? "aha-health-state" : "aha-health-state is-error", text: light.ok ? "正常" : "需处理" });
      row.createEl("strong", { text: light.label });
      row.createDiv({ cls: "setting-item-description", text: light.message });
      if (!light.ok && light.fixCommand) {
        const fixCommand = light.fixCommand;
        const code = row.createEl("code", { cls: "aha-health-fix", text: fixCommand });
        code.tabIndex = 0;
        code.setAttribute("role", "button");
        code.setAttribute("aria-label", `复制修复建议：${light.label}`);
        code.title = "复制修复建议";
        const copy = async (): Promise<void> => {
          try {
            await navigator.clipboard.writeText(fixCommand);
            new Notice("已复制修复建议。", 3000);
          } catch {
            new Notice("复制失败，请手动选择并复制修复建议。", 6000);
          }
        };
        code.addEventListener("click", () => { void copy(); });
        code.addEventListener("keydown", event => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          void copy();
        });
      }
    }
    return lights.filter(light => !light.ok).length;
  }
}
