# Scripts

This directory keeps executable project scripts grouped by workflow.

## Layout

```text
scripts/
  bench/
    build-fixture.mjs       # Build a qmd bench fixture from active cases.
    run-qmd-bench.mjs       # L1: QMD-only retrieval benchmark.
    run-pipeline-bench.mjs  # L2: query agent -> QMD -> backlinks -> rerank benchmark.
    summarize-report.mjs    # Print a compact QMD bench report summary.
  insight/
    test-extension.mjs      # Standard /insight extension regression test.
    ultraqa-extension.mjs   # Adversarial /insight regression matrix.
  lib/
    aha-*.mjs               # Shared benchmark query, scoring, and rerank helpers.
```

## Common Commands

Run the extension regression suite against the package source:

```bash
INSIGHT_EXTENSION_PATH=/Users/hong/Downloads/Pi/insight-package/extensions/insight.ts \
  bun scripts/insight/test-extension.mjs
```

Run adversarial extension checks:

```bash
INSIGHT_EXTENSION_PATH=/Users/hong/Downloads/Pi/insight-package/extensions/insight.ts \
  bun scripts/insight/ultraqa-extension.mjs
```

Run the QMD-only benchmark:

```bash
cp bench/aha-memory-cases.example.json bench/aha-memory-cases.json # first run only; then edit local private cases
node scripts/bench/run-qmd-bench.mjs
```

Run the pipeline benchmark:

```bash
node scripts/bench/run-pipeline-bench.mjs
```

Latest benchmark reports are written to `bench/reports/latest/`.
Timestamped historical reports are written to `bench/reports/archive/`.
