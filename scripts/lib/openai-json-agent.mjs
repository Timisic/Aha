import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleepAsync } from "node:timers/promises";
import { httpsProxyUrlFor } from "./https-proxy.mjs";

export const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
export const DEFAULT_OPENAI_MODEL = "gpt-5.5";
export const DEFAULT_OPENAI_API_KEY_ENV = "OPENAI_API_KEY";
export const DEFAULT_OPENAI_MAX_ATTEMPTS = 3;
export const DEFAULT_OPENAI_MAX_OUTPUT_BYTES = 5 * 1024 * 1024;

const RETRY_BACKOFF_MS = [500, 1500];

export function runOpenAiJsonSync(options) {
  const apiKeyEnv = String(options.apiKeyEnv || DEFAULT_OPENAI_API_KEY_ENV).trim() || DEFAULT_OPENAI_API_KEY_ENV;
  const apiKey = process.env[apiKeyEnv];
  if (!apiKey) throw new Error(`${apiKeyEnv} is not set.`);

  const body = compatibleRequestBody(options);
  const url = compatibleRequestUrl(options);
  const proxyUrl = httpsProxyUrlFor(url);
  const maxAttempts = Math.max(1, Number(options.maxAttempts || DEFAULT_OPENAI_MAX_ATTEMPTS));

  const tmpRoot = mkdtempSync(join(tmpdir(), "aha-openai-json-agent-"));
  const { bodyPath, headerConfigPath } = writeRequestFiles(tmpRoot, body, apiKey, proxyUrl);
  try {
    let lastFailure = null;
    let attemptsMade = 0;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      attemptsMade = attempt;
      const result = spawnSync("curl", curlRequestArgs({ url, proxyUrl, bodyPath, headerConfigPath, timeoutMs: options.timeoutMs }), {
        encoding: "utf-8",
        env: environmentWithout(apiKeyEnv),
        maxBuffer: Number(options.maxOutputBytes || DEFAULT_OPENAI_MAX_OUTPUT_BYTES),
        timeout: Number(options.timeoutMs || 120_000) + 5_000,
      });
      const evaluated = evaluateCurlAttempt(result);
      if (evaluated.kind === "success") return evaluated.outputText;
      if (evaluated.kind === "fatal") throw evaluated.error;
      lastFailure = evaluated.failure;
      if (!evaluated.retryable) break;
      if (attempt < maxAttempts) {
        const backoff = RETRY_BACKOFF_MS[Math.min(attempt - 1, RETRY_BACKOFF_MS.length - 1)];
        sleepSync(backoff);
      }
    }
    throw attemptsExhaustedError(lastFailure, attemptsMade, proxyUrl);
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
}

export async function runOpenAiJsonAsync(options) {
  const apiKeyEnv = String(options.apiKeyEnv || DEFAULT_OPENAI_API_KEY_ENV).trim() || DEFAULT_OPENAI_API_KEY_ENV;
  const apiKey = process.env[apiKeyEnv];
  if (!apiKey) throw new Error(`${apiKeyEnv} is not set.`);

  const body = compatibleRequestBody(options);
  const url = compatibleRequestUrl(options);
  const proxyUrl = httpsProxyUrlFor(url);
  const maxAttempts = Math.max(1, Number(options.maxAttempts || DEFAULT_OPENAI_MAX_ATTEMPTS));

  const tmpRoot = mkdtempSync(join(tmpdir(), "aha-openai-json-agent-"));
  const { bodyPath, headerConfigPath } = writeRequestFiles(tmpRoot, body, apiKey, proxyUrl);
  try {
    let lastFailure = null;
    let attemptsMade = 0;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      attemptsMade = attempt;
      const result = await spawnCurlAsync(
        curlRequestArgs({ url, proxyUrl, bodyPath, headerConfigPath, timeoutMs: options.timeoutMs }),
        Number(options.timeoutMs || 120_000) + 5_000,
        Number(options.maxOutputBytes || DEFAULT_OPENAI_MAX_OUTPUT_BYTES),
        apiKeyEnv,
      );
      const evaluated = evaluateCurlAttempt(result, options.providerName);
      if (evaluated.kind === "success") {
        options.onResponse?.(evaluated.payload);
        return evaluated.outputText;
      }
      if (evaluated.kind === "fatal") throw evaluated.error;
      lastFailure = evaluated.failure;
      if (!evaluated.retryable) break;
      if (attempt < maxAttempts) {
        const backoff = RETRY_BACKOFF_MS[Math.min(attempt - 1, RETRY_BACKOFF_MS.length - 1)];
        await sleepAsync(backoff);
      }
    }
    throw attemptsExhaustedError(lastFailure, attemptsMade, proxyUrl);
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
}

function compatibleRequestBody(options) {
  if (options.protocol === "chat-completions") {
    return {
      model: String(options.model || DEFAULT_OPENAI_MODEL).trim() || DEFAULT_OPENAI_MODEL,
      messages: [{ role: "user", content: String(options.prompt ?? "") }],
      response_format: { type: "json_object" },
      stream: false,
    };
  }
  const body = {
    model: String(options.model || DEFAULT_OPENAI_MODEL).trim() || DEFAULT_OPENAI_MODEL,
    input: String(options.prompt ?? ""),
  };
  if (options.schema) {
    body.text = {
      format: {
        type: "json_schema",
        name: schemaName(options.schemaName),
        schema: options.schema,
        strict: true,
      },
    };
  }
  return body;
}

function compatibleRequestUrl(options) {
  if (options.protocol === "chat-completions") {
    const trimmed = String(options.baseUrl || "").trim().replace(/\/+$/, "");
    return `${trimmed}/chat/completions`;
  }
  return openAiResponsesUrl(options.baseUrl);
}

