// Shared note-identity logic (ADR 0005). Compiled into both the plugin bundle
// and the standalone core artifact consumed by bench scripts.
//
// This module must stay free of `obsidian` imports, node imports, and
// module-level I/O: all path and filesystem effects flow through injected deps.
// Behavior is a 1:1 port of scripts/aha/lib/note-identity.mjs (frozen legacy
// wrapper path); any drift here is a bug.

export interface CorePathDeps {
  isAbsolute(value: string): boolean;
  relative(from: string, to: string): string;
  resolve(...segments: string[]): string;
  basename(value: string, ext?: string): string;
}

export interface CoreDirEntry {
  name: string;
  isDirectory: boolean;
  isFile: boolean;
}

export interface CoreFsDeps {
  exists(absolutePath: string): boolean;
  /** May throw (mirrors fs.statSync); callers that tolerate races catch. */
  statIsFile(absolutePath: string): boolean;
  listDir(absolutePath: string): CoreDirEntry[];
}

export interface NoteIdentityDeps {
  path: CorePathDeps;
  fs: CoreFsDeps;
}

export interface NotePathArgs {
  vaultRoot?: string | null;
}

export interface NoteRow {
  file?: unknown;
  path?: unknown;
  uri?: unknown;
  title?: unknown;
}

export interface NoteIdentityOptions {
  caseSensitive?: boolean;
}

export interface VaultPathResolver {
  root: string;
  files: string[];
  byRelative: Map<string, string[]>;
  bySlug: Map<string, string[]>;
  byBasename: Map<string, string[]>;
  deps: NoteIdentityDeps;
}

export type VaultPathResolution =
  | { status: "resolved"; path: string; matches: string[] }
  | { status: "ambiguous"; matches: string[] }
  | { status: "not_found"; matches: string[] };

