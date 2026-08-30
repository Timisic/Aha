#!/usr/bin/env node
import { access, readFile, realpath, stat } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { validateAhaResult } from "./lib/result-validator.mjs";
import { notePathForObsidian } from "./lib/note-identity.mjs";
import {
  fallbackQmdObject as sharedFallbackQmdObject,
  qmdQueryFromObject as sharedQmdQueryFromObject,
  unique,
} from "./query-plan.mjs";
import { normalizeStructuredResult } from "./relation-judge.mjs";
import { runOpenAiJsonAsync } from "../lib/openai-json-agent.mjs";

const JSON_BEGIN = "AHA_RESULT_JSON_BEGIN";
const JSON_END = "AHA_RESULT_JSON_END";
const MIN_TARGET_CANDIDATES = 15;
const MAX_TARGET_CANDIDATES = 20;
const DEFAULT_MAX_OUTPUT_BYTES = 5 * 1024 * 1024;
const DEFAULT_QMD_QUERY_TIMEOUT_MS = 30_000;
const DEFAULT_QMD_CANDIDATE_LIMIT = 20;
const DEFAULT_LLM_PROVIDER = "deepseek";
const DEFAULT_LLM_BASE_URL = "https://api.deepseek.com";
const DEFAULT_LLM_MODEL = "deepseek-v4-pro";
const DEFAULT_LLM_API_KEY_ENV = "DEEPSEEK_API_KEY";
const DEFAULT_QMD_RUNNER = "sdk";
const DEFAULT_QMD_INDEX = "obsidian";
const VALID_LLM_PROVIDERS = new Set(["deepseek"]);
const VALID_QMD_RUNNERS = new Set(["cli", "sdk"]);
const COMMON_COMMAND_DIRS = [
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/usr/bin",
  "/bin",
  "/usr/sbin",
  "/sbin",
  path.join(homedir(), ".local/bin"),
  path.join(homedir(), ".npm-global/bin"),
  path.join(homedir(), ".bun/bin"),
];

main().catch((error) => {
  emitJson(failedAhaResult({
    sourcePath: null,
    summary: "Aha wrapper failed before completing the search round.",
    message: "Aha wrapper failed.",
    tool: "wrapper",
    details: error instanceof Error ? error.message : String(error),
  }), 1);
});

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.checkLlmConnection) {
    const result = await checkLlmConnection(args);
    emitJson(result, result.ok ? 0 : 2);
    return;
  }

  if (args.checkReadiness) {
    const result = await readiness(args);
    emitJson(result, result.ok ? 0 : 2);
    return;
  }

  if (args.fixture) {
    const fixture = JSON.parse(await readFile(args.fixture, "utf8"));
    const validation = validateAhaResult(fixture);
    if (!validation.ok) {
      emitJson(failedAhaResult({
        sourcePath: args.sourcePath,
        summary: "Fixture result failed schema validation.",
        message: "Fixture result is malformed.",
        tool: "wrapper",
        details: validation.errors.join("; "),
      }), 3);
      return;
    }
    emitJson({
      ...fixture,
      generatedAt: fixture.generatedAt ?? new Date().toISOString(),
      sourcePath: fixture.sourcePath ?? args.sourcePath,
    });
    return;
  }

  const prerequisites = await readiness(args);
  if (!prerequisites.ok) {
    emitJson(failedAhaResult({
      sourcePath: args.sourcePath,
      summary: "Aha prerequisites are not ready.",
      message: "Aha prerequisites are not ready.",
      tool: "wrapper",
      details: prerequisites.checks.filter((check) => !check.ok).map((check) => `${check.name}: ${check.message}`).join("; "),
    }), 4);
    return;
  }

  const sourceFilePath = await resolveSourceFilePath(args);
  if (!sourceFilePath) {
    emitJson(failedAhaResult({
      sourcePath: args.sourcePath,
      summary: "Aha source note failed the vault boundary check.",
      message: "Aha source note is outside the configured vault.",
      tool: "wrapper",
      details: "The source note path did not resolve inside vaultRoot after realpath symlink resolution.",
    }), 4);
    return;
  }

  const sourceText = await readFile(sourceFilePath, "utf8");

  if (args.strategy === "pipeline") {
    // Delegates to core's runFullPipeline (ADR 0005) instead of this file's
    // own query-plan/retrieval/relation-judge implementation, so a core fix
    // or prompt change no longer needs a second, easy-to-forget edit here --
    // this is also the only combination process.ts's #58 legacy-wrapper
    // rollback path actually invokes in production.
    const result = await pipelineRecallViaCore(args, sourceText);
    emitJson(result, result.ok ? 0 : 2);
    return;
  }

  if (args.strategy === "qmd-only") {
    const recall = await qmdRecall(args, sourceText);
    emitJson(weakFallbackFromRows(args, recall.rows, "Relation judging skipped by qmd-only strategy."));
    return;
  }

  const recall = await qmdRecall(args, sourceText);
  const prompt = await buildRelationJudgePrompt(args, sourceText, recall.rows);
  let llmOutput;
  try {
    llmOutput = await runLlm(args, prompt);
  } catch (error) {
    emitJson(relationJudgeFailureFromRows(args, recall.rows, `${llmDisplayName(args)} relation judging failed: ${error.message}`, llmToolName(args)), 2);
    return;
  }
  if (llmOutput.code !== 0) {
    emitJson(relationJudgeFailureFromRows(
      args,
      recall.rows,
      `${llmDisplayName(args)} relation judging exited ${llmOutput.code}: ${firstLine(llmOutput.stderr || llmOutput.stdout) || "no diagnostic"}`,
      llmToolName(args),
    ), 2);
    return;
  }
  let parsed;
  try {
    parsed = normalizeStructuredResult(extractStructuredJson(llmOutput.stdout));
  } catch (error) {
    emitJson(relationJudgeFailureFromRows(args, recall.rows, `${llmDisplayName(args)} relation judging returned non-JSON output: ${error.message}`, llmToolName(args)), 2);
    return;
  }
  const validation = validateAhaResult(parsed);
  if (!validation.ok) {
    emitJson(relationJudgeFailureFromRows(args, recall.rows, `${llmDisplayName(args)} relation judging returned malformed output: ${validation.errors.join("; ")}`, llmToolName(args)), 2);
    return;
  }
  emitJson({
    ...parsed,
    generatedAt: parsed.generatedAt ?? new Date().toISOString(),
    sourcePath: parsed.sourcePath ?? args.sourcePath,
    warnings: [
      ...(parsed.warnings ?? []),
      `Retrieval used bounded wrapper-side QMD recall; ${llmDisplayName(args)} judged the returned candidate excerpts.`,
    ],
  });
}

