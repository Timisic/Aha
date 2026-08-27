// Tests for qmd-request.ts's issue #59 additions: parseQmdEnvironment (the
// general-purpose KEY=VALUE parser backing the new qmdEnvironment settings
// field) and the health/embed-button subprocess adapters
// (runQmdStatus/runQmdUpdate/runQmdEmbed). qmd-request.ts only has type-only
// imports from ./core and ./settings, so it bundles with no obsidian stub.

import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
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
    ahaWorkspace: "",
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
