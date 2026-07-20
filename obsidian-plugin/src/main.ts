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
import { appendReviewBenchmarkSeed, appendSuccessfulSearchRound, makeReviewFileName, makeReviewNoteContent, reviewFolderPath, reviewNoteMatchesSource, reviewSourcePathFromContent, setReviewNoteStatus } from "./review-note";
import { firstWikiLinkTarget, linkTargetBase } from "./wikilink";
import { AHA_REVIEW_PANEL_VIEW_TYPE, AhaReviewPanelView, type AhaReviewPanelContext } from "./review-panel";
import { canRunExternalProcesses, runAhaWrapper, runReadinessCheck } from "./process";
import { AhaSettingTab, DEFAULT_SETTINGS, type AhaPluginSettings } from "./settings";
import { validateAhaWrapperResult, type AhaWrapperResult } from "./schema";
import { legacySourceIdentity, sourceIdentityForFile, sourceReviewIndexKey } from "./source-identity";
import { AHA_COMMANDS } from "./commands";
import { runTieredSearch } from "./tier-pipeline";
import { createVaultReadNote } from "./vault-read";
import {
  appendSessionFeedback,
  createEmptySessionStore,
  normalizeSessionStore,
  recordFailedSessionRound,
  recordRunningSessionRound,
  recordSuccessfulSessionRound,
  resultForSessionRound,
  reviewSeedInputForSessionFeedback,
  sessionRecordKeyForSource,
  syncSessionSelections,
  latestSuccessfulRound,
  type AhaSessionFeedbackInput,
  type AhaSessionRecord,
  type AhaSessionRound,
  type AhaSessionSourceInput,
  type AhaSessionStoreData,
  type SyncSessionSelectionResult,
} from "./session-store";

interface AhaPluginData {
  settings: AhaPluginSettings;
  reviewIndex: Record<string, string>;
  sessionStore: AhaSessionStoreData;
}

export default class AhaPlugin extends Plugin {
  settings: AhaPluginSettings = { ...DEFAULT_SETTINGS };
  reviewIndex: Record<string, string> = {};
  sessionStore: AhaSessionStoreData = createEmptySessionStore();
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
      id: AHA_COMMANDS.exportReviewNote.id,
      name: AHA_COMMANDS.exportReviewNote.name,
      checkCallback: (checking) => {
        const file = this.currentMarkdownFile();
        if (!file) return false;
        if (!checking) void this.exportReviewNoteForCurrentFile(file);
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

  async loadSettings(): Promise<void> {
    const data = (await this.loadData()) as Partial<AhaPluginData> | null;
    this.settings = { ...DEFAULT_SETTINGS, ...(data?.settings ?? {}) };
    this.reviewIndex = data?.reviewIndex ?? {};
    this.sessionStore = normalizeSessionStore(data?.sessionStore);
  }

  async saveSettings(): Promise<void> {
    await this.saveData({
      settings: this.settings,
      reviewIndex: this.reviewIndex,
      sessionStore: this.sessionStore,
    });
  }

  private async checkReadiness(): Promise<void> {
    if (!this.assertDesktop()) return;

    try {
      const result = await runReadinessCheck(this.settings);
      const failed = result.checks.filter((check) => !check.ok);
      const message = failed.length === 0
        ? "Aha readiness passed."
        : `Aha readiness failed: ${failed.map((check) => `${check.name}: ${check.message}`).join("; ")}`;
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
            reviewPath: this.expectedReviewPathFor(sourceFile, startedAt),
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
      reviewPath: this.expectedReviewPathFor(sourceFile, startedAt),
      metadataCache: this.app.metadataCache,
      readNote: createVaultReadNote(this.app, vaultRoot),
    });
    return { result: outcome.result };
  }

  private async ensureReviewNote(sourceFile: TFile): Promise<TFile> {
    const sourceId = await this.sourceIdentityFor(sourceFile);
    const existingPath = this.reviewIndex[sourceReviewIndexKey(sourceId, sourceFile.path)]
      ?? this.reviewIndex[legacySourceIdentity(sourceFile.path)]
      ?? this.reviewIndex[sourceFile.path];
    const existing = existingPath ? await this.verifiedReviewNote(existingPath, sourceId, sourceFile.path) : null;
    if (existing instanceof TFile) {
      await this.rememberReviewNote(sourceId, sourceFile.path, existing.path);
      return existing;
    }

    const scanned = await this.findReviewNoteForSource(sourceId, sourceFile.path);
    if (scanned) {
      await this.rememberReviewNote(sourceId, sourceFile.path, scanned.path);
      return scanned;
    }

    const folder = reviewFolderPath(this.settings.reviewFolder);
    await this.ensureFolder(folder);
    const createdAt = new Date();
    const basePath = normalizePath(`${folder}/${makeReviewFileName(sourceFile.basename, createdAt)}`);
    const reviewPath = await this.uniqueReviewPath(basePath, sourceFile.path);
    const content = makeReviewNoteContent({
      createdAt,
      sourceId,
      sourcePath: sourceFile.path,
      sourceTitle: sourceFile.basename,
    });
    const file = await this.app.vault.create(reviewPath, content);
    await this.rememberReviewNote(sourceId, sourceFile.path, reviewPath);
    return file;
  }

