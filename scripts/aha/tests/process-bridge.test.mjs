import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
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
      codexModel: "gpt-5.3-codex-spark",
      codexReasoningEffort: "low",
      codexSandbox: "danger-full-access",
      reviewFolder: "Aha/Reviews",
      codexCommand: helper,
      qmdCommand: helper,
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
