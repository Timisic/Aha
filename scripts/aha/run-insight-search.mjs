#!/usr/bin/env node
import { access, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { constants as fsConstants, realpathSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { connect as tlsConnect } from "node:tls";
import { spawn, spawnSync } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { validateAhaResult } from "./lib/result-validator.mjs";
import { notePathForObsidian, normalizeNoteIdentity, sameNotePath } from "./lib/note-identity.mjs";
import { isExcludedCandidatePath } from "../lib/candidate-fields.mjs";
import { excerptNoteMarkdown } from "../lib/note-excerpt.mjs";
import {
  compactLine,
  fallbackQmdObject as sharedFallbackQmdObject,
  generateQueryPlanWithAdapter,
  qmdQueryFromObject as sharedQmdQueryFromObject,
  unique,
} from "./query-plan.mjs";
import { judgeCandidateRelations, normalizeStructuredResult } from "./relation-judge.mjs";
import { isNoProxyHost, parseMacProxyConfig } from "../lib/https-proxy.mjs";
import {
  DEFAULT_OPENAI_MAX_ATTEMPTS,
  extractOpenAiOutputText,
  openAiResponsesUrl,
} from "../lib/openai-json-agent.mjs";
import { buildRuntimePipelineTrace } from "../lib/pipeline-trace.mjs";
import { runRetrievalPipeline } from "./retrieval-pipeline.mjs";
import { DEFAULT_RETRIEVAL_POLICY_ID, retrievalPolicyById, policyWithDisplayBudget } from "./retrieval-policies.mjs";
import {
  emptyOpenAiTransportStats,
  isRetryableOpenAiTransportError,
  mergeOpenAiTransportStats,
  normalizeOpenAiAttemptFragment,
  normalizeOpenAiTransportStats,
  openAiTransportCategory,
  wrapOpenAiCurlFallbackError,
} from "../lib/openai-transport.mjs";

const JSON_BEGIN = "AHA_RESULT_JSON_BEGIN";
const JSON_END = "AHA_RESULT_JSON_END";
const MIN_TARGET_CANDIDATES = 15;
const MAX_TARGET_CANDIDATES = 20;
const DEFAULT_MAX_OUTPUT_BYTES = 5 * 1024 * 1024;
const OPENAI_RETRY_BACKOFF_MS = [250, 750];
const OPENAI_INVALID_JSON_ERROR = "OpenAI API returned invalid JSON.";
const OPENAI_MISSING_OUTPUT_ERROR = "OpenAI API response did not include structured output.";
const DEFAULT_QMD_QUERY_TIMEOUT_MS = 30_000;
const DEFAULT_QMD_CANDIDATE_LIMIT = 20;
const DEFAULT_LLM_PROVIDER = "openai";
const DEFAULT_LLM_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_LLM_MODEL = "gpt-5.5";
const DEFAULT_LLM_API_KEY_ENV = "OPENAI_API_KEY";
const DEFAULT_QMD_RUNNER = "sdk";
const DEFAULT_QMD_INDEX = "obsidian";
const VALID_LLM_PROVIDERS = new Set(["codex-cli", "openai"]);
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

if (isMainModule()) {
  main().catch((error) => {
    emitJson(failedAhaResult({
      sourcePath: null,
      summary: "Aha wrapper failed before completing the search round.",
      message: "Aha wrapper failed.",
      tool: "wrapper",
      details: error instanceof Error ? error.message : String(error),
    }), 1);
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

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
    const result = await pipelineRecall(args, sourceText);
    emitJson(result, result.ok ? 0 : 2);
    return;
  }

  if (args.strategy === "qmd-only") {
    const recall = await qmdRecall(args, sourceText);
    emitJson(weakFallbackFromRows(args, recall.rows, "Codex relation judging skipped by qmd-only strategy."));
    return;
  }

  if (args.strategy !== "codex-orchestrated") {
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
      parsed = normalizeStructuredResult(extractCodexJson(llmOutput.stdout));
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
    return;
  }

  const prompt = buildCodexPrompt(args, sourceText);
  let codexOutput;
  try {
    codexOutput = await runCodex(args, prompt);
  } catch (error) {
    emitJson(await codexOrchestrationFailure(args, sourceText, `Codex run failed: ${error.message}`), 2);
    return;
  }

  if (codexOutput.code !== 0) {
    emitJson(await codexOrchestrationFailure(
      args,
      sourceText,
      `Codex exited ${codexOutput.code}: ${firstLine(codexOutput.stderr || codexOutput.stdout) || "no diagnostic"}`,
    ), 2);
    return;
  }
  let parsed;
  try {
    parsed = normalizeStructuredResult(extractCodexJson(codexOutput.stdout));
  } catch (error) {
    emitJson(await codexOrchestrationFailure(args, sourceText, `Codex returned non-JSON output: ${error.message}`), 2);
    return;
  }
  const validation = validateAhaResult(parsed);
  if (!validation.ok) {
    emitJson(await codexOrchestrationFailure(args, sourceText, `Codex returned malformed Aha output: ${validation.errors.join("; ")}`), 2);
    return;
  }

  emitJson({
    ...parsed,
    generatedAt: parsed.generatedAt ?? new Date().toISOString(),
    sourcePath: parsed.sourcePath ?? args.sourcePath,
  });
}

async function readiness(args) {
  const checks = [];
  checks.push(await checkWorkspace(args.workspace));
  checks.push(await checkReadableSourceNote(args));
  if (args.llmProvider === "openai") {
    checks.push(checkOpenAiApiKey(args));
  } else {
    checks.push(await checkCommand("Codex CLI", args.codexCommand, ["--version"]));
  }
  if (args.qmdRunner === "sdk") {
    checks.push(await checkQmdSdk(args));
  } else {
    checks.push(await checkCommand("QMD CLI", args.qmdCommand, ["--version"]));
  }
  checks.push(await checkCommand("Obsidian CLI", args.obsidianCommand, ["files", "total"]));
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

async function checkCommand(name, command, args) {
  if (!command) return { name, ok: false, message: "Not configured." };
  try {
    const result = await runCommand(command, args, { timeoutMs: 15_000 });
    return result.code === 0
      ? { name, ok: true, message: firstLine(result.stdout || result.stderr) || "OK" }
      : { name, ok: false, message: firstLine(result.stderr || result.stdout) || `Exited ${result.code}` };
  } catch (error) {
    return { name, ok: false, message: error.message };
  }
}

function checkOpenAiApiKey(args) {
  const envName = String(args.llmApiKeyEnv || "").trim();
  if (!envName) return { name: "OpenAI API key", ok: false, message: "API key environment variable is not configured." };
  return process.env[envName]
    ? { name: "OpenAI API key", ok: true, message: `${envName} is set.` }
    : { name: "OpenAI API key", ok: false, message: `${envName} is not set.` };
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

function buildCodexPrompt(args, sourceText) {
  const target = Number(args.targetCandidates || 20);
  return [
    "You are running the Aha retrieval orchestration for an Obsidian plugin MVP.",
    "Do not modify Obsidian notes or repository files.",
    "Stay bounded: return within five minutes with partial useful candidates rather than exploring indefinitely.",
    "Use QMD for semantic recall. Run at most two QMD query commands and at most eight candidate read commands.",
    "Read candidate note text before assigning supports, challenges, resembles, or bounds. If you only have snippets, label the candidate weak.",
    "",
    "Local commands:",
    `- qmd command: ${args.qmdCommand}`,
    `- obsidian command: ${args.obsidianCommand}`,
    `- Aha workspace: ${args.workspace}`,
    `- vault root: ${args.vaultRoot}`,
    `- source vault path: ${args.sourcePath}`,
    `- source absolute path: ${args.sourceAbsolutePath}`,
    "",
    `Return up to ${target} candidate old notes; target 15-20 when enough candidates exist.`,
    "Allowed relation labels: supports, challenges, resembles, bounds, weak.",
    "For supports, challenges, resembles, and bounds, include quote-backed hit material from the old note text.",
    "Use Chinese for user-facing summary and why text when the source or candidate content is Chinese. Keep JSON keys and relation labels in English.",
    "Write why as a compact, note-like bridge: lead with the concrete idea or tension, not with a generic phrase about the candidate.",
    "Avoid formulaic openings such as “这条旧笔记…”, “这条笔记…”, “这条候选…”, or “直接支撑当前 source…”. Do not reuse the same sentence frame across candidates.",
    "",
    "Return only JSON as the final answer. It must match this shape:",
    JSON.stringify({
      ok: true,
      summary: "简短说明这一轮检索找到了什么",
      warnings: [],
      candidates: [
        {
          notePath: "vault-relative/path.md",
          noteTitle: "Readable title",
          relation: "supports",
          hit: "\"short quote from old note\"",
          quotes: ["short quote from old note"],
          why: "用自然中文点出旧判断和当前 insight 之间的具体连接，不要写成模板句。",
          selected: true,
        },
      ],
    }, null, 2),
    "",
    "If your Codex CLI output-schema support is unavailable, you may instead wrap the same JSON between these exact fallback markers:",
    JSON_BEGIN,
    "{...same JSON shape...}",
    JSON_END,
    "",
    "Source note content:",
    "```markdown",
    sourceText.slice(0, 12_000),
    "```",
  ].join("\n");
}

async function runCodex(args, prompt, options = {}) {
  const schemaPath = options.schemaPath ?? path.join(args.workspace, "scripts/aha/aha-result.schema.json");
  const tempDir = await mkdtemp(path.join(tmpdir(), "aha-codex-"));
  const codexCwd = options.isolateCwd ? tempDir : options.codexCwd ?? args.workspace;
  const outputFile = path.join(tempDir, options.outputFileName ?? "last-message.json");
  const codexArgs = [
    "--ask-for-approval",
    "never",
    "--model",
    args.codexModel,
    "--sandbox",
    options.sandbox ?? args.codexSandbox,
    "exec",
    "--ephemeral",
  ];

  if (options.skipGitRepoCheck) {
    codexArgs.push("--skip-git-repo-check");
  }

  if (options.ignoreRules) {
    codexArgs.push("--ignore-rules");
  }

  codexArgs.push(
    "-C",
    codexCwd,
    "--disable",
    "hooks",
    "-c",
    `model_reasoning_effort="${args.codexReasoningEffort}"`,
  );

  if (await exists(schemaPath)) {
    codexArgs.push("--output-schema", schemaPath);
  }

  codexArgs.push(
    "--output-last-message",
    outputFile,
    prompt,
  );

  try {
    const result = await runCommand(args.codexCommand, codexArgs, {
      cwd: codexCwd,
      timeoutMs: Number(options.timeoutMs ?? args.timeoutMs),
    });
    const lastMessage = await readFile(outputFile, "utf8").catch(() => "");
    return {
      ...result,
      stdout: lastMessage.trim() || result.stdout,
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function runLlm(args, prompt, options = {}) {
  if (args.llmProvider === "openai") {
    return runOpenAi(args, prompt, options);
  }
  return runCodex(args, prompt, options);
}

async function runOpenAi(args, prompt, options = {}) {
  const apiKey = process.env[args.llmApiKeyEnv];
  if (!apiKey) {
    throw new Error(`${args.llmApiKeyEnv} is not set.`);
  }

  const schemaPath = options.schemaPath ?? path.join(args.workspace, "scripts/aha/aha-result.schema.json");
  const schema = await readJsonIfExists(schemaPath);
  const requestBody = {
    model: args.llmModel,
    input: prompt,
  };
  if (schema) {
    requestBody.text = {
      format: {
        type: "json_schema",
        name: schemaNameForPath(schemaPath),
        schema,
        strict: true,
      },
    };
  }

  const perAttemptTimeoutMs = Number(options.openAiPerAttemptTimeoutMs ?? options.timeoutMs ?? args.timeoutMs);
  const totalTimeoutMs = Number(options.openAiTotalTimeoutMs ?? args.timeoutMs);
  let request;
  try {
    request = await postOpenAiJsonWithRetry(openAiResponsesUrl(args.llmBaseUrl), requestBody, {
      "Authorization": `Bearer ${apiKey}`,
    }, perAttemptTimeoutMs, totalTimeoutMs);
  } catch (error) {
    recordOpenAiTransport(args, options.transportStage, error.openAiTransport);
    throw error;
  }
  recordOpenAiTransport(args, options.transportStage, request.transport);
  // A 2xx response with malformed or missing output is a contract failure, not a transient request.
  let payload;
  try {
    payload = JSON.parse(request.response.body);
  } catch {
    throw new Error(OPENAI_INVALID_JSON_ERROR);
  }
  if (process.env.AHA_LOG_USAGE === "1" && payload?.usage) {
    process.stderr.write(`AHA_USAGE ${JSON.stringify({ model: payload.model, usage: payload.usage })}\n`);
  }
  let outputText;
  try {
    outputText = extractOpenAiOutputText(payload);
  } catch {
    throw new Error(OPENAI_MISSING_OUTPUT_ERROR);
  }
  return {
    code: 0,
    stdout: outputText,
    stderr: "",
  };
}

async function postOpenAiJsonWithRetry(url, payload, headers, perAttemptTimeoutMs, totalTimeoutMs) {
  const perAttemptCapMs = positiveTimeoutMs(perAttemptTimeoutMs, 120_000);
  const deadline = Date.now() + openAiRetryBudgetMs(perAttemptCapMs, totalTimeoutMs);
  const transport = { ...emptyOpenAiTransportStats(), request_count: 1 };
  let lastError = null;
  let pendingRetryCategory = null;
  for (let attempt = 1; attempt <= DEFAULT_OPENAI_MAX_ATTEMPTS; attempt += 1) {
    const remaining = remainingDeadlineMs(deadline);
    if (remaining <= 0) throw withOpenAiTransport(openAiDeadlineError(), transport);
    if (pendingRetryCategory) {
      transport.retry_count += 1;
      transport.retry_categories[pendingRetryCategory] = (transport.retry_categories[pendingRetryCategory] ?? 0) + 1;
      pendingRetryCategory = null;
    }
    let response;
    try {
      response = await postJson(
        url,
        payload,
        headers,
        openAiAttemptDeadline(
          deadline,
          perAttemptCapMs,
          DEFAULT_OPENAI_MAX_ATTEMPTS - attempt + 1,
        ),
      );
      mergeAttemptTransport(transport, response.openAiAttempt);
    } catch (error) {
      mergeAttemptTransport(transport, error.openAiAttempt);
      if (!isRetryableOpenAiTransportError(error) || attempt === DEFAULT_OPENAI_MAX_ATTEMPTS) {
        throw withOpenAiTransport(openAiAttemptsError(error, attempt), transport);
      }
      lastError = error;
      pendingRetryCategory = openAiTransportCategory(error);
      await waitForOpenAiRetry(attempt, null, deadline, transport);
      continue;
    }

    if (response.statusCode >= 200 && response.statusCode < 300) {
      return { response, transport: normalizeOpenAiTransportStats(transport) };
    }
    const error = new Error(
      `OpenAI API request failed (${isInsufficientQuotaResponse(response.body)
        ? "permanent_quota"
        : httpFailureCategory(response.statusCode)}).`,
    );
    if (
      !isTransientOpenAiHttpResponse(response)
      || attempt === DEFAULT_OPENAI_MAX_ATTEMPTS
    ) {
      throw withOpenAiTransport(openAiAttemptsError(error, attempt), transport);
    }
    lastError = error;
    pendingRetryCategory = retryCategoryForHttpStatus(response.statusCode);
    await waitForOpenAiRetry(attempt, response.headers, deadline, transport);
  }
  throw withOpenAiTransport(
    openAiAttemptsError(lastError ?? new Error("OpenAI API request failed."), DEFAULT_OPENAI_MAX_ATTEMPTS),
    transport,
  );
}

function isTransientOpenAiHttpResponse(response) {
  if (response.statusCode === 429 && isInsufficientQuotaResponse(response.body)) return false;
  return response.statusCode === 408
    || response.statusCode === 429
    || (response.statusCode >= 500 && response.statusCode <= 599);
}

function openAiAttemptsError(error, attempts) {
  const message = String(error?.message ?? error ?? "");
  const safeMessage = /^OpenAI API request failed \([a-z0-9_]+\)\.$/.test(message)
    ? message
    : `OpenAI API request failed (${openAiTransportCategory(error)}).`;
  return new Error(attempts <= 1 ? safeMessage : `${safeMessage} (after ${attempts} attempts)`);
}

async function waitForOpenAiRetry(attempt, headers, deadline, transport) {
  const defaultDelay = OPENAI_RETRY_BACKOFF_MS[Math.min(attempt - 1, OPENAI_RETRY_BACKOFF_MS.length - 1)];
  const delayMs = Math.max(defaultDelay, retryAfterMs(headers));
  if (delayMs >= remainingDeadlineMs(deadline)) {
    throw withOpenAiTransport(openAiDeadlineError(), transport);
  }
  await new Promise((resolvePromise) => setTimeout(resolvePromise, delayMs));
}

function recordOpenAiTransport(args, stage, value) {
  if (!stage || !value || !args._openAiTransport) return;
  args._openAiTransport[stage] = mergeOpenAiTransportStats(args._openAiTransport[stage], value);
}

function mergeAttemptTransport(transport, attempt) {
  const normalized = normalizeOpenAiAttemptFragment(attempt ?? { attempt_count: 1 });
  transport.attempt_count += normalized.attempt_count || 1;
  transport.retry_count += normalized.retry_count;
  for (const [category, count] of Object.entries(normalized.retry_categories)) {
    transport.retry_categories[category] = (transport.retry_categories[category] ?? 0) + count;
  }
}

function withOpenAiTransport(error, transport) {
  const normalized = error instanceof Error ? error : new Error(String(error));
  normalized.openAiTransport = normalizeOpenAiTransportStats(transport);
  return normalized;
}

function withAttemptTransport(response, attemptCount, retryCategory = null) {
  return {
    ...response,
    openAiAttempt: {
      request_count: 0,
      attempt_count: attemptCount,
      retry_count: Math.max(0, attemptCount - 1),
      retry_categories: retryCategory && attemptCount > 1 ? { [retryCategory]: attemptCount - 1 } : {},
    },
  };
}

function withAttemptError(error, attemptCount, retryCategory = null) {
  const normalized = error instanceof Error ? error : new Error(String(error));
  normalized.openAiAttempt = withAttemptTransport({}, attemptCount, retryCategory).openAiAttempt;
  return normalized;
}

function retryCategoryForHttpStatus(statusCode) {
  if (statusCode === 408) return "timeout";
  if (statusCode === 429) return "http_429";
  return "http_5xx";
}

function httpFailureCategory(statusCode) {
  if (statusCode === 408) return "timeout";
  if (statusCode === 429) return "http_429";
  if (statusCode >= 500) return "http_5xx";
  return "http_4xx";
}

function isInsufficientQuotaResponse(body) {
  try {
    const payload = JSON.parse(String(body ?? "{}"));
    return payload?.error?.code === "insufficient_quota" || payload?.error?.type === "insufficient_quota";
  } catch {
    return false;
  }
}

function retryAfterMs(headers) {
  const raw = headers?.["retry-after"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined || value === null || String(value).trim() === "") return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1_000);
  const date = Date.parse(String(value));
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : 0;
}

function remainingDeadlineMs(deadline) {
  return Math.max(0, deadline - Date.now());
}

function requireRemainingDeadline(deadline) {
  const remaining = remainingDeadlineMs(deadline);
  if (remaining <= 0) throw openAiDeadlineError();
  return remaining;
}

export function openAiRetryBudgetMs(perAttemptTimeoutMs, totalTimeoutMs) {
  const perAttemptCapMs = positiveTimeoutMs(perAttemptTimeoutMs, 120_000);
  const boundedBackoffMs = OPENAI_RETRY_BACKOFF_MS
    .slice(0, Math.max(0, DEFAULT_OPENAI_MAX_ATTEMPTS - 1))
    .reduce((total, delayMs) => total + delayMs, 0);
  const fullRetryBudgetMs = (perAttemptCapMs * DEFAULT_OPENAI_MAX_ATTEMPTS) + boundedBackoffMs;
  return Math.min(positiveTimeoutMs(totalTimeoutMs, fullRetryBudgetMs), fullRetryBudgetMs);
}

export function openAiAttemptDeadline(
  totalDeadline,
  perAttemptTimeoutMs,
  remainingSlots,
  now = Date.now(),
) {
  const remaining = Math.max(0, Number(totalDeadline) - Number(now));
  if (remaining <= 0) throw openAiDeadlineError();
  const slots = Math.max(1, Math.floor(Number(remainingSlots) || 1));
  const fairBudgetMs = Math.max(1, Math.floor(remaining / slots));
  const perAttemptCapMs = positiveTimeoutMs(perAttemptTimeoutMs, fairBudgetMs);
  return Math.min(totalDeadline, now + Math.min(perAttemptCapMs, fairBudgetMs));
}

function dividedDeadline(deadline, remainingSlots) {
  const remaining = requireRemainingDeadline(deadline);
  const budget = Math.max(1, Math.floor(remaining / Math.max(1, remainingSlots)));
  return Math.min(deadline, Date.now() + budget);
}

function openAiDeadlineError() {
  return Object.assign(new Error("OpenAI API timed out within the shared request deadline."), { code: "ETIMEDOUT" });
}

async function postJson(url, payload, headers, deadline) {
  const target = new URL(url);
  const body = JSON.stringify(payload);
  try {
    const nodeDeadline = deadline;
    const proxyUrl = proxyUrlFor(target, dividedDeadline(nodeDeadline, 2));
    if (proxyUrl && target.protocol === "https:") {
      const socket = await openHttpsProxyTunnel(
        target,
        proxyUrl,
        requireRemainingDeadline(nodeDeadline),
      );
      return withAttemptTransport(await postJsonWithRequest(
        httpsRequest,
        target,
        body,
        headers,
        nodeDeadline,
        {
          createConnection: () => socket,
          agent: false,
        },
      ).catch((error) => {
        socket.destroy();
        throw error;
      }), 1);
    }
    const requestFn = target.protocol === "http:" ? httpRequest : httpsRequest;
    return withAttemptTransport(
      await postJsonWithRequest(requestFn, target, body, headers, nodeDeadline),
      1,
    );
  } catch (error) {
    if (target.protocol !== "https:") throw withAttemptError(error, 1);
    const category = openAiTransportCategory(error);
    if (category === "timeout" || remainingDeadlineMs(deadline) <= 0) {
      throw withAttemptError(error, 1);
    }
    try {
      const response = await postJsonWithCurl(
        target,
        body,
        headers,
        deadline,
        error,
      );
      return withAttemptTransport(response, 2, category);
    } catch (curlError) {
      throw withAttemptError(wrapOpenAiCurlFallbackError(error, curlError), 2, category);
    }
  }
}

function postJsonWithRequest(requestFn, target, body, headers, deadline, extraOptions = {}) {
  const timeoutMs = requireRemainingDeadline(deadline);
  return new Promise((resolve, reject) => {
    let settled = false;
    let deadlineTimer;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadlineTimer);
      if (error) reject(error);
      else resolve(value);
    };
    const request = requestFn({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || (target.protocol === "https:" ? 443 : 80),
      path: `${target.pathname}${target.search}`,
      method: "POST",
      headers: {
        ...headers,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
        "Connection": "close",
      },
      timeout: timeoutMs,
      ...extraOptions,
    }, (response) => {
      let responseBody = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        responseBody += chunk;
      });
      response.on("end", () => {
        finish(null, {
          statusCode: response.statusCode ?? 0,
          statusMessage: response.statusMessage ?? "",
          body: responseBody,
          headers: response.headers ?? {},
        });
      });
      response.on("aborted", () => finish(Object.assign(
        new Error("OpenAI response stream aborted."),
        { code: "ECONNRESET" },
      )));
      response.on("error", (error) => finish(error));
    });
    deadlineTimer = setTimeout(() => {
      request.destroy(openAiDeadlineError());
    }, timeoutMs);
    request.on("timeout", () => {
      request.destroy(openAiDeadlineError());
    });
    request.on("error", (error) => finish(error));
    request.end(body);
  });
}

function proxyUrlFor(target, deadline) {
  if (isNoProxyHost(target.hostname, process.env.NO_PROXY || process.env.no_proxy || "")) return null;
  const rawProxy = target.protocol === "https:"
    ? process.env.HTTPS_PROXY || process.env.https_proxy || process.env.ALL_PROXY || process.env.all_proxy
    : process.env.HTTP_PROXY || process.env.http_proxy || process.env.ALL_PROXY || process.env.all_proxy;
  const raw = rawProxy || systemProxyUrlFor(target, deadline);
  if (!raw) return null;
  try {
    const proxy = new URL(raw);
    return proxy.protocol === "http:" ? proxy : null;
  } catch {
    return null;
  }
}

function systemProxyUrlFor(target, deadline) {
  if (process.platform !== "darwin") return "";
  const result = spawnSync("scutil", ["--proxy"], {
    encoding: "utf8",
    timeout: Math.min(2_000, requireRemainingDeadline(deadline)),
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0 || !result.stdout) return "";
  const proxyConfig = parseMacProxyConfig(result.stdout);
  const exceptions = proxyConfig.ExceptionsList || [];
  if (Array.isArray(exceptions) && exceptions.some((item) => isNoProxyHost(target.hostname, item))) return "";
  const prefix = target.protocol === "https:" ? "HTTPS" : "HTTP";
  if (proxyConfig[`${prefix}Enable`] !== "1") return "";
  const host = proxyConfig[`${prefix}Proxy`];
  const port = proxyConfig[`${prefix}Port`];
  if (!host || !port) return "";
  return `http://${host}:${port}`;
}

function openHttpsProxyTunnel(target, proxy, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const targetPort = target.port || "443";
    const finish = (error, socket) => {
      if (settled) {
        if (socket) socket.destroy();
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(socket);
    };
    const headers = {
      Host: `${target.hostname}:${targetPort}`,
    };
    if (proxy.username || proxy.password) {
      headers["Proxy-Authorization"] = `Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString("base64")}`;
    }
    const request = httpRequest({
      host: proxy.hostname,
      port: proxy.port || 80,
      method: "CONNECT",
      path: `${target.hostname}:${targetPort}`,
      headers,
    });
    const timer = setTimeout(() => {
      request.destroy(new Error(`OpenAI proxy tunnel timed out after ${timeoutMs}ms.`));
    }, timeoutMs);
    request.on("connect", (response, socket) => {
      if ((response.statusCode ?? 0) < 200 || (response.statusCode ?? 0) >= 300) {
        finish(new Error(`OpenAI proxy tunnel exited ${response.statusCode ?? 0}: ${response.statusMessage || "CONNECT failed"}`));
        socket.destroy();
        return;
      }
      const secureSocket = tlsConnect({
        socket,
        servername: target.hostname,
      });
      secureSocket.once("secureConnect", () => finish(null, secureSocket));
      secureSocket.once("error", (error) => finish(error));
    });
    request.on("error", (error) => finish(error));
    request.end();
  });
}

async function postJsonWithCurl(target, body, headers, deadline, nodeError) {
  const tempDir = await mkdtemp(path.join(tmpdir(), "aha-openai-curl-"));
  const bodyPath = path.join(tempDir, "body.json");
  const headersPath = path.join(tempDir, "headers.txt");
  const statusMarker = "\nAHA_CURL_HTTP_STATUS:";
  try {
    await writeFile(bodyPath, body, { mode: 0o600 });
    const config = [
      `url = "${target.href.replace(/"/g, "%22")}"`,
      'request = "POST"',
      ...Object.entries(headers).map(([name, value]) => `header = "${name}: ${String(value).replace(/"/g, '\\"')}"`),
      'header = "Content-Type: application/json"',
      'header = "Connection: close"',
      "",
    ].join("\n");
    const timeoutMs = requireRemainingDeadline(deadline);
    const result = await runCurl([
      "-q",
      "-sS",
      "--no-progress-meter",
      "--max-time",
      (Math.max(1, timeoutMs) / 1_000).toFixed(3),
      "--dump-header",
      headersPath,
      "--config",
      "-",
      "--data-binary",
      `@${bodyPath}`,
      "--write-out",
      `${statusMarker}%{http_code}`,
    ], config, timeoutMs);
    const statusIndex = result.stdout.lastIndexOf(statusMarker);
    if (result.code !== 0 || statusIndex === -1) {
      const detail = firstLine(result.stderr || result.stdout) || `curl exited ${result.code ?? "unknown"}`;
      throw new Error(`OpenAI API request failed with Node HTTPS (${nodeError.message}); curl fallback failed: ${detail}`);
    }
    return {
      statusCode: Number(result.stdout.slice(statusIndex + statusMarker.length).trim()) || 0,
      statusMessage: "",
      body: result.stdout.slice(0, statusIndex),
      headers: parseCurlHeaders(await readFile(headersPath, "utf8").catch(() => "")),
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function parseCurlHeaders(value) {
  const blocks = String(value ?? "").trim().split(/\r?\n\r?\n/).filter(Boolean);
  const lines = (blocks.at(-1) ?? "").split(/\r?\n/).slice(1);
  const headers = {};
  for (const line of lines) {
    const separator = line.indexOf(":");
    if (separator <= 0) continue;
    headers[line.slice(0, separator).trim().toLowerCase()] = line.slice(separator + 1).trim();
  }
  return headers;
}

function runCurl(args, stdin, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn("curl", args, {
      env: process.env,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
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
      reject(error);
    };
    const timer = setTimeout(() => {
      fail(new Error(`curl timed out after ${timeoutMs}ms.`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      stdoutBytes += Buffer.byteLength(text);
      if (stdoutBytes > DEFAULT_MAX_OUTPUT_BYTES) {
        fail(new Error(`curl stdout exceeded ${DEFAULT_MAX_OUTPUT_BYTES} bytes.`));
        return;
      }
      stdout += text;
    });
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderrBytes += Buffer.byteLength(text);
      if (stderrBytes > DEFAULT_MAX_OUTPUT_BYTES) {
        fail(new Error(`curl stderr exceeded ${DEFAULT_MAX_OUTPUT_BYTES} bytes.`));
        return;
      }
      stderr += text;
    });
    child.on("error", (error) => fail(error));
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.stdin.end(stdin);
  });
}

function schemaNameForPath(schemaPath) {
  return path.basename(schemaPath, path.extname(schemaPath)).replace(/[^a-zA-Z0-9_-]+/g, "_").slice(0, 64) || "aha_schema";
}

async function readJsonIfExists(filePath) {
  if (!(await exists(filePath))) return null;
  return JSON.parse(await readFile(filePath, "utf8"));
}

function llmDisplayName(args) {
  return args.llmProvider === "openai" ? "OpenAI" : "Codex";
}

function llmToolName(args) {
  return args.llmProvider === "openai" ? "openai" : "codex";
}

function queryPlannerDisplayName(value) {
  if (value === "openai") return "OpenAI";
  if (value === "codex") return "Codex";
  return value || "Unknown";
}

async function qmdFallback(args, sourceText, reason) {
  try {
    const recall = await qmdRecall(args, sourceText);
    return weakFallbackFromRows(args, recall.rows, reason);
  } catch (error) {
    return failedAhaResult({
      sourcePath: args.sourcePath,
      summary: "Aha retrieval failed and QMD fallback could not run.",
      warnings: [reason],
      message: "Aha retrieval failed and QMD fallback could not run.",
      tool: "qmd",
      details: error.message,
    });
  }
}

async function codexOrchestrationFailure(args, sourceText, reason) {
  const fallback = await qmdFallback(args, sourceText, reason);
  return {
    ...fallback,
    ok: false,
    summary: "Codex orchestration failed before it could assign reliable relations.",
    warnings: [
      reason,
      "Weak QMD candidates are included only as diagnostics; this search round must be treated as failed.",
    ],
    error: {
      message: "Aha Codex orchestration failed.",
      tool: "codex",
      details: fallback.error?.details ?? reason,
    },
  };
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

async function pipelineRecall(args, sourceText) {
  args._openAiTransport = {
    query_generation: emptyOpenAiTransportStats(),
    relation_judge: emptyOpenAiTransportStats(),
  };
  const policy = policyWithDisplayBudget(retrievalPolicyById(args.retrievalPolicy), Number(args.targetCandidates || 20));
  const { result, trace } = await runRetrievalPipeline({
    insight: { text: sourceText, sourceExcerpt: sourceText, thought: args.thought, sourcePath: args.sourcePath },
    policy,
    adapters: {
      planQueries: () => generateQueryPlan(args, sourceText),
      retrieve: async ({ queries }) => {
        const retrieval = await runQmdPlanQueries(args, queries);
        return { runs: retrieval.queryResults, errors: retrieval.errors, warnings: retrieval.warnings };
      },
      graphAdapters: ({ state }) => runtimeGraphAdapters(args, state),
      selectCandidates: async ({ state, graphCandidates }) => {
        const queryResults = [...state.retrievalRuns];
        if (graphCandidates.length > 0) {
          queryResults.push({
            query: { kind: "obsidian_graph", command: "obsidian links/backlinks" },
            rows: graphCandidates,
          });
        }
        const candidates = (await rerankPipelineCandidates(args, queryResults))
          .slice(0, policy.candidateBudgets.retrievalPoolBudget)
          .map((candidate) => pipelineCandidate(candidate));
        if (candidates.length === 0) {
          const error = new Error("No usable candidates remained after runtime filtering.");
          error.code = "NO_CANDIDATES";
          error.pipelineStage = "qmd_retrieval";
          throw error;
        }
        return candidates;
      },
      judgeRelationChunk: async ({ candidates }) => {
        const judged = await judgePipelineCandidates(args, sourceText, candidates);
        if (!judged.ok) {
          const error = new Error(judged.error || judged.message || "Relation Judge chunk failed.");
          error.tool = judged.tool;
          error.category = judged.errorCategory;
          throw error;
        }
        return judged.candidates;
      },
      compareRelationsGlobally: async ({ candidates }) => {
        const judged = await judgePipelineCandidates(args, sourceText, candidates);
        if (!judged.ok) {
          const error = new Error(judged.error || judged.message || "Global Relation Judge comparison failed.");
          error.tool = judged.tool;
          error.category = judged.errorCategory;
          throw error;
        }
        return judged.candidates;
      },
      judgeRelations: ({ candidates }) => judgePipelineCandidates(args, sourceText, candidates),
      candidateId: (candidate) => candidate.notePath,
      validateRelationEvidence: (candidate) => candidate,
      formatResult: ({ state, finalCandidates }) => formatRuntimePipelineResult(args, state, finalCandidates),
      onFailure: ({ stage, error, state }) => runtimePipelineFailure(args, stage, error, state),
      buildTrace: ({ state, result }) => buildRuntimePipelineTrace({
        profile: "product-runtime",
        status: result.ok ? "success" : "failed",
        sourcePath: args.sourcePath,
        vaultRoot: args.vaultRoot,
        generatedQuery: state.generatedQuery,
        queryResults: state.retrievalRuns,
        queryErrors: state.retrievalErrors,
        graphExpansion: state.graphExpansion,
        preJudgeCandidates: state.selectedCandidates,
        relationJudge: state.relationJudge,
        finalCandidates: state.finalCandidates,
        openAiTransport: args._openAiTransport,
        errors: state.errors,
        policy,
      }),
    },
  });
  return args.trace ? { ...result, trace } : result;
}

function formatRuntimePipelineResult(args, state, finalCandidates) {
  const plan = state.generatedQuery;
  const relationJudge = state.relationJudge;
  const graphWarnings = [
    ...(state.graphExpansion?.warnings ?? []),
    ...(state.graphExpansion?.failures ?? []).map((failure) => `Graph ${failure.graphCommand || failure.command} failed for ${failure.origin} origin.`),
  ];
  const warnings = [
    `Query plan generated by ${plan.query_generated_by}${plan.query_generation_fallback ? ` after fallback: ${plan.query_generation_error}` : ""}.`,
    relationJudge.ok
      ? "Relation Judge ran on bounded candidate excerpts; strong relation labels require quote evidence from the excerpt."
      : `Relation Judge unavailable; returning structured failure instead of treating weak candidates as success: ${relationJudge.error}`,
    ...graphWarnings,
    ...state.retrievalWarnings,
    ...(relationJudge.warnings ?? []),
    ...state.retrievalErrors.map((error) => `Skipped failed query: ${error}`),
  ];
  const plannerName = queryPlannerDisplayName(plan.query_generated_by);
  const reviewedCount = relationJudge.reviewedCount ?? relationJudge.counts?.reviewed_count ?? 0;
  const summary = `${plannerName} generated ${plan.queries.length} QMD queries; mixed retrieval returned ${state.selectedCandidates.length} reranked candidates; Relation Judge reviewed ${reviewedCount} candidate excerpts.`;
  if (!relationJudge.ok) {
    return failedAhaResult({
      sourcePath: args.sourcePath,
      summary,
      warnings,
      message: relationJudge.message ?? "Aha Relation Judge failed.",
      tool: relationJudge.tool ?? "codex",
      details: relationJudge.error,
      candidates: finalCandidates.map((candidate) => stripInternalCandidateFields(candidate)),
    });
  }
  return {
    ok: true,
    sourcePath: args.sourcePath,
    generatedAt: new Date().toISOString(),
    summary,
    warnings,
    candidates: finalCandidates.map((candidate) => stripInternalCandidateFields(candidate)),
  };
}

function runtimePipelineFailure(args, stage, error, state) {
  if (stage === "query_generation") {
    return failedAhaResult({
      sourcePath: args.sourcePath,
      summary: "Aha query planning failed before retrieval.",
      message: "Aha query planning failed.",
      tool: llmToolName(args),
      details: error.message,
    });
  }
  if (stage === "qmd_retrieval" && error.code === "NO_CANDIDATES") {
    const plan = state.generatedQuery;
    return failedAhaResult({
      sourcePath: args.sourcePath,
      summary: "Aha mixed retrieval returned no usable candidates.",
      warnings: [
        `Query plan generated by ${plan.query_generated_by}${plan.query_generation_fallback ? ` after fallback: ${plan.query_generation_error}` : ""}.`,
        ...(state.graphExpansion?.warnings ?? []),
        ...state.retrievalErrors.map((item) => `Skipped failed query: ${item}`),
      ],
      message: "Aha retrieval returned no usable candidates.",
      tool: "qmd",
      details: state.retrievalErrors.length > 0
        ? state.retrievalErrors.join("; ")
        : "QMD and Obsidian graph expansion returned no vault-contained candidates after self-hit and path-boundary filtering.",
    });
  }
  return failedAhaResult({
    sourcePath: args.sourcePath,
    summary: "Aha retrieval pipeline failed.",
    message: "Aha retrieval pipeline failed.",
    tool: "wrapper",
    details: error.message,
  });
}

function runtimeGraphAdapters(args) {
  const graphCommand = (command) => async ({ path: originPath, limit }) => {
    if (!(await sourceIsVaultBacked(args))) return [];
    const notePath = notePathForObsidian(args, { file: originPath, path: originPath }) || originPath;
    const commandArgs = command === "backlinks"
      ? [command, `path=${notePath}`, "format=json"]
      : [command, `path=${notePath}`];
    const result = await runCommand(args.obsidianCommand, commandArgs, {
      cwd: args.workspace,
      timeoutMs: 15_000,
    });
    if (result.code !== 0) throw new Error(`Obsidian ${command} exited ${result.code}.`);
    return parseObsidianPathList(result.stdout).slice(0, limit);
  };
  return {
    links: graphCommand("links"),
    backlinks: graphCommand("backlinks"),
    admitCandidate: async (row, { command }) => {
      const notePath = typeof row === "string" ? row : notePathForObsidian(args, row);
      if (!notePath?.endsWith(".md")) return null;
      const graphKind = command === "backlinks" ? "backlink" : "outlink";
      const candidateRow = typeof row === "string" ? {
        score: graphKind === "backlink" ? 0.18 : 0.14,
        file: `qmd://obsidian/${notePath}?index=obsidian`,
        title: path.basename(notePath, ".md"),
        snippet: `Obsidian ${graphKind}: ${notePath}`,
      } : row;
      if (!(await isCandidatePathAllowed(args, notePath, candidateRow))) return null;
      if (isSourceCandidate(args, notePath, candidateRow)) return null;
      if (isGeneratedReviewCandidate(args, notePath, candidateRow)) return null;
      if (isExcludedCandidatePath(notePath)) return null;
      return candidateRow;
    },
    canonicalIdentity: (row) => normalizeNoteIdentity(notePathForObsidian(args, row)),
  };
}

async function sourceIsVaultBacked(args) {
  if (!args.vaultRoot || !args.sourcePath) return false;
  if (args.sourceAbsolutePath) {
    const relative = path.relative(args.vaultRoot, args.sourceAbsolutePath);
    if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) return true;
  }
  return exists(path.join(args.vaultRoot, args.sourcePath));
}

function parseObsidianPathList(output) {
  const text = String(output ?? "").trim();
  if (!text || /^No .* found\./i.test(text)) return [];
  if (text.startsWith("[") || text.startsWith("{")) {
    try {
      return collectPathsFromJson(JSON.parse(text));
    } catch {
      // Fall back to line parsing below.
    }
  }
  return text
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\t|,/)[0]?.trim())
    .filter(Boolean)
    .filter((line) => !/^No .* found\./i.test(line));
}

function collectPathsFromJson(value) {
  if (Array.isArray(value)) return value.flatMap((item) => collectPathsFromJson(item));
  if (!value || typeof value !== "object") return [];
  const direct = [value.path, value.file, value.source, value.sourcePath, value.target, value.targetPath]
    .filter((item) => typeof item === "string");
  return [
    ...direct,
    ...Object.values(value).flatMap((item) => collectPathsFromJson(item)),
  ];
}

async function judgePipelineCandidates(args, sourceText, candidates) {
  const candidateInputs = [];
  const excerptWarnings = [];
  for (const candidate of candidates) {
    const excerpt = await readPipelineCandidateExcerpt(args, candidate);
    if (!excerpt) {
      excerptWarnings.push(`Could not read a vault-contained excerpt for ${candidate.notePath}; relation judging skipped this candidate.`);
      continue;
    }
    candidateInputs.push({
      notePath: candidate.notePath,
      noteTitle: candidate.noteTitle,
      retrievalHit: candidate.hit,
      retrievalWhy: candidate.why,
      excerpt: compactLine(excerpt, 1400),
    });
  }

  if (candidateInputs.length === 0) {
    return {
      ok: false,
      reviewedCount: 0,
      reviewedCandidates: [],
      warnings: excerptWarnings,
      message: "Aha Relation Judge had no vault-contained excerpts.",
      tool: "qmd",
      error: "No vault-contained excerpts were readable after the vault realpath boundary check, so Relation Judge did not run.",
      errorCategory: "empty_candidates",
      candidates,
    };
  }

  const result = await judgeCandidateRelations({
    sourcePath: args.sourcePath,
    sourceText,
    candidates,
    candidateInputs,
    adapterName: llmToolName(args),
    preserveOrder: true,
    adapter: async ({ prompt, outputFileName, timeoutMs }) => {
      const llmOutput = await runLlm(args, prompt, {
        schemaPath: path.join(args.workspace, "scripts/aha/aha-result.schema.json"),
        outputFileName,
        timeoutMs: Math.min(Number(args.timeoutMs || 300_000), timeoutMs),
        openAiPerAttemptTimeoutMs: Number(timeoutMs),
        openAiTotalTimeoutMs: Number(args.timeoutMs || 300_000),
        sandbox: "read-only",
        isolateCwd: true,
        ignoreRules: true,
        skipGitRepoCheck: true,
        transportStage: "relation_judge",
      });
      if (llmOutput.code !== 0) {
        throw new Error(firstLine(llmOutput.stderr || llmOutput.stdout) || `${llmDisplayName(args)} exited ${llmOutput.code}`);
      }
      return extractCodexJson(llmOutput.stdout);
    },
  });
  return {
    ...result,
    errorCategory: result.ok ? null : openAiTransportCategory({ message: result.error }),
    reviewedCandidates: candidateInputs.map((candidate) => ({
      notePath: candidate.notePath,
      noteTitle: candidate.noteTitle,
    })),
    warnings: [
      ...excerptWarnings,
      ...(result.warnings ?? []),
    ],
  };
}

async function generateQueryPlan(args, sourceText) {
  return generateQueryPlanWithAdapter({
    sourcePath: args.sourcePath,
    sourceText,
    primaryName: llmToolName(args),
    fallbackName: "codex",
    displayName: llmDisplayName(args),
    adapter: queryPlanAdapter(args),
    fallbackAdapter: args.llmProvider === "openai" ? queryPlanAdapter({ ...args, llmProvider: "codex-cli" }) : null,
  });
}

function queryPlanAdapter(args) {
  return async ({ prompt, outputFileName, timeoutMs }) => {
    const llmOutput = await runLlm(args, prompt, {
      schemaPath: path.join(args.workspace, "scripts/aha/aha-query-plan.schema.json"),
      outputFileName,
      timeoutMs: Math.min(Number(args.timeoutMs || 300_000), timeoutMs),
      openAiPerAttemptTimeoutMs: Number(timeoutMs),
      openAiTotalTimeoutMs: Number(args.timeoutMs || 300_000),
      sandbox: "read-only",
      isolateCwd: true,
      ignoreRules: true,
      skipGitRepoCheck: true,
      transportStage: "query_generation",
    });
    if (llmOutput.code !== 0) {
      throw new Error(firstLine(llmOutput.stderr || llmOutput.stdout) || `${llmDisplayName(args)} exited ${llmOutput.code}`);
    }
    return extractCodexJson(llmOutput.stdout);
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

  const result = await runCommand(args.qmdCommand, commandArgs, { cwd: args.workspace, timeoutMs: options.timeoutMs });

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

async function runQmdPlanQueries(args, queries) {
  const settled = [];
  for (const query of queries) {
    try {
      settled.push({ ok: true, result: await runQmdPlanQuery(args, query) });
    } catch (error) {
      const failure = `${query.kind}/${query.command}: ${error.message}`;
      settled.push({ ok: false, error: failure, result: { query, rows: [], errors: [failure] } });
    }
  }
  return {
    queryResults: settled.map((item) => item.result),
    warnings: settled.filter((item) => item.ok && item.result.warning).map((item) => item.result.warning),
    errors: settled.filter((item) => !item.ok).map((item) => item.error),
  };
}

async function rerankPipelineCandidates(args, queryResults) {
  const byPath = new Map();
  for (const queryResult of queryResults) {
    for (const [index, row] of queryResult.rows.entries()) {
      const notePath = notePathForObsidian(args, row);
      if (!(await isCandidatePathAllowed(args, notePath, row))) continue;
      if (isSourceCandidate(args, notePath, row)) continue;
      if (isGeneratedReviewCandidate(args, notePath, row)) continue;
      if (isExcludedCandidatePath(notePath)) continue;
      const existing = byPath.get(notePath) ?? {
        notePath,
        noteTitle: typeof row.title === "string" && row.title.trim()
          ? row.title.trim()
          : path.basename(notePath, ".md"),
        hit: firstSnippetLine(row.snippet) || `QMD score ${row.score ?? "unknown"}`,
        bestScore: 0,
        rankScore: 0,
        queryKinds: new Set(),
        commands: new Set(),
        rawLocations: new Set(),
        sources: [],
      };
      const score = Number(row.score ?? 0);
      existing.bestScore = Math.max(existing.bestScore, Number.isFinite(score) ? score : 0);
      existing.rankScore += 1 / (index + 1);
      existing.queryKinds.add(queryResult.query.kind);
      existing.commands.add(queryResult.query.command);
      for (const location of [row.file, row.path, row.uri]) {
        if (typeof location === "string" && location.trim()) existing.rawLocations.add(location.trim());
      }
      existing.sources.push({
        kind: queryResult.query.kind,
        command: queryResult.query.command,
        rank: index + 1,
        score: Number.isFinite(score) ? score : null,
      });
      byPath.set(notePath, existing);
    }
  }

  return [...byPath.values()]
    .map((candidate) => {
      const diversity = candidate.queryKinds.size * 0.12 + candidate.commands.size * 0.04;
      return {
        ...candidate,
        finalScore: candidate.bestScore + candidate.rankScore * 0.18 + diversity,
      };
    })
    .sort((a, b) => b.finalScore - a.finalScore);
}

function pipelineCandidate(candidate) {
  const kinds = [...candidate.queryKinds].filter(Boolean);
  const commands = [...candidate.commands].filter(Boolean);
  const strongest = candidate.sources
    .slice()
    .sort((a, b) => (a.rank ?? 999) - (b.rank ?? 999))
    .slice(0, 3)
    .map((source) => `${source.kind}/${source.command}#${source.rank}`)
    .join(", ");
  return {
    notePath: candidate.notePath,
    noteTitle: candidate.noteTitle,
    relation: "weak",
    hit: candidate.hit,
    why: `Mixed QMD retrieval ranked this candidate from ${kinds.length} query kind(s) (${kinds.join(", ")}) via ${commands.join(", ")}. Strongest retrieval signals: ${strongest}. Relation is weak pending quote-backed judging.`,
    quotes: [],
    selected: true,
    _rawLocations: [...candidate.rawLocations],
    _traceScore: candidate.finalScore,
    _traceSources: candidate.sources,
  };
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

async function readPipelineCandidateExcerpt(args, candidate) {
  const raw = String(candidate.notePath ?? "");
  if (!raw) return "";
  const locations = unique([
    ...(Array.isArray(candidate._rawLocations) ? candidate._rawLocations : []),
    raw,
  ]);

  for (const location of locations) {
    if (isObsidianQmdUri(location)) {
      try {
        const filePath = await qmdUriVaultPath(args, location);
        if (filePath) return excerptMarkdown(await readFile(filePath, "utf8"));
      } catch {
        // Try the next plausible location.
      }
      continue;
    }

    try {
      const filePath = await resolveVaultContainedPath(args, location);
      if (filePath) return excerptMarkdown(await readFile(filePath, "utf8"));
    } catch {
      // Try the next plausible path.
    }
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

async function isCandidatePathAllowed(args, notePath, row) {
  const rawLocations = [row.file, row.path, row.uri]
    .filter((value) => typeof value === "string")
    .map((value) => value.trim())
    .filter(Boolean);
  if (rawLocations.length === 0) {
    return Boolean(await resolveVaultContainedPath(args, notePath).catch(() => ""));
  }

  for (const location of rawLocations) {
    if (isObsidianQmdUri(location)) {
      if (await qmdUriVaultPath(args, location).catch(() => "")) return true;
      continue;
    }
    if (await resolveVaultContainedPath(args, location).catch(() => "")) return true;
  }
  return false;
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

function stripInternalCandidateFields(candidate) {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return candidate;
  const { _rawLocations, _traceScore, _traceSources, ...publicCandidate } = candidate;
  return publicCandidate;
}

function excerptMarkdown(markdown) {
  return excerptNoteMarkdown(markdown);
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
      "Fallback candidates are direct QMD recall results. Relation labels are weak unless later judged by Codex.",
    ],
    candidates,
  };
}

function relationJudgeFailureFromRows(args, rows, reason, tool = "codex") {
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
    why: "Direct QMD recall surfaced this note as a candidate; relation is marked weak pending Codex judging.",
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

function isSourceCandidate(args, notePath, row) {
  if (sameNotePath(notePath, args.sourcePath)) return true;
  const rawPaths = [row.file, row.path, row.uri]
    .filter((value) => typeof value === "string")
    .map((value) => value.trim());
  return rawPaths.some((value) => {
    if (sameNotePath(notePathForObsidian(args, { file: value }), args.sourcePath)) return true;
    if (path.isAbsolute(value) && args.sourceAbsolutePath && path.resolve(value) === path.resolve(args.sourceAbsolutePath)) return true;
    return false;
  });
}

function isGeneratedReviewCandidate(args, notePath, row) {
  const rawPaths = [notePath, row.file, row.path, row.uri]
    .filter((value) => typeof value === "string")
    .map((value) => notePathForObsidian(args, { file: value.trim() }));
  if (args.reviewPath && rawPaths.some((value) => sameNotePath(value, args.reviewPath))) return true;
  return rawPaths.some((value) => {
    const normalized = normalizeNoteIdentity(value);
    return normalized === "aha/reviews" || normalized.startsWith("aha/reviews/");
  });
}

function extractCodexJson(stdout) {
  const trimmed = stdout.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    return JSON.parse(trimmed);
  }

  const begin = stdout.indexOf(JSON_BEGIN);
  const end = stdout.lastIndexOf(JSON_END);
  if (begin === -1 || end === -1 || end <= begin) {
    throw new Error("Codex output did not include AHA_RESULT_JSON markers.");
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
      env: process.env,
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
    codexCommand: "codex",
    codexModel: "gpt-5.3-codex-spark",
    codexReasoningEffort: "low",
    codexSandbox: "danger-full-access",
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
    retrievalPolicy: DEFAULT_RETRIEVAL_POLICY_ID,
    qmdRerank: false,
    qmdQueryTimeoutMs: DEFAULT_QMD_QUERY_TIMEOUT_MS,
    qmdRunner: DEFAULT_QMD_RUNNER,
    qmdSdkModule: "",
    sourceAbsolutePath: "",
    sourcePath: "",
    strategy: "pipeline",
    targetCandidates: 20,
    thought: "",
    timeoutMs: 900_000,
    trace: false,
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
      case "--codex-command":
        args.codexCommand = next();
        break;
      case "--codex-model":
        args.codexModel = next();
        break;
      case "--codex-reasoning-effort":
        args.codexReasoningEffort = next();
        break;
      case "--codex-sandbox":
        args.codexSandbox = next();
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
      case "--retrieval-policy":
        args.retrievalPolicy = next();
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
      case "--thought":
        args.thought = next();
        break;
      case "--trace":
        args.trace = true;
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
  retrievalPolicyById(args.retrievalPolicy);
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

function positiveTimeoutMs(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.max(1, Math.floor(parsed)) : fallback;
}

function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(path.resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
  }
}

function emitJson(value, exitCode = 0) {
  process.exitCode = exitCode;
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
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
