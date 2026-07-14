import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { redactedProxyUrl, runOpenAiJsonAsync, shouldRetryCurlFailure } from "../../lib/openai-json-agent.mjs";

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

test("async transport passes the resolved proxy to curl and retries a TLS failure", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "aha-openai-agent-proxy-"));
  const curl = path.join(temp, "curl");
  const calls = path.join(temp, "calls.jsonl");
  const count = path.join(temp, "count.txt");
  const previous = {
    PATH: process.env.PATH,
    HTTPS_PROXY: process.env.HTTPS_PROXY,
    NO_PROXY: process.env.NO_PROXY,
    AHA_TEST_OPENAI_KEY: process.env.AHA_TEST_OPENAI_KEY,
  };

  await writeFile(curl, [
    "#!/usr/bin/env node",
    "import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';",
    `const calls = ${JSON.stringify(calls)};`,
    `const count = ${JSON.stringify(count)};`,
    "const argv = process.argv.slice(2);",
    "const configIndex = argv.indexOf('--config');",
    "const config = configIndex === -1 ? '' : readFileSync(argv[configIndex + 1], 'utf8');",
    "appendFileSync(calls, `${JSON.stringify({ argv, config, keyInEnv: process.env.AHA_TEST_OPENAI_KEY || '' })}\\n`);",
    "const current = existsSync(count) ? Number(readFileSync(count, 'utf8')) : 0;",
    "writeFileSync(count, String(current + 1));",
    "if (current === 0) { process.stderr.write('curl: (35) TLS handshake failed\\n'); process.exit(35); }",
    "process.stdout.write(JSON.stringify({ output_text: '{\"ok\":true}' }));",
    "",
  ].join("\n"));
  await chmod(curl, 0o755);

  process.env.PATH = `${temp}:${previous.PATH ?? ""}`;
  process.env.HTTPS_PROXY = "http://127.0.0.1:7897";
  delete process.env.NO_PROXY;
  process.env.AHA_TEST_OPENAI_KEY = "test-key";
  try {
    const output = await runOpenAiJsonAsync({
      apiKeyEnv: "AHA_TEST_OPENAI_KEY",
      baseUrl: "https://api.openai.test/v1",
      maxAttempts: 2,
      model: "gpt-test",
      prompt: "Return JSON",
      timeoutMs: 1000,
    });
    assert.equal(output, '{"ok":true}');
    const invocations = (await readFile(calls, "utf8")).trim().split(/\r?\n/).map((line) => JSON.parse(line));
    assert.equal(invocations.length, 2);
    for (const invocation of invocations) {
      assert.equal(invocation.argv.includes("--proxy"), false);
      assert.match(invocation.config, /proxy = "http:\/\/127\.0\.0\.1:7897\/"/);
      assert.equal(invocation.keyInEnv, "");
    }
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(temp, { recursive: true, force: true });
  }
});

test("async transport bounds curl output", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "aha-openai-agent-output-limit-"));
  const curl = path.join(temp, "curl");
  const previousPath = process.env.PATH;
  const previousKey = process.env.AHA_TEST_OPENAI_KEY;
  await writeFile(curl, "#!/bin/sh\nprintf '%080d' 0\n");
  await chmod(curl, 0o755);
  process.env.PATH = `${temp}:${previousPath ?? ""}`;
  process.env.AHA_TEST_OPENAI_KEY = "test-key";
  try {
    await assert.rejects(
      runOpenAiJsonAsync({
        apiKeyEnv: "AHA_TEST_OPENAI_KEY",
        baseUrl: "https://api.openai.test/v1",
        maxAttempts: 1,
        maxOutputBytes: 32,
        model: "gpt-test",
        prompt: "Return JSON",
        timeoutMs: 1000,
      }),
      /curl stdout exceeded 32 bytes/,
    );
  } finally {
    process.env.PATH = previousPath;
    if (previousKey === undefined) delete process.env.AHA_TEST_OPENAI_KEY;
    else process.env.AHA_TEST_OPENAI_KEY = previousKey;
    await rm(temp, { recursive: true, force: true });
  }
});

test("proxy diagnostics redact credentials", () => {
  const result = redactedProxyUrl("http://alice:super-secret@127.0.0.1:7897");
  assert.equal(result, "http://127.0.0.1:7897/");
  assert.equal(result.includes("alice"), false);
  assert.equal(result.includes("super-secret"), false);
});
