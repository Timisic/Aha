import { join } from "node:path";
import { pathToFileURL } from "node:url";

export function resolveTypeboxPath(): string {
  const explicit = process.env.PI_TYPEBOX_PATH?.trim();
  if (explicit) return explicit;
  const npmPrefix = process.env.NPM_CONFIG_PREFIX?.trim() || join(process.env.HOME ?? "", ".npm-global");
  return join(
    npmPrefix,
    "lib",
    "node_modules",
    "@earendil-works",
    "pi-coding-agent",
    "node_modules",
    "typebox",
    "build",
    "index.mjs",
  );
}

export function resolvePiTuiPath(): string {
  const explicit = process.env.PI_TUI_PATH?.trim();
  if (explicit) return explicit;
  const npmPrefix = process.env.NPM_CONFIG_PREFIX?.trim() || join(process.env.HOME ?? "", ".npm-global");
  return join(
    npmPrefix,
    "lib",
    "node_modules",
    "@earendil-works",
    "pi-coding-agent",
    "node_modules",
    "@earendil-works",
    "pi-tui",
    "dist",
    "index.js",
  );
}

export const { Type } = await import(pathToFileURL(resolveTypeboxPath()).href);
export const { truncateToWidth, visibleWidth } = (await import(pathToFileURL(resolvePiTuiPath()).href)) as {
  truncateToWidth: (text: string, maxWidth: number, ellipsis?: string, pad?: boolean) => string;
  visibleWidth: (text: string) => number;
};
