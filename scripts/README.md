# Scripts

Executable project scripts are grouped by workflow.

```text
scripts/
  bench/                 # L1/L2 benchmark runners and report summaries.
  insight/               # Extension smoke/demo scripts.
  lib/                   # Shared benchmark helpers.
```

## Extension checks

```bash
cd insight-package
npm test
npm run test:ultraqa
npm run test:doctor
npm run build
npm run demo:offline
```

From the repository root, run the first-run synthetic demo directly:

```bash
node scripts/insight/demo-offline.mjs
```

## Benchmarks

```bash
cp bench/aha-memory-cases.example.json bench/aha-memory-cases.json
node scripts/bench/run-qmd-bench.mjs
node scripts/bench/run-pipeline-bench.mjs
```

Latest benchmark reports are written to `bench/reports/latest/`; timestamped historical reports are written to `bench/reports/archive/`.
