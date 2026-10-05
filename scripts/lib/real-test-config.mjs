import assert from "node:assert/strict";
import { realpath, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export async function realTestConfig(env) {
  assert(env.DEEPSEEK_API_KEY, "Set DEEPSEEK_API_KEY for real provider tests");
  assert(env.AHA_E2E_VAULT_ROOT, "Set AHA_E2E_VAULT_ROOT to a disposable fixture vault under the system temporary directory");
  assert(env.AHA_E2E_QMD_INDEX && env.AHA_E2E_QMD_INDEX !== "obsidian", "Set AHA_E2E_QMD_INDEX to the fixture index, not obsidian");
  const vaultRoot = await realpath(env.AHA_E2E_VAULT_ROOT);
  const relative = path.relative(await realpath(tmpdir()), vaultRoot);
  assert(relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative), "Real tests require a temporary fixture vault");
  const plugins = path.join(vaultRoot, ".obsidian", "plugins");
  assert.equal(await realpath(plugins), plugins, "Fixture plugin directory must not redirect outside its vault");
  assert((await stat(plugins)).isDirectory(), "Fixture vault needs .obsidian/plugins");
  return { vaultRoot, qmdIndex: env.AHA_E2E_QMD_INDEX };
}
