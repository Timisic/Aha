import { Prec, StateEffect, StateField, type Extension, type Text } from "@codemirror/state";
import { isolateHistory } from "@codemirror/commands";
import { EditorView, ViewPlugin, showTooltip, type Rect } from "@codemirror/view";
import { FileSystemAdapter, TFile, editorInfoField, type App, type Editor } from "obsidian";
import { excludedFoldersFromSettings, mergeAndRankQueryResults } from "./core";
import { captureQuickLinkContext, quickLinkInsertion, quickWikiLink, type QuickLinkContext } from "./quick-link-context";
import { createExcerptReranker } from "./excerpt-rerank-request";
import { excludesQuickLinkNote, extractExcerptDocument, excerptText, selectExcerpts, type ExcerptDocument, type ExcerptPick } from "./quick-link-excerpts";
import { runQmdQuickRecall } from "./qmd-request";
import type { AhaPluginSettings } from "./settings";
import { createVaultBoundaryDeps } from "./vault-boundary";

interface Capture extends QuickLinkContext {
  readonly editor: Editor;
  readonly file: TFile;
  readonly sourcePath: string;
  readonly doc: Text;
  readonly request: AbortController;
}

interface Candidate {
  readonly file: TFile;
  readonly title: string;
  readonly excerpt: {
    readonly text: string;
    readonly method: ExcerptPick["method"];
    readonly coverage: ExcerptPick["coverage"];
  } | null;
}

type PopupState =
  | { kind: "closed" }
  | { kind: "loading"; capture: Capture }
  | { kind: "ready"; capture: Capture; candidates: Candidate[]; highlighted: number; checked: ReadonlySet<string> }
  | { kind: "message"; capture: Capture; message: string };

export class QuickLinks {
  readonly extension: Extension;
  private readonly views = new Set<EditorView>();
  private readonly change = StateEffect.define<PopupState>();
  private readonly field: StateField<PopupState>;
  private active: { view: EditorView; capture: Capture; removeOutside: () => void } | null = null;

  constructor(private readonly app: App, private readonly settings: () => AhaPluginSettings) {
    this.field = StateField.define<PopupState>({
      create: () => ({ kind: "closed" }),
      update: (state, transaction) => {
        if (transaction.docChanged || !transaction.startState.selection.eq(transaction.state.selection)) return { kind: "closed" };
        for (const effect of transaction.effects) if (effect.is(this.change)) return effect.value;
        return state;
      },
      provide: (field) => showTooltip.from(field, (state) => state.kind === "closed" ? null : {
        pos: state.capture.insertOffset,
        above: false,
        strictSide: false,
        create: (view) => {
          const dom = view.dom.ownerDocument.createElement("div");
          dom.className = "aha-quick-links";
          const render = () => this.render(view, dom);
          render();
          return { dom, update: render, positioned: (space) => this.fitPopup(dom, space) };
        },
      }),
    });
    this.extension = [
      this.field,
      ViewPlugin.define((view) => {
        this.views.add(view);
        return {
          update: () => {
            if (this.active?.view === view && view.state.field(this.field).kind === "closed") this.release();
          },
          destroy: () => {
            this.views.delete(view);
            if (this.active?.view === view) this.release();
          },
        };
      }),
      Prec.highest(EditorView.domEventHandlers({ keydown: (event, view) => this.keydown(event, view) })),
    ];
  }

  open(editor: Editor, file: TFile | null): void {
    this.close();
    if (!file) return;
    const view = [...this.views].find((candidate) => candidate.state.field(editorInfoField, false)?.editor === editor);
    if (!view) return;
    const selection = view.state.selection.main;
    const capture: Capture = {
      ...captureQuickLinkContext(view.state.doc.toString(), selection.anchor, selection.head),
      editor, file, sourcePath: file.path, doc: view.state.doc, request: new AbortController(),
    };
    const document = view.dom.ownerDocument;
    const outside = (event: MouseEvent) => {
      if (!event.composedPath().some((node) => node instanceof document.defaultView!.Element && node.classList.contains("aha-quick-links"))) this.close();
    };
    document.addEventListener("mousedown", outside, true);
    this.active = { view, capture, removeOutside: () => document.removeEventListener("mousedown", outside, true) };
    this.show(view, capture.query
      ? { kind: "loading", capture }
      : { kind: "message", capture, message: "选中文字，或先写一段话。" });
    if (capture.query) void this.recall(view, capture);
  }

  close(): void {
    const active = this.active;
    this.release();
    if (active && this.views.has(active.view)) active.view.dispatch({ effects: this.change.of({ kind: "closed" }) });
  }

