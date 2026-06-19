#!/usr/bin/env node
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "../..");
const packageRoot = resolve(repoRoot, "insight-package");
const demoVault = resolve(packageRoot, "demo-vault");
const keep = process.argv.includes("--keep");
const workRoot = mkdtempSync(join(tmpdir(), "aha-demo-"));
const binDir = join(workRoot, "bin");
const insightHome = join(workRoot, "insights");
mkdirSync(binDir, { recursive: true });

function makeExecutable(path, body) {
  writeFileSync(path, body, "utf-8");
  chmodSync(path, 0o755);
}

makeExecutable(join(binDir, "qmd"), [
  "#!/usr/bin/env node",
  "if (process.argv.includes('--version')) { console.log('qmd 1.2.3-demo'); process.exit(0); }",
  "process.stdout.write(JSON.stringify([",
  "  { file: 'feedback-boundary.md', title: 'Feedback exposes learning boundaries', snippet: 'Feedback is useful when it exposes a concrete gap between judgment and evidence.', score: 0.91 },",
  "  { file: 'counterexample.md', title: 'Counterexample before confidence', snippet: 'Keep one counterexample visible before a durable judgment.', score: 0.86 }",
  "]));",
].join("\n"));

makeExecutable(join(binDir, "obsidian"), [
  "#!/usr/bin/env node",
  "const { readFileSync } = require('node:fs');",
  "const { join } = require('node:path');",
  "if (process.argv.includes('--version')) { console.log('obsidian 1.0.0-demo'); process.exit(0); }",
  "const command = process.argv[2];",
  "if (command === 'backlinks') { process.stdout.write('[]'); process.exit(0); }",
  "const arg = process.argv.find((item) => item.startsWith('path=') || item.startsWith('file='));",
  "if (!arg) { process.stdout.write('[]'); process.exit(0); }",
  "const name = arg.split('=').slice(1).join('=');",
  "const path = join(process.env.AHA_DEMO_VAULT, name.endsWith('.md') ? name : `${name}.md`);",
  "try { process.stdout.write(readFileSync(path, 'utf8')); } catch { process.stdout.write(''); }",
].join("\n"));

const oldEnv = { ...process.env };
Object.assign(process.env, {
  INSIGHT_HOME: insightHome,
  QMD_BIN: join(binDir, "qmd"),
  OBSIDIAN_BIN: join(binDir, "obsidian"),
  INSIGHT_SOURCE_ROOTS: demoVault,
  INSIGHT_MEMORY_RERANKER: "off",
  INSIGHT_EXPAND_BACKLINKS: "0",
  AHA_DEMO_VAULT: demoVault,
});

globalThis.__ahaInsightExtensionRegisterCount = 0;
const { default: extension } = await import(pathToFileURL(join(packageRoot, "extensions/insight.ts")).href);

const commands = new Map();
const tools = new Map();
const sessionEntries = [];
const editorTexts = [];
const notifications = [];
const pi = {
  version: "0.79.7",
  registerCommand(name, options) { commands.set(name, options); },
  registerTool(tool) { tools.set(tool.name, tool); },
  on() {},
  sendUserMessage(content, options) { notifications.push({ followUp: content, options }); },
  appendEntry(customType, data) { sessionEntries.push({ type: "custom", customType, data, timestamp: new Date().toISOString() }); },
};
extension(pi);
const ctx = {
  cwd: repoRoot,
  hasUI: true,
  ui: {
    editor: async () => "",
    notify(message, type) { notifications.push({ message, type }); },
    setEditorText(text) { editorTexts.push(text); },
    setStatus() {},
  },
  sessionManager: {
    getEntries: () => sessionEntries.slice(),
    getBranch: () => sessionEntries.slice(),
  },
};

const insight = commands.get("insight");
await insight.handler("doctor --json", ctx);
const doctor = JSON.parse(editorTexts.at(-1));
if (!doctor.ok) {
  console.error("Aha offline demo doctor failed:");
  console.error(JSON.stringify(doctor.checks.filter((check) => check.status === "fail"), null, 2));
  process.exit(1);
}

await insight.handler([
  "Insight: Feedback only helps when it changes the next judgment.",
  "",
  "Context: First-run synthetic demo with no private vault.",
  "",
  "Connected History Notes:",
  "- Feedback exposes learning boundaries",
].join("\n"), ctx);

const search = tools.get("insight_search_memory");
const searchResult = await search.execute("demo-search", {
  limit: 2,
  queries: [{
    kind: "contextual",
    command: "qmd query",
    text: "feedback judgment counterexample",
    qmd: {
      intent: "Find synthetic notes that help judge whether feedback changes a decision.",
      lex: ["feedback", "judgment", "counterexample"],
      vec: "Feedback only helps when it changes the next judgment.",
      hyde: "A useful memory note shows a boundary, counterexample, or next decision tied to feedback.",
    },
  }],
}, undefined, undefined, ctx);

const indexPath = join(insightHome, "index.json");
const index = JSON.parse(readFileSync(indexPath, "utf-8"));
const sessionDir = index[0]?.dir;

console.log("Aha offline demo: PASS");
console.log(`Doctor checks: ${doctor.checks.length} checks, required failures: 0`);
console.log(`Candidate rows: ${searchResult.details?.candidateCount ?? searchResult.details?.candidates?.length ?? "see state.json"}`);
console.log(`Session artifacts: ${sessionDir}`);
console.log(`Demo state root: ${workRoot}`);
if (!keep) {
  rmSync(workRoot, { recursive: true, force: true });
  console.log("Demo state cleaned up. Re-run with --keep to inspect artifacts.");
}
Object.assign(process.env, oldEnv);
