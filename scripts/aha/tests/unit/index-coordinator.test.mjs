import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "../../../..");
const require = createRequire(path.join(root, "obsidian-plugin/package.json"));
globalThis.require = require;
const temp = await mkdtemp(path.join(tmpdir(), "aha-index-tests-"));
const bundle = path.join(temp, "index.mjs");
await require("esbuild").build({ entryPoints: [path.join(root, "obsidian-plugin/src/index-coordinator.ts")], bundle: true, platform: "node", format: "esm", outfile: bundle });
const { IndexCoordinator, reconcileInventory, emptyIndexState, normalizeIndexState } = await import(pathToFileURL(bundle).href);
test.after(() => rm(temp, { recursive: true, force: true }));
const note = (name, id = name) => ({ path: `${name}.md`, filesystemId: `srcfs:${id}` });
const settle = () => new Promise(resolve => setTimeout(resolve, 450));

async function fixture(t, restored) {
  const dir = await mkdtemp(path.join(temp, "run-"));
  const script = path.join(dir, "qmd.cjs");
  const log = path.join(dir, "log");
  await writeFile(script, `#!/usr/bin/env node\nconst fs=require('fs');const path=require('path');const dir=__dirname;const command=process.argv[2];fs.appendFileSync(path.join(dir,'log'), command+'\\n');if(fs.existsSync(path.join(dir,'fail')))process.exit(1);if(command==='embed'&&fs.existsSync(path.join(dir,'hold'))){const timer=setInterval(()=>{if(!fs.existsSync(path.join(dir,'hold'))){clearInterval(timer);console.log('complete');}},10);}else console.log('complete');`, { mode: 0o755 });
  const settings = { qmdCommand: script, qmdIndex: "test", qmdEnvironment: "", autoIndexEnabled: true, autoIndexNoteThreshold: 10 };
  let files = [note("original")];
  let saved = restored;
  let failSave = () => false;
  let now = 100_000;
  const coordinator = new IndexCoordinator({ settings: () => settings, inventory: async () => files, persist: async state => {
    if (failSave(state)) throw new Error("Disk write rejected");
    saved = structuredClone(state);
  }, now: () => now }, restored);
  t.after(() => coordinator.dispose());
  const commands = async () => { try { return (await readFile(log, "utf8")).trim().split("\n"); } catch { return []; } };
  return { coordinator, settings, dir, commands, get saved() { return saved; }, files: values => { files = values; }, add: count => { files = [...files, ...Array.from({ length: count }, (_, i) => note(`new-${files.length + i}`))]; }, failSave: fn => { failSave = fn; }, advance: ms => { now += ms; } };
}
async function waitFor(predicate) {
  for (let i = 0; i < 200; i++) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error("Expected state did not arrive.");
}

test("inventory baselines existing notes, counts additions and preserves atomic replacements", () => {
  let token = 0;
  const allocate = () => `token-${++token}`;
  const baseline = reconcileInventory(emptyIndexState("target"), [note("a"), note("b")], allocate);
  assert.deepEqual(baseline.notes.map(n => n.token), ["token-1", "token-2"]);
  assert.deepEqual(baseline.pending, []);
  const added = reconcileInventory(baseline, [note("a", "new-inode"), note("b"), note("c")], allocate);
  assert.deepEqual(added.pending, ["token-3"]);
  assert.equal(added.notes[0].token, "token-1");
  const renamed = reconcileInventory(added, [note("a", "new-inode"), note("renamed", "b"), note("c")], allocate);
  assert.equal(renamed.notes[1].token, "token-2");
  const deleted = reconcileInventory(renamed, [note("c")], allocate);
  assert.deepEqual(deleted.pending, ["token-3"]);
  assert.deepEqual(reconcileInventory(deleted, [], allocate).pending, []);
});

