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

test("renderGrillHandoff lists only selected candidates and stays quiet with none", async () => {
  const reviewNote = await loadReviewNoteModule();
  const candidates = [
    searchRound("2026-06-28T07:00:00Z").result.candidates[0],
    {
      notePath: "Memory/Weak.md",
      noteTitle: "Weak",
      relation: "weak",
      hit: "Lexical overlap only.",
      why: "边界材料，不进入 handoff。",
      quotes: [],
      selected: false,
    },
  ];

  const handoff = reviewNote.renderGrillHandoff("Source/Insight.md", "Insight", candidates).join("\n");
  assert.match(handoff, /纳入 handoff 的旧笔记：/);
  assert.match(handoff, /Memory\/Candidate/);
  assert.doesNotMatch(handoff, /Memory\/Weak/);

  const empty = reviewNote.renderGrillHandoff("Source/Insight.md", "Insight", []).join("\n");
  assert.match(empty, /还没有纳入 handoff 的记忆/);
});

test("seedLabelForAction maps review actions to benchmark seed labels", async () => {
  const reviewNote = await loadReviewNoteModule();
  assert.equal(reviewNote.seedLabelForAction("accept"), "nice_to_have");
  assert.equal(reviewNote.seedLabelForAction("reject_as_noise"), "negative");
  assert.equal(reviewNote.seedLabelForAction("should_have_found"), "must_recall");
});

test("obsidianLink omits the alias when it matches the target or its last segment", async () => {
  const reviewNote = await loadReviewNoteModule();
  assert.equal(reviewNote.obsidianLink("BOOK/Course/example-course-note.md"), "[[BOOK/Course/example-course-note]]");
  assert.equal(reviewNote.obsidianLink("BOOK/Course/example-course-note.md", "example-course-note"), "[[BOOK/Course/example-course-note]]");
  assert.equal(reviewNote.obsidianLink("BOOK/Course/example-course-note.md", "V 2"), "[[BOOK/Course/example-course-note|V 2]]");
  assert.equal(reviewNote.noteDisplayTitleFromPath("BOOK/Course/example-course-note.md"), "example-course-note");
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
  assert.deepEqual(commands.AHA_COMMANDS.openCandidate, {
    id: "aha-open-candidate-under-cursor",
    name: "Open Candidate",
  });
  assert.equal(commands.AHA_COMMANDS.exportReviewNote, undefined, "Review Note export was removed; no command should reference it");
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
  const sessionStore = await loadTsModule("obsidian-plugin/src/session-store.ts");
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
  const sessionStore = await loadTsModule("obsidian-plugin/src/session-store.ts");
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
  const sessionStore = await loadTsModule("obsidian-plugin/src/session-store.ts");
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
  const sessionStore = await loadTsModule("obsidian-plugin/src/session-store.ts");
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
  const sessionStore = await loadTsModule("obsidian-plugin/src/session-store.ts");
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
  const sessionStore = await loadTsModule("obsidian-plugin/src/session-store.ts");
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
  const sessionStore = await loadTsModule("obsidian-plugin/src/session-store.ts");
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
  const sessionStore = await loadTsModule("obsidian-plugin/src/session-store.ts");
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
  const sessionStore = await loadTsModule("obsidian-plugin/src/session-store.ts");
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

async function loadReviewNoteModule() {
  return loadTsModule("obsidian-plugin/src/review-note.ts");
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