// The Authorization header travels in a 0600 config file, never on the curl
// command line where any local process could read it from the process list.
function writeRequestFiles(tmpRoot, body, apiKey, proxyUrl) {
  const bodyPath = join(tmpRoot, "request.json");
  const headerConfigPath = join(tmpRoot, "headers.curl");
  writeFileSync(bodyPath, `${JSON.stringify(body)}\n`, { mode: 0o600 });
  const proxyConfig = proxyUrl ? `proxy = "${curlConfigValue(proxyUrl)}"\n` : "";
  writeFileSync(headerConfigPath, `header = "Authorization: Bearer ${curlConfigValue(apiKey)}"\n${proxyConfig}`, { mode: 0o600 });
  return { bodyPath, headerConfigPath };
}

function curlRequestArgs({ url, proxyUrl, bodyPath, headerConfigPath, timeoutMs }) {
  return [
    "--silent",
    "--show-error",
    "--fail-with-body",
    "--max-time",
    String(Math.max(1, Math.ceil(Number(timeoutMs || 120_000) / 1000))),
    ...(proxyUrl ? [] : ["--noproxy", "*"]),
    "-X",
    "POST",
    url,
    "-H",
    "Content-Type: application/json",
    "--config",
    headerConfigPath,
    "--data-binary",
    `@${bodyPath}`,
  ];
}

function evaluateCurlAttempt(result, providerName = "OpenAI") {
  if (result.error && result.error.code !== "ETIMEDOUT") return { kind: "fatal", error: result.error };
  if (!result.error && result.status === 0) {
    let payload;
    try {
      payload = JSON.parse(String(result.stdout || "{}"));
    } catch {
      return {
        kind: "failure",
        failure: `${providerName} API returned a non-JSON body: ${String(result.stdout || "").trim().slice(0, 200)}`,
        retryable: true,
      };
    }
    return { kind: "success", outputText: extractOpenAiOutputText(payload), payload };
  }
  const stdout = String(result.stdout ?? "").trim();
  const stderr = String(result.stderr ?? "").trim();
  const failure = result.status === 22 && stdout
    ? stdout
    : result.error?.message || stderr || stdout || `OpenAI API exited with ${result.status}`;
  return {
    kind: "failure",
    failure: failure.slice(0, 800),
    retryable: shouldRetryCurlFailure(result),
  };
}

function attemptsExhaustedError(lastFailure, maxAttempts, proxyUrl) {
  return new Error(`${lastFailure} (after ${maxAttempts} attempt${maxAttempts > 1 ? "s" : ""}${proxyUrl ? `, proxy ${redactedProxyUrl(proxyUrl)}` : ", no proxy"})`);
}

function spawnCurlAsync(args, killAfterMs, maxOutputBytes, apiKeyEnv) {
  return new Promise((resolvePromise) => {
    const child = spawn("curl", args, { env: environmentWithout(apiKeyEnv), stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill("SIGKILL");
      resolvePromise({ error, status: null, stdout, stderr });
    };
    const timer = setTimeout(() => {
      fail(Object.assign(new Error("curl timed out"), { code: "ETIMEDOUT" }));
    }, killAfterMs);
    child.stdout.on("data", (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxOutputBytes) return fail(Object.assign(new Error(`curl stdout exceeded ${maxOutputBytes} bytes.`), { code: "EOUTPUTLIMIT" }));
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes > maxOutputBytes) return fail(Object.assign(new Error(`curl stderr exceeded ${maxOutputBytes} bytes.`), { code: "EOUTPUTLIMIT" }));
      stderr += chunk;
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({ error, status: null, stdout, stderr });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({ error: null, status: code, stdout, stderr });
    });
  });
}

function environmentWithout(name) {
  const env = { ...process.env };
  if (name) delete env[name];
  return env;
}

function curlConfigValue(value) {
  return String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

export function redactedProxyUrl(proxyUrl) {
  try {
    const parsed = new URL(proxyUrl);
    parsed.username = "";
    parsed.password = "";
    return parsed.href;
  } catch {
    return "configured proxy";
  }
}

export function shouldRetryCurlFailure(result) {
  if (result.error) return result.error.code === "ETIMEDOUT";
  if (result.status === 0) return false;
  // curl exit 22 (--fail-with-body) is an HTTP error: only transient statuses heal on retry.
  if (result.status === 22) {
    const match = String(result.stderr ?? "").match(/returned error:\s*(\d{3})/);
    const httpStatus = match ? Number(match[1]) : 0;
    return httpStatus === 408 || httpStatus === 429 || httpStatus >= 500;
  }
  return true;
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function openAiResponsesUrl(baseUrl) {
  const trimmed = String(baseUrl || DEFAULT_OPENAI_BASE_URL).trim().replace(/\/+$/, "") || DEFAULT_OPENAI_BASE_URL;
  return `${trimmed}/responses`;
}

export function extractOpenAiOutputText(payload) {
  if (typeof payload?.output_text === "string") return payload.output_text.trim();
  const outputParts = Array.isArray(payload?.output) ? payload.output : [];
  const contentText = outputParts
    .flatMap((item) => Array.isArray(item?.content) ? item.content : [])
    .map((content) => {
      if (typeof content?.text === "string") return content.text;
      if (typeof content?.value === "string") return content.value;
      if (typeof content === "string") return content;
      return "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
  if (contentText) return contentText;
  const choiceText = payload?.choices?.[0]?.message?.content;
  if (typeof choiceText === "string") return choiceText.trim();
  throw new Error("OpenAI API response did not include output text.");
}

function schemaName(value) {
  return String(value || "aha_json_agent_schema")
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .slice(0, 64) || "aha_json_agent_schema";
}
