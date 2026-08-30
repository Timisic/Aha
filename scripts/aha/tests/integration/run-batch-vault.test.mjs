// Integration tests for the batch vault runner (BATCH-VAULT-RUNNER-PLAN.md,
// scripts/dev/run-batch-vault.mjs): argument parsing, note-list collection,
// strictly-serial scheduling, one note's failure not aborting the batch,
// --dry-run doing nothing, and the per-note incremental read-merge-write of
// data.json. A fake runPipeline is injected via config.runPipeline -- no
// real LLM or QMD call happens in this file.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { normalizeSessionStore, appendSessionFeedback } from "../../../lib/session-artifact.mjs";
import {
  collectNotesFromFile,
  collectNotesUnderFolder,
  dataJsonPathFor,
  main,
  parseArgs,
  runBatch,
} from "../../../dev/run-batch-vault.mjs";

async function makeVault() {
  const vaultRoot = await mkdtemp(path.join(tmpdir(), "aha-batch-vault-"));
  return vaultRoot;
}

async function writeDataJson(vaultRoot, pluginId, data) {
  const dataJsonPath = dataJsonPathFor(vaultRoot, pluginId);
  await mkdir(path.dirname(dataJsonPath), { recursive: true });
  await writeFile(dataJsonPath, JSON.stringify(data, null, 2));
  return dataJsonPath;
}

function fakeSuccessResult(sourcePath) {
  return {
    ok: true,
    sourcePath,
    generatedAt: new Date().toISOString(),
    summary: `summary for ${sourcePath}`,
    warnings: [],
    error: null,
    candidates: [{ notePath: "Memory/Old.md", relation: "supports", hit: "hit", why: "why", quotes: [] }],
  };
}

test("batch honors traceDirectory and writes a trace for each completed round", async () => {
  const vaultRoot = await makeVault();
  const pluginId = "aha-memory-surface-dev";
  try {
    await writeFile(path.join(vaultRoot, "note.md"), "A source note.");
    const traceDirectory = path.join(vaultRoot, "debug-traces");
    const dataPath = await writeDataJson(vaultRoot, pluginId, { settings: { traceDirectory } });
    const config = { settings: { traceDirectory }, runPipeline: async args => fakeSuccessResult(args.sourcePath) };
    await runBatch({ vaultRoot, pluginId }, config, ["note.md"]);
    const files = await readdir(traceDirectory);
    assert.equal(files.length, 1);
    const trace = JSON.parse(await readFile(path.join(traceDirectory, files[0]), "utf-8"));
    assert.equal(trace.schema, "PipelineTrace");
    assert.equal(trace.origin, "batch");
    assert.equal(trace.case.id, "note.md");
    assert.equal(trace.steps.final_candidates.length, 1);
    const data = JSON.parse(await readFile(dataPath, "utf8"));
    const store = normalizeSessionStore(data.sessionStore);
    const record = Object.values(store.records)[0];
    const round = record.rounds[0];
    assert.deepEqual(round.trace, { path: path.join(traceDirectory, files[0]), origin: "batch" });
    for (const action of ["accept", "surprise"]) {
      appendSessionFeedback(record, { action, createdAt: new Date(), sourcePath: record.source.path, sourceTitle: record.source.title, candidate: round.candidates[0] });
    }
    await writeFile(dataPath, JSON.stringify({ ...data, sessionStore: store }));
    const reopened = normalizeSessionStore(JSON.parse(await readFile(dataPath, "utf8")).sessionStore);
    const reopenedRecord = Object.values(reopened.records)[0];
    assert.deepEqual(reopenedRecord.feedback.map(f => f.action), ["accept", "surprise"]);
    assert.deepEqual(reopenedRecord.rounds[0].trace, round.trace);
  } finally {
    await rm(vaultRoot, { recursive: true, force: true });
  }
});