async function readiness(args) {
  const checks = [];
  checks.push(await checkWorkspace(args.workspace));
  checks.push(await checkReadableSourceNote(args));
  checks.push(checkLlmApiKey(args));
  if (args.qmdRunner === "sdk") {
    checks.push(await checkQmdSdk(args));
  } else {
    checks.push(await checkCommand("QMD CLI", args.qmdCommand, ["--version"], args.llmApiKeyEnv));
  }
  checks.push(await checkCommand("Obsidian CLI", args.obsidianCommand, ["files", "total"], args.llmApiKeyEnv));
  return {
    ok: checks.every((check) => check.ok),
    checks,
  };
}

async function checkWorkspace(workspace) {
  if (!workspace) return { name: "Aha workspace", ok: false, message: "Not configured." };
  try {
    const info = await stat(workspace);
    return info.isDirectory()
      ? { name: "Aha workspace", ok: true, message: workspace }
      : { name: "Aha workspace", ok: false, message: "Path is not a directory." };
  } catch (error) {
    return { name: "Aha workspace", ok: false, message: error.message };
  }
}

async function checkReadableSourceNote(args) {
  if (!args.sourceAbsolutePath) return { name: "Wrapper source note", ok: true, message: "Skipped." };
  try {
    const sourceFilePath = await resolveSourceFilePath(args);
    if (!sourceFilePath) {
      return { name: "Wrapper source note", ok: false, message: "Source note must resolve inside vaultRoot." };
    }
    await access(sourceFilePath, fsConstants.R_OK);
    return { name: "Wrapper source note", ok: true, message: sourceFilePath };
  } catch (error) {
    return { name: "Wrapper source note", ok: false, message: error.message };
  }
}

async function checkCommand(name, command, args, sensitiveEnvName = "") {
  if (!command) return { name, ok: false, message: "Not configured." };
  try {
    const result = await runCommand(command, args, { timeoutMs: 15_000, sensitiveEnvName });
    return result.code === 0
      ? { name, ok: true, message: firstLine(result.stdout || result.stderr) || "OK" }
      : { name, ok: false, message: firstLine(result.stderr || result.stdout) || `Exited ${result.code}` };
  } catch (error) {
    return { name, ok: false, message: error.message };
  }
}

