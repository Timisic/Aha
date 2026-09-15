import { App, ItemView, Modal, Notice, Setting, TFile, WorkspaceLeaf, setIcon } from "obsidian";
import { candidateHit } from "./core/candidate-hit";
import { savedReviewActions } from "./review-feedback";
import { savedThoughtMarkdown, savedThoughtText, type SavedThought } from "./saved-thoughts";
import { renderThoughtEditor } from "./thought-editor";
import {
  handoffForRound,
  latestSuccessfulRound,
  staleStateForRound,
  type AhaSessionFeedbackInput,
  type AhaSessionRecord,
  type AhaSessionSourceSnapshot,
  type SyncSessionSelectionResult,
} from "./session-store";
import {
  type ReviewBenchmarkSeedAction,
  type ReviewPanelCandidate,
} from "./review-note";
import { markdownFilePathForLink, noteDisplayTitleFromPath } from "./wikilink";

export const AHA_REVIEW_PANEL_VIEW_TYPE = "aha-review-panel";

const SEED_BUTTON_TITLE: Record<Exclude<ReviewBenchmarkSeedAction, "should_have_found">, string> = {
  surprise: "保存这次发现，并记下你的想法",
  accept: "保存为草稿 nice-to-have seed，不会自动标记 must-recall",
  reject_as_noise: "保存为草稿 negative seed，不会自动启用负例标签",
};

export interface AhaReviewPanelContext {
  recordKey: string;
  sourcePath: string;
  sourceTitle: string;
  sourceSnapshot?: AhaSessionSourceSnapshot;
}

export interface AhaReviewPanelHost {
  openCandidateInNewTab(target: string): Promise<void>;
  loadSessionRecord(recordKey: string): AhaSessionRecord | null;
  syncSessionSelections(recordKey: string, selectedByIndex: Map<number, boolean>): Promise<SyncSessionSelectionResult>;
  recordSessionFeedback(recordKey: string, input: AhaSessionFeedbackInput): Promise<void>;
  listSavedThoughts(): SavedThought[];
  saveThought(recordKey: string, feedbackId: string, note: string): Promise<void>;
  runAhaForSourcePath(sourcePath: string): Promise<void>;
}

export class AhaReviewPanelView extends ItemView {
  private context: AhaReviewPanelContext | null = null;
  private candidates: ReviewPanelCandidate[] = [];
  private handoff = "";
  private status = "";
  private stale = false;
  private fallbackWarning = "";
  private traceStatus = "";
  private pendingFeedback = new Set<string>();
  private pinned = false;
  private showingSaved = false;
  private savedQuery = "";
  private thoughtDrafts = new Map<string, string>();
  private countEl?: HTMLElement;
  private copyButton?: HTMLButtonElement;

  constructor(leaf: WorkspaceLeaf, private readonly host: AhaReviewPanelHost) {
    super(leaf);
    this.icon = "network";
  }

  getViewType(): string {
    return AHA_REVIEW_PANEL_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "Aha";
  }

  async setContext(context: AhaReviewPanelContext): Promise<void> {
    this.context = context;
    await this.refresh();
  }

  followsActiveFile(): boolean {
    return !this.pinned && !this.showingSaved;
  }

  async refresh(): Promise<void> {
    if (this.showingSaved) {
      this.renderSaved();
      return;
    }
    this.traceStatus = "";
    if (!this.context) {
      this.stale = false;
      this.renderEmpty("未选择 source note");
      return;
    }

    const record = this.host.loadSessionRecord(this.context.recordKey);
    if (!record) {
      this.candidates = [];
      this.handoff = "";
      this.status = "";
      this.stale = false;
      this.renderEmpty("还没有 Aha 历史", { showRunAction: true });
      return;
    }

    const latestRun = record.rounds.at(-1);
    this.traceStatus = latestRun?.trace
      ? `Pipeline trace saved: ${latestRun.trace.path}`
      : latestRun?.warnings?.find(w => w.startsWith("Pipeline trace ")) ?? "";
    this.status = latestRun?.status ?? "";
    const latest = latestSuccessfulRound(record);
    if (!latest || latest.candidates.length === 0) {
      this.candidates = [];
      this.handoff = "";
      this.stale = false;
      this.renderEmpty("无候选", { showRunAction: true, showMissingMemorySeed: true });
      return;
    }

    this.candidates = latest.candidates;
    this.handoff = handoffForRound(record, latest);
    this.stale = staleStateForRound(latest, this.context.sourceSnapshot).stale;
    this.fallbackWarning = latest.error ? "Relation Judge 未能运行，当前显示的是基础检索结果" : "";
    this.renderCandidates();
  }

