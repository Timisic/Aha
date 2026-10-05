import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { realTestConfig } from "../../../lib/real-test-config.mjs";

test("an ambient API key cannot opt direct E2E discovery into real services", () => {
  const env = { ...process.env, DEEPSEEK_API_KEY: "boundary-test-not-a-secret", AHA_RUN_REAL_E2E: "" };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, ["--test", "--test-reporter=tap", "scripts/aha/tests/e2e/e2e-batch-vault-runner.test.mjs", "scripts/aha/tests/e2e/e2e-real-deepseek.test.mjs"], {
    cwd: path.resolve(import.meta.dirname, "../../../.."),
    env,
    encoding: "utf8",
    timeout: 10000,
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /# pass 0/);
  assert.match(result.stdout, /# skipped 2/);
});

test("real test configuration requires a temporary vault and separate index", async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), "aha-e2e-boundary-"));
  try {
    await mkdir(path.join(scratch, ".obsidian/plugins"), { recursive: true });
    const env = { DEEPSEEK_API_KEY: "test", AHA_E2E_VAULT_ROOT: scratch, AHA_E2E_QMD_INDEX: "synthetic-test" };
    assert.equal((await realTestConfig(env)).qmdIndex, "synthetic-test");
    await assert.rejects(realTestConfig({ ...env, AHA_E2E_VAULT_ROOT: "" }), /AHA_E2E_VAULT_ROOT/);
    await assert.rejects(realTestConfig({ ...env, AHA_E2E_QMD_INDEX: "obsidian" }), /fixture index/);
    await symlink(path.resolve(import.meta.dirname, "../../../.."), path.join(scratch, "outside"));
    await assert.rejects(realTestConfig({ ...env, AHA_E2E_VAULT_ROOT: path.join(scratch, "outside") }), /temporary fixture vault/);
    await rm(path.join(scratch, ".obsidian/plugins"), { recursive: true });
    await symlink(path.resolve(import.meta.dirname, "../../../.."), path.join(scratch, ".obsidian/plugins"));
    await assert.rejects(realTestConfig(env), /must not redirect/);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
