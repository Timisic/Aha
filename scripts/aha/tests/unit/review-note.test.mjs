import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const repoRoot = path.resolve(import.meta.dirname, "../../../..");
const requireFromPlugin = createRequire(path.join(repoRoot, "obsidian-plugin/package.json"));
const esbuild = requireFromPlugin("esbuild");

test("generated block helper replaces marker body and exposes body content", async () => {
  const generatedBlock = await loadTsModule("obsidian-plugin/src/generated-block.ts");
  const original = [
    "# Review",
    "",
    "## Search",
    "",
    "<!-- aha:search-results:start -->",
    "old",
    "<!-- aha:search-results:end -->",
    "",
    "manual note",
  ].join("\n");

  const next = generatedBlock.replaceGeneratedBlock(original, "search-results", "Search", "new body");
  const body = generatedBlock.generatedBlockBody(next, "search-results");

  assert.match(next, /manual note/);
  assert.equal(body?.value.trim(), "new body");
});

test("generated block helper returns the latest matching round section", async () => {
  const generatedBlock = await loadTsModule("obsidian-plugin/src/generated-block.ts");
  const content = [
    "<!-- aha:selected-memories:start -->",
    "### Selected Memories - 2026-06-28T01:00:00Z",
    "",
    "old",
    "",
    "### 纳入 Handoff 的记忆 - 2026-06-28T02:00:00Z",
    "",
    "new",
    "<!-- aha:selected-memories:end -->",
  ].join("\n");

  const latest = generatedBlock.latestRoundSectionInGeneratedBlock(content, "selected-memories", ["纳入 Handoff 的记忆", "Selected Memories"]);

  assert.equal(latest?.generatedAt, "2026-06-28T02:00:00Z");
  assert.match(latest?.text ?? "", /new/);
  assert.doesNotMatch(latest?.text ?? "", /old/);
});

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

