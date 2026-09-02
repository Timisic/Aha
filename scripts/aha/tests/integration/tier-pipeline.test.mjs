// Tests for tier-pipeline.ts's issue #59 additions: settings.excludedFolders
// parsing and end-to-end threading into a real search round's candidate
// filtering, the query-plan prompt-override hash scheme, and
// traceDirectory-gated Pipeline Trace writing (writes only when configured,
// writes nothing when unset).
//
// tier-pipeline.ts pulls in llm-request.ts (obsidian's requestUrl) even
// though the excludedFolders/trace tests below only exercise the Recall
// Tier path (no LLM call), so this bundles behind a minimal obsidian stub,
// the same pattern process-bridge.test.mjs established.

import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const repoRoot = path.resolve(import.meta.dirname, "../../../..");
const requireFromPlugin = createRequire(path.join(repoRoot, "obsidian-plugin/package.json"));
const esbuild = requireFromPlugin("esbuild");

globalThis.require = createRequire(import.meta.url);

function obsidianStubPlugin() {
  return {
    name: "obsidian-stub",
    setup(build) {
      build.onResolve({ filter: /^obsidian$/ }, () => ({ path: "obsidian", namespace: "obsidian-stub" }));
      build.onLoad({ filter: /.*/, namespace: "obsidian-stub" }, () => ({
        contents: "export async function requestUrl() { return { status: 200, text: '{}' }; }",
        loader: "js",
      }));
    },
  };
}

async function loadModule() {
  const temp = await mkdtemp(path.join(tmpdir(), "aha-tier-pipeline-test-"));
  const entry = path.join(temp, "entry.ts");
  const out = path.join(temp, "bundle.mjs");
  await writeFile(entry, `export * from ${JSON.stringify(path.join(repoRoot, "obsidian-plugin/src/tier-pipeline.ts"))};\n`);
  await esbuild.build({
    bundle: true,
    entryPoints: [entry],
    format: "esm",
    outfile: out,
    platform: "node",
    plugins: [obsidianStubPlugin()],
    target: "es2022",
  });
  const loaded = await import(`${pathToFileURL(out).href}?cacheBust=${Date.now()}`);
  await rm(temp, { recursive: true, force: true });
  return loaded;
}

test("excludedFoldersFromSettings splits on commas and newlines, trims, and drops blanks", async () => {
  const { excludedFoldersFromSettings } = await loadModule();
  assert.deepEqual(excludedFoldersFromSettings("templates"), ["templates"]);
  assert.deepEqual(excludedFoldersFromSettings("templates, Aha/Reviews"), ["templates", "Aha/Reviews"]);
  assert.deepEqual(excludedFoldersFromSettings("templates\nCustomExclude\n"), ["templates", "CustomExclude"]);
  assert.deepEqual(excludedFoldersFromSettings("  , ,templates,  \n\n"), ["templates"]);
  assert.deepEqual(excludedFoldersFromSettings(""), []);
});

test("queryPromptOverrideFromSettings returns undefined for empty/whitespace-only input", async () => {
  const { queryPromptOverrideFromSettings } = await loadModule();
  assert.equal(queryPromptOverrideFromSettings(""), undefined);
  assert.equal(queryPromptOverrideFromSettings("   \n  "), undefined);
});

test("queryPromptOverrideFromSettings computes aha-query-plan-custom-<16 hex chars> from a SHA-256 of the text", async () => {
  const { queryPromptOverrideFromSettings } = await loadModule();
  const crypto = await import("node:crypto");
  const text = "My custom query-plan prompt override.";
  const expectedHash = crypto.createHash("sha256").update(text).digest("hex").slice(0, 16);

  const override = queryPromptOverrideFromSettings(text);
  assert.equal(override.text, text);
  assert.equal(override.version, `aha-query-plan-custom-${expectedHash}`);
  assert.equal(override.version.length, "aha-query-plan-custom-".length + 16);
});

test("queryPromptOverrideFromSettings trims the override text before hashing", async () => {
  const { queryPromptOverrideFromSettings } = await loadModule();
  const a = queryPromptOverrideFromSettings("same text");
  const b = queryPromptOverrideFromSettings("  same text  \n");
  assert.equal(a.version, b.version);
  assert.equal(b.text, "same text");
});

