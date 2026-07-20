// Tests for the plugin-side Neighborhood Tier module (issue #58; CONTEXT.md
// "Neighborhood Tier"): candidate shaping from a fake metadataCache-like
// structure, with no qmd, no LLM, no subprocess. neighborhood-tier.ts is
// obsidian-import-free (duck-typed against a minimal metadataCache/source
// shape), so this bundles and runs with no Obsidian stub.

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const requireFromPlugin = createRequire(path.join(repoRoot, "obsidian-plugin/package.json"));
const esbuild = requireFromPlugin("esbuild");

async function loadTsModule(relativePath) {
  const temp = await mkdtemp(path.join(tmpdir(), "aha-neighborhood-tier-test-"));
  const entry = path.join(temp, "entry.ts");
  const out = path.join(temp, "bundle.mjs");
  await writeFile(entry, `export * from ${JSON.stringify(path.join(repoRoot, relativePath))};\n`);
  await esbuild.build({
    bundle: true,
    entryPoints: [entry],
    format: "esm",
    outfile: out,
    platform: "node",
    target: "es2022",
  });
  const loaded = await import(`${pathToFileURL(out).href}?cacheBust=${Date.now()}`);
  await rm(temp, { recursive: true, force: true });
  return loaded;
}

async function neighborhoodTierModule() {
  return loadTsModule("obsidian-plugin/src/neighborhood-tier.ts");
}

test("ranks backlinks before pure outlinks, merges a note that is both, and excludes the excluded folders", async () => {
  const neighborhoodTier = await neighborhoodTierModule();
  const result = neighborhoodTier.buildNeighborhoodTierResult({
    sourceFile: { path: "Source.md", basename: "Source" },
    metadataCache: {
      resolvedLinks: {
        "Source.md": { "Outlink.md": 2, "Both.md": 1, "Templates/T.md": 1 },
        "Backlink.md": { "Source.md": 3 },
        "Both.md": { "Source.md": 1 },
        "Other.md": { "Elsewhere.md": 1 },
      },
    },
  });

  assert.equal(result.ok, true);
  const paths = result.candidates.map((candidate) => candidate.notePath);
  assert.deepEqual(paths, ["Backlink.md", "Both.md", "Outlink.md"]);
  assert.ok(!paths.includes("Templates/T.md"), "excluded folder must not appear as a candidate");
  assert.ok(!paths.includes("Source.md"), "the source note must never be its own candidate");
});

test("candidates are honestly labeled weak neighborhood recall, never disguised as judged/full results", async () => {
  const neighborhoodTier = await neighborhoodTierModule();
  const result = neighborhoodTier.buildNeighborhoodTierResult({
    sourceFile: { path: "Source.md", basename: "Source" },
    metadataCache: { resolvedLinks: { "Source.md": { "Neighbor.md": 1 }, "Neighbor.md": {} } },
  });

  assert.equal(result.candidates.length, 1);
  const [candidate] = result.candidates;
  assert.equal(candidate.relation, "weak");
  assert.equal(candidate.selected, true);
  assert.ok(candidate.hit.length >= 1);
  assert.ok(candidate.why.length >= 12, "why must satisfy the schema's 12-char minimum");
  assert.match(candidate.why, /Neighborhood Tier/);
  assert.match(result.summary, /^Neighborhood Tier \(qmd unavailable\)\./);
});

test("an empty neighborhood is an honest ok:true zero-candidate result, not a failure -- no tier is an error state", async () => {
  const neighborhoodTier = await neighborhoodTierModule();
  const result = neighborhoodTier.buildNeighborhoodTierResult({
    sourceFile: { path: "Lonely.md", basename: "Lonely" },
    metadataCache: { resolvedLinks: { "Lonely.md": {} } },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.candidates, []);
  assert.match(result.summary, /no linked or backlinked notes/);
});

test("caps the candidate list at targetCandidates", async () => {
  const neighborhoodTier = await neighborhoodTierModule();
  const resolvedLinks = { "Source.md": {} };
  for (let index = 0; index < 5; index += 1) {
    resolvedLinks[`Back${index}.md`] = { "Source.md": 1 };
  }
  const result = neighborhoodTier.buildNeighborhoodTierResult({
    sourceFile: { path: "Source.md", basename: "Source" },
    metadataCache: { resolvedLinks },
    targetCandidates: 3,
  });

  assert.equal(result.candidates.length, 3);
});
