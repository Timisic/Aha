import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";
import { validateAhaResult } from "../../lib/result-validator.mjs";
import { notePathForObsidian, normalizeNoteIdentity, sameNotePath } from "../../lib/note-identity.mjs";

const repoRoot = path.resolve(import.meta.dirname, "../../../..");
const wrapper = path.join(repoRoot, "scripts/aha/run-insight-search.mjs");

test("fixture result passes schema validation", async () => {
  const fixture = JSON.parse(await readFixture("stub-result.json"));
  const validation = validateAhaResult(fixture);
  assert.equal(validation.ok, true, validation.errors.join("; "));
});

test("malformed result is rejected before note rendering", async () => {
  const fixture = JSON.parse(await readFixture("malformed-result.json"));
  const validation = validateAhaResult(fixture);
  assert.equal(validation.ok, false);
  assert.ok(validation.errors.some((error) => error.includes("relation")));
});

test("note identity normalizes qmd uri and Obsidian paths", () => {
  assert.equal(
    notePathForObsidian({}, { uri: "qmd://obsidian/BOOK/FYP%20Draft/Example.md?index=obsidian" }),
    "BOOK/FYP Draft/Example.md",
  );
  assert.equal(
    notePathForObsidian({ vaultRoot: "/vault" }, { file: "/vault/Folder/Note.md" }),
    "Folder/Note.md",
  );
  assert.equal(normalizeNoteIdentity("QMD://obsidian/Folder/Note.md?index=obsidian"), "folder/note");
  assert.equal(sameNotePath("Folder/Note.md", "folder/note"), true);
  assert.equal(sameNotePath("Folder/Note.md", "folder/note", { caseSensitive: true }), false);
});

