// Tests for qmd-request.ts's issue #59 additions: parseQmdEnvironment (the
// general-purpose KEY=VALUE parser backing the new qmdEnvironment settings
// field) and the health/embed-button subprocess adapters
// (runQmdStatus/runQmdUpdate/runQmdEmbed). qmd-request.ts only has type-only
// imports from ./core and ./settings, so it bundles with no obsidian stub.

import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const repoRoot = path.resolve(import.meta.dirname, "../../../..");
const requireFromPlugin = createRequire(path.join(repoRoot, "obsidian-plugin/package.json"));
const esbuild = requireFromPlugin("esbuild");

globalThis.require = createRequire(import.meta.url);

async function loadModule() {
  const temp = await mkdtemp(path.join(tmpdir(), "aha-qmd-request-test-"));
  const entry = path.join(temp, "entry.ts");
  const out = path.join(temp, "bundle.mjs");
  await writeFile(entry, `export * from ${JSON.stringify(path.join(repoRoot, "obsidian-plugin/src/qmd-request.ts"))};\n`);
  await esbuild.build({
    bundle: true,
    entryPoints: [entry],
    format: "esm",
    outfile: out,
    platform: "node",
    target: "es2022",
  });
  const loaded = await import(`${pathToFileURL(out).href}?cacheBust=${Date.now()}`);
  await rm(temp, { recursive: true, force: true });
  return loaded;
}

function baseSettings(overrides = {}) {
  return {
    qmdCommand: "qmd",
    qmdIndex: "obsidian",
    qmdRerank: false,
    targetCandidates: 20,
    qmdEnvironment: "",
    ...overrides,
  };
}

test("parseQmdEnvironment parses KEY=VALUE lines, general-purpose (not restricted to QMD_REMOTE_*)", async () => {
  const { parseQmdEnvironment } = await loadModule();
  const parsed = parseQmdEnvironment("QMD_REMOTE_EMBED_URL=https://embed.example/v1\nCUSTOM_TOKEN=abc123\n");
  assert.deepEqual(parsed, {
    QMD_REMOTE_EMBED_URL: "https://embed.example/v1",
    CUSTOM_TOKEN: "abc123",
  });
});

test("parseQmdEnvironment ignores blank lines, comment lines, and lines without '='", async () => {
  const { parseQmdEnvironment } = await loadModule();
  const parsed = parseQmdEnvironment("\n# a comment\nKEY_ONE=value one\nnotakeyvalueline\n\nKEY_TWO=value two\n");
  assert.deepEqual(parsed, { KEY_ONE: "value one", KEY_TWO: "value two" });
});

test("parseQmdEnvironment trims whitespace and lets a later duplicate key win", async () => {
  const { parseQmdEnvironment } = await loadModule();
  const parsed = parseQmdEnvironment("  KEY = first  \nKEY=second\n");
  assert.deepEqual(parsed, { KEY: "second" });
});

test("parseQmdEnvironment allows '=' inside the value", async () => {
  const { parseQmdEnvironment } = await loadModule();
  const parsed = parseQmdEnvironment("QUERY=key=value&other=1");
  assert.deepEqual(parsed, { QUERY: "key=value&other=1" });
});

