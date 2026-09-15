/** A locator/journal kept in plugin data; no markers are added to user notes. */
export interface ThoughtNoteWrite {
  path: string;
  block: string;
  previousBlock?: string;
  status: "pending" | "saved";
}

export function thoughtNoteBlock(memoryPath: string, note: string): string {
  const target = memoryPath.replace(/\.md$/i, "");
  if (!target || /[\r\n\[\]|]/.test(target)) throw new Error("历史笔记路径无法生成双链，请先打开原笔记检查。");
  return `[[${target}]]${note.trim() ? `\n\n${note.trim()}` : ""}`;
}

function positions(content: string, block: string): number[] {
  const found: number[] = [];
  let index = content.indexOf(block);
  while (index !== -1) {
    const end = index + block.length;
    if ((index === 0 || content[index - 1] === "\n") && (end === content.length || content[end] === "\n" || content[end] === "\r")) found.push(index);
    index = content.indexOf(block, index + 1);
  }
  return found;
}

/** Retrying a persisted pending write is safe even if the note already changed. */
export function applyThoughtNoteWrite(content: string, write: ThoughtNoteWrite): string {
  const next = positions(content, write.block);
  const previous = write.previousBlock ? positions(content, write.previousBlock) : [];
  if (next.length > 1 || previous.length > 1 || (next.length && previous.length && next[0] !== previous[0])) {
    throw new Error("笔记中有多段相同内容，请在原笔记中编辑；输入已保留。");
  }
  if (next.length === 1 && !(previous.length === 1 && write.previousBlock!.length > write.block.length)) return content;
  if (previous.length === 1) {
    const start = previous[0];
    return content.slice(0, start) + write.block + content.slice(start + write.previousBlock!.length);
  }
  if (write.previousBlock) throw new Error("这段内容已在原笔记中改动，请在原笔记中继续编辑；输入已保留。");
  // Keep the entire original byte sequence, adding only the missing separator.
  const separator = !content || content.endsWith("\n\n") ? "" : content.endsWith("\n") ? "\n" : "\n\n";
  return `${content}${separator}${write.block}\n`;
}

export function normalizeThoughtNoteWrite(value: unknown): ThoughtNoteWrite | undefined {
  if (!value || typeof value !== "object") return;
  const item = value as Record<string, unknown>;
  if (typeof item.path !== "string" || typeof item.block !== "string" || !item.block || !["pending", "saved"].includes(String(item.status))) return;
  return { path: item.path, block: item.block, previousBlock: typeof item.previousBlock === "string" ? item.previousBlock : undefined, status: item.status as "pending" | "saved" };
}
