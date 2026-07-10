import assert from "node:assert/strict";
import test from "node:test";

import { shouldRetryCurlFailure } from "../../lib/openai-json-agent.mjs";
import {
  isRetryableOpenAiTransportError,
  normalizeOpenAiAttemptFragment,
  normalizeOpenAiTransportStats,
  openAiTransportCategory,
  wrapOpenAiCurlFallbackError,
} from "../../lib/openai-transport.mjs";

test("transport-level curl failures are retryable", () => {
  assert.equal(shouldRetryCurlFailure({ status: 35, stderr: "curl: (35) LibreSSL SSL_connect: SSL_ERROR_SYSCALL" }), true);
  assert.equal(shouldRetryCurlFailure({ status: 28, stderr: "curl: (28) Operation timed out" }), true);
  assert.equal(shouldRetryCurlFailure({ status: 60, stderr: "curl: (60) SSL certificate problem" }), true);
  assert.equal(shouldRetryCurlFailure({ error: { code: "ETIMEDOUT" }, status: null }), true);
});

test("http errors only retry on transient statuses", () => {
  assert.equal(shouldRetryCurlFailure({ status: 22, stderr: "curl: (22) The requested URL returned error: 500" }), true);
  assert.equal(shouldRetryCurlFailure({ status: 22, stderr: "curl: (22) The requested URL returned error: 429" }), true);
  assert.equal(shouldRetryCurlFailure({ status: 22, stderr: "curl: (22) The requested URL returned error: 401" }), false);
  assert.equal(shouldRetryCurlFailure({ status: 22, stderr: "curl: (22) The requested URL returned error: 404" }), false);
});

test("success and non-timeout spawn errors are not retryable", () => {
  assert.equal(shouldRetryCurlFailure({ status: 0, stderr: "" }), false);
  assert.equal(shouldRetryCurlFailure({ error: { code: "ENOENT" }, status: null }), false);
});

test("curl fallback wrapping preserves and classifies the original Node transport code", () => {
  const nodeError = Object.assign(new Error("getaddrinfo failed"), { code: "EAI_AGAIN" });
  const curlError = new Error("curl fallback failed");
  const wrapped = wrapOpenAiCurlFallbackError(nodeError, curlError);

  assert.equal(wrapped.nodeErrorCode, "EAI_AGAIN");
  assert.equal(isRetryableOpenAiTransportError(wrapped), true);
  assert.equal(openAiTransportCategory(wrapped), "transport");
  assert.ok(!wrapped.message.includes("getaddrinfo"));
});

test("final OpenAI transport stats reject impossible counts while attempt fragments stay explicit", () => {
  assert.deepEqual(normalizeOpenAiAttemptFragment({
    attempt_count: 2,
    retry_count: 1,
    retry_categories: { transport: 1 },
  }), {
    request_count: 0,
    attempt_count: 2,
    retry_count: 1,
    retry_categories: { transport: 1 },
  });
  assert.throws(
    () => normalizeOpenAiTransportStats({
      request_count: 1,
      attempt_count: 3,
      retry_count: 0,
      retry_categories: {},
    }),
    /request_count \+ retry_count must equal attempt_count/i,
  );
  assert.throws(
    () => normalizeOpenAiTransportStats({
      request_count: 1,
      attempt_count: 3,
      retry_count: 2,
      retry_categories: { http_5xx: 1 },
    }),
    /retry category total must equal retry_count/i,
  );
});