  protected async onOpen(): Promise<void> {
    this.stale = false;
    this.renderEmpty("未选择 source note");
  }

  protected async onClose(): Promise<void> {
    this.contentEl.empty();
  }

  private renderEmpty(message: string, options: { showRunAction?: boolean; showMissingMemorySeed?: boolean } = {}): void {
    this.contentEl.empty();
    const root = this.contentEl.createDiv({ cls: "aha-review-panel" });
    this.renderHeader(root, { showPin: true });
    this.renderTraceStatus(root);
    root.createDiv({ cls: "aha-review-panel-empty", text: message });
    if (!this.context) return;

    const footer = root.createDiv({ cls: "aha-review-panel-footer" });
    if (options.showRunAction) this.renderRunButton(footer);
    if (options.showMissingMemorySeed) this.renderMissingMemorySeedButton(footer);
  }

  private renderHeader(root: HTMLElement, options: { showRun?: boolean; showMissingMemorySeed?: boolean; showPin?: boolean } = {}): void {
    const header = root.createDiv({ cls: "aha-review-panel-header" });
    const title = header.createDiv({ cls: "aha-review-panel-title" });
    title.createEl("h2", { text: "Aha" });
    if (this.context) {
      const sourcePath = this.context.sourcePath;
      const sourceLink = title.createEl("a", {
        text: this.context.sourceTitle,
        href: "#",
        title: sourcePath,
        cls: "aha-review-panel-source-link",
      });
      sourceLink.addEventListener("click", (event) => {
        event.preventDefault();
        void this.host.openCandidateInNewTab(sourcePath);
      });
    }
    this.countEl = title.createDiv({ cls: "aha-review-panel-count" });
    this.updateCount();
    const actions = header.createDiv({ cls: "aha-review-panel-actions" });
    const saved = actions.createEl("button", { text: "已保存", cls: "aha-review-panel-seed-button", attr: { "aria-label": "查看已保存的 Surprise" } });
    saved.addEventListener("click", () => {
      this.showingSaved = true;
      this.renderSaved();
    });
    if (!this.context) return;
    if (options.showRun) this.renderRunButton(actions, "rerun Aha");
    if (options.showMissingMemorySeed) this.renderMissingMemorySeedButton(actions);
    if (options.showPin) this.renderPinButton(actions);
  }

  private renderCandidates(): void {
    this.contentEl.empty();
    const root = this.contentEl.createDiv({ cls: "aha-review-panel" });
    this.renderHeader(root, { showRun: true, showMissingMemorySeed: true, showPin: true });
    this.renderStaleCue(root);
    this.renderFallbackWarning(root);
    this.renderTraceStatus(root);

    const table = root.createDiv({ cls: "aha-review-panel-table", attr: { role: "table" } });
    const headerRow = table.createDiv({ cls: "aha-review-panel-row aha-review-panel-head", attr: { role: "row" } });
    for (const heading of ["纳入", "旧笔记", "关系", "理由"]) {
      headerRow.createDiv({ text: heading, cls: "aha-review-panel-cell aha-review-panel-heading", attr: { role: "columnheader" } });
    }

    const body = table.createDiv({ cls: "aha-review-panel-body", attr: { role: "rowgroup" } });
    for (const candidate of this.candidates) {
      const row = body.createDiv({ cls: "aha-review-panel-row", attr: { role: "row" } });
      this.renderSelectionCell(row, candidate);
      this.renderMemoryCell(row, candidate);
      this.renderRelationCell(row, candidate);
      this.renderReasonCell(row, candidate);
    }

    const footer = root.createDiv({ cls: "aha-review-panel-footer" });
    this.copyButton = footer.createEl("button", {
      text: "复制 Grill Handoff",
      cls: "aha-review-panel-copy",
      title: "复制当前勾选候选组成的 Grill Handoff",
    });
    this.copyButton.addEventListener("click", () => {
      void this.copyHandoff();
    });
  }

