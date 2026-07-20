// Tests for the shared-core candidate identity/filter module (ADR 0005,
// issue #56). Imports go through the core artifact loader on purpose: the
// loader rebuilds obsidian-plugin/dist/core.mjs from src/core before
// importing, so this test also exercises the rebuild path every run.
//
// isExcludedCandidatePath is also covered end to end (through the bench
// shim scripts/lib/candidate-fields.mjs) by
// scripts/aha/tests/candidate-fields.test.mjs; this file adds direct
// coverage for the vault-containment, source self-hit, and generated-review
// filters ported from the frozen legacy wrapper
// scripts/aha/run-insight-search.mjs, which previously had no standalone
// test coverage (they were private helpers inline in that file).

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import {
  DEFAULT_EXCLUDED_CANDIDATE_FOLDERS,
  annotateCandidateRerankIds,
  candidatePath,
  candidateRerankId,
  candidateSourceLabel,
  candidateSourceList,
  excludedCandidateFolders,
  isCandidatePathAllowed,
  isGeneratedReviewCandidate,
  isObsidianQmdUri,
  isSourceCandidate,
  qmdUriVaultPath,
  resolveVaultContainedPath,
} from "../../lib/core-artifact.mjs";

// isExcludedCandidatePath's raw core signature takes an explicit
// vaultRootPrefix (core has no process.env reads); the Node binding in
// core-artifact.mjs hides that third argument behind an
// AHA_BENCH_VAULT_ROOT env read to preserve the legacy 2-arg call site
// (already covered by scripts/aha/tests/candidate-fields.test.mjs). Import
// the compiled artifact directly here to exercise the parameterized seam
// itself, the same way core-llm-transport.test.mjs does.
const repoRoot = path.resolve(import.meta.dirname, "..", "..", "..");
const pluginDir = path.join(repoRoot, "obsidian-plugin");
const artifactPath = path.join(pluginDir, "dist", "core.mjs");
const build = spawnSync(process.execPath, ["esbuild.config.mjs", "core"], { cwd: pluginDir, encoding: "utf-8" });
if (build.error) throw new Error(`core artifact build failed to spawn: ${build.error.message}`);
if (build.status !== 0) throw new Error(`core artifact build failed (exit ${build.status}):\n${build.stdout ?? ""}${build.stderr ?? ""}`);
const core = await import(pathToFileURL(artifactPath).href);
const { isExcludedCandidatePath } = core;

test("candidatePath prefers file, then path, slug, title", () => {
  assert.equal(candidatePath({ file: "a.md", path: "b.md" }), "a.md");
  assert.equal(candidatePath({ path: "b.md", slug: "c" }), "b.md");
  assert.equal(candidatePath({ slug: "c", title: "d" }), "c");
  assert.equal(candidatePath({ title: "d" }), "d");
  assert.equal(candidatePath({}), "");
  assert.equal(candidatePath(null), "");
});

test("candidateSourceList/candidateSourceLabel prefer sources array over single source", () => {
  assert.deepEqual(candidateSourceList({ sources: ["qmd_query", "backlink"] }), ["qmd_query", "backlink"]);
  assert.deepEqual(candidateSourceList({ source: "qmd_query" }), ["qmd_query"]);
  assert.deepEqual(candidateSourceList({}), []);
  assert.equal(candidateSourceLabel({ sources: ["qmd_query", "backlink"] }), "qmd_query+backlink");
  assert.equal(candidateSourceLabel({ source: "qmd_query" }), "qmd_query");
  assert.equal(candidateSourceLabel({}), undefined);
});

test("candidateRerankId/annotateCandidateRerankIds zero-pad to 3 digits", () => {
  assert.equal(candidateRerankId(0), "c001");
  assert.equal(candidateRerankId(9), "c010");
  const annotated = annotateCandidateRerankIds([{ file: "a.md" }, { file: "b.md" }]);
  assert.deepEqual(annotated.map((c) => c.rerankId), ["c001", "c002"]);
});

test("isExcludedCandidatePath matches the default folders and a custom vault-root prefix", () => {
  assert.equal(isExcludedCandidatePath("templates/Insight-Artifact.md", DEFAULT_EXCLUDED_CANDIDATE_FOLDERS, "/Users/x/vault"), true);
  assert.equal(isExcludedCandidatePath("qmd://obsidian/templates/weekly-review.md?index=obsidian", DEFAULT_EXCLUDED_CANDIDATE_FOLDERS, "/Users/x/vault"), true);
  assert.equal(isExcludedCandidatePath("/Users/x/vault/templates/weekly-review.md", DEFAULT_EXCLUDED_CANDIDATE_FOLDERS, "/Users/x/vault"), true);
  assert.equal(isExcludedCandidatePath("Aha/Reviews/some-insight.md", DEFAULT_EXCLUDED_CANDIDATE_FOLDERS, "/Users/x/vault"), true);
  assert.equal(isExcludedCandidatePath("Projects/reviews/week/2026-W22.md", DEFAULT_EXCLUDED_CANDIDATE_FOLDERS, "/Users/x/vault"), false);
  assert.equal(isExcludedCandidatePath("templates-archive/old.md", DEFAULT_EXCLUDED_CANDIDATE_FOLDERS, "/Users/x/vault"), false);
  assert.equal(isExcludedCandidatePath("", DEFAULT_EXCLUDED_CANDIDATE_FOLDERS, "/Users/x/vault"), false);
});