test("batch trace failure preserves a successful round and records the warning", async () => {
  const vaultRoot = await makeVault();
  const pluginId = "aha-memory-surface-dev";
  try {
    await writeFile(path.join(vaultRoot, "note.md"), "A source note.");
    const traceDirectory = path.join(vaultRoot, "not-a-directory");
    await writeFile(traceDirectory, "existing file");
    const dataPath = await writeDataJson(vaultRoot, pluginId, { settings: { traceDirectory } });
    const config = { settings: { traceDirectory }, runPipeline: async args => fakeSuccessResult(args.sourcePath) };
    await runBatch({ vaultRoot, pluginId }, config, ["note.md"]);
    const data = JSON.parse(await readFile(dataPath, "utf-8"));
    const round = Object.values(data.sessionStore.records)[0].rounds[0];
    assert.equal(round.status, "success");
    assert.ok(round.warnings.some(w => w.startsWith("Pipeline trace write failed:")));
  } finally {
    await rm(vaultRoot, { recursive: true, force: true });
  }
});

test("parseArgs requires exactly one of --folder or --notes-file", () => {
  assert.throws(() => parseArgs(["--folder", "x", "--notes-file", "y"]), /exactly one/);
  assert.throws(() => parseArgs([]), /exactly one/);
});

test("parseArgs rejects a non-positive --limit", () => {
  assert.throws(() => parseArgs(["--folder", "x", "--limit", "0"]), /positive number/);
  assert.throws(() => parseArgs(["--folder", "x", "--limit", "abc"]), /positive number/);
});

test("parseArgs defaults plugin-id to the -dev install and dry-run to false", () => {
  const options = parseArgs(["--folder", "x"]);
  assert.equal(options.pluginId, "aha-memory-surface-dev");
  assert.equal(options.dryRun, false);
});

test("parseArgs picks up --dry-run and an explicit production plugin-id", () => {
  const options = parseArgs(["--notes-file", "y", "--plugin-id", "aha-memory-surface", "--dry-run"]);
  assert.equal(options.pluginId, "aha-memory-surface");
  assert.equal(options.dryRun, true);
});

test("collectNotesUnderFolder recurses, skips dotfiles/dirs, and only picks .md", async () => {
  const vaultRoot = await makeVault();
  try {
    await mkdir(path.join(vaultRoot, "个人复盘", "2026", ".trash"), { recursive: true });
    await writeFile(path.join(vaultRoot, "个人复盘", "a.md"), "a");
    await writeFile(path.join(vaultRoot, "个人复盘", "2026", "b.md"), "b");
    await writeFile(path.join(vaultRoot, "个人复盘", "2026", "notes.txt"), "not markdown");
    await writeFile(path.join(vaultRoot, "个人复盘", "2026", ".trash", "c.md"), "c");
    await writeFile(path.join(vaultRoot, "个人复盘", ".hidden.md"), "hidden");

    const notes = await collectNotesUnderFolder(vaultRoot, "个人复盘");
    assert.deepEqual(notes.sort(), ["个人复盘/2026/b.md", "个人复盘/a.md"].sort());
  } finally {
    await rm(vaultRoot, { recursive: true, force: true });
  }
});

