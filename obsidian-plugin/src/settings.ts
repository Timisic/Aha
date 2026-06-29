import { App, PluginSettingTab, Setting } from "obsidian";
import type AhaPlugin from "./main";

export interface AhaPluginSettings {
  ahaWorkspace: string;
  llmProvider: string;
  llmBaseUrl: string;
  llmModel: string;
  llmApiKey: string;
  llmApiKeyEnv: string;
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
  obsidianCommand: string;
  wrapperRelativePath: string;
  targetCandidates: number;
  useFixtureResult: boolean;
}

export const DEFAULT_SETTINGS: AhaPluginSettings = {
  ahaWorkspace: "",
  llmProvider: "openai",
  llmBaseUrl: "https://api.openai.com/v1",
  llmModel: "gpt-5.5",
  llmApiKey: "",
  llmApiKeyEnv: "OPENAI_API_KEY",
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
      .setName("Node command")
      .setDesc("Optional absolute path to Node.js. Leave empty to auto-detect common desktop install paths.")
      .addText((text) => text
        .setPlaceholder("auto")
        .setValue(this.plugin.settings.nodeCommand)
        .onChange(async (value) => {
          this.plugin.settings.nodeCommand = value.trim();
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("LLM provider")
      .setDesc("OpenAI API is the normal fast path. Codex CLI remains available as a local fallback.")
      .addDropdown((dropdown) => dropdown
        .addOption("openai", "OpenAI API")
        .addOption("codex-cli", "Codex CLI")
        .setValue(this.plugin.settings.llmProvider)
        .onChange(async (value) => {
          this.plugin.settings.llmProvider = value || DEFAULT_SETTINGS.llmProvider;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("OpenAI base URL")
      .setDesc("OpenAI-compatible API base URL.")
      .addText((text) => text
        .setPlaceholder(DEFAULT_SETTINGS.llmBaseUrl)
        .setValue(this.plugin.settings.llmBaseUrl)
        .onChange(async (value) => {
          this.plugin.settings.llmBaseUrl = value.trim() || DEFAULT_SETTINGS.llmBaseUrl;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("OpenAI model")
      .setDesc("Model used for query planning and bounded Relation Judge.")
      .addText((text) => text
        .setPlaceholder(DEFAULT_SETTINGS.llmModel)
        .setValue(this.plugin.settings.llmModel)
        .onChange(async (value) => {
          this.plugin.settings.llmModel = value.trim() || DEFAULT_SETTINGS.llmModel;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("OpenAI API key")
      .setDesc("Stored in Obsidian plugin data for this local vault. Leave empty to read the environment variable below.")
      .addText((text) => {
        text.inputEl.type = "password";
        text
          .setPlaceholder("sk-...")
          .setValue(this.plugin.settings.llmApiKey ?? "")
          .onChange(async (value) => {
            this.plugin.settings.llmApiKey = value.trim();
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("OpenAI key env")
      .setDesc("Environment variable name used when the API key field above is empty.")
      .addText((text) => text
        .setPlaceholder(DEFAULT_SETTINGS.llmApiKeyEnv)
        .setValue(this.plugin.settings.llmApiKeyEnv)
        .onChange(async (value) => {
          this.plugin.settings.llmApiKeyEnv = value.trim() || DEFAULT_SETTINGS.llmApiKeyEnv;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("Codex command")
      .setDesc("Fallback command used only when LLM provider is Codex CLI.")
      .addText((text) => text
        .setPlaceholder("codex")
        .setValue(this.plugin.settings.codexCommand)
        .onChange(async (value) => {
          this.plugin.settings.codexCommand = value.trim() || DEFAULT_SETTINGS.codexCommand;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("Codex sandbox")
      .setDesc("Fallback Codex CLI sandbox.")
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
      .setDesc("Fallback Codex CLI model.")
      .addText((text) => text
        .setPlaceholder(DEFAULT_SETTINGS.codexModel)
        .setValue(this.plugin.settings.codexModel)
        .onChange(async (value) => {
          this.plugin.settings.codexModel = value.trim() || DEFAULT_SETTINGS.codexModel;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("Codex reasoning effort")
      .setDesc("Fallback Codex CLI reasoning effort.")
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
      .setName("QMD runner")
      .setDesc("SDK is the fast local path; CLI remains useful for diagnostics.")
      .addDropdown((dropdown) => dropdown
        .addOption("sdk", "SDK")
        .addOption("cli", "CLI")
        .setValue(this.plugin.settings.qmdRunner)
        .onChange(async (value) => {
          this.plugin.settings.qmdRunner = value || DEFAULT_SETTINGS.qmdRunner;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("QMD command")
      .setDesc("QMD CLI fallback and SDK module inference path.")
      .addText((text) => text
        .setPlaceholder("qmd")
        .setValue(this.plugin.settings.qmdCommand)
        .onChange(async (value) => {
          this.plugin.settings.qmdCommand = value.trim() || DEFAULT_SETTINGS.qmdCommand;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("QMD index")
      .setDesc("QMD index and collection name used for the Obsidian vault.")
      .addText((text) => text
        .setPlaceholder(DEFAULT_SETTINGS.qmdIndex)
        .setValue(this.plugin.settings.qmdIndex)
        .onChange(async (value) => {
          this.plugin.settings.qmdIndex = value.trim() || DEFAULT_SETTINGS.qmdIndex;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("QMD SDK module")
      .setDesc("Optional module path. Leave empty to import @tobilu/qmd or infer from QMD command.")
      .addText((text) => text
        .setPlaceholder("auto")
        .setValue(this.plugin.settings.qmdSdkModule)
        .onChange(async (value) => {
          this.plugin.settings.qmdSdkModule = value.trim();
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("QMD rerank")
      .setDesc("Off by default because Aha reranks after mixed retrieval and Relation Judge.")
      .addToggle((toggle) => toggle
        .setValue(this.plugin.settings.qmdRerank)
        .onChange(async (value) => {
          this.plugin.settings.qmdRerank = value;
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
