# Scripts

This directory keeps executable project scripts grouped by workflow.

## Layout

```text
scripts/
  bench/
    build-fixture.mjs       # Build a qmd bench fixture from active cases.
    collect-review-seeds.mjs # Collect Session Store feedback into an ignored development draft inbox.
    normalize-case-paths.mjs # Rewrite vault-absolute case paths to vault-relative paths.
    run-qmd-bench.mjs       # L1: QMD-only retrieval benchmark.
    run-pipeline-bench.mjs  # Advanced L2 runner: product-parity or diagnostic-enhanced.
    run-eval-workflow.mjs   # Stable validate/smoke/baseline/diagnostic entry point.
    summarize-report.mjs    # Summarize a report or the verified latest pointer.
  lib/
    bench-workflow.mjs      # Run provenance, promotion gate, and latest-pointer integrity.
    *.mjs                   # Shared benchmark scoring, identity, trace, and helpers.
  aha/
    retrieval-pipeline.mjs  # Shared query-to-final-slate orchestration interface.
    retrieval-policies.mjs  # Versioned product, diagnostic, and legacy rollback policies.
    supplemental-queries.mjs # Shared deterministic source/thought recall floor.
    graph-expansion.mjs     # Shared bounded source + top-seed graph expansion.
    chunked-relation-judge.mjs # Shared bounded, fail-closed Relation Judge execution.
    run-insight-search.mjs  # Obsidian plugin wrapper; delegates pipeline orchestration.
    query-plan.mjs          # Shared query-plan generation.
    relation-judge.mjs      # Shared quote-backed relation judging.
```

## Common Commands

Use the named workflows for routine evaluation:

```bash
npm run bench:validate               # tracked synthetic schema/privacy check
npm run bench:validate -- --private  # ignored local suite + canonical identity
npm run bench:smoke                  # deterministic evaluation contract tests
npm run bench:diagnostic             # diagnostic-enhanced, development only
npm run bench:baseline               # product-parity, development + holdout
```

Collect Session Store feedback into a private development draft inbox:

```bash
node scripts/bench/collect-review-seeds.mjs \
  --vault-root "$HOME/Obsidian Notes" \
  --output bench/aha-memory-seed-cases.json
```

Review Note import is legacy-only and must be explicit:

```bash
node scripts/bench/collect-review-seeds.mjs --legacy-review-notes
```

Normalize private benchmark case files to the shorter vault-relative path style:

```bash
node scripts/bench/normalize-case-paths.mjs
```

The raw runners remain available for focused investigation:

```bash
node scripts/bench/run-qmd-bench.mjs --suite development
node scripts/bench/run-pipeline-bench.mjs --profile product-parity --suite development
node scripts/bench/run-pipeline-bench.mjs --profile diagnostic-enhanced --suite development --only aha-001
```

Named workflow runs are immutable under `bench/reports/runs/<run-id>/`. `bench/reports/latest/product-parity.json` is an atomic, hash-verified pointer and is updated only by a complete eligible baseline. Raw runners may still write legacy latest/archive paths when used directly.

The shipped wrapper and diagnostic runner both execute the shared v2 retrieval mechanisms. Product defaults keep up to 80 retrieval candidates, review up to 60 in bounded chunks, and display up to 20. Source excerpts and an optional `--thought` add deterministic, deduplicated QMD queries. Source-note and top-seed graph expansion share admission, identity, per-origin, and global budgets. `legacy-v1` in `retrieval-policies.mjs` is the rollback contract.

The Obsidian setting and product-parity runner pass `--retrieval-policy product-v2|legacy-v1`; the policy id/version is part of both effective configuration identity and every runtime trace. Compare candidate and rollback reports per suite with `scripts/bench/compare-retrieval-policies.mjs`; its output is private benchmark evidence and must not be committed.

`bench:baseline` and `bench:diagnostic` load the active Obsidian plugin runtime settings from the vault's plugin `data.json`; use `-- --plugin-data <path>` only when validating a different local installation. Secrets are passed through the child environment and are not persisted in evaluation artifacts.
