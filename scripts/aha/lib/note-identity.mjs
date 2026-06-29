import path from "node:path";

export function notePathForObsidian(args, row) {
  const raw = String(row.file ?? row.path ?? row.uri ?? row.title ?? "unknown.md");
  if (/^qmd:\/\//i.test(raw)) {
    return decodeURIComponent(raw.replace(/^qmd:\/\/[^/]+\//i, "").replace(/\?index=.*$/i, ""));
  }
  if (args.vaultRoot && path.isAbsolute(raw)) {
    const relative = path.relative(args.vaultRoot, raw);
    if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) {
      return relative;
    }
  }
  return raw;
}

export function sameNotePath(left, right, options = {}) {
  if (!left || !right) return false;
  return normalizeNoteIdentity(left, options) === normalizeNoteIdentity(right, options);
}

export function normalizeNoteIdentity(value, options = {}) {
  const normalized = decodeURIComponent(String(value ?? "")
    .replace(/^qmd:\/\/[^/]+\//i, "")
    .replace(/\?index=.*$/i, "")
    .replace(/\\/g, "/")
    .replace(/\.md$/i, "")
    .trim()
    .normalize("NFC"));
  return options.caseSensitive ? normalized : normalized.toLowerCase();
}