  private renderStaleCue(root: HTMLElement): void {
    if (!this.context || !this.stale) return;
    const cue = root.createDiv({ cls: "aha-review-panel-stale" });
    cue.createSpan({ text: "源笔记已更新" });
  }

  private renderTraceStatus(root: HTMLElement): void {
    if (!this.traceStatus) return;
    const details = root.createEl("details", { cls: "aha-review-panel-hit" });
    details.createEl("summary", { text: this.traceStatus.startsWith("Pipeline trace saved:") ? "Trace 已保存" : "Trace 保存失败" });
    details.createDiv({ text: this.traceStatus });
    if (this.traceStatus.startsWith("Pipeline trace write failed:")) details.open = true;
  }

  private renderFallbackWarning(root: HTMLElement): void {
    if (!this.fallbackWarning) return;
    const warning = root.createDiv({ cls: "aha-review-panel-stale" });
    warning.createSpan({ text: this.fallbackWarning });
  }

  private renderRunButton(parent: HTMLElement, text = "运行 Aha"): HTMLButtonElement {
    const runButton = parent.createEl("button", {
      text,
      cls: "aha-review-panel-run",
      title: "为当前 source note 运行 Aha",
    });
    runButton.addEventListener("click", () => {
      if (!this.context) return;
      void this.host.runAhaForSourcePath(this.context.sourcePath);
    });
    return runButton;
  }

  private renderPinButton(parent: HTMLElement): HTMLButtonElement {
    const pinButton = parent.createEl("button", {
      cls: "aha-review-panel-icon-button",
      title: this.pinned ? "跟随当前笔记" : "固定当前笔记",
      attr: { "aria-label": this.pinned ? "跟随当前笔记" : "固定当前笔记" },
    });
    setIcon(pinButton, this.pinned ? "pin-off" : "pin");
    pinButton.addEventListener("click", () => {
      this.pinned = !this.pinned;
      void this.refresh();
    });
    return pinButton;
  }

  private renderMissingMemorySeedButton(parent: HTMLElement): HTMLButtonElement {
    const missingButton = parent.createEl("button", {
      text: "record must",
      cls: "aha-review-panel-seed-button",
      title: "Record a draft must-recall seed for a missing memory",
    });
    missingButton.addEventListener("click", () => {
      void this.recordMissingMemorySeed();
    });
    return missingButton;
  }

  private renderSelectionCell(row: HTMLElement, candidate: ReviewPanelCandidate): void {
    const cell = row.createDiv({ cls: "aha-review-panel-cell aha-review-panel-select", attr: { role: "cell" } });
    const displayTitle = this.displayTitleFor(candidate);
    const checkbox = cell.createEl("input", {
      type: "checkbox",
      title: "纳入 handoff",
      attr: { "aria-label": `纳入 ${displayTitle}` },
    });
    checkbox.checked = candidate.selected;
    checkbox.addEventListener("change", () => {
      candidate.selected = checkbox.checked;
      this.updateCount();
      void this.persistSelections();
    });
  }

  private renderMemoryCell(row: HTMLElement, candidate: ReviewPanelCandidate): void {
    const cell = row.createDiv({ cls: "aha-review-panel-cell aha-review-panel-memory", attr: { role: "cell" } });
    const displayTitle = this.displayTitleFor(candidate);
    const link = cell.createEl("a", {
      text: displayTitle,
      href: "#",
      title: candidate.notePath,
      cls: "aha-review-panel-note-link",
    });
    link.addEventListener("click", (event) => {
      event.preventDefault();
      void this.host.openCandidateInNewTab(candidate.notePath);
    });
  }

  private renderRelationCell(row: HTMLElement, candidate: ReviewPanelCandidate): void {
    const cell = row.createDiv({ cls: "aha-review-panel-cell aha-review-panel-relation", attr: { role: "cell" } });
    cell.setText(candidate.relation);
  }

  private renderReasonCell(row: HTMLElement, candidate: ReviewPanelCandidate): void {
    const cell = row.createDiv({ cls: "aha-review-panel-cell aha-review-panel-reason", attr: { role: "cell" } });
    cell.createDiv({ text: candidate.why || candidate.hit, cls: "aha-review-panel-reason-text" });
    this.renderSeedActions(cell, candidate);
    const thought = cell.createDiv({ cls: "aha-inline-thought" });
    this.renderCandidateThought(thought, candidate);
    const hit = candidateHit(candidate);
    if (!hit) return;

    const details = cell.createEl("details", { cls: "aha-review-panel-hit" });
    details.createEl("summary", { text: "hit" });
    details.createDiv({ text: hit });
  }

