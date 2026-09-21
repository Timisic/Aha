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
import { AhaSettingTab, DEFAULT_SETTINGS, type AhaPluginSettings } from "./settings";
import { testProviderConnection } from "./llm-request";
import { canRunExternalProcesses, probeQmdAvailable, runQmdStatus, parseQmdEnvironment } from "./qmd-request";
import { decideQmdBinaryLight, decideIndexCoverageLight, decideQmdEndpointsLight, decideLlmConnectivityLight } from "./health-checks";
import { validateAhaWrapperResult, type AhaWrapperResult } from "./schema";
import { sourceIdentityForFile } from "./source-identity";
import { AHA_COMMANDS } from "./commands";
import { savedThoughts, updateSavedThought, type SavedThought } from "./saved-thoughts";
import { applyThoughtNoteWrite, thoughtNoteBlock, type ThoughtNoteWrite } from "./thought-note";
import { runTieredSearch } from "./tier-pipeline";
import { createVaultReadNote } from "./vault-read";
import { CURRENT_SETTINGS_SCHEMA_VERSION, migrateAhaPluginSettings, shouldShowSimplificationNotice } from "./settings-migration";
import {
  appendSessionFeedback,
  latestSuccessfulRound,
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
  private feedbackWrite: Promise<void> = Promise.resolve();

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
  // and persist the new schema version. Session records are normalized separately.
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
    const operation = this.feedbackWrite.then(() => this.saveData({
      settings: this.settings,
      sessionStore: this.sessionStore,
      schemaVersion: this.schemaVersion,
    }));
    this.feedbackWrite = operation.catch(() => {});
    await operation;
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
      const payload = (await this.runTieredSearchForFile(sourceFile, startedAt)).result;
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
          trace: validation.result.trace,
          warnings: validation.result.warnings,
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
    // Capture source text at save time; old records never acquire invented context.
    if (input.action === "surprise") {
      const file = this.app.vault.getAbstractFileByPath(input.sourcePath);
      if (file instanceof TFile) {
        const text = await this.app.vault.cachedRead(file);
        input = { ...input, sourceExcerpt: text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "").slice(0, 3500) };
      }
    }
    const snapshot = input;
    await this.writeFeedback(recordKey, record => {
      if (snapshot.action === "surprise" && record.feedback.some(item => item.action === "surprise" && item.memory === snapshot.candidate?.notePath)) return;
      appendSessionFeedback(record, snapshot);
    });
  }

  listSavedThoughts(): SavedThought[] {
    return savedThoughts(this.sessionStore);
  }

  async saveThought(recordKey: string, feedbackId: string, note: string): Promise<void> {
    const operation = this.feedbackWrite.then(async () => {
      const record = this.sessionStore.records[recordKey];
      if (!record) throw new Error("当前笔记的记录不存在，文字已保留。");
      const entry = savedThoughts(this.sessionStore).find(item => item.recordKey === recordKey && item.feedbackId === feedbackId);
      if (!entry?.feedback.memory) throw new Error("这条 Surprise 不存在，文字已保留。");
      const feedback = entry.feedback;
      // Use the source associated with this result, never whichever tab is active.
      const sourcePath = feedback.noteWrite?.path ?? record.source.path;
      const file = this.app.vault.getAbstractFileByPath(sourcePath);
      if (!(file instanceof TFile) || file.extension !== "md") throw new Error("当前笔记不存在或已移动，请先打开原笔记；文字已保留。");
      // Reconcile an interrupted save before accepting another edit. This is a
      // write-ahead journal: a failed data.json write cannot cause a duplicate.
      if (feedback.noteWrite?.status === "pending") {
        await this.app.vault.process(file, content => applyThoughtNoteWrite(content, feedback.noteWrite!));
      }
      const write: ThoughtNoteWrite = {
        path: sourcePath,
        block: thoughtNoteBlock(feedback.memory!, note),
        previousBlock: feedback.noteWrite?.block,
        status: "pending",
      };
      // Check conflicts before persisting intent, and again inside vault.process.
      applyThoughtNoteWrite(await this.app.vault.read(file), write);
      const next = structuredClone(record);
      const nextEntry = savedThoughts({ schemaVersion: 1, records: { [recordKey]: next } }).find(item => item.feedbackId === feedbackId)!;
      nextEntry.feedback.id = feedbackId;
      nextEntry.feedback.noteWrite = write;
      await this.persistFeedbackRecord(record, next);
      await this.app.vault.process(file, content => applyThoughtNoteWrite(content, write));
      const completed = structuredClone(record);
      updateSavedThought(completed, feedbackId, note, new Date());
      const completedEntry = completed.feedback.find(item => item.id === feedbackId)!;
      completedEntry.noteWrite = { path: sourcePath, block: write.block, status: "saved" };
      await this.persistFeedbackRecord(record, completed);
    });
    this.feedbackWrite = operation.catch(() => {});
    return operation;
  }

  private async persistFeedbackRecord(record: AhaSessionRecord, next: AhaSessionRecord): Promise<void> {
    await this.saveData({
      settings: this.settings,
      schemaVersion: this.schemaVersion,
      sessionStore: { ...this.sessionStore, records: { ...this.sessionStore.records, [record.key]: next } },
    });
    record.feedback = next.feedback;
    record.updatedAt = next.updatedAt;
  }

  private writeFeedback(recordKey: string, mutate: (record: AhaSessionRecord) => void): Promise<void> {
    const operation = this.feedbackWrite.then(async () => {
      const record = this.sessionStore.records[recordKey];
      if (!record) throw new Error("No Aha Session Record exists for this source note.");
      const next = structuredClone(record);
      mutate(next);
      // Commit the in-memory feedback only after persistence succeeds. A failed
      // save must remain retryable and must not show a successful Surprise mark.
      const added = next.feedback.length > record.feedback.length ? next.feedback.at(-1) : undefined;
      await this.persistFeedbackRecord(record, next);
      if (added?.action === "reject_as_noise") {
        const candidate = latestSuccessfulRound(record)?.candidates.find(item => item.notePath === added.memory);
        if (candidate) candidate.selected = false;
      }
    });
    this.feedbackWrite = operation.catch(() => {});
    return operation;
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
