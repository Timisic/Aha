// Node implementations of the shared-core dependency seam (ADR 0005).
// Bench scripts inject these into core entry points so the compiled core
// stays free of node imports while behaving exactly like the legacy
// scripts/aha/lib modules it replaces.

import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

export const coreNodeDeps = {
  path: {
    isAbsolute: (value) => path.isAbsolute(value),
    relative: (from, to) => path.relative(from, to),
    resolve: (...segments) => path.resolve(...segments),
    basename: (value, ext) => (ext === undefined ? path.basename(value) : path.basename(value, ext)),
  },
  fs: {
    exists: (absolutePath) => existsSync(absolutePath),
    statIsFile: (absolutePath) => statSync(absolutePath).isFile(),
    listDir: (absolutePath) => readdirSync(absolutePath, { withFileTypes: true }).map((entry) => ({
      name: entry.name,
      isDirectory: entry.isDirectory(),
      isFile: entry.isFile(),
    })),
  },
};