test("wrapper flushes a large trace-sized JSON result before exiting", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "aha-wrapper-large-output-"));
  const source = path.join(temp, "source.md");
  const fixturePath = path.join(temp, "large-fixture.json");
  const fixture = JSON.parse(await readFixture("stub-result.json"));
  fixture.candidates = Array.from({ length: 20 }, (_, index) => ({
    ...fixture.candidates[index % fixture.candidates.length],
    notePath: `Memory/Large Candidate ${index + 1}.md`,
    noteTitle: `Large Candidate ${index + 1}`,
    hit: `evidence-${index}-${"证据".repeat(2_000)}`,
    why: `reason-${index}-${"理由".repeat(2_000)}`,
  }));
  await writeFile(source, "# Source\n\nA current insight.");
  await writeFile(fixturePath, JSON.stringify(fixture));

  try {
    const result = spawnSync(process.execPath, [
      wrapper,
      "--workspace", repoRoot,
      "--source-path", "source.md",
      "--source-absolute-path", source,
      "--fixture", fixturePath,
    ], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });

    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.candidates.length, 20);
    assert.ok(result.stdout.length > 100_000);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("readiness reports missing DeepSeek key", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "aha-wrapper-deepseek-readiness-"));
  const helper = path.join(temp, "ok-command.mjs");
  await writeOkCommand(helper);

  try {
    const env = { ...process.env };
    delete env.AHA_TEST_DEEPSEEK_KEY;
    const result = spawnSync(process.execPath, [
      wrapper,
      "--check-readiness",
      "--workspace",
      repoRoot,
      "--llm-provider",
      "deepseek",
      "--qmd-runner",
      "cli",
      "--llm-api-key-env",
      "AHA_TEST_DEEPSEEK_KEY",
      "--qmd-command",
      helper,
      "--obsidian-command",
      helper,
    ], { encoding: "utf8", env });

    assert.equal(result.status, 2);
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, false);
    assert.ok(output.checks.some((check) => check.name === "DeepSeek API key" && !check.ok && check.message.includes("AHA_TEST_DEEPSEEK_KEY")));
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("wrapper does not expose the active API key to tool subprocesses", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "aha-wrapper-secret-env-"));
  const helper = path.join(temp, "env-check.mjs");
  await writeFile(helper, [
    "#!/usr/bin/env node",
    "if (process.env.AHA_TEST_DEEPSEEK_KEY) { console.error('API key leaked'); process.exit(9); }",
    "console.log('ok');",
    "",
  ].join("\n"));
  await chmod(helper, 0o755);

  try {
    const result = spawnSync(process.execPath, [
      wrapper,
      "--check-readiness",
      "--workspace", repoRoot,
      "--llm-provider", "deepseek",
      "--llm-api-key-env", "AHA_TEST_DEEPSEEK_KEY",
      "--qmd-runner", "cli",
      "--qmd-command", helper,
      "--obsidian-command", helper,
    ], {
      encoding: "utf8",
      env: { ...process.env, AHA_TEST_DEEPSEEK_KEY: "top-secret" },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, true);
    assert.ok(output.checks.some((check) => check.name === "QMD CLI" && check.ok));
    assert.ok(output.checks.some((check) => check.name === "Obsidian CLI" && check.ok));
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("wrapper defaults to DeepSeek key and QMD SDK readiness", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "aha-wrapper-default-readiness-"));
  const helper = path.join(temp, "ok-command.mjs");
  const sdkModule = path.join(temp, "fake-qmd-sdk.mjs");
  await writeOkCommand(helper);
  await writeFakeQmdSdkModule(sdkModule, path.join(temp, "sdk.log"), { rows: [] });

  try {
    const result = spawnSync(process.execPath, [
      wrapper,
      "--check-readiness",
      "--workspace",
      repoRoot,
      "--llm-api-key-env",
      "AHA_TEST_DEEPSEEK_KEY",
      "--qmd-sdk-module",
      sdkModule,
      "--qmd-command",
      "/definitely/missing/qmd",
      "--obsidian-command",
      helper,
    ], { encoding: "utf8", env: { ...process.env, AHA_TEST_DEEPSEEK_KEY: "test-key" }, timeout: 10000 });

    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, true);
    assert.ok(output.checks.some((check) => check.name === "DeepSeek API key" && check.ok));
    assert.ok(output.checks.some((check) => check.name === "QMD SDK" && check.ok));
    assert.equal(output.checks.some((check) => check.name === "QMD CLI"), false);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("LLM connection check exercises the configured DeepSeek model", async () => {
  const requests = [];
  const server = await startDeepSeekFixtureServer(requests);

  try {
    const result = await spawnNode([
      wrapper,
      "--check-llm-connection",
      "--workspace",
      repoRoot,
      "--llm-provider",
      "deepseek",
      "--llm-base-url",
      server.baseUrl,
      "--llm-model",
      "deepseek-v4-pro",
      "--llm-api-key-env",
      "AHA_TEST_DEEPSEEK_KEY",
    ], { env: withoutProxyEnv({ ...process.env, AHA_TEST_DEEPSEEK_KEY: "deepseek-test-key" }), timeout: 10000 });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.provider, "deepseek");
    assert.equal(output.model, "deepseek-v4-pro");
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, "/chat/completions");
    assert.equal(requests[0].headers.authorization, "Bearer deepseek-test-key");
    assert.equal(requests[0].body.model, "deepseek-v4-pro");
    assert.deepEqual(requests[0].body.thinking, { type: "disabled" });
    assert.deepEqual(requests[0].body.response_format, { type: "json_object" });
    assert.match(requests[0].body.messages[0].content, /connection check/i);
  } finally {
    await server.close();
  }
});

test("pipeline can use DeepSeek chat completions for query planning and relation judging", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "aha-wrapper-deepseek-"));
  const vault = path.join(temp, "vault");
  const source = path.join(vault, "source.md");
  const codex = path.join(temp, "codex-helper.mjs");
  const qmd = path.join(temp, "qmd-helper.mjs");
  const obsidian = path.join(temp, "obsidian-helper.mjs");
  await mkdir(vault, { recursive: true });
  await writeFile(source, "# Source\n\nA current insight with enough text for DeepSeek query planning.");
  await writeSafeCandidate(vault);
  await writePipelineHelpers({ codex, qmd, obsidian, relationJudge: "success" });
  const requests = [];
  const server = await startDeepSeekFixtureServer(requests);

  try {
    const result = await spawnNode([
      wrapper,
      "--workspace",
      repoRoot,
      "--llm-provider",
      "deepseek",
      "--qmd-runner",
      "cli",
      "--source-path",
      "source.md",
      "--source-absolute-path",
      source,
      "--vault-root",
      vault,
      "--llm-base-url",
      server.baseUrl,
      "--llm-model",
      "deepseek-v4-pro",
      "--llm-api-key-env",
      "AHA_TEST_DEEPSEEK_KEY",
      "--qmd-command",
      qmd,
      "--obsidian-command",
      obsidian,
    ], { env: withoutProxyEnv({ ...process.env, AHA_TEST_DEEPSEEK_KEY: "deepseek-test-key" }), timeout: 10000 });

    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.candidates[0].notePath, "Memory/Candidate.md");
    assert.equal(requests.length, 2);
    assert.ok(requests.every((request) => request.url === "/chat/completions"));
    assert.ok(requests.every((request) => request.body.model === "deepseek-v4-pro"));
    assert.ok(requests.every((request) => request.body.thinking?.type === "disabled"));
    assert.ok(requests.every((request) => request.body.response_format?.type === "json_object"));
  } finally {
    await server.close();
    await rm(temp, { recursive: true, force: true });
  }
});