  private renderSeedActions(cell: HTMLElement, candidate: ReviewPanelCandidate): void {
    const actions = cell.createDiv({ cls: "aha-review-panel-seed-actions" });
    this.renderSeedButton(actions, "surprise", "surprise", candidate);
    this.renderSeedButton(actions, "accept", "accept", candidate);
    this.renderSeedButton(actions, "reject_as_noise", "noise", candidate);
  }

  private renderSeedButton(parent: HTMLElement, action: Exclude<ReviewBenchmarkSeedAction, "should_have_found">, text: string, candidate: ReviewPanelCandidate): void {
    const button = parent.createEl("button", {
      text,
      cls: "aha-review-panel-seed-button",
      title: SEED_BUTTON_TITLE[action],
      attr: { "data-action": action },
    });
    this.updateSeedButton(button, action, candidate);
    button.addEventListener("click", async () => {
      if (!this.context) return;
      if (button.getAttribute("aria-pressed") === "true") {
        if (action === "surprise") parent.parentElement?.querySelector<HTMLTextAreaElement>(".aha-thought-input")?.focus();
        return;
      }
      const recordKey = this.context.recordKey;
      const pendingKey = `${recordKey}\n${candidate.notePath}`;
      if (this.pendingFeedback.has(pendingKey)) return;
      this.pendingFeedback.add(pendingKey);
      parent.querySelectorAll("button").forEach(b => { b.disabled = true; });
      button.setAttribute("aria-busy", "true");
      try {
        const saved = await this.recordCandidateSeed(action, candidate);
        if (saved && this.context?.recordKey === recordKey) {
          parent.querySelectorAll<HTMLButtonElement>("button[data-action]").forEach(b => {
            this.updateSeedButton(b, b.dataset.action as typeof action, candidate);
          });
          if (action === "surprise") {
            const target = parent.parentElement?.querySelector<HTMLElement>(".aha-inline-thought");
            if (target) this.renderCandidateThought(target, candidate)?.focus();
          }
        }
      } finally {
        this.pendingFeedback.delete(pendingKey);
        parent.querySelectorAll("button").forEach(b => { b.disabled = false; });
        button.removeAttribute("aria-busy");
      }
    });
  }

  private updateSeedButton(button: HTMLButtonElement, action: Exclude<ReviewBenchmarkSeedAction, "should_have_found">, candidate: ReviewPanelCandidate): void {
    const record = this.context ? this.host.loadSessionRecord(this.context.recordKey) : null;
    const marked = savedReviewActions(record?.feedback ?? [], candidate.notePath).has(action);
    button.classList.toggle("is-marked", marked);
    button.setAttribute("aria-pressed", String(marked));
    button.setText(`${marked ? "✓ " : ""}${action === "reject_as_noise" ? "noise" : action}`);
    button.title = marked ? action === "surprise" ? "已保存，点击继续写想法" : "已标注并保存，重复点击不会再次记录" : SEED_BUTTON_TITLE[action];
  }

  private async recordCandidateSeed(action: Exclude<ReviewBenchmarkSeedAction, "should_have_found">, candidate: ReviewPanelCandidate): Promise<boolean> {
    if (!this.context) return false;
    try {
      await this.host.recordSessionFeedback(this.context.recordKey, {
        action,
        createdAt: new Date(),
        sourcePath: this.context.sourcePath,
        sourceTitle: this.context.sourceTitle,
        candidate,
      });
      if (action === "reject_as_noise") {
        candidate.selected = false;
        this.updateCount();
      }
      if (action !== "surprise") new Notice(`已记录 ${action} 草稿 seed。`, 3000);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      new Notice(`Aha seed 写回失败：${message}`, 8000);
      return false;
    }
  }

  private renderCandidateThought(parent: HTMLElement, candidate: ReviewPanelCandidate): HTMLTextAreaElement | undefined {
    parent.empty();
    const entry = this.host.listSavedThoughts().find(item => item.recordKey === this.context?.recordKey && item.feedback.memory === candidate.notePath);
    if (!entry) return;
    return renderThoughtEditor(parent, entry, this.thoughtDrafts, (item, note) => this.host.saveThought(item.recordKey, item.feedbackId, note));
  }

