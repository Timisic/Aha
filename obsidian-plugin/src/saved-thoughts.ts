import type { AhaSessionFeedback, AhaSessionRecord, AhaSessionStoreData } from "./session-store";

export interface SavedThought {
  recordKey: string;
  feedbackId: string;
  feedback: AhaSessionFeedback;
}

// Legacy feedback is append-only. Its index remains stable across round pruning.
function feedbackId(feedback: AhaSessionFeedback, index: number): string {
  return feedback.id ?? `legacy:${index}:${feedback.createdAt}`;
}

export function savedThoughts(store: AhaSessionStoreData): SavedThought[] {
  return Object.values(store.records).flatMap(record => record.feedback.flatMap((feedback, index) =>
    feedback.action === "surprise" && feedback.memory
      ? [{ recordKey: record.key, feedbackId: feedbackId(feedback, index), feedback }]
      : [],
  )).sort((a, b) => b.feedback.createdAt.localeCompare(a.feedback.createdAt));
}

export function savedThoughtText(feedback: AhaSessionFeedback): string {
  // The journal retains the latest writing after an interrupted save/reload.
  return feedback.noteWrite?.status === "pending"
    ? feedback.noteWrite.block.split("\n\n").slice(1).join("\n\n")
    : feedback.note ?? "";
}

export function updateSavedThought(record: AhaSessionRecord, id: string, note: string, now: Date): void {
  const feedback = record.feedback.find((item, index) => feedbackId(item, index) === id && item.action === "surprise");
  if (!feedback) throw new Error("这条已保存记录不存在，请重新打开面板。");
  feedback.id = id;
  feedback.note = note.trim() || undefined;
  feedback.updatedAt = now.toISOString();
  record.updatedAt = feedback.updatedAt;
}

export function savedThoughtMarkdown({ feedback: item }: SavedThought): string {
  const quote = (text: string) => text.split(/\r?\n/).map(line => `> ${line}`).join("\n");
  return [
    "## 我的想法", savedThoughtText(item) || "（尚未补充）", "",
    `当前笔记：[[${item.sourcePath.replace(/\.md$/, "")}]]`,
    `历史笔记：[[${(item.memory ?? "").replace(/\.md$/, "")}]]`,
    `保存于：${item.createdAt}`, "",
    ...(item.sourceExcerpt ? ["### 保存时的当前笔记（节选）", quote(item.sourceExcerpt), ""] : []),
    ...(item.hit ? ["### 历史原文", quote(item.hit), ""] : []),
    "### 当时的 AI 解释", item.why || "（无）",
  ].join("\n");
}
