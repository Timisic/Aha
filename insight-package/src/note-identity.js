import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, isAbsolute, relative, resolve } from "node:path";

export function stripPathDecorations(value) {
  let text = String(value ?? "").trim().replace(/\\/g, "/");
  const wiki = text.match(/^\[\[([^\]]+)\]\]$/);
  if (wiki) text = wiki[1];
  const aliasIndex = text.indexOf("|");
  if (aliasIndex >= 0) text = text.slice(0, aliasIndex);
  const headingIndex = text.indexOf("#");
  if (headingIndex >= 0) text = text.slice(0, headingIndex);
  text = text.replace(/[?].*$/, "").trim();
  if (!text.startsWith("qmd://")) return text;
  const withoutScheme = text.slice("qmd://".length);
  const slashIndex = withoutScheme.indexOf("/");
  return slashIndex >= 0 ? withoutScheme.slice(slashIndex + 1) : withoutScheme;
}

function normalizeLookupKey(value) {
  return stripPathDecorations(value)
    .replace(/^\/+|\/+$/g, "")
    .replace(/\.md$/i, "")
    .normalize("NFC")
    .toLowerCase();
}

function normalizeRelativePath(value) {
  return stripPathDecorations(value).replace(/^\/+|\/+$/g, "").normalize("NFC");
}