// The pipeline strategy delegates to core's runFullPipeline (ADR 0005;
// pipelineRecallViaCore in run-insight-search.mjs), which falls back to the
// deterministic rules query plan on a query-plan LLM failure.
test("pipeline falls back to deterministic rules when DeepSeek query planning fails", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "aha-wrapper-deepseek-plan-fallback-"));
  const vault = path.join(temp, "vault");
  const source = path.join(vault, "source.md");
  const codex = path.join(temp, "codex-helper.mjs");
  const qmd = path.join(temp, "qmd-helper.mjs");
  const obsidian = path.join(temp, "obsidian-helper.mjs");
  await mkdir(vault, { recursive: true });
  await writeFile(source, "# Source\n\nA current insight with enough text for fallback query planning.");
  await writeSafeCandidate(vault);
  await writePipelineHelpers({ codex, qmd, obsidian, relationJudge: "success" });
  const requests = [];
  const server = await startDeepSeekFixtureServer(requests, { failAllQueryPlans: true });

  try {
    const result = await spawnNode([
      wrapper,
      "--workspace",
      repoRoot,
      "--llm-provider",
      "deepseek",
      "--qmd-runner",
      "cli",
      "--source-path",
      "source.md",
      "--source-absolute-path",
      source,
      "--vault-root",
      vault,
      "--llm-base-url",
      server.baseUrl,
      "--llm-model",
      "deepseek-test",
      "--llm-api-key-env",
      "AHA_TEST_DEEPSEEK_KEY",
      "--qmd-command",
      qmd,
      "--obsidian-command",
      obsidian,
    ], { env: withoutProxyEnv({ ...process.env, AHA_TEST_DEEPSEEK_KEY: "test-key" }), timeout: 10000 });

    const output = JSON.parse(result.stdout);
    assert.ok(output.warnings.some((warning) => warning.includes("Query plan generated by rules after fallback")));
  } finally {
    await server.close();
    await rm(temp, { recursive: true, force: true });
  }
});

async function readFixture(name) {
  return import("node:fs/promises").then(({ readFile }) => readFile(path.join(repoRoot, "scripts/aha/fixtures", name), "utf8"));
}

async function writeOkCommand(filePath) {
  await writeFile(filePath, [
    "#!/usr/bin/env node",
    "const args = process.argv.slice(2);",
    "if (args[0] === 'files' && args[1] === 'total') { console.log('1'); process.exit(0); }",
    "console.log('ok-command 1.0');",
    "",
  ].join("\n"));
  await chmod(filePath, 0o755);
}

function withoutProxyEnv(env) {
  for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) {
    delete env[key];
  }
  env.NO_PROXY = "localhost,127.0.0.1,::1";
  env.no_proxy = env.NO_PROXY;
  return env;
}

function spawnNode(args, { env, timeout }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish({ status: null, stdout, stderr, error: new Error("spawn timeout") });
    }, timeout);
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (error) => finish({ status: null, stdout, stderr, error }));
    child.on("close", (code) => finish({ status: code, stdout, stderr }));
  });
}


