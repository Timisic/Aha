// Plugin-side vault-read adapter (issue #58): implements
// OrchestratorDeps.readNote (core/orchestrator.ts) via the Obsidian Vault
// API rather than node fs, so candidate-excerpt reads go through Obsidian's
// own file model/cache -- the same way main.ts already reads notes
// elsewhere (see markReviewNoteGrilled's cachedRead usage).
//
// core hands this function an already realpath-resolved absolute path (see
// candidates.ts's resolveVaultContainedPath), so it maps back to a
// vault-relative path before looking it up with getAbstractFileByPath.
//
// This is the one adapter that genuinely needs Obsidian's App/TFile at
// runtime, so it stays a separate file from vault-boundary.ts (which is
// obsidian-import-free and directly unit-testable without a stub).

import * as path from "path";
import { TFile, type App } from "obsidian";

export function createVaultReadNote(app: App, vaultRoot: string): (absolutePath: string) => Promise<string> {
  return async (absolutePath: string): Promise<string> => {
    const relative = path.relative(vaultRoot, absolutePath);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`Path is outside the vault: ${absolutePath}`);
    }
    const vaultPath = relative.split(path.sep).join("/");
    const file = app.vault.getAbstractFileByPath(vaultPath);
    if (!(file instanceof TFile)) {
      throw new Error(`Note not found in vault: ${vaultPath}`);
    }
    return app.vault.cachedRead(file);
  };
}
