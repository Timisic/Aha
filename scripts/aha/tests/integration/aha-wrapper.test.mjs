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

test("wrapper emits fixture JSON without running Codex", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "aha-wrapper-"));
  const source = path.join(temp, "source.md");
  await writeFile(source, "# Source\n\nA current insight.");
  try {
    const result = spawnSync(process.execPath, [
      wrapper,
      "--workspace",
      repoRoot,
      "--llm-provider",
      "codex-cli",
      "--qmd-runner",
      "cli",
      "--source-path",
      "source.md",
      "--source-absolute-path",
      source,
      "--fixture",
      path.join(repoRoot, "scripts/aha/fixtures/stub-result.json"),
    ], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, true);
    assert.ok(output.candidates.length >= 3);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
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

test("readiness reports missing tools clearly", async () => {
  const result = spawnSync(process.execPath, [
    wrapper,
    "--check-readiness",
    "--workspace",
    repoRoot,
      "--llm-provider",
      "codex-cli",
      "--qmd-runner",
      "cli",
    "--codex-command",
    "/definitely/missing/codex",
    "--qmd-command",
    "/definitely/missing/qmd",
    "--obsidian-command",
    "/definitely/missing/obsidian",
  ], { encoding: "utf8" });
  assert.equal(result.status, 2);
  const output = JSON.parse(result.stdout);
  assert.equal(output.ok, false);
  assert.ok(output.checks.some((check) => check.name === "Codex CLI" && !check.ok));
  assert.ok(output.checks.some((check) => check.name === "QMD CLI" && !check.ok));
  assert.ok(output.checks.some((check) => check.name === "Obsidian CLI" && !check.ok));
});

test("readiness reports missing DeepSeek key without requiring Codex CLI", async () => {
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
      "--codex-command",
      "/definitely/missing/codex",
      "--qmd-command",
      helper,
      "--obsidian-command",
      helper,
    ], { encoding: "utf8", env });

    assert.equal(result.status, 2);
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, false);
    assert.ok(output.checks.some((check) => check.name === "DeepSeek API key" && !check.ok && check.message.includes("AHA_TEST_DEEPSEEK_KEY")));
    assert.equal(output.checks.some((check) => check.name === "Codex CLI"), false);
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
      "--codex-command",
      "/definitely/missing/codex",
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
    assert.equal(output.checks.some((check) => check.name === "Codex CLI"), false);
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
      "--codex-command",
      "/definitely/missing/codex",
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

// DeepSeek+pipeline delegates to core's runFullPipeline (ADR 0005;
// pipelineRecallViaCore in run-insight-search.mjs), which only falls back to
// deterministic rules on a query-plan LLM failure -- never to Codex CLI. The
// codex-fallback-on-API-failure behavior the pre-delegation legacy
// pipelineRecall had is intentionally not preserved for this path (the user
// confirmed it is unnecessary once OpenAI/codex-fallback was dropped); this
// replaces the old "falls back to Codex CLI" test with coverage of the
// actual current behavior.
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
      "--codex-command",
      codex,
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