  private release(): void {
    this.active?.capture.request.abort();
    this.active?.removeOutside();
    this.active = null;
  }

  private show(view: EditorView, state: Exclude<PopupState, { kind: "closed" }>): void {
    let announcement: string;
    if (state.kind === "ready") {
      const candidate = state.candidates[state.highlighted];
      if (!candidate) return;
      const checked = state.checked.has(candidate.file.path) ? "已勾选" : "未勾选";
      announcement = `${candidate.title}，第 ${state.highlighted + 1} 条，共 ${state.candidates.length} 条，${checked}。`;
    } else {
      announcement = state.kind === "loading" ? "查找相关笔记…" : state.message;
    }
    view.dispatch({ effects: [this.change.of(state), EditorView.announce.of(announcement)] });
  }

  private isCurrent(view: EditorView, capture: Capture): boolean {
    return this.active?.capture === capture && !capture.request.signal.aborted &&
      view.state.doc === capture.doc && capture.file.path === capture.sourcePath &&
      this.app.workspace.activeEditor?.editor === capture.editor &&
      view.state.field(editorInfoField, false)?.file === capture.file;
  }

  private async recall(view: EditorView, capture: Capture): Promise<void> {
    try {
      const adapter = this.app.vault.adapter;
      if (!(adapter instanceof FileSystemAdapter)) throw new Error("Desktop vault required.");
      const settings = this.settings();
      const rows = await runQmdQuickRecall(settings, capture.query, capture.request.signal);
      const vaultRoot = adapter.getBasePath();
      const boundary = createVaultBoundaryDeps();
      const sourceRealPath = await boundary.realpath(boundary.path.resolve(vaultRoot, capture.sourcePath));
      const pooled = await mergeAndRankQueryResults(
        { vaultRoot, sourcePath: capture.sourcePath },
        [{ query: { kind: "semantic", command: "qmd query" }, rows }],
        { excludedFolders: excludedFoldersFromSettings(settings.excludedFolders), vaultRootPrefix: vaultRoot },
        boundary,
      );
      if (!this.isCurrent(view, capture)) return;
      const candidates: Candidate[] = [];
      const documents: ExcerptDocument[] = [];
      const seen = new Set<string>([sourceRealPath]);
      for (const candidate of pooled) {
        if (excludesQuickLinkNote(candidate.notePath)) continue;
        const file = this.app.vault.getAbstractFileByPath(candidate.notePath);
        if (!(file instanceof TFile) || file.extension.toLowerCase() !== "md" || file.path === capture.sourcePath) continue;
        if (!quickWikiLink(this.app.metadataCache.fileToLinktext(file, capture.sourcePath, true))) continue;
        const realPath = await boundary.realpath(boundary.path.resolve(vaultRoot, file.path)).catch(() => "");
        if (!realPath || seen.has(realPath)) continue;
        seen.add(realPath);
        const source = await this.app.vault.cachedRead(file);
        if (!this.isCurrent(view, capture)) return;
        const document = extractExcerptDocument(file.path, source);
        if (!document) continue;
        documents.push(document);
        candidates.push({ file, title: file.basename, excerpt: null });
        if (candidates.length === 4) break;
      }
      if (!this.isCurrent(view, capture)) return;
      if (!candidates.length) {
        this.show(view, { kind: "message", capture, message: "没有找到可插入的相关笔记。" });
        return;
      }
      this.show(view, { kind: "ready", capture, candidates, highlighted: 0, checked: new Set() });
      const picks = await selectExcerpts(capture.query, documents, createExcerptReranker(settings.qmdEnvironment), capture.request.signal);
      if (!this.isCurrent(view, capture)) return;
      const excerpts = candidates.map((candidate, index) => {
        const pick = picks[index];
        return { ...candidate, excerpt: { text: pick.span ? excerptText(documents[index], pick.span) : "",
          method: pick.method, coverage: pick.coverage } };
      });
      const state = view.state.field(this.field);
      if (state.kind === "ready" && state.capture === capture) this.show(view, { ...state, candidates: excerpts });
    } catch (error) {
      if (!this.isCurrent(view, capture)) return;
      const timedOut = error instanceof Error && error.message.includes("timed out after");
      this.show(view, { kind: "message", capture,
        message: timedOut ? "检索超时，请稍后重试。" : "QMD 暂时不可用，请检查 Aha 设置。" });
    }
  }