test("human-edited content immediately touching every marker pair survives a round trip across search results, failure, and benchmark seed appends (issue #58)", async () => {
  const reviewNote = await loadReviewNoteModule();
  const markerNames = ["search-results", "selected-memories", "review-benchmark-seeds", "grill-handoff"];
  let humanNote = reviewNote.makeReviewNoteContent({
    createdAt: new Date("2026-06-28T00:00:00Z"),
    sourceId: "src:marker-adjacency",
    sourcePath: "Source/Insight.md",
    sourceTitle: "Insight",
  });
  for (const marker of markerNames) {
    humanNote = humanNote
      .replace(`<!-- aha:${marker}:start -->`, `Human note directly before the ${marker} marker.\n\n<!-- aha:${marker}:start -->`)
      .replace(`<!-- aha:${marker}:end -->`, `<!-- aha:${marker}:end -->\n\nHuman note directly after the ${marker} marker.`);
  }

  const afterSuccess = reviewNote.appendSuccessfulSearchRound(humanNote, searchRound("2026-06-28T10:00:00Z"));
  const afterFailure = reviewNote.appendFailureRecord(afterSuccess, {
    message: "Aha Relation Judge failed.",
    tool: "llm",
    details: "LLM call failed after 3 attempts.",
  }, new Date("2026-06-28T10:05:00Z"));
  const candidate = searchRound("2026-06-28T10:00:00Z").result.candidates[0];
  const afterSeed = reviewNote.appendReviewBenchmarkSeed(afterFailure, {
    action: "accept",
    createdAt: new Date("2026-06-28T10:06:00Z"),
    sourcePath: "Source/Insight.md",
    sourceTitle: "Insight",
    candidate,
  });

  for (const marker of markerNames) {
    assert.match(afterSeed, new RegExp(`Human note directly before the ${marker} marker\\.`), `before-text for ${marker} must survive`);
    assert.match(afterSeed, new RegExp(`Human note directly after the ${marker} marker\\.`), `after-text for ${marker} must survive`);
  }
  // Sanity: the generated content inside the markers actually changed across
  // these operations, so the above is not a vacuous no-op test.
  assert.doesNotMatch(afterSeed, /还没有完成的搜索轮次/);
  assert.match(afterSeed, /### 检索失败 - 2026-06-28T10:05:00\.000Z/);
  assert.match(afterSeed, /### 纳入 Handoff 的记忆 - 2026-06-28T10:00:00Z/);
  assert.match(afterSeed, /### Review Benchmark Seed - 2026-06-28T10:06:00\.000Z/);
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
          notePath: "BOOK/Course/example-course-note.md",
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

  assert.match(next, /\[\[BOOK\/Course\/example-course-note\]\]/);
  assert.doesNotMatch(next, /\|V 2\]\]/);
  assert.equal(reviewNote.noteDisplayTitleFromPath("BOOK/Course/example-course-note.md"), "example-course-note");
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
  const validator = await import("../../lib/result-validator.mjs");

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

test("plugin command names rely on Obsidian for the Aha palette prefix", async () => {
  const commands = await loadTsModule("obsidian-plugin/src/commands.ts");

  assert.deepEqual(commands.AHA_COMMANDS.checkReadiness, {
    id: "aha-readiness-check",
    name: "Check Readiness",
  });
  assert.deepEqual(commands.AHA_COMMANDS.run, {
    id: "aha-run",
    name: "Run",
  });
  assert.deepEqual(commands.AHA_COMMANDS.openPanel, {
    id: "aha-open-panel",
    name: "Open Panel",
  });
  assert.deepEqual(commands.AHA_COMMANDS.exportReviewNote, {
    id: "aha-export-review-note",
    name: "Export Review Note",
  });
  assert.deepEqual(commands.AHA_COMMANDS.openCandidate, {
    id: "aha-open-candidate-under-cursor",
    name: "Open Candidate",
  });
  for (const command of Object.values(commands.AHA_COMMANDS)) {
    assert.doesNotMatch(command.name, /^Aha:/);
  }
});

test("panel source keeps follow and pin hooks without a Review Note export button", async () => {
  const source = await readFile(path.join(repoRoot, "obsidian-plugin/src/review-panel.ts"), "utf8");

  assert.match(source, /followsActiveFile\(\)/);
  assert.match(source, /private pinned = false/);
  assert.match(source, /renderPinButton/);
  assert.doesNotMatch(source, /Export Review Note/);
  assert.doesNotMatch(source, /exportReviewNote/);
});

test("panel header keeps source title space beside compact actions", async () => {
  const styles = await readFile(path.join(repoRoot, "obsidian-plugin/styles.css"), "utf8");
  const source = await readFile(path.join(repoRoot, "obsidian-plugin/src/review-panel.ts"), "utf8");
  const sourceLinkRule = styles.match(/\.aha-review-panel-source-link\s*{[\s\S]*?}/)?.[0] ?? "";

  assert.match(styles, /grid-template-areas:\s*"title actions"/);
  assert.match(styles, /grid-template-columns:\s*minmax\(0, 1fr\) max-content/);
  assert.match(styles, /@container \(max-width: 680px\)/);
  assert.match(styles, /@container \(max-width: 430px\)/);
  assert.match(styles, /\.aha-review-panel-actions\s*{[\s\S]*?display:\s*flex;/);
  assert.match(styles, /\.aha-review-panel-actions > \.aha-review-panel-run,[\s\S]*?height:\s*24px/);
  assert.doesNotMatch(styles, /display:\s*contents/);
  assert.match(sourceLinkRule, /overflow-wrap:\s*break-word/);
  assert.doesNotMatch(sourceLinkRule, /overflow-wrap:\s*anywhere/);
  assert.match(source, /this\.countEl = title\.createDiv\(\{ cls: "aha-review-panel-count" \}\)/);
  assert.match(source, /renderRunButton\(actions, "rerun Aha"\)/);
  assert.match(source, /text: "record must"/);
});

test("plugin manifest presents the product as Aha", async () => {
  const manifest = JSON.parse(await readFile(path.join(repoRoot, "obsidian-plugin/manifest.json"), "utf8"));

  assert.equal(manifest.name, "Aha");
  assert.doesNotMatch(manifest.description, /Review Notes/i);
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

test("session store creates compact source-keyed panel records", async () => {
  const sessionStore = await loadTsModule("obsidian-plugin/src/session-store.ts", obsidianStubPlugin());
  const store = sessionStore.createEmptySessionStore();
  const source = sourceInput("srcfs:stable-source", "Source/Insight.md");
  const result = {
    ...searchRound("2026-06-28T08:00:00Z").result,
    rawPrompt: "SECRET_PROMPT_SHOULD_NOT_PERSIST",
    candidates: [
      {
        ...searchRound("2026-06-28T08:00:00Z").result.candidates[0],
        rawBody: "SECRET_OLD_NOTE_BODY_SHOULD_NOT_PERSIST",
      },
    ],
  };

  const record = sessionStore.recordSuccessfulSessionRound(store, {
    generatedAt: new Date("2026-06-28T08:00:00Z"),
    source,
    result,
  });
  const latest = sessionStore.latestSuccessfulRound(record);
  const persisted = JSON.stringify(record);

  assert.equal(Object.keys(store.records)[0], "srcfs:stable-source");
  assert.equal(record.source.id, "srcfs:stable-source");
  assert.equal(record.source.path, "Source/Insight.md");
  assert.equal(record.source.fallbackPath, "Source/Insight.md");
  assert.equal(latest.candidates.length, 1);
  assert.equal(latest.candidates[0].notePath, "Memory/Candidate.md");
  assert.equal(latest.candidates[0].selected, true);
  assert.match(sessionStore.handoffForRound(record, latest), /Memory\/Candidate/);
  assert.doesNotMatch(persisted, /SECRET_PROMPT_SHOULD_NOT_PERSIST/);
  assert.doesNotMatch(persisted, /SECRET_OLD_NOTE_BODY_SHOULD_NOT_PERSIST/);
});

test("session store lookup follows filesystem identity and separates path fallback collisions", async () => {
  const sessionStore = await loadTsModule("obsidian-plugin/src/session-store.ts", obsidianStubPlugin());
  const store = sessionStore.createEmptySessionStore();

  assert.equal(
    sessionStore.sessionRecordKeyForSource("srcfs:stable-source", "Source/Insight.md"),
    "srcfs:stable-source",
  );
  assert.notEqual(
    sessionStore.sessionRecordKeyForSource("src:ctime-collision", "Source/First.md"),
    sessionStore.sessionRecordKeyForSource("src:ctime-collision", "Source/Second.md"),
  );

  sessionStore.recordSuccessfulSessionRound(store, {
    generatedAt: new Date("2026-06-28T08:10:00Z"),
    source: sourceInput("srcfs:stable-source", "Source/Insight.md"),
    result: searchRound("2026-06-28T08:10:00Z").result,
  });
  const renamed = sessionStore.findSessionRecord(store, "srcfs:stable-source", "Other/Renamed.md");

  assert.equal(renamed.source.path, "Source/Insight.md");
});

test("session store keeps latest successful panel state after a failed run", async () => {
  const sessionStore = await loadTsModule("obsidian-plugin/src/session-store.ts", obsidianStubPlugin());
  const store = sessionStore.createEmptySessionStore();
  const source = sourceInput("srcfs:failure-source", "Source/Insight.md");
  const record = sessionStore.recordSuccessfulSessionRound(store, {
    generatedAt: new Date("2026-06-28T08:20:00Z"),
    source,
    result: searchRound("2026-06-28T08:20:00Z").result,
  });

  sessionStore.recordFailedSessionRound(store, {
    generatedAt: new Date("2026-06-28T08:21:00Z"),
    source,
    failure: {
      message: "QMD timeout",
      tool: "qmd",
      details: "query exceeded timeout ".repeat(200),
    },
  });

  const latest = sessionStore.latestSuccessfulRound(record);
  const failed = record.rounds.find((round) => round.status === "failed");

  assert.equal(record.rounds.some((round) => round.status === "failed"), true);
  assert.ok(failed.error.details.length < 2100);
  assert.equal(latest.generatedAt, "2026-06-28T08:20:00Z");
  assert.equal(latest.candidates.length, 1);
});

test("a successful round can carry a structured failure record for Runtime Tier Fallback (issue #58), without disturbing an ordinary success", async () => {
  const sessionStore = await loadTsModule("obsidian-plugin/src/session-store.ts", obsidianStubPlugin());
  const store = sessionStore.createEmptySessionStore();
  const ordinarySource = sourceInput("srcfs:ordinary-success", "Source/Ordinary.md");
  const ordinaryRecord = sessionStore.recordSuccessfulSessionRound(store, {
    generatedAt: new Date("2026-06-28T09:40:00Z"),
    source: ordinarySource,
    result: searchRound("2026-06-28T09:40:00Z").result,
  });
  const ordinaryRound = sessionStore.latestSuccessfulRound(ordinaryRecord);
  assert.equal(ordinaryRound.error, undefined, "an ordinary success round never carries a failure record");

  const fallbackSource = sourceInput("srcfs:fallback-source", "Source/Fallback.md");
  const fallbackRecord = sessionStore.recordSuccessfulSessionRound(store, {
    generatedAt: new Date("2026-06-28T09:41:00Z"),
    source: fallbackSource,
    result: {
      ...searchRound("2026-06-28T09:41:00Z").result,
      summary: "Recall Tier (Full Tier fallback: Relation Judge failed - LLM call failed after 3 attempts). Deterministic multi-query retrieval ranked 1 candidate(s).",
      error: {
        message: "Aha Relation Judge failed.",
        tool: "llm",
        details: "LLM call failed after 3 attempts: network error: connection refused",
      },
    },
  });
  const fallbackRound = sessionStore.latestSuccessfulRound(fallbackRecord);

  assert.equal(fallbackRound.status, "success", "Runtime Tier Fallback still lands on a successful round -- it is not an error state");
  assert.match(fallbackRound.summary, /^Recall Tier \(Full Tier fallback:/, "Search Round History names the fallback honestly, not a fake Full Tier success");
  assert.ok(fallbackRound.error, "the structured failure record survives into Search Round History");
  assert.equal(fallbackRound.error.tool, "llm");
  assert.match(fallbackRound.error.details, /LLM call failed after 3 attempts/);
});

test("session store syncs panel selections and draft feedback without review notes", async () => {
  const sessionStore = await loadTsModule("obsidian-plugin/src/session-store.ts", obsidianStubPlugin());
  const store = sessionStore.createEmptySessionStore();
  const source = sourceInput("srcfs:feedback-source", "Source/Insight.md");
  const record = sessionStore.recordSuccessfulSessionRound(store, {
    generatedAt: new Date("2026-06-28T08:30:00Z"),
    source,
    result: searchRound("2026-06-28T08:30:00Z").result,
  });

  const synced = sessionStore.syncSessionSelections(record, new Map([[1, false]]), new Date("2026-06-28T08:31:00Z"));
  const feedback = sessionStore.appendSessionFeedback(record, {
    action: "accept",
    createdAt: new Date("2026-06-28T08:32:00Z"),
    sourcePath: source.path,
    sourceTitle: source.title,
    candidate: synced.candidates[0],
  });

  assert.equal(synced.candidates[0].selected, false);
  assert.doesNotMatch(synced.handoff, /Memory\/Candidate/);
  assert.equal(record.feedback.length, 1);
  assert.equal(feedback.status, "draft");
  assert.equal(feedback.seedLabel, "nice_to_have");
  assert.equal(feedback.memory, "Memory/Candidate.md");
});

test("session store reruns preserve user state while refreshing model-owned fields", async () => {
  const sessionStore = await loadTsModule("obsidian-plugin/src/session-store.ts", obsidianStubPlugin());
  const store = sessionStore.createEmptySessionStore();
  const source = sourceInput("srcfs:rerun-source", "Source/Insight.md");
  const record = sessionStore.recordSuccessfulSessionRound(store, {
    generatedAt: new Date("2026-06-28T08:40:00Z"),
    source,
    result: searchRound("2026-06-28T08:40:00Z").result,
  });

  const firstSync = sessionStore.syncSessionSelections(record, new Map([[1, false]]), new Date("2026-06-28T08:41:00Z"));
  sessionStore.appendSessionFeedback(record, {
    action: "accept",
    createdAt: new Date("2026-06-28T08:42:00Z"),
    sourcePath: source.path,
    sourceTitle: source.title,
    candidate: firstSync.candidates[0],
  });

  sessionStore.recordSuccessfulSessionRound(store, {
    generatedAt: new Date("2026-06-28T08:43:00Z"),
    source,
    result: {
      ...searchRound("2026-06-28T08:43:00Z").result,
      candidates: [
        {
          notePath: "Memory/Candidate.md",
          noteTitle: "Candidate",
          relation: "challenges",
          hit: "\"Fresh evidence quote.\"",
          why: "这次 rerun 刷新了模型判断文本，但不应该覆盖用户选择。",
          quotes: ["Fresh evidence quote."],
          selected: true,
        },
      ],
    },
  });

  const latest = sessionStore.latestSuccessfulRound(record);

  assert.equal(record.rounds.filter((round) => round.status === "success").length, 2);
  assert.equal(latest.generatedAt, "2026-06-28T08:43:00Z");
  assert.equal(latest.candidates[0].selected, false);
  assert.equal(latest.candidates[0].relation, "challenges");
  assert.equal(latest.candidates[0].hit, "\"Fresh evidence quote.\"");
  assert.deepEqual(latest.candidates[0].quotes, ["Fresh evidence quote."]);
  assert.equal(record.feedback.length, 1);
  assert.equal(record.feedback[0].memory, "Memory/Candidate.md");
});

test("session store separates handoff selection from feedback actions", async () => {
  const sessionStore = await loadTsModule("obsidian-plugin/src/session-store.ts", obsidianStubPlugin());
  const store = sessionStore.createEmptySessionStore();
  const source = sourceInput("srcfs:selection-source", "Source/Insight.md");
  const record = sessionStore.recordSuccessfulSessionRound(store, {
    generatedAt: new Date("2026-06-28T08:45:00Z"),
    source,
    result: {
      ...searchRound("2026-06-28T08:45:00Z").result,
      candidates: [
        searchRound("2026-06-28T08:45:00Z").result.candidates[0],
        {
          notePath: "Memory/Weak.md",
          noteTitle: "Weak",
          relation: "weak",
          hit: "Lexical overlap only.",
          why: "这条候选只是边界材料，默认不应该进入 handoff。",
          quotes: [],
        },
      ],
    },
  });
  const latest = sessionStore.latestSuccessfulRound(record);

  assert.equal(latest.candidates[0].selected, true);
  assert.equal(latest.candidates[1].selected, false);

  sessionStore.appendSessionFeedback(record, {
    action: "accept",
    createdAt: new Date("2026-06-28T08:46:00Z"),
    sourcePath: source.path,
    sourceTitle: source.title,
    candidate: latest.candidates[1],
  });
  assert.equal(latest.candidates[1].selected, false);

  sessionStore.appendSessionFeedback(record, {
    action: "reject_as_noise",
    createdAt: new Date("2026-06-28T08:47:00Z"),
    sourcePath: source.path,
    sourceTitle: source.title,
    candidate: latest.candidates[0],
  });
  sessionStore.appendSessionFeedback(record, {
    action: "should_have_found",
    createdAt: new Date("2026-06-28T08:48:00Z"),
    sourcePath: source.path,
    sourceTitle: source.title,
    missingMemory: "Memory/Missing.md",
  });

  assert.equal(latest.candidates[0].selected, false);
  assert.deepEqual(record.feedback.map((feedback) => [feedback.action, feedback.status, feedback.seedLabel]), [
    ["accept", "draft", "nice_to_have"],
    ["reject_as_noise", "draft", "negative"],
    ["should_have_found", "draft", "must_recall"],
  ]);
  assert.doesNotMatch(sessionStore.handoffForRound(record, latest), /Memory\/Candidate/);
});

test("session store exposes stale source state without hiding candidates", async () => {
  const sessionStore = await loadTsModule("obsidian-plugin/src/session-store.ts", obsidianStubPlugin());
  const store = sessionStore.createEmptySessionStore();
  const source = sourceInput("srcfs:stale-source", "Source/Insight.md");
  const record = sessionStore.recordSuccessfulSessionRound(store, {
    generatedAt: new Date("2026-06-28T08:50:00Z"),
    source,
    result: searchRound("2026-06-28T08:50:00Z").result,
  });
  const latest = sessionStore.latestSuccessfulRound(record);

  const fresh = sessionStore.staleStateForRound(latest, {
    path: source.path,
    ctime: source.ctime,
    mtime: source.mtime,
    size: source.size,
  });
  const changed = sessionStore.staleStateForRound(latest, {
    path: source.path,
    ctime: source.ctime,
    mtime: source.mtime + 1,
    size: source.size + 1,
  });

  assert.equal(fresh.stale, false);
  assert.equal(changed.stale, true);
  assert.equal(changed.mtimeChanged, true);
  assert.equal(changed.sizeChanged, true);
  assert.equal(sessionStore.latestSuccessfulRound(record).candidates.length, 1);
});

test("session store normalization retains orphaned records quietly", async () => {
  const sessionStore = await loadTsModule("obsidian-plugin/src/session-store.ts", obsidianStubPlugin());
  const store = sessionStore.createEmptySessionStore();
  const source = sourceInput("srcfs:orphan-source", "Missing/Insight.md");
  sessionStore.recordSuccessfulSessionRound(store, {
    generatedAt: new Date("2026-06-28T09:00:00Z"),
    source,
    result: searchRound("2026-06-28T09:00:00Z").result,
  });

  const normalized = sessionStore.normalizeSessionStore(JSON.parse(JSON.stringify(store)));
  const retained = sessionStore.findSessionRecord(normalized, "srcfs:orphan-source", "Missing/Renamed.md");

  assert.equal(Object.keys(normalized.records).length, 1);
  assert.equal(retained.source.path, "Missing/Insight.md");
  assert.equal(sessionStore.latestSuccessfulRound(retained).candidates.length, 1);
});

test("review note export renders current session panel state only", async () => {
  const sessionStore = await loadTsModule("obsidian-plugin/src/session-store.ts", obsidianStubPlugin());
  const reviewNote = await loadReviewNoteModule();
  const store = sessionStore.createEmptySessionStore();
  const source = sourceInput("srcfs:export-source", "Source/Insight.md");
  const record = sessionStore.recordSuccessfulSessionRound(store, {
    generatedAt: new Date("2026-06-28T09:10:00Z"),
    source,
    result: {
      ...searchRound("2026-06-28T09:10:00Z").result,
      summary: "Older round should not be exported.",
      candidates: [
        {
          ...searchRound("2026-06-28T09:10:00Z").result.candidates[0],
          why: "Older model text should not appear in a current-state export.",
        },
      ],
    },
  });
  sessionStore.recordSuccessfulSessionRound(store, {
    generatedAt: new Date("2026-06-28T09:11:00Z"),
    source,
    result: {
      ...searchRound("2026-06-28T09:11:00Z").result,
      summary: "Latest panel surface.",
      candidates: [
        searchRound("2026-06-28T09:11:00Z").result.candidates[0],
        {
          notePath: "Memory/Weak.md",
          noteTitle: "Weak",
          relation: "weak",
          hit: "Weak candidate remains visible.",
          why: "Weak candidate stays visible but is not selected by default.",
          quotes: [],
        },
      ],
    },
  });
  sessionStore.appendSessionFeedback(record, {
    action: "should_have_found",
    createdAt: new Date("2026-06-28T09:12:00Z"),
    sourcePath: source.path,
    sourceTitle: source.title,
    missingMemory: "Memory/Missing.md",
  });

  const latest = sessionStore.latestSuccessfulRound(record);
  let exported = reviewNote.makeReviewNoteContent({
    createdAt: new Date("2026-06-28T09:13:00Z"),
    sourceId: source.id,
    sourcePath: source.path,
    sourceTitle: source.title,
  });
  exported = reviewNote.appendSuccessfulSearchRound(exported, {
    generatedAt: new Date(latest.generatedAt),
    result: sessionStore.resultForSessionRound(latest),
    sourcePath: source.path,
    sourceTitle: source.title,
  });
  for (const feedback of record.feedback) {
    const seedInput = sessionStore.reviewSeedInputForSessionFeedback(feedback);
    if (seedInput) exported = reviewNote.appendReviewBenchmarkSeed(exported, seedInput);
  }

  assert.equal((exported.match(/### 搜索轮次 - /g) ?? []).length, 1);
  assert.match(exported, /Latest panel surface/);
  assert.match(exported, /1\. \[x\] \[\[Memory\/Candidate\]\]/);
  assert.match(exported, /2\. \[ \] \[\[Memory\/Weak\]\]/);
  assert.match(exported, /- action: `should_have_found`/);
  assert.match(exported, /- seed_label: `must_recall`/);
  assert.doesNotMatch(exported, /Older round should not be exported/);
  assert.doesNotMatch(exported, /Older model text should not appear/);
  assert.doesNotMatch(exported, /2026-06-28T09:10:00Z/);
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

function sourceInput(id, path) {
  return {
    id,
    path,
    title: "Insight",
    ctime: 1782600000000,
    mtime: 1782600000000,
    size: 100,
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
