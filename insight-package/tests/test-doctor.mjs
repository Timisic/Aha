import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const extensionModule = await import(process.env.INSIGHT_EXTENSION_PATH ?? "../extensions/insight.ts");
const extension = extensionModule.default;

function makeExecutable(path, body) {
  writeFileSync(path, body, "utf-8");
  chmodSync(path, 0o755);
}

function createHarness(cwd, options = {}) {
  const commands = new Map();
  const tools = new Map();
  const handlers = new Map();
  const notifications = [];
  const editorTexts = [];
  const sessionEntries = [];
  const pi = {
    version: options.piVersion ?? "0.79.7",
    registerCommand(name, commandOptions) {
      commands.set(name, commandOptions);
    },
    registerTool(tool) {
      tools.set(tool.name, tool);
    },
    on(event, handler) {
      const current = handlers.get(event) ?? [];
      current.push(handler);
      handlers.set(event, current);
    },
    sendUserMessage() {},
    appendEntry(customType, data) {
      sessionEntries.push({ type: "custom", customType, data });
    },
  };
  extension(pi);
  return {
    commands,
    tools,
    notifications,
    editorTexts,
    ctx: {
      cwd,
      hasUI: true,
      ui: {
        editor: async () => "",
        notify(message, type) {
          notifications.push({ message, type });
        },
        setEditorText(text) {
          editorTexts.push(text);
        },
        setStatus() {},
      },
      sessionManager: {
        getEntries: () => sessionEntries.slice(),
        getBranch: () => sessionEntries.slice(),
      },
    },
  };
}

function parseLastJson(harness) {
  const text = harness.editorTexts.at(-1);
  assert.ok(text, "doctor wrote editor text");
  return JSON.parse(text);
}

