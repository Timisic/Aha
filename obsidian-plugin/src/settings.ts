import { App, PluginSettingTab, Setting } from "obsidian";
import type AhaPlugin from "./main";

export interface AhaPluginSettings {
  ahaWorkspace: string;
  codexModel: string;
  codexReasoningEffort: string;
  codexSandbox: string;
  reviewFolder: string;
  codexCommand: string;
  qmdCommand: string;
  obsidianCommand: string;
  wrapperRelativePath: string;
  targetCandidates: number;
  useFixtureResult: boolean;
}

export const DEFAULT_SETTINGS: AhaPluginSettings = {
  ahaWorkspace: "",
  codexModel: "gpt-5.3-codex-spark",
  codexReasoningEffort: "low",
  codexSandbox: "danger-full-access",
  reviewFolder: "Aha/Reviews",
  codexCommand: "codex",
  qmdCommand: "qmd",
  obsidianCommand: "obsidian",
  wrapperRelativePath: "scripts/aha/aha-wrapper.mjs",
  targetCandidates: 20,
  useFixtureResult: false,
};

export class AhaSettingTab extends PluginSettingTab {
  plugin: AhaPlugin;

  constructor(app: App, plugin: AhaPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Aha workspace")
      .setDesc("Absolute path to the local Aha repository that contains scripts/aha/aha-wrapper.mjs.")
      .addText((text) => text
        .setPlaceholder("/path/to/Aha")
        .setValue(this.plugin.settings.ahaWorkspace)
        .onChange(async (value) => {
          this.plugin.settings.ahaWorkspace = value.trim();
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("Review note location")
      .setDesc("Vault-relative folder for Aha Review Notes.")
      .addText((text) => text
        .setPlaceholder("Aha/Reviews")
        .setValue(this.plugin.settings.reviewFolder)
        .onChange(async (value) => {
          this.plugin.settings.reviewFolder = value.trim() || DEFAULT_SETTINGS.reviewFolder;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("Codex command")
      .setDesc("Command or absolute path used by the wrapper to run Codex.")
      .addText((text) => text
        .setPlaceholder("codex")
        .setValue(this.plugin.settings.codexCommand)
        .onChange(async (value) => {
          this.plugin.settings.codexCommand = value.trim() || DEFAULT_SETTINGS.codexCommand;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("Codex sandbox")
      .setDesc("QMD needs local sqlite writes and localhost model endpoints; danger-full-access is the working desktop default.")
      .addDropdown((dropdown) => dropdown
        .addOption("danger-full-access", "Danger full access")
        .addOption("workspace-write", "Workspace write")
        .addOption("read-only", "Read only")
        .setValue(this.plugin.settings.codexSandbox)
        .onChange(async (value) => {
          this.plugin.settings.codexSandbox = value || DEFAULT_SETTINGS.codexSandbox;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("Codex model")
      .setDesc("Fast model used for bounded relation judging.")
      .addText((text) => text
        .setPlaceholder(DEFAULT_SETTINGS.codexModel)
        .setValue(this.plugin.settings.codexModel)
        .onChange(async (value) => {
          this.plugin.settings.codexModel = value.trim() || DEFAULT_SETTINGS.codexModel;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("Codex reasoning effort")
      .setDesc("Low is the MVP default so a search round can return promptly.")
      .addDropdown((dropdown) => dropdown
        .addOption("low", "Low")
        .addOption("medium", "Medium")
        .addOption("high", "High")
        .setValue(this.plugin.settings.codexReasoningEffort)
        .onChange(async (value) => {
          this.plugin.settings.codexReasoningEffort = value || DEFAULT_SETTINGS.codexReasoningEffort;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("QMD command")
      .setDesc("Command or absolute path used by Codex for QMD retrieval.")
      .addText((text) => text
        .setPlaceholder("qmd")
        .setValue(this.plugin.settings.qmdCommand)
        .onChange(async (value) => {
          this.plugin.settings.qmdCommand = value.trim() || DEFAULT_SETTINGS.qmdCommand;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("Obsidian CLI command")
      .setDesc("Command or absolute path used for backlink/outlink expansion and vault checks.")
      .addText((text) => text
        .setPlaceholder("obsidian")
        .setValue(this.plugin.settings.obsidianCommand)
        .onChange(async (value) => {
          this.plugin.settings.obsidianCommand = value.trim() || DEFAULT_SETTINGS.obsidianCommand;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("Wrapper script")
      .setDesc("Path relative to the Aha workspace.")
      .addText((text) => text
        .setPlaceholder(DEFAULT_SETTINGS.wrapperRelativePath)
        .setValue(this.plugin.settings.wrapperRelativePath)
        .onChange(async (value) => {
          this.plugin.settings.wrapperRelativePath = value.trim() || DEFAULT_SETTINGS.wrapperRelativePath;
          await this.plugin.saveSettings();
        }));

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

    new Setting(containerEl)
      .setName("Use fixture result")
      .setDesc("Development smoke mode: skip Codex and render the checked-in fixture result.")
      .addToggle((toggle) => toggle
        .setValue(this.plugin.settings.useFixtureResult)
        .onChange(async (value) => {
          this.plugin.settings.useFixtureResult = value;
          await this.plugin.saveSettings();
        }));
  }
}
