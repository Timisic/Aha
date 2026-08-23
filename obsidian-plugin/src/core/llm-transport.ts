// Shared LLM JSON-call transport (ADR 0005, issue #55). Compiled into both the
// plugin bundle and the standalone core artifact consumed by bench scripts.
//
// This module must stay free of `obsidian` imports, node imports, and
// module-level I/O: the actual HTTP POST and the backoff sleep are injected
// through `LlmTransportDeps`. Request URL and body construction mirror the
// bench-side conventions in scripts/lib/openai-json-agent.mjs (chat-completions
// vs responses protocol); any drift between the two is a bug.

export type LlmProtocol = "chat-completions" | "responses";
export type LlmThinking = "disabled" | "enabled";

export interface LlmJsonCallRequest {
  baseUrl: string;
  apiKey: string;
  model: string;
  protocol: LlmProtocol;
  prompt: string;
  /** JSON schema for the model output. Used only by the responses protocol. */
  schema?: unknown;
  schemaName?: string;
  /** DeepSeek chat-completions thinking control; omitted from the body when unset. */
  thinking?: LlmThinking;
  timeoutMs?: number;
}

export interface LlmJsonCallSuccess {
  ok: true;
  /** The model's JSON output, already parsed. */
  json: unknown;
  attempts: number;
}

export type LlmFailureKind = "network" | "http" | "auth" | "parse" | "config";

export interface LlmJsonCallFailure {
  ok: false;
  /** Human-readable message including the attempt count. */
  error: string;
  attempts: number;
  kind: LlmFailureKind;
  /** HTTP status of the last failed attempt, when one was received. */
  lastStatus?: number;
}

export type LlmJsonCallResult = LlmJsonCallSuccess | LlmJsonCallFailure;

export interface HttpJsonPostResponse {
  status: number;
  bodyText: string;
}

/**
 * Low-level injected HTTP POST. Resolves for every received HTTP status
 * (including 4xx/5xx) and throws only on network-level failures (DNS, refused
 * connection, timeout, proxy failure).
 */
export type HttpJsonPost = (
  url: string,
  headers: Record<string, string>,
  body: string,
  timeoutMs: number,
) => Promise<HttpJsonPostResponse>;

export interface LlmTransportDeps {
  httpPost: HttpJsonPost;
  sleep: (ms: number) => Promise<void>;
}

/** Backoff before the second and third attempts. */
export const LLM_RETRY_BACKOFF_MS: readonly number[] = [1000, 4000];
/** One initial attempt plus one retry per backoff entry. */
export const LLM_MAX_ATTEMPTS = LLM_RETRY_BACKOFF_MS.length + 1;
export const DEFAULT_LLM_TIMEOUT_MS = 120_000;
export const DEFAULT_LLM_SCHEMA_NAME = "aha_json_agent_schema";

const ERROR_BODY_PREVIEW_LIMIT = 300;

export function llmRequestUrl(request: Pick<LlmJsonCallRequest, "baseUrl" | "protocol">): string {
  const base = request.baseUrl.trim().replace(/\/+$/, "");
  return request.protocol === "chat-completions" ? `${base}/chat/completions` : `${base}/responses`;
}

export function llmRequestBody(request: LlmJsonCallRequest): Record<string, unknown> {
  if (request.protocol === "chat-completions") {
    const body: Record<string, unknown> = {
      model: request.model,
      messages: [{ role: "user", content: request.prompt }],
      response_format: { type: "json_object" },
      stream: false,
    };
    if (request.thinking === "disabled" || request.thinking === "enabled") {
      body.thinking = { type: request.thinking };
    }
    return body;
  }
  const body: Record<string, unknown> = {
    model: request.model,
    input: request.prompt,
  };
  if (request.schema) {
    body.text = {
      format: {
        type: "json_schema",
        name: sanitizedLlmSchemaName(request.schemaName),
        schema: request.schema,
        strict: true,
      },
    };
  }
  return body;
}

// Mirrors schemaName() in scripts/lib/openai-json-agent.mjs: the default is
// substituted before sanitizing, so a name that sanitizes to "_" stays "_".
export function sanitizedLlmSchemaName(value: string | undefined): string {
  return (value || DEFAULT_LLM_SCHEMA_NAME)
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .slice(0, 64) || DEFAULT_LLM_SCHEMA_NAME;
}

/**
 * Extracts the model's output text from a provider response envelope. Mirrors
 * extractOpenAiOutputText in scripts/lib/openai-json-agent.mjs, but returns
 * null instead of throwing when no output text is present.
 */
