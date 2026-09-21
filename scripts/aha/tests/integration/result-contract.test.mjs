import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { validateAhaResult } from "../../lib/result-validator.mjs";
import { notePathForObsidian, normalizeNoteIdentity, sameNotePath } from "../../lib/note-identity.mjs";
const repoRoot = path.resolve(import.meta.dirname, "../../../..");
async function readFixture(name) {
  return readFile(path.join(repoRoot, "scripts/aha/fixtures", name), "utf8");
}

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
