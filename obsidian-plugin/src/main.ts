import * as path from "path";
import {
  FileSystemAdapter,
  MarkdownView,
  Notice,
  Platform,
  Plugin,
  TFile,
  normalizePath,
} from "obsidian";
import { firstWikiLinkTarget, linkTargetBase } from "./wikilink";
import { AHA_REVIEW_PANEL_VIEW_TYPE, AhaReviewPanelView, type AhaReviewPanelContext } from "./review-panel";
import { canRunExternalProcesses, runAhaWrapper } from "./process";
import { AhaSettingTab, DEFAULT_SETTINGS, type AhaPluginSettings } from "./settings";
import { testProviderConnection } from "./llm-request";
import { probeQmdAvailable, runQmdStatus, parseQmdEnvironment } from "./qmd-request";
import { decideQmdBinaryLight, decideIndexCoverageLight, decideQmdEndpointsLight, decideLlmConnectivityLight } from "./health-checks";
import { validateAhaWrapperResult, type AhaWrapperResult } from "./schema";
import { sourceIdentityForFile } from "./source-identity";
import { AHA_COMMANDS } from "./commands";
import { runTieredSearch } from "./tier-pipeline";
import { createVaultReadNote } from "./vault-read";
import { CURRENT_SETTINGS_SCHEMA_VERSION, migrateAhaPluginSettings, shouldShowSimplificationNotice } from "./settings-migration";
import {
  appendSessionFeedback,
  createEmptySessionStore,
  normalizeSessionStore,
  recordFailedSessionRound,
  recordRunningSessionRound,
  recordSuccessfulSessionRound,
  sessionRecordKeyForSource,
  syncSessionSelections,
  type AhaSessionFeedbackInput,
  type AhaSessionRecord,
  type AhaSessionSourceInput,
  type AhaSessionStoreData,
  type SyncSessionSelectionResult,
} from "./session-store";

interface AhaPluginData {
  settings: AhaPluginSettings;
  sessionStore: AhaSessionStoreData;
  /**
   * Settings schema version marker (issue #59), absent on any data saved
   * before this field existed. Used only to decide whether the one-time
   * "settings simplified" notice has already been shown -- see
   * loadSettings() and settings-migration.ts's shouldShowSimplificationNotice.
   */
  schemaVersion?: number;
}

export default class AhaPlugin extends Plugin {
  settings: AhaPluginSettings = { ...DEFAULT_SETTINGS };
  sessionStore: AhaSessionStoreData = createEmptySessionStore();
  schemaVersion: number = CURRENT_SETTINGS_SCHEMA_VERSION;
  private statusBar?: HTMLElement;
  private activeRun?: { startedAt: number; sourcePath: string };
  private timerId?: number;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.addSettingTab(new AhaSettingTab(this.app, this));
    this.statusBar = this.addStatusBarItem();
    this.statusBar.setText("Aha idle");
    this.registerView(AHA_REVIEW_PANEL_VIEW_TYPE, (leaf) => new AhaReviewPanelView(leaf, this));

    this.addCommand({
      id: AHA_COMMANDS.checkReadiness.id,
      name: AHA_COMMANDS.checkReadiness.name,
      callback: () => {
        void this.checkReadiness();
      },
    });

    this.addCommand({
      id: AHA_COMMANDS.run.id,
      name: AHA_COMMANDS.run.name,
      checkCallback: (checking) => {
        const file = this.currentMarkdownFile();
        if (!file) return false;
        if (!checking) void this.searchFromCurrentNote(file);
        return true;
      },
    });

    this.addCommand({
      id: AHA_COMMANDS.openPanel.id,
      name: AHA_COMMANDS.openPanel.name,
      checkCallback: (checking) => {
        const file = this.currentMarkdownFile();
        if (!file) return false;
        if (!checking) void this.openReviewPanelForCurrentFile(file);
        return true;
      },
    });

    this.addCommand({
      id: AHA_COMMANDS.openCandidate.id,
      name: AHA_COMMANDS.openCandidate.name,
      editorCheckCallback: (checking, editor) => {
        const line = editor.getLine(editor.getCursor().line);
        const target = firstWikiLinkTarget(line);
        if (!target) return false;
        if (!checking) void this.openCandidateInNewTab(target);
        return true;
      },
    });

    this.registerEvent(this.app.workspace.on("file-open", (file) => {
      void this.followActiveFile(file);
    }));

