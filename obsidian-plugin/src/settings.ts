import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type AhaPlugin from "./main";
import { runProviderConnectionCheck, type ApiProvider } from "./process";

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

  private providerTestSetting(provider: ApiProvider, label: string): void {
    new Setting(this.containerEl)
      .setName(`Test ${label}`)
      .setDesc(`Send a minimal JSON request to verify the configured ${label} key, endpoint, and model.`)
      .addButton((button) => button
        .setButtonText(`Test ${label}`)
        .onClick(async () => {
          button.setDisabled(true).setButtonText("Testing...");
          try {
            const result = await runProviderConnectionCheck(this.plugin.settings, provider);
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

    this.textSetting("ahaWorkspace", "Aha workspace", "Absolute path to the local Aha repository that contains scripts/aha/run-insight-search.mjs.", { placeholder: "/path/to/Aha", keepEmpty: true });
    this.textSetting("reviewFolder", "Review note location", "Vault-relative folder for Aha Review Notes.");
    this.textSetting("nodeCommand", "Node command", "Optional absolute path to Node.js. Leave empty to auto-detect common desktop install paths.", { placeholder: "auto", keepEmpty: true });

    new Setting(containerEl)
      .setName("LLM provider")
      .setDesc("Choose the provider used for query planning and Relation Judge. Provider profiles remain stored separately when switching.")
      .addDropdown((dropdown) => dropdown
        .addOption("openai", "OpenAI API")
        .addOption("deepseek", "DeepSeek API")
        .addOption("codex-cli", "Codex CLI")
        .setValue(this.plugin.settings.llmProvider)
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

    containerEl.createEl("h3", { text: "Codex fallback" });
    this.textSetting("codexCommand", "Codex command", "Fallback command used only when LLM provider is Codex CLI.");

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

    this.textSetting("codexModel", "Codex model", "Fallback Codex CLI model.");

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

    this.textSetting("qmdCommand", "QMD command", "QMD CLI fallback and SDK module inference path.");
    this.textSetting("qmdIndex", "QMD index", "QMD index and collection name used for the Obsidian vault.");
    this.textSetting("qmdSdkModule", "QMD SDK module", "Optional module path. Leave empty to import @tobilu/qmd or infer from QMD command.", { placeholder: "auto", keepEmpty: true });
    this.textSetting("qmdRemoteEmbedUrl", "QMD remote embed URL", "Optional OpenAI-compatible embedding endpoint injected into the QMD SDK child process.", { placeholder: "inherit environment", keepEmpty: true });
    this.textSetting("qmdRemoteEmbedModel", "QMD remote embed model", "Model name used by the remote embedding endpoint.", { placeholder: "inherit environment", keepEmpty: true });
    this.textSetting("qmdRemoteGenerateUrl", "QMD remote generate URL", "Optional query-expansion endpoint injected into the QMD SDK child process.", { placeholder: "inherit environment", keepEmpty: true });
    this.textSetting("qmdRemoteGenerateModel", "QMD remote generate model", "Model name used by the remote query-expansion endpoint.", { placeholder: "inherit environment", keepEmpty: true });
    this.textSetting("qmdRemoteRerankUrl", "QMD remote rerank URL", "Optional rerank endpoint injected into the QMD SDK child process.", { placeholder: "inherit environment", keepEmpty: true });
    this.textSetting("qmdRemoteRerankModel", "QMD remote rerank model", "Model name used by the remote rerank endpoint.", { placeholder: "inherit environment", keepEmpty: true });

    new Setting(containerEl)
      .setName("QMD rerank")
      .setDesc("Off by default because Aha reranks after mixed retrieval and Relation Judge.")
      .addToggle((toggle) => toggle
        .setValue(this.plugin.settings.qmdRerank)
        .onChange(async (value) => {
          this.plugin.settings.qmdRerank = value;
          await this.plugin.saveSettings();
        }));

    this.textSetting("obsidianCommand", "Obsidian CLI command", "Command or absolute path used for backlink/outlink expansion and vault checks.");
    this.textSetting("wrapperRelativePath", "Search runner script", "Path to the local retrieval and relation-judging runner, relative to the Aha workspace.");

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