  private keydown(event: KeyboardEvent, view: EditorView): boolean {
    const state = view.state.field(this.field);
    if (state.kind === "closed" || event.isComposing || event.metaKey || event.ctrlKey || event.altKey) return false;
    if (event.key === "Escape") this.close();
    else if (state.kind === "ready" && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
      const direction = event.key === "ArrowDown" ? 1 : -1;
      const highlighted = (state.highlighted + direction + state.candidates.length) % state.candidates.length;
      this.show(view, { ...state, highlighted });
      const list = view.dom.ownerDocument.querySelector<HTMLElement>(".aha-quick-links-list");
      const row = list?.children.item(highlighted);
      if (list && row && row instanceof view.dom.ownerDocument.defaultView!.HTMLElement) {
        const top = row.getBoundingClientRect().top - list.getBoundingClientRect().top + list.scrollTop;
        if (row.clientHeight > list.clientHeight || top < list.scrollTop) list.scrollTop = top;
        else if (top + row.clientHeight > list.scrollTop + list.clientHeight) list.scrollTop = top + row.clientHeight - list.clientHeight;
      }
    } else if (state.kind === "ready" && (event.key === "PageDown" || event.key === "PageUp")) {
      const list = view.dom.ownerDocument.querySelector<HTMLElement>(".aha-quick-links-list");
      if (list) list.scrollTop += (event.key === "PageDown" ? 1 : -1) * list.clientHeight;
    } else if (state.kind === "ready" && event.key === " ") this.toggle(view, state.highlighted);
    else if (state.kind === "ready" && event.key === "Enter") this.insert(view, state);
    else return false;
    event.preventDefault();
    return true;
  }

  private toggle(view: EditorView, index: number): void {
    const state = view.state.field(this.field);
    if (state.kind !== "ready") return;
    const candidate = state.candidates[index];
    if (!candidate) return;
    const checked = new Set(state.checked);
    if (checked.has(candidate.file.path)) checked.delete(candidate.file.path);
    else checked.add(candidate.file.path);
    this.show(view, { ...state, highlighted: index, checked });
  }

  private insert(view: EditorView, state: Extract<PopupState, { kind: "ready" }>): void {
    const { capture } = state;
    if (!this.isCurrent(view, capture)) { this.close(); return; }
    const chosen = state.checked.size
      ? state.candidates.filter((candidate) => state.checked.has(candidate.file.path))
      : state.candidates.slice(state.highlighted, state.highlighted + 1);
    if (chosen.some(({ file }) => this.app.vault.getAbstractFileByPath(file.path) !== file)) { this.close(); return; }
    const links: string[] = [];
    for (const { file } of chosen) {
      const link = quickWikiLink(this.app.metadataCache.fileToLinktext(file, capture.sourcePath, true));
      if (!link) { this.close(); return; }
      links.push(link);
    }
    const insert = quickLinkInsertion(capture.document, capture.insertOffset, links);
    this.close();
    view.dispatch({
      changes: { from: capture.insertOffset, insert },
      selection: { anchor: capture.insertOffset + insert.length },
      annotations: isolateHistory.of("full"),
      userEvent: "input.aha-quick-links",
    });
    view.focus();
  }

