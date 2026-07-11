import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { validateAhaResult } from "../lib/result-validator.mjs";
import { notePathForObsidian, normalizeNoteIdentity, sameNotePath } from "../lib/note-identity.mjs";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const wrapper = path.join(repoRoot, "scripts/aha/run-insight-search.mjs");

test("OpenAI retry budget preserves a full first attempt when the total cap permits it", () => {
  const script = [
    `import { openAiAttemptDeadline, openAiRetryBudgetMs } from ${JSON.stringify(pathToFileURL(wrapper).href)};`,
    "const now = 1_000_000;",
    "const queryTotal = openAiRetryBudgetMs(60_000, 900_000);",
    "const relationTotal = openAiRetryBudgetMs(120_000, 900_000);",
    "const shortTotal = openAiRetryBudgetMs(1_000, 900);",
    "console.log(JSON.stringify({",
    "  queryTotal,",
    "  queryFirst: openAiAttemptDeadline(now + queryTotal, 60_000, 3, now) - now,",
    "  relationTotal,",
    "  relationFirst: openAiAttemptDeadline(now + relationTotal, 120_000, 3, now) - now,",
    "  shortTotal,",
    "  shortFirst: openAiAttemptDeadline(now + shortTotal, 1_000, 3, now) - now,",
    "}));",
  ].join("\n");
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script], { encoding: "utf8" });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    queryTotal: 181_000,
    queryFirst: 60_000,
    relationTotal: 361_000,
    relationFirst: 120_000,
    shortTotal: 900,
    shortFirst: 300,
  });
});

test("wrapper remains executable when launched through a symlink", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "aha-wrapper-link-"));
  const linkedWrapper = path.join(temp, "aha-wrapper");
  await symlink(wrapper, linkedWrapper);

  try {
    const result = spawnSync(process.execPath, [
      linkedWrapper,
      "--workspace",
      repoRoot,
      "--source-path",
      "source.md",
      "--fixture",
      path.join(repoRoot, "scripts/aha/fixtures/stub-result.json"),
    ], { encoding: "utf8" });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).ok, true);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

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
    assert.equal(result.status, 0, result.stderr);
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