  private async openReviewForSource(sourceFile: TFile): Promise<void> {
    const file = await this.findExistingReviewNoteForSource(sourceFile);
    if (!(file instanceof TFile)) {
      new Notice("No Aha Review Note exists for this source note yet.");
      return;
    }
    await this.openFile(file, false);
  }

  private async exportReviewNoteForCurrentFile(file: TFile): Promise<void> {
    const context = await this.reviewPanelContextForFile(file);
    const record = this.sessionStore.records[context.recordKey];
    const round = record ? latestSuccessfulRound(record) : null;
    if (!record || !round) {
      new Notice("No Aha Session Record with candidates exists for this source note yet.");
      return;
    }

    const sourceFile = this.app.vault.getAbstractFileByPath(context.sourcePath);
    const sourceId = sourceFile instanceof TFile ? await this.sourceIdentityFor(sourceFile) : record.source.id;
    const folder = reviewFolderPath(this.settings.reviewFolder);
    await this.ensureFolder(folder);
    const createdAt = new Date();
    const basePath = normalizePath(`${folder}/${makeReviewFileName(context.sourceTitle, createdAt)}`);
    const reviewPath = await this.uniqueReviewPath(basePath, context.sourcePath);
    const content = this.renderReviewNoteExport(record, round, sourceId, context, createdAt);
    const reviewFile = await this.app.vault.create(reviewPath, content);
    await this.rememberReviewNote(sourceId, context.sourcePath, reviewPath);
    await this.openFile(reviewFile, false);
    new Notice(`Aha Review Note exported: ${reviewPath}`, 8000);
  }

  private async markReviewNoteGrilled(file: TFile): Promise<void> {
    const content = await this.app.vault.cachedRead(file);
    const reviewFile = reviewSourcePathFromContent(content) ? file : await this.findExistingReviewNoteForSource(file);
    if (!(reviewFile instanceof TFile)) {
      new Notice("No Aha Review Note exists for this note yet.");
      return;
    }
    const reviewContent = await this.app.vault.read(reviewFile);
    await this.app.vault.modify(reviewFile, setReviewNoteStatus(reviewContent, "grilled"));
    new Notice(`Review note marked as grilled: ${reviewFile.path}`);
  }

  private async openReviewPanelForCurrentFile(file: TFile): Promise<void> {
    const context = await this.reviewPanelContextForFile(file);
    await this.openReviewPanel(context);
  }

  private async reviewPanelContextForFile(file: TFile): Promise<AhaReviewPanelContext> {
    const reviewContent = await this.app.vault.cachedRead(file);
    const reviewSourcePath = reviewSourcePathFromContent(reviewContent);
    if (reviewSourcePath) {
      const sourceFile = this.app.vault.getAbstractFileByPath(reviewSourcePath);
      const source = sourceFile instanceof TFile
        ? await this.sessionSourceFor(sourceFile)
        : {
            id: legacySourceIdentity(reviewSourcePath),
            path: reviewSourcePath,
            title: this.sourceTitleForPath(reviewSourcePath),
          };
      return this.reviewPanelContextForSource(source);
    }

    return this.reviewPanelContextForSource(await this.sessionSourceFor(file));
  }

