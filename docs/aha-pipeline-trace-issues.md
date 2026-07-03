# Aha Pipeline Trace Issues

This local issue brief captures the approved Pipeline Trace work. It is intentionally repo-local and should not be published to GitHub unless requested.

## Issue 01: Emit structured Pipeline Trace artifacts from L2 benchmark runs

## What to build

After each Memory Pipeline Benchmark run, emit one stable structured `PipelineTrace` JSON artifact per case. The trace should make the retrieval path inspectable without becoming a Markdown report or private note backup: query generation, QMD runs, backlink expansion, the pre-rerank candidate pool, final candidates, gold positions, and rule-based diagnosis should live in one object. The benchmark report should point to each trace and summarize trace diagnoses across cases.

## Acceptance criteria

- [x] Each L2 benchmark case writes a `PipelineTrace` JSON file under the latest report trace directory.
- [x] `pipeline.json` includes per-case trace pointers and a trace diagnosis summary.
- [x] The trace records `steps`, including query generation, QMD runs, backlink expansion, pre-rerank candidates, rerank metadata, and final candidates.
- [x] The trace records `gold_positions` for must, nice, and noise labels across QMD, expanded-pool, and final stages.
- [x] The trace records a concise rule-based `diagnosis` with primary target and supporting signals.
- [x] Candidate trace records use paths, titles, ranks, sources, rerank ids, bounded snippets, and content hashes; full note bodies are not stored by default.
- [x] Deterministic tests cover trace generation without live QMD, Obsidian, or OpenAI calls.
- [x] Documentation explains that `PipelineTrace` is the structured source of truth; readable views can be generated later.

## Blocked by

None - can start immediately.
