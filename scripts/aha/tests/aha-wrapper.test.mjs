import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { validateAhaResult } from "../lib/aha-result-schema.mjs";
import { notePathForObsidian, normalizeNoteIdentity, sameNotePath } from "../lib/note-identity.mjs";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const wrapper = path.join(repoRoot, "scripts/aha/aha-wrapper.mjs");

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

test("readiness reports missing tools clearly", async () => {
  const result = spawnSync(process.execPath, [
    wrapper,
    "--check-readiness",
    "--workspace",
    repoRoot,
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
  await mkdir(vault, { recursive: true });
  await writeFile(source, "# Source\n\nA current insight with enough text for query planning.");
  await writeSafeCandidate(vault);
  await writePipelineHelpers({ codex, qmd, obsidian, relationJudge: "fail" });

  try {
    const result = spawnSync(process.execPath, [
      wrapper,
      "--workspace",
      repoRoot,
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
    ], { encoding: "utf8", env: { ...process.env, QMD_N_LOG: qmdLog }, timeout: 10000 });

    assert.equal(result.status, 2, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, false);
    assert.equal(output.error.tool, "codex");
    assert.match(output.error.message, /Relation Judge/);
    assert.ok(output.candidates.length > 0);
    const qmdCounts = (await readFile(qmdLog, "utf8")).trim().split(/\r?\n/);
    assert.ok(qmdCounts.length >= 3);
    assert.ok(qmdCounts.every((value) => value === "20"));
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

async function writeSafeCandidate(vault) {
  const candidate = path.join(vault, "Memory/Candidate.md");
  await mkdir(path.dirname(candidate), { recursive: true });
  await writeFile(candidate, "# Candidate\n\nSafe vault evidence.");
}

async function writePipelineHelpers({ codex, qmd, obsidian, relationJudge, outsidePath = "", outsideSnippet = "outside snippet", noCandidates = false }) {
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
    "    { kind: 'contextual', command: 'qmd vsearch', qmd: { intent: 'context', lex: ['context'], vec: 'context relation', hyde: 'old note about context relation' } }",
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
    "import { appendFileSync } from 'node:fs';",
    "const args = process.argv.slice(2);",
    "if (args.includes('--version')) { console.log('qmd-test 1.0'); process.exit(0); }",
    "const nIndex = args.indexOf('-n');",
    "if (process.env.QMD_N_LOG && nIndex !== -1) appendFileSync(process.env.QMD_N_LOG, `${args[nIndex + 1]}\\n`);",
    "if (args.includes('get')) { console.log('qmd://obsidian/Memory/Candidate.md?index=obsidian\\n---\\n# Candidate\\nSafe vault evidence.'); process.exit(0); }",
    noCandidates
      ? "console.log('[]');"
      : [
          "console.log(JSON.stringify([",
          outsidePath
            ? `  { score: 0.99, file: ${JSON.stringify(outsidePath)}, title: 'Secret', snippet: ${JSON.stringify(outsideSnippet)} },`
            : "",
          "  { score: 0.91, file: 'qmd://obsidian/Memory/Candidate.md?index=obsidian', title: 'Candidate', snippet: '\"Safe vault evidence.\"' }",
          "]));",
        ].filter((line) => line !== "").join("\n"),
    "",
  ].filter((line) => line !== "").join("\n"));

  await writeFile(obsidian, [
    "#!/usr/bin/env node",
    "const args = process.argv.slice(2);",
    "if (args[0] === 'files' && args[1] === 'total') { console.log('1'); process.exit(0); }",
    "if (args[0] === 'links' || args[0] === 'backlinks') { console.log('[]'); process.exit(0); }",
    "console.log('ok');",
    "",
  ].join("\n"));

  await Promise.all([codex, qmd, obsidian].map((file) => chmod(file, 0o755)));
}
