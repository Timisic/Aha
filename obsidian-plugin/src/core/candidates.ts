// Candidate identity and filter policy shared between the plugin and bench
// (ADR 0005, issue #56). Ports scripts/lib/candidate-fields.mjs plus the
// vault-containment, source-self-hit, and generated-review filters from the
// frozen legacy wrapper scripts/aha/run-insight-search.mjs.
//
// This module must stay free of `obsidian` imports, node imports, and
// module-level I/O: filesystem realpath and path arithmetic flow through
// injected deps, and the excluded-folder list plus the vault-root prefix used
// for exclusion matching are parameters instead of process.env reads (the Node
// binding in scripts/lib/core-artifact.mjs restores the env behavior).

import {
  type CorePathDeps,
  normalizeNoteIdentity,
  notePathForObsidian,
  sameNotePath,
  slugPath,
} from "./note-identity";

export interface CandidateRecord {
  file?: unknown;
  path?: unknown;
  slug?: unknown;
  title?: unknown;
  sources?: unknown;
  source?: unknown;
  [key: string]: unknown;
}

export interface CandidateRowLike {
  file?: unknown;
  path?: unknown;
  uri?: unknown;
  title?: unknown;
  [key: string]: unknown;
}

export interface CandidateFilterArgs {
  vaultRoot?: string | null;
  sourcePath?: string;
  sourceAbsolutePath?: string;
  reviewPath?: string;
}

export interface VaultBoundaryDeps {
  path: CorePathDeps;
  posixNormalize(value: string): string;
  /** May reject (mirrors fs.promises.realpath on missing paths). */
  realpath(absolutePath: string): Promise<string>;
  /** Directory entry names for resolving QMD's slugged path components. */
  listDirectory?(absolutePath: string): Promise<string[]>;
}

export function candidatePath(candidate: CandidateRecord | null | undefined): string {
  return (candidate?.file || candidate?.path || candidate?.slug || candidate?.title || "") as string;
}

export const DEFAULT_EXCLUDED_CANDIDATE_FOLDERS = ["templates", "Aha/Reviews"];