function checkLlmApiKey(args) {
  const envName = String(args.llmApiKeyEnv || "").trim();
  const name = `${llmDisplayName(args)} API key`;
  if (!envName) return { name, ok: false, message: "API key environment variable is not configured." };
  return process.env[envName]
    ? { name, ok: true, message: `${envName} is set.` }
    : { name, ok: false, message: `${envName} is not set.` };
}

async function checkLlmConnection(args) {
  const keyCheck = checkLlmApiKey(args);
  if (!keyCheck.ok) {
    return { ok: false, provider: args.llmProvider, model: args.llmModel, message: keyCheck.message };
  }
  try {
    const result = await runLlm(args, "Aha connection check. Return only this JSON object: {\"ok\":true}", {
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["ok"],
        properties: { ok: { type: "boolean", enum: [true] } },
      },
      schemaName: "aha_connection_check",
      timeoutMs: 60_000,
    });
    const parsed = extractStructuredJson(result.stdout);
    if (parsed?.ok !== true) throw new Error("Provider returned an unexpected connection-check payload.");
    return {
      ok: true,
      provider: args.llmProvider,
      model: args.llmModel,
      message: `${llmDisplayName(args)} model ${args.llmModel} is reachable and generated valid JSON.`,
    };
  } catch (error) {
    return {
      ok: false,
      provider: args.llmProvider,
      model: args.llmModel,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

async function checkQmdSdk(args) {
  try {
    const sdk = await loadQmdSdk(args);
    return typeof sdk.module?.createStore === "function"
      ? { name: "QMD SDK", ok: true, message: sdk.source }
      : { name: "QMD SDK", ok: false, message: `${sdk.source} does not export createStore.` };
  } catch (error) {
    return { name: "QMD SDK", ok: false, message: error.message };
  }
}

async function runLlm(args, prompt, options = {}) {
  return runDeepSeek(args, prompt, options);
}

async function runDeepSeek(args, prompt, options = {}) {
  const schemaPath = options.schemaPath ?? path.join(args.workspace, "scripts/aha/aha-result.schema.json");
  const schema = options.schema ?? await readJsonIfExists(schemaPath);
  const stdout = await runOpenAiJsonAsync({
    apiKeyEnv: args.llmApiKeyEnv,
    baseUrl: args.llmBaseUrl,
    model: args.llmModel,
    prompt,
    protocol: "chat-completions",
    providerName: llmDisplayName(args),
    thinking: "disabled",
    schema,
    schemaName: options.schemaName ?? schemaNameForPath(schemaPath),
    timeoutMs: Number(options.timeoutMs ?? args.timeoutMs),
    onResponse: (payload) => {
      if (process.env.AHA_LOG_USAGE === "1" && payload?.usage) {
        process.stderr.write(`AHA_USAGE ${JSON.stringify({ model: payload.model, usage: payload.usage })}\n`);
      }
    },
  });
  return {
    code: 0,
    stdout,
    stderr: "",
  };
}

function schemaNameForPath(schemaPath) {
  return path.basename(schemaPath, path.extname(schemaPath)).replace(/[^a-zA-Z0-9_-]+/g, "_").slice(0, 64) || "aha_schema";
}

async function readJsonIfExists(filePath) {
  if (!(await exists(filePath))) return null;
  return JSON.parse(await readFile(filePath, "utf8"));
}

function llmDisplayName() {
  return "DeepSeek";
}

function llmToolName() {
  return "deepseek";
}

async function qmdRecall(args, sourceText) {
  const qmd = sharedFallbackQmdObject(args, sourceText);
  const query = sharedQmdQueryFromObject(qmd);
  const result = await runQmdPlanQuery(args, {
    kind: "fallback",
    command: "qmd query",
    text: query,
    query,
    qmd,
  });
  return { query, rows: result.rows };
}

// Delegates to core-artifact.mjs's runFullPipeline (ADR 0005), which
// rebuilds and imports the shared TypeScript core -- the same code
// tier-pipeline.ts calls for the live plugin's Full Tier. A dynamic import
// keeps the esbuild core rebuild off every other strategy this file
// supports (qmd-only, hybrid, readiness checks, ...).
async function pipelineRecallViaCore(args, sourceText) {
  const { runFullPipeline } = await import("../lib/core-artifact.mjs");
  const llm = {
    baseUrl: args.llmBaseUrl,
    apiKey: process.env[args.llmApiKeyEnv] || "",
    model: args.llmModel,
    protocol: "chat-completions",
    timeoutMs: args.timeoutMs,
    thinking: "disabled",
  };
  const coreArgs = {
    ...args,
    sourceText,
    id: args.sourcePath,
    displayName: "Aha",
    _resolved_insight_input: sourceText,
  };
  const result = await runFullPipeline(coreArgs, llm, {});
  return shapeCoreFullResult(result);
}

// Strips core's diagnostic-only fields (queryPlanGeneratedBy, qmdQueryResults,
// pooledCandidates, etc. -- added for the plugin's Pipeline Trace, issue #59)
// down to exactly this wrapper's existing AhaResult JSON shape, matching
// failedAhaResult's own return shape byte-for-byte.
function shapeCoreFullResult(result) {
  if (result.ok) {
    return {
      ok: true,
      sourcePath: result.sourcePath,
      generatedAt: result.generatedAt,
      summary: result.summary,
      warnings: result.warnings,
      candidates: result.candidates,
    };
  }
  return {
    ok: false,
    sourcePath: result.sourcePath,
    generatedAt: result.generatedAt,
    summary: result.summary,
    warnings: result.warnings,
    error: result.error,
    candidates: result.candidates,
  };
}

async function runQmdPlanQuery(args, query) {
  const timeoutMs = qmdQueryTimeoutMs(args);
  if (args.qmdRunner === "sdk") {
    return withTimeout(runQmdPlanQuerySdk(args, query), timeoutMs, `QMD SDK timed out after ${timeoutMs}ms.`);
  }
  try {
    return await runQmdPlanQueryCommand(args, query, { timeoutMs });
  } catch (error) {
    if (!isQmdRetryableTimeout(error, query)) throw error;
    try {
      const result = await runQmdPlanQueryCommand(args, query, { timeoutMs });
      return {
        ...result,
        warning: `${query.kind}/${query.command} timed out once (${error.message}); retry succeeded with qmd query.`,
      };
    } catch (retryError) {
      throw new Error(`${error.message}; retry failed: ${retryError.message}`);
    }
  }
}

async function runQmdPlanQueryCommand(args, query, options) {
  const command = String(query.command || "qmd query");
  const subcommand = command.startsWith("qmd search")
    ? "search"
    : "query";
  const text = query.query || query.text;
  const commandArgs = [
    "--index",
    args.qmdIndex,
    subcommand,
    text,
    "-c",
    args.qmdIndex,
    "-n",
    String(Math.max(Number(args.targetCandidates || 20), 15)),
    "-C",
    String(qmdCandidateLimit(args)),
    "--full-path",
    "--line-numbers",
    "--format",
    "json",
  ];
  if (subcommand === "query" && !args.qmdRerank) {
    commandArgs.push("--no-rerank");
  }

  const result = await runCommand(args.qmdCommand, commandArgs, {
    cwd: args.workspace,
    sensitiveEnvName: args.llmApiKeyEnv,
    timeoutMs: options.timeoutMs,
  });

  if (result.code !== 0) {
    throw new Error(firstLine(result.stderr || result.stdout) || `QMD exited ${result.code}`);
  }

  return {
    query,
    rows: extractJsonArray(result.stdout),
  };
}

async function runQmdPlanQuerySdk(args, query) {
  const sdk = await loadQmdSdk(args);
  const store = await sdk.module.createStore({ dbPath: qmdDbPath(args) });
  try {
    const command = String(query.command || "qmd query");
    const limit = Math.max(Number(args.targetCandidates || 20), 15);
    const rows = command.startsWith("qmd search")
      ? await store.searchLex(String(query.query || query.text || ""), { collection: args.qmdIndex, limit })
      : await store.search(qmdSdkSearchOptions(args, query, limit));
    return {
      query,
      rows: normalizeQmdSdkRows(args, rows),
    };
  } finally {
    if (typeof store?.close === "function") {
      await store.close();
    }
  }
}

function qmdSdkSearchOptions(args, query, limit) {
  const expanded = qmdSdkExpandedQueries(query);
  const base = {
    collections: [args.qmdIndex],
    limit,
    candidateLimit: qmdCandidateLimit(args),
    rerank: Boolean(args.qmdRerank),
    explain: false,
  };
  if (query?.qmd?.intent) base.intent = query.qmd.intent;
  if (expanded.length > 0) {
    return {
      ...base,
      queries: expanded,
    };
  }
  return {
    ...base,
    query: String(query.query || query.text || ""),
  };
}

function qmdSdkExpandedQueries(query) {
  const qmd = query?.qmd;
  if (!qmd || typeof qmd !== "object") return [];
  return [
    ...(Array.isArray(qmd.lex) ? qmd.lex.map((item) => ({ type: "lex", query: item })) : []),
    qmd.vec ? { type: "vec", query: qmd.vec } : null,
    qmd.hyde ? { type: "hyde", query: qmd.hyde } : null,
  ].filter((item) => item?.query);
}

function normalizeQmdSdkRows(args, rows) {
  if (!Array.isArray(rows)) return [];
  return rows.map((row) => normalizeQmdSdkRow(args, row)).filter(Boolean);
}

function normalizeQmdSdkRow(args, row) {
  if (!row || typeof row !== "object") return null;
  const rawFile = row.file ?? row.uri ?? row.path ?? row.filepath ?? row.displayPath;
  const snippet = firstString(row.snippet, row.bestChunk, row.body, row.context, row.title);
  return {
    ...row,
    file: normalizeQmdSdkFile(args, rawFile, row),
    title: firstString(row.title, path.basename(String(rawFile || "unknown.md"), ".md")),
    snippet,
    score: Number.isFinite(Number(row.score)) ? Number(row.score) : 0,
  };
}

function normalizeQmdSdkFile(args, rawFile, row) {
  const value = String(rawFile ?? "").trim();
  if (!value) return `${row.title || "unknown"}.md`;
  if (/^qmd:\/\//i.test(value) || path.isAbsolute(value)) return value;
  const normalized = value.replace(/^\/+/, "");
  const collectionPrefix = `${args.qmdIndex}/`;
  return normalized.startsWith(collectionPrefix)
    ? normalized.slice(collectionPrefix.length)
    : normalized;
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

async function loadQmdSdk(args) {
  const candidates = await qmdSdkCandidates(args);
  const errors = [];
  for (const candidate of candidates) {
    try {
      const module = await importModuleSpecifier(candidate.specifier);
      return { module, source: candidate.label };
    } catch (error) {
      errors.push(`${candidate.label}: ${error.message}`);
    }
  }
  throw new Error(errors.length > 0 ? errors.join("; ") : "No QMD SDK module candidate could be resolved.");
}

async function qmdSdkCandidates(args) {
  const candidates = [];
  if (args.qmdSdkModule) {
    candidates.push({ label: args.qmdSdkModule, specifier: args.qmdSdkModule });
  }
  candidates.push({ label: "@tobilu/qmd", specifier: "@tobilu/qmd" });
  const inferred = await inferQmdSdkModuleFromCommand(args.qmdCommand);
  if (inferred) {
    candidates.push({ label: inferred, specifier: inferred });
  }
  return uniqueBy(candidates, (candidate) => candidate.specifier);
}

async function inferQmdSdkModuleFromCommand(command) {
  const commandPath = await resolveCommandPath(command);
  if (!commandPath) return "";
  const packageRoot = path.resolve(path.dirname(commandPath), "..");
  const sdkModule = path.join(packageRoot, "dist", "index.js");
  return await exists(sdkModule) ? sdkModule : "";
}

async function resolveCommandPath(command) {
  const raw = String(command || "").trim();
  if (!raw) return "";
  const candidates = raw.includes("/") || path.isAbsolute(raw)
    ? [raw]
    : unique([...(process.env.PATH || "").split(path.delimiter), ...COMMON_COMMAND_DIRS]).map((dir) => path.join(dir, raw));
  for (const candidate of candidates) {
    try {
      return await realpath(candidate);
    } catch {
      // Try the next PATH entry.
    }
  }
  return "";
}

async function importModuleSpecifier(specifier) {
  if (/^file:\/\//i.test(specifier) || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(specifier)) {
    return import(specifier);
  }
  if (path.isAbsolute(specifier) || specifier.startsWith(".")) {
    return import(pathToFileURL(path.resolve(specifier)).href);
  }
  return import(specifier);
}

function qmdDbPath(args) {
  return expandHome(args.qmdDbPath || path.join(process.env.XDG_CACHE_HOME || path.join(homedir(), ".cache"), "qmd", `${args.qmdIndex}.sqlite`));
}

function expandHome(value) {
  const raw = String(value || "");
  return raw === "~" || raw.startsWith("~/")
    ? path.join(homedir(), raw.slice(2))
    : raw;
}

function uniqueBy(values, keyFn) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const key = keyFn(value);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

function qmdQueryTimeoutMs(args) {
  return Math.min(Number(args.timeoutMs || 300_000), Number(args.qmdQueryTimeoutMs || DEFAULT_QMD_QUERY_TIMEOUT_MS));
}

function qmdCandidateLimit(args) {
  return Math.max(Number(args.targetCandidates || DEFAULT_QMD_CANDIDATE_LIMIT), DEFAULT_QMD_CANDIDATE_LIMIT);
}

function isQmdRetryableTimeout(error, query) {
  const command = String(query.command || "qmd query");
  return command === "qmd query" && String(error?.message ?? error).includes("timed out after");
}

async function buildRelationJudgePrompt(args, sourceText, rows) {
  const candidates = [];
  for (const row of rows.slice(0, Number(args.targetCandidates || 20))) {
    candidates.push({
      notePath: notePathForObsidian(args, row),
      noteTitle: typeof row.title === "string" ? row.title : undefined,
      snippet: typeof row.snippet === "string" ? row.snippet.slice(0, 1600) : "",
      excerpt: await readCandidateExcerpt(args, row),
    });
  }

  return [
    "You are the Aha Relation Judge for an Obsidian plugin MVP.",
    "Do not run shell commands. Judge only from the source note and candidate excerpts below.",
    "Return JSON only. Use supports, challenges, resembles, bounds, or weak.",
    "Use supports/challenges/resembles/bounds only when the candidate excerpt contains quote evidence. Otherwise use weak.",
    "The hit field must be a short quote or concrete snippet from the candidate excerpt.",
    "The why field should explain why this old note is worth reading for the current insight.",
    "Use Chinese for summary and why when the source or candidate excerpt is Chinese. Keep JSON keys and relation labels in English.",
    "Write why as a compact, note-like bridge: lead with the concrete idea or tension, not with a generic phrase about the candidate.",
    "Avoid formulaic openings such as “这条旧笔记…”, “这条笔记…”, “这条候选…”, or “直接支撑当前 source…”. Do not reuse the same sentence frame across candidates.",
    "",
    `Source path: ${args.sourcePath}`,
    "Source excerpt:",
    "```markdown",
    sourceText.slice(0, 8000),
    "```",
    "",
    "Candidates:",
    JSON.stringify(candidates, null, 2),
    "",
    "Required JSON shape:",
    JSON.stringify({
      ok: true,
      sourcePath: args.sourcePath,
      summary: "一句话概括这轮候选关系判断",
      warnings: [],
      error: null,
      candidates: [
        {
          notePath: "candidate path",
          noteTitle: "candidate title",
          relation: "weak",
          hit: "short quote/snippet",
          why: "用自然中文说明具体相关性，避免模板句",
          quotes: ["optional quote"],
          selected: true,
        },
      ],
    }, null, 2),
  ].join("\n");
}

async function readCandidateExcerpt(args, row) {
  const notePath = String(row.file ?? row.path ?? row.uri ?? "");
  if (!notePath) return "";
  try {
    if (isObsidianQmdUri(notePath)) {
      const filePath = await qmdUriVaultPath(args, notePath);
      if (filePath) return (await readFile(filePath, "utf8")).slice(0, 1200);
    }
    const filePath = await resolveVaultContainedPath(args, notePath);
    if (filePath) {
      return (await readFile(filePath, "utf8")).slice(0, 1200);
    }
  } catch {
    return "";
  }
  return "";
}

async function resolveVaultContainedPath(args, location) {
  if (!args.vaultRoot || !location || /^qmd:\/\//i.test(String(location))) return "";
  if (!path.isAbsolute(location) && !isSafeVaultRelativePath(location)) return "";
  const candidatePath = path.isAbsolute(location)
    ? location
    : path.resolve(args.vaultRoot, location);
  const [vaultRealPath, candidateRealPath] = await Promise.all([
    realpath(args.vaultRoot),
    realpath(candidatePath),
  ]);
  return pathIsInside(vaultRealPath, candidateRealPath) ? candidateRealPath : "";
}

async function resolveSourceFilePath(args) {
  return resolveVaultContainedPath(args, args.sourceAbsolutePath || args.sourcePath);
}

function isObsidianQmdUri(value) {
  return /^qmd:\/\/obsidian\//i.test(String(value ?? ""));
}

async function qmdUriVaultPath(args, value) {
  const notePath = notePathForObsidian(args, { file: value });
  return resolveVaultContainedPath(args, notePath);
}

function isSafeVaultRelativePath(value) {
  const raw = String(value ?? "").replace(/\\/g, "/").trim();
  if (!raw || path.isAbsolute(raw)) return false;
  const normalized = path.posix.normalize(raw);
  return normalized !== "." && normalized !== ".." && !normalized.startsWith("../");
}

function pathIsInside(basePath, candidatePath) {
  const relative = path.relative(path.resolve(basePath), path.resolve(candidatePath));
  return relative === "" || (relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function weakFallbackFromRows(args, rows, reason) {
  const candidates = rows.slice(0, Number(args.targetCandidates || 20)).map((row) => fallbackCandidate(args, row));
  return {
    ok: true,
    sourcePath: args.sourcePath,
    generatedAt: new Date().toISOString(),
    summary: `Returned ${candidates.length} direct QMD recall candidates.`,
    warnings: [
      reason,
      "Fallback candidates are direct QMD recall results. Relation labels are weak unless later judged by Relation Judge.",
    ],
    candidates,
  };
}

function relationJudgeFailureFromRows(args, rows, reason, tool = "deepseek") {
  const fallback = weakFallbackFromRows(args, rows, reason);
  return {
    ...fallback,
    ok: false,
    summary: "Aha retrieved QMD candidates, but Relation Judge failed before it could assign reliable relations.",
    warnings: [
      reason,
      "Weak QMD candidates are included only as diagnostics; this search round must be treated as failed.",
    ],
    error: {
      message: "Aha Relation Judge failed.",
      tool,
      details: reason,
    },
  };
}

function fallbackCandidate(args, row) {
  const notePath = notePathForObsidian(args, row);
  const noteTitle = typeof row.title === "string" && row.title.trim()
    ? row.title.trim()
    : path.basename(notePath.replace(/^qmd:\/\/[^/]+\//, "").replace(/\?index=.*$/, ""), ".md");
  return {
    notePath,
    noteTitle,
    relation: "weak",
    hit: firstSnippetLine(row.snippet) || `QMD score ${row.score ?? "unknown"}`,
    why: "Direct QMD recall surfaced this note as a candidate; relation is marked weak pending Relation Judge.",
    quotes: [],
    selected: true,
  };
}

function extractJsonArray(output) {
  const start = output.indexOf("[");
  const end = output.lastIndexOf("]");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("QMD output did not include a JSON array.");
  }
  return JSON.parse(output.slice(start, end + 1));
}

function firstSnippetLine(snippet) {
  if (typeof snippet !== "string") return "";
  return snippet
    .split(/\r?\n/)
    .map((line) => line.replace(/^\d+:\s*/, "").trim())
    .find((line) =>
      line &&
      !line.startsWith("@@") &&
      line !== "---" &&
      !/^(create|cssclasses|tags|categories|emotion):\s*/.test(line)
    ) ?? "";
}

function extractStructuredJson(stdout) {
  const trimmed = stdout.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    return JSON.parse(trimmed);
  }

  const begin = stdout.indexOf(JSON_BEGIN);
  const end = stdout.lastIndexOf(JSON_END);
  if (begin === -1 || end === -1 || end <= begin) {
    throw new Error("Model output did not include AHA_RESULT_JSON markers.");
  }
  const json = stdout.slice(begin + JSON_BEGIN.length, end).trim();
  return JSON.parse(json);
}

async function exists(filePath) {
  try {
    await access(filePath, fsConstants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function runCommand(command, args, options = {}) {
  const timeoutMs = Number(options.timeoutMs ?? 900_000);
  const maxOutputBytes = Number(options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: childCommandEnvironment(options.sensitiveEnvName),
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill("SIGTERM");
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }, 1_000).unref();
      reject(error);
    };
    const timer = setTimeout(() => {
      fail(new Error(`${command} timed out after ${timeoutMs}ms.`));
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      stdoutBytes += Buffer.byteLength(text);
      if (stdoutBytes > maxOutputBytes) {
        fail(new Error(`${command} stdout exceeded ${maxOutputBytes} bytes.`));
        return;
      }
      stdout += text;
    });
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderrBytes += Buffer.byteLength(text);
      if (stderrBytes > maxOutputBytes) {
        fail(new Error(`${command} stderr exceeded ${maxOutputBytes} bytes.`));
        return;
      }
      stderr += text;
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

function childCommandEnvironment(sensitiveEnvName) {
  const env = { ...process.env };
  if (sensitiveEnvName) delete env[sensitiveEnvName];
  return env;
}

function withTimeout(promise, timeoutMs, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

function parseArgs(rawArgs) {
  const args = {
    checkReadiness: false,
    checkLlmConnection: false,
    fixture: "",
    llmApiKeyEnv: DEFAULT_LLM_API_KEY_ENV,
    llmBaseUrl: DEFAULT_LLM_BASE_URL,
    llmModel: DEFAULT_LLM_MODEL,
    llmProvider: DEFAULT_LLM_PROVIDER,
    obsidianCommand: "obsidian",
    qmdCommand: "qmd",
    qmdDbPath: "",
    qmdIndex: DEFAULT_QMD_INDEX,
    reviewPath: "",
    qmdRerank: false,
    qmdQueryTimeoutMs: DEFAULT_QMD_QUERY_TIMEOUT_MS,
    qmdRunner: DEFAULT_QMD_RUNNER,
    qmdSdkModule: "",
    sourceAbsolutePath: "",
    sourcePath: "",
    strategy: "pipeline",
    targetCandidates: 20,
    timeoutMs: 900_000,
    vaultRoot: "",
    workspace: process.cwd(),
  };

  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index];
    const next = () => rawArgs[++index] ?? "";
    switch (arg) {
      case "--check-readiness":
        args.checkReadiness = true;
        break;
      case "--check-llm-connection":
        args.checkLlmConnection = true;
        break;
      case "--fixture":
        args.fixture = next();
        break;
      case "--llm-api-key-env":
        args.llmApiKeyEnv = next();
        break;
      case "--llm-base-url":
        args.llmBaseUrl = next();
        break;
      case "--llm-model":
        args.llmModel = next();
        break;
      case "--llm-provider":
        args.llmProvider = next();
        break;
      case "--obsidian-command":
        args.obsidianCommand = next();
        break;
      case "--qmd-command":
        args.qmdCommand = next();
        break;
      case "--qmd-db-path":
        args.qmdDbPath = next();
        break;
      case "--qmd-index":
        args.qmdIndex = next();
        break;
      case "--review-path":
        args.reviewPath = next();
        break;
      case "--qmd-rerank":
        args.qmdRerank = true;
        break;
      case "--qmd-query-timeout-ms":
        args.qmdQueryTimeoutMs = Number(next());
        break;
      case "--qmd-runner":
        args.qmdRunner = next();
        break;
      case "--qmd-sdk-module":
        args.qmdSdkModule = next();
        break;
      case "--source-absolute-path":
        args.sourceAbsolutePath = next();
        break;
      case "--source-path":
        args.sourcePath = next();
        break;
      case "--strategy":
        args.strategy = next();
        break;
      case "--target-candidates":
        args.targetCandidates = Number(next());
        break;
      case "--timeout-ms":
        args.timeoutMs = Number(next());
        break;
      case "--vault-root":
        args.vaultRoot = next();
        break;
      case "--workspace":
        args.workspace = next();
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  args.workspace = path.resolve(args.workspace);
  if (args.vaultRoot) args.vaultRoot = path.resolve(args.vaultRoot);
  args.llmProvider = VALID_LLM_PROVIDERS.has(args.llmProvider) ? args.llmProvider : DEFAULT_LLM_PROVIDER;
  args.llmBaseUrl = String(args.llmBaseUrl || DEFAULT_LLM_BASE_URL).trim() || DEFAULT_LLM_BASE_URL;
  args.llmModel = String(args.llmModel || DEFAULT_LLM_MODEL).trim() || DEFAULT_LLM_MODEL;
  args.llmApiKeyEnv = String(args.llmApiKeyEnv || DEFAULT_LLM_API_KEY_ENV).trim() || DEFAULT_LLM_API_KEY_ENV;
  args.qmdRunner = VALID_QMD_RUNNERS.has(args.qmdRunner) ? args.qmdRunner : DEFAULT_QMD_RUNNER;
  args.qmdIndex = String(args.qmdIndex || DEFAULT_QMD_INDEX).trim() || DEFAULT_QMD_INDEX;
  args.targetCandidates = clampTargetCandidates(args.targetCandidates);
  args.qmdQueryTimeoutMs = clampPositiveInteger(args.qmdQueryTimeoutMs, DEFAULT_QMD_QUERY_TIMEOUT_MS);
  return args;
}

function clampTargetCandidates(value) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed)) return MAX_TARGET_CANDIDATES;
  return Math.min(MAX_TARGET_CANDIDATES, Math.max(MIN_TARGET_CANDIDATES, parsed));
}

function clampPositiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function emitJson(value, exitCode = 0) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`, () => {
    process.exit(exitCode);
  });
}

function failedAhaResult({
  sourcePath,
  summary,
  warnings = [],
  message,
  tool,
  details,
  candidates = [],
}) {
  const detailText = String(details || message);
  return {
    ok: false,
    sourcePath,
    generatedAt: new Date().toISOString(),
    summary,
    warnings,
    error: {
      message,
      tool,
      details: detailText,
    },
    candidates,
  };
}

function firstLine(value) {
  return String(value ?? "").split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "";
}