  private renderSaved(): void {
    this.contentEl.empty();
    const root = this.contentEl.createDiv({ cls: "aha-review-panel aha-saved" });
    const header = root.createDiv({ cls: "aha-saved-header" });
    const back = header.createEl("button", { text: "返回结果", cls: "aha-review-panel-seed-button" });
    back.addEventListener("click", () => {
      this.showingSaved = false;
      void this.refresh();
    });
    header.createEl("h2", { text: "已保存" });
    const entries = this.host.listSavedThoughts();
    header.createSpan({ text: `${entries.length} 条`, cls: "aha-thought-status" });
    const search = root.createEl("input", {
      cls: "aha-saved-search", type: "search",
      attr: { placeholder: "查找想法或笔记", "aria-label": "查找已保存的想法" },
    });
    search.value = this.savedQuery;
    const list = root.createDiv({ cls: "aha-saved-list" });
    const renderList = () => {
      list.empty();
      const query = this.savedQuery.trim().toLocaleLowerCase();
      const filtered = entries.filter(({ feedback }) => [savedThoughtText(feedback), feedback.sourceTitle, feedback.sourcePath, feedback.memory, feedback.why, feedback.hit].some(value => value?.toLocaleLowerCase().includes(query)));
      if (!filtered.length) {
        list.createDiv({ cls: "aha-review-panel-empty", text: entries.length ? "没有匹配的记录" : "遇到有价值的连接时，点一下 Surprise，就会留在这里。" });
      }
      for (const entry of filtered) this.renderSavedEntry(list, entry);
    };
    search.addEventListener("input", () => { this.savedQuery = search.value; renderList(); });
    renderList();
  }

  private renderSavedEntry(parent: HTMLElement, entry: SavedThought): void {
    const item = { ...entry.feedback, note: savedThoughtText(entry.feedback) };
    const article = parent.createEl("article", { cls: "aha-saved-entry" });
    const meta = article.createDiv({ cls: "aha-saved-meta" });
    const date = new Date(item.createdAt);
    meta.createEl("time", { text: Number.isNaN(date.getTime()) ? item.createdAt : date.toLocaleDateString("zh-CN"), attr: { datetime: item.createdAt } });
    const links = article.createDiv({ cls: "aha-saved-links" });
    this.renderSavedLink(links, item.sourcePath, item.sourceTitle);
    links.createSpan({ text: "×", attr: { "aria-label": "关联" } });
    this.renderSavedLink(links, item.memory ?? "", noteDisplayTitleFromPath(item.memory ?? ""));
    const thought = article.createDiv({ cls: "aha-saved-thought", text: item.note || "还没有写下想法" });
    thought.classList.toggle("is-empty", !item.note);
    const editor = article.createDiv();
    const context = article.createEl("details", { cls: "aha-saved-context" });
    context.createEl("summary", { text: "当时的连接与原文" });
    context.createDiv({ cls: "aha-saved-caption", text: "AI 解释" });
    context.createDiv({ text: item.why || "未保留解释", cls: "aha-saved-prose" });
    if (item.hit) {
      context.createDiv({ cls: "aha-saved-caption", text: "历史原文" });
      context.createEl("blockquote", { text: item.hit });
    }
    if (item.sourceExcerpt) {
      context.createDiv({ cls: "aha-saved-caption", text: "保存时的当前笔记 · 节选" });
      context.createEl("blockquote", { text: item.sourceExcerpt });
    }
    const actions = article.createDiv({ cls: "aha-saved-actions" });
    const edit = actions.createEl("button", { text: item.note ? "编辑想法" : "补充想法", cls: "aha-review-panel-seed-button" });
    edit.addEventListener("click", () => {
      editor.empty();
      thought.hidden = true;
      edit.hidden = true;
      renderThoughtEditor(editor, entry, this.thoughtDrafts, async (target, note) => {
        await this.host.saveThought(target.recordKey, target.feedbackId, note);
        // This snapshot also feeds search and copy without refreshing the list.
        target.feedback.note = note.trim() || undefined;
        thought.setText(target.feedback.note || "还没有写下想法");
        thought.classList.toggle("is-empty", !target.feedback.note);
      }).focus();
    });
    const copy = actions.createEl("button", { text: "复制 Markdown", cls: "aha-review-panel-seed-button" });
    copy.addEventListener("click", async () => {
      try {
        const latest = this.host.listSavedThoughts().find(value => value.recordKey === entry.recordKey && value.feedbackId === entry.feedbackId) ?? entry;
        await navigator.clipboard.writeText(savedThoughtMarkdown(latest));
        new Notice("已复制想法与出处。", 2000);
      } catch {
        new Notice("复制失败，请重试。", 3000);
      }
    });
    if (this.thoughtDrafts.has(JSON.stringify([entry.recordKey, entry.feedbackId]))) edit.click();
  }

