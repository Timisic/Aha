// Tests for core/graph-expansion.ts (ADR 0005 follow-up): verbatim port of
// obsidianGraphExpansion's row-building half from the frozen legacy wrapper
// scripts/aha/run-insight-search.mjs.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const repoRoot = path.resolve(import.meta.dirname, "..", "..", "..");
const pluginDir = path.join(repoRoot, "obsidian-plugin");
const artifactPath = path.join(pluginDir, "dist", "core.mjs");

const build = spawnSync(process.execPath, ["esbuild.config.mjs", "core"], {
  cwd: pluginDir,
  encoding: "utf-8",
});
if (build.error) {
  throw new Error(`core artifact build failed to spawn: ${build.error.message}`);
}
if (build.status !== 0) {
  throw new Error(`core artifact build failed (exit ${build.status}):\n${build.stdout ?? ""}${build.stderr ?? ""}`);
}

const core = await import(pathToFileURL(artifactPath).href);
const { graphExpansionRows } = core;

test("scores backlinks above outlinks, matching the legacy wrapper's constants", () => {
  const rows = graphExpansionRows("Source.md", [
    { notePath: "Memory/Outlink.md", kind: "outlink" },
    { notePath: "Memory/Backlink.md", kind: "backlink" },
  ]);

  assert.equal(rows.length, 2);
  const outlink = rows.find((row) => row.file.includes("Outlink"));
  const backlink = rows.find((row) => row.file.includes("Backlink"));
  assert.equal(outlink.score, 0.14);
  assert.equal(backlink.score, 0.18);
});

test("builds a qmd:// obsidian URI and derives the title from the basename", () => {
  const rows = graphExpansionRows("Source.md", [{ notePath: "Memory/Nested/Old Note.md", kind: "outlink" }]);

  assert.equal(rows.length, 1);
  assert.equal(rows[0].file, "qmd://obsidian/Memory/Nested/Old Note.md?index=obsidian");
  assert.equal(rows[0].title, "Old Note");
  assert.equal(rows[0].snippet, "Obsidian outlink: Memory/Nested/Old Note.md");
});

test("excludes non-markdown paths and the source note itself", () => {
  const rows = graphExpansionRows("Source.md", [
    { notePath: "Memory/Attachment.png", kind: "outlink" },
    { notePath: "Source.md", kind: "backlink" },
  ]);

  assert.equal(rows.length, 0);
});

test("dedupes by normalized note identity even when scores/kinds differ across calls", () => {
  const rows = graphExpansionRows("Source.md", [
    { notePath: "Memory/Feedback.md", kind: "outlink" },
    { notePath: "Memory/Feedback.md", kind: "backlink" },
  ]);

  assert.equal(rows.length, 1);
  // First occurrence wins, matching the legacy wrapper's Set-based dedup.
  assert.equal(rows[0].score, 0.14);
});