test("createQmdRequestDeps injects settings.qmdEnvironment's KEY=VALUE pairs into the qmd subprocess environment", async () => {
  const { createQmdRequestDeps } = await loadModule();
  const temp = await mkdtemp(path.join(tmpdir(), "aha-qmd-env-"));
  const fakeQmd = path.join(temp, "qmd.sh");
  await writeFile(fakeQmd, [
    "#!/bin/sh",
    "echo \"[{\\\"file\\\": \\\"$AHA_TEST_CUSTOM_VAR\\\"}]\"",
    "",
  ].join("\n"));
  await chmod(fakeQmd, 0o755);

  try {
    const deps = createQmdRequestDeps(baseSettings({ qmdCommand: fakeQmd, qmdEnvironment: "AHA_TEST_CUSTOM_VAR=injected-value" }));
    const stdout = await deps.runQmdQuery({ command: "qmd query", text: "test" }, 5000);
    assert.match(stdout, /injected-value/);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("runQmdStatus/runQmdUpdate/runQmdEmbed pass --index and report success/failure without throwing", async () => {
  const { runQmdStatus, runQmdUpdate, runQmdEmbed } = await loadModule();
  const temp = await mkdtemp(path.join(tmpdir(), "aha-qmd-subcommand-"));
  const fakeQmd = path.join(temp, "qmd.sh");
  await writeFile(fakeQmd, [
    "#!/bin/sh",
    "if [ \"$1\" = \"status\" ]; then echo 'Documents'; echo '  Total:    5 files indexed'; exit 0; fi",
    "if [ \"$1\" = \"update\" ]; then echo 'updated'; exit 0; fi",
    "if [ \"$1\" = \"embed\" ]; then echo 'embed failed' 1>&2; exit 1; fi",
    "echo unknown 1>&2; exit 1",
    "",
  ].join("\n"));
  await chmod(fakeQmd, 0o755);

  try {
    const settings = baseSettings({ qmdCommand: fakeQmd, qmdIndex: "obsidian" });
    const status = await runQmdStatus(settings);
    assert.equal(status.ok, true);
    assert.match(status.stdout, /5 files indexed/);

    const update = await runQmdUpdate(settings);
    assert.equal(update.ok, true);

    const embed = await runQmdEmbed(settings);
    assert.equal(embed.ok, false);
    assert.match(embed.message, /embed failed/);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("runQmdStatus never throws when the binary does not exist", async () => {
  const { runQmdStatus } = await loadModule();
  const settings = baseSettings({ qmdCommand: "/nonexistent/path/to/qmd" });
  const result = await runQmdStatus(settings);
  assert.equal(result.ok, false);
});


async function quickRecallFixture(t, body) {
  const directory = await mkdtemp(path.join(tmpdir(), "aha-quick-recall-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const command = path.join(directory, "qmd.cjs");
  const log = path.join(directory, "calls.jsonl");
  await writeFile(command, `#!${process.execPath}
const fs = require("node:fs");
fs.appendFileSync(process.env.AHA_CALL_LOG, JSON.stringify({ argv: process.argv.slice(2), token: process.env.AHA_QUICK_TOKEN, pid: process.pid }) + "\\n");
${body}
`);
  await chmod(command, 0o755);
  const settings = baseSettings({ qmdCommand: command,
    qmdEnvironment: `AHA_CALL_LOG=${log}\nAHA_QUICK_TOKEN=fixture` });
  return { settings, log };
}

test("quick recall runs one semantic query with bounded candidates and configured environment", async (t) => {
  const { runQmdQuickRecall } = await loadModule();
  const fixture = await quickRecallFixture(t, 'console.log(JSON.stringify([{file:"/vault/A.md", score:0.8, snippet:"A real result"}]));');
  const rows = await runQmdQuickRecall(fixture.settings, "paragraph\nlex: other\r\n hyde: fake", new AbortController().signal);
  assert.deepEqual(rows, [{ file: "/vault/A.md", score: 0.8, snippet: "A real result" }]);
  const calls = (await readFile(fixture.log, "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].argv, ["query", "vec: paragraph lex: other hyde: fake", "-c", "obsidian", "--index", "obsidian", "-n", "20", "-C", "20", "--no-rerank", "--full-path", "--format", "json"]);
  assert.equal(calls[0].token, "fixture");
});

test("quick recall rejects malformed rows before the candidate pool", async (t) => {
  const { runQmdQuickRecall } = await loadModule();
  const fixture = await quickRecallFixture(t, 'console.log(JSON.stringify([null,4,[],{}, {file:42}, {file:"A.md",score:"bad"}, {file:"B.md",title:{}}, {file:"C.md",snippet:[]}, {file:"valid.md",score:0.7}]));');
  assert.deepEqual(await runQmdQuickRecall(fixture.settings, "query", new AbortController().signal), [{ file: "valid.md", score: 0.7 }]);
});

test("quick recall cancellation terminates its owned subprocess and never retries", async (t) => {
  const { runQmdQuickRecall } = await loadModule();
  const fixture = await quickRecallFixture(t, 'setInterval(() => {}, 100);');
  const controller = new AbortController();
  const pending = runQmdQuickRecall(fixture.settings, "query", controller.signal);
  let call;
  for (let attempt = 0; attempt < 100; attempt++) {
    const contents = await readFile(fixture.log, "utf8").catch(() => "");
    if (contents) { call = JSON.parse(contents.split("\n")[0]); break; }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(call, "child started before cancellation");
  controller.abort();
  await assert.rejects(pending, /cancelled/);
  let alive = true;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { process.kill(call.pid, 0); } catch { alive = false; break; }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(alive, false, "cancelled child exited");
  assert.equal((await readFile(fixture.log, "utf8")).trim().split("\n").filter(Boolean).length, 1);
});

test("empty or already cancelled quick recall does not spawn", async (t) => {
  const { runQmdQuickRecall } = await loadModule();
  const fixture = await quickRecallFixture(t, 'console.log("[]");');
  assert.deepEqual(await runQmdQuickRecall(fixture.settings, " \n ", new AbortController().signal), []);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(runQmdQuickRecall(fixture.settings, "query", controller.signal), /cancelled/);
  await assert.rejects(readFile(fixture.log, "utf8"), { code: "ENOENT" });
});

test("quick recall timeout ends after one subprocess attempt", async (t) => {
  const { runQmdQuickRecall } = await loadModule();
  const fixture = await quickRecallFixture(t, 'setInterval(() => {}, 100);');
  await assert.rejects(runQmdQuickRecall(fixture.settings, "query", new AbortController().signal), /timed out after 8000ms/);
  assert.equal((await readFile(fixture.log, "utf8")).trim().split("\n").filter(Boolean).length, 1);
});

test("quick recall rejects malformed JSON and bounds subprocess output", async (t) => {
  const { runQmdQuickRecall } = await loadModule();
  const malformed = await quickRecallFixture(t, 'console.log("[invalid]");');
  await assert.rejects(runQmdQuickRecall(malformed.settings, "query", new AbortController().signal), SyntaxError);
  const oversized = await quickRecallFixture(t, 'process.stdout.write("x".repeat(6 * 1024 * 1024));');
  await assert.rejects(runQmdQuickRecall(oversized.settings, "query", new AbortController().signal), /stdout exceeded/);
});

test("quick recall accepts literal filesystem percent paths and rejects malformed URI escapes", async (t) => {
  const { runQmdQuickRecall } = await loadModule();
  const fixture = await quickRecallFixture(t, 'console.log(JSON.stringify([{file:"/vault/100%.md"}, {file:"/vault/反例 #1.md"}, {file:"qmd://obsidian/bad%.md"}]));');
  assert.deepEqual(await runQmdQuickRecall(fixture.settings, "query", new AbortController().signal), [{ file: "/vault/100%.md" }, { file: "/vault/反例 #1.md" }]);
});

test("index cancellation waits for child exit before another update can start", async () => {
  const { runQmdUpdate } = await loadModule();
  const temp = await mkdtemp(path.join(tmpdir(), "aha-index-abort-"));
  const script = path.join(temp, "qmd.cjs");
  const pidPath = path.join(temp, "pid");
  await writeFile(script, `#!/usr/bin/env node\nrequire('fs').writeFileSync(${JSON.stringify(pidPath)},String(process.pid));process.on('SIGTERM',()=>setTimeout(()=>process.exit(0),150));setInterval(()=>{},100);`, { mode: 0o755 });
  try {
    const controller = new AbortController();
    const running = runQmdUpdate(baseSettings({ qmdCommand: script }), controller.signal);
    let pid;
    for (let attempt = 0; attempt < 100; attempt++) {
      try { pid = Number(await readFile(pidPath, "utf8")); break; } catch { await new Promise(resolve => setTimeout(resolve, 10)); }
    }
    assert.equal(Number.isInteger(pid), true);
    controller.abort();
    const outcome = await running;
    assert.equal(outcome.ok, false);
    assert.match(outcome.message, /cancelled/);
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  } finally { await rm(temp, { recursive: true, force: true }); }
});
