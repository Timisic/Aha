// Tests for the shared-core Aha result validator (ADR 0005, issue #57).
//
// The compiled core artifact is never committed, so this test rebuilds it the
// same way scripts/lib/core-artifact.mjs does and imports
// obsidian-plugin/dist/core.mjs directly.
//
// A dedicated drift-guard test asserts the schema embedded in
// obsidian-plugin/src/core/result-validator.ts stays byte-identical (as a
// deep-equal JSON value) to scripts/aha/aha-result.schema.json, since core
// cannot import that JSON file directly (see the module comment in
// result-validator.ts for why).

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const repoRoot = path.resolve(import.meta.dirname, "..", "..", "..", "..");
const pluginDir = path.join(repoRoot, "obsidian-plugin");
const artifactPath = path.join(pluginDir, "dist", "core.mjs");
const schemaPath = path.join(repoRoot, "scripts", "aha", "aha-result.schema.json");

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
const { AHA_RESULT_SCHEMA, RELATIONS, validateAhaResult } = core;

test("core AHA_RESULT_SCHEMA stays byte-identical to scripts/aha/aha-result.schema.json", () => {
  const fileSchema = JSON.parse(readFileSync(schemaPath, "utf-8"));
  assert.deepEqual(AHA_RESULT_SCHEMA, fileSchema);
});

test("RELATIONS is derived from the schema's relation enum", () => {
  assert.deepEqual([...RELATIONS].sort(), ["bounds", "challenges", "resembles", "supports", "weak"]);
});

test("rejects a non-object value", () => {
  const result = validateAhaResult(null);
  assert.equal(result.ok, false);
  assert.deepEqual(result.errors, ["Result must be a JSON object."]);
});

test("rejects a value missing boolean ok", () => {
  const result = validateAhaResult({});
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes("boolean ok")));
});

test("accepts a well-formed success result", () => {
  const result = validateAhaResult({
    ok: true,
    sourcePath: "Source.md",
    generatedAt: new Date().toISOString(),
    summary: "Found one candidate.",
    warnings: [],
    error: null,
    candidates: [
      {
        notePath: "Memory/Note.md",
        noteTitle: "Note",
        relation: "weak",
        hit: "some snippet",
        why: "Explains why this old note is worth reading for the current insight.",
        quotes: [],
        selected: true,
      },
    ],
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
});

test("a strong relation without quote-backed hit material fails validation", () => {
  const result = validateAhaResult({
    ok: true,
    sourcePath: "Source.md",
    generatedAt: null,
    summary: null,
    warnings: [],
    error: null,
    candidates: [
      {
        notePath: "Memory/Note.md",
        noteTitle: "Note",
        relation: "supports",
        hit: "a plain unquoted snippet with no ellipsis",
        why: "Explains why this old note is worth reading for the current insight.",
        quotes: [],
        selected: true,
      },
    ],
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes("quote-backed")));
});

test("a strong relation with a quotes array entry passes even when hit itself is unquoted", () => {
  const result = validateAhaResult({
    ok: true,
    sourcePath: "Source.md",
    generatedAt: null,
    summary: null,
    warnings: [],
    error: null,
    candidates: [
      {
        notePath: "Memory/Note.md",
        noteTitle: "Note",
        relation: "challenges",
        hit: "a plain unquoted snippet",
        why: "Explains why this old note challenges the current insight in detail.",
        quotes: ["an exact quote from the excerpt"],
        selected: true,
      },
    ],
  });
  assert.equal(result.ok, true);
});

test("a failed result must include error.message/tool/details", () => {
  const result = validateAhaResult({
    ok: false,
    sourcePath: null,
    generatedAt: null,
    summary: null,
    warnings: null,
    error: { message: "failed" },
    candidates: null,
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes("error.tool")));
  assert.ok(result.errors.some((error) => error.includes("error.details")));
});

test("why below the 12-char minimum is rejected", () => {
  const result = validateAhaResult({
    ok: true,
    sourcePath: "Source.md",
    generatedAt: null,
    summary: null,
    warnings: [],
    error: null,
    candidates: [
      {
        notePath: "Memory/Note.md",
        noteTitle: "Note",
        relation: "weak",
        hit: "snippet",
        why: "太短",
        quotes: [],
        selected: true,
      },
    ],
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes("why")));
});
