import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const requireFromPlugin = createRequire(path.join(repoRoot, "obsidian-plugin/package.json"));
const esbuild = requireFromPlugin("esbuild");

test("process bridge runs wrapper through explicit Node when PATH lacks node", async () => {
  const processBridge = await loadProcessModule();
  const temp = await mkdtemp(path.join(tmpdir(), "aha-process-bridge-"));
  const helper = path.join(temp, "ok-command.sh");
  const previousRequire = globalThis.require;
  const previousPath = process.env.PATH;
  globalThis.require = createRequire(import.meta.url);
  process.env.PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

  await writeFile(helper, [
    "#!/bin/sh",
    "if [ \"$1\" = \"files\" ]; then echo 1; else echo \"ok-command 1.0\"; fi",
    "",
  ].join("\n"));
  await chmod(helper, 0o755);

  try {
    const result = await processBridge.runReadinessCheck({
      ahaWorkspace: repoRoot,
      nodeCommand: "",
      llmProvider: "codex-cli",
      llmBaseUrl: "https://api.openai.com/v1",
      llmModel: "gpt-5.5",
      llmApiKey: "",
      llmApiKeyEnv: "OPENAI_API_KEY",
      codexModel: "gpt-5.3-codex-spark",
      codexReasoningEffort: "low",
      codexSandbox: "danger-full-access",
      reviewFolder: "Aha/Reviews",
      codexCommand: helper,
      qmdRunner: "cli",
      qmdCommand: helper,
      qmdIndex: "obsidian",
      qmdSdkModule: "",
      qmdRerank: false,
      obsidianCommand: helper,
      wrapperRelativePath: "scripts/aha/aha-wrapper.mjs",
      targetCandidates: 20,
      useFixtureResult: false,
    });

    assert.equal(result.ok, true);
    assert.ok(result.checks.some((check) => check.name === "Node CLI" && check.ok));
    assert.ok(result.checks.some((check) => check.name === "Codex CLI" && check.ok));
    assert.ok(result.checks.some((check) => check.name === "QMD CLI" && check.ok));
    assert.ok(result.checks.some((check) => check.name === "Obsidian CLI" && check.ok));
  } finally {
    if (previousRequire === undefined) {
      delete globalThis.require;
    } else {
      globalThis.require = previousRequire;
    }
    process.env.PATH = previousPath;
    await rm(temp, { recursive: true, force: true });
  }
});

test("process bridge forwards LLM and QMD runtime arguments", async () => {
  const processBridge = await loadProcessModule();
  const temp = await mkdtemp(path.join(tmpdir(), "aha-process-argv-"));
  const wrapper = path.join(temp, "wrapper.mjs");
  const argvLog = path.join(temp, "argv.json");
  const envLog = path.join(temp, "env.txt");
  const previousRequire = globalThis.require;
  globalThis.require = createRequire(import.meta.url);

  await writeFile(wrapper, [
    "#!/usr/bin/env node",
    "import { writeFileSync } from 'node:fs';",
    `writeFileSync(${JSON.stringify(argvLog)}, JSON.stringify(process.argv.slice(2)));`,
    `writeFileSync(${JSON.stringify(envLog)}, process.env.AHA_TEST_OPENAI_KEY || '');`,
    "process.stdout.write('\\u001b[?25l');",
    "console.log(JSON.stringify({ ok: true, sourcePath: 'Idea/Source.md', generatedAt: new Date().toISOString(), summary: 'ok', warnings: [], candidates: [] }));",
    "",
  ].join("\n"));
  await chmod(wrapper, 0o755);

  const settings = {
    ahaWorkspace: repoRoot,
    nodeCommand: process.execPath,
    llmProvider: "openai",
    llmBaseUrl: "https://api.openai.test/v1",
    llmModel: "gpt-5.5",
    llmApiKey: "direct-openai-key",
    llmApiKeyEnv: "AHA_TEST_OPENAI_KEY",
    codexModel: "gpt-5.3-codex-spark",
    codexReasoningEffort: "low",
    codexSandbox: "danger-full-access",
    reviewFolder: "Aha/Reviews",
    codexCommand: "/tmp/codex",
    qmdRunner: "sdk",
    qmdCommand: "/tmp/qmd",
    qmdIndex: "obsidian",
    qmdSdkModule: "/tmp/qmd-sdk.mjs",
    qmdRerank: true,
    obsidianCommand: "/tmp/obsidian",
    wrapperRelativePath: wrapper,
    targetCandidates: 20,
    useFixtureResult: false,
  };

  try {
    await processBridge.runAhaWrapper(settings, {
      reviewPath: "Aha/Reviews/Source.md",
      sourceAbsolutePath: "/vault/Idea/Source.md",
      sourcePath: "Idea/Source.md",
      vaultRoot: "/vault",
    });
    const argv = JSON.parse(await readFile(argvLog, "utf8"));
    const envValue = await readFile(envLog, "utf8");
    assertIncludesPair(argv, "--llm-provider", "openai");
    assertIncludesPair(argv, "--llm-base-url", "https://api.openai.test/v1");
    assertIncludesPair(argv, "--llm-model", "gpt-5.5");
    assertIncludesPair(argv, "--llm-api-key-env", "AHA_TEST_OPENAI_KEY");
    assertIncludesPair(argv, "--qmd-runner", "sdk");
    assertIncludesPair(argv, "--qmd-command", "/tmp/qmd");
    assertIncludesPair(argv, "--qmd-index", "obsidian");
    assertIncludesPair(argv, "--qmd-sdk-module", "/tmp/qmd-sdk.mjs");
    assert.ok(argv.includes("--qmd-rerank"));
    assert.equal(envValue, "direct-openai-key");
    assert.ok(!argv.includes("direct-openai-key"));
  } finally {
    if (previousRequire === undefined) {
      delete globalThis.require;
    } else {
      globalThis.require = previousRequire;
    }
    await rm(temp, { recursive: true, force: true });
  }
});

async function loadProcessModule() {
  const temp = await mkdtemp(path.join(tmpdir(), "aha-process-test-"));
  const entry = path.join(temp, "entry.ts");
  const out = path.join(temp, "bundle.mjs");
  await writeFile(entry, `export * from ${JSON.stringify(path.join(repoRoot, "obsidian-plugin/src/process.ts"))};\n`);
  await esbuild.build({
    bundle: true,
    entryPoints: [entry],
    format: "esm",
    outfile: out,
    platform: "node",
    plugins: [obsidianStubPlugin()],
    target: "es2022",
  });
  const loaded = await import(`${pathToFileURL(out).href}?cacheBust=${Date.now()}`);
  await rm(temp, { recursive: true, force: true });
  return loaded;
}

function assertIncludesPair(argv, flag, value) {
  const index = argv.indexOf(flag);
  assert.notEqual(index, -1, `${flag} not found in ${argv.join(" ")}`);
  assert.equal(argv[index + 1], value);
}

function obsidianStubPlugin() {
  return {
    name: "obsidian-stub",
    setup(build) {
      build.onResolve({ filter: /^obsidian$/ }, () => ({ path: "obsidian", namespace: "obsidian-stub" }));
      build.onLoad({ filter: /.*/, namespace: "obsidian-stub" }, () => ({
        contents: "export const Platform = { isDesktopApp: true };",
        loader: "js",
      }));
    },
  };
}
