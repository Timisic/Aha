#!/usr/bin/env node
// Batch vault runner (BATCH-VAULT-RUNNER-PLAN.md). Runs the real Aha pipeline
// (real vault, real DeepSeek, real QMD index) over a batch of real notes --
// one at a time, strictly serial across notes -- and writes each note's
// result into the same data.json session-store shape the Obsidian plugin
// itself writes (via session-store.ts / source-identity.ts, compiled through
// scripts/lib/session-artifact.mjs, never reimplemented). Afterwards, open
// Obsidian (or reload the plugin) and browse results in the Review Panel.
//
// HARD CONSTRAINT: Obsidian must be closed while this runs. data.json is
// Obsidian's own in-memory-then-saveData() store; if Obsidian is open, its
// next save can clobber whatever this script just wrote. See
// BATCH-VAULT-RUNNER-PLAN.md's "安全前提" section.
//
// Usage:
//   node scripts/dev/run-batch-vault.mjs \
//     --vault-root "$HOME/Obsidian Notes" \
//     --plugin-id aha-memory-surface-dev \
//     --folder "个人复盘" \
//     --limit 20 \
//     --dry-run

import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import { createQmdCliRunner } from "../lib/core-node-deps.mjs";
import { runFullPipeline } from "../lib/core-artifact.mjs";
import { expandHome } from "../lib/vault-paths.mjs";
import {
  buildPluginPipelineTrace,
  writePluginPipelineTrace,
  normalizeSessionStore,
  recordFailedSessionRound,
  recordSuccessfulSessionRound,
  sourceIdentityForFile,
} from "../lib/session-artifact.mjs";

const DEFAULTS = {
  vaultRoot: path.join(homedir(), "Obsidian Notes"),
  pluginId: "aha-memory-surface-dev",
  folder: "",
  notesFile: "",
  limit: 0,
  dryRun: false,
};

function usage() {
  return [
    "Usage:",
    "  node scripts/dev/run-batch-vault.mjs [options]",
    "",
    "Options:",
    "  --vault-root <path>      Default: ~/Obsidian Notes",
    "  --plugin-id <id>         Default: aha-memory-surface-dev (pass aha-memory-surface for production)",
    "  --folder <vault-rel>     Recursively run every .md note under this vault-relative folder",
    "  --notes-file <path>      A file listing vault-relative note paths, one per line (# comments allowed)",
    "  --limit <n>              Only run the first n notes",
    "  --dry-run                Print which notes would run; no LLM/QMD calls, no file writes",
    "",
    "Exactly one of --folder or --notes-file is required.",
  ].join("\n");
}