test("readiness reports missing OpenAI key without requiring Codex CLI", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "aha-wrapper-openai-readiness-"));
  const helper = path.join(temp, "ok-command.mjs");
  await writeOkCommand(helper);

  try {
    const env = { ...process.env };
    delete env.AHA_TEST_OPENAI_KEY;
    const result = spawnSync(process.execPath, [
      wrapper,
      "--check-readiness",
      "--workspace",
      repoRoot,
      "--llm-provider",
      "openai",
      "--qmd-runner",
      "cli",
      "--llm-api-key-env",
      "AHA_TEST_OPENAI_KEY",
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
    assert.ok(output.checks.some((check) => check.name === "OpenAI API key" && !check.ok && check.message.includes("AHA_TEST_OPENAI_KEY")));
    assert.equal(output.checks.some((check) => check.name === "Codex CLI"), false);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("wrapper defaults to OpenAI key and QMD SDK readiness", async () => {
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
      "AHA_TEST_OPENAI_KEY",
      "--codex-command",
      "/definitely/missing/codex",
      "--qmd-sdk-module",
      sdkModule,
      "--qmd-command",
      "/definitely/missing/qmd",
      "--obsidian-command",
      helper,
    ], { encoding: "utf8", env: { ...process.env, AHA_TEST_OPENAI_KEY: "test-key" }, timeout: 10000 });

    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, true);
    assert.ok(output.checks.some((check) => check.name === "OpenAI API key" && check.ok));
    assert.ok(output.checks.some((check) => check.name === "QMD SDK" && check.ok));
    assert.equal(output.checks.some((check) => check.name === "Codex CLI"), false);
    assert.equal(output.checks.some((check) => check.name === "QMD CLI"), false);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("pipeline can use OpenAI structured output provider", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "aha-wrapper-openai-"));
  const vault = path.join(temp, "vault");
  const source = path.join(vault, "source.md");
  const codex = path.join(temp, "codex-helper.mjs");
  const qmd = path.join(temp, "qmd-helper.mjs");
  const obsidian = path.join(temp, "obsidian-helper.mjs");
  await mkdir(vault, { recursive: true });
  await writeFile(source, "# Source\n\nA current insight with enough text for OpenAI query planning.");
  await writeSafeCandidate(vault);
  await writePipelineHelpers({ codex, qmd, obsidian, relationJudge: "success" });
  const requests = [];
  const server = await startOpenAiFixtureServer(requests);

  try {
    const result = await spawnNode([
      wrapper,
      "--workspace",
      repoRoot,
      "--llm-provider",
      "openai",
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
      "gpt-test",
      "--llm-api-key-env",
      "AHA_TEST_OPENAI_KEY",
      "--codex-command",
      "/definitely/missing/codex",
      "--qmd-command",
      qmd,
      "--obsidian-command",
      obsidian,
    ], { env: withoutProxyEnv({ ...process.env, AHA_TEST_OPENAI_KEY: "test-key" }), timeout: 10000 });

    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.candidates[0].notePath, "Memory/Candidate.md");
    assert.equal(requests.length, 2);
    assert.ok(requests.every((request) => request.headers.authorization === "Bearer test-key"));
    assert.ok(requests.every((request) => request.body.model === "gpt-test"));
    assert.ok(requests.every((request) => request.body.text?.format?.type === "json_schema"));
    const relationJudgePrompt = String(requests[1].body.input ?? "");
    assert.match(relationJudgePrompt, /Avoid formulaic openings/);
    assert.match(relationJudgePrompt, /Do not reuse the same sentence frame/);
  } finally {
    await server.close();
    await rm(temp, { recursive: true, force: true });
  }
});

test("product OpenAI runtime retries a transient 429 and then succeeds", async () => {
  const { result, requests } = await runOpenAiFixturePipeline({
    failFirstQueryPlan: true,
    firstQueryPlanStatus: 429,
  });

  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.ok, true);
  assert.equal(requests.length, 3);
  assert.equal(queryPlanRequests(requests).length, 2);
  assert.equal(output.warnings.some((warning) => warning.includes("fallback")), false);
  assert.deepEqual(openAiTransportFor(output.trace.steps.query_generation), {
    request_count: 1,
    attempt_count: 2,
    retry_count: 1,
    retry_categories: { http_429: 1 },
  });
  assert.deepEqual(openAiTransportFor(output.trace.steps.relation_judge), {
    request_count: 1,
    attempt_count: 1,
    retry_count: 0,
    retry_categories: {},
  });
});

test("product OpenAI runtime honors Retry-After within the shared request deadline", async () => {
  const { result, requests } = await runOpenAiFixturePipeline({
    failFirstQueryPlan: true,
    firstQueryPlanStatus: 429,
    firstQueryPlanRetryAfter: "1",
    timeoutMs: 3_000,
  });

  assert.equal(result.status, 0, result.stderr);
  const queryRequests = queryPlanRequests(requests);
  assert.equal(queryRequests.length, 2);
  assert.ok(
    queryRequests[1].receivedAt - queryRequests[0].receivedAt >= 900,
    "expected Retry-After delay between attempts",
  );
  const output = JSON.parse(result.stdout);
  assert.equal(output.trace.steps.query_generation.retry_categories.http_429, 1);
});

test("product OpenAI runtime does not retry permanent insufficient_quota 429", async () => {
  const { result, requests } = await runOpenAiFixturePipeline({ quotaFirstQueryPlan: true });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(queryPlanRequests(requests).length, 1);
  const output = JSON.parse(result.stdout);
  assert.ok(output.warnings.some((warning) => warning.includes("Query plan generated by codex after fallback")));
  assert.deepEqual(openAiTransportFor(output.trace.steps.query_generation), {
    request_count: 1,
    attempt_count: 1,
    retry_count: 0,
    retry_categories: {},
  });
});

