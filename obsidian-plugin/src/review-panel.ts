import { ItemView, Notice, TFile, WorkspaceLeaf } from "obsidian";
import {
  latestSelectedMemoriesRound,
  syncLatestSelectedMemoriesAndHandoff,
  type ReviewPanelCandidate,
  type SyncReviewSelectionResult,
} from "./review-note";

export const AHA_REVIEW_PANEL_VIEW_TYPE = "aha-review-panel";

export interface AhaReviewPanelContext {
  reviewFile: TFile;
  sourcePath: string;
  sourceTitle: string;
}

export interface AhaReviewPanelHost {
  openCandidateInNewTab(target: string): Promise<void>;
}

export class AhaReviewPanelView extends ItemView {
  private context: AhaReviewPanelContext | null = null;
  private candidates: ReviewPanelCandidate[] = [];
  private handoff = "";
  private countEl?: HTMLElement;
  private copyButton?: HTMLButtonElement;

  constructor(leaf: WorkspaceLeaf, private readonly host: AhaReviewPanelHost) {
    super(leaf);
    this.icon = "list-checks";
  }

  getViewType(): string {
    return AHA_REVIEW_PANEL_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "Aha Review Panel";
  }

  async setContext(context: AhaReviewPanelContext): Promise<void> {
    this.context = context;
    await this.refresh();
  }

  async refresh(): Promise<void> {
    if (!this.context) {
      this.renderEmpty("无 Review Note");
      return;
    }

    const content = await this.app.vault.read(this.context.reviewFile);
    const latest = latestSelectedMemoriesRound(content);
    if (!latest || latest.candidates.length === 0) {
      this.candidates = [];
      this.handoff = "";
      this.renderEmpty("无候选");
      return;
    }

    this.candidates = latest.candidates;
    this.handoff = syncLatestSelectedMemoriesAndHandoff(
      content,
      this.context.sourcePath,
      this.context.sourceTitle,
      this.selectionMap(),
    ).handoff;
    this.renderCandidates();
  }

  protected async onOpen(): Promise<void> {
    this.renderEmpty("无 Review Note");
  }

  protected async onClose(): Promise<void> {
    this.contentEl.empty();
  }

  private renderEmpty(message: string): void {
    this.contentEl.empty();
    const root = this.contentEl.createDiv({ cls: "aha-review-panel" });
    root.createEl("h2", { text: "Aha Review" });
    root.createDiv({ cls: "aha-review-panel-empty", text: message });
  }

  private renderCandidates(): void {
    this.contentEl.empty();
    const root = this.contentEl.createDiv({ cls: "aha-review-panel" });
    const header = root.createDiv({ cls: "aha-review-panel-header" });
    header.createEl("h2", { text: "Aha Review" });
    this.countEl = header.createDiv({ cls: "aha-review-panel-count" });
    this.updateCount();

    const table = root.createEl("table", { cls: "aha-review-panel-table" });
    const thead = table.createEl("thead");
    const headerRow = thead.createEl("tr");
    for (const heading of ["纳入", "旧笔记", "关系", "理由"]) {
      headerRow.createEl("th", { text: heading });
    }

    const tbody = table.createEl("tbody");
    for (const candidate of this.candidates) {
      const row = tbody.createEl("tr");
      this.renderSelectionCell(row, candidate);
      this.renderNoteCell(row, candidate);
      row.createEl("td", { text: candidate.relation, cls: "aha-review-panel-relation" });
      this.renderReasonCell(row, candidate);
    }

    const footer = root.createDiv({ cls: "aha-review-panel-footer" });
    this.copyButton = footer.createEl("button", {
      text: "复制 handoff",
      cls: "mod-cta",
      title: "复制当前勾选候选组成的 Grill Handoff",
    });
    this.copyButton.addEventListener("click", () => {
      void this.copyHandoff();
    });
  }

  private renderSelectionCell(row: HTMLTableRowElement, candidate: ReviewPanelCandidate): void {
    const cell = row.createEl("td", { cls: "aha-review-panel-select" });
    const checkbox = cell.createEl("input", {
      type: "checkbox",
      title: "纳入 handoff",
      attr: { "aria-label": `纳入 ${candidate.noteTitle ?? candidate.notePath}` },
    });
    checkbox.checked = candidate.selected;
    checkbox.addEventListener("change", () => {
      candidate.selected = checkbox.checked;
      this.updateCount();
      void this.persistSelections();
    });
  }

  private renderNoteCell(row: HTMLTableRowElement, candidate: ReviewPanelCandidate): void {
    const cell = row.createEl("td", { cls: "aha-review-panel-note" });
    const link = cell.createEl("a", {
      text: candidate.noteTitle?.trim() || candidate.notePath,
      href: "#",
      title: candidate.notePath,
    });
    link.addEventListener("click", (event) => {
      event.preventDefault();
      void this.host.openCandidateInNewTab(candidate.notePath);
    });
  }

  private renderReasonCell(row: HTMLTableRowElement, candidate: ReviewPanelCandidate): void {
    const cell = row.createEl("td", { cls: "aha-review-panel-reason" });
    cell.createDiv({ text: candidate.why || candidate.hit });
    if (!candidate.hit && candidate.quotes.length === 0) return;

    const details = cell.createEl("details", { cls: "aha-review-panel-hit" });
    details.createEl("summary", { text: "hit" });
    details.createDiv({ text: candidate.hit || candidate.quotes[0] });
  }

  private async persistSelections(): Promise<SyncReviewSelectionResult | null> {
    if (!this.context) return null;

    try {
      const content = await this.app.vault.read(this.context.reviewFile);
      const synced = syncLatestSelectedMemoriesAndHandoff(
        content,
        this.context.sourcePath,
        this.context.sourceTitle,
        this.selectionMap(),
      );
      await this.app.vault.modify(this.context.reviewFile, synced.content);
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
    const selected = this.candidates.filter((candidate) => candidate.selected).length;
    this.countEl.setText(`${selected} / ${this.candidates.length} 纳入`);
  }
}