export function slugPath(path) {
  return normalizeRelativePath(path)
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

function canonicalIdForPath(path) {
  return normalizeRelativePath(path).toLowerCase();
}

function titleFromPath(path) {
  return basename(stripPathDecorations(path), ".md").trim();
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
  const normalized = normalizeLookupKey(key);
  if (!normalized) return;
  const values = map.get(normalized) ?? [];
  if (!values.includes(value)) values.push(value);
  map.set(normalized, values);
}

function frontmatterAliases(content) {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!match) return [];
  const body = match[1];
  const aliases = [];
  const inline = body.match(/^aliases?:\s*\[([^\]]*)\]\s*$/mi);
  if (inline) {
    aliases.push(...inline[1].split(",").map((item) => item.replace(/^['\"]|['\"]$/g, "").trim()));
  }
  const single = body.match(/^aliases?:\s*([^\n\[][^\n]*)$/mi);
  if (single) aliases.push(single[1].replace(/^['\"]|['\"]$/g, "").trim());
  const list = body.match(/^aliases?:\s*\n((?:\s*-\s*[^\n]+\n?)+)/mi);
  if (list) {
    aliases.push(...list[1].split(/\r?\n/).map((line) => line.replace(/^\s*-\s*/, "").replace(/^['\"]|['\"]$/g, "").trim()));
  }
  return Array.from(new Set(aliases.filter(Boolean)));
}

function readAliases(root, file) {
  try {
    return frontmatterAliases(readFileSync(resolve(root, file), "utf-8"));
  } catch {
    return [];
  }
}

function identityForFile(root, file) {
  const canonicalPath = normalizeRelativePath(file);
  const title = titleFromPath(canonicalPath);
  return {
    canonicalPath,
    canonicalId: canonicalIdForPath(canonicalPath),
    title,
    aliases: readAliases(root, canonicalPath),
  };
}

export function buildNoteIdentityResolver(root) {
  const vaultRoot = resolve(root);
  const files = listMarkdownFiles(vaultRoot);
  const byRelative = new Map();
  const bySlug = new Map();
  const byBasename = new Map();
  const byTitle = new Map();
  const byAlias = new Map();
  const identities = new Map();

  for (const file of files) {
    const identity = identityForFile(vaultRoot, file);
    identities.set(identity.canonicalPath, identity);
    addIndex(byRelative, identity.canonicalPath, identity.canonicalPath);
    addIndex(byRelative, identity.canonicalPath.replace(/\.md$/i, ""), identity.canonicalPath);
    addIndex(bySlug, slugPath(identity.canonicalPath), identity.canonicalPath);
    addIndex(byBasename, identity.title, identity.canonicalPath);
    addIndex(byTitle, identity.title, identity.canonicalPath);
    for (const alias of identity.aliases) addIndex(byAlias, alias, identity.canonicalPath);
  }

  return { root: vaultRoot, files, byRelative, bySlug, byBasename, byTitle, byAlias, identities };
}

function candidateKeys(rawInput, resolver) {
  const raw = String(rawInput ?? "").trim();
  const cleaned = stripPathDecorations(rawInput);
  if (!cleaned) return [];
  const isPathLike = isAbsolute(cleaned) || raw.startsWith("qmd://") || cleaned.includes("/") || /\.md$/i.test(cleaned);
  if (!isPathLike) return [];
  const keys = [];

  if (isAbsolute(cleaned)) {
    const rel = relative(resolver.root, cleaned).replace(/\\/g, "/");
    if (rel && !rel.startsWith("..") && !isAbsolute(rel)) keys.push(rel);
    if (existsSync(cleaned)) {
      try {
        const stat = statSync(cleaned);
        if (stat.isFile()) {
          const realRel = relative(resolver.root, cleaned).replace(/\\/g, "/");
          if (realRel && !realRel.startsWith("..") && !isAbsolute(realRel)) keys.push(realRel);
        }
      } catch {
        // Fall through to normalized hint matching.
      }
    }
  } else {
    keys.push(cleaned.replace(/^\/+/, ""));
  }

  keys.push(cleaned.replace(/\.md$/i, ""));
  keys.push(slugPath(cleaned));
  return Array.from(new Set(keys.map((key) => key.trim()).filter(Boolean)));
}

function titleCandidateKeys(rawInput) {
  const cleaned = stripPathDecorations(rawInput);
  return Array.from(new Set([cleaned, titleFromPath(cleaned)].map((key) => key.trim()).filter(Boolean)));
}

function lookup(map, key) {
  return map.get(normalizeLookupKey(key)) ?? [];
}

function resolutionFromMatches(input, matches, resolver) {
  const unique = Array.from(new Set(matches));
  if (unique.length === 1) {
    const identity = resolver.identities.get(unique[0]);
    if (identity) return { status: "resolved", ...identity };
  }
  if (unique.length > 1) {
    return {
      status: "ambiguous",
      input: String(input ?? ""),
      matches: unique.map((path) => resolver.identities.get(path)).filter(Boolean),
    };
  }
  return null;
}

export function resolveNoteIdentity(input, resolver) {
  const keys = candidateKeys(input, resolver);
  for (const map of [resolver.byRelative, resolver.bySlug]) {
    const matches = [];
    for (const key of keys) matches.push(...lookup(map, key));
    const resolution = resolutionFromMatches(input, matches, resolver);
    if (resolution) return resolution;
  }

  const titleKeys = titleCandidateKeys(input);
  for (const map of [resolver.byTitle, resolver.byAlias, resolver.byBasename]) {
    const matches = [];
    for (const key of titleKeys) matches.push(...lookup(map, key));
    const resolution = resolutionFromMatches(input, matches, resolver);
    if (resolution) return resolution;
  }

  return {
    status: "unresolved",
    input: String(input ?? ""),
    normalizedHint: normalizeLookupKey(input),
  };
}

export function equivalentNoteIdentity(a, b, resolver) {
  const resolvedA = resolveNoteIdentity(a, resolver);
  const resolvedB = resolveNoteIdentity(b, resolver);
  return resolvedA.status === "resolved" && resolvedB.status === "resolved" && resolvedA.canonicalId === resolvedB.canonicalId;
}

export function deterministicFallbackCanonicalId(input) {
  const collection = normalizeLookupKey(input?.collection ?? "");
  const path = normalizeLookupKey(input?.path ?? input?.slug ?? "");
  const title = normalizeLookupKey(input?.title ?? "");
  const fingerprint = createHash("sha256")
    .update([
      collection,
      path,
      title,
      String(input?.content ?? input?.queryText ?? "").trim().slice(0, 1000),
    ].join("\u0000"))
    .digest("hex")
    .slice(0, 16);
  const hint = path || title || "candidate";
  return `unresolved:${hint}:${fingerprint}`;
}

export function normalizeIdentityHint(input) {
  return normalizeLookupKey(input);
}
