// Integration tests for scripts/bench/collect-session-feedback.mjs: reads a
// fixture data.json (the shape a real plugin install writes), writes a draft
// seed case file, and flags a stale/missing note path -- without touching
// any real vault or plugin install.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { dataJsonPathFor } from "../../../dev/run-batch-vault.mjs";
import { main, parseArgs } from "../../../bench/collect-session-feedback.mjs";

async function makeVault() {
  return mkdtemp(path.join(tmpdir(), "aha-collect-feedback-"));
}

async function writeDataJson(vaultRoot, pluginId, sessionStore) {
  const dataJsonPath = dataJsonPathFor(vaultRoot, pluginId);
  await mkdir(path.dirname(dataJsonPath), { recursive: true });
  await writeFile(dataJsonPath, JSON.stringify({
    settings: { llmProvider: "deepseek" },
    sessionStore,
    schemaVersion: 3,
  }, null, 2));
  return dataJsonPath;
}

function feedbackFixture() {
  return {
    schemaVersion: 1,
    records: {
      "srcfs:one": {
        schemaVersion: 1,
        key: "srcfs:one",
        source: { id: "srcfs:one", path: "Source/Insight.md", title: "Insight", fallbackPath: "Source/Insight.md" },
        rounds: [],
        feedback: [
          {
            action: "accept",
            status: "draft",
            seedLabel: "nice_to_have",
            createdAt: "2026-06-30T01:00:00.000Z",
            sourcePath: "Source/Insight.md",
            sourceTitle: "Insight",
            memory: "Memory/Nice.md",
          },
        ],
        updatedAt: "2026-06-30T01:00:00.000Z",
      },
      "srcfs:two": {
        schemaVersion: 1,
        key: "srcfs:two",
        source: { id: "srcfs:two", path: "Source/NoFeedback.md", title: "NoFeedback", fallbackPath: "Source/NoFeedback.md" },
        rounds: [],
        feedback: [],
        updatedAt: "2026-06-30T01:00:00.000Z",
      },
    },
  };
}

test("parseArgs defaults to the -dev plugin id and DEFAULT_SESSION_FEEDBACK_CASES_PATH output", () => {
  const options = parseArgs([]);
  assert.equal(options.pluginId, "aha-memory-surface-dev");
  assert.equal(options.output, "bench/aha-memory-seed-cases.json");
  assert.equal(options.dryRun, false);
});

test("collects feedback into a draft case file and skips records with no feedback", async () => {
  const vaultRoot = await makeVault();
  const outputPath = path.join(vaultRoot, "seed-cases.json");
  try {
    await mkdir(path.join(vaultRoot, "Source"), { recursive: true });
    await mkdir(path.join(vaultRoot, "Memory"), { recursive: true });
    await writeFile(path.join(vaultRoot, "Source", "Insight.md"), "content");
    await writeFile(path.join(vaultRoot, "Memory", "Nice.md"), "content");
    await writeDataJson(vaultRoot, "aha-memory-surface-dev", feedbackFixture());

    const originalArgv = process.argv;
    process.argv = [originalArgv[0], originalArgv[1], "--vault-root", vaultRoot, "--output", outputPath];
    try {
      await main();
    } finally {
      process.argv = originalArgv;
    }

    const written = JSON.parse(await readFile(outputPath, "utf-8"));
    assert.equal(written.cases.length, 1);
    assert.equal(written.cases[0].input.note, "Source/Insight.md");
    assert.deepEqual(written.cases[0].gold.nice, ["Memory/Nice.md"]);
    assert.equal(written.warnings, undefined, "both the source and the memory note exist, so there should be no warnings");
  } finally {
    await rm(vaultRoot, { recursive: true, force: true });
  }
});

test("flags a gold path that no longer exists in the vault (moved/renamed since the feedback was recorded)", async () => {
  const vaultRoot = await makeVault();
  const outputPath = path.join(vaultRoot, "seed-cases.json");
  try {
    // Note: Source/Insight.md and Memory/Nice.md are never written to disk here.
    await writeDataJson(vaultRoot, "aha-memory-surface-dev", feedbackFixture());

    const originalArgv = process.argv;
    process.argv = [originalArgv[0], originalArgv[1], "--vault-root", vaultRoot, "--output", outputPath];
    try {
      await main();
    } finally {
      process.argv = originalArgv;
    }

    const written = JSON.parse(await readFile(outputPath, "utf-8"));
    assert.ok(written.warnings?.some((w) => w.includes("input.note not found")));
    assert.ok(written.warnings?.some((w) => w.includes("gold.nice not found")));
  } finally {
    await rm(vaultRoot, { recursive: true, force: true });
  }
});

test("--dry-run prints the document without writing an output file", async () => {
  const vaultRoot = await makeVault();
  const outputPath = path.join(vaultRoot, "seed-cases.json");
  try {
    await writeDataJson(vaultRoot, "aha-memory-surface-dev", feedbackFixture());

    const logs = [];
    const originalLog = console.log;
    const originalArgv = process.argv;
    console.log = (...args) => logs.push(args.join(" "));
    process.argv = [originalArgv[0], originalArgv[1], "--vault-root", vaultRoot, "--output", outputPath, "--dry-run"];
    try {
      await main();
    } finally {
      console.log = originalLog;
      process.argv = originalArgv;
    }

    assert.ok(logs.some((line) => line.includes('"cases"')));
    await assert.rejects(readFile(outputPath, "utf-8"), /ENOENT/);
  } finally {
    await rm(vaultRoot, { recursive: true, force: true });
  }
});
