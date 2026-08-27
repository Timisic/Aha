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
      wrapperRelativePath: "scripts/aha/run-insight-search.mjs",
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
    `writeFileSync(${JSON.stringify(envLog)}, JSON.stringify({`,
    "  apiKey: process.env.AHA_TEST_DEEPSEEK_KEY || '',",
    "  embedUrl: process.env.QMD_REMOTE_EMBED_URL || '',",
    "  embedModel: process.env.QMD_REMOTE_EMBED_MODEL || '',",
    "  generateUrl: process.env.QMD_REMOTE_GENERATE_URL || '',",
    "  generateModel: process.env.QMD_REMOTE_GENERATE_MODEL || '',",
    "  rerankUrl: process.env.QMD_REMOTE_RERANK_URL || '',",
    "  rerankModel: process.env.QMD_REMOTE_RERANK_MODEL || '',",
    "}));",
    "process.stdout.write('\\u001b[?25l');",
    "console.log(JSON.stringify({ ok: true, sourcePath: 'Idea/Source.md', generatedAt: new Date().toISOString(), summary: 'ok', warnings: [], candidates: [] }));",
    "",
  ].join("\n"));
  await chmod(wrapper, 0o755);

  const settings = {
    ahaWorkspace: repoRoot,
    nodeCommand: process.execPath,
    llmProvider: "deepseek",
    deepseekBaseUrl: "https://api.deepseek.test",
    deepseekModel: "deepseek-v4-pro",
    deepseekApiKey: "direct-deepseek-key",
    deepseekApiKeyEnv: "AHA_TEST_DEEPSEEK_KEY",
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
    qmdRemoteEmbedUrl: "http://127.0.0.1:28081/v1/embeddings",
    qmdRemoteEmbedModel: "test-embed-model",
    qmdRemoteGenerateUrl: "http://127.0.0.1:28082/completion",
    qmdRemoteGenerateModel: "test-generate-model",
    qmdRemoteRerankUrl: "http://127.0.0.1:28083/v1/rerank",
    qmdRemoteRerankModel: "test-rerank-model",
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
    const envValue = JSON.parse(await readFile(envLog, "utf8"));
    assertIncludesPair(argv, "--llm-provider", "deepseek");
    assertIncludesPair(argv, "--llm-base-url", "https://api.deepseek.test");
    assertIncludesPair(argv, "--llm-model", "deepseek-v4-pro");
    assertIncludesPair(argv, "--llm-api-key-env", "AHA_TEST_DEEPSEEK_KEY");
    assertIncludesPair(argv, "--qmd-runner", "sdk");
    assertIncludesPair(argv, "--qmd-command", "/tmp/qmd");
    assertIncludesPair(argv, "--qmd-index", "obsidian");
    assertIncludesPair(argv, "--qmd-sdk-module", "/tmp/qmd-sdk.mjs");
    assert.ok(argv.includes("--qmd-rerank"));
    assert.deepEqual(envValue, {
      apiKey: "direct-deepseek-key",
      embedUrl: "http://127.0.0.1:28081/v1/embeddings",
      embedModel: "test-embed-model",
      generateUrl: "http://127.0.0.1:28082/completion",
      generateModel: "test-generate-model",
      rerankUrl: "http://127.0.0.1:28083/v1/rerank",
      rerankModel: "test-rerank-model",
    });
    assert.ok(!argv.includes("direct-deepseek-key"));
  } finally {
    if (previousRequire === undefined) {
      delete globalThis.require;
    } else {
      globalThis.require = previousRequire;
    }
    await rm(temp, { recursive: true, force: true });
  }
});