function withEnv(values, fn) {
  const previous = new Map();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const root = mkdtempSync(join(tmpdir(), "aha-doctor-test-"));
const binDir = join(root, "bin");
const insightHome = join(root, "insights");
const sourceRoot = join(root, "demo-vault");
mkdirSync(binDir, { recursive: true });
mkdirSync(sourceRoot, { recursive: true });

const fakeQmd = join(binDir, "qmd");
makeExecutable(fakeQmd, [
  "#!/usr/bin/env node",
  "if (process.argv.includes('--version')) { console.log('qmd 1.2.3'); process.exit(0); }",
  "if ((process.env.QMD_FAKE_MODE || '') === 'missing-index') { console.error('missing index or collection'); process.exit(2); }",
  "process.stdout.write(JSON.stringify([{ title: 'Aha synthetic public note', file: 'demo/synthetic.md', snippet: 'synthetic only' }]));",
].join("\n"));

const fakeObsidian = join(binDir, "obsidian");
makeExecutable(fakeObsidian, [
  "#!/usr/bin/env node",
  "if (process.argv.includes('--version')) { console.log('obsidian 1.0.0'); process.exit(0); }",
  "process.exit(0);",
].join("\n"));

await withEnv({
  INSIGHT_HOME: insightHome,
  QMD_BIN: fakeQmd,
  OBSIDIAN_BIN: fakeObsidian,
  INSIGHT_SOURCE_ROOTS: sourceRoot,
  INSIGHT_MEMORY_RERANKER: "off",
  AHA_DOCTOR_TEST_NODE_VERSION: "v25.8.1",
  AHA_DOCTOR_TEST_PLATFORM: "darwin",
}, async () => {
  globalThis.__ahaInsightExtensionRegisterCount = 0;
  const harness = createHarness(root);
  await harness.commands.get("insight").handler("doctor --json", harness.ctx);
  const report = parseLastJson(harness);
  assert.equal(report.ok, true, "healthy synthetic environment passes required checks");
  assert.equal(report.privacy, "no-real-note-content");
  assert.ok(report.checks.some((check) => check.id === "qmd-synthetic-query" && check.status === "pass"));
  assert.ok(report.checks.some((check) => check.id === "reranker-mode" && check.status === "pass"));
});

await withEnv({
  INSIGHT_HOME: insightHome,
  QMD_BIN: join(binDir, "does-not-exist"),
  OBSIDIAN_BIN: fakeObsidian,
  INSIGHT_SOURCE_ROOTS: sourceRoot,
  INSIGHT_MEMORY_RERANKER: "off",
  AHA_DOCTOR_TEST_NODE_VERSION: "v25.8.1",
  AHA_DOCTOR_TEST_PLATFORM: "darwin",
}, async () => {
  globalThis.__ahaInsightExtensionRegisterCount = 0;
  const harness = createHarness(root);
  await harness.commands.get("insight").handler("doctor --json", harness.ctx);
  const report = parseLastJson(harness);
  assert.equal(report.ok, false, "missing QMD fails required checks");
  assert.ok(report.checks.some((check) => check.id === "qmd-version" && check.status === "fail"));
});

await withEnv({
  INSIGHT_HOME: insightHome,
  QMD_BIN: fakeQmd,
  QMD_FAKE_MODE: "missing-index",
  OBSIDIAN_BIN: fakeObsidian,
  INSIGHT_SOURCE_ROOTS: sourceRoot,
  INSIGHT_MEMORY_RERANKER: "off",
  AHA_DOCTOR_TEST_NODE_VERSION: "v25.8.1",
  AHA_DOCTOR_TEST_PLATFORM: "darwin",
}, async () => {
  globalThis.__ahaInsightExtensionRegisterCount = 0;
  const harness = createHarness(root);
  await harness.commands.get("insight").handler("doctor --json", harness.ctx);
  const report = parseLastJson(harness);
  assert.equal(report.ok, false, "missing QMD index/collection fails required checks");
  assert.ok(report.checks.some((check) => check.id === "qmd-synthetic-query" && check.status === "fail"));
});

await withEnv({
  INSIGHT_HOME: insightHome,
  QMD_BIN: fakeQmd,
  OBSIDIAN_BIN: fakeObsidian,
  INSIGHT_SOURCE_ROOTS: sourceRoot,
  INSIGHT_MEMORY_RERANKER: "off",
  AHA_DOCTOR_TEST_NODE_VERSION: "v20.0.0",
  AHA_DOCTOR_TEST_PLATFORM: "win32",
}, async () => {
  globalThis.__ahaInsightExtensionRegisterCount = 0;
  const harness = createHarness(root, { piVersion: "0.1.0" });
  await harness.commands.get("insight").handler("doctor --json", harness.ctx);
  const report = parseLastJson(harness);
  assert.equal(report.ok, false, "unsupported host and Pi version fail required checks");
  assert.ok(report.checks.some((check) => check.id === "node-js" && check.status === "fail"));
  assert.ok(report.checks.some((check) => check.id === "operating-system" && check.status === "fail"));
  assert.ok(report.checks.some((check) => check.id === "pi-host-version" && check.status === "fail"));
});

await withEnv({
  INSIGHT_HOME: join(root, "not-a-dir"),
  QMD_BIN: fakeQmd,
  OBSIDIAN_BIN: fakeObsidian,
  INSIGHT_SOURCE_ROOTS: sourceRoot,
  INSIGHT_MEMORY_RERANKER: "off",
  AHA_DOCTOR_TEST_NODE_VERSION: "v25.8.1",
  AHA_DOCTOR_TEST_PLATFORM: "darwin",
}, async () => {
  writeFileSync(join(root, "not-a-dir"), "file blocks directory creation", "utf-8");
  globalThis.__ahaInsightExtensionRegisterCount = 0;
  const harness = createHarness(root);
  await harness.commands.get("insight").handler("doctor --json", harness.ctx);
  const report = parseLastJson(harness);
  assert.equal(report.ok, false, "unwritable insight home fails required checks");
  assert.ok(report.checks.some((check) => check.id === "insight-home-writable" && check.status === "fail"));
});

await withEnv({
  INSIGHT_HOME: insightHome,
  QMD_BIN: fakeQmd,
  OBSIDIAN_BIN: fakeObsidian,
  INSIGHT_SOURCE_ROOTS: sourceRoot,
  INSIGHT_MEMORY_RERANKER: "definitely-unavailable-agent-mode",
  INSIGHT_MEMORY_RERANK_AGENT_BIN: join(binDir, "missing-codex"),
  AHA_DOCTOR_TEST_NODE_VERSION: "v25.8.1",
  AHA_DOCTOR_TEST_PLATFORM: "darwin",
}, async () => {
  globalThis.__ahaInsightExtensionRegisterCount = 0;
  const harness = createHarness(root);
  await harness.commands.get("insight").handler("doctor --json", harness.ctx);
  const report = parseLastJson(harness);
  assert.equal(report.ok, true, "optional unavailable reranker warns but does not fail required checks");
  assert.ok(report.checks.some((check) => check.id === "reranker-mode" && check.status === "warn"));
});

await withEnv({
  INSIGHT_HOME: insightHome,
  QMD_BIN: fakeQmd,
  OBSIDIAN_BIN: fakeObsidian,
  INSIGHT_SOURCE_ROOTS: sourceRoot,
  INSIGHT_MEMORY_RERANKER: "off",
  AHA_DOCTOR_TEST_NODE_VERSION: "v25.8.1",
  AHA_DOCTOR_TEST_PLATFORM: "darwin",
}, async () => {
  globalThis.__ahaInsightExtensionRegisterCount = 0;
  const first = createHarness(root);
  createHarness(root);
  await first.commands.get("insight").handler("doctor --json", first.ctx);
  const report = parseLastJson(first);
  assert.equal(report.ok, false, "duplicate registration fails required checks");
  assert.ok(report.checks.some((check) => check.id === "extension-registration" && check.status === "fail"));
});

rmSync(root, { recursive: true, force: true });
console.log("doctor tests passed");