function baseSettings(overrides = {}) {
  return {
    ahaWorkspace: "",
    llmProvider: "deepseek",
    deepseekBaseUrl: "https://api.deepseek.com",
    deepseekModel: "deepseek-v4-pro",
    deepseekApiKey: "",
    deepseekApiKeyEnv: "AHA_TEST_NONEXISTENT_DEEPSEEK_KEY_ENV",
    nodeCommand: "",
    qmdRunner: "cli",
    qmdCommand: "qmd",
    qmdIndex: "obsidian",
    qmdSdkModule: "",
    qmdRerank: false,
    qmdRemoteEmbedUrl: "",
    qmdRemoteEmbedModel: "",
    qmdRemoteGenerateUrl: "",
    qmdRemoteGenerateModel: "",
    qmdRemoteRerankUrl: "",
    qmdRemoteRerankModel: "",
    obsidianCommand: "",
    wrapperRelativePath: "",
    targetCandidates: 20,
    useFixtureResult: false,
    useLegacyWrapper: false,
    qmdEnvironment: "",
    excludedFolders: "templates",
    queryPromptOverride: "",
    traceDirectory: "",
    ...overrides,
  };
}

async function withTestVault(run) {
  const temp = await mkdtemp(path.join(tmpdir(), "aha-tier-pipeline-vault-"));
  const vaultRoot = path.join(temp, "vault");
  await mkdir(path.join(vaultRoot, "Memory"), { recursive: true });
  await mkdir(path.join(vaultRoot, "templates"), { recursive: true });
  await mkdir(path.join(vaultRoot, "CustomExclude"), { recursive: true });
  await writeFile(path.join(vaultRoot, "Memory/Good.md"), "Good old memory.\n");
  await writeFile(path.join(vaultRoot, "templates/Old.md"), "A template, not a real memory.\n");
  await writeFile(path.join(vaultRoot, "CustomExclude/Skip.md"), "Explicitly excluded via settings.\n");
  await writeFile(path.join(vaultRoot, "Source.md"), "The source note under search.\n");

  const fakeQmd = path.join(temp, "qmd.sh");
  await writeFile(fakeQmd, [
    "#!/bin/sh",
    "if [ \"$1\" = \"--version\" ]; then echo 'qmd-test 1.0'; exit 0; fi",
    "echo '[",
    "  {\"file\": \"Memory/Good.md\", \"title\": \"Good\", \"snippet\": \"Good old memory.\", \"score\": 0.9},",
    "  {\"file\": \"templates/Old.md\", \"title\": \"Old\", \"snippet\": \"A template.\", \"score\": 0.8},",
    "  {\"file\": \"CustomExclude/Skip.md\", \"title\": \"Skip\", \"snippet\": \"Explicitly excluded.\", \"score\": 0.7}",
    "]'",
    "",
  ].join("\n"));
  await chmod(fakeQmd, 0o755);

  try {
    await run({ temp, vaultRoot, fakeQmd });
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

function tieredSearchInput({ vaultRoot, settings, traceDirectory }) {
  return {
    settings: { ...settings, traceDirectory: traceDirectory ?? settings.traceDirectory },
    sourceFile: { path: "Source.md", basename: "Source" },
    sourceText: "The source note under search.",
    sourceAbsolutePath: path.join(vaultRoot, "Source.md"),
    vaultRoot,
    reviewPath: "Aha/Reviews/Source-review.md",
    metadataCache: { resolvedLinks: {} },
    readNote: async () => "",
  };
}

test("settings.excludedFolders reaches recall-tier.ts's actual candidate filtering end to end", async () => {
  await withTestVault(async ({ vaultRoot, fakeQmd }) => {
    const { runTieredSearch } = await loadModule();
    const settings = baseSettings({ qmdCommand: fakeQmd, excludedFolders: "templates,CustomExclude" });
    const outcome = await runTieredSearch(tieredSearchInput({ vaultRoot, settings }));

    assert.equal(outcome.tier, "recall");
    const paths = outcome.result.candidates.map((candidate) => candidate.notePath);
    assert.deepEqual(paths, ["Memory/Good.md"]);
    assert.ok(!paths.includes("templates/Old.md"));
    assert.ok(!paths.includes("CustomExclude/Skip.md"));
  });
});

test("the default excludedFolders (\"templates\") excludes templates but not other custom folders", async () => {
  await withTestVault(async ({ vaultRoot, fakeQmd }) => {
    const { runTieredSearch } = await loadModule();
    const settings = baseSettings({ qmdCommand: fakeQmd, excludedFolders: "templates" });
    const outcome = await runTieredSearch(tieredSearchInput({ vaultRoot, settings }));

    const paths = outcome.result.candidates.map((candidate) => candidate.notePath);
    assert.ok(paths.includes("CustomExclude/Skip.md"));
    assert.ok(!paths.includes("templates/Old.md"));
  });
});

test("with traceDirectory set, a search round writes a schema-valid trace with plugin origin", async () => {
  await withTestVault(async ({ vaultRoot, fakeQmd, temp }) => {
    const { runTieredSearch } = await loadModule();
    const traceDirectory = path.join(temp, "traces");
    const settings = baseSettings({ qmdCommand: fakeQmd, traceDirectory });
    const outcome = await runTieredSearch(tieredSearchInput({ vaultRoot, settings }));

    const files = await readdir(traceDirectory);
    assert.equal(files.length, 1);
    assert.ok(files[0].endsWith(".json"));
    const trace = JSON.parse(await readFile(path.join(traceDirectory, files[0]), "utf-8"));
    assert.equal(trace.schema, "PipelineTrace");
    assert.equal(trace.origin, "plugin");
    assert.equal(trace.case.id, "Source.md");
    assert.equal(trace.steps.query_generation.generated_by, "rules");
    assert.equal(outcome.result.trace.path, path.join(traceDirectory, files[0]));
  });
});

test("QMD slug paths resolve to actual notes before source filtering and judging", async () => {
  await withTestVault(async ({ vaultRoot, fakeQmd }) => {
    await writeFile(path.join(vaultRoot, "Memory/Old Note.md"), "An old note with concrete practice and feedback experiences.");
    await writeFile(fakeQmd, '#!/bin/sh\necho \'[{"file":"qmd://obsidian/Memory/Old-Note.md","score":1},{"file":"qmd://obsidian/Source.md","score":0.9}]\'\n');
    const { runTieredSearch } = await loadModule();
    const outcome = await runTieredSearch(tieredSearchInput({ vaultRoot, settings: baseSettings({ qmdCommand: fakeQmd }) }));
    assert.equal(outcome.result.ok, true);
    assert.deepEqual(outcome.result.candidates.map(c => c.notePath), ["Memory/Old Note.md"]);
  });
});

test("with traceDirectory unset, a search round writes nothing (no filesystem writes at all)", async () => {
  await withTestVault(async ({ vaultRoot, fakeQmd, temp }) => {
    const { runTieredSearch } = await loadModule();
    const traceDirectory = path.join(temp, "traces-never-created");
    const settings = baseSettings({ qmdCommand: fakeQmd, traceDirectory: "" });
    await runTieredSearch(tieredSearchInput({ vaultRoot, settings }));

    await assert.rejects(readdir(traceDirectory), /ENOENT/);
  });
});

test("trace write failure is visible but does not discard a successful search", async () => {
  await withTestVault(async ({ vaultRoot, fakeQmd, temp }) => {
    const { runTieredSearch } = await loadModule();
    const traceDirectory = path.join(temp, "not-a-directory");
    await writeFile(traceDirectory, "existing file");
    const settings = baseSettings({ qmdCommand: fakeQmd, traceDirectory });
    const outcome = await runTieredSearch(tieredSearchInput({ vaultRoot, settings }));
    assert.equal(outcome.result.ok, true);
    assert.ok(outcome.result.candidates.length > 0);
    assert.ok(outcome.result.warnings.some(w => w.startsWith("Pipeline trace write failed:")));
  });
});

// Bundles a smarter obsidian stub whose fake requestUrl inspects the
// DeepSeek chat-completions request body and returns a query-plan or
// relation-judge response depending on prompt content -- unlike the always-
// "{}" stub loadModule() above uses (sufficient for the Recall-Tier-only
// tests above, which never actually call requestUrl). Needed to reach Full
// Tier and exercise orchestratorDeps.listGraphNeighbors end to end (issue:
// Full Tier previously never wired this dep, so graph-expansion candidates
// silently never reached plugin users even though core supported it).
async function loadModuleWithLlmStub() {
  const temp = await mkdtemp(path.join(tmpdir(), "aha-tier-pipeline-llm-test-"));
  const entry = path.join(temp, "entry.ts");
  const out = path.join(temp, "bundle.mjs");
  await writeFile(entry, `export * from ${JSON.stringify(path.join(repoRoot, "obsidian-plugin/src/tier-pipeline.ts"))};\n`);
  await esbuild.build({
    bundle: true,
    entryPoints: [entry],
    format: "esm",
    outfile: out,
    platform: "node",
    plugins: [{
      name: "obsidian-stub-llm",
      setup(build) {
        build.onResolve({ filter: /^obsidian$/ }, () => ({ path: "obsidian", namespace: "obsidian-stub-llm" }));
        build.onLoad({ filter: /.*/, namespace: "obsidian-stub-llm" }, () => ({
          contents: [
            "export async function requestUrl(options) {",
            "  const parsed = JSON.parse(options.body || '{}');",
            "  const prompt = parsed.messages?.[0]?.content || '';",
            "  const isQueryPlan = prompt.includes('检索查询生成');",
            "  const output = isQueryPlan",
            "    ? { queries: [",
            "        { kind: 'raw', command: 'qmd query', text: 'raw', qmd: { intent: 'raw', lex: ['old'], vec: 'old memory', hyde: 'an old note' } },",
            "        { kind: 'abstracted_judgment', command: 'qmd query', text: 'abstracted', qmd: { intent: 'abstracted', lex: ['judgment'], vec: 'judgment', hyde: 'an old note' } },",
            "        { kind: 'contextual', command: 'qmd query', text: 'context', qmd: { intent: 'context', lex: ['context'], vec: 'context', hyde: 'an old note' } },",
            "      ] }",
            "    : { ok: true, sourcePath: 'Source.md', generatedAt: null, summary: 'judge ok', warnings: [], error: null,",
            "        candidates: JSON.parse(prompt.slice(prompt.lastIndexOf('candidates:') + 'candidates:'.length).trim()).map((c) => ({",
            "          notePath: c.notePath, noteTitle: c.noteTitle, relation: 'supports',",
            "          hit: '\\\"' + String(c.excerpt || '').slice(0, 20) + '\\\"', why: '这段具体证据直接回应眼下的判断，因此值得优先纳入进一步思考。',",
            "          quotes: [String(c.excerpt || '').slice(0, 20)], selected: true,",
            "        })) };",
            "  return { status: 200, text: JSON.stringify({ choices: [{ message: { role: 'assistant', content: JSON.stringify(output) } }] }) };",
            "}",
          ].join('\n'),
          loader: "js",
        }));
      },
    }],
    target: "es2022",
  });
  const loaded = await import(`${pathToFileURL(out).href}?cacheBust=${Date.now()}`);
  await rm(temp, { recursive: true, force: true });
  return loaded;
}

test("Full Tier surfaces Obsidian graph-expansion (backlink) candidates via orchestratorDeps.listGraphNeighbors", async () => {
  await withTestVault(async ({ vaultRoot, fakeQmd }) => {
    await writeFile(path.join(vaultRoot, "Memory/Linked.md"), "A backlinked old note with a durable judgment worth surfacing.\n");

    const { runTieredSearch } = await loadModuleWithLlmStub();
    const settings = baseSettings({
      qmdCommand: fakeQmd,
      deepseekApiKey: "test-key",
      deepseekApiKeyEnv: "",
    });
    const input = tieredSearchInput({ vaultRoot, settings });
    // Memory/Linked.md links to Source.md, i.e. it is a backlink of the source note.
    input.metadataCache = { resolvedLinks: { "Memory/Linked.md": { "Source.md": 1 } } };
    // The default tieredSearchInput's readNote always returns "", which would
    // fail core's isSubstantiveExcerpt (30-char floor) for every candidate.
    input.readNote = (absolutePath) => readFile(absolutePath, "utf-8");

    const outcome = await runTieredSearch(input);

    assert.equal(outcome.tier, "full");
    assert.equal(outcome.result.ok, true);
    const paths = outcome.result.candidates.map((candidate) => candidate.notePath);
    assert.ok(paths.includes("Memory/Linked.md"), `expected backlink candidate Memory/Linked.md in ${JSON.stringify(paths)}`);
  });
});
