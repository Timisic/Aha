// True end-to-end test for the batch vault runner
// (BATCH-VAULT-RUNNER-PLAN.md, scripts/dev/run-batch-vault.mjs): one real
// note, one real call to DeepSeek and QMD, asserting the run doesn't throw
// and the data.json it writes reads back cleanly through
// normalizeSessionStore(). Mirrors the layering of
// e2e-real-deepseek.test.mjs: auto-runs when DEEPSEEK_API_KEY is set and a
// real vault + qmd binary are available, skips with a clear message
// otherwise, so `npm test` never costs money or needs local vault state.
//
// Uses a real note written into the real vault (so QMD's index has
// something real to search against and path resolution behaves normally),
// but writes to a throwaway plugin id's data.json
// (aha-memory-surface-e2e-test) so it never touches the real dev/production
// plugin state -- cleaned up in a finally block either way.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { DEFAULT_DEEPSEEK_API_KEY_ENV, DEFAULT_DEEPSEEK_BASE_URL, DEFAULT_DEEPSEEK_MODEL } from "../../../lib/openai-json-agent.mjs";
import { normalizeSessionStore } from "../../../lib/session-artifact.mjs";
import { benchVaultRoot } from "../../../lib/vault-paths.mjs";
import { dataJsonPathFor, loadPipelineConfig, runOneNote } from "../../../dev/run-batch-vault.mjs";

const DEEPSEEK_API_KEY = process.env[DEFAULT_DEEPSEEK_API_KEY_ENV];
// A real run through the full pipeline (query plan -> QMD retrieval -> note
// excerpt loading -> Relation Judge over every candidate) took ~5 minutes
// against the real dev vault during development of this test; this leaves
// comfortable headroom above that.
const E2E_TIMEOUT_MS = 480_000;
const PLUGIN_ID = "aha-memory-surface-e2e-test";
const SCRATCH_NOTE_PATH = "Aha/_batch-vault-runner-e2e-scratch.md";

function qmdAvailable(qmdCommand) {
  const probe = spawnSync(qmdCommand, ["--help"], { encoding: "utf-8" });
  return !probe.error;
}

async function vaultExists(vaultRoot) {
  try {
    await access(path.join(vaultRoot, ".obsidian"));
    return true;
  } catch {
    return false;
  }
}

if (!DEEPSEEK_API_KEY) {
  test(`real batch-vault-runner E2E test (skipped: ${DEFAULT_DEEPSEEK_API_KEY_ENV} is not set)`, { skip: true }, () => {});
} else {
  const vaultRoot = benchVaultRoot();
  const hasVault = await vaultExists(vaultRoot);
  const hasQmd = hasVault && qmdAvailable("qmd");

  if (!hasVault) {
    test(`real batch-vault-runner E2E test (skipped: no real vault found at ${vaultRoot})`, { skip: true }, () => {});
  } else if (!hasQmd) {
    test("real batch-vault-runner E2E test (skipped: qmd binary not available)", { skip: true }, () => {});
  } else {
    test("runs one real note through the batch vault runner end to end", { timeout: E2E_TIMEOUT_MS }, async () => {
      const scratchAbsPath = path.join(vaultRoot, SCRATCH_NOTE_PATH);
      const dataJsonPath = dataJsonPathFor(vaultRoot, PLUGIN_ID);

      try {
        await mkdir(path.dirname(scratchAbsPath), { recursive: true });
        await writeFile(
          scratchAbsPath,
          "# 批量跑测试笔记\n\n这是 batch vault runner 的端到端测试笔记，跑完可以删除。记录一次关于坚持写复盘的想法。",
        );

        await mkdir(path.dirname(dataJsonPath), { recursive: true });
        await writeFile(dataJsonPath, JSON.stringify({
          settings: {
            llmProvider: "deepseek",
            deepseekApiKeyEnv: DEFAULT_DEEPSEEK_API_KEY_ENV,
            deepseekBaseUrl: process.env.DEEPSEEK_TEST_BASE_URL || DEFAULT_DEEPSEEK_BASE_URL,
            deepseekModel: process.env.DEEPSEEK_TEST_MODEL || DEFAULT_DEEPSEEK_MODEL,
            qmdCommand: "qmd",
            qmdIndex: "obsidian",
            targetCandidates: 5,
            excludedFolders: "templates",
          },
          sessionStore: { schemaVersion: 1, records: {} },
          schemaVersion: 1,
        }, null, 2));

        const config = await loadPipelineConfig(dataJsonPath);
        assert.ok(config.llmConfig.apiKey, "expected the real DeepSeek key to be threaded through");

        const outcome = await runOneNote({ vaultRoot, pluginId: PLUGIN_ID }, config, SCRATCH_NOTE_PATH);
        assert.equal(typeof outcome.ok, "boolean");

        const written = JSON.parse(await readFile(dataJsonPath, "utf-8"));
        const store = normalizeSessionStore(written.sessionStore);
        const records = Object.values(store.records);
        assert.equal(records.length, 1);
        assert.equal(records[0].source.path, SCRATCH_NOTE_PATH);
        assert.equal(records[0].rounds.length, 1);
        assert.ok(["success", "failed"].includes(records[0].rounds[0].status));
      } finally {
        await rm(scratchAbsPath, { force: true });
        await rm(path.dirname(dataJsonPath), { recursive: true, force: true });
      }
    });
  }
}