test("product OpenAI relation stall retries within one shared deadline", async () => {
  const { result, requests, elapsedMs } = await runOpenAiFixturePipeline({
    stallRelationMs: 2_000,
    timeoutMs: 1_000,
  });

  assert.equal(result.status, 2, result.stderr);
  assert.ok(elapsedMs < 4_000, `expected structured failure before outer timeout, got ${elapsedMs}ms`);
  assert.ok(
    requests.filter((request) => !String(request.body.input || "").includes("检索查询生成")).length >= 2,
    "expected a bounded retry after the first stalled relation request",
  );
  const output = JSON.parse(result.stdout);
  assert.equal(output.ok, false);
  assert.equal(output.trace.status, "failed");
  assert.equal(output.trace.steps.relation_judge.status, "failed");
  assert.equal(output.trace.steps.relation_judge.request_count, 1);
  assert.ok(output.trace.steps.relation_judge.attempt_count >= 2);
  assert.ok(output.trace.steps.relation_judge.retry_count >= 1);
  assert.ok(output.trace.steps.relation_judge.retry_categories.timeout >= 1);
  assert.equal(output.trace.steps.relation_judge.errors[0].category, "timeout");
});

test("product OpenAI slow response stream retries without escaping the absolute deadline", async () => {
  const { result, requests, elapsedMs } = await runOpenAiFixturePipeline({
    trickleRelationIntervalMs: 50,
    trickleRelationChunks: 12,
    timeoutMs: 1_000,
  });

  assert.equal(result.status, 2, result.stderr);
  assert.ok(elapsedMs < 4_000, `expected the response stream deadline to stay bounded, got ${elapsedMs}ms`);
  assert.ok(
    requests.filter((request) => !String(request.body.input || "").includes("检索查询生成")).length >= 2,
    "expected a bounded retry after the first slow response stream",
  );
  const output = JSON.parse(result.stdout);
  assert.equal(output.trace.steps.relation_judge.status, "failed");
  assert.ok(output.trace.steps.relation_judge.retry_categories.timeout >= 1);
  assert.equal(output.trace.steps.relation_judge.errors[0].category, "timeout");
});