export function excludedCandidateFolders(extraValue?: unknown): string[] {
  const extras = String(extraValue ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return [...DEFAULT_EXCLUDED_CANDIDATE_FOLDERS, ...extras];
}

export function isExcludedCandidatePath(rawPath: unknown, folders: readonly string[], vaultRootPrefix: unknown): boolean {
  const normalized = vaultRelativeCandidatePath(rawPath, vaultRootPrefix);
  if (!normalized) return false;
  return folders.some((folder) => {
    const prefix = vaultRelativeCandidatePath(folder, vaultRootPrefix);
    return prefix && (normalized === prefix || normalized.startsWith(`${prefix}/`));
  });
}

function vaultRelativeCandidatePath(value: unknown, vaultRootPrefix: unknown): string {
  let normalized = String(value ?? "").trim();
  if (normalized.startsWith("qmd://")) {
    const withoutScheme = normalized.slice("qmd://".length);
    const slashIdx = withoutScheme.indexOf("/");
    normalized = slashIdx >= 0 ? withoutScheme.slice(slashIdx + 1) : withoutScheme;
  }
  normalized = normalized.replace(/[?#].*$/, "").toLowerCase().replace(/^\/+|\/+$/g, "");
  const vaultRoot = String(vaultRootPrefix ?? "")
    .toLowerCase()
    .replace(/^\/+|\/+$/g, "");
  if (normalized === vaultRoot) return "";
  if (normalized.startsWith(`${vaultRoot}/`)) return normalized.slice(vaultRoot.length + 1);
  return normalized;
}

export function candidateSourceList(candidate: CandidateRecord | null | undefined): unknown[] {
  if (Array.isArray(candidate?.sources) && candidate.sources.length > 0) return candidate.sources;
  return candidate?.source ? [candidate.source] : [];
}

export function candidateSourceLabel(candidate: CandidateRecord | null | undefined): unknown {
  const sources = candidateSourceList(candidate);
  return sources.length > 0 ? sources.join("+") : candidate?.source;
}

export function candidateRerankId(index: number): string {
  return `c${String(index + 1).padStart(3, "0")}`;
}

export function annotateCandidateRerankIds<T extends object>(candidates: T[]): Array<T & { rerankId: string }> {
  return candidates.map((candidate, index) => ({
    ...candidate,
    rerankId: candidateRerankId(index),
  }));
}

// --- Vault containment and self-hit filters (legacy wrapper port) ---

export async function resolveVaultContainedPath(
  args: CandidateFilterArgs,
  location: string,
  deps: VaultBoundaryDeps,
): Promise<string> {
  if (!args.vaultRoot || !location || /^qmd:\/\//i.test(String(location))) return "";
  if (!deps.path.isAbsolute(location) && !isSafeVaultRelativePath(location, deps)) return "";
  const candidateAbsolutePath = deps.path.isAbsolute(location)
    ? location
    : deps.path.resolve(args.vaultRoot, location);
  const [vaultRealPath, candidateRealPath] = await Promise.all([
    deps.realpath(args.vaultRoot),
    deps.realpath(candidateAbsolutePath),
  ]);
  return pathIsInside(vaultRealPath, candidateRealPath, deps) ? candidateRealPath : "";
}

export async function isCandidatePathAllowed(
  args: CandidateFilterArgs,
  notePath: string,
  row: CandidateRowLike,
  deps: VaultBoundaryDeps,
): Promise<boolean> {
  const rawLocations = [row.file, row.path, row.uri]
    .filter((value) => typeof value === "string")
    .map((value) => (value as string).trim())
    .filter(Boolean);
  if (rawLocations.length === 0) {
    return Boolean(await resolveVaultContainedPath(args, notePath, deps).catch(() => ""));
  }

  for (const location of rawLocations) {
    if (isObsidianQmdUri(location)) {
      if (await qmdUriVaultPath(args, location, deps).catch(() => "")) return true;
      continue;
    }
    if (await resolveVaultContainedPath(args, location, deps).catch(() => "")) return true;
  }
  return false;
}

export function isObsidianQmdUri(value: unknown): boolean {
  return /^qmd:\/\/obsidian\//i.test(String(value ?? ""));
}

export async function qmdUriVaultPath(args: CandidateFilterArgs, value: string, deps: VaultBoundaryDeps): Promise<string> {
  if (!isObsidianQmdUri(value)) return "";
  const notePath = notePathForObsidian(args, { file: value }, deps.path);
  const exact = await resolveVaultContainedPath(args, notePath, deps).catch(() => "");
  if (exact) return exact;
  if (!args.vaultRoot || !deps.listDirectory || !isSafeVaultRelativePath(notePath, deps)) return "";
  let current = args.vaultRoot;
  for (const segment of deps.posixNormalize(notePath).split("/")) {
    const entries = await deps.listDirectory(current).catch((): string[] => []);
    // Prefer literal identity; otherwise require a unique full component
    // match. Never fall back to a basename from a different folder.
    const matches = entries.includes(segment) ? [segment] : entries.filter(name => slugPath(name) === slugPath(segment));
    if (matches.length !== 1) return "";
    current = deps.path.resolve(current, matches[0]);
    // Check every hop, so even listing a symlink outside the vault is denied.
    if (!(await resolveVaultContainedPath(args, current, deps).catch(() => ""))) return "";
  }
  return resolveVaultContainedPath(args, current, deps);
}

export function isSafeVaultRelativePath(value: unknown, deps: VaultBoundaryDeps): boolean {
  const raw = String(value ?? "").replace(/\\/g, "/").trim();
  if (!raw || deps.path.isAbsolute(raw)) return false;
  const normalized = deps.posixNormalize(raw);
  return normalized !== "." && normalized !== ".." && !normalized.startsWith("../");
}

export function pathIsInside(basePath: string, candidateAbsolutePath: string, deps: VaultBoundaryDeps): boolean {
  const relative = deps.path.relative(deps.path.resolve(basePath), deps.path.resolve(candidateAbsolutePath));
  return relative === "" || Boolean(relative && !relative.startsWith("..") && !deps.path.isAbsolute(relative));
}

export function isSourceCandidate(
  args: CandidateFilterArgs,
  notePath: string,
  row: CandidateRowLike,
  pathDeps: CorePathDeps,
): boolean {
  if (sameNotePath(notePath, args.sourcePath)) return true;
  const rawPaths = [row.file, row.path, row.uri]
    .filter((value) => typeof value === "string")
    .map((value) => (value as string).trim());
  return rawPaths.some((value) => {
    if (sameNotePath(notePathForObsidian(args, { file: value }, pathDeps), args.sourcePath)) return true;
    if (pathDeps.isAbsolute(value) && args.sourceAbsolutePath && pathDeps.resolve(value) === pathDeps.resolve(args.sourceAbsolutePath)) return true;
    return false;
  });
}

export function isGeneratedReviewCandidate(
  args: CandidateFilterArgs,
  notePath: string,
  row: CandidateRowLike,
  pathDeps: CorePathDeps,
): boolean {
  const rawPaths = [notePath, row.file, row.path, row.uri]
    .filter((value) => typeof value === "string")
    .map((value) => notePathForObsidian(args, { file: (value as string).trim() }, pathDeps));
  if (args.reviewPath && rawPaths.some((value) => sameNotePath(value, args.reviewPath))) return true;
  return rawPaths.some((value) => {
    const normalized = normalizeNoteIdentity(value);
    return normalized === "aha/reviews" || normalized.startsWith("aha/reviews/");
  });
}
