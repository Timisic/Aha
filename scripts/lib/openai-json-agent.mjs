import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { httpsProxyUrlFor } from "./https-proxy.mjs";

export const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
export const DEFAULT_OPENAI_MODEL = "gpt-5.5";
export const DEFAULT_OPENAI_API_KEY_ENV = "OPENAI_API_KEY";
export const DEFAULT_OPENAI_MAX_ATTEMPTS = 3;

const RETRY_BACKOFF_MS = [500, 1500];

export function runOpenAiJsonSync(options) {
  const apiKeyEnv = String(options.apiKeyEnv || DEFAULT_OPENAI_API_KEY_ENV).trim() || DEFAULT_OPENAI_API_KEY_ENV;
  const apiKey = process.env[apiKeyEnv];
  if (!apiKey) throw new Error(`${apiKeyEnv} is not set.`);

  const schema = options.schema;
  const body = {
    model: String(options.model || DEFAULT_OPENAI_MODEL).trim() || DEFAULT_OPENAI_MODEL,
    input: String(options.prompt ?? ""),
  };
  if (schema) {
    body.text = {
      format: {
        type: "json_schema",
        name: schemaName(options.schemaName),
        schema,
        strict: true,
      },
    };
  }

  const url = openAiResponsesUrl(options.baseUrl);
  const proxyUrl = httpsProxyUrlFor(url);
  const maxAttempts = Math.max(1, Number(options.maxAttempts || DEFAULT_OPENAI_MAX_ATTEMPTS));

  const tmpRoot = mkdtempSync(join(tmpdir(), "aha-openai-json-agent-"));
  const bodyPath = join(tmpRoot, "request.json");
  try {
    writeFileSync(bodyPath, `${JSON.stringify(body)}\n`);
    let lastFailure = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const result = spawnSync("curl", [
        "--silent",
        "--show-error",
        "--fail-with-body",
        "--max-time",
        String(Math.max(1, Math.ceil(Number(options.timeoutMs || 120_000) / 1000))),
        ...(proxyUrl ? ["--proxy", proxyUrl] : ["--noproxy", "*"]),
        "-X",
        "POST",
        url,
        "-H",
        "Content-Type: application/json",
        "-H",
        `Authorization: Bearer ${apiKey}`,
        "--data-binary",
        `@${bodyPath}`,
      ], {
        encoding: "utf-8",
        timeout: Number(options.timeoutMs || 120_000) + 5_000,
      });
      if (result.error && result.error.code !== "ETIMEDOUT") throw result.error;
      if (!result.error && result.status === 0) {
        const payload = JSON.parse(String(result.stdout || "{}"));
        return extractOpenAiOutputText(payload);
      }
      const stderr = String(result.stderr ?? "").trim();
      const stdout = String(result.stdout ?? "").trim();
      lastFailure = result.error?.message
        || stderr
        || stdout
        || `OpenAI API exited with ${result.status}`;
      if (!shouldRetryCurlFailure(result)) break;
      if (attempt < maxAttempts) {
        const backoff = RETRY_BACKOFF_MS[Math.min(attempt - 1, RETRY_BACKOFF_MS.length - 1)];
        sleepSync(backoff);
      }
    }
    throw new Error(`${lastFailure} (after ${maxAttempts} attempt${maxAttempts > 1 ? "s" : ""}${proxyUrl ? `, proxy ${proxyUrl}` : ", no proxy"})`);
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
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
