// Tests for createObsidianGraphNeighborsRunner (scripts/lib/core-node-deps.mjs,
// ADR 0005 follow-up): the Node/CLI-side implementation of core's
// OrchestratorDeps.listGraphNeighbors, verbatim-porting obsidianGraphExpansion's
// I/O half from the frozen legacy wrapper scripts/aha/run-insight-search.mjs.

import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createObsidianGraphNeighborsRunner } from "../../../lib/core-node-deps.mjs";

async function makeObsidianStub(behavior) {
  const dir = await mkdtemp(path.join(tmpdir(), "aha-graph-expansion-"));
  const script = path.join(dir, "obsidian-stub.sh");
  await writeFile(script, behavior, { mode: 0o755 });
  await chmod(script, 0o755);
  return script;
}

test("returns no neighbors when the source note is not vault-backed", async () => {
  const runner = createObsidianGraphNeighborsRunner({
    obsidianCommand: "should-not-run",
    workspace: process.cwd(),
    vaultRoot: "",
    sourceAbsolutePath: "",
  });

  const outcome = await runner("Source.md");
  assert.deepEqual(outcome, { neighbors: [], warnings: [] });
});

test("merges links and backlinks output, tagging each with its kind", async () => {
  const vaultRoot = await mkdtemp(path.join(tmpdir(), "aha-graph-vault-"));
  await mkdir(path.join(vaultRoot, "Memory"), { recursive: true });
  await writeFile(path.join(vaultRoot, "Source.md"), "source note");

  const script = await makeObsidianStub([
    "#!/bin/sh",
    'if [ "$1" = "links" ]; then',
    '  echo "Memory/Outlink.md"',
    'elif [ "$1" = "backlinks" ]; then',
    '  echo \'[{"path":"Memory/Backlink.md"}]\'',
    "fi",
    "",
  ].join("\n"));

  const runner = createObsidianGraphNeighborsRunner({
    obsidianCommand: script,
    workspace: vaultRoot,
    vaultRoot,
    sourceAbsolutePath: path.join(vaultRoot, "Source.md"),
  });

  const outcome = await runner("Source.md");
  assert.deepEqual(outcome.warnings, []);
  assert.deepEqual(
    outcome.neighbors.slice().sort((a, b) => a.notePath.localeCompare(b.notePath)),
    [
      { notePath: "Memory/Backlink.md", kind: "backlink" },
      { notePath: "Memory/Outlink.md", kind: "outlink" },
    ],
  );
});

test("a non-zero exit on one direction becomes a warning without aborting the other", async () => {
  const vaultRoot = await mkdtemp(path.join(tmpdir(), "aha-graph-vault-"));
  await writeFile(path.join(vaultRoot, "Source.md"), "source note");

  const script = await makeObsidianStub([
    "#!/bin/sh",
    'if [ "$1" = "links" ]; then',
    "  exit 1",
    'elif [ "$1" = "backlinks" ]; then',
    '  echo \'[{"path":"Memory/Backlink.md"}]\'',
    "fi",
    "",
  ].join("\n"));

  const runner = createObsidianGraphNeighborsRunner({
    obsidianCommand: script,
    workspace: vaultRoot,
    vaultRoot,
    sourceAbsolutePath: path.join(vaultRoot, "Source.md"),
  });

  const outcome = await runner("Source.md");
  assert.equal(outcome.neighbors.length, 1);
  assert.equal(outcome.neighbors[0].notePath, "Memory/Backlink.md");
  assert.equal(outcome.warnings.length, 1);
  assert.match(outcome.warnings[0], /Obsidian links expansion skipped/);
});

test("a missing obsidian command becomes a warning per direction, not a thrown error", async () => {
  const vaultRoot = await mkdtemp(path.join(tmpdir(), "aha-graph-vault-"));
  await writeFile(path.join(vaultRoot, "Source.md"), "source note");

  const runner = createObsidianGraphNeighborsRunner({
    obsidianCommand: path.join(vaultRoot, "does-not-exist"),
    workspace: vaultRoot,
    vaultRoot,
    sourceAbsolutePath: path.join(vaultRoot, "Source.md"),
  });

  const outcome = await runner("Source.md");
  assert.equal(outcome.neighbors.length, 0);
  assert.equal(outcome.warnings.length, 2);
  assert.ok(outcome.warnings.every((warning) => /expansion failed/.test(warning)));
});
