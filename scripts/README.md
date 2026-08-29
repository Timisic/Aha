# Scripts

This directory keeps executable project scripts grouped by workflow.

## Layout

The orchestration logic itself (query plan, QMD retrieval, pool merge/rerank, Relation Judge) lives in `obsidian-plugin/src/core/`, not here — see [ADR 0005](../docs/adr/0005-share-compiled-core-between-plugin-and-bench.md). Everything under `scripts/` either consumes that compiled core (`lib/core-artifact.mjs`) for bench/CLI use, or is legacy machinery kept as a rollback path.

```text
scripts/
  bench/
    build-fixture.mjs         # Build a qmd bench fixture from active cases.
    extract-note-excerpt.mjs  # Preview a case's exact source-note excerpt.
    normalize-case-paths.mjs  # Rewrite vault-absolute case paths to vault-relative paths.
    collect-session-feedback.mjs # Collects Review Panel accept/noise/should_have_found feedback out of a plugin's data.json into draft bench cases.
    run-qmd-bench.mjs         # L1: QMD-only retrieval benchmark.
    run-pipeline-bench.mjs    # L2: query plan -> QMD -> backlinks -> Relation Judge benchmark, via core.
    run-pipeline-ablations.mjs # Runs the standard L2 ablation variant suite.
    summarize-report.mjs      # Print a compact QMD bench report summary.
  lib/
    core-artifact.mjs         # Rebuild-first loader for the shared core artifact (ADR 0005); the main entry point for bench/CLI.
    session-artifact.mjs      # Rebuild-first loader for the session-store Node artifact (same pattern, "session" esbuild target); used by dev/run-batch-vault.mjs and bench/collect-session-feedback.mjs.
    session-feedback-cases.mjs # Turns Session Store feedback (accept/reject_as_noise/should_have_found) into draft bench cases; used by bench/collect-session-feedback.mjs.
    core-node-deps.mjs        # Node bindings (fetch, spawn, fs) injected into core's dependency seam.
    *.mjs                     # Other shared benchmark scoring, trace, and path helpers.
  aha/
    run-insight-search.mjs    # Legacy CLI wrapper. DeepSeek runs now delegate to core-artifact.mjs; kept
                               # as the plugin's hidden `useLegacyWrapper` rollback switch and bench's
                               # process bridge. Codex CLI (an alternate LLM provider for this path) has
                               # been removed entirely -- DeepSeek is the sole provider.
    query-plan.mjs            # Thin shell around core's query-plan generation, used by the legacy wrapper/bench.
    relation-judge.mjs        # Thin shell around core's quote-backed relation judging.
    tests/{unit,integration,e2e}/ # wrapper/retrieval/judge/scoring tests, tiered by what they touch.
  debug-pipeline.mjs         # CLI harness for running the full core pipeline outside Obsidian.
  dev/install-dev-plugin.mjs # Installs a side-by-side dev-channel plugin build into the vault.
  dev/run-batch-vault.mjs    # Batch-runs the real pipeline over many real notes, writing results into the dev plugin's data.json session store (see BATCH-VAULT-RUNNER-PLAN.md).
```

## Common Commands

Run the QMD-only benchmark:

```bash
cp bench/aha-memory-cases.example.json bench/aha-memory-cases.json # first run only; then edit local private cases
node scripts/bench/run-qmd-bench.mjs
```

Normalize private benchmark case files to the shorter vault-relative path style:

```bash
node scripts/bench/normalize-case-paths.mjs
```

Run the pipeline benchmark:

```bash
node scripts/bench/run-pipeline-bench.mjs
```

Latest benchmark reports are written to `bench/reports/latest/`.
Timestamped historical reports are written to `bench/reports/archive/`.