test("duplicate ctime fallback never merges distinct notes and strong ambiguous IDs never guess", () => {
  let n = 0;
  const alloc = () => `k${++n}`;
  const baseline = reconcileInventory(emptyIndexState("a"), [{ path: "a.md", filesystemId: "src:42" }], alloc);
  const next = reconcileInventory(baseline, [{ path: "a.md", filesystemId: "src:42" }, { path: "b.md", filesystemId: "src:42" }], alloc);
  assert.deepEqual(next.pending, ["k2"]);
  const ambiguous = reconcileInventory(emptyIndexState("a"), [note("a", "same"), note("b", "same")], alloc);
  const renamed = reconcileInventory(ambiguous, [note("renamed", "same")], alloc);
  assert.deepEqual(renamed.pending, ["k5"]);
});

test("9 additions wait, tenth runs update then embed; restart detects offline additions", async t => {
  const f = await fixture(t);
  await f.coordinator.start();
  f.add(9); f.coordinator.schedule(); await settle();
  assert.equal(f.coordinator.status.pending, 9);
  assert.deepEqual(await f.commands(), []);
  const restored = normalizeIndexState(f.saved);
  assert.equal(restored.pending.length, 9);
  f.coordinator.dispose();
  const recovered = new IndexCoordinator({ settings: () => f.settings, inventory: async () => [note("original"), ...Array.from({ length: 10 }, (_, i) => note(`new-${i + 1}`))], persist: async () => {} }, restored);
  t.after(() => recovered.dispose());
  await recovered.start();
  await waitFor(async () => (await f.commands()).length === 2 && recovered.status.kind === "idle");
  assert.deepEqual(await f.commands(), ["update", "embed"]);
  assert.equal(recovered.status.pending, 0);
});

test("concurrent manual and automatic calls join; notes created during a job remain pending", async t => {
  const f = await fixture(t); await f.coordinator.start();
  f.add(10); await f.coordinator.reconcile();
  await writeFile(path.join(f.dir, "hold"), "");
  const first = f.coordinator.refresh();
  assert.equal(f.coordinator.refresh(), first);
  f.coordinator.configure();
  await waitFor(async () => (await f.commands()).length === 2);
  f.add(2); await f.coordinator.reconcile();
  await rm(path.join(f.dir, "hold"));
  assert.equal((await first).ok, true);
  assert.equal(f.coordinator.status.pending, 2);
  assert.deepEqual(await f.commands(), ["update", "embed"]);
});

test("threshold-sized concurrent additions schedule exactly one follow-up batch", async t => {
  const f = await fixture(t); await f.coordinator.start();
  f.add(10); await writeFile(path.join(f.dir, "hold"), "");
  const first = f.coordinator.refresh();
  await waitFor(async () => (await f.commands()).length === 2);
  f.add(10); await f.coordinator.reconcile();
  await rm(path.join(f.dir, "hold")); await first;
  await waitFor(async () => (await f.commands()).length === 4 && f.coordinator.status.kind === "idle");
  assert.deepEqual(await f.commands(), ["update", "embed", "update", "embed"]);
  assert.equal(f.saved.pending.length, 0);
});

test("failure persists pending and cooldown, never retries on a timer or delete, allows later new-note retry", async t => {
  const f = await fixture(t); await f.coordinator.start(); f.add(10);
  await writeFile(path.join(f.dir, "fail"), "");
  assert.equal((await f.coordinator.refresh()).ok, false);
  assert.equal(f.saved.pending.length, 10); assert.equal(f.saved.retryAfter, 160_000);
  f.add(1); f.coordinator.schedule(); await settle();
  assert.deepEqual(await f.commands(), ["update"]);
  f.advance(61_000); await settle();
  assert.deepEqual(await f.commands(), ["update"]);
  f.coordinator.schedule(undefined, undefined, false); await settle();
  assert.deepEqual(await f.commands(), ["update"]);
  await rm(path.join(f.dir, "fail")); f.add(1); f.coordinator.schedule();
  await waitFor(() => f.coordinator.status.kind === "idle");
  assert.deepEqual(await f.commands(), ["update", "update", "embed"]);
  assert.equal(f.saved.pending.length, 0);
});

