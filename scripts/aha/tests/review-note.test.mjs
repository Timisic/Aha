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

test("successful search rounds append without deleting manual review content", async () => {
  const reviewNote = await loadReviewNoteModule();
  const initial = reviewNote.makeReviewNoteContent({
    createdAt: new Date("2026-06-28T00:00:00Z"),
    sourceId: "src:test",
    sourcePath: "Source/Insight.md",
    sourceTitle: "Insight",
  }).replace(
    "_Aha will add selected memory candidates here after retrieval._",
    "Manual selected memory note.",
  ).replace(
    "_Aha will prepare a compact handoff after retrieval._",
    "Manual handoff note.",
  );

  const first = reviewNote.appendSuccessfulSearchRound(initial, searchRound("2026-06-28T01:00:00Z"));
  const second = reviewNote.appendSuccessfulSearchRound(first, searchRound("2026-06-28T02:00:00Z"));

  assert.match(second, /Manual selected memory note\./);
  assert.match(second, /Manual handoff note\./);
  assert.equal((second.match(/### Search Round - /g) ?? []).length, 2);
  assert.equal((second.match(/### Selected Memories - /g) ?? []).length, 2);
  assert.equal((second.match(/### Grill Handoff - /g) ?? []).length, 2);
  assert.equal(reviewNote.reviewSourceIdFromContent(second), "src:test");
  assert.equal(reviewNote.reviewSourcePathFromContent(second), "Source/Insight.md");
  assert.match(second, /<!-- aha:search-results:start -->/);
  assert.match(second, /<!-- aha:search-results:end -->/);
  assert.doesNotMatch(second, /No search round has completed yet/);
  assert.doesNotMatch(second, /Aha will add selected memory candidates here/);
  assert.doesNotMatch(second, /Aha will prepare a compact handoff/);
});

test("successful search round uses markers when headings are edited", async () => {
  const reviewNote = await loadReviewNoteModule();
  const initial = reviewNote.makeReviewNoteContent({
    createdAt: new Date("2026-06-28T00:00:00Z"),
    sourceId: "src:renamed-heading",
    sourcePath: "Source/Insight.md",
    sourceTitle: "Insight",
  }).replace("## Search Results", "## My Search Results");

  const next = reviewNote.appendSuccessfulSearchRound(initial, searchRound("2026-06-28T03:00:00Z"));

  assert.match(next, /## My Search Results/);
  assert.match(next, /### Search Round - 2026-06-28T03:00:00Z/);
  assert.equal((next.match(/<!-- aha:search-results:start -->/g) ?? []).length, 1);
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

  const incomplete = schema.validateAhaWrapperResult({
    ok: false,
    error: {
      message: "failed without tool or details",
    },
  });
  const complete = schema.validateAhaWrapperResult({
    ok: false,
    error: {
      message: "Aha retrieval returned no usable candidates.",
      tool: "qmd",
      details: "QMD and Obsidian graph expansion returned no vault-contained candidates.",
    },
  });

  assert.equal(incomplete.ok, false);
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
      summary: "Aha completed a test search round.",
      warnings: [],
      candidates: [
        {
          notePath: "Memory/Candidate.md",
          noteTitle: "Candidate",
          relation: "supports",
          hit: "\"Evidence quote.\"",
          why: "This candidate has a concrete quote-backed reason for the current insight.",
          quotes: ["Evidence quote."],
          selected: true,
        },
      ],
    },
  };
}
