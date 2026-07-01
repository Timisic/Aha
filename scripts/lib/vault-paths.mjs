import { isAbsolute, relative, resolve } from "node:path";

export function expandHome(value) {
  const raw = String(value ?? "");
  if (raw === "~") return process.env.HOME || raw;
  if (raw.startsWith("~/")) return resolve(process.env.HOME || ".", raw.slice(2));
  return raw;
}

export function normalizeSlash(value) {
  return String(value ?? "").replace(/\\/g, "/");
}

export function splitPathDecorations(value) {
  const raw = String(value ?? "");
  const match = raw.match(/^([^?#]*)([?#].*)?$/);
  return {
    path: match ? match[1] : raw,
    suffix: match?.[2] ?? "",
  };
}

export function toVaultRelativePath(value, options = {}) {
  const raw = normalizeSlash(String(value ?? "").trim());
  if (!raw || /^qmd:\/\//i.test(raw)) return raw;

  const vaultRoot = String(options.vaultRoot ?? process.env.AHA_BENCH_VAULT_ROOT ?? "").trim();
  if (!vaultRoot) return raw;

  const { path, suffix } = splitPathDecorations(raw);
  const expandedPath = normalizeSlash(expandHome(path));
  if (!isAbsolute(expandedPath)) return raw;

  const root = normalizeSlash(resolve(expandHome(vaultRoot))).replace(/\/+$/g, "");
  if (!root) return raw;

  const resolvedPath = normalizeSlash(resolve(expandedPath));
  const rel = normalizeSlash(relative(root, resolvedPath));
  if (!rel || rel === ".") return suffix ? `.${suffix}` : ".";
  if (rel.startsWith("../") || rel === ".." || isAbsolute(rel)) return raw;
  return `${rel}${suffix}`;
}

export function normalizeVaultRelativePaths(value, options = {}) {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeVaultRelativePaths(item, options));
  }
  if (!value || typeof value !== "object") {
    return typeof value === "string" ? toVaultRelativePath(value, options) : value;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, normalizeVaultRelativePaths(entry, options)]),
  );
}
