// Plugin-side vault-boundary adapter (issue #58): implements core's
// VaultBoundaryDeps (path arithmetic + realpath) for candidates.ts/pool.ts's
// vault-containment checks. `realpath` uses Node's fs.promises.realpath --
// Obsidian's renderer-side Vault API has no equivalent, and this is local
// filesystem access from the desktop app (not a subprocess), the same
// category process.ts's own pathExists helper already relies on.
//
// Deliberately obsidian-import-free (unlike vault-read.ts) so this file
// bundles and unit-tests without any Obsidian stub.

import * as path from "path";
import type { VaultBoundaryDeps } from "./core";

function getNodeRequire(): NodeRequire {
  const globalRequire = (globalThis as { require?: NodeRequire }).require;
  if (typeof globalRequire === "function") return globalRequire;
  const windowRequire = (globalThis as { window?: { require?: NodeRequire } }).window?.require;
  if (typeof windowRequire === "function") return windowRequire;
  throw new Error("Node require is unavailable.");
}

export function createVaultBoundaryDeps(): VaultBoundaryDeps {
  return {
    path: {
      isAbsolute: (value) => path.isAbsolute(value),
      relative: (from, to) => path.relative(from, to),
      resolve: (...segments) => path.resolve(...segments),
      basename: (value, ext) => (ext === undefined ? path.basename(value) : path.basename(value, ext)),
    },
    posixNormalize: (value) => path.posix.normalize(value),
    realpath: async (absolutePath: string) => {
      const fs = getNodeRequire()("fs") as typeof import("fs");
      return fs.promises.realpath(absolutePath);
    },
  };
}
