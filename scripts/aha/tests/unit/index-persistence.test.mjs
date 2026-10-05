import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "../../../..");
const require = createRequire(path.join(root, "obsidian-plugin/package.json"));
const temp = await mkdtemp(path.join(tmpdir(), "aha-index-persistence-"));
const bundle = path.join(temp, "plugin.mjs");
await require("esbuild").build({
  stdin: { contents: `export { default as AhaPlugin } from ${JSON.stringify(path.join(root, "obsidian-plugin/src/main.ts"))}; export { recordRunningSessionRound } from ${JSON.stringify(path.join(root, "obsidian-plugin/src/session-store.ts"))};`, resolveDir: root },
  bundle: true, platform: "node", format: "esm", outfile: bundle,
  plugins: [{ name: "obsidian-host", setup(build) {
    build.onResolve({ filter: /^obsidian$/ }, () => ({ path: "obsidian", namespace: "host" }));
    build.onLoad({ filter: /.*/, namespace: "host" }, () => ({ contents: `
      export class App {} export class Notice {} export class Plugin {} export class PluginSettingTab {}
      export class Setting {} export class FileSystemAdapter {} export class MarkdownView {} export class TFile {}
      export class ItemView {} export class Modal {} export class WorkspaceLeaf {}
      export const Platform = { isDesktop: true }; export const editorInfoField = {};
      export const normalizePath = value => value; export function setIcon() {}
      export async function requestUrl() { throw new Error('Network unavailable in host fixture'); }
    `, loader: "js" }));
  } }],
});
const { AhaPlugin, recordRunningSessionRound } = await import(pathToFileURL(bundle).href);
test.after(() => rm(temp, { recursive: true, force: true }));

test("settings and feedback whole-data saves retain the latest committed index ledger", async () => {
  const plugin = new AhaPlugin();
  let disk;
  plugin.saveData = async value => { await Promise.resolve(); disk = structuredClone(value); };
  plugin.loadData = async () => ({ schemaVersion: 4, settings: { autoIndexNoteThreshold: -3, autoIndexEnabled: true } });
  await plugin.loadSettings();
  assert.equal(plugin.settings.autoIndexNoteThreshold, 10);
  const record = recordRunningSessionRound(plugin.sessionStore, { source: { id: "srcfs:test", path: "source.md", title: "Source", mtime: 1, size: 1 }, startedAt: new Date("2026-01-01") });
  const ledger = { version: 1, target: "target", initialized: true, notes: [{ token: "one", path: "new.md" }], pending: ["one"], retryAfter: 0, lastSuccess: null, error: null };
  const indexWrite = plugin.persistIndexState(ledger);
  const settingsWrite = plugin.saveSettings();
  const feedbackWrite = plugin.recordSessionFeedback(record.key, { action: "should_have_found", createdAt: new Date("2026-01-02"), sourcePath: "source.md", sourceTitle: "Source", missingMemory: "missed.md" });
  await Promise.all([indexWrite, settingsWrite, feedbackWrite]);
  assert.deepEqual(disk.indexState.pending, ["one"]);
  assert.equal(disk.sessionStore.records[record.key].feedback[0].memory, "missed.md");
  await plugin.persistIndexState({ ...ledger, pending: [], lastSuccess: 42 });
  await plugin.recordSessionFeedback(record.key, { action: "should_have_found", createdAt: new Date("2026-01-03"), sourcePath: "source.md", sourceTitle: "Source", missingMemory: "second.md" });
  await plugin.saveSettings();
  assert.equal(disk.indexState.lastSuccess, 42);
  assert.deepEqual(disk.indexState.pending, []);
  assert.equal(disk.sessionStore.records[record.key].feedback.length, 2);
});

test("rejected index writes cannot become a later settings save's acknowledgement", async () => {
  const plugin = new AhaPlugin();
  let disk;
  plugin.saveData = async value => { disk = structuredClone(value); };
  const ledger = { version: 1, target: "target", initialized: true, notes: [{ token: "one", path: "new.md" }], pending: ["one"], retryAfter: 0, lastSuccess: null, error: null };
  await plugin.persistIndexState(ledger);
  plugin.saveData = async () => { throw new Error("Full disk"); };
  await assert.rejects(plugin.persistIndexState({ ...ledger, pending: [], lastSuccess: 42 }), /Full disk/);
  plugin.saveData = async value => { disk = structuredClone(value); };
  await plugin.saveSettings();
  assert.deepEqual(disk.indexState.pending, ["one"]);
  assert.equal(disk.indexState.lastSuccess, null);
});
