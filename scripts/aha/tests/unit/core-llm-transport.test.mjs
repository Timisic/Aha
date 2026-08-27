// Tests for the shared-core LLM JSON-call transport (ADR 0005, issue #55).
//
// The compiled core artifact is never committed, so this test rebuilds it the
// same way scripts/lib/core-artifact.mjs does (which we intentionally do not
// edit here) and imports obsidian-plugin/dist/core.mjs directly. Transport
// effects are all injected: a recording fake httpPost plus a recording fake
// sleep, so retries and backoff delays are asserted without real time or
// network.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const repoRoot = path.resolve(import.meta.dirname, "..", "..", "..", "..");
const pluginDir = path.join(repoRoot, "obsidian-plugin");
const artifactPath = path.join(pluginDir, "dist", "core.mjs");

const build = spawnSync(process.execPath, ["esbuild.config.mjs", "core"], {
  cwd: pluginDir,
  encoding: "utf-8",
});
if (build.error) {
  throw new Error(`core artifact build failed to spawn: ${build.error.message}`);
}
if (build.status !== 0) {
  throw new Error(`core artifact build failed (exit ${build.status}):\n${build.stdout ?? ""}${build.stderr ?? ""}`);
}

const core = await import(pathToFileURL(artifactPath).href);
const { llmJsonCall, LLM_RETRY_BACKOFF_MS, LLM_MAX_ATTEMPTS, DEFAULT_LLM_TIMEOUT_MS } = core;

// Each entry in `script` is either an Error (thrown as a network failure) or a
// { status, bodyText } response. The last entry repeats if attempts run past
// the end of the script.
function fakeDeps(script) {
  const calls = [];
  const sleeps = [];
  let index = 0;
  return {
    calls,
    sleeps,
    deps: {
      httpPost: async (url, headers, body, timeoutMs) => {
        calls.push({ url, headers, body: JSON.parse(body), timeoutMs });
        const step = script[Math.min(index, script.length - 1)];
        index += 1;
        if (step instanceof Error) throw step;
        return step;
      },
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    },
  };
}

const chatEnvelope = (json) => ({
  status: 200,
  bodyText: JSON.stringify({ choices: [{ message: { content: JSON.stringify(json) } }] }),
});
const responsesEnvelope = (json) => ({
  status: 200,
  bodyText: JSON.stringify({ output_text: JSON.stringify(json) }),
});

const chatRequest = (overrides = {}) => ({
  baseUrl: "https://api.deepseek.com",
  apiKey: "sk-deepseek-test",
  model: "deepseek-v4-pro",
  protocol: "chat-completions",
  prompt: "Return {\"ok\":true}",
  thinking: "disabled",
  ...overrides,
});
const responsesRequest = (overrides = {}) => ({
  baseUrl: "https://api.openai.com/v1/",
  apiKey: "sk-openai-test",
  model: "gpt-5.5",
  protocol: "responses",
  prompt: "Return {\"ok\":true}",
  ...overrides,
});

test("retry constants: two backoffs of 1s and 4s, three attempts total", () => {
  assert.deepEqual([...LLM_RETRY_BACKOFF_MS], [1000, 4000]);
  assert.equal(LLM_MAX_ATTEMPTS, 3);
});

test("success on the first attempt reports attempts 1 and never sleeps", async () => {
  const { deps, calls, sleeps } = fakeDeps([responsesEnvelope({ ok: true, n: 7 })]);
  const result = await llmJsonCall(responsesRequest(), deps);
  assert.deepEqual(result, { ok: true, json: { ok: true, n: 7 }, attempts: 1 });
  assert.equal(calls.length, 1);
  assert.deepEqual(sleeps, []);
});

test("network error then success reports attempts 2 with one backoff", async () => {
  const { deps, calls, sleeps } = fakeDeps([
    new Error("socket hang up"),
    responsesEnvelope({ ok: true }),
  ]);
  const result = await llmJsonCall(responsesRequest(), deps);
  assert.equal(result.ok, true);
  assert.equal(result.attempts, 2);
  assert.equal(calls.length, 2);
  assert.deepEqual(sleeps, [1000]);
});

test("429 then 500 then success reports attempts 3 with both backoffs", async () => {
  const { deps, calls, sleeps } = fakeDeps([
    { status: 429, bodyText: '{"error":"rate limited"}' },
    { status: 500, bodyText: "internal error" },
    chatEnvelope({ ok: true }),
  ]);
  const result = await llmJsonCall(chatRequest(), deps);
  assert.equal(result.ok, true);
  assert.equal(result.attempts, 3);
  assert.equal(calls.length, 3);
  assert.deepEqual(sleeps, [1000, 4000]);
});

test("persistent 429 fails after 3 attempts with status and count in the message", async () => {
  const { deps, calls, sleeps } = fakeDeps([
    { status: 429, bodyText: '{"error":{"message":"rate limited"}}' },
  ]);
  const result = await llmJsonCall(chatRequest(), deps);
  assert.equal(result.ok, false);
  assert.equal(result.attempts, 3);
  assert.equal(result.kind, "http");
  assert.equal(result.lastStatus, 429);
  assert.match(result.error, /after 3 attempts/);
  assert.match(result.error, /HTTP 429/);
  assert.match(result.error, /rate limited/);
  assert.equal(calls.length, 3);
  assert.deepEqual(sleeps, [1000, 4000]);
});

test("persistent network errors fail after 3 attempts with kind network", async () => {
  const { deps, calls, sleeps } = fakeDeps([new Error("getaddrinfo ENOTFOUND api.example")]);
  const result = await llmJsonCall(responsesRequest(), deps);
  assert.equal(result.ok, false);
  assert.equal(result.attempts, 3);
  assert.equal(result.kind, "network");
  assert.equal(result.lastStatus, undefined);
  assert.match(result.error, /after 3 attempts/);
  assert.match(result.error, /ENOTFOUND/);
  assert.equal(calls.length, 3);
  assert.deepEqual(sleeps, [1000, 4000]);
});

