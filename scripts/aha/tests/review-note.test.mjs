import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const requireFromPlugin = createRequire(path.join(repoRoot, "obsidian-plugin/package.json"));
const esbuild = requireFromPlugin("esbuild");

test("successful search rounds replace generated blocks without deleting surrounding review content", async () => {
  const reviewNote = await loadReviewNoteModule();
  const initial = reviewNote.makeReviewNoteContent({
    createdAt: new Date("2026-06-28T00:00:00Z"),
    sourceId: "src:test",
    sourcePath: "Source/Insight.md",
    sourceTitle: "Insight",
  }) + "\nManual review note outside generated blocks.\n";

  const first = reviewNote.appendSuccessfulSearchRound(initial, searchRound("2026-06-28T01:00:00Z"));
  const second = reviewNote.appendSuccessfulSearchRound(first, searchRound("2026-06-28T02:00:00Z"));

  assert.match(second, /Manual review note outside generated blocks\./);
  assert.match(second, /# Aha 记忆审阅：Insight/);
  assert.match(second, /## 当前 insight/);
  assert.match(second, /## 搜索结果/);
  assert.equal((second.match(/### 搜索轮次 - /g) ?? []).length, 1);
  assert.equal((second.match(/### 纳入 Handoff 的记忆 - /g) ?? []).length, 1);
  assert.equal((second.match(/### Grill Handoff - /g) ?? []).length, 1);
  assert.doesNotMatch(second, /2026-06-28T01:00:00Z/);
  assert.match(second, /2026-06-28T02:00:00Z/);
  assert.equal(reviewNote.reviewSourceIdFromContent(second), "src:test");
  assert.equal(reviewNote.reviewSourcePathFromContent(second), "Source/Insight.md");
  assert.match(second, /<!-- aha:search-results:start -->/);
  assert.match(second, /<!-- aha:search-results:end -->/);
  assert.match(second, /   - relation: `supports`/);
  assert.match(second, /   - hit: "Evidence quote\."/);
  assert.match(second, /   - why: 这条候选包含能支撑当前 insight 的具体旧判断。/);
  assert.doesNotMatch(second, /还没有完成的搜索轮次/);
  assert.doesNotMatch(second, /检索完成后，Aha 会在这里列出默认纳入 handoff 的候选记忆/);
  assert.doesNotMatch(second, /检索完成后，Aha 会在这里准备可复制的 handoff/);
  assert.doesNotMatch(second, /aha-open-candidate|<button|Open<\/button>/);
});

test("successful search round uses markers when headings are edited", async () => {
  const reviewNote = await loadReviewNoteModule();
  const initial = reviewNote.makeReviewNoteContent({
    createdAt: new Date("2026-06-28T00:00:00Z"),
    sourceId: "src:renamed-heading",
    sourcePath: "Source/Insight.md",
    sourceTitle: "Insight",
  }).replace("## 搜索结果", "## My Search Results");

  const next = reviewNote.appendSuccessfulSearchRound(initial, searchRound("2026-06-28T03:00:00Z"));

  assert.match(next, /## My Search Results/);
  assert.match(next, /### 搜索轮次 - 2026-06-28T03:00:00Z/);
  assert.equal((next.match(/<!-- aha:search-results:start -->/g) ?? []).length, 1);
});

test("candidate aliases do not replace original note file titles", async () => {
  const reviewNote = await loadReviewNoteModule();
  const initial = reviewNote.makeReviewNoteContent({
    createdAt: new Date("2026-06-28T00:00:00Z"),
    sourceId: "src:note-title",
    sourcePath: "Source/Insight.md",
    sourceTitle: "Insight",
  });

  const next = reviewNote.appendSuccessfulSearchRound(initial, {
    ...searchRound("2026-06-28T03:30:00Z"),
    result: {
      ...searchRound("2026-06-28T03:30:00Z").result,
      candidates: [
        {
          notePath: "BOOK/Course/人机交互课程心得.md",
          noteTitle: "V 2",
          relation: "supports",
          hit: "\"具体旧判断。\"",
          why: "这条候选用于确认 panel 和 handoff 不应该擅自改写旧笔记标题。",
          quotes: ["具体旧判断。"],
          selected: true,
        },
      ],
    },
  });

  assert.match(next, /\[\[BOOK\/Course\/人机交互课程心得\]\]/);
  assert.doesNotMatch(next, /\|V 2\]\]/);
  assert.equal(reviewNote.noteDisplayTitleFromPath("BOOK/Course/人机交互课程心得.md"), "人机交互课程心得");
});

test("failed round replaces running status inside search results", async () => {
  const reviewNote = await loadReviewNoteModule();
  const initial = reviewNote.makeReviewNoteContent({
    createdAt: new Date("2026-06-28T00:00:00Z"),
    sourceId: "src:visible-status",
    sourcePath: "Source/Insight.md",
    sourceTitle: "Insight",
  });

  const running = reviewNote.appendRunningSearchRound(initial, new Date("2026-06-28T04:00:00Z"));
  const failed = reviewNote.appendFailureRecord(running, {
    message: "Aha wrapper failed before returning a valid structured result.",
    tool: "wrapper",
    details: "env: node: No such file or directory",
  }, new Date("2026-06-28T04:01:00Z"));

  const searchBlock = failed.slice(
    failed.indexOf("<!-- aha:search-results:start -->"),
    failed.indexOf("<!-- aha:search-results:end -->"),
  );
  assert.doesNotMatch(searchBlock, /### 正在检索 - 2026-06-28T04:00:00\.000Z/);
  assert.match(searchBlock, /### 检索失败 - 2026-06-28T04:01:00\.000Z/);
  assert.match(searchBlock, /env: node: No such file or directory/);
  assert.doesNotMatch(searchBlock, /还没有完成的搜索轮次/);
});

test("latest selected memories can sync checkbox state and handoff text", async () => {
  const reviewNote = await loadReviewNoteModule();
  const initial = reviewNote.makeReviewNoteContent({
    createdAt: new Date("2026-06-28T00:00:00Z"),
    sourceId: "src:panel-sync",
    sourcePath: "Source/Insight.md",
    sourceTitle: "Insight",
  });
  const appended = reviewNote.appendSuccessfulSearchRound(initial, {
    ...searchRound("2026-06-28T05:00:00Z"),
    result: {
      ...searchRound("2026-06-28T05:00:00Z").result,
      candidates: [
        searchRound("2026-06-28T05:00:00Z").result.candidates[0],
        {
          notePath: "Memory/Second.md",
          noteTitle: "Second",
          relation: "challenges",
          hit: "\"Another quote.\"",
          why: "这条候选提供了一个需要保留的反例边界。",
          quotes: ["Another quote."],
          selected: true,
        },
      ],
    },
  });

  const latest = reviewNote.latestSelectedMemoriesRound(appended);
  assert.equal(latest.generatedAt, "2026-06-28T05:00:00Z");
  assert.equal(latest.candidates.length, 2);
  assert.equal(latest.candidates[0].notePath, "Memory/Candidate.md");
  assert.equal(latest.candidates[0].selected, true);

  const synced = reviewNote.syncLatestSelectedMemoriesAndHandoff(
    appended,
    "Source/Insight.md",
    "Insight",
    new Map([[1, false], [2, true]]),
  );

  assert.match(synced.content, /1\. \[ \] \[\[Memory\/Candidate\]\]/);
  assert.match(synced.content, /2\. \[x\] \[\[Memory\/Second\]\]/);
  assert.match(synced.handoff, /纳入 handoff 的旧笔记：/);
  assert.doesNotMatch(synced.handoff, /Memory\/Candidate/);
  assert.match(synced.handoff, /Memory\/Second/);
});

test("review benchmark seeds render and parse draft labels without changing handoff selections", async () => {
  const reviewNote = await loadReviewNoteModule();
  const initial = reviewNote.makeReviewNoteContent({
    createdAt: new Date("2026-06-28T00:00:00Z"),
    sourceId: "src:seed-actions",
    sourcePath: "Source/Insight.md",
    sourceTitle: "Insight",
  });
  const appended = reviewNote.appendSuccessfulSearchRound(initial, searchRound("2026-06-28T07:00:00Z"));
  const candidate = searchRound("2026-06-28T07:00:00Z").result.candidates[0];

  const withAccept = reviewNote.appendReviewBenchmarkSeed(appended, {
    action: "accept",
    createdAt: new Date("2026-06-28T07:01:00Z"),
    sourcePath: "Source/Insight.md",
    sourceTitle: "Insight",
    candidate,
  });
  const withReject = reviewNote.appendReviewBenchmarkSeed(withAccept, {
    action: "reject_as_noise",
    createdAt: new Date("2026-06-28T07:02:00Z"),
    sourcePath: "Source/Insight.md",
    sourceTitle: "Insight",
    candidate: { ...candidate, why: "This candidate is lexical noise, not a useful memory." },
  });
  const withMissing = reviewNote.appendReviewBenchmarkSeed(withReject, {
    action: "should_have_found",
    createdAt: new Date("2026-06-28T07:03:00Z"),
    sourcePath: "Source/Insight.md",
    sourceTitle: "Insight",
    missingMemory: "Memory/Missing.md",
  });

  assert.match(withMissing, /## Review Benchmark Seeds/);
  assert.equal((withMissing.match(/### Review Benchmark Seed - /g) ?? []).length, 3);
  assert.match(withMissing, /- action: `accept`/);
  assert.match(withMissing, /- seed_label: `nice_to_have`/);
  assert.match(withMissing, /- action: `reject_as_noise`/);
  assert.match(withMissing, /- seed_label: `negative`/);
  assert.match(withMissing, /- action: `should_have_found`/);
  assert.match(withMissing, /- seed_label: `must_recall`/);
  assert.match(withMissing, /- memory: \[\[Memory\/Missing\]\]/);

  const latest = reviewNote.latestSelectedMemoriesRound(withMissing);
  assert.equal(latest.candidates.length, 1);
  assert.equal(latest.candidates[0].selected, true);
  const synced = reviewNote.syncLatestSelectedMemoriesAndHandoff(
    withMissing,
    "Source/Insight.md",
    "Insight",
    new Map([[1, false]]),
  );
  assert.match(synced.content, /### Review Benchmark Seed - 2026-06-28T07:01:00\.000Z/);
  assert.match(synced.content, /1\. \[ \] \[\[Memory\/Candidate\]\]/);

  const seeds = reviewNote.parseReviewBenchmarkSeeds(synced.content);
  assert.deepEqual(seeds.map((seed) => [seed.action, seed.seedLabel]), [
    ["accept", "nice_to_have"],
    ["reject_as_noise", "negative"],
    ["should_have_found", "must_recall"],
  ]);
});

test("should-have-found seed can be recorded for a zero-candidate search round", async () => {
  const reviewNote = await loadReviewNoteModule();
  const initial = reviewNote.makeReviewNoteContent({
    createdAt: new Date("2026-06-28T00:00:00Z"),
    sourceId: "src:zero-candidates",
    sourcePath: "Source/Insight.md",
    sourceTitle: "Insight",
  });
  const zeroCandidateRound = reviewNote.appendSuccessfulSearchRound(initial, {
    generatedAt: new Date("2026-06-28T07:10:00Z"),
    sourcePath: "Source/Insight.md",
    sourceTitle: "Insight",
    result: {
      ok: true,
      generatedAt: "2026-06-28T07:10:00.000Z",
      summary: "No candidates found.",
      candidates: [],
    },
  });

  assert.equal(reviewNote.latestSelectedMemoriesRound(zeroCandidateRound).candidates.length, 0);
  const withMissingSeed = reviewNote.appendReviewBenchmarkSeed(zeroCandidateRound, {
    action: "should_have_found",
    createdAt: new Date("2026-06-28T07:11:00Z"),
    sourcePath: "Source/Insight.md",
    sourceTitle: "Insight",
    missingMemory: "Memory/Missing.md",
  });

  assert.match(withMissingSeed, /- action: `should_have_found`/);
  assert.match(withMissingSeed, /- seed_label: `must_recall`/);
  assert.match(withMissingSeed, /- memory: \[\[Memory\/Missing\]\]/);
  assert.equal(reviewNote.parseReviewBenchmarkSeeds(withMissingSeed)[0].seedLabel, "must_recall");
});

test("selection sync prunes legacy selected-memory and handoff rounds", async () => {
  const reviewNote = await loadReviewNoteModule();
  const initial = reviewNote.makeReviewNoteContent({
    createdAt: new Date("2026-06-28T00:00:00Z"),
    sourceId: "src:legacy-prune",
    sourcePath: "Source/Insight.md",
    sourceTitle: "Insight",
  });
  const current = reviewNote.appendSuccessfulSearchRound(initial, searchRound("2026-06-28T06:00:00Z"));
  const legacySelectedRound = [
    "### 纳入 Handoff 的记忆 - 2026-06-28T05:00:00Z",
    "",
    "1. [x] [[Memory/Old]]",
    "   - relation: `weak`",
    "   - hit: old",
    "   - why: old round should be removed",
    "",
  ].join("\n");
  const legacyHandoffRound = [
    "### Grill Handoff - 2026-06-28T05:00:00Z",
    "",
    "当前 insight：[[Source/Insight]]",
    "",
    "纳入 handoff 的旧笔记：",
    "- [[Memory/Old]] (weak): old round should be removed",
    "",
  ].join("\n");
  const legacy = current
    .replace("<!-- aha:selected-memories:start -->\n", `<!-- aha:selected-memories:start -->\n${legacySelectedRound}\n`)
    .replace("<!-- aha:grill-handoff:start -->\n", `<!-- aha:grill-handoff:start -->\n${legacyHandoffRound}\n`);

  const synced = reviewNote.syncLatestSelectedMemoriesAndHandoff(
    legacy,
    "Source/Insight.md",
    "Insight",
    new Map([[1, true]]),
  );

  assert.doesNotMatch(synced.content, /2026-06-28T05:00:00Z/);
  assert.doesNotMatch(synced.content, /Memory\/Old/);
  assert.equal((synced.content.match(/### 纳入 Handoff 的记忆 - /g) ?? []).length, 1);
  assert.equal((synced.content.match(/### Grill Handoff - /g) ?? []).length, 1);
  assert.match(synced.content, /2026-06-28T06:00:00Z/);
});

test("review note matching allows path drift only for filesystem-backed source_id", async () => {
  const reviewNote = await loadReviewNoteModule();
  const content = reviewNote.makeReviewNoteContent({
    createdAt: new Date("2026-06-28T00:00:00Z"),
    sourceId: "src:original",
    sourcePath: "Source/Insight.md",
    sourceTitle: "Insight",
  });
  const filesystemBackedContent = reviewNote.makeReviewNoteContent({
    createdAt: new Date("2026-06-28T00:00:00Z"),
    sourceId: "srcfs:original",
    sourcePath: "Source/Insight.md",
    sourceTitle: "Insight",
  });
  const legacyContent = content.replace(/^source_id:.*\n/m, "");

  assert.equal(reviewNote.reviewNoteMatchesSource(content, "src:original", "Source/Insight.md"), true);
  assert.equal(reviewNote.reviewNoteMatchesSource(content, "src:recreated", "Source/Insight.md"), false);
  assert.equal(reviewNote.reviewNoteMatchesSource(content, "src:original", "Source/Recreated.md"), false);
  assert.equal(reviewNote.reviewNoteMatchesSource(filesystemBackedContent, "srcfs:original", "Source/Renamed.md"), true);
  assert.equal(reviewNote.reviewNoteMatchesSource(legacyContent, "src:recreated", "Source/Insight.md"), true);
});

test("plugin wrapper validator requires structured failure fields", async () => {
  const schema = await loadTsModule("obsidian-plugin/src/schema.ts");
  const validator = await import("../lib/result-validator.mjs");

  const incompletePayload = {
    ok: false,
    error: {
      message: "failed without tool or details",
    },
  };
  const completePayload = {
    ok: false,
    error: {
      message: "Aha retrieval returned no usable candidates.",
      tool: "qmd",
      details: "QMD and Obsidian graph expansion returned no vault-contained candidates.",
    },
  };
  const incomplete = schema.validateAhaWrapperResult(incompletePayload);
  const complete = schema.validateAhaWrapperResult(completePayload);
  const sharedIncomplete = validator.validateAhaResult(incompletePayload);

  assert.equal(incomplete.ok, false);
  assert.deepEqual(incomplete.errors, sharedIncomplete.errors);
  assert.ok(incomplete.errors.some((error) => error.includes("error.tool")));
  assert.ok(incomplete.errors.some((error) => error.includes("error.details")));
  assert.equal(complete.ok, true);
});

test("source identity survives source note edits and renames", async () => {
  const sourceIdentity = await loadTsModule("obsidian-plugin/src/source-identity.ts");
  const before = mockTFile({
    basename: "Original",
    path: "Folder/Original.md",
    ctime: 1782600000000,
    mtime: 1782600000000,
    size: 100,
  });
  const afterEditAndRename = mockTFile({
    basename: "Renamed",
    path: "Other/Renamed.md",
    ctime: 1782600000000,
    mtime: 1782609999999,
    size: 999,
  });

  const filesystemIdentity = { birthtimeMs: 1782600000000, dev: 1, ino: 100 };

  assert.equal(
    sourceIdentity.sourceIdentity(before, filesystemIdentity),
    sourceIdentity.sourceIdentity(afterEditAndRename, filesystemIdentity),
  );
});

test("filesystem-backed source identity separates ctime collisions", async () => {
  const sourceIdentity = await loadTsModule("obsidian-plugin/src/source-identity.ts");
  const first = mockTFile({
    basename: "First",
    path: "Folder/First.md",
    ctime: 1782600000000,
    mtime: 1782600000000,
    size: 100,
  });
  const second = mockTFile({
    basename: "Second",
    path: "Folder/Second.md",
    ctime: 1782600000000,
    mtime: 1782600000000,
    size: 100,
  });
  const firstId = sourceIdentity.sourceIdentity(first, { birthtimeMs: 1782600000000, dev: 1, ino: 100 });
  const secondId = sourceIdentity.sourceIdentity(second, { birthtimeMs: 1782600000000, dev: 1, ino: 101 });

  assert.match(firstId, /^srcfs:[A-Za-z0-9_-]{24}$/);
  assert.notEqual(firstId, secondId);
});

test("source review index key still separates fallback ctime collisions by source path", async () => {
  const sourceIdentity = await loadTsModule("obsidian-plugin/src/source-identity.ts");
  const first = mockTFile({
    basename: "First",
    path: "Folder/First.md",
    ctime: 1782600000000,
    mtime: 1782600000000,
    size: 100,
  });
  const second = mockTFile({
    basename: "Second",
    path: "Folder/Second.md",
    ctime: 1782600000000,
    mtime: 1782600000000,
    size: 100,
  });
  const firstId = sourceIdentity.sourceIdentity(first);
  const secondId = sourceIdentity.sourceIdentity(second);

  assert.equal(firstId, secondId);
  assert.notEqual(
    sourceIdentity.sourceReviewIndexKey(firstId, first.path),
    sourceIdentity.sourceReviewIndexKey(secondId, second.path),
  );
});

async function loadReviewNoteModule() {
  return loadTsModule("obsidian-plugin/src/review-note.ts", obsidianStubPlugin());
}

async function loadTsModule(relativePath, ...plugins) {
  const temp = await mkdtemp(path.join(tmpdir(), "aha-review-note-test-"));
  const entry = path.join(temp, "entry.ts");
  const out = path.join(temp, "bundle.mjs");
  await writeFile(entry, `export * from ${JSON.stringify(path.join(repoRoot, relativePath))};\n`);
  await esbuild.build({
    bundle: true,
    entryPoints: [entry],
    format: "esm",
    outfile: out,
    platform: "node",
    plugins,
    target: "es2022",
  });
  const loaded = await import(`${pathToFileURL(out).href}?cacheBust=${Date.now()}`);
  await rm(temp, { recursive: true, force: true });
  return loaded;
}

function mockTFile({ basename, path, ctime, mtime, size }) {
  return {
    basename,
    path,
    stat: { ctime, mtime, size },
  };
}

function obsidianStubPlugin() {
  return {
    name: "obsidian-stub",
    setup(build) {
      build.onResolve({ filter: /^obsidian$/ }, () => ({ path: "obsidian", namespace: "obsidian-stub" }));
      build.onLoad({ filter: /.*/, namespace: "obsidian-stub" }, () => ({
        contents: "export function normalizePath(value) { return String(value).replace(/\\\\\\\\/g, '/').replace(/\\/+/g, '/'); }",
        loader: "js",
      }));
    },
  };
}

function searchRound(generatedAt) {
  return {
    generatedAt: new Date(generatedAt),
    sourcePath: "Source/Insight.md",
    sourceTitle: "Insight",
    result: {
      ok: true,
      generatedAt,
      sourcePath: "Source/Insight.md",
      summary: "Aha 完成了一轮测试检索。",
      warnings: [],
      candidates: [
        {
          notePath: "Memory/Candidate.md",
          noteTitle: "Candidate",
          relation: "supports",
          hit: "\"Evidence quote.\"",
          why: "这条候选包含能支撑当前 insight 的具体旧判断。",
          quotes: ["Evidence quote."],
          selected: true,
        },
      ],
    },
  };
}
