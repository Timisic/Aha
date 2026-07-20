// Tests for the shared-core note-identity module (ADR 0005, issue #54).
// Imports go through the core artifact loader on purpose: the loader rebuilds
// obsidian-plugin/dist/core.mjs from src/core before importing, so this test
// also exercises the rebuild path every run.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildVaultPathResolver,
  equivalentVaultPath,
  normalizeNoteIdentity,
  notePathForObsidian,
  resolveVaultPath,
  sameNotePath,
  slugPath,
  stripPathDecorations,
} from "../../lib/core-artifact.mjs";

test("normalizeNoteIdentity strips qmd scheme, index suffix, extension, and decorations", () => {
  assert.equal(normalizeNoteIdentity("QMD://obsidian/Folder/Note.md?index=obsidian"), "folder/note");
  assert.equal(normalizeNoteIdentity("qmd://obsidian/BOOK/FYP%20Draft/Example.md?index=obsidian"), "book/fyp draft/example");
  assert.equal(normalizeNoteIdentity("Folder\\Sub\\Note.md"), "folder/sub/note");
  assert.equal(normalizeNoteIdentity("Folder/Note.MD"), "folder/note");
  // Extension stripping happens before trim, so padded input keeps ".md" (legacy parity).
  assert.equal(normalizeNoteIdentity("  Folder/Note.md  "), "folder/note.md");
  assert.equal(normalizeNoteIdentity(null), "");
  assert.equal(normalizeNoteIdentity(undefined), "");
});

test("normalizeNoteIdentity applies NFC normalization and case folding", () => {
  // NFD input (e + combining acute) equals the precomposed NFC form.
  assert.equal(normalizeNoteIdentity("Cafe\u0301.md"), "caf\u00e9");
  assert.equal(normalizeNoteIdentity("Cafe\u0301.md"), normalizeNoteIdentity("Caf\u00e9.md"));
  assert.equal(normalizeNoteIdentity("Folder/Note.md", { caseSensitive: true }), "Folder/Note");
});

test("sameNotePath compares normalized identities", () => {
  assert.equal(sameNotePath("Folder/Note.md", "folder/note"), true);
  assert.equal(sameNotePath("Folder/Note.md", "folder/note", { caseSensitive: true }), false);
  assert.equal(sameNotePath("qmd://obsidian/Folder/Note.md?index=obsidian", "Folder\\Note"), true);
  assert.equal(sameNotePath("Folder/Note.md", "Folder/Other.md"), false);
  assert.equal(sameNotePath("", "folder/note"), false);
  assert.equal(sameNotePath("folder/note", null), false);
});

test("stripPathDecorations removes qmd scheme, query, and fragment", () => {
  assert.equal(stripPathDecorations("qmd://obsidian/Folder/Note.md?index=obsidian"), "Folder/Note.md");
  assert.equal(stripPathDecorations("Folder/Note.md#heading"), "Folder/Note.md");
  assert.equal(stripPathDecorations("Folder\\Sub\\Note.md"), "Folder/Sub/Note.md");
  assert.equal(stripPathDecorations("  Folder/Note.md  "), "Folder/Note.md");
  assert.equal(stripPathDecorations("qmd://collection-only"), "collection-only");
  assert.equal(stripPathDecorations("Plain/Path.md"), "Plain/Path.md");
  assert.equal(stripPathDecorations(undefined), "");
});

test("slugPath hex-encodes emoji and dashes CJK punctuation", () => {
  assert.equal(slugPath("Notes/\u{1F525} Hot，Idea。.md"), "notes/1f525-hot-idea");
  assert.equal(slugPath("日记：复盘（初稿）.md"), "日记-复盘-初稿");
  assert.equal(slugPath("/leading/and/trailing/"), "leading/and/trailing");
  assert.equal(slugPath("A -- B?!.md"), "a-b");
  assert.equal(slugPath("qmd://obsidian/Folder/Note.md?index=obsidian"), "folder/note");
});

test("notePathForObsidian decodes qmd URIs and relativizes vault-absolute paths", () => {
  assert.equal(
    notePathForObsidian({}, { uri: "qmd://obsidian/BOOK/FYP%20Draft/Example.md?index=obsidian" }),
    "BOOK/FYP Draft/Example.md",
  );
  assert.equal(
    notePathForObsidian({ vaultRoot: "/vault" }, { file: "/vault/Folder/Note.md" }),
    "Folder/Note.md",
  );
  assert.equal(
    notePathForObsidian({ vaultRoot: "/vault" }, { file: "/elsewhere/Note.md" }),
    "/elsewhere/Note.md",
  );
  assert.equal(
    notePathForObsidian({}, { file: "/vault/Folder/Note.md" }),
    "/vault/Folder/Note.md",
  );
  assert.equal(notePathForObsidian({}, { path: "Folder/Note.md", title: "Ignored" }), "Folder/Note.md");
  assert.equal(notePathForObsidian({}, {}), "unknown.md");
});

