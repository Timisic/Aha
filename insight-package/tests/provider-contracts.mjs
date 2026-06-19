import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const fixture = JSON.parse(readFileSync(resolve("tests/fixtures/provider-contracts.json"), "utf-8"));
const MAX_OUTPUT_BYTES = 1_000_000;

function stdoutFor(scenario) {
  if (scenario.stdoutBytes) return "x".repeat(scenario.stdoutBytes);
  return scenario.stdout ?? "";
}

function parseJsonItems(stdout) {
  const parsed = JSON.parse(stdout);
  if (Array.isArray(parsed)) return parsed;
  for (const key of ["results", "items", "pages", "matches", "data"]) {
    if (Array.isArray(parsed?.[key])) return parsed[key];
  }
  return [];
}

function parseTextItems(stdout) {
  return String(stdout || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => ({ path: line, title: line.replace(/\.md$/i, "") }));
}

function classifyProviderScenario(kind, scenario) {
  const stdout = stdoutFor(scenario);
  const stderr = scenario.stderr ?? "";
  if (scenario.timedOut) return { status: "timeout", items: [] };
  if (stdout.length > MAX_OUTPUT_BYTES) return { status: "oversized", items: [] };
  if (/ECONNREFUSED|not found|unavailable/i.test(stderr)) return { status: "unavailable", items: [] };

  let items = [];
  try {
    items = kind === "obsidian" && !stdout.trim().startsWith("[") && !stdout.trim().startsWith("{")
      ? parseTextItems(stdout)
      : parseJsonItems(stdout);
  } catch {
    return { status: "malformed", items: [] };
  }

  if (kind === "reranker") {
    const parsed = JSON.parse(stdout || "{}");
    items = Array.isArray(parsed.ranked_ids) ? parsed.ranked_ids : [];
  }

  const exitCode = scenario.exitCode;
  if (exitCode && exitCode !== 0 && items.length > 0) return { status: "partial", items };
  if (items.length === 0) return { status: "empty", items };
  if (kind === "obsidian" && scenario.name.includes("ambiguous")) return { status: "ambiguous", items };
  return { status: "ok", items };
}

for (const kind of ["qmd", "obsidian", "reranker"]) {
  assert.ok(Array.isArray(fixture[kind]), `${kind} fixture array exists`);
  for (const scenario of fixture[kind]) {
    const result = classifyProviderScenario(kind, scenario);
    assert.equal(result.status, scenario.expectedStatus, `${kind}/${scenario.name} status`);
    assert.equal(result.items.length, scenario.expectedCount, `${kind}/${scenario.name} count`);
  }
}

const requiredQmdStatuses = new Set(["ok", "empty", "partial", "unavailable", "timeout", "oversized", "malformed"]);
const requiredObsidianStatuses = new Set(["ok", "ambiguous", "unavailable"]);
const requiredRerankerStatuses = new Set(["ok", "empty", "malformed", "partial"]);

for (const [kind, required] of [["qmd", requiredQmdStatuses], ["obsidian", requiredObsidianStatuses], ["reranker", requiredRerankerStatuses]]) {
  const covered = new Set(fixture[kind].map((scenario) => scenario.expectedStatus));
  for (const status of required) {
    assert.ok(covered.has(status), `${kind} covers ${status}`);
  }
}

console.log("provider contract fixture tests passed");
