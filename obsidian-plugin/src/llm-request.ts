// Plugin-side LLM transport adapter (issue #55). Implements the core
// HttpJsonPost seam over Obsidian's requestUrl, which uses the Chromium
// network stack and therefore honors the system proxy — unlike the legacy
// external-process path in process.ts, which stays available while the
// pipeline is internalized.

import { requestUrl } from "obsidian";
import {
  DEFAULT_LLM_TIMEOUT_MS,
  llmJsonCall,
  type HttpJsonPost,
  type LlmJsonCallRequest,
  type LlmJsonCallResult,
  type LlmProtocol,
  type LlmThinking,
} from "./core";
import type { AhaPluginSettings } from "./settings";

export type LlmApiProvider = "openai" | "deepseek";

export interface ProviderConnectionResult {
  ok: boolean;
  provider: string;
  model: string;
  message: string;
}

export interface LlmProviderProfile {
  ok: true;
  label: string;
  model: string;
  request: Pick<LlmJsonCallRequest, "baseUrl" | "apiKey" | "model" | "protocol" | "thinking">;
}

export interface LlmProviderProfileError {
  ok: false;
  label: string;
  model: string;
  error: string;
}

export interface PluginLlmCallOptions {
  /** Override the provider; defaults to settings.llmProvider. */
  provider?: string;
  schemaName?: string;
  timeoutMs?: number;
}

const CONNECTION_CHECK_PROMPT = 'Aha connection check. Return only this JSON object: {"ok":true}';
const CONNECTION_CHECK_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["ok"],
  properties: { ok: { type: "boolean", enum: [true] } },
};
const CONNECTION_CHECK_TIMEOUT_MS = 60_000;

/**
 * HttpJsonPost over Obsidian's requestUrl. requestUrl exposes no timeout
 * parameter, so the injected timeout is accepted for seam compatibility and
 * Chromium's own network timeouts apply. `throw: false` keeps 4xx/5xx as
 * resolved responses; only network-level failures reject.
 */
export const requestUrlHttpPost: HttpJsonPost = async (url, headers, body, _timeoutMs) => {
  const response = await requestUrl({
    url,
    method: "POST",
    contentType: "application/json",
    headers,
    body,
    throw: false,
  });
  return { status: response.status, bodyText: response.text };
};

/**
 * Derives the request profile for a provider from the plugin settings,
 * matching the wrapper conventions: openai uses the responses protocol,
 * deepseek uses chat-completions with thinking disabled. The API key comes
 * from the provider's key field when set, otherwise from the environment
 * variable named in the provider's key-env field (same precedence the legacy
 * process path applied by injecting the direct key into the child env).
 */
export function resolveLlmRequestProfile(settings: AhaPluginSettings, provider: string): LlmProviderProfile | LlmProviderProfileError {
  if (provider !== "openai" && provider !== "deepseek") {
    return {
      ok: false,
      label: provider || "LLM",
      model: settings.llmModel,
      error: "Direct API calls are available for OpenAI and DeepSeek providers.",
    };
  }
  const config = provider === "deepseek"
    ? {
        label: "DeepSeek",
        baseUrl: settings.deepseekBaseUrl,
        model: settings.deepseekModel,
        directKey: settings.deepseekApiKey,
        keyEnv: settings.deepseekApiKeyEnv,
        protocol: "chat-completions" as LlmProtocol,
        thinking: "disabled" as LlmThinking,
      }
    : {
        label: "OpenAI",
        baseUrl: settings.llmBaseUrl,
        model: settings.llmModel,
        directKey: settings.llmApiKey,
        keyEnv: settings.llmApiKeyEnv,
        protocol: "responses" as LlmProtocol,
        thinking: undefined,
      };
  const key = resolveApiKey(config.directKey, config.keyEnv);
  if (!key.ok) {
    return { ok: false, label: config.label, model: config.model, error: key.error };
  }
  return {
    ok: true,
    label: config.label,
    model: config.model,
    request: {
      baseUrl: config.baseUrl,
      apiKey: key.value,
      model: config.model,
      protocol: config.protocol,
      thinking: config.thinking,
    },
  };
}

function resolveApiKey(directKey: string, keyEnvName: string): { ok: true; value: string } | { ok: false; error: string } {
  const direct = (directKey ?? "").trim();
  if (direct) return { ok: true, value: direct };
  const envName = (keyEnvName ?? "").trim();
  if (!envName) return { ok: false, error: "API key environment variable is not configured." };
  const fromEnv = (typeof process === "undefined" ? "" : process.env[envName] ?? "").trim();
  if (fromEnv) return { ok: true, value: fromEnv };
  return { ok: false, error: `${envName} is not set.` };
}

/**
 * JSON call against the configured provider through requestUrl, with the core
 * retry policy. Never throws; configuration problems (unsupported provider,
 * missing key) come back as kind "config" failures with attempts 0.
 */
export async function pluginLlmJsonCall(
  settings: AhaPluginSettings,
  prompt: string,
  schema?: unknown,
  options: PluginLlmCallOptions = {},
): Promise<LlmJsonCallResult> {
  const profile = resolveLlmRequestProfile(settings, options.provider ?? settings.llmProvider);
  if (!profile.ok) {
    return { ok: false, kind: "config", attempts: 0, error: profile.error };
  }
  return llmJsonCall(
    {
      ...profile.request,
      prompt,
      schema,
      schemaName: options.schemaName,
      timeoutMs: options.timeoutMs ?? DEFAULT_LLM_TIMEOUT_MS,
    },
    { httpPost: requestUrlHttpPost, sleep: waitMs },
  );
}

/**
 * Settings-page provider test: sends the same minimal JSON round-trip the
 * legacy wrapper connection check used, but through the requestUrl adapter.
 * Failure messages carry the transport's attempt count.
 */
export async function testProviderConnection(settings: AhaPluginSettings, provider: LlmApiProvider): Promise<ProviderConnectionResult> {
  const profile = resolveLlmRequestProfile(settings, provider);
  if (!profile.ok) {
    return { ok: false, provider, model: profile.model, message: profile.error };
  }
  const result = await pluginLlmJsonCall(settings, CONNECTION_CHECK_PROMPT, CONNECTION_CHECK_SCHEMA, {
    provider,
    schemaName: "aha_connection_check",
    timeoutMs: CONNECTION_CHECK_TIMEOUT_MS,
  });
  if (!result.ok) {
    return { ok: false, provider, model: profile.model, message: result.error };
  }
  const okField = typeof result.json === "object" && result.json !== null
    ? (result.json as Record<string, unknown>).ok
    : undefined;
  if (okField !== true) {
    return { ok: false, provider, model: profile.model, message: "Provider returned an unexpected connection-check payload." };
  }
  return {
    ok: true,
    provider,
    model: profile.model,
    message: `${profile.label} model ${profile.model} is reachable and generated valid JSON.`,
  };
}

function waitMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
