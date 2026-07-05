import assert from "node:assert/strict";
import test from "node:test";

import { shouldRetryCurlFailure } from "../../lib/openai-json-agent.mjs";

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