export function notePathForObsidian(args: NotePathArgs, row: NoteRow, pathDeps: CorePathDeps): string {
  const raw = String(row.file ?? row.path ?? row.uri ?? row.title ?? "unknown.md");
  if (/^qmd:\/\//i.test(raw)) {
    return decodeURIComponent(raw.replace(/^qmd:\/\/[^/]+\//i, "").replace(/\?index=.*$/i, ""));
  }
  if (args.vaultRoot && pathDeps.isAbsolute(raw)) {
    const relative = pathDeps.relative(args.vaultRoot, raw);
    if (relative && !relative.startsWith("..") && !pathDeps.isAbsolute(relative)) {
      return relative;
    }
  }
  return raw;
}

export function sameNotePath(left: unknown, right: unknown, options: NoteIdentityOptions = {}): boolean {
  if (!left || !right) return false;
  return normalizeNoteIdentity(left, options) === normalizeNoteIdentity(right, options);
}

export function normalizeNoteIdentity(value: unknown, options: NoteIdentityOptions = {}): string {
  const normalized = decodeURIComponent(String(value ?? "")
    .replace(/^qmd:\/\/[^/]+\//i, "")
    .replace(/\?index=.*$/i, "")
    .replace(/\\/g, "/")
    .replace(/\.md$/i, "")
    .trim()
    .normalize("NFC"));
  return options.caseSensitive ? normalized : normalized.toLowerCase();
}

export function stripPathDecorations(value: unknown): string {
  const cleaned = String(value ?? "")
    .trim()
    .replace(/[?#].*$/, "")
    .replace(/\\/g, "/");
  if (!cleaned.startsWith("qmd://")) return cleaned;
  const withoutScheme = cleaned.slice("qmd://".length);
  const slashIndex = withoutScheme.indexOf("/");
  return slashIndex >= 0 ? withoutScheme.slice(slashIndex + 1) : withoutScheme;
}

export function slugPath(value: unknown): string {
  return stripPathDecorations(value)
    .replace(/^\/+|\/+$/g, "")
    .split("/")
    .map((segment) =>
      segment
        .replace(/\.md$/i, "")
        .replace(/[\u{1F000}-\u{1FBFF}\u{2600}-\u{27BF}]/gu, (ch) => (ch.codePointAt(0) as number).toString(16))
        .replace(/[\s，。；;、：:（）()【】\[\]《》<>!?！？“”‘’「」『』'—–]+/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-+|-+$/g, "")
        .toLowerCase(),
    )
    .join("/");
}

export function buildVaultPathResolver(root: string, deps: NoteIdentityDeps): VaultPathResolver {
  const vaultRoot = deps.path.resolve(root);
  const files = listMarkdownFiles(vaultRoot, vaultRoot, deps);
  const byRelative = new Map<string, string[]>();
  const bySlug = new Map<string, string[]>();
  const byBasename = new Map<string, string[]>();

  for (const file of files) {
    addIndex(byRelative, stripPathDecorations(file), file);
    addIndex(bySlug, slugPath(file), file);
    addIndex(byBasename, deps.path.basename(file, ".md"), file);
  }

  return { root: vaultRoot, files, byRelative, bySlug, byBasename, deps };
}

export function resolveVaultPath(rawPath: unknown, resolver: VaultPathResolver): VaultPathResolution {
  const keys = candidateKeys(rawPath, resolver);
  for (const mapLookup of [
    (key: string) => lookup(resolver.byRelative, stripPathDecorations(key)),
    (key: string) => lookup(resolver.bySlug, slugPath(key)),
    (key: string) => lookup(resolver.byBasename, resolver.deps.path.basename(key, ".md")),
  ]) {
    const matches: string[] = [];
    for (const key of keys) {
      for (const match of mapLookup(key)) matches.push(match);
    }
    const uniqueMatches = Array.from(new Set(matches));
    if (uniqueMatches.length === 1) return { status: "resolved", path: uniqueMatches[0], matches: uniqueMatches };
    if (uniqueMatches.length > 1) return { status: "ambiguous", matches: uniqueMatches };
  }
  return { status: "not_found", matches: [] };
}

export function equivalentVaultPath(left: unknown, right: unknown, resolver: VaultPathResolver): boolean {
  const resolvedLeft = resolveVaultPath(left, resolver);
  const resolvedRight = resolveVaultPath(right, resolver);
  return resolvedLeft.status === "resolved" &&
    resolvedRight.status === "resolved" &&
    resolvedLeft.path === resolvedRight.path;
}

function listMarkdownFiles(root: string, dir: string, deps: NoteIdentityDeps): string[] {
  if (!deps.fs.exists(dir)) return [];
  const files: string[] = [];
  for (const entry of deps.fs.listDir(dir)) {
    if (entry.name.startsWith(".")) continue;
    const fullPath = deps.path.resolve(dir, entry.name);
    if (entry.isDirectory) {
      files.push(...listMarkdownFiles(root, fullPath, deps));
    } else if (entry.isFile && entry.name.toLowerCase().endsWith(".md")) {
      files.push(deps.path.relative(root, fullPath).replace(/\\/g, "/"));
    }
  }
  return files;
}

function addIndex(map: Map<string, string[]>, key: unknown, value: string): void {
  const normalized = String(key ?? "").trim().toLowerCase();
  if (!normalized) return;
  const values = map.get(normalized) ?? [];
  if (!values.includes(value)) values.push(value);
  map.set(normalized, values);
}

function candidateKeys(rawPath: unknown, resolver: VaultPathResolver): string[] {
  const { path: pathDeps, fs: fsDeps } = resolver.deps;
  const cleaned = stripPathDecorations(rawPath);
  if (!cleaned) return [];
  const keys: string[] = [];

  if (pathDeps.isAbsolute(cleaned)) {
    if (fsDeps.exists(cleaned)) {
      try {
        if (fsDeps.statIsFile(cleaned)) {
          const relative = pathDeps.relative(resolver.root, cleaned).replace(/\\/g, "/");
          if (relative && !relative.startsWith("..") && !pathDeps.isAbsolute(relative)) keys.push(relative);
        }
      } catch {
        // Fall through to relative/slug matching.
      }
    }
    const relative = pathDeps.relative(resolver.root, cleaned).replace(/\\/g, "/");
    if (relative && !relative.startsWith("..") && !pathDeps.isAbsolute(relative)) keys.push(relative);
  } else {
    keys.push(cleaned.replace(/^\/+/, ""));
  }

  keys.push(slugPath(cleaned));
  keys.push(pathDeps.basename(cleaned, ".md"));
  return Array.from(new Set(keys.filter(Boolean)));
}

function lookup(map: Map<string, string[]>, key: unknown): string[] {
  return map.get(String(key ?? "").toLowerCase()) ?? [];
}
