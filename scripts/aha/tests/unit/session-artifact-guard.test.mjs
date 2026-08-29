// Drift guard for scripts/lib/session-artifact.mjs (BATCH-VAULT-RUNNER-PLAN.md).
// session-artifact.mjs hand-picks named re-exports off the compiled session
// artifact, the same pattern scripts/lib/core-artifact.mjs uses for the
// "core" target -- see core-result-validator.test.mjs for the analogous
// guard on that target. If session-store.ts or source-identity.ts ever adds,
// removes, or renames an exported function, this test fails until
// session-artifact.mjs's re-export list is updated to match, so the batch
// vault runner can never silently fall behind the plugin's own logic.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import * as sessionArtifact from "../../../lib/session-artifact.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..", "..", "..", "..");
const pluginSrcDir = path.join(repoRoot, "obsidian-plugin", "src");

function exportedFunctionNames(fileName) {
  const source = readFileSync(path.join(pluginSrcDir, fileName), "utf-8");
  const names = [];
  for (const match of source.matchAll(/^export(?: async)? function (\w+)/gm)) {
    names.push(match[1]);
  }
  return names;
}

test("session-artifact.mjs re-exports exactly the exported functions of session-store.ts and source-identity.ts", () => {
  const expected = [
    ...exportedFunctionNames("session-store.ts"),
    ...exportedFunctionNames("source-identity.ts"),
  ].sort();

  assert.ok(expected.length > 0, "sanity: the source-file scan must find at least one exported function");

  const actual = Object.keys(sessionArtifact)
    .filter((key) => typeof sessionArtifact[key] === "function")
    .sort();

  assert.deepEqual(
    actual,
    expected,
    "scripts/lib/session-artifact.mjs's re-export list has drifted from session-store.ts / source-identity.ts's actual exports",
  );
});