export function parseArgs(argv) {
  const options = { ...DEFAULTS };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for ${arg}`);
    }
    index += 1;
    switch (arg) {
      case "--vault-root":
        options.vaultRoot = value;
        break;
      case "--plugin-id":
        options.pluginId = value;
        break;
      case "--folder":
        options.folder = value;
        break;
      case "--notes-file":
        options.notesFile = value;
        break;
      case "--limit": {
        const limit = Number(value);
        if (!Number.isFinite(limit) || limit < 1) {
          throw new Error("--limit must be a positive number.");
        }
        options.limit = limit;
        break;
      }
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (Boolean(options.folder) === Boolean(options.notesFile)) {
    throw new Error("Pass exactly one of --folder or --notes-file.");
  }

  options.vaultRoot = path.resolve(expandHome(options.vaultRoot));
  return options;
}

export async function collectNotesUnderFolder(vaultRoot, folder) {
  const root = path.join(vaultRoot, folder);
  const results = [];

  async function walk(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
        continue;
      }
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".md")) continue;
      results.push(path.relative(vaultRoot, fullPath).split(path.sep).join("/"));
    }
  }

  await walk(root);
  return results;
}

export async function collectNotesFromFile(notesFilePath) {
  const raw = await readFile(notesFilePath, "utf-8");
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
}

export function dataJsonPathFor(vaultRoot, pluginId) {
  return path.join(vaultRoot, ".obsidian", "plugins", pluginId, "data.json");
}

export async function loadPipelineConfig(dataJsonPath) {
  const raw = await readFile(dataJsonPath, "utf-8");
  const data = JSON.parse(raw);
  const settings = data.settings ?? {};

  const provider = settings.llmProvider || "deepseek";
  const isDeepSeek = provider === "deepseek";
  const apiKey = isDeepSeek
    ? (settings.deepseekApiKey || process.env[settings.deepseekApiKeyEnv] || "")
    : (settings.llmApiKey || process.env[settings.llmApiKeyEnv] || "");
  const baseUrl = isDeepSeek ? settings.deepseekBaseUrl : settings.llmBaseUrl;
  const model = isDeepSeek ? settings.deepseekModel : settings.llmModel;
  const protocol = isDeepSeek ? "chat-completions" : "responses";

  const excludedFolders = (settings.excludedFolders || "templates")
    .split(/[,\n]/).map((s) => s.trim()).filter(Boolean);

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
    thinking: isDeepSeek ? "disabled" : undefined,
    timeoutMs: 120_000,
  };

  return {
    data,
    settings,
    excludedFolders,
    qmdDeps,
    llmConfig,
    targetCandidates: settings.targetCandidates || 20,
    relationJudgeBudget: settings.relationJudgeBudget || 40,
    runPipeline: runFullPipeline,
  };
}

export async function backupDataJson(dataJsonPath) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = `${dataJsonPath}.bak-${timestamp}`;
  await writeFile(backupPath, await readFile(dataJsonPath, "utf-8"));
  return backupPath;
}

export async function readMergeWrite(dataJsonPath, mutate) {
  const raw = await readFile(dataJsonPath, "utf-8");
  const data = JSON.parse(raw);
  const store = normalizeSessionStore(data.sessionStore);
  mutate(store);
  data.sessionStore = store;
  if (typeof data.schemaVersion !== "number") data.schemaVersion = 1;
  await writeFile(dataJsonPath, `${JSON.stringify(data, null, 2)}\n`);
}

export async function sourceInputFor(vaultRoot, notePath) {
  const absolutePath = path.join(vaultRoot, notePath);
  const metadata = await stat(absolutePath);
  const fakeFile = { stat: { ctime: metadata.birthtimeMs } };
  const id = await sourceIdentityForFile(fakeFile, absolutePath);
  return {
    absolutePath,
    source: {
      id,
      path: notePath,
      title: path.basename(notePath, ".md"),
      ctime: metadata.birthtimeMs,
      mtime: metadata.mtimeMs,
      size: metadata.size,
    },
  };
}

export async function runOneNote(options, config, notePath) {
  const { absolutePath, source } = await sourceInputFor(options.vaultRoot, notePath);
  const sourceText = await readFile(absolutePath, "utf-8");

  const args = {
    sourcePath: notePath,
    sourceText,
    sourceAbsolutePath: absolutePath,
    vaultRoot: options.vaultRoot,
    obsidianCommand: config.settings?.obsidianCommand?.trim() || "obsidian",
    reviewPath: "Aha/Reviews/placeholder.md",
    id: notePath,
    displayName: "Aha",
    _resolved_insight_input: sourceText,
    targetCandidates: config.targetCandidates,
    relationJudgeBudget: config.relationJudgeBudget,
    excludedFolders: config.excludedFolders,
  };

  const runPipeline = config.runPipeline ?? runFullPipeline;
  const result = await runPipeline(args, config.llmConfig, config.qmdDeps);

  const traceDirectory = config.settings?.traceDirectory?.trim();
  if (traceDirectory) {
    try {
      const trace = buildPluginPipelineTrace({
        origin: "batch", sourcePath: notePath, sourceTitle: source.title, sourceText,
        tier: "full", result,
        queryPlan: result.queryPlanPromptVersion ? {
          generatedBy: result.queryPlanGeneratedBy,
          fallback: result.queryPlanFallback,
          error: null,
          promptVersion: result.queryPlanPromptVersion,
          queries: result.queryPlanQueries,
        } : undefined,
        qmdQueryResults: result.qmdQueryResults,
        pooledCandidates: result.pooledCandidates,
        relationJudgeTrace: result.relationJudgeTrace,
      });
      const tracePath = writePluginPipelineTrace(trace, traceDirectory);
      result.trace = { path: tracePath, origin: "batch" };
      (result.warnings ??= []).push(`Pipeline trace saved: ${tracePath}`);
    } catch (error) {
      const warning = `Pipeline trace write failed: ${error.code || "unknown error"}; directory: ${traceDirectory}`;
      (result.warnings ??= []).push(warning);
      console.warn(warning);
    }
  }

  const dataJsonPath = dataJsonPathFor(options.vaultRoot, options.pluginId);
  if (result.ok) {
    await readMergeWrite(dataJsonPath, (store) => {
      recordSuccessfulSessionRound(store, { generatedAt: new Date(), result, source });
    });
    return { ok: true, candidateCount: result.candidates?.length ?? 0 };
  }

  await readMergeWrite(dataJsonPath, (store) => {
    recordFailedSessionRound(store, {
      generatedAt: new Date(),
      source,
      failure: result.error ?? { message: "Aha pipeline failed with no structured error.", tool: "pipeline" },
      trace: result.trace,
      warnings: result.warnings,
    });
  });
  return { ok: false, message: result.error?.message ?? "Aha pipeline failed." };
}

// The serial per-note loop, factored out of main() so integration tests can
// drive it directly against a hand-built config (with a fake config.runPipeline)
// and fixture notes, without going through CLI arg parsing or real settings
// I/O. Strictly serial across notes on purpose: QMD sits behind a local
// index/CLI process with no evidence it can safely take concurrent calls
// (see BATCH-VAULT-RUNNER-PLAN.md's "执行模型" section), so this never
// Promise.all's across notePath entries.
export async function runBatch(options, config, selected) {
  const dataJsonPath = dataJsonPathFor(options.vaultRoot, options.pluginId);
  const succeeded = [];
  const failed = [];

  for (const [index, notePath] of selected.entries()) {
    const startedAt = Date.now();
    process.stdout.write(`[${index + 1}/${selected.length}] ${notePath} ... `);
    try {
      const outcome = await runOneNote(options, config, notePath);
      const elapsedS = ((Date.now() - startedAt) / 1000).toFixed(1);
      if (outcome.ok) {
        console.log(`ok (${outcome.candidateCount} candidates, ${elapsedS}s)`);
        succeeded.push(notePath);
      } else {
        console.log(`failed: ${outcome.message} (${elapsedS}s)`);
        failed.push({ notePath, message: outcome.message });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const elapsedS = ((Date.now() - startedAt) / 1000).toFixed(1);
      console.log(`failed: ${message} (${elapsedS}s)`);
      try {
        const { source } = await sourceInputFor(options.vaultRoot, notePath);
        await readMergeWrite(dataJsonPath, (store) => {
          recordFailedSessionRound(store, {
            generatedAt: new Date(),
            source,
            failure: { message, tool: "batch-runner", details: error instanceof Error ? error.stack : undefined },
          });
        });
      } catch {
        // Best-effort: if we can't even record the failure (e.g. the note
        // itself vanished), the summary below still reports it as failed.
      }
      failed.push({ notePath, message });
    }
  }

  console.log(`\nDone: ${succeeded.length} succeeded, ${failed.length} failed.`);
  if (failed.length > 0) {
    console.log("Failed notes:");
    for (const item of failed) console.log(`  - ${item.notePath}: ${item.message}`);
  }
  return { succeeded, failed };
}

export async function main() {
  const options = parseArgs(process.argv.slice(2));

  const notes = options.folder
    ? await collectNotesUnderFolder(options.vaultRoot, options.folder)
    : await collectNotesFromFile(path.resolve(options.notesFile));
  const selected = options.limit ? notes.slice(0, options.limit) : notes;

  console.log(`Vault root: ${options.vaultRoot}`);
  console.log(`Plugin id: ${options.pluginId}`);
  console.log(`Notes selected: ${selected.length}${options.limit ? ` (limit ${options.limit}, ${notes.length} found)` : ` (${notes.length} found)`}`);
  for (const notePath of selected) console.log(`  - ${notePath}`);

  if (options.dryRun) {
    console.log("\n--dry-run: no LLM/QMD calls, no file writes.");
    return;
  }
  if (selected.length === 0) {
    console.log("\nNothing to run.");
    return;
  }

  console.log(
    "\nWARNING: Disable the target Aha plugin during this run so it cannot overwrite data.json.",
    "Keep Obsidian open for link/backlink queries; re-enable Aha after the batch finishes.\n",
  );

  const dataJsonPath = dataJsonPathFor(options.vaultRoot, options.pluginId);
  const backupPath = await backupDataJson(dataJsonPath);
  console.log(`Backed up data.json to ${backupPath}\n`);

  const config = await loadPipelineConfig(dataJsonPath);
  if (!config.llmConfig.apiKey) {
    throw new Error("No LLM API key found in settings (or its configured env var). Aborting before running any notes.");
  }

  await runBatch(options, config, selected);
}

const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(`\n${usage()}`);
    process.exit(1);
  }
}