test("product OpenAI timeout does not duplicate a stalled HTTPS attempt through curl", async () => {
  const proxy = await startStalledConnectProxy();
  try {
    const { result } = await runOpenAiFixturePipeline({
      httpsProxyUrl: proxy.url,
      llmBaseUrl: "https://api.openai.invalid/v1",
      timeoutMs: 1_200,
    });

    assert.equal(result.status, 2, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.deepEqual(openAiTransportFor(output.trace.steps.query_generation), {
      request_count: 1,
      attempt_count: 2,
      retry_count: 1,
      retry_categories: { timeout: 1 },
    });
    assert.deepEqual(openAiTransportFor(output.trace.steps.relation_judge), {
      request_count: 1,
      attempt_count: 2,
      retry_count: 1,
      retry_categories: { timeout: 1 },
    });
    assert.equal(proxy.connectCount, 4, "expected one CONNECT per outer attempt, without curl duplication");
  } finally {
    await proxy.close();
  }
});

test("product OpenAI macOS proxy discovery stays inside the LLM deadline", {
  skip: process.platform !== "darwin",
}, async () => {
  const { result, elapsedMs } = await runOpenAiFixturePipeline({
    systemProxyLookupStallMs: 5_000,
    timeoutMs: 600,
  });

  assert.equal(result.status, 0, result.stderr);
  assert.ok(elapsedMs < 3_500, `expected proxy discovery to share the LLM deadline, got ${elapsedMs}ms`);
  const output = JSON.parse(result.stdout);
  assert.equal(output.trace.steps.relation_judge.status, "success");
});

test("product OpenAI exhausted retries stay structured and privacy bounded", async () => {
  const privateError = "PRIVATE_OPENAI_RETRY_BODY";
  const { result, requests } = await runOpenAiFixturePipeline({
    failRelationStatus: 500,
    failRelationBody: privateError,
  });

  assert.equal(result.status, 2, result.stderr);
  assert.equal(requests.filter((request) => !String(request.body.input || "").includes("检索查询生成")).length, 3);
  const output = JSON.parse(result.stdout);
  assert.equal(output.ok, false);
  assert.deepEqual(openAiTransportFor(output.trace.steps.relation_judge), {
    request_count: 1,
    attempt_count: 3,
    retry_count: 2,
    retry_categories: { http_5xx: 2 },
  });
  assert.ok(!result.stdout.includes(privateError));
});

test("product OpenAI runtime does not retry a malformed successful payload", async () => {
  const privateBody = "PRIVATE_OPENAI_MISSING_OUTPUT_BODY";
  const { result, requests } = await runOpenAiFixturePipeline({
    malformedFirstQueryPlan: true,
    privateContractMarker: privateBody,
  });

  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.ok, true);
  assert.equal(requests.length, 2);
  assert.equal(queryPlanRequests(requests).length, 1);
  assert.ok(output.warnings.some((warning) => warning.includes("Query plan generated by codex after fallback")));
  assert.ok(output.warnings.some((warning) => warning.includes("OpenAI API response did not include structured output.")));
  assert.ok(!result.stdout.includes(privateBody));
});

test("product OpenAI runtime keeps invalid 2xx JSON private and does not retry it", async () => {
  const privateBody = "PRIVATE_OPENAI_INVALID_JSON_BODY";
  const { result, requests } = await runOpenAiFixturePipeline({
    invalidJsonFirstQueryPlan: true,
    privateContractMarker: privateBody,
  });

  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.ok, true);
  assert.equal(queryPlanRequests(requests).length, 1);
  assert.ok(output.warnings.some((warning) => warning.includes("OpenAI API returned invalid JSON.")));
  assert.ok(!result.stdout.includes(privateBody));
});

