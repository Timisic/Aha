import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const packageJson = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf-8"));

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? packageRoot,
    encoding: "utf-8",
    env: options.env ?? process.env,
    timeout: options.timeoutMs ?? 120_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status}\n${result.stdout}\n${result.stderr}`);
  }
  return result;
}

const smokeRoot = mkdtempSync(join(tmpdir(), "aha-clean-smoke-"));
const fakeHome = join(smokeRoot, "home");
const installRoot = join(smokeRoot, "install-root");
const runtimeRoot = join(smokeRoot, "runtime");
const fakeDeps = join(smokeRoot, "fake-deps");
mkdirSync(fakeHome, { recursive: true });
mkdirSync(installRoot, { recursive: true });
mkdirSync(runtimeRoot, { recursive: true });
mkdirSync(fakeDeps, { recursive: true });

const typeboxPath = join(fakeDeps, "typebox.mjs");
const tuiPath = join(fakeDeps, "pi-tui.mjs");
writeFileSync(typeboxPath, `
const schema = (type, extra = {}) => ({ type, ...extra });
export const Type = {
  Object: (properties = {}, options = {}) => ({ type: 'object', properties, ...options }),
  Array: (items, options = {}) => ({ type: 'array', items, ...options }),
  String: (options = {}) => schema('string', options),
  Number: (options = {}) => schema('number', options),
  Boolean: (options = {}) => schema('boolean', options),
  Literal: (value) => ({ const: value }),
  Union: (anyOf) => ({ anyOf }),
  Optional: (inner) => ({ ...inner, optional: true }),
};
`);
writeFileSync(tuiPath, `
export function visibleWidth(value) { return String(value ?? '').length; }
export function truncateToWidth(value, maxWidth, ellipsis = '…') {
  const text = String(value ?? '');
  return text.length > maxWidth ? text.slice(0, Math.max(0, maxWidth - ellipsis.length)) + ellipsis : text;
}
`);
writeFileSync(join(installRoot, "package.json"), "{\"private\":true,\"type\":\"module\"}\n");

const pack = run("npm", ["pack", "--pack-destination", smokeRoot, "--json"]);
const packed = JSON.parse(pack.stdout)[0];
const tarball = join(smokeRoot, packed.filename);
assert.ok(existsSync(tarball), "npm pack tarball created");
run("npm", ["install", "--ignore-scripts", "--legacy-peer-deps", tarball], { cwd: installRoot });

const installedPackageDir = join(installRoot, "node_modules", ...packageJson.name.split("/"));
const installedExtension = join(installedPackageDir, "extensions", "insight.ts");
assert.ok(existsSync(installedExtension), "extension entrypoint installed from packed package");

const runnerPath = join(smokeRoot, "run-installed-smoke.mjs");
writeFileSync(runnerPath, `
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const installedExtension = ${JSON.stringify(installedExtension)};
const runtimeRoot = ${JSON.stringify(runtimeRoot)};
const smokeRoot = ${JSON.stringify(smokeRoot)};
process.env.HOME = ${JSON.stringify(fakeHome)};
process.env.INSIGHT_HOME = runtimeRoot;
process.env.PI_TYPEBOX_PATH = ${JSON.stringify(typeboxPath)};
process.env.PI_TUI_PATH = ${JSON.stringify(tuiPath)};
process.env.INSIGHT_MEMORY_RERANKER = "none";

const extension = (await import(installedExtension)).default;
const commands = new Map();
const tools = new Map();
const sessionEntries = [];
const pi = {
  registerCommand(name, options) {
    assert.ok(!commands.has(name), name + " registered exactly once");
    commands.set(name, options);
  },
  registerTool(tool) {
    assert.ok(!tools.has(tool.name), tool.name + " registered exactly once");
    tools.set(tool.name, tool);
  },
  on() {},
  sendUserMessage(content, options) {
    sessionEntries.push({ type: "sent", content, options });
  },
  appendEntry(customType, data) {
    sessionEntries.push({ type: "custom", customType, data });
  },
};

extension(pi);
assert.equal(commands.size, 1, "one command registered");
assert.ok(commands.has("insight"), "/insight command registered");
assert.ok(tools.has("insight_search_memory"), "search tool registered");

const cwd = join(smokeRoot, "cwd");
mkdirSync(cwd, { recursive: true });
const notifications = [];
await commands.get("insight").handler("Insight: clean package smoke\\nContext: synthetic reranker-off demo", {
  cwd,
  hasUI: true,
  ui: {
    notify(message, type) { notifications.push({ message, type }); },
    setStatus(key, text) { notifications.push({ key, text }); },
    setEditorText() {},
    editor: async () => "Insight: clean package smoke",
  },
  sessionManager: {
    getBranch: () => [],
    getEntries: () => [],
  },
});

const indexPath = join(runtimeRoot, "index.json");
assert.ok(existsSync(indexPath), "session index created under fresh INSIGHT_HOME");
const index = JSON.parse(readFileSync(indexPath, "utf-8"));
assert.equal(index.length, 1, "one smoke session created");
assert.ok(existsSync(join(index[0].dir, "state.json")), "state artifact created");
assert.ok(existsSync(join(index[0].dir, "grill-context.md")), "grill artifact created");
assert.ok(sessionEntries.some((entry) => entry.type === "sent"), "synthetic demo input was replayed to Pi follow-up");
console.log("clean package smoke passed");
`);

run("bun", [runnerPath], {
  cwd: installRoot,
  env: {
    ...process.env,
    HOME: fakeHome,
    INSIGHT_HOME: runtimeRoot,
    PI_TYPEBOX_PATH: typeboxPath,
    PI_TUI_PATH: tuiPath,
    INSIGHT_MEMORY_RERANKER: "none",
  },
});
