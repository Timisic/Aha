# Use a single Pipeline Trace schema

Aha benchmark runs should produce a single structured Pipeline Trace for each Memory Pipeline Benchmark case. The trace is the source of truth for how a case moved from input to query generation, QMD retrieval, backlink expansion, pre-rerank candidates, final candidates, gold positions, and diagnosis.

This keeps trace work simple enough to maintain while still making benchmark results useful as product feedback. A trace should answer which part of the memory pipeline deserves the next optimization effort, not merely preserve a verbose debug log.

## Considered Options

- Store trace as Markdown only. Rejected because Markdown is readable but weak as a stable source for aggregation, rerendering, and automated diagnosis.
- Split trace into separate raw, view, and feedback layers from the start. Rejected because that adds architecture before there is enough use pressure to justify separate artifacts.
- Store full candidate note contents in trace by default. Rejected because benchmark traces should remain long-term feedback artifacts, not private note backups.

## Consequences

- `PipelineTrace` should be one stable structured object per benchmark case.
- The trace should combine process facts, gold-memory positions, and a concise rule-based diagnosis.
- Human-readable views may be generated from the structured trace later, but they should not become the source of truth.
- The benchmark report may summarize traces across cases, but per-case trace objects remain the evidence layer.
- Candidate records should include paths, titles, ranks, sources, rerank ids, bounded snippets when needed, and content hashes or other compact identifiers rather than full note bodies by default.
- Trace diagnosis should stay rule-based first. LLM-written summaries can be added later as a view or explanation layer, after the deterministic signal is stable.