test("failed acknowledgement retains pending and blocks immediate automatic repetition", async t => {
  const f = await fixture(t); await f.coordinator.start(); f.add(10);
  f.failSave(state => state.lastSuccess !== null);
  assert.equal((await f.coordinator.refresh()).ok, false);
  assert.equal(f.coordinator.status.pending, 10);
  assert.equal(f.saved.pending.length, 10);
  assert.equal(f.saved.error, "Disk write rejected");
  await settle(); assert.deepEqual(await f.commands(), ["update", "embed"]);
  f.failSave(() => false); assert.equal((await f.coordinator.refresh()).ok, true);
  assert.equal(f.saved.pending.length, 0);
});

test("live rename preserves fallback tokens, deleted pending notes disappear, disable retains pending", async t => {
  const f = await fixture(t); f.settings.autoIndexEnabled = false;
  f.files([{ path: "old/a.md", filesystemId: "src:42" }]); await f.coordinator.start();
  f.files([{ path: "renamed/a.md", filesystemId: "src:42" }, note("added")]);
  f.coordinator.schedule("old", "renamed", false); await settle();
  assert.equal(f.saved.notes[0].path, "renamed/a.md"); assert.equal(f.saved.pending.length, 1);
  const pending = f.saved.pending[0];
  f.coordinator.configure(); await settle(); assert.equal(f.saved.pending[0], pending);
  f.files([{ path: "renamed/a.md", filesystemId: "src:42" }]); await f.coordinator.reconcile();
  assert.equal(f.saved.pending.length, 0); assert.deepEqual(await f.commands(), []);
});

test("target change cannot acknowledge a previous index and unload aborts its owned job", async t => {
  const f = await fixture(t); await f.coordinator.start(); f.add(2);
  await writeFile(path.join(f.dir, "hold"), "");
  const job = f.coordinator.refresh(); await waitFor(async () => (await f.commands()).length === 2);
  f.settings.qmdIndex = "other"; await f.coordinator.reconcile(); f.add(1); await f.coordinator.reconcile();
  await rm(path.join(f.dir, "hold")); assert.equal((await job).ok, false);
  assert.equal(f.saved.pending.length, 1); assert.equal(f.saved.lastSuccess, null);
  await writeFile(path.join(f.dir, "hold"), "");
  const cancelled = f.coordinator.refresh(); await waitFor(async () => (await f.commands()).length === 4);
  f.coordinator.dispose(); assert.equal((await cancelled).ok, false);
  assert.equal(f.saved.pending.length, 1);
  assert.match((await f.coordinator.refresh()).steps[0].message, /not ready/);
});

test("restart honors durable cooldown; unrelated saves do not become a retry trigger", async t => {
  const f = await fixture(t); await f.coordinator.start(); f.add(10);
  await writeFile(path.join(f.dir, "fail"), ""); await f.coordinator.refresh();
  f.coordinator.dispose();
  let now = 120_000;
  let stored = f.saved;
  const restarted = new IndexCoordinator({ settings: () => f.settings, inventory: async () => stored.notes, persist: async next => { stored = structuredClone(next); }, now: () => now }, stored);
  t.after(() => restarted.dispose());
  await restarted.start(); await settle();
  assert.deepEqual(await f.commands(), ["update"]);
  now = 170_000;
  restarted.configure(); await settle();
  assert.deepEqual(await f.commands(), ["update"]);
  await rm(path.join(f.dir, "fail"));
  f.settings.autoIndexNoteThreshold = 9;
  restarted.configure();
  await waitFor(() => restarted.status.kind === "idle");
  assert.deepEqual(await f.commands(), ["update", "update", "embed"]);
  assert.equal(stored.pending.length, 0);
});

test("disabling automatic updates does not abort a manual job", async t => {
  const f = await fixture(t); await f.coordinator.start(); f.add(1);
  await writeFile(path.join(f.dir, "hold"), "");
  const manual = f.coordinator.refresh();
  await waitFor(async () => (await f.commands()).length === 2);
  f.settings.autoIndexEnabled = false; f.coordinator.configure(); await settle();
  assert.equal(f.coordinator.status.kind, "running");
  await rm(path.join(f.dir, "hold"));
  assert.equal((await manual).ok, true);
  assert.equal(f.saved.pending.length, 0);
});
