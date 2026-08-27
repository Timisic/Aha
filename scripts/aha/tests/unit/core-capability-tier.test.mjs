// Tests for the shared-core Capability Tier decision (ADR 0005, issue #58;
// CONTEXT.md "Runtime Capability Tiers"). decideCapabilityTier is a pure
// function of a dependency-availability snapshot: no I/O, no caching, no
// inspection of call outcomes. Imports go through the core artifact loader
// on purpose: the loader rebuilds obsidian-plugin/dist/core.mjs from
// src/core before importing, so this test also exercises the rebuild path
// every run.

import assert from "node:assert/strict";
import test from "node:test";
import { decideCapabilityTier, formatTierHeader, tierLabel } from "../../../lib/core-artifact.mjs";

test("decideCapabilityTier covers the full qmd x llm 2x2 matrix", () => {
  assert.equal(decideCapabilityTier({ qmdAvailable: false, llmConfigured: false }), "neighborhood");
  assert.equal(decideCapabilityTier({ qmdAvailable: false, llmConfigured: true }), "neighborhood");
  assert.equal(decideCapabilityTier({ qmdAvailable: true, llmConfigured: false }), "recall");
  assert.equal(decideCapabilityTier({ qmdAvailable: true, llmConfigured: true }), "full");
});

test("decideCapabilityTier is pure: identical snapshots always decide the same tier", () => {
  const snapshot = { qmdAvailable: true, llmConfigured: false };
  const first = decideCapabilityTier(snapshot);
  const second = decideCapabilityTier({ ...snapshot });
  assert.equal(first, "recall");
  assert.equal(first, second);
});

test("tierLabel names each tier honestly, never disguising one as another", () => {
  assert.equal(tierLabel("neighborhood"), "Neighborhood Tier");
  assert.equal(tierLabel("recall"), "Recall Tier");
  assert.equal(tierLabel("full"), "Full Tier");
});

test("formatTierHeader is a plain label with no reason", () => {
  assert.equal(formatTierHeader("full"), "Full Tier");
  assert.equal(formatTierHeader("neighborhood"), "Neighborhood Tier");
});

test("formatTierHeader attaches a fallback/unavailability reason in one line", () => {
  assert.equal(formatTierHeader("neighborhood", "qmd unavailable"), "Neighborhood Tier (qmd unavailable)");
  assert.equal(formatTierHeader("recall", "no LLM configured"), "Recall Tier (no LLM configured)");
  assert.equal(
    formatTierHeader("recall", "Full Tier fallback: Relation Judge failed - LLM call failed after 3 attempts"),
    "Recall Tier (Full Tier fallback: Relation Judge failed - LLM call failed after 3 attempts)",
  );
});

test("formatTierHeader ignores a blank/whitespace-only reason", () => {
  assert.equal(formatTierHeader("full", ""), "Full Tier");
  assert.equal(formatTierHeader("full", "   "), "Full Tier");
  assert.equal(formatTierHeader("full", undefined), "Full Tier");
});
