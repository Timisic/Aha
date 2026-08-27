// Tests for the settings-page health section's pure decision logic (issue
// #59): qmd-status text parsing, each light's color decision, and the
// embed-button sequencing/progress logic. health-checks.ts has no
// `obsidian` import and no subprocess/network I/O, so this bundles and runs
// with no stub -- every probe result is a plain fixture object.

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const repoRoot = path.resolve(import.meta.dirname, "../../../..");
const requireFromPlugin = createRequire(path.join(repoRoot, "obsidian-plugin/package.json"));
const esbuild = requireFromPlugin("esbuild");

async function loadModule() {
  const temp = await mkdtemp(path.join(tmpdir(), "aha-health-checks-test-"));
  const entry = path.join(temp, "entry.ts");
  const out = path.join(temp, "bundle.mjs");
  await writeFile(entry, `export * from ${JSON.stringify(path.join(repoRoot, "obsidian-plugin/src/health-checks.ts"))};\n`);
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

const HEALTHY_STATUS_TEXT = [
  "Documents",
  "  Total:    388 files indexed",
  "  Vectors:  594 embedded",
  "  Updated:  16d ago",
  "Collections",
  "  obsidian (...)",
  "    Files:    388 (...)",
  "Models",
  "  Embedding:  text-embedding-3-small",
  "  Reranking:  bge-reranker-v2",
  "  Generation: gpt-5.5",
].join("\n");

const ZERO_FILES_STATUS_TEXT = [
  "Documents",
  "  Total:    0 files indexed",
  "  Vectors:  0 embedded",
  "  Updated:  never",
].join("\n");

test("parseQmdStatusOutput extracts total indexed, vectors, updated-ago, and models from a healthy blob", async () => {
  const { parseQmdStatusOutput } = await loadModule();
  const parsed = parseQmdStatusOutput(HEALTHY_STATUS_TEXT);
  assert.equal(parsed.totalIndexed, 388);
  assert.equal(parsed.vectorsEmbedded, 594);
  assert.equal(parsed.updatedAgo, "16d ago");
  assert.equal(parsed.models.embedding, "text-embedding-3-small");
  assert.equal(parsed.models.reranking, "bge-reranker-v2");
  assert.equal(parsed.models.generation, "gpt-5.5");
});

test("parseQmdStatusOutput handles a 0-files blob without throwing", async () => {
  const { parseQmdStatusOutput } = await loadModule();
  const parsed = parseQmdStatusOutput(ZERO_FILES_STATUS_TEXT);
  assert.equal(parsed.totalIndexed, 0);
  assert.equal(parsed.vectorsEmbedded, 0);
  assert.equal(parsed.models.embedding, null);
});

test("parseQmdStatusOutput tolerates unparseable/empty text", async () => {
  const { parseQmdStatusOutput } = await loadModule();
  const parsed = parseQmdStatusOutput("command not found: qmd");
  assert.equal(parsed.totalIndexed, null);
  assert.equal(parsed.vectorsEmbedded, null);
  assert.equal(parsed.updatedAgo, null);
});

test("decideQmdBinaryLight is green when available, red with an install fix command otherwise", async () => {
  const { decideQmdBinaryLight } = await loadModule();
  assert.equal(decideQmdBinaryLight(true).ok, true);
  const red = decideQmdBinaryLight(false);
  assert.equal(red.ok, false);
  assert.match(red.fixCommand, /Install qmd/);
});

test("decideIndexCoverageLight is red when the status probe itself failed", async () => {
  const { decideIndexCoverageLight } = await loadModule();
  const light = decideIndexCoverageLight({ ok: false, stdout: "", message: "qmd: command not found" }, 400, "obsidian");
  assert.equal(light.ok, false);
  assert.match(light.message, /command not found/);
  assert.equal(light.fixCommand, "qmd update --index obsidian");
});

test("decideIndexCoverageLight is red on a 0-files-indexed blob", async () => {
  const { decideIndexCoverageLight } = await loadModule();
  const light = decideIndexCoverageLight({ ok: true, stdout: ZERO_FILES_STATUS_TEXT, message: "" }, 400, "obsidian");
  assert.equal(light.ok, false);
  assert.match(light.message, /0 files indexed/);
});

test("decideIndexCoverageLight is red when the indexed count is far below the vault's real file count", async () => {
  const { decideIndexCoverageLight } = await loadModule();
  const light = decideIndexCoverageLight({ ok: true, stdout: HEALTHY_STATUS_TEXT, message: "" }, 4000, "obsidian");
  assert.equal(light.ok, false);
  assert.match(light.message, /388 of the vault's 4000/);
});

test("decideIndexCoverageLight is green when the indexed count roughly covers the vault", async () => {
  const { decideIndexCoverageLight } = await loadModule();
  const light = decideIndexCoverageLight({ ok: true, stdout: HEALTHY_STATUS_TEXT, message: "" }, 388, "obsidian");
  assert.equal(light.ok, true);
  assert.match(light.message, /388 files indexed/);
});

test("decideQmdEndpointsLight is red on a malformed configured URL", async () => {
  const { decideQmdEndpointsLight } = await loadModule();
  const light = decideQmdEndpointsLight({ QMD_REMOTE_EMBED_URL: "not-a-url" }, { ok: true, stdout: HEALTHY_STATUS_TEXT, message: "" }, "obsidian");
  assert.equal(light.ok, false);
  assert.match(light.message, /QMD_REMOTE_EMBED_URL/);
});

test("decideQmdEndpointsLight is green with valid URLs and a populated Models section", async () => {
  const { decideQmdEndpointsLight } = await loadModule();
  const light = decideQmdEndpointsLight({ QMD_REMOTE_EMBED_URL: "https://embed.example/v1" }, { ok: true, stdout: HEALTHY_STATUS_TEXT, message: "" }, "obsidian");
  assert.equal(light.ok, true);
});

test("decideQmdEndpointsLight is green (using local/default inference) when no endpoint overrides are configured", async () => {
  const { decideQmdEndpointsLight } = await loadModule();
  const light = decideQmdEndpointsLight({}, { ok: true, stdout: HEALTHY_STATUS_TEXT, message: "" }, "obsidian");
  assert.equal(light.ok, true);
  assert.match(light.message, /local\/default/);
});

test("decideQmdEndpointsLight is red when qmd status itself failed (can't confirm endpoints)", async () => {
  const { decideQmdEndpointsLight } = await loadModule();
  const light = decideQmdEndpointsLight({}, { ok: false, stdout: "", message: "qmd: command not found" }, "obsidian");
  assert.equal(light.ok, false);
});

test("decideLlmConnectivityLight wraps testProviderConnection's ok/failure shape with a key/key-env fix hint", async () => {
  const { decideLlmConnectivityLight } = await loadModule();
  const green = decideLlmConnectivityLight({ ok: true, provider: "openai", model: "gpt-5.5", message: "reachable" });
  assert.equal(green.ok, true);
  const red = decideLlmConnectivityLight({ ok: false, provider: "openai", model: "gpt-5.5", message: "OPENAI_API_KEY is not set." });
  assert.equal(red.ok, false);
  assert.match(red.fixCommand, /key/i);
});

// --- Embed sequencing -------------------------------------------------------

test("runEmbedSequence runs update to completion before starting embed", async () => {
  const { runEmbedSequence } = await loadModule();
  const calls = [];
  const outcome = await runEmbedSequence(
    {
      runUpdate: async () => {
        calls.push("update");
        return { ok: true, message: "update ok" };
      },
      runEmbed: async () => {
        calls.push("embed");
        return { ok: true, message: "embed ok" };
      },
    },
    () => {},
  );
  assert.deepEqual(calls, ["update", "embed"]);
  assert.equal(outcome.ok, true);
  assert.equal(outcome.steps.length, 2);
});

test("runEmbedSequence reports progress for both steps in order", async () => {
  const { runEmbedSequence } = await loadModule();
  const progress = [];
  await runEmbedSequence(
    {
      runUpdate: async () => ({ ok: true, message: "update ok" }),
      runEmbed: async () => ({ ok: true, message: "embed ok" }),
    },
    (step, status) => progress.push(`${step}:${status}`),
  );
  assert.deepEqual(progress, ["update:started", "update:succeeded", "embed:started", "embed:succeeded"]);
});

test("runEmbedSequence never calls runEmbed when runUpdate fails", async () => {
  const { runEmbedSequence } = await loadModule();
  let embedCalled = false;
  const outcome = await runEmbedSequence(
    {
      runUpdate: async () => ({ ok: false, message: "update failed: qmd exited 1" }),
      runEmbed: async () => {
        embedCalled = true;
        return { ok: true, message: "embed ok" };
      },
    },
    () => {},
  );
  assert.equal(embedCalled, false);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.steps.length, 1);
  assert.equal(outcome.steps[0].step, "update");
  assert.match(outcome.steps[0].message, /update failed/);
});

test("runEmbedSequence surfaces an embed-step failure after a successful update", async () => {
  const { runEmbedSequence } = await loadModule();
  const progress = [];
  const outcome = await runEmbedSequence(
    {
      runUpdate: async () => ({ ok: true, message: "update ok" }),
      runEmbed: async () => ({ ok: false, message: "embed failed: qmd exited 2" }),
    },
    (step, status, message) => progress.push({ step, status, message }),
  );
  assert.equal(outcome.ok, false);
  assert.equal(outcome.steps.length, 2);
  assert.equal(outcome.steps[1].ok, false);
  assert.ok(progress.some((entry) => entry.step === "embed" && entry.status === "failed" && /embed failed/.test(entry.message ?? "")));
});
