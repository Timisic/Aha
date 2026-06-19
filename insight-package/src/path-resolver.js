import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, isAbsolute, relative, resolve } from "node:path";

export function stripPathDecorations(path) {
  const value = String(path ?? "")
    .trim()
    .replace(/[?#].*$/, "")
    .replace(/\\/g, "/");
  if (!value.startsWith("qmd://")) return value;
  const withoutScheme = value.slice("qmd://".length);
  const slashIndex = withoutScheme.indexOf("/");
  return slashIndex >= 0 ? withoutScheme.slice(slashIndex + 1) : withoutScheme;
}

export function slugPath(path) {
  return stripPathDecorations(path)
    .replace(/^\/+|\/+$/g, "")
    .split("/")
    .map((segment) =>
      segment
        .replace(/\.md$/i, "")
        .replace(/[\s，。；;、：:（）()【】\[\]《》<>!?！？]+/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-+|-+$/g, "")
        .toLowerCase(),
    )
    .join("/");
}

function listMarkdownFiles(root, dir = root) {
  if (!existsSync(dir)) return [];
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const fullPath = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listMarkdownFiles(root, fullPath));
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
      files.push(relative(root, fullPath).replace(/\\/g, "/"));
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

export function buildVaultPathResolver(root) {
  const vaultRoot = resolve(root);
  const files = listMarkdownFiles(vaultRoot);
  const byRelative = new Map();
  const bySlug = new Map();
  const byBasename = new Map();

  for (const file of files) {
    addIndex(byRelative, stripPathDecorations(file), file);
    addIndex(bySlug, slugPath(file), file);
    addIndex(byBasename, basename(file, ".md"), file);
  }

  return { root: vaultRoot, files, byRelative, bySlug, byBasename };
}

function candidateKeys(rawPath, resolver) {
  const cleaned = stripPathDecorations(rawPath);
  if (!cleaned) return [];
  const keys = [];

  if (isAbsolute(cleaned)) {
    if (existsSync(cleaned)) {
      try {
        const stat = statSync(cleaned);
        if (stat.isFile()) {
          const rel = relative(resolver.root, cleaned).replace(/\\/g, "/");
          if (rel && !rel.startsWith("..") && !isAbsolute(rel)) keys.push(rel);
        }
      } catch {
        // Fall through to relative/slug matching.
      }
    }
    const rel = relative(resolver.root, cleaned).replace(/\\/g, "/");
    if (rel && !rel.startsWith("..") && !isAbsolute(rel)) keys.push(rel);
  } else {
    keys.push(cleaned.replace(/^\/+/, ""));
  }

  keys.push(slugPath(cleaned));
  keys.push(basename(cleaned, ".md"));
  return Array.from(new Set(keys.filter(Boolean)));
}

function lookup(map, key) {
  return map.get(String(key ?? "").toLowerCase()) ?? [];
}

export function resolveVaultPath(rawPath, resolver) {
  const keys = candidateKeys(rawPath, resolver);
  for (const mapLookup of [
    (key) => lookup(resolver.byRelative, stripPathDecorations(key)),
    (key) => lookup(resolver.bySlug, slugPath(key)),
    (key) => lookup(resolver.byBasename, basename(key, ".md")),
  ]) {
    const matches = [];
    for (const key of keys) {
      for (const match of mapLookup(key)) matches.push(match);
    }
    const unique = Array.from(new Set(matches));
    if (unique.length === 1) return { status: "resolved", path: unique[0], matches: unique };
    if (unique.length > 1) return { status: "ambiguous", matches: unique };
  }
  return { status: "not_found", matches: [] };
}

export function equivalentVaultPath(a, b, resolver) {
  const resolvedA = resolveVaultPath(a, resolver);
  const resolvedB = resolveVaultPath(b, resolver);
  return resolvedA.status === "resolved" &&
    resolvedB.status === "resolved" &&
    resolvedA.path === resolvedB.path;
}
