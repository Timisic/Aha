# Scripts

This directory keeps executable project scripts grouped by workflow.

## Layout

```text
scripts/
  bench/
    build-fixture.mjs       # Build a qmd bench fixture from active cases.
    collect-review-seeds.mjs # Collect Obsidian Review Note seeds into an ignored draft case inbox.
    normalize-case-paths.mjs # Rewrite vault-absolute case paths to vault-relative paths.
    run-qmd-bench.mjs       # L1: QMD-only retrieval benchmark.
    run-pipeline-bench.mjs  # L2: query plan -> QMD -> backlinks -> Relation Judge benchmark.
    summarize-report.mjs    # Print a compact QMD bench report summary.
  lib/
    *.mjs                   # Shared benchmark scoring, trace, and helper modules.
  aha/
    run-insight-search.mjs  # Obsidian plugin search runner.
    query-plan.mjs          # Shared query-plan generation.
    relation-judge.mjs      # Shared quote-backed relation judging.
```

## Common Commands

Run the QMD-only benchmark:

```bash
cp bench/aha-memory-cases.example.json bench/aha-memory-cases.json # first run only; then edit local private cases
node scripts/bench/run-qmd-bench.mjs
```

Collect Obsidian Review Note seeds into a private draft case inbox:

```bash
node scripts/bench/collect-review-seeds.mjs \
  --vault-root "$HOME/Obsidian Notes" \
  --output bench/aha-memory-seed-cases.json
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