async function startDeepSeekFixtureServer(requests, options = {}) {
  let failedQueryPlan = false;
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const parsed = JSON.parse(body);
      requests.push({ url: request.url, headers: request.headers, body: parsed });
      const prompt = String(parsed.messages?.[0]?.content ?? "");
      const isConnectionCheck = /connection check/i.test(prompt);
      const isQueryPlan = prompt.includes("检索查询生成");
      if (isQueryPlan && (options.failAllQueryPlans || (options.failFirstQueryPlan && !failedQueryPlan))) {
        failedQueryPlan = true;
        response.writeHead(500, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: { message: "planned fixture query-plan failure" } }));
        return;
      }
      const output = isConnectionCheck
        ? { ok: true }
        : isQueryPlan
          ? {
              queries: [
                { kind: "raw", command: "qmd query", text: "raw", qmd: { intent: "raw", lex: ["source"], vec: "source insight", hyde: "old note about source insight" } },
                { kind: "abstracted_judgment", command: "qmd query", text: "abstracted", qmd: { intent: "abstracted", lex: ["judgment"], vec: "judgment boundary", hyde: "old note about judgment boundary" } },
                { kind: "contextual", command: "qmd query", text: "context", qmd: { intent: "context", lex: ["context"], vec: "context relation", hyde: "old note about context relation" } },
              ],
            }
          : {
              ok: true,
              sourcePath: "source.md",
              generatedAt: null,
              summary: "judge ok",
              warnings: [],
              error: null,
              candidates: [
                { notePath: "Memory/Candidate.md", noteTitle: "Candidate", relation: "supports", hit: "\"Safe vault evidence.\"", why: "The candidate includes quote-backed evidence for the source insight.", quotes: ["Safe vault evidence."], selected: true },
              ],
            };
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        choices: [{ message: { role: "assistant", content: JSON.stringify(output) } }],
      }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

async function writeFakeQmdSdkModule(modulePath, logPath, { rows }) {
  await writeFile(modulePath, [
    "import { appendFileSync } from 'node:fs';",
    `const logPath = ${JSON.stringify(logPath)};`,
    `const rows = ${JSON.stringify(rows)};`,
    "function log(method, options) { appendFileSync(logPath, `${JSON.stringify({ method, options })}\\n`); }",
    "export async function createStore(options) {",
    "  log('createStore', options);",
    "  return {",
    "    async search(options) { log('search', options); return rows; },",
    "    async searchLex(query, options) { log('searchLex', { query, options }); return rows; },",
    "    async close() { log('close', {}); },",
    "  };",
    "}",
    "",
  ].join("\n"));
}

async function writeSafeCandidate(vault) {
  const candidate = path.join(vault, "Memory/Candidate.md");
  await mkdir(path.dirname(candidate), { recursive: true });
  // At least 30 substantive chars after heading/whitespace stripping: core's
  // isSubstantiveExcerpt (note-excerpt.ts) filters out template/near-empty
  // notes before Relation Judge, unlike the legacy wrapper's judge, which
  // never filtered by length.
  await writeFile(candidate, "# Candidate\n\nSafe vault evidence. This candidate note has enough real content.");
}

