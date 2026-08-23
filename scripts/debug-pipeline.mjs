#!/usr/bin/env node
// CLI harness for debugging the full pipeline outside Obsidian.
// Usage: node scripts/debug-pipeline.mjs "2026-08-23 放弃太早容易丢失很多.md"

import { readFile } from "node:fs/promises";
import path from "node:path";
import { homedir } from "node:os";
import { runFullPipeline } from "./lib/core-artifact.mjs";
import { createQmdCliRunner } from "./lib/core-node-deps.mjs";

const VAULT_ROOT = path.join(homedir(), "Obsidian Notes");
const DATA_JSON = path.join(VAULT_ROOT, ".obsidian/plugins/aha-memory-surface/data.json");

const sourceName = process.argv[2] || "2026-08-23 放弃太早容易丢失很多.md";
const sourcePath = sourceName;
const sourceAbsPath = path.join(VAULT_ROOT, sourcePath);

console.log(`--- Source: ${sourcePath} ---`);
console.log(`--- Vault: ${VAULT_ROOT} ---\n`);

const sourceText = await readFile(sourceAbsPath, "utf-8");
console.log(`Source text: ${sourceText.length} chars\n`);

const data = JSON.parse(await readFile(DATA_JSON, "utf-8"));
const settings = data.settings;

const provider = settings.llmProvider || "deepseek";
const isDeepSeek = provider === "deepseek";
const apiKey = isDeepSeek
  ? (settings.deepseekApiKey || process.env[settings.deepseekApiKeyEnv] || "")
  : (settings.llmApiKey || process.env[settings.llmApiKeyEnv] || "");
const baseUrl = isDeepSeek ? settings.deepseekBaseUrl : settings.llmBaseUrl;
const model = isDeepSeek ? settings.deepseekModel : settings.llmModel;
const protocol = isDeepSeek ? "chat-completions" : "responses";

console.log(`LLM: ${provider} / ${model} / ${baseUrl} / protocol=${protocol}`);
console.log(`API key: ${apiKey ? apiKey.slice(0, 4) + "..." : "MISSING"}\n`);

const excludedFolders = (settings.excludedFolders || "templates")
  .split(/[,\n]/).map(s => s.trim()).filter(Boolean);
console.log(`Excluded folders: ${JSON.stringify(excludedFolders)}`);

const qmdDeps = createQmdCliRunner({
  qmdCommand: settings.qmdCommand || "qmd",
  qmdIndex: settings.qmdIndex || "obsidian",
  qmdRerank: settings.qmdRerank || false,
  targetCandidates: settings.targetCandidates || 20,
});

const llmConfig = {
  baseUrl,
  apiKey,
  model,
  protocol,
  timeoutMs: 120_000,
};

const args = {
  sourcePath,
  sourceText,
  sourceAbsolutePath: sourceAbsPath,
  vaultRoot: VAULT_ROOT,
  reviewPath: "Aha/Reviews/placeholder.md",
  id: sourcePath,
  displayName: "Aha",
  _resolved_insight_input: sourceText,
  targetCandidates: settings.targetCandidates || 20,
  excludedFolders,
};

console.log(`\n--- Running full pipeline ---\n`);

try {
  const result = await runFullPipeline(args, llmConfig, qmdDeps);
  console.log(`\n--- Result ---`);
  console.log(`ok: ${result.ok}`);
  console.log(`generatedBy: ${result.queryPlanGeneratedBy}`);
  console.log(`fallback: ${result.queryPlanFallback}`);
  console.log(`candidates: ${result.candidates.length}`);
  if (result.error) {
    console.log(`error: ${JSON.stringify(result.error)}`);
  }
  console.log(`summary: ${result.summary}`);
  for (const w of result.warnings || []) {
    console.log(`  WARN: ${w}`);
  }
  console.log();
  for (const [i, c] of (result.candidates || []).entries()) {
    console.log(`  [${i + 1}] ${c.notePath}`);
    console.log(`      relation=${c.relation}  hit=${String(c.hit || "").slice(0, 80)}`);
    console.log(`      why=${String(c.why || "").slice(0, 120)}`);
    console.log();
  }
} catch (err) {
  console.error("Pipeline threw:", err);
}