test("process bridge forwards the DeepSeek connection-check profile", async () => {
  const processBridge = await loadProcessModule();
  const temp = await mkdtemp(path.join(tmpdir(), "aha-process-deepseek-"));
  const wrapper = path.join(temp, "wrapper.mjs");
  const argvLog = path.join(temp, "argv.json");
  const envLog = path.join(temp, "env.json");
  const previousRequire = globalThis.require;
  globalThis.require = createRequire(import.meta.url);

  await writeFile(wrapper, [
    "#!/usr/bin/env node",
    "import { writeFileSync } from 'node:fs';",
    `writeFileSync(${JSON.stringify(argvLog)}, JSON.stringify(process.argv.slice(2)));`,
    `writeFileSync(${JSON.stringify(envLog)}, JSON.stringify({ deepseek: process.env.AHA_TEST_DEEPSEEK_KEY || '' }));`,
    "console.log(JSON.stringify({ ok: true, provider: 'deepseek', model: 'deepseek-v4-pro', message: 'connected' }));",
    "",
  ].join("\n"));
  await chmod(wrapper, 0o755);

  const settings = {
    ahaWorkspace: repoRoot,
    nodeCommand: process.execPath,
    llmProvider: "deepseek",
    deepseekBaseUrl: "https://api.deepseek.test",
    deepseekModel: "deepseek-v4-pro",
    deepseekApiKey: "deepseek-direct-key",
    deepseekApiKeyEnv: "AHA_TEST_DEEPSEEK_KEY",
    codexModel: "gpt-test",
    codexReasoningEffort: "low",
    codexSandbox: "danger-full-access",
    reviewFolder: "Aha/Reviews",
    codexCommand: "/tmp/codex",
    qmdRunner: "sdk",
    qmdCommand: "/tmp/qmd",
    qmdIndex: "obsidian",
    qmdSdkModule: "",
    qmdRerank: false,
    qmdRemoteEmbedUrl: "",
    qmdRemoteEmbedModel: "",
    qmdRemoteGenerateUrl: "",
    qmdRemoteGenerateModel: "",
    qmdRemoteRerankUrl: "",
    qmdRemoteRerankModel: "",
    obsidianCommand: "/tmp/obsidian",
    wrapperRelativePath: wrapper,
    targetCandidates: 20,
    useFixtureResult: false,
  };

  try {
    const result = await processBridge.runProviderConnectionCheck(settings, "deepseek");
    assert.equal(result.ok, true);
    const argv = JSON.parse(await readFile(argvLog, "utf8"));
    const envValue = JSON.parse(await readFile(envLog, "utf8"));
    assert.ok(argv.includes("--check-llm-connection"));
    assertIncludesPair(argv, "--llm-provider", "deepseek");
    assertIncludesPair(argv, "--llm-base-url", "https://api.deepseek.test");
    assertIncludesPair(argv, "--llm-model", "deepseek-v4-pro");
    assertIncludesPair(argv, "--llm-api-key-env", "AHA_TEST_DEEPSEEK_KEY");
    assert.deepEqual(envValue, { deepseek: "deepseek-direct-key" });
    assert.ok(!argv.includes("deepseek-direct-key"));
  } finally {
    if (previousRequire === undefined) delete globalThis.require;
    else globalThis.require = previousRequire;
    await rm(temp, { recursive: true, force: true });
  }
});

test("process bridge skips leading ANSI-only stderr lines when reporting wrapper failure", async () => {
  const processBridge = await loadProcessModule();
  const temp = await mkdtemp(path.join(tmpdir(), "aha-process-error-"));
  const wrapper = path.join(temp, "wrapper.mjs");
  const previousRequire = globalThis.require;
  globalThis.require = createRequire(import.meta.url);

  await writeFile(wrapper, [
    "#!/usr/bin/env node",
    "process.stderr.write('\\u001b[?25l\\nDeepSeek relation judge timed out.\\n');",
    "process.exitCode = 2;",
    "",
  ].join("\n"));
  await chmod(wrapper, 0o755);

  try {
    await assert.rejects(
      processBridge.runAhaWrapper({
        ahaWorkspace: repoRoot,
        nodeCommand: process.execPath,
        llmProvider: "deepseek",
        deepseekBaseUrl: "https://api.deepseek.test",
        deepseekModel: "deepseek-v4-pro",
        deepseekApiKey: "test-key",
        deepseekApiKeyEnv: "AHA_TEST_DEEPSEEK_KEY",
        codexModel: "gpt-5.3-codex-spark",
        codexReasoningEffort: "low",
        codexSandbox: "danger-full-access",
        reviewFolder: "Aha/Reviews",
        codexCommand: "/tmp/codex",
        qmdRunner: "sdk",
        qmdCommand: "/tmp/qmd",
        qmdIndex: "obsidian",
        qmdSdkModule: "",
        qmdRerank: false,
        obsidianCommand: "/tmp/obsidian",
        wrapperRelativePath: wrapper,
        targetCandidates: 20,
        useFixtureResult: false,
      }, {
        reviewPath: "Aha/Reviews/Source.md",
        sourceAbsolutePath: "/vault/Idea/Source.md",
        sourcePath: "Idea/Source.md",
        vaultRoot: "/vault",
      }),
      /DeepSeek relation judge timed out\./,
    );
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
