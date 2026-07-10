import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

export function notePathForObsidian(args, row) {
  const raw = String(row.file ?? row.path ?? row.uri ?? row.title ?? "unknown.md");
  if (/^qmd:\/\//i.test(raw)) {
    return stripPathDecorations(raw);
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
  const normalized = stripPathDecorations(value)
    .replace(/\.md$/i, "")
    .trim()
    .normalize("NFC");
  return options.caseSensitive ? normalized : normalized.toLowerCase();
}

export function stripPathDecorations(value) {
  const raw = String(value ?? "")
    .trim()
    .replace(/\\/g, "/");
  const undecorated = raw.replace(/[?#].*$/, "");
  const withoutScheme = /^qmd:\/\//i.test(undecorated)
    ? undecorated.replace(/^qmd:\/\/[^/]+\/?/i, "")
    : undecorated;
  return safeDecodeURIComponent(withoutScheme).normalize("NFC");
}

export function slugPath(value) {
  return stripPathDecorations(value)
    .replace(/^\/+|\/+$/g, "")
    .split("/")
    .map((segment) =>
      segment
        .replace(/\.md$/i, "")
        .replace(/[\u{1F000}-\u{1FBFF}\u{2600}-\u{27BF}]/gu, (ch) => ch.codePointAt(0).toString(16))
        .replace(/[\s，。；;、：:（）()【】\[\]《》<>!?！？“”‘’「」『』'—–]+/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-+|-+$/g, "")
        .toLowerCase(),
    )
    .join("/");
}

export function buildVaultPathResolver(root) {
  const vaultRoot = path.resolve(root);
  const files = listMarkdownFiles(vaultRoot);
  const byRelative = new Map();
  const bySlug = new Map();
  const byBasename = new Map();

  for (const file of files) {
    addIndex(byRelative, normalizeNoteIdentity(file), file);
    addIndex(bySlug, slugPath(file), file);
    addIndex(byBasename, normalizeNoteIdentity(path.basename(file, ".md")), file);
  }

  return { root: vaultRoot, files, byRelative, bySlug, byBasename };
}

export function resolveVaultPath(rawPath, resolver) {
  const keys = candidateKeys(rawPath, resolver);
  for (const mapLookup of [
    (key) => lookup(resolver.byRelative, normalizeNoteIdentity(key)),
    (key) => lookup(resolver.bySlug, slugPath(key)),
    (key) => lookup(resolver.byBasename, normalizeNoteIdentity(path.basename(key, ".md"))),
  ]) {
    const matches = [];
    for (const key of keys) {
      for (const match of mapLookup(key)) matches.push(match);
    }
    const uniqueMatches = Array.from(new Set(matches));
    if (uniqueMatches.length === 1) {
      return {
        status: "resolved",
        path: uniqueMatches[0],
        identity: normalizeNoteIdentity(uniqueMatches[0]),
        matches: uniqueMatches,
      };
    }
    if (uniqueMatches.length > 1) return { status: "ambiguous", matches: uniqueMatches };
  }
  return { status: "not_found", matches: [] };
}

export function equivalentVaultPath(left, right, resolver) {
  const resolvedLeft = resolveVaultPath(left, resolver);
  const resolvedRight = resolveVaultPath(right, resolver);
  return resolvedLeft.status === "resolved" &&
    resolvedRight.status === "resolved" &&
    resolvedLeft.path === resolvedRight.path;
}

function listMarkdownFiles(root, dir = root) {
  if (!existsSync(dir)) return [];
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const fullPath = path.resolve(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listMarkdownFiles(root, fullPath));
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
      files.push(path.relative(root, fullPath).replace(/\\/g, "/"));
    }
  }
  return files;
}

function addIndex(map, key, value) {
  const normalized = String(key ?? "").trim().toLowerCase();
  if (!normalized) return;
  const values = map.get(normalized) ?? [];
  if (!values.includes(value)) values.push(value);
  map.set(normalized, values);
}

function candidateKeys(rawPath, resolver) {
  const cleaned = stripPathDecorations(rawPath);
  if (!cleaned) return [];
  const keys = [];

  if (path.isAbsolute(cleaned)) {
    if (existsSync(cleaned)) {
      try {
        const fileStat = statSync(cleaned);
        if (fileStat.isFile()) {
          const relative = path.relative(resolver.root, cleaned).replace(/\\/g, "/");
          if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) keys.push(relative);
        }
      } catch {
        // Fall through to relative/slug matching.
      }
    }
    const relative = path.relative(resolver.root, cleaned).replace(/\\/g, "/");
    if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) keys.push(relative);
  } else {
    keys.push(cleaned.replace(/^\/+/, ""));
  }

  keys.push(slugPath(cleaned));
  keys.push(path.basename(cleaned, ".md"));
  return Array.from(new Set(keys.filter(Boolean)));
}

function lookup(map, key) {
  return map.get(String(key ?? "").toLowerCase()) ?? [];
}

function safeDecodeURIComponent(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