test("pipeline can use QMD SDK runner without invoking QMD CLI", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "aha-wrapper-qmd-sdk-"));
  const vault = path.join(temp, "vault");
  const source = path.join(vault, "source.md");
  const reviewPath = "Aha/Reviews/2026-06-28 Source.md";
  const codex = path.join(temp, "codex-helper.mjs");
  const qmd = path.join(temp, "qmd-helper.mjs");
  const obsidian = path.join(temp, "obsidian-helper.mjs");
  const sdkModule = path.join(temp, "fake-qmd-sdk.mjs");
  const sdkLog = path.join(temp, "sdk.log");
  await mkdir(path.join(vault, "Aha/Reviews"), { recursive: true });
  await writeFile(source, "# Source\n\nA current insight with enough text for query planning.");
  await writeSafeCandidate(vault);
  await writeFile(path.join(vault, reviewPath), "# Aha Review: Source\n\nSource shell");
  await writeFakeQmdSdkModule(sdkModule, sdkLog, {
    rows: [
      { score: 0.99, file: "qmd://obsidian/source.md?index=obsidian", title: "Source", bestChunk: "self hit" },
      { score: 0.98, file: `qmd://obsidian/${encodeURIComponent(reviewPath)}?index=obsidian`, title: "Review", bestChunk: "review shell" },
      { score: 0.97, filepath: path.join(temp, "outside.md"), title: "Outside", bestChunk: "outside" },
      { score: 0.91, file: "qmd://obsidian/Memory/Candidate.md?index=obsidian", title: "Candidate", bestChunk: "\"Safe vault evidence.\"" },
    ],
  });
  await writeFile(path.join(temp, "outside.md"), "outside");
  await writePipelineHelpers({ codex, qmd, obsidian, relationJudge: "success", noCandidates: true });

  try {
    const result = spawnSync(process.execPath, [
      wrapper,
      "--workspace",
      repoRoot,
      "--llm-provider",
      "codex-cli",
      "--qmd-runner",
      "sdk",
      "--source-path",
      "source.md",
      "--source-absolute-path",
      source,
      "--review-path",
      reviewPath,
      "--vault-root",
      vault,
      "--codex-command",
      codex,
      "--qmd-sdk-module",
      sdkModule,
      "--qmd-command",
      "/definitely/missing/qmd",
      "--obsidian-command",
      obsidian,
    ], { encoding: "utf8", timeout: 10000 });

    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.candidates.length, 1);
    assert.equal(output.candidates[0].notePath, "Memory/Candidate.md");
    const sdkCalls = (await readFile(sdkLog, "utf8")).trim().split(/\r?\n/).map((line) => JSON.parse(line));
    assert.ok(sdkCalls.some((call) => call.method === "search" && call.options.rerank === false));
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("QMD SDK readiness can infer module path from qmd command", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "aha-wrapper-qmd-sdk-infer-"));
  const helper = path.join(temp, "ok-command.mjs");
  const packageRoot = path.join(temp, "fake-qmd");
  const qmdCommand = path.join(packageRoot, "bin/qmd");
  await writeOkCommand(helper);
  await mkdir(path.join(packageRoot, "bin"), { recursive: true });
  await mkdir(path.join(packageRoot, "dist"), { recursive: true });
  await writeFile(path.join(packageRoot, "package.json"), JSON.stringify({ type: "module" }));
  await writeFile(qmdCommand, "#!/usr/bin/env node\nconsole.log('fake qmd');\n");
  await chmod(qmdCommand, 0o755);
  await writeFakeQmdSdkModule(path.join(packageRoot, "dist/index.js"), path.join(temp, "sdk.log"), { rows: [] });

  try {
    const result = spawnSync(process.execPath, [
      wrapper,
      "--check-readiness",
      "--workspace",
      repoRoot,
      "--llm-provider",
      "codex-cli",
      "--qmd-runner",
      "sdk",
      "--codex-command",
      helper,
      "--qmd-command",
      qmdCommand,
      "--obsidian-command",
      helper,
    ], { encoding: "utf8", timeout: 10000 });

    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, true);
    assert.ok(output.checks.some((check) => check.name === "QMD SDK" && check.ok && check.message.endsWith("dist/index.js")));
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("wrapper closes child stdin for noninteractive CLI commands", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "aha-wrapper-stdin-"));
  const helper = path.join(temp, "stdin-eof-command.mjs");
  await writeFile(helper, [
    "#!/usr/bin/env node",
    "process.stdin.resume();",
    "process.stdin.on('end', () => { console.log('stdin-eof'); process.exit(0); });",
    "setTimeout(() => { console.error('stdin-still-open'); process.exit(23); }, 500);",
    "",
  ].join("\n"));
  await chmod(helper, 0o755);

  try {
    const result = spawnSync(process.execPath, [
      wrapper,
      "--check-readiness",
      "--workspace",
      repoRoot,
      "--llm-provider",
      "codex-cli",
      "--qmd-runner",
      "cli",
      "--codex-command",
      helper,
      "--qmd-command",
      helper,
      "--obsidian-command",
      helper,
    ], { encoding: "utf8", timeout: 5000 });
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.checks.filter((check) => check.message === "stdin-eof").length, 3);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("pipeline rejects symlinked source notes outside vault before reading", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "aha-wrapper-source-symlink-boundary-"));
  const vault = path.join(temp, "vault");
  const source = path.join(vault, "source.md");
  const secret = path.join(temp, "secret-source.md");
  const codex = path.join(temp, "codex-helper.mjs");
  const qmd = path.join(temp, "qmd-helper.mjs");
  const obsidian = path.join(temp, "obsidian-helper.mjs");
  await mkdir(vault, { recursive: true });
  await writeFile(secret, "# Secret\n\nSUPER_SECRET_SOURCE_SHOULD_NOT_LEAK");
  await symlink(secret, source);
  await writeSafeCandidate(vault);
  await writePipelineHelpers({ codex, qmd, obsidian, relationJudge: "success" });

  try {
    const result = spawnSync(process.execPath, [
      wrapper,
      "--workspace",
      repoRoot,
      "--llm-provider",
      "codex-cli",
      "--qmd-runner",
      "cli",
      "--source-path",
      "source.md",
      "--source-absolute-path",
      source,
      "--vault-root",
      vault,
      "--codex-command",
      codex,
      "--qmd-command",
      qmd,
      "--obsidian-command",
      obsidian,
    ], { encoding: "utf8", timeout: 10000 });

    assert.equal(result.status, 4, result.stderr);
    assert.doesNotMatch(result.stdout, /SUPER_SECRET_SOURCE_SHOULD_NOT_LEAK/);
    assert.doesNotMatch(result.stderr, /SUPER_SECRET_SOURCE_SHOULD_NOT_LEAK/);
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, false);
    assert.equal(output.error.tool, "wrapper");
    assert.match(output.error.details, /source note/i);
    assert.equal(validateAhaResult(output).ok, true);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("pipeline returns structured failure when relation judge fails", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "aha-wrapper-judge-fail-"));
  const vault = path.join(temp, "vault");
  const source = path.join(vault, "source.md");
  const codex = path.join(temp, "codex-helper.mjs");
  const qmd = path.join(temp, "qmd-helper.mjs");
  const obsidian = path.join(temp, "obsidian-helper.mjs");
  const qmdLog = path.join(temp, "qmd-n.log");
  const qmdCandidateLimitLog = path.join(temp, "qmd-candidate-limit.log");
  await mkdir(vault, { recursive: true });
  await writeFile(source, "# Source\n\nA current insight with enough text for query planning.");
  await writeSafeCandidate(vault);
  await writePipelineHelpers({ codex, qmd, obsidian, relationJudge: "fail" });

  try {
    const result = spawnSync(process.execPath, [
      wrapper,
      "--workspace",
      repoRoot,
      "--llm-provider",
      "codex-cli",
      "--qmd-runner",
      "cli",
      "--source-path",
      "source.md",
      "--source-absolute-path",
      source,
      "--vault-root",
      vault,
      "--codex-command",
      codex,
      "--qmd-command",
      qmd,
      "--obsidian-command",
      obsidian,
      "--target-candidates",
      "999",
    ], { encoding: "utf8", env: { ...process.env, QMD_N_LOG: qmdLog, QMD_CANDIDATE_LIMIT_LOG: qmdCandidateLimitLog }, timeout: 10000 });

    assert.equal(result.status, 2, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, false);
    assert.equal(output.error.tool, "codex");
    assert.match(output.error.message, /Relation Judge/);
    assert.ok(output.candidates.length > 0);
    const qmdCounts = (await readFile(qmdLog, "utf8")).trim().split(/\r?\n/);
    assert.ok(qmdCounts.length >= 3);
    assert.ok(qmdCounts.every((value) => value === "20"));
    const qmdCandidateLimits = (await readFile(qmdCandidateLimitLog, "utf8")).trim().split(/\r?\n/);
    assert.ok(qmdCandidateLimits.length >= 3);
    assert.ok(qmdCandidateLimits.every((value) => value === "20"));
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("QMD CLI fallback disables rerank by default and preserves explicit rerank opt-in", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "aha-wrapper-qmd-no-rerank-"));
  const vault = path.join(temp, "vault");
  const source = path.join(vault, "source.md");
  const codex = path.join(temp, "codex-helper.mjs");
  const qmd = path.join(temp, "qmd-helper.mjs");
  const obsidian = path.join(temp, "obsidian-helper.mjs");
  const defaultArgsLog = path.join(temp, "qmd-default-args.log");
  const optInArgsLog = path.join(temp, "qmd-opt-in-args.log");
  await mkdir(vault, { recursive: true });
  await writeFile(source, "# Source\n\nA current insight with enough text for qmd-only recall.");
  await writeSafeCandidate(vault);
  await writePipelineHelpers({ codex, qmd, obsidian, relationJudge: "success" });

  const baseArgs = [
    wrapper,
    "--workspace",
    repoRoot,
    "--llm-provider",
    "codex-cli",
    "--qmd-runner",
    "cli",
    "--strategy",
    "qmd-only",
    "--source-path",
    "source.md",
    "--source-absolute-path",
    source,
    "--vault-root",
    vault,
    "--codex-command",
    codex,
    "--qmd-command",
    qmd,
    "--obsidian-command",
    obsidian,
  ];

  try {
    const defaultResult = spawnSync(process.execPath, baseArgs, {
      encoding: "utf8",
      env: { ...process.env, QMD_ARGS_LOG: defaultArgsLog },
      timeout: 10000,
    });
    assert.equal(defaultResult.status, 0, defaultResult.stderr);
    const defaultQmdArgs = JSON.parse((await readFile(defaultArgsLog, "utf8")).trim().split(/\r?\n/)[0]);
    assert.ok(defaultQmdArgs.includes("--no-rerank"));

    const optInResult = spawnSync(process.execPath, [...baseArgs, "--qmd-rerank"], {
      encoding: "utf8",
      env: { ...process.env, QMD_ARGS_LOG: optInArgsLog },
      timeout: 10000,
    });
    assert.equal(optInResult.status, 0, optInResult.stderr);
    const optInQmdArgs = JSON.parse((await readFile(optInArgsLog, "utf8")).trim().split(/\r?\n/)[0]);
    assert.equal(optInQmdArgs.includes("--no-rerank"), false);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("pipeline returns structured failure when mixed retrieval has no candidates", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "aha-wrapper-empty-candidates-"));
  const vault = path.join(temp, "vault");
  const source = path.join(vault, "source.md");
  const codex = path.join(temp, "codex-helper.mjs");
  const qmd = path.join(temp, "qmd-helper.mjs");
  const obsidian = path.join(temp, "obsidian-helper.mjs");
  await mkdir(vault, { recursive: true });
  await writeFile(source, "# Source\n\nA current insight with enough text for query planning.");
  await writePipelineHelpers({ codex, qmd, obsidian, relationJudge: "success", noCandidates: true });

  try {
    const result = spawnSync(process.execPath, [
      wrapper,
      "--workspace",
      repoRoot,
      "--llm-provider",
      "codex-cli",
      "--qmd-runner",
      "cli",
      "--source-path",
      "source.md",
      "--source-absolute-path",
      source,
      "--vault-root",
      vault,
      "--codex-command",
      codex,
      "--qmd-command",
      qmd,
      "--obsidian-command",
      obsidian,
    ], { encoding: "utf8", timeout: 10000 });

    assert.equal(result.status, 2, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, false);
    assert.equal(output.error.tool, "qmd");
    assert.match(output.error.details, /no vault-contained candidates/i);
    assert.deepEqual(output.candidates, []);
    assert.equal(validateAhaResult(output).ok, true);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("pipeline filters generated Aha review notes from graph expansion", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "aha-wrapper-review-note-filter-"));
  const vault = path.join(temp, "vault");
  const source = path.join(vault, "source.md");
  const reviewPath = "Aha/Reviews/2026-06-28 Source.md";
  const codex = path.join(temp, "codex-helper.mjs");
  const qmd = path.join(temp, "qmd-helper.mjs");
  const obsidian = path.join(temp, "obsidian-helper.mjs");
  await mkdir(path.join(vault, "Aha/Reviews"), { recursive: true });
  await writeFile(source, "# Source\n\nA current insight with enough text for query planning.");
  await writeFile(path.join(vault, reviewPath), [
    "# Aha Review: Source",
    "",
    "Source: [[source]]",
    "",
    "_Aha will add selected memory candidates here after retrieval._",
  ].join("\n"));
  await writePipelineHelpers({
    codex,
    qmd,
    obsidian,
    relationJudge: "success",
    noCandidates: true,
    graphPaths: [reviewPath],
  });

  try {
    const result = spawnSync(process.execPath, [
      wrapper,
      "--workspace",
      repoRoot,
      "--llm-provider",
      "codex-cli",
      "--qmd-runner",
      "cli",
      "--source-path",
      "source.md",
      "--source-absolute-path",
      source,
      "--review-path",
      reviewPath,
      "--vault-root",
      vault,
      "--codex-command",
      codex,
      "--qmd-command",
      qmd,
      "--obsidian-command",
      obsidian,
    ], { encoding: "utf8", timeout: 10000 });

    assert.equal(result.status, 2, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, false);
    assert.equal(output.error.tool, "qmd");
    assert.deepEqual(output.candidates, []);
    assert.doesNotMatch(result.stdout, /Aha\/Reviews/);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("pipeline bounds QMD plan query timeouts serially", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "aha-wrapper-qmd-timeout-bound-"));
  const vault = path.join(temp, "vault");
  const source = path.join(vault, "source.md");
  const codex = path.join(temp, "codex-helper.mjs");
  const qmd = path.join(temp, "qmd-helper.mjs");
  const obsidian = path.join(temp, "obsidian-helper.mjs");
  const qmdCallLog = path.join(temp, "qmd-call.log");
  await mkdir(vault, { recursive: true });
  await writeFile(source, "# Source\n\nA current insight with enough text for query planning.");
  await writeSafeCandidate(vault);
  await writePipelineHelpers({
    codex,
    qmd,
    obsidian,
    relationJudge: "success",
    qmdHang: true,
    graphPaths: ["Memory/Candidate.md"],
  });

  try {
    const started = Date.now();
    const result = spawnSync(process.execPath, [
      wrapper,
      "--workspace",
      repoRoot,
      "--llm-provider",
      "codex-cli",
      "--qmd-runner",
      "cli",
      "--source-path",
      "source.md",
      "--source-absolute-path",
      source,
      "--vault-root",
      vault,
      "--codex-command",
      codex,
      "--qmd-command",
      qmd,
      "--obsidian-command",
      obsidian,
      "--qmd-query-timeout-ms",
      "250",
    ], { encoding: "utf8", env: { ...process.env, QMD_CALL_LOG: qmdCallLog }, timeout: 10000 });
    const elapsedMs = Date.now() - started;

    assert.equal(result.status, 0, result.stderr);
    assert.ok(elapsedMs >= 1000, `expected serial timeout work to include the deterministic source fallback, got ${elapsedMs}ms`);
    assert.ok(elapsedMs < 6500, `expected bounded serial timeout handling, got ${elapsedMs}ms`);
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.candidates.length, 1);
    assert.equal(output.warnings.filter((warning) => warning.includes("timed out after 250ms")).length, 4);
    const qmdCalls = (await readFile(qmdCallLog, "utf8")).trim().split("\n").map((line) => {
      const [time, subcommand] = line.split(":");
      return { time: Number(time), subcommand };
    });
    const planCalls = qmdCalls.filter((call) => call.subcommand !== "get");
    assert.ok(planCalls.length >= 4 && planCalls.length <= 8, `expected bounded query attempts, got ${planCalls.length}`);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("pipeline preserves structured QMD query timeout without vsearch fallback", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "aha-wrapper-qmd-query-no-fallback-"));
  const vault = path.join(temp, "vault");
  const source = path.join(vault, "source.md");
  const codex = path.join(temp, "codex-helper.mjs");
  const qmd = path.join(temp, "qmd-helper.mjs");
  const obsidian = path.join(temp, "obsidian-helper.mjs");
  const qmdCallLog = path.join(temp, "qmd-call.log");
  await mkdir(vault, { recursive: true });
  await writeFile(source, "# Source\n\nA current insight with enough text for query planning.");
  await writeSafeCandidate(vault);
  await writePipelineHelpers({
    codex,
    qmd,
    obsidian,
    relationJudge: "success",
    qmdHangQueryOnly: true,
    graphPaths: ["Memory/Candidate.md"],
  });

  try {
    const result = spawnSync(process.execPath, [
      wrapper,
      "--workspace",
      repoRoot,
      "--llm-provider",
      "codex-cli",
      "--qmd-runner",
      "cli",
      "--source-path",
      "source.md",
      "--source-absolute-path",
      source,
      "--vault-root",
      vault,
      "--codex-command",
      codex,
      "--qmd-command",
      qmd,
      "--obsidian-command",
      obsidian,
      "--qmd-query-timeout-ms",
      "500",
    ], { encoding: "utf8", env: { ...process.env, QMD_CALL_LOG: qmdCallLog }, timeout: 10000 });

    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.candidates.length, 1);
    assert.equal(output.warnings.filter((warning) => warning.includes("timed out after 500ms")).length, 4);
    assert.ok(!output.warnings.some((warning) => warning.includes("vsearch fallback")));
    const qmdCalls = (await readFile(qmdCallLog, "utf8")).trim().split("\n").map((line) => line.split(":")[1]);
    assert.deepEqual(qmdCalls.filter((subcommand) => subcommand !== "get"), ["query", "query", "query", "query", "query", "query", "query", "query"]);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("pipeline retries timed out structured QMD query once", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "aha-wrapper-qmd-query-retry-"));
  const vault = path.join(temp, "vault");
  const source = path.join(vault, "source.md");
  const codex = path.join(temp, "codex-helper.mjs");
  const qmd = path.join(temp, "qmd-helper.mjs");
  const obsidian = path.join(temp, "obsidian-helper.mjs");
  const qmdTimeoutMarker = path.join(temp, "qmd-timeout-once.marker");
  await mkdir(vault, { recursive: true });
  await writeFile(source, "# Source\n\nA current insight with enough text for query planning.");
  await writeSafeCandidate(vault);
  await writePipelineHelpers({
    codex,
    qmd,
    obsidian,
    relationJudge: "success",
    qmdHangRawQueryOnce: true,
  });

  try {
    const result = spawnSync(process.execPath, [
      wrapper,
      "--workspace",
      repoRoot,
      "--llm-provider",
      "codex-cli",
      "--qmd-runner",
      "cli",
      "--source-path",
      "source.md",
      "--source-absolute-path",
      source,
      "--vault-root",
      vault,
      "--codex-command",
      codex,
      "--qmd-command",
      qmd,
      "--obsidian-command",
      obsidian,
      "--qmd-query-timeout-ms",
      "1000",
    ], { encoding: "utf8", env: { ...process.env, QMD_TIMEOUT_ONCE_MARKER: qmdTimeoutMarker }, timeout: 10000 });

    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, true);
    assert.ok(output.warnings.some((warning) => warning.includes("retry succeeded with qmd query")));
    assert.ok(!output.warnings.some((warning) => warning.includes("vsearch fallback")));
    assert.ok(!output.warnings.some((warning) => warning.includes("Skipped failed query")));
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("pipeline fails structurally when admitted candidates have no readable excerpts", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "aha-wrapper-unreadable-excerpts-"));
  const vault = path.join(temp, "vault");
  const source = path.join(vault, "source.md");
  const codex = path.join(temp, "codex-helper.mjs");
  const qmd = path.join(temp, "qmd-helper.mjs");
  const obsidian = path.join(temp, "obsidian-helper.mjs");
  await mkdir(vault, { recursive: true });
  await writeFile(source, "# Source\n\nA current insight with enough text for query planning.");
  await mkdir(path.join(vault, "Memory/Candidate.md"), { recursive: true });
  await writePipelineHelpers({ codex, qmd, obsidian, relationJudge: "success" });

  try {
    const result = spawnSync(process.execPath, [
      wrapper,
      "--workspace",
      repoRoot,
      "--llm-provider",
      "codex-cli",
      "--qmd-runner",
      "cli",
      "--source-path",
      "source.md",
      "--source-absolute-path",
      source,
      "--vault-root",
      vault,
      "--codex-command",
      codex,
      "--qmd-command",
      qmd,
      "--obsidian-command",
      obsidian,
    ], { encoding: "utf8", timeout: 10000 });

    assert.equal(result.status, 2, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, false);
    assert.equal(output.error.tool, "qmd");
    assert.match(output.error.details, /no vault-contained excerpts/i);
    assert.ok(output.candidates.length > 0);
    assert.equal(validateAhaResult(output).ok, true);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("non-pipeline relation judge failures are structured failures", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "aha-wrapper-hybrid-judge-fail-"));
  const vault = path.join(temp, "vault");
  const source = path.join(vault, "source.md");
  const codex = path.join(temp, "codex-helper.mjs");
  const qmd = path.join(temp, "qmd-helper.mjs");
  const obsidian = path.join(temp, "obsidian-helper.mjs");
  await mkdir(vault, { recursive: true });
  await writeFile(source, "# Source\n\nA current insight with enough text for query planning.");
  await writeSafeCandidate(vault);
  await writePipelineHelpers({ codex, qmd, obsidian, relationJudge: "fail" });

  try {
    const result = spawnSync(process.execPath, [
      wrapper,
      "--workspace",
      repoRoot,
      "--llm-provider",
      "codex-cli",
      "--qmd-runner",
      "cli",
      "--source-path",
      "source.md",
      "--source-absolute-path",
      source,
      "--vault-root",
      vault,
      "--codex-command",
      codex,
      "--qmd-command",
      qmd,
      "--obsidian-command",
      obsidian,
      "--strategy",
      "hybrid",
    ], { encoding: "utf8", timeout: 10000 });

    assert.equal(result.status, 2, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, false);
    assert.equal(output.error.tool, "codex");
    assert.match(output.error.message, /Relation Judge/);
    assert.ok(output.candidates.length > 0);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("codex-orchestrated failures are structured failures", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "aha-wrapper-codex-orchestrated-fail-"));
  const vault = path.join(temp, "vault");
  const source = path.join(vault, "source.md");
  const codex = path.join(temp, "codex-helper.mjs");
  const qmd = path.join(temp, "qmd-helper.mjs");
  const obsidian = path.join(temp, "obsidian-helper.mjs");
  await mkdir(vault, { recursive: true });
  await writeFile(source, "# Source\n\nA current insight with enough text for query planning.");
  await writePipelineHelpers({ codex, qmd, obsidian, relationJudge: "fail" });

  try {
    const result = spawnSync(process.execPath, [
      wrapper,
      "--workspace",
      repoRoot,
      "--llm-provider",
      "codex-cli",
      "--qmd-runner",
      "cli",
      "--source-path",
      "source.md",
      "--source-absolute-path",
      source,
      "--vault-root",
      vault,
      "--codex-command",
      codex,
      "--qmd-command",
      qmd,
      "--obsidian-command",
      obsidian,
      "--strategy",
      "codex-orchestrated",
    ], { encoding: "utf8", timeout: 10000 });

    assert.equal(result.status, 2, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, false);
    assert.equal(output.error.tool, "codex");
    assert.match(output.error.message, /Codex orchestration/);
    assert.ok(output.candidates.length > 0);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("pipeline does not read outside-vault candidate excerpts", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "aha-wrapper-vault-boundary-"));
  const vault = path.join(temp, "vault");
  const source = path.join(vault, "source.md");
  const secret = path.join(temp, "secret.md");
  const codex = path.join(temp, "codex-helper.mjs");
  const qmd = path.join(temp, "qmd-helper.mjs");
  const obsidian = path.join(temp, "obsidian-helper.mjs");
  await mkdir(vault, { recursive: true });
  await writeFile(source, "# Source\n\nA current insight with enough text for query planning.");
  await writeSafeCandidate(vault);
  await writeFile(secret, "SUPER_SECRET_SHOULD_NOT_LEAK");
  await writePipelineHelpers({ codex, qmd, obsidian, relationJudge: "success", outsidePath: secret });

  try {
    const result = spawnSync(process.execPath, [
      wrapper,
      "--workspace",
      repoRoot,
      "--llm-provider",
      "codex-cli",
      "--qmd-runner",
      "cli",
      "--source-path",
      "source.md",
      "--source-absolute-path",
      source,
      "--vault-root",
      vault,
      "--codex-command",
      codex,
      "--qmd-command",
      qmd,
      "--obsidian-command",
      obsidian,
    ], { encoding: "utf8", timeout: 10000 });

    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /SUPER_SECRET_SHOULD_NOT_LEAK/);
    assert.doesNotMatch(result.stderr, /SUPER_SECRET_SHOULD_NOT_LEAK/);
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.candidates.some((candidate) => String(candidate.notePath).includes("secret.md")), false);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("pipeline rejects symlinked outside-vault candidates before relation judge", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "aha-wrapper-symlink-boundary-"));
  const vault = path.join(temp, "vault");
  const source = path.join(vault, "source.md");
  const secret = path.join(temp, "secret.md");
  const symlinkedSecret = path.join(vault, "LinkedSecret.md");
  const codex = path.join(temp, "codex-helper.mjs");
  const qmd = path.join(temp, "qmd-helper.mjs");
  const obsidian = path.join(temp, "obsidian-helper.mjs");
  await mkdir(vault, { recursive: true });
  await writeFile(source, "# Source\n\nA current insight with enough text for query planning.");
  await writeSafeCandidate(vault);
  await writeFile(secret, "SUPER_SECRET_SHOULD_NOT_LEAK");
  await symlink(secret, symlinkedSecret);
  await writePipelineHelpers({
    codex,
    qmd,
    obsidian,
    relationJudge: "success",
    outsidePath: symlinkedSecret,
    outsideSnippet: "SUPER_SECRET_SHOULD_NOT_LEAK",
  });

  try {
    const result = spawnSync(process.execPath, [
      wrapper,
      "--workspace",
      repoRoot,
      "--llm-provider",
      "codex-cli",
      "--qmd-runner",
      "cli",
      "--source-path",
      "source.md",
      "--source-absolute-path",
      source,
      "--vault-root",
      vault,
      "--codex-command",
      codex,
      "--qmd-command",
      qmd,
      "--obsidian-command",
      obsidian,
    ], { encoding: "utf8", timeout: 10000 });

    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /SUPER_SECRET_SHOULD_NOT_LEAK/);
    assert.doesNotMatch(result.stderr, /SUPER_SECRET_SHOULD_NOT_LEAK/);
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.candidates.some((candidate) => String(candidate.notePath).includes("LinkedSecret.md")), false);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("pipeline rejects qmd uri candidates that resolve through symlink outside vault", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "aha-wrapper-qmd-uri-symlink-boundary-"));
  const vault = path.join(temp, "vault");
  const source = path.join(vault, "source.md");
  const secret = path.join(temp, "secret.md");
  const symlinkedSecret = path.join(vault, "LinkedSecret.md");
  const codex = path.join(temp, "codex-helper.mjs");
  const qmd = path.join(temp, "qmd-helper.mjs");
  const obsidian = path.join(temp, "obsidian-helper.mjs");
  await mkdir(vault, { recursive: true });
  await writeFile(source, "# Source\n\nA current insight with enough text for query planning.");
  await writeSafeCandidate(vault);
  await writeFile(secret, "SUPER_SECRET_SHOULD_NOT_LEAK");
  await symlink(secret, symlinkedSecret);
  await writePipelineHelpers({
    codex,
    qmd,
    obsidian,
    relationJudge: "success",
    outsidePath: "qmd://obsidian/LinkedSecret.md?index=obsidian",
    outsideSnippet: "SUPER_SECRET_SHOULD_NOT_LEAK",
  });

  try {
    const result = spawnSync(process.execPath, [
      wrapper,
      "--workspace",
      repoRoot,
      "--llm-provider",
      "codex-cli",
      "--qmd-runner",
      "cli",
      "--source-path",
      "source.md",
      "--source-absolute-path",
      source,
      "--vault-root",
      vault,
      "--codex-command",
      codex,
      "--qmd-command",
      qmd,
      "--obsidian-command",
      obsidian,
    ], { encoding: "utf8", timeout: 10000 });

    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /SUPER_SECRET_SHOULD_NOT_LEAK/);
    assert.doesNotMatch(result.stderr, /SUPER_SECRET_SHOULD_NOT_LEAK/);
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.candidates.some((candidate) => String(candidate.notePath).includes("LinkedSecret.md")), false);
  } finally {
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