test("excludedCandidateFolders extends the default list with an explicit extras value", () => {
  const folders = excludedCandidateFolders("Clippings, BOOK/Course");
  assert.deepEqual(folders, ["templates", "Aha/Reviews", "Clippings", "BOOK/Course"]);
});

test("isObsidianQmdUri matches only qmd://obsidian/ URIs", () => {
  assert.equal(isObsidianQmdUri("qmd://obsidian/Note.md?index=obsidian"), true);
  assert.equal(isObsidianQmdUri("qmd://other/Note.md"), false);
  assert.equal(isObsidianQmdUri("Note.md"), false);
});

test("vault-containment: resolveVaultContainedPath / isCandidatePathAllowed / isSourceCandidate / isGeneratedReviewCandidate", async () => {
  const rawVault = await mkdtemp(path.join(tmpdir(), "core-candidates-vault-"));
  // resolveVaultContainedPath resolves through fs.realpath (matching the
  // legacy wrapper's realpath boundary check), and on macOS $TMPDIR sits
  // behind a /private symlink, so expected paths must be realpath'd too.
  const vault = await realpath(rawVault);
  try {
    await mkdir(path.join(vault, "Aha", "Reviews"), { recursive: true });
    await writeFile(path.join(vault, "note.md"), "hello");
    await writeFile(path.join(vault, "source.md"), "source");
    await writeFile(path.join(vault, "Aha", "Reviews", "r1.md"), "review");

    const args = { vaultRoot: vault, sourcePath: "source.md", sourceAbsolutePath: path.join(vault, "source.md") };

    // resolveVaultContainedPath: relative path inside the vault resolves;
    // a path escaping the vault via ".." does not.
    assert.equal(await resolveVaultContainedPath(args, "note.md"), path.join(vault, "note.md"));
    assert.equal(await resolveVaultContainedPath(args, "../outside.md"), "");
    assert.equal(await resolveVaultContainedPath(args, path.join(vault, "note.md")), path.join(vault, "note.md"));

    // isCandidatePathAllowed: true when at least one raw location resolves
    // inside the vault; false when every location escapes or is missing.
    assert.equal(await isCandidatePathAllowed(args, "note.md", { file: "note.md" }), true);
    assert.equal(await isCandidatePathAllowed(args, "missing.md", { file: "missing.md" }), false);
    assert.equal(await isCandidatePathAllowed(args, "note.md", { file: "../outside.md", path: "note.md" }), true);

    // isSourceCandidate: matches the source note by vault-relative identity
    // or by absolute-path equality.
    assert.equal(isSourceCandidate(args, "source.md", { file: "source.md" }), true);
    assert.equal(isSourceCandidate(args, "note.md", { file: path.join(vault, "source.md") }), true);
    assert.equal(isSourceCandidate(args, "note.md", { file: "note.md" }), false);

    // isGeneratedReviewCandidate: matches the configured reviewPath and the
    // Aha/Reviews folder identity regardless of path decoration.
    assert.equal(isGeneratedReviewCandidate(args, "Aha/Reviews/r1.md", { file: "Aha/Reviews/r1.md" }), true);
    assert.equal(isGeneratedReviewCandidate(args, "aha/reviews/r1.md", { file: "aha/reviews/r1.md" }), true);
    assert.equal(isGeneratedReviewCandidate({ ...args, reviewPath: "custom-review.md" }, "custom-review.md", { file: "custom-review.md" }), true);
    assert.equal(isGeneratedReviewCandidate(args, "note.md", { file: "note.md" }), false);

    // qmdUriVaultPath: an obsidian qmd:// URI resolves through the vault
    // boundary check just like a plain relative path.
    assert.equal(await qmdUriVaultPath(args, "qmd://obsidian/note.md?index=obsidian"), path.join(vault, "note.md"));
    assert.equal(await qmdUriVaultPath(args, "qmd://obsidian/../outside.md"), "");
  } finally {
    await rm(vault, { recursive: true, force: true });
  }
});