async function writePipelineHelpers({ codex, qmd, obsidian, relationJudge, outsidePath = "", outsideSnippet = "outside snippet", noCandidates = false, graphPaths = [], qmdHang = false, qmdHangQueryOnly = false, qmdHangRawQueryOnce = false }) {
  await writeFile(codex, [
    "#!/usr/bin/env node",
    "import { writeFileSync } from 'node:fs';",
    "const args = process.argv.slice(2);",
    "if (args.includes('--version')) { console.log('codex-test 1.0'); process.exit(0); }",
    "const outputIndex = args.indexOf('--output-last-message');",
    "const outputFile = outputIndex === -1 ? '' : args[outputIndex + 1];",
    "if (outputFile.endsWith('query-plan.json')) {",
    "  writeFileSync(outputFile, JSON.stringify({ queries: [",
    "    { kind: 'raw', command: 'qmd query', qmd: { intent: 'raw', lex: ['source'], vec: 'source insight', hyde: 'old note about source insight' } },",
    "    { kind: 'abstracted_judgment', command: 'qmd query', qmd: { intent: 'abstracted', lex: ['judgment'], vec: 'judgment boundary', hyde: 'old note about judgment boundary' } },",
    "    { kind: 'contextual', command: 'qmd query', qmd: { intent: 'context', lex: ['context'], vec: 'context relation', hyde: 'old note about context relation' } }",
    "  ] }));",
    "  process.exit(0);",
    "}",
    relationJudge === "fail"
      ? "if (outputFile.endsWith('relation-judge.json')) { console.error('judge failed intentionally'); process.exit(42); }"
      : [
          "if (outputFile.endsWith('relation-judge.json')) {",
          "  const prompt = args[args.length - 1] || '';",
          "  if (prompt.includes('SUPER_SECRET_SHOULD_NOT_LEAK')) { console.error('secret leaked into judge prompt'); process.exit(66); }",
          "  writeFileSync(outputFile, JSON.stringify({ ok: true, sourcePath: 'source.md', summary: 'judge ok', warnings: [], candidates: [",
          "    { notePath: 'Memory/Candidate.md', noteTitle: 'Candidate', relation: 'supports', hit: '\"Safe vault evidence.\"', why: 'The candidate includes quote-backed evidence for the source insight.', quotes: ['Safe vault evidence.'], selected: true }",
          "  ] }));",
          "  process.exit(0);",
          "}",
        ].join("\n"),
    "console.error('unexpected codex invocation');",
    "process.exit(2);",
    "",
  ].join("\n"));

  await writeFile(qmd, [
    "#!/usr/bin/env node",
    "import { appendFileSync, readFileSync } from 'node:fs';",
    "const args = process.argv.slice(2);",
    "if (args.includes('--version')) { console.log('qmd-test 1.0'); process.exit(0); }",
    "const indexFlag = args.indexOf('--index');",
    "const subcommand = indexFlag === -1 ? args[0] : args[indexFlag + 2];",
    "const nIndex = args.indexOf('-n');",
    "const candidateLimitIndex = args.indexOf('-C');",
    "if (process.env.QMD_ARGS_LOG) appendFileSync(process.env.QMD_ARGS_LOG, `${JSON.stringify(args)}\\n`);",
    "if (process.env.QMD_N_LOG && nIndex !== -1) appendFileSync(process.env.QMD_N_LOG, `${args[nIndex + 1]}\\n`);",
    "if (process.env.QMD_CANDIDATE_LIMIT_LOG && candidateLimitIndex !== -1) appendFileSync(process.env.QMD_CANDIDATE_LIMIT_LOG, `${args[candidateLimitIndex + 1]}\\n`);",
    "if (process.env.QMD_CALL_LOG) appendFileSync(process.env.QMD_CALL_LOG, `${Date.now()}:${subcommand}\\n`);",
    "if (args.includes('get')) { console.log('qmd://obsidian/Memory/Candidate.md?index=obsidian\\n---\\n# Candidate\\nSafe vault evidence.'); process.exit(0); }",
    qmdHangRawQueryOnce
      ? [
          "if (process.env.QMD_TIMEOUT_ONCE_MARKER && subcommand === 'query' && args.join('\\n').includes('source insight')) {",
          "  let seen = '';",
          "  try { seen = readFileSync(process.env.QMD_TIMEOUT_ONCE_MARKER, 'utf8'); } catch {}",
          "  if (!seen) { appendFileSync(process.env.QMD_TIMEOUT_ONCE_MARKER, 'seen'); setInterval(() => {}, 1000); }",
          "}",
        ].join("\n")
      : "",
    "function emitRows() {",
    noCandidates
      ? "  console.log('[]');"
      : [
          "  console.log(JSON.stringify([",
          outsidePath
            ? `    { score: 0.99, file: ${JSON.stringify(outsidePath)}, title: 'Secret', snippet: ${JSON.stringify(outsideSnippet)} },`
            : "",
          "    { score: 0.91, file: 'qmd://obsidian/Memory/Candidate.md?index=obsidian', title: 'Candidate', snippet: '\"Safe vault evidence.\"' }",
          "  ]));",
        ].filter((line) => line !== "").join("\n"),
    "}",
    qmdHang
      ? "setInterval(() => {}, 1000);"
      : qmdHangQueryOnly
      ? "if (subcommand === 'query') { setInterval(() => {}, 1000); } else { emitRows(); }"
      : "emitRows();",
    "",
  ].filter((line) => line !== "").join("\n"));

  await writeFile(obsidian, [
    "#!/usr/bin/env node",
    "const args = process.argv.slice(2);",
    "if (args[0] === 'files' && args[1] === 'total') { console.log('1'); process.exit(0); }",
    `if (args[0] === 'links' || args[0] === 'backlinks') { console.log(${JSON.stringify(JSON.stringify(graphPaths.map((file) => ({ file }))))}); process.exit(0); }`,
    "console.log('ok');",
    "",
  ].join("\n"));

  await Promise.all([codex, qmd, obsidian].map((file) => chmod(file, 0o755)));
}