export function extractLlmOutputText(payload: unknown): string | null {
  const envelope = payload as {
    output_text?: unknown;
    output?: unknown;
    choices?: Array<{ message?: { content?: unknown } }>;
  } | null | undefined;
  if (typeof envelope?.output_text === "string") return envelope.output_text.trim();
  const outputParts = Array.isArray(envelope?.output) ? envelope.output : [];
  const contentText = outputParts
    .flatMap((item: { content?: unknown }) => Array.isArray(item?.content) ? item.content : [])
    .map((content: { text?: unknown; value?: unknown } | string) => {
      if (typeof content === "string") return content;
      if (typeof content?.text === "string") return content.text;
      if (typeof content?.value === "string") return content.value;
      return "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
  if (contentText) return contentText;
  const choiceText = envelope?.choices?.[0]?.message?.content;
  if (typeof choiceText === "string") return choiceText.trim();
  return null;
}

interface AttemptFailure {
  kind: LlmFailureKind;
  detail: string;
  status?: number;
}

/**
 * One JSON call against an OpenAI-compatible endpoint with the agreed retry
 * policy: up to LLM_MAX_ATTEMPTS attempts, retrying only thrown network errors
 * and HTTP 408/429/5xx, with LLM_RETRY_BACKOFF_MS waits between attempts.
 * Never throws; every outcome is a structured result with an attempt count.
 */
export async function llmJsonCall(request: LlmJsonCallRequest, deps: LlmTransportDeps): Promise<LlmJsonCallResult> {
  const url = llmRequestUrl(request);
  const body = JSON.stringify(llmRequestBody(request));
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${request.apiKey}`,
  };
  const timeoutMs = request.timeoutMs ?? DEFAULT_LLM_TIMEOUT_MS;

  let lastFailure: AttemptFailure = { kind: "network", detail: "no attempt was made" };
  let attempts = 0;
  for (let attempt = 1; attempt <= LLM_MAX_ATTEMPTS; attempt += 1) {
    attempts = attempt;
    let response: HttpJsonPostResponse;
    try {
      response = await deps.httpPost(url, headers, body, timeoutMs);
    } catch (error) {
      lastFailure = { kind: "network", detail: `network error: ${errorMessage(error)}` };
      if (attempt < LLM_MAX_ATTEMPTS) await deps.sleep(LLM_RETRY_BACKOFF_MS[attempt - 1]);
      continue;
    }
    if (response.status >= 200 && response.status < 300) {
      const parsed = successfulResponseResult(response.bodyText, attempt);
      if (parsed.ok || parsed.kind !== "parse" || attempt >= LLM_MAX_ATTEMPTS) return parsed;
      lastFailure = { kind: "parse", detail: parsed.error };
      await deps.sleep(LLM_RETRY_BACKOFF_MS[attempt - 1]);
      continue;
    }
    lastFailure = {
      kind: response.status === 401 || response.status === 403 ? "auth" : "http",
      status: response.status,
      detail: `HTTP ${response.status} ${bodyPreview(response.bodyText)}`.trim(),
    };
    if (!retryableLlmHttpStatus(response.status)) break;
    if (attempt < LLM_MAX_ATTEMPTS) await deps.sleep(LLM_RETRY_BACKOFF_MS[attempt - 1]);
  }

  const failure: LlmJsonCallFailure = {
    ok: false,
    kind: lastFailure.kind,
    attempts,
    error: failureMessage(lastFailure.detail, attempts),
  };
  if (lastFailure.status !== undefined) failure.lastStatus = lastFailure.status;
  return failure;
}

export function retryableLlmHttpStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function successfulResponseResult(bodyText: string, attempts: number): LlmJsonCallResult {
  let envelope: unknown;
  try {
    envelope = JSON.parse(bodyText);
  } catch {
    return parseFailure(`provider returned a non-JSON body: ${bodyPreview(bodyText)}`, attempts);
  }
  const outputText = extractLlmOutputText(envelope);
  if (outputText === null) {
    return parseFailure("provider response did not include output text", attempts);
  }
  try {
    return { ok: true, json: JSON.parse(outputText), attempts };
  } catch {
    return parseFailure(`model output is not valid JSON: ${bodyPreview(outputText)}`, attempts);
  }
}

function parseFailure(detail: string, attempts: number): LlmJsonCallFailure {
  return { ok: false, kind: "parse", attempts, error: failureMessage(detail, attempts) };
}

function failureMessage(detail: string, attempts: number): string {
  return `LLM call failed after ${attempts} attempt${attempts === 1 ? "" : "s"}: ${detail}`;
}

function bodyPreview(bodyText: string): string {
  return bodyText.replace(/\s+/g, " ").trim().slice(0, ERROR_BODY_PREVIEW_LIMIT);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
