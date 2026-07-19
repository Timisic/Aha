# Share one compiled core between the Obsidian plugin and the bench

When retrieval orchestration moved from the external Node wrapper into plugin TypeScript, the benchmark loop (gold cases, pipeline bench, failure attribution) had to keep running on the exact same logic, or plugin and bench behavior would drift apart. We decided that `src/core/` is the single source of orchestration logic, compiled by esbuild into two artifacts: the bundled plugin and a standalone ESM build (not committed; rebuilt by verify/bench entry points) that bench scripts import in place of the old `scripts/aha/*.mjs` modules.

The injection seam sits at the transport level, not the task level: core entry points receive a `deps` object of roughly `llmJsonCall` (transport plus retry, no prompts), `runQmdQuery` (single query execution), and `vault` (note read, path resolve, backlinks). Prompt construction, schema validation, pool merging, and ranking all live in core and are therefore identical on both sides; the plugin injects `requestUrl`/child-process/vault-API implementations while bench injects Node HTTP/spawn/fs implementations.

## Considered Options

- Bench imports TypeScript sources directly (Node type-stripping or tsx). Rejected: pins the Node version or adds a runtime dependency for no parity gain.
- Commit the compiled ESM artifact to git. Rejected: a forgotten rebuild silently diverges source from artifact, which is the exact drift this decision exists to prevent.
- Task-level seam (`generateQueryPlan`, `judgeRelation` implemented per side). Rejected: prompts and judging logic could drift between plugin and bench, making bench numbers stop being evidence about the product.

## Consequences

- Bench regression comparisons remain valid evidence about plugin behavior, because both execute the same compiled logic with only transport swapped.
- Core code must stay free of `obsidian` imports and module-level I/O; all effects flow through the injected deps.
- The old sync-I/O wrapper modules could not be bundled as-is (`spawnSync` would freeze the UI thread), so the migration is decision-logic-equivalent but structurally async; equivalence is guaranteed by bench regression and unit tests, not line-by-line diffs.
