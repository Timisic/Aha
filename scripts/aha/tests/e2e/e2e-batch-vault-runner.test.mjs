import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { DEFAULT_DEEPSEEK_API_KEY_ENV, DEFAULT_DEEPSEEK_BASE_URL, DEFAULT_DEEPSEEK_MODEL } from "../../../lib/openai-json-agent.mjs";
import { normalizeSessionStore } from "../../../lib/session-artifact.mjs";
import { realTestConfig } from "../../../lib/real-test-config.mjs";
import { dataJsonPathFor, loadPipelineConfig, runOneNote } from "../../../dev/run-batch-vault.mjs";

const DEEPSEEK_API_KEY = process.env[DEFAULT_DEEPSEEK_API_KEY_ENV];
// A real run through the full pipeline (query plan -> QMD retrieval -> note
// excerpt loading -> Relation Judge over every candidate) took ~5 minutes
// against the real dev vault during development of this test; this leaves
// comfortable headroom above that.
const E2E_TIMEOUT_MS = 480_000;
const PLUGIN_ID = "aha-memory-surface-e2e-test";
const SCRATCH_NOTE_PATH = "_aha-batch-vault-runner-e2e-scratch.md";

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

async function pathExists(targetPath) {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

if (process.env.AHA_RUN_REAL_E2E !== "1" || !DEEPSEEK_API_KEY) {
  test(`real batch-vault-runner E2E test (skipped: use npm run test:e2e:real with explicit configuration)`, { skip: true }, () => {});
} else {
  const { vaultRoot, qmdIndex } = await realTestConfig(process.env);
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
      const legacyAhaDirectory = path.join(vaultRoot, "Aha");
      const legacyAhaDirectoryExisted = await pathExists(legacyAhaDirectory);

      assert.equal(await pathExists(scratchAbsPath), false, "Refuse to overwrite an existing note");
      await mkdir(path.dirname(dataJsonPath), { recursive: false });
      let noteCreated = false;
      try {
        await writeFile(
          scratchAbsPath,
          "# 批量跑测试笔记\n\n这是 batch vault runner 的端到端测试笔记，跑完可以删除。记录一次关于坚持写复盘的想法。",
          { flag: "wx" },
        );
        noteCreated = true;

        await writeFile(dataJsonPath, JSON.stringify({
          settings: {
            llmProvider: "deepseek",
            deepseekApiKeyEnv: DEFAULT_DEEPSEEK_API_KEY_ENV,
            deepseekBaseUrl: process.env.DEEPSEEK_TEST_BASE_URL || DEFAULT_DEEPSEEK_BASE_URL,
            deepseekModel: process.env.DEEPSEEK_TEST_MODEL || DEFAULT_DEEPSEEK_MODEL,
            qmdCommand: "qmd",
            qmdIndex,
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
        if (noteCreated) await rm(scratchAbsPath, { force: true });
        await rm(path.dirname(dataJsonPath), { recursive: true, force: true });
        if (!legacyAhaDirectoryExisted) {
          assert.equal(
            await pathExists(legacyAhaDirectory),
            false,
            "the E2E test must not leave a vault-root Aha directory behind",
          );
        }
      }
    });
  }
}