test("pipeline trace is opt-in, privacy-bounded, and aligned with the shipped result order", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "aha-wrapper-trace-"));
  const vault = path.join(temp, "vault");
  const source = path.join(vault, "source.md");
  const codex = path.join(temp, "codex-helper.mjs");
  const qmd = path.join(temp, "qmd-helper.mjs");
  const obsidian = path.join(temp, "obsidian-helper.mjs");
  const privateSourceMarker = "TRACE_PRIVATE_SOURCE_BODY";
  const privateCandidateMarker = "TRACE_PRIVATE_CANDIDATE_BODY";
  await mkdir(path.join(vault, "Memory"), { recursive: true });
  await writeFile(source, `# Source\n\n${privateSourceMarker}`);
  await writeFile(path.join(vault, "Memory/Candidate.md"), `# Candidate\n\n${privateCandidateMarker}`);
  await writePipelineHelpers({ codex, qmd, obsidian, relationJudge: "success" });

  const baseArgs = [
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
  ];

  try {
    const defaultRun = spawnSync(process.execPath, baseArgs, { encoding: "utf8", timeout: 10000 });
    assert.equal(defaultRun.status, 0, defaultRun.stderr);
    const defaultOutput = JSON.parse(defaultRun.stdout);
    assert.equal(Object.hasOwn(defaultOutput, "trace"), false);

    const tracedRun = spawnSync(process.execPath, [...baseArgs, "--trace"], { encoding: "utf8", timeout: 10000 });
    assert.equal(tracedRun.status, 0, tracedRun.stderr);
    const tracedOutput = JSON.parse(tracedRun.stdout);
    assert.equal(tracedOutput.trace.schema, "PipelineTrace");
    assert.equal(tracedOutput.trace.version, 2);
    assert.equal(tracedOutput.trace.profile, "product-runtime");
    assert.equal(tracedOutput.trace.status, "success");
    assert.deepEqual(
      tracedOutput.trace.steps.final_candidates.map((candidate) => candidate.file),
      tracedOutput.candidates.map((candidate) => candidate.notePath),
    );
    assert.ok(tracedOutput.trace.steps.qmd_runs.length > 0);
    assert.ok(tracedOutput.trace.steps.pre_judge_candidates.length > 0);
    assert.equal(typeof tracedOutput.trace.steps.query_generation.queries[0].query_hash, "string");

    const serializedTrace = JSON.stringify(tracedOutput.trace);
    assert.doesNotMatch(serializedTrace, new RegExp(privateSourceMarker));
    assert.doesNotMatch(serializedTrace, new RegExp(privateCandidateMarker));
    assert.doesNotMatch(serializedTrace, new RegExp(escapeRegExp(vault)));
    assert.doesNotMatch(serializedTrace, /Safe vault evidence/);
    assert.equal(hasForbiddenTraceKey(tracedOutput.trace), false);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("pipeline relation-judge failure returns a privacy-bounded partial trace", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "aha-wrapper-failure-trace-"));
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
      "--trace",
    ], { encoding: "utf8", timeout: 10000 });

    assert.equal(result.status, 2, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, false);
    assert.equal(output.trace.status, "failed");
    assert.equal(output.trace.errors.at(-1).stage, "relation_judge");
    assert.ok(output.trace.steps.qmd_runs.length > 0);
    assert.ok(output.trace.steps.pre_judge_candidates.length > 0);
    assert.deepEqual(
      output.trace.steps.final_candidates.map((candidate) => candidate.file),
      output.candidates.map((candidate) => candidate.notePath),
    );
    assert.doesNotMatch(JSON.stringify(output.trace), /judge failed intentionally/);
    assert.doesNotMatch(JSON.stringify(output.trace), new RegExp(escapeRegExp(vault)));
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("pipeline does not retry OpenAI 401 and uses Codex CLI query-plan fallback", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "aha-wrapper-openai-plan-fallback-"));
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
  const server = await startOpenAiFixtureServer(requests, {
    failFirstQueryPlan: true,
    firstQueryPlanStatus: 401,
  });

  try {
    const result = await spawnNode([
      wrapper,
      "--workspace",
      repoRoot,
      "--llm-provider",
      "openai",
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
      "gpt-test",
      "--llm-api-key-env",
      "AHA_TEST_OPENAI_KEY",
      "--codex-command",
      codex,
      "--qmd-command",
      qmd,
      "--obsidian-command",
      obsidian,
    ], { env: withoutProxyEnv({ ...process.env, AHA_TEST_OPENAI_KEY: "test-key" }), timeout: 10000 });

    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, true);
    assert.ok(output.warnings.some((warning) => warning.includes("Query plan generated by codex after fallback")));
    assert.equal(requests.length, 2);
    assert.equal(queryPlanRequests(requests).length, 1);
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
      "--retrieval-policy",
      "legacy-v1",
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
      "--retrieval-policy",
      "legacy-v1",
    ], { encoding: "utf8", env: { ...process.env, QMD_CALL_LOG: qmdCallLog }, timeout: 10000 });
    const elapsedMs = Date.now() - started;

    assert.equal(result.status, 0, result.stderr);
    assert.ok(elapsedMs >= 750, `expected serial timeout work to take at least three query timeouts, got ${elapsedMs}ms`);
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.candidates.length, 1);
    assert.equal(output.warnings.filter((warning) => warning.includes("timed out after 250ms")).length, 3);
    const qmdCalls = (await readFile(qmdCallLog, "utf8")).trim().split("\n").map((line) => {
      const [time, subcommand] = line.split(":");
      return { time: Number(time), subcommand };
    });
    const planCalls = qmdCalls.filter((call) => call.subcommand !== "get");
    assert.ok(planCalls.length >= 3 && planCalls.length <= 6, `expected bounded query attempts, got ${planCalls.length}`);
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
      "--retrieval-policy",
      "legacy-v1",
    ], { encoding: "utf8", env: { ...process.env, QMD_CALL_LOG: qmdCallLog }, timeout: 10000 });

    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.candidates.length, 1);
    assert.equal(output.warnings.filter((warning) => warning.includes("timed out after 500ms")).length, 3);
    assert.ok(!output.warnings.some((warning) => warning.includes("vsearch fallback")));
    const qmdCalls = (await readFile(qmdCallLog, "utf8")).trim().split("\n").map((line) => line.split(":")[1]);
    assert.deepEqual(qmdCalls.filter((subcommand) => subcommand !== "get"), ["query", "query", "query", "query", "query", "query"]);
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
      "--retrieval-policy",
      "product-v2",
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
    assert.deepEqual(output.candidates, []);
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

