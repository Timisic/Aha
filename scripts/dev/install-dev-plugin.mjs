// Side-by-side dev-channel installer (issue #55).
//
// Builds the production plugin bundle and installs it into the vault under the
// dev plugin id `aha-memory-surface-dev`, so a development copy runs next to
// the production install (`aha-memory-surface`) against the same notes and qmd
// index. Only the -dev directory is ever written; the production plugin
// directory and its settings store are never touched. The dev install keeps
// its own data.json (different plugin id), which this script never overwrites.
//
// Vault root defaults to ~/Obsidian Notes and can be overridden with
// AHA_DEV_VAULT_ROOT.

import { spawnSync } from "node:child_process";
import { access, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

const PROD_PLUGIN_ID = "aha-memory-surface";
const DEV_PLUGIN_ID = "aha-memory-surface-dev";
const COPIED_FILES = ["main.js", "styles.css", "versions.json"];

const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const pluginDir = path.join(repoRoot, "obsidian-plugin");

const vaultRoot = (process.env.AHA_DEV_VAULT_ROOT ?? "").trim() || path.join(homedir(), "Obsidian Notes");
const pluginsDir = path.join(vaultRoot, ".obsidian", "plugins");
const targetDir = path.join(pluginsDir, DEV_PLUGIN_ID);
const productionDir = path.join(pluginsDir, PROD_PLUGIN_ID);

// Guard the production install: refuse to run if the target ever resolves to
// anything other than the dedicated -dev directory.
if (path.basename(targetDir) !== DEV_PLUGIN_ID || path.resolve(targetDir) === path.resolve(productionDir)) {
  fail(`Refusing to install: target ${targetDir} is not the dedicated ${DEV_PLUGIN_ID} directory.`);
}

if (!(await exists(path.join(vaultRoot, ".obsidian")))) {
  fail(`No Obsidian vault found at ${vaultRoot} (missing .obsidian). Set AHA_DEV_VAULT_ROOT to the vault root.`);
}

console.log(`Building production plugin bundle in ${pluginDir} ...`);
const build = spawnSync(process.execPath, ["esbuild.config.mjs", "production"], {
  cwd: pluginDir,
  stdio: "inherit",
});
if (build.error) fail(`Plugin build failed to spawn: ${build.error.message}`);
if (build.status !== 0) fail(`Plugin build failed with exit code ${build.status}.`);

for (const name of COPIED_FILES) {
  if (!(await exists(path.join(pluginDir, name)))) {
    fail(`Build artifact ${name} is missing from ${pluginDir}.`);
  }
}

const manifest = JSON.parse(await readFile(path.join(pluginDir, "manifest.json"), "utf8"));
if (manifest.id !== PROD_PLUGIN_ID) {
  fail(`Unexpected manifest id "${manifest.id}" (expected "${PROD_PLUGIN_ID}"); refusing to rewrite it.`);
}
manifest.id = DEV_PLUGIN_ID;
manifest.name = `${manifest.name} (Dev)`;

await mkdir(targetDir, { recursive: true });
for (const name of COPIED_FILES) {
  await copyFile(path.join(pluginDir, name), path.join(targetDir, name));
}
await writeFile(path.join(targetDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`Installed dev plugin "${manifest.name}" (id ${DEV_PLUGIN_ID}) into:`);
console.log(`  ${targetDir}`);
console.log(`Copied: ${COPIED_FILES.join(", ")}; wrote rewritten manifest.json.`);
console.log(`Production install left untouched: ${productionDir}`);
console.log("Next: in Obsidian, reload the app (or toggle community plugins) and enable \"Aha (Dev)\".");

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