  private renderSavedLink(parent: HTMLElement, path: string, title: string): void {
    const link = parent.createEl("a", { text: title, href: "#", attr: { title: path } });
    link.addEventListener("click", event => {
      event.preventDefault();
      void this.host.openCandidateInNewTab(path);
    });
  }

  private recordMissingMemorySeed(): void {
    if (!this.context) return;
    new MissingMemoryPromptModal(this.app, (missingMemory) => {
      if (!missingMemory) return;
      void this.appendMissingMemorySeed(missingMemory);
    }).open();
  }

  private async appendMissingMemorySeed(missingMemory: string): Promise<void> {
    if (!this.context) return;
    try {
      await this.host.recordSessionFeedback(this.context.recordKey, {
        action: "should_have_found",
        createdAt: new Date(),
        sourcePath: this.context.sourcePath,
        sourceTitle: this.context.sourceTitle,
        missingMemory,
      });
      new Notice("已记录 should_have_found 草稿 seed。", 3000);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      new Notice(`Aha seed 写回失败：${message}`, 8000);
    }
  }

  private async persistSelections(): Promise<SyncSessionSelectionResult | null> {
    if (!this.context) return null;

    try {
      const synced = await this.host.syncSessionSelections(this.context.recordKey, this.selectionMap());
      this.candidates = synced.candidates;
      this.handoff = synced.handoff;
      this.updateCount();
      return synced;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      new Notice(`Aha panel 写回失败：${message}`, 8000);
      return null;
    }
  }

  private async copyHandoff(): Promise<void> {
    const synced = await this.persistSelections();
    const handoff = synced?.handoff ?? this.handoff;
    if (!handoff.trim()) {
      new Notice("没有可复制的 handoff。", 5000);
      return;
    }

    try {
      await navigator.clipboard.writeText(handoff);
      new Notice("已复制 handoff。", 3000);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      new Notice(`复制失败：${message}`, 8000);
    }
  }

  private selectionMap(): Map<number, boolean> {
    return new Map(this.candidates.map((candidate) => [candidate.index, candidate.selected]));
  }

  private updateCount(): void {
    if (!this.countEl) return;
    const stalePrefix = this.stale ? "已过期 · " : "";
    const statusPrefix = this.status ? `${this.status} · ` : "";
    if (this.candidates.length === 0) {
      this.countEl.setText(`${stalePrefix}${this.status}`.trim());
      return;
    }
    const selected = this.candidates.filter((candidate) => candidate.selected).length;
    this.countEl.setText(`${stalePrefix}${statusPrefix}${selected} / ${this.candidates.length} 纳入`);
  }

  private displayTitleFor(candidate: ReviewPanelCandidate): string {
    const filePath = markdownFilePathForLink(candidate.notePath);
    const file = this.app.vault.getAbstractFileByPath(filePath);
    return file instanceof TFile ? file.basename : noteDisplayTitleFromPath(candidate.notePath);
  }
}

class MissingMemoryPromptModal extends Modal {
  private value = "";

  constructor(app: App, private readonly onSubmit: (value: string) => void) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText("记录 should-have-found");
    new Setting(this.contentEl)
      .setName("应该找到哪条旧记忆？")
      .setDesc("输入 Obsidian 路径或 [[链接]]。")
      .addText((text) => {
        text.onChange((value) => {
          this.value = value;
        });
        text.inputEl.addEventListener("keydown", (event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            this.submit();
          }
        });
        text.inputEl.focus();
      });
    new Setting(this.contentEl)
      .addButton((button) => button
        .setButtonText("保存")
        .setCta()
        .onClick(() => this.submit()));
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private submit(): void {
    this.close();
    this.onSubmit(this.value.trim());
  }
}