    this.timerId = window.setInterval(() => this.updateStatusBar(), 1000);
    this.registerInterval(this.timerId);
  }

  // Settings migration + one-time simplification notice (issue #59). The
  // *notice* fires at most once per upgrade, guarded by schemaVersion: only
  // when the stored data predates CURRENT_SETTINGS_SCHEMA_VERSION (absent or
  // older) does this run migrateAhaPluginSettings against the raw old data
  // and bump/persist schemaVersion. On every subsequent load (schemaVersion
  // already current), a plain DEFAULT_SETTINGS merge is used instead --
  // deliberately NOT re-running migrateAhaPluginSettings on every load, even
  // though that function is itself pure/idempotent (see
  // settings-migration.ts's own idempotency guarantee and test coverage):
  // migrateAhaPluginSettings intentionally still carries the six legacy
  // qmdRemote* fields forward verbatim (for process.ts's frozen legacy
  // wrapper), so re-running it after schema-version bump would silently
  // resurrect a qmdEnvironment value from those stale fields even after a
  // user explicitly cleared the qmdEnvironment field by hand -- the version
  // guard is what prevents that regression.
  async loadSettings(): Promise<void> {
    const data = (await this.loadData()) as Partial<AhaPluginData> | null;
    const storedVersion = data?.schemaVersion;
    const needsMigrationNotice = shouldShowSimplificationNotice(storedVersion, CURRENT_SETTINGS_SCHEMA_VERSION);

    this.settings = needsMigrationNotice
      ? migrateAhaPluginSettings(data?.settings ?? {})
      : { ...DEFAULT_SETTINGS, ...(data?.settings ?? {}) };
    this.sessionStore = normalizeSessionStore(data?.sessionStore);
    this.schemaVersion = CURRENT_SETTINGS_SCHEMA_VERSION;

    if (needsMigrationNotice) {
      await this.saveSettings();
      new Notice(
        "Aha settings were simplified in this update: legacy fields were dropped or hidden, and the six QMD remote-endpoint fields were merged into one QMD environment field under Advanced. Open Settings > Aha to see the new layout.",
        15000,
      );
    }
  }

  async saveSettings(): Promise<void> {
    await this.saveData({
      settings: this.settings,
      sessionStore: this.sessionStore,
      schemaVersion: this.schemaVersion,
    });
  }

  private async checkReadiness(): Promise<void> {
    if (!this.assertDesktop()) return;

    try {
      const settings = this.settings;
      const vaultFileCount = this.app.vault.getMarkdownFiles().length;
      const [qmdAvailable, statusProbe, llmProbe] = await Promise.all([
        probeQmdAvailable(settings),
        runQmdStatus(settings),
        testProviderConnection(settings, "deepseek"),
      ]);
      const lights = [
        decideQmdBinaryLight(qmdAvailable),
        decideIndexCoverageLight(statusProbe, vaultFileCount, settings.qmdIndex),
        decideQmdEndpointsLight(parseQmdEnvironment(settings.qmdEnvironment), statusProbe, settings.qmdIndex),
        decideLlmConnectivityLight(llmProbe),
      ];
      const failed = lights.filter((l) => !l.ok);
      const message = failed.length === 0
        ? "Aha readiness passed."
        : `Aha readiness failed: ${failed.map((l) => `${l.label}: ${l.message}`).join("; ")}`;
      new Notice(message, failed.length === 0 ? 5000 : 10000);
      this.statusBar?.setText(failed.length === 0 ? "Aha ready" : "Aha readiness failed");
    } catch (error) {
      this.reportError("Aha readiness failed", error);
    }
  }

  private async searchFromCurrentNote(sourceFile: TFile): Promise<void> {
    if (!this.assertDesktop()) return;

    const startedAt = new Date();
    const source = await this.sessionSourceFor(sourceFile);
    recordRunningSessionRound(this.sessionStore, { startedAt, source });
    await this.saveSettings();

    this.activeRun = { startedAt: startedAt.getTime(), sourcePath: sourceFile.path };
    this.updateStatusBar();
    new Notice(`Aha search started: ${sourceFile.path}`, 8000);

    try {
      const payload = this.settings.useLegacyWrapper
        ? await runAhaWrapper(this.settings, {
            // No Review Note file is generated any more, so there is no
            // meaningful expected path here; the empty string just leaves
            // isGeneratedReviewCandidate's exact-path check inert (falsy
            // guard) and relies on the Aha/Reviews folder-level exclusion in
            // DEFAULT_EXCLUDED_CANDIDATE_FOLDERS instead.
            reviewPath: "",
            sourceAbsolutePath: this.absolutePathForFile(sourceFile),
            sourcePath: sourceFile.path,
            vaultRoot: this.vaultRoot(),
          })
        : (await this.runTieredSearchForFile(sourceFile, startedAt)).result;
      const validation = validateAhaWrapperResult(payload);
      if (!validation.ok || !validation.result) {
        throw new Error(`Malformed Aha result: ${validation.errors.join("; ")}`);
      }
      if (!validation.result.ok) {
        const failure = validation.result.error ?? { message: "Aha wrapper failed." };
        recordFailedSessionRound(this.sessionStore, {
          generatedAt: new Date(),
          source,
          failure,
        });
        await this.saveSettings();
        await this.openReviewPanel(this.reviewPanelContextForSource(source));
        new Notice(`Aha failed: ${failure.message}`, 10000);
        return;
      }

      recordSuccessfulSessionRound(this.sessionStore, {
        generatedAt: new Date(),
        result: validation.result,
        source,
      });
      await this.saveSettings();
      await this.openReviewPanel(this.reviewPanelContextForSource(source));
      new Notice(`Aha search completed: ${validation.result.candidates?.length ?? 0} candidates.`);
    } catch (error) {
      const details = error instanceof Error ? error.message : String(error);
      recordFailedSessionRound(this.sessionStore, {
        generatedAt: new Date(),
        source,
        failure: {
        message: "Aha wrapper failed before returning a valid structured result.",
        tool: "wrapper",
        details,
        },
      });
      await this.saveSettings();
      this.reportError("Aha search failed", error);
    } finally {
      this.activeRun = undefined;
      this.updateStatusBar();
    }
  }

  // Capability Tier engine entry point (issue #58): readiness pre-check ->
  // decideCapabilityTier -> Neighborhood/Recall/Full (with Full's Runtime
  // Tier Fallback), internalized with no external Node subprocess. The qmd
  // CLI probe and LLM profile resolution both re-run fresh on every call
  // (see tier-pipeline.ts / qmd-request.ts), so an environment repair
  // upgrades the tier on the next round without restarting Obsidian.
  private async runTieredSearchForFile(sourceFile: TFile, startedAt: Date): Promise<{ result: AhaWrapperResult }> {
    const sourceText = await this.app.vault.cachedRead(sourceFile);
    const vaultRoot = this.vaultRoot();
    const outcome = await runTieredSearch({
      settings: this.settings,
      sourceFile: { path: sourceFile.path, basename: sourceFile.basename },
      sourceText,
      sourceAbsolutePath: this.absolutePathForFile(sourceFile),
      vaultRoot,
      reviewPath: "",
      metadataCache: this.app.metadataCache,
      readNote: createVaultReadNote(this.app, vaultRoot),
    });
    return { result: outcome.result };
  }

  private async openReviewPanelForCurrentFile(file: TFile): Promise<void> {
    const context = await this.reviewPanelContextForFile(file);
    await this.openReviewPanel(context);
  }

  private async reviewPanelContextForFile(file: TFile): Promise<AhaReviewPanelContext> {
    return this.reviewPanelContextForSource(await this.sessionSourceFor(file));
  }

  private async openReviewPanel(context: AhaReviewPanelContext): Promise<void> {
    const leaf = this.app.workspace.getLeavesOfType(AHA_REVIEW_PANEL_VIEW_TYPE)[0]
      ?? this.app.workspace.getRightLeaf(false);
    if (!leaf) {
      new Notice("Aha could not open the review panel.", 8000);
      return;
    }
    await leaf.setViewState({ type: AHA_REVIEW_PANEL_VIEW_TYPE, active: true });
    await leaf.loadIfDeferred();
    await this.app.workspace.revealLeaf(leaf);
    if (leaf.view instanceof AhaReviewPanelView) {
      await leaf.view.setContext(context);
    }
  }

  loadSessionRecord(recordKey: string): AhaSessionRecord | null {
    return this.sessionStore.records[recordKey] ?? null;
  }

  async syncSessionSelections(recordKey: string, selectedByIndex: Map<number, boolean>): Promise<SyncSessionSelectionResult> {
    const record = this.sessionStore.records[recordKey];
    if (!record) throw new Error("No Aha Session Record exists for this source note.");
    const synced = syncSessionSelections(record, selectedByIndex);
    await this.saveSettings();
    return synced;
  }

  async recordSessionFeedback(recordKey: string, input: AhaSessionFeedbackInput): Promise<void> {
    const record = this.sessionStore.records[recordKey];
    if (!record) throw new Error("No Aha Session Record exists for this source note.");
    appendSessionFeedback(record, input);
    await this.saveSettings();
  }

  async runAhaForSourcePath(sourcePath: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(sourcePath);
    if (!(file instanceof TFile)) {
      new Notice(`Aha source note not found: ${sourcePath}`, 8000);
      return;
    }
    await this.searchFromCurrentNote(file);
  }

  private async followActiveFile(file: TFile | null): Promise<void> {
    if (!(file instanceof TFile) || file.extension.toLowerCase() !== "md") return;
    const leaves = this.app.workspace.getLeavesOfType(AHA_REVIEW_PANEL_VIEW_TYPE);
    if (leaves.length === 0) return;

    const context = await this.reviewPanelContextForFile(file);
    for (const leaf of leaves) {
      if (leaf.view instanceof AhaReviewPanelView && leaf.view.followsActiveFile()) {
        await leaf.view.setContext(context);
      }
    }
  }

  async openCandidateInNewTab(target: string): Promise<void> {
    const file = this.resolveCandidate(target);
    if (!file) {
      new Notice(`Aha could not find candidate note: ${target}`, 8000);
      return;
    }
    const leaf = this.app.workspace.getLeaf("tab");
    await leaf.openFile(file, { active: true });
  }

  private resolveCandidate(target: string): TFile | null {
    const normalized = normalizePath(linkTargetBase(target) || target);
    const exact = this.app.vault.getAbstractFileByPath(normalized) ?? this.app.vault.getAbstractFileByPath(`${normalized}.md`);
    if (exact instanceof TFile) return exact;

    const title = path.basename(normalized, ".md");
    const matches = this.app.vault.getMarkdownFiles().filter((file) => file.basename === title);
    if (matches.length > 1) {
      new Notice(`Aha candidate target is ambiguous: ${target}`, 8000);
      return null;
    }
    if (matches.length === 1) return matches[0];

    const linked = this.app.metadataCache.getFirstLinkpathDest(normalized, "");
    return linked instanceof TFile ? linked : null;
  }

  private currentMarkdownFile(): TFile | null {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    const file = view?.file ?? this.app.workspace.getActiveFile();
    if (!(file instanceof TFile) || file.extension.toLowerCase() !== "md") return null;
    return file;
  }

  private absolutePathForFile(file: TFile): string {
    return path.join(this.vaultRoot(), file.path);
  }

  private vaultRoot(): string {
    const adapter = this.app.vault.adapter;
    if (adapter instanceof FileSystemAdapter) return adapter.getBasePath();
    throw new Error("Aha requires a local filesystem-backed vault.");
  }

  private async sourceIdentityFor(sourceFile: TFile): Promise<string> {
    return sourceIdentityForFile(sourceFile, this.absolutePathForFile(sourceFile));
  }

  private async sessionSourceFor(sourceFile: TFile): Promise<AhaSessionSourceInput> {
    return {
      id: await this.sourceIdentityFor(sourceFile),
      path: sourceFile.path,
      title: sourceFile.basename,
      ctime: sourceFile.stat.ctime,
      mtime: sourceFile.stat.mtime,
      size: sourceFile.stat.size,
    };
  }

  private reviewPanelContextForSource(source: AhaSessionSourceInput): AhaReviewPanelContext {
    return {
      recordKey: sessionRecordKeyForSource(source.id, source.path),
      sourcePath: source.path,
      sourceTitle: source.title,
      sourceSnapshot: {
        path: source.path,
        ctime: source.ctime,
        mtime: source.mtime,
        size: source.size,
      },
    };
  }

  private assertDesktop(): boolean {
    if (!Platform.isDesktopApp || !canRunExternalProcesses()) {
      new Notice("Aha can only run external tools from Obsidian desktop.", 10000);
      return false;
    }
    return true;
  }

  private updateStatusBar(): void {
    if (!this.statusBar) return;
    if (!this.activeRun) {
      this.statusBar.setText("Aha idle");
      return;
    }
    const elapsed = Math.floor((Date.now() - this.activeRun.startedAt) / 1000);
    this.statusBar.setText(`Aha running ${elapsed}s`);
  }

  private reportError(prefix: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    new Notice(`${prefix}: ${message}`, 10000);
    this.statusBar?.setText("Aha failed");
  }
}