  private render(view: EditorView, dom: HTMLElement): void {
    const scrollTop = dom.querySelector<HTMLElement>(".aha-quick-links-list")?.scrollTop ?? 0;
    dom.replaceChildren();
    const state = view.state.field(this.field);
    if (state.kind === "closed") return;
    dom.dataset.excerptsPending = String(state.kind === "loading" ||
      (state.kind === "ready" && state.candidates.some((candidate) => candidate.excerpt === null)));
    const document = dom.ownerDocument;
    const close = document.createElement("button");
    close.className = "aha-quick-links-close";
    close.textContent = "×";
    close.setAttribute("aria-label", "取消插入双链");
    close.tabIndex = -1;
    close.addEventListener("mousedown", (event) => event.preventDefault());
    close.addEventListener("click", () => this.close());
    dom.append(close);
    if (state.kind === "ready") {
      const list = document.createElement("div");
      list.className = "aha-quick-links-list";
      list.setAttribute("role", "listbox");
      list.setAttribute("aria-label", "相关笔记");
      list.setAttribute("aria-multiselectable", "true");
      list.setAttribute("aria-busy", String(state.candidates.some((candidate) => candidate.excerpt === null)));
      for (const [index, candidate] of state.candidates.entries()) {
        const row = document.createElement("div");
        row.className = "aha-quick-link-option";
        row.classList.toggle("is-highlighted", state.highlighted === index);
        row.dataset.path = candidate.file.path;
        row.dataset.excerptMethod = candidate.excerpt?.method ?? "pending";
        row.dataset.excerptCoverage = candidate.excerpt?.coverage ?? "pending";
        row.setAttribute("role", "option");
        row.setAttribute("aria-selected", String(state.checked.has(candidate.file.path)));
        const check = document.createElement("span");
        check.className = "aha-quick-link-check";
        check.textContent = state.checked.has(candidate.file.path) ? "✓" : "";
        check.setAttribute("aria-hidden", "true");
        const text = document.createElement("span");
        text.className = "aha-quick-link-text";
        const title = document.createElement("span");
        title.className = "aha-quick-link-title";
        title.textContent = candidate.title;
        text.append(title);
        if (state.candidates.some((other, otherIndex) => otherIndex !== index && other.title === candidate.title)) {
          const path = document.createElement("span");
          path.className = "aha-quick-link-path";
          path.textContent = candidate.file.parent?.path ?? "";
          title.append(path);
        }
        const excerpt = document.createElement("span");
        excerpt.className = candidate.excerpt?.method === "none" ? "aha-quick-link-excerpt-status" : "aha-quick-link-excerpt";
        excerpt.textContent = candidate.excerpt?.method === "none" ? "暂无匹配原文" : candidate.excerpt?.text ?? "";
        text.append(excerpt);
        row.append(check, text);
        row.addEventListener("mousedown", (event) => event.preventDefault());
        row.addEventListener("click", () => this.toggle(view, index));
        list.append(row);
      }
      dom.append(list);
      list.scrollTop = scrollTop;
    } else {
      const message = document.createElement("div");
      message.className = "aha-quick-links-message";
      message.textContent = state.kind === "loading" ? "查找相关笔记…" : state.message;
      dom.append(message);
    }
    const footer = document.createElement("div");
    footer.className = "aha-quick-links-footer";
    footer.textContent = state.kind === "ready"
      ? `${state.candidates.some((candidate) => candidate.excerpt === null) ? "原文提取中 · " : ""}↑↓ 移动 · 空格 多选 · Enter 插入 · Esc 取消`
      : "Esc 取消";
    dom.append(footer);
    const list = dom.querySelector<HTMLElement>(".aha-quick-links-list");
    if (list && list.scrollHeight > list.clientHeight) footer.textContent += " · PgUp/PgDn 阅读";
  }

  private fitPopup(dom: HTMLElement, space: Rect): void {
    const window = dom.ownerDocument.defaultView;
    if (!window) return;
    const viewport = window.visualViewport;
    let left = Math.max(space.left, viewport?.offsetLeft ?? 0);
    let top = Math.max(space.top, viewport?.offsetTop ?? 0);
    let right = Math.min(space.right, (viewport?.offsetLeft ?? 0) + (viewport?.width ?? window.innerWidth));
    let bottom = Math.min(space.bottom, (viewport?.offsetTop ?? 0) + (viewport?.height ?? window.innerHeight));
    for (let ancestor = dom.parentElement; ancestor; ancestor = ancestor.parentElement) {
      const style = window.getComputedStyle(ancestor);
      const clipX = /^(?:hidden|clip|auto|scroll)$/.test(style.overflowX);
      const clipY = /^(?:hidden|clip|auto|scroll)$/.test(style.overflowY);
      if (!clipX && !clipY) continue;
      const box = ancestor.getBoundingClientRect();
      const scaleX = ancestor.offsetWidth ? box.width / ancestor.offsetWidth : 1;
      const scaleY = ancestor.offsetHeight ? box.height / ancestor.offsetHeight : 1;
      if (clipX) {
        const edge = box.left + ancestor.clientLeft * scaleX;
        left = Math.max(left, edge);
        right = Math.min(right, edge + ancestor.clientWidth * scaleX);
      }
      if (clipY) {
        const edge = box.top + ancestor.clientTop * scaleY;
        top = Math.max(top, edge);
        bottom = Math.min(bottom, edge + ancestor.clientHeight * scaleY);
      }
    }
    if (right <= left || bottom <= top) return;
    const before = dom.getBoundingClientRect();
    const popupStyle = window.getComputedStyle(dom);
    const width = parseFloat(popupStyle.width) || dom.offsetWidth;
    const height = parseFloat(popupStyle.height) || dom.offsetHeight;
    const scaleX = width ? before.width / width : 1;
    const scaleY = height ? before.height / height : 1;
    dom.style.maxWidth = `${(right - left) / scaleX}px`;
    dom.style.maxHeight = `${(bottom - top) / scaleY}px`;
    const fitted = dom.getBoundingClientRect();
    const fittedLeft = Math.max(left, Math.min(fitted.left, right - fitted.width));
    const fittedTop = Math.max(top, Math.min(fitted.top, bottom - fitted.height));
    dom.style.left = `${parseFloat(dom.style.left) + (fittedLeft - fitted.left) / scaleX}px`;
    dom.style.top = `${parseFloat(dom.style.top) + (fittedTop - fitted.top) / scaleY}px`;
  }
}