function hasForbiddenTraceKey(value) {
  if (Array.isArray(value)) return value.some((item) => hasForbiddenTraceKey(item));
  if (!value || typeof value !== "object") return false;
  const forbidden = new Set(["content", "snippet", "hit", "why", "quotes", "prompt", "query", "qmd", "input"]);
  return Object.entries(value).some(([key, item]) => forbidden.has(key) || hasForbiddenTraceKey(item));
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

async function startOpenAiFixtureServer(requests, options = {}) {
  let failedQueryPlan = false;
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const parsed = JSON.parse(body);
      requests.push({
        url: request.url,
        headers: request.headers,
        body: parsed,
        receivedAt: Date.now(),
      });
      const isQueryPlan = String(parsed.input || "").includes("检索查询生成");
      if (options.quotaFirstQueryPlan && isQueryPlan && !failedQueryPlan) {
        failedQueryPlan = true;
        response.writeHead(429, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: { type: "insufficient_quota", code: "insufficient_quota" } }));
        return;
      }
      if (options.malformedFirstQueryPlan && isQueryPlan && !failedQueryPlan) {
        failedQueryPlan = true;
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ output: [], private: options.privateContractMarker }));
        return;
      }
      if (options.invalidJsonFirstQueryPlan && isQueryPlan && !failedQueryPlan) {
        failedQueryPlan = true;
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(`{"private":${JSON.stringify(options.privateContractMarker)}`);
        return;
      }
      if (options.failFirstQueryPlan && isQueryPlan && !failedQueryPlan) {
        failedQueryPlan = true;
        response.writeHead(options.firstQueryPlanStatus ?? 500, {
          "Content-Type": "application/json",
          ...(options.firstQueryPlanRetryAfter ? { "Retry-After": options.firstQueryPlanRetryAfter } : {}),
        });
        response.end(JSON.stringify({ error: { message: "planned fixture query-plan failure" } }));
        return;
      }
      if (!isQueryPlan && options.failRelationStatus) {
        response.writeHead(options.failRelationStatus, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: { message: options.failRelationBody ?? "planned relation failure" } }));
        return;
      }
      const output = isQueryPlan
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
      const finish = () => {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ output_text: JSON.stringify(output) }));
      };
      if (!isQueryPlan && options.trickleRelationIntervalMs) {
        const serialized = JSON.stringify({ output_text: JSON.stringify(output) });
        const chunkCount = Math.max(2, Number(options.trickleRelationChunks ?? 10));
        const chunkSize = Math.ceil(serialized.length / chunkCount);
        let offset = 0;
        response.writeHead(200, { "Content-Type": "application/json" });
        const timer = setInterval(() => {
          if (response.destroyed || response.writableEnded) {
            clearInterval(timer);
            return;
          }
          const chunk = serialized.slice(offset, offset + chunkSize);
          offset += chunkSize;
          if (chunk) response.write(chunk);
          if (offset >= serialized.length) {
            clearInterval(timer);
            response.end();
          }
        }, options.trickleRelationIntervalMs);
        response.once("close", () => clearInterval(timer));
      } else if (!isQueryPlan && options.stallRelationMs) setTimeout(finish, options.stallRelationMs);
      else finish();
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