async function makeVaultFixture() {
  const root = await mkdtemp(path.join(tmpdir(), "core-note-identity-"));
  await mkdir(path.join(root, "notes", "sub"), { recursive: true });
  await mkdir(path.join(root, "dup"), { recursive: true });
  await mkdir(path.join(root, ".hidden"), { recursive: true });
  await writeFile(path.join(root, "notes", "Alpha.md"), "# Alpha\n");
  await writeFile(path.join(root, "notes", "sub", "Beta.md"), "# Beta (sub)\n");
  await writeFile(path.join(root, "dup", "Beta.md"), "# Beta (dup)\n");
  await writeFile(path.join(root, "notes", "ignored.txt"), "not markdown\n");
  await writeFile(path.join(root, ".hidden", "Skipped.md"), "# Skipped\n");
  await writeFile(path.join(root, ".Dotfile.md"), "# Dot\n");
  return root;
}

test("buildVaultPathResolver indexes markdown files and skips dot entries", async (t) => {
  const root = await makeVaultFixture();
  t.after(() => rm(root, { recursive: true, force: true }));

  const resolver = buildVaultPathResolver(root);
  assert.equal(resolver.root, path.resolve(root));
  assert.deepEqual(
    [...resolver.files].sort(),
    ["dup/Beta.md", "notes/Alpha.md", "notes/sub/Beta.md"],
  );
  assert.deepEqual(resolver.byRelative.get("notes/alpha.md"), ["notes/Alpha.md"]);
  assert.deepEqual(resolver.bySlug.get("notes/alpha"), ["notes/Alpha.md"]);
  assert.deepEqual([...resolver.byBasename.get("beta")].sort(), ["dup/Beta.md", "notes/sub/Beta.md"]);
});

test("resolveVaultPath resolves relative, slug, basename, and qmd keys", async (t) => {
  const root = await makeVaultFixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const resolver = buildVaultPathResolver(root);

  assert.deepEqual(resolveVaultPath("notes/Alpha.md", resolver), {
    status: "resolved",
    path: "notes/Alpha.md",
    matches: ["notes/Alpha.md"],
  });
  assert.equal(resolveVaultPath("notes/alpha", resolver).status, "resolved");
  assert.equal(resolveVaultPath("Alpha", resolver).path, "notes/Alpha.md");
  assert.equal(resolveVaultPath("/notes/Alpha.md", resolver).path, "notes/Alpha.md");
  assert.equal(
    resolveVaultPath("qmd://obsidian/notes/Alpha.md?index=obsidian", resolver).path,
    "notes/Alpha.md",
  );
  assert.equal(resolveVaultPath("notes/sub/Beta.md", resolver).path, "notes/sub/Beta.md");

  const ambiguous = resolveVaultPath("Beta", resolver);
  assert.equal(ambiguous.status, "ambiguous");
  assert.deepEqual([...ambiguous.matches].sort(), ["dup/Beta.md", "notes/sub/Beta.md"]);

  assert.deepEqual(resolveVaultPath("Missing Note", resolver), { status: "not_found", matches: [] });
  assert.deepEqual(resolveVaultPath("", resolver), { status: "not_found", matches: [] });
});

test("resolveVaultPath maps absolute filesystem paths into the vault", async (t) => {
  const root = await makeVaultFixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const resolver = buildVaultPathResolver(root);

  const absolute = path.join(path.resolve(root), "notes", "Alpha.md");
  assert.equal(resolveVaultPath(absolute, resolver).path, "notes/Alpha.md");

  const absoluteDup = path.join(path.resolve(root), "dup", "Beta.md");
  assert.equal(resolveVaultPath(absoluteDup, resolver).path, "dup/Beta.md");

  const outside = path.join(tmpdir(), "core-note-identity-outside", "Nowhere.md");
  assert.equal(resolveVaultPath(outside, resolver).status, "not_found");
});

test("equivalentVaultPath is true only when both sides resolve to one file", async (t) => {
  const root = await makeVaultFixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const resolver = buildVaultPathResolver(root);

  assert.equal(equivalentVaultPath("Alpha", "notes/Alpha.md", resolver), true);
  assert.equal(equivalentVaultPath("qmd://obsidian/notes/Alpha.md?index=obsidian", "notes/alpha", resolver), true);
  assert.equal(equivalentVaultPath("Alpha", "notes/sub/Beta.md", resolver), false);
  // Ambiguous inputs never count as equivalent.
  assert.equal(equivalentVaultPath("Beta", "notes/sub/Beta.md", resolver), false);
  assert.equal(equivalentVaultPath("Alpha", "Missing Note", resolver), false);
});