test("collectNotesFromFile skips blank lines and # comments", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "aha-batch-notesfile-"));
  try {
    const notesFile = path.join(dir, "notes.txt");
    await writeFile(notesFile, "a/one.md\n\n# a comment\n  b/two.md  \n");
    const notes = await collectNotesFromFile(notesFile);
    assert.deepEqual(notes, ["a/one.md", "b/two.md"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runBatch runs notes strictly serially, isolates one failure, and flushes data.json per note", async () => {
  const vaultRoot = await makeVault();
  const pluginId = "aha-memory-surface-dev";
  try {
    const notePaths = ["note-1.md", "note-2.md", "note-3.md"];
    for (const notePath of notePaths) {
      await writeFile(path.join(vaultRoot, notePath), `content of ${notePath}`);
    }
    const originalSettings = { llmProvider: "deepseek", deepseekModel: "deepseek-v4-pro" };
    const dataJsonPath = await writeDataJson(vaultRoot, pluginId, {
      settings: originalSettings,
      sessionStore: { schemaVersion: 1, records: {} },
      schemaVersion: 3,
    });

    let active = 0;
    let maxActive = 0;
    let callIndex = 0;

    const runPipeline = async (args) => {
      callIndex += 1;
      active += 1;
      maxActive = Math.max(maxActive, active);

      // Prove the previous note's round was already flushed to disk before
      // this note starts running -- i.e. writes happen per note, not batched
      // at the very end of the loop.
      if (callIndex > 1) {
        const onDisk = JSON.parse(await readFile(dataJsonPath, "utf-8"));
        const priorPath = notePaths[callIndex - 2];
        const hasPriorRecord = Object.values(onDisk.sessionStore.records)
          .some((record) => record.source.path === priorPath);
        assert.ok(hasPriorRecord, `expected ${priorPath}'s round on disk before note ${callIndex} starts`);
      }

      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;

      if (args.sourcePath === "note-2.md") {
        return {
          ok: false,
          sourcePath: args.sourcePath,
          generatedAt: new Date().toISOString(),
          summary: "failed",
          warnings: [],
          candidates: [],
          error: { message: "simulated pipeline failure", tool: "relation-judge", details: "boom" },
        };
      }
      return fakeSuccessResult(args.sourcePath);
    };

    const options = { vaultRoot, pluginId };
    const config = { targetCandidates: 20, excludedFolders: [], qmdDeps: {}, llmConfig: {}, runPipeline };

    const outcome = await runBatch(options, config, notePaths);

    assert.equal(maxActive, 1, "notes must never run concurrently");
    assert.deepEqual(outcome.succeeded, ["note-1.md", "note-3.md"]);
    assert.equal(outcome.failed.length, 1);
    assert.equal(outcome.failed[0].notePath, "note-2.md");
    assert.match(outcome.failed[0].message, /simulated pipeline failure/);

    const finalData = JSON.parse(await readFile(dataJsonPath, "utf-8"));
    assert.deepEqual(finalData.settings, originalSettings, "settings must be untouched");
    assert.equal(finalData.schemaVersion, 3, "top-level schemaVersion must be preserved");
    const records = Object.values(finalData.sessionStore.records);
    assert.equal(records.length, 3, "all three notes must have a record, including the failed one");
    const failedRecord = records.find((record) => record.source.path === "note-2.md");
    assert.equal(failedRecord.rounds.at(-1).status, "failed");
    const successRecord = records.find((record) => record.source.path === "note-1.md");
    assert.equal(successRecord.rounds.at(-1).status, "success");
  } finally {
    await rm(vaultRoot, { recursive: true, force: true });
  }
});

test("--dry-run prints the selection and touches nothing on disk", async () => {
  const vaultRoot = await makeVault();
  try {
    await mkdir(path.join(vaultRoot, "folder"), { recursive: true });
    await writeFile(path.join(vaultRoot, "folder", "a.md"), "a");
    await writeFile(path.join(vaultRoot, "folder", "b.md"), "b");

    const dataJsonPath = dataJsonPathFor(vaultRoot, "aha-memory-surface-dev");
    const logs = [];
    const originalLog = console.log;
    const originalArgv = process.argv;
    console.log = (...args) => logs.push(args.join(" "));
    process.argv = [originalArgv[0], originalArgv[1], "--vault-root", vaultRoot, "--folder", "folder", "--dry-run"];
    try {
      await main();
    } finally {
      console.log = originalLog;
      process.argv = originalArgv;
    }

    assert.ok(logs.some((line) => line.includes("--dry-run")));
    assert.ok(logs.some((line) => line.includes("folder/a.md")));
    assert.ok(logs.some((line) => line.includes("folder/b.md")));
    await assert.rejects(readFile(dataJsonPath, "utf-8"), /ENOENT/, "dry-run must never touch data.json, not even to read it");
  } finally {
    await rm(vaultRoot, { recursive: true, force: true });
  }
});
