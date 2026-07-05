import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_EXCLUDED_CANDIDATE_FOLDERS,
  excludedCandidateFolders,
  isExcludedCandidatePath,
} from "../../lib/candidate-fields.mjs";

test("default excluded folders cover templates and review shells", () => {
  assert.deepEqual(DEFAULT_EXCLUDED_CANDIDATE_FOLDERS, ["templates", "Aha/Reviews"]);
});

test("isExcludedCandidatePath matches every candidate path shape", () => {
  assert.equal(isExcludedCandidatePath("templates/Insight-Artifact.md"), true);
  assert.equal(isExcludedCandidatePath("qmd://obsidian/templates/weekly-review.md?index=obsidian"), true);
  assert.equal(isExcludedCandidatePath("/path/to/vault/templates/weekly-review.md"), true);
  assert.equal(isExcludedCandidatePath("Users/hong/Obsidian Notes/templates/weekly-review.md"), true);
  assert.equal(isExcludedCandidatePath("Aha/Reviews/some-insight.md"), true);
  assert.equal(isExcludedCandidatePath("qmd://obsidian/Aha/Reviews/x.md?index=obsidian"), true);
});

test("isExcludedCandidatePath keeps regular notes and near-miss names", () => {
  assert.equal(isExcludedCandidatePath("Projects/reviews/week/2026-W22.md"), false);
  assert.equal(isExcludedCandidatePath("Categories/Evergreen/example-feedback-density.md"), false);
  assert.equal(isExcludedCandidatePath("templates-archive/old.md"), false);
  assert.equal(isExcludedCandidatePath(""), false);
});

test("AHA_EXCLUDED_FOLDERS extends the default list", () => {
  const previous = process.env.AHA_EXCLUDED_FOLDERS;
  process.env.AHA_EXCLUDED_FOLDERS = "Clippings, BOOK/Course";
  try {
    const folders = excludedCandidateFolders();
    assert.deepEqual(folders, ["templates", "Aha/Reviews", "Clippings", "BOOK/Course"]);
    assert.equal(isExcludedCandidatePath("Clippings/some-article.md", folders), true);
    assert.equal(isExcludedCandidatePath("BOOK/Course/example-course-note.md", folders), true);
  } finally {
    if (previous === undefined) delete process.env.AHA_EXCLUDED_FOLDERS;
    else process.env.AHA_EXCLUDED_FOLDERS = previous;
  }
});
