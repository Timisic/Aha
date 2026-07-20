// Rebuild-first loader for the shared core artifact (ADR 0005).
//
// The compiled artifact (obsidian-plugin/dist/core.mjs) is never committed, so
// every importer must rebuild it from src/core before use. Importing this
// module does exactly that: it spawns the esbuild core build synchronously,
// then dynamically imports the fresh artifact and re-exports the note-identity
// functions with Node deps bound, keeping the legacy call-site signatures.

import { spawnSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { coreNodeDeps } from "./core-node-deps.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const pluginDir = path.join(repoRoot, "obsidian-plugin");
const artifactPath = path.join(pluginDir, "dist", "core.mjs");

const build = spawnSync(process.execPath, ["esbuild.config.mjs", "core"], {
  cwd: pluginDir,
  encoding: "utf-8",
});
if (build.error) {
  throw new Error(`core artifact build failed to spawn: ${build.error.message}`);
}
if (build.status !== 0) {
  throw new Error(
    `core artifact build failed (exit ${build.status}):\n${build.stdout ?? ""}${build.stderr ?? ""}`,
  );
}

const core = await import(pathToFileURL(artifactPath).href);

export const normalizeNoteIdentity = core.normalizeNoteIdentity;
export const sameNotePath = core.sameNotePath;
export const stripPathDecorations = core.stripPathDecorations;
export const slugPath = core.slugPath;
export const resolveVaultPath = core.resolveVaultPath;
export const equivalentVaultPath = core.equivalentVaultPath;

export function notePathForObsidian(args, row) {
  return core.notePathForObsidian(args, row, coreNodeDeps.path);
}

export function buildVaultPathResolver(root) {
  return core.buildVaultPathResolver(root, coreNodeDeps);
}
