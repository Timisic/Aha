import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { applyTraceRenames, planTraceRenames, relinkTraceReferences } from "../../../dev/rename-traces.mjs";

test("trace rename preserves evidence, backs up old names, and is idempotent", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "aha-trace-rename-"));
  try {
    const old = path.join(dir, "old-1788098606884-deadbeef.json");
    const bytes = JSON.stringify({ schema: "PipelineTrace", origin: "plugin", case: { id: "Folder/独处.md", title: "独处" } });
    await writeFile(old, bytes);
    const entries = await planTraceRenames(dir);
    const backup = path.join(dir, "backup");
    await applyTraceRenames(entries, backup);
    assert.match(path.basename(entries[0].to), /^独处__\d{8}-\d{6}\.json$/);
    assert.equal(await readFile(entries[0].to, "utf8"), bytes);
    assert.equal(await readFile(path.join(backup, path.basename(old)), "utf8"), bytes);
    assert.ok((await planTraceRenames(dir)).every(e => e.from === e.to));
    const round = { sourcePath: "Folder/独处.md", generatedAt: "2026-08-30T14:03:26.880Z", warnings: [] };
    const store = { records: { source: { rounds: [round], feedback: [{ action: "accept" }] } } };
    assert.equal(relinkTraceReferences(store, entries), 1);
    assert.equal(round.trace.path, entries[0].to);
    assert.deepEqual(store.records.source.feedback, [{ action: "accept" }]);
    delete round.trace;
    assert.equal(relinkTraceReferences(store, [...entries, { ...entries[0], to: "ambiguous.json" }]), 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("trace rename never overwrites a target appearing after planning", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "aha-trace-collision-"));
  try {
    const old = path.join(dir, "old-1788098606884.json");
    await writeFile(old, JSON.stringify({ schema: "PipelineTrace", origin: "plugin", case: { id: "note.md", title: "note" } }));
    const entries = await planTraceRenames(dir);
    await writeFile(entries[0].to, "do not overwrite");
    await assert.rejects(applyTraceRenames(entries, path.join(dir, "backup")), /EEXIST/);
    assert.equal(await readFile(entries[0].to, "utf8"), "do not overwrite");
    assert.ok(await readFile(old, "utf8"));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