async function runOpenAiFixturePipeline(serverOptions) {
  const temp = await mkdtemp(path.join(tmpdir(), "aha-wrapper-openai-retry-"));
  const vault = path.join(temp, "vault");
  const source = path.join(vault, "source.md");
  const codex = path.join(temp, "codex-helper.mjs");
  const qmd = path.join(temp, "qmd-helper.mjs");
  const obsidian = path.join(temp, "obsidian-helper.mjs");
  const requests = [];
  await mkdir(vault, { recursive: true });
  await writeFile(source, "# Source\n\nA current insight with enough text for OpenAI retry coverage.");
  await writeSafeCandidate(vault);
  await writePipelineHelpers({ codex, qmd, obsidian, relationJudge: "success" });
  const server = await startOpenAiFixtureServer(requests, serverOptions);
  try {
    const env = withoutProxyEnv({ ...process.env, AHA_TEST_OPENAI_KEY: "test-key" });
    if (serverOptions.systemProxyLookupStallMs) {
      const proxyBin = path.join(temp, "proxy-bin");
      const scutil = path.join(proxyBin, "scutil");
      await mkdir(proxyBin, { recursive: true });
      await writeFile(scutil, [
        "#!/usr/bin/env node",
        `setTimeout(() => process.exit(0), ${Number(serverOptions.systemProxyLookupStallMs)});`,
        "",
      ].join("\n"));
      await chmod(scutil, 0o755);
      delete env.NO_PROXY;
      delete env.no_proxy;
      env.PATH = `${proxyBin}:${env.PATH ?? ""}`;
    }
    if (serverOptions.httpsProxyUrl) {
      delete env.NO_PROXY;
      delete env.no_proxy;
      env.HTTPS_PROXY = serverOptions.httpsProxyUrl;
      env.https_proxy = serverOptions.httpsProxyUrl;
    }
    const startedAt = Date.now();
    const result = await spawnNode([
      wrapper,
      "--workspace", repoRoot,
      "--llm-provider", "openai",
      "--qmd-runner", "cli",
      "--source-path", "source.md",
      "--source-absolute-path", source,
      "--vault-root", vault,
      "--llm-base-url", serverOptions.llmBaseUrl ?? server.baseUrl,
      "--llm-model", "gpt-test",
      "--llm-api-key-env", "AHA_TEST_OPENAI_KEY",
      "--codex-command", codex,
      "--qmd-command", qmd,
      "--obsidian-command", obsidian,
      "--timeout-ms", String(serverOptions.timeoutMs ?? 5_000),
      "--trace",
    ], { env, timeout: 10000 });
    return { result, requests, elapsedMs: Date.now() - startedAt };
  } finally {
    await server.close();
    await rm(temp, { recursive: true, force: true });
  }
}

async function startStalledConnectProxy() {
  const sockets = new Set();
  let connectCount = 0;
  const server = createServer();
  server.on("connect", (_request, socket) => {
    connectCount += 1;
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return {
    url: `http://127.0.0.1:${address.port}`,
    get connectCount() {
      return connectCount;
    },
    close: () => new Promise((resolve, reject) => {
      for (const socket of sockets) socket.destroy();
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}

function queryPlanRequests(requests) {
  return requests.filter((request) => String(request.body.input || "").includes("检索查询生成"));
}

function openAiTransportFor(step) {
  return {
    request_count: step.request_count,
    attempt_count: step.attempt_count,
    retry_count: step.retry_count,
    retry_categories: step.retry_categories,
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
  await writeFile(candidate, "# Candidate\n\nSafe vault evidence.");
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