test("HTTP 400 is not retried and fails with attempts 1", async () => {
  const { deps, calls, sleeps } = fakeDeps([
    { status: 400, bodyText: '{"error":{"message":"bad request"}}' },
  ]);
  const result = await llmJsonCall(responsesRequest(), deps);
  assert.equal(result.ok, false);
  assert.equal(result.attempts, 1);
  assert.equal(result.kind, "http");
  assert.equal(result.lastStatus, 400);
  assert.match(result.error, /after 1 attempt:/);
  assert.match(result.error, /HTTP 400/);
  assert.equal(calls.length, 1);
  assert.deepEqual(sleeps, []);
});

test("HTTP 401 is not retried and fails immediately with kind auth", async () => {
  const { deps, calls, sleeps } = fakeDeps([
    { status: 401, bodyText: '{"error":{"message":"invalid api key"}}' },
  ]);
  const result = await llmJsonCall(responsesRequest(), deps);
  assert.equal(result.ok, false);
  assert.equal(result.attempts, 1);
  assert.equal(result.kind, "auth");
  assert.equal(result.lastStatus, 401);
  assert.equal(calls.length, 1);
  assert.deepEqual(sleeps, []);
});

test("HTTP 408 is retryable like 429 and 5xx", async () => {
  const { deps, calls, sleeps } = fakeDeps([
    { status: 408, bodyText: "request timeout" },
    responsesEnvelope({ ok: true }),
  ]);
  const result = await llmJsonCall(responsesRequest(), deps);
  assert.equal(result.ok, true);
  assert.equal(result.attempts, 2);
  assert.equal(calls.length, 2);
  assert.deepEqual(sleeps, [1000]);
});

test("chat-completions request builds the DeepSeek-compatible URL, body, and auth header", async () => {
  const { deps, calls } = fakeDeps([chatEnvelope({ ok: true })]);
  // A schema passed under chat-completions must not leak into the body; that
  // protocol carries response_format json_object instead (bench parity).
  await llmJsonCall(chatRequest({ schema: { type: "object" } }), deps);
  const call = calls[0];
  assert.equal(call.url, "https://api.deepseek.com/chat/completions");
  assert.equal(call.headers.Authorization, "Bearer sk-deepseek-test");
  assert.equal(call.headers["Content-Type"], "application/json");
  assert.deepEqual(call.body.messages, [{ role: "user", content: "Return {\"ok\":true}" }]);
  assert.deepEqual(call.body.response_format, { type: "json_object" });
  assert.equal(call.body.stream, false);
  assert.deepEqual(call.body.thinking, { type: "disabled" });
  assert.equal(call.body.text, undefined);
  assert.equal(call.body.input, undefined);
});

test("chat-completions body omits thinking when the flag is unset", async () => {
  const { deps, calls } = fakeDeps([chatEnvelope({ ok: true })]);
  await llmJsonCall(chatRequest({ thinking: undefined }), deps);
  assert.equal(calls[0].body.thinking, undefined);
});

test("responses request builds the OpenAI URL and strict json_schema body", async () => {
  const { deps, calls } = fakeDeps([responsesEnvelope({ ok: true })]);
  const schema = { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } };
  await llmJsonCall(responsesRequest({ schema, schemaName: "aha result.schema" }), deps);
  const call = calls[0];
  assert.equal(call.url, "https://api.openai.com/v1/responses");
  assert.equal(call.headers.Authorization, "Bearer sk-openai-test");
  assert.equal(call.body.input, "Return {\"ok\":true}");
  assert.equal(call.body.messages, undefined);
  assert.equal(call.body.response_format, undefined);
  assert.deepEqual(call.body.text, {
    format: {
      type: "json_schema",
      name: "aha_result_schema",
      schema,
      strict: true,
    },
  });
});

test("responses body omits text.format and uses the default schema name rules when no schema is given", async () => {
  const { deps, calls } = fakeDeps([responsesEnvelope({ ok: true })]);
  await llmJsonCall(responsesRequest(), deps);
  assert.equal(calls[0].body.text, undefined);
  assert.equal(core.sanitizedLlmSchemaName(undefined), "aha_json_agent_schema");
  assert.equal(core.sanitizedLlmSchemaName(""), "aha_json_agent_schema");
  // Bench parity: a non-empty name is sanitized, not replaced by the default.
  assert.equal(core.sanitizedLlmSchemaName("!!!"), "_");
});

test("responses envelope with an output array is extracted like output_text", async () => {
  const { deps } = fakeDeps([
    {
      status: 200,
      bodyText: JSON.stringify({ output: [{ content: [{ text: '{"via":"output-array"}' }] }] }),
    },
  ]);
  const result = await llmJsonCall(responsesRequest(), deps);
  assert.deepEqual(result, { ok: true, json: { via: "output-array" }, attempts: 1 });
});

test("timeout passes through to httpPost, defaulting to DEFAULT_LLM_TIMEOUT_MS", async () => {
  const custom = fakeDeps([responsesEnvelope({ ok: true })]);
  await llmJsonCall(responsesRequest({ timeoutMs: 60_000 }), custom.deps);
  assert.equal(custom.calls[0].timeoutMs, 60_000);

  const fallback = fakeDeps([responsesEnvelope({ ok: true })]);
  await llmJsonCall(responsesRequest(), fallback.deps);
  assert.equal(fallback.calls[0].timeoutMs, DEFAULT_LLM_TIMEOUT_MS);
});
