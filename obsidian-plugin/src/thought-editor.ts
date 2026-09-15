import { savedThoughtText, type SavedThought } from "./saved-thoughts";

/** Shared inline editor; drafts survive panel navigation until explicitly saved. */
export function renderThoughtEditor(
  parent: HTMLElement,
  entry: SavedThought,
  drafts: Map<string, string>,
  save: (entry: SavedThought, note: string) => Promise<void>,
): HTMLTextAreaElement {
  const key = JSON.stringify([entry.recordKey, entry.feedbackId]);
  let savedText = savedThoughtText(entry.feedback);
  let writtenToNote = entry.feedback.noteWrite?.status === "saved";
  const editor = parent.createDiv({ cls: "aha-thought-editor" });
  const label = editor.createEl("label", { text: "我的想法", cls: "aha-thought-label" });
  const input = label.createEl("textarea", {
    cls: "aha-thought-input",
    attr: { rows: "3", placeholder: "这个连接让你想到了什么？", "aria-label": "我的想法" },
  });
  input.value = drafts.get(key) ?? savedText;
  const actions = editor.createDiv({ cls: "aha-thought-actions" });
  const button = actions.createEl("button", { text: "保存", cls: "aha-review-panel-seed-button" });
  const status = actions.createSpan({ cls: "aha-thought-status", attr: { role: "status", "aria-live": "polite" } });
  let saving = false;
  const update = () => {
    const dirty = input.value !== savedText || (!writtenToNote && (!!input.value.trim() || entry.feedback.noteWrite?.status === "pending"));
    button.disabled = saving || !dirty;
    status.setText(saving ? "保存中…" : dirty ? "未保存到笔记" : writtenToNote ? "已保存" : "想法可以稍后补充");
  };
  input.addEventListener("input", () => {
    drafts.set(key, input.value);
    update();
  });
  const submit = async () => {
    if (saving || button.disabled) return;
    const value = input.value;
    saving = true;
    update();
    try {
      await save(entry, value);
      writtenToNote = true;
      savedText = value.trim();
      if (input.value === value) {
        input.value = savedText;
        drafts.delete(key);
      }
      saving = false;
      update();
    } catch (error) {
      saving = false;
      button.disabled = false;
      status.setText(error instanceof Error ? error.message : "保存失败，文字已保留，请重试");
    }
  };
  button.addEventListener("click", () => { void submit(); });
  input.addEventListener("keydown", event => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.isComposing) {
      event.preventDefault();
      void submit();
    }
  });
  update();
  return input;
}
