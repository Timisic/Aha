// Rebuild-first loader for the session-store Node artifact
// (BATCH-VAULT-RUNNER-PLAN.md). The compiled artifact
// (obsidian-plugin/dist/session.mjs) is never committed, so every importer
// rebuilds it from obsidian-plugin/src/session-index.ts before use, the same
// pattern as scripts/lib/core-artifact.mjs for the "core" target. This keeps
// the batch vault runner on the exact session-store.ts / source-identity.ts
// logic the Obsidian plugin itself runs -- never a reimplementation.

import { spawnSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const pluginDir = path.join(repoRoot, "obsidian-plugin");
const artifactPath = path.join(pluginDir, "dist", "session.mjs");

const build = spawnSync(process.execPath, ["esbuild.config.mjs", "session"], {
  cwd: pluginDir,
  encoding: "utf-8",
});
if (build.error) {
  throw new Error(`session artifact build failed to spawn: ${build.error.message}`);
}
if (build.status !== 0) {
  throw new Error(
    `session artifact build failed (exit ${build.status}):\n${build.stdout ?? ""}${build.stderr ?? ""}`,
  );
}

const session = await import(pathToFileURL(artifactPath).href);

// --- session-store ---

export const createEmptySessionStore = session.createEmptySessionStore;
export const normalizeSessionStore = session.normalizeSessionStore;
export const sessionRecordKeyForSource = session.sessionRecordKeyForSource;
export const findSessionRecord = session.findSessionRecord;
export const recordRunningSessionRound = session.recordRunningSessionRound;
export const recordSuccessfulSessionRound = session.recordSuccessfulSessionRound;
export const recordFailedSessionRound = session.recordFailedSessionRound;
export const latestSuccessfulRound = session.latestSuccessfulRound;
export const handoffForRound = session.handoffForRound;
export const staleStateForRound = session.staleStateForRound;
export const syncSessionSelections = session.syncSessionSelections;
export const appendSessionFeedback = session.appendSessionFeedback;

// --- source-identity ---

export const sourceIdentity = session.sourceIdentity;
export const sourceIdentityForFile = session.sourceIdentityForFile;
export const sourceIdentityAllowsPathDrift = session.sourceIdentityAllowsPathDrift;
export const legacySourceIdentity = session.legacySourceIdentity;
export const sourceReviewIndexKey = session.sourceReviewIndexKey;