  private renderReviewNoteExport(
    record: AhaSessionRecord,
    round: AhaSessionRound,
    sourceId: string,
    context: AhaReviewPanelContext,
    createdAt: Date,
  ): string {
    let content = makeReviewNoteContent({
      createdAt,
      sourceId,
      sourcePath: context.sourcePath,
      sourceTitle: context.sourceTitle,
    });
    content = appendSuccessfulSearchRound(content, {
      generatedAt: new Date(round.generatedAt),
      result: resultForSessionRound(round),
      sourcePath: context.sourcePath,
      sourceTitle: context.sourceTitle,
    });

    for (const feedback of record.feedback) {
      const seedInput = reviewSeedInputForSessionFeedback(feedback);
      if (seedInput) content = appendReviewBenchmarkSeed(content, seedInput);
    }
    return content;
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

  private async findExistingReviewNoteForSource(sourceFile: TFile): Promise<TFile | null> {
    const sourceId = await this.sourceIdentityFor(sourceFile);
    const reviewPath = this.reviewIndex[sourceReviewIndexKey(sourceId, sourceFile.path)]
      ?? this.reviewIndex[legacySourceIdentity(sourceFile.path)]
      ?? this.reviewIndex[sourceFile.path];
    let file = reviewPath ? await this.verifiedReviewNote(reviewPath, sourceId, sourceFile.path) : null;
    if (!(file instanceof TFile)) {
      file = await this.findReviewNoteForSource(sourceId, sourceFile.path);
    }
    if (!(file instanceof TFile)) {
      return null;
    }
    await this.rememberReviewNote(sourceId, sourceFile.path, file.path);
    return file;
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

  private async openFile(file: TFile, newTab: boolean): Promise<void> {
    const leaf = this.app.workspace.getLeaf(newTab ? "tab" : false);
    await leaf.openFile(file, { active: true });
  }

  private async ensureFolder(folder: string): Promise<void> {
    const parts = folder.split("/").filter(Boolean);
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (!this.app.vault.getAbstractFileByPath(current)) {
        await this.app.vault.createFolder(current);
      }
    }
  }

  private async uniqueReviewPath(basePath: string, sourcePath: string): Promise<string> {
    if (!this.app.vault.getAbstractFileByPath(basePath)) return basePath;
    const suffix = stableSuffix(sourcePath);
    const withoutExtension = basePath.replace(/\.md$/i, "");
    const suffixed = `${withoutExtension}-${suffix}.md`;
    if (!this.app.vault.getAbstractFileByPath(suffixed)) return suffixed;

    for (let index = 2; index < 100; index += 1) {
      const candidate = `${withoutExtension}-${suffix}-${index}.md`;
      if (!this.app.vault.getAbstractFileByPath(candidate)) return candidate;
    }
    throw new Error("Could not create a unique Aha Review Note path.");
  }

  private absolutePathForFile(file: TFile): string {
    return path.join(this.vaultRoot(), file.path);
  }

  private vaultRoot(): string {
    const adapter = this.app.vault.adapter;
    if (adapter instanceof FileSystemAdapter) return adapter.getBasePath();
    throw new Error("Aha requires a local filesystem-backed vault.");
  }

  private async rememberReviewNote(sourceId: string, sourcePath: string, reviewPath: string): Promise<void> {
    this.reviewIndex[sourceReviewIndexKey(sourceId, sourcePath)] = reviewPath;
    this.reviewIndex[legacySourceIdentity(sourcePath)] = reviewPath;
    delete this.reviewIndex[sourceId];
    delete this.reviewIndex[sourcePath];
    await this.saveSettings();
  }

  private async findReviewNoteForSource(sourceId: string, sourcePath: string): Promise<TFile | null> {
    const folder = reviewFolderPath(this.settings.reviewFolder);
    const reviewFiles = this.app.vault.getMarkdownFiles()
      .filter((file) => file.path.startsWith(`${folder}/`) || file.path === folder);
    const matches: TFile[] = [];
    for (const file of reviewFiles) {
      try {
        const content = await this.app.vault.cachedRead(file);
        if (reviewNoteMatchesSource(content, sourceId, sourcePath)) matches.push(file);
      } catch {
        // Ignore unreadable notes and keep scanning the review folder.
      }
    }
    return matches.length === 1 ? matches[0] : null;
  }

  private async verifiedReviewNote(reviewPath: string, sourceId: string, sourcePath: string): Promise<TFile | null> {
    const file = this.app.vault.getAbstractFileByPath(reviewPath);
    if (!(file instanceof TFile)) return null;
    try {
      const content = await this.app.vault.cachedRead(file);
      if (reviewNoteMatchesSource(content, sourceId, sourcePath)) return file;
    } catch {
      return null;
    }
    return null;
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

  private expectedReviewPathFor(sourceFile: TFile, createdAt: Date): string {
    const folder = reviewFolderPath(this.settings.reviewFolder);
    return normalizePath(`${folder}/${makeReviewFileName(sourceFile.basename, createdAt)}`);
  }

  private sourceTitleForPath(sourcePath: string): string {
    const file = this.app.vault.getAbstractFileByPath(sourcePath);
    if (file instanceof TFile) return file.basename;
    return path.basename(sourcePath, ".md");
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

function stableSuffix(value: string): string {
  let hash = 0;
  for (const char of value) {
    hash = Math.imul(31, hash) + char.charCodeAt(0) | 0;
  }
  return Math.abs(hash).toString(36).slice(0, 6);
}
