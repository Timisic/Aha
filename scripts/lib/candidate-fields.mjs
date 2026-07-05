export function candidatePath(candidate) {
  return candidate?.file || candidate?.path || candidate?.slug || candidate?.title || "";
}

export const DEFAULT_EXCLUDED_CANDIDATE_FOLDERS = ["templates", "Aha/Reviews"];

const DEFAULT_VAULT_ROOT = "/path/to/vault";

export function excludedCandidateFolders(extraEnvValue = process.env.AHA_EXCLUDED_FOLDERS) {
  const extras = String(extraEnvValue ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return [...DEFAULT_EXCLUDED_CANDIDATE_FOLDERS, ...extras];
}

export function isExcludedCandidatePath(rawPath, folders = excludedCandidateFolders()) {
  const normalized = vaultRelativeCandidatePath(rawPath);
  if (!normalized) return false;
  return folders.some((folder) => {
    const prefix = vaultRelativeCandidatePath(folder);
    return prefix && (normalized === prefix || normalized.startsWith(`${prefix}/`));
  });
}

function vaultRelativeCandidatePath(value) {
  let normalized = String(value ?? "").trim();
  if (normalized.startsWith("qmd://")) {
    const withoutScheme = normalized.slice("qmd://".length);
    const slashIdx = withoutScheme.indexOf("/");
    normalized = slashIdx >= 0 ? withoutScheme.slice(slashIdx + 1) : withoutScheme;
  }
  normalized = normalized.replace(/[?#].*$/, "").toLowerCase().replace(/^\/+|\/+$/g, "");
  const vaultRoot = String(process.env.AHA_BENCH_VAULT_ROOT || DEFAULT_VAULT_ROOT)
    .toLowerCase()
    .replace(/^\/+|\/+$/g, "");
  if (normalized === vaultRoot) return "";
  if (normalized.startsWith(`${vaultRoot}/`)) return normalized.slice(vaultRoot.length + 1);
  return normalized;
}

export function candidateSourceList(candidate) {
  if (Array.isArray(candidate?.sources) && candidate.sources.length > 0) return candidate.sources;
  return candidate?.source ? [candidate.source] : [];
}

export function candidateSourceLabel(candidate) {
  const sources = candidateSourceList(candidate);
  return sources.length > 0 ? sources.join("+") : candidate?.source;
}

export function candidateRerankId(index) {
  return `c${String(index + 1).padStart(3, "0")}`;
}

export function annotateCandidateRerankIds(candidates) {
  return candidates.map((candidate, index) => ({
    ...candidate,
    rerankId: candidateRerankId(index),
  }));
}
