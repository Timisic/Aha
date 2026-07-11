# Use a single Pipeline Trace schema

Aha should use one structured `PipelineTrace` schema for both the shipped retrieval runtime and benchmark runs. The runtime trace is an opt-in, privacy-bounded record of query planning, QMD rounds, source-graph expansion, the candidates actually reviewed by the Relation Judge, final ordering, and stage failures. A benchmark may add gold positions and deterministic diagnosis as an evaluation overlay on that same evidence object.

This keeps trace work simple enough to maintain while still making benchmark results useful as product feedback. A trace should answer which part of the memory pipeline deserves the next optimization effort, not merely preserve a verbose debug log.

## Considered Options

- Store trace as Markdown only. Rejected because Markdown is readable but weak as a stable source for aggregation, rerendering, and automated diagnosis.
- Split trace into separate raw, view, and feedback layers from the start. Rejected because that adds architecture before there is enough use pressure to justify separate artifacts.
- Store full candidate note contents in trace by default. Rejected because benchmark traces should remain long-term feedback artifacts, not private note backups.

## Consequences

- `PipelineTrace` should be one stable, versioned structured object per runtime or benchmark case.
- The shipped runtime is the source of truth for product-parity traces. The benchmark must consume that runtime result and trace instead of reconstructing a second product pipeline.
- `scripts/aha/retrieval-pipeline.mjs` is the source of truth for orchestration order. The shipped wrapper and diagnostic-enhanced benchmark inject different policies and runtime adapters into its documented `runRetrievalPipeline({ insight, policy, adapters })` interface.
- Benchmark cases, gold labels, scoring, diagnosis, report generation, and baseline promotion remain outside that interface. Product-parity continues to launch the shipped wrapper as a process.
- Trace collection is opt-in and off by default. It is diagnostic process evidence and must not be persisted in the Aha Session Store.
- Runtime trace fields use vault-relative identities, ranks, scores, source labels, relations, hashes, evidence counts, and error categories. They do not store note bodies, full queries or prompts, API keys, raw stderr, private absolute paths, `hit`/`why` prose, or quotes.
- Benchmark-only gold positions and rule-based diagnosis may be attached after the runtime completes; they must not change runtime candidates or ordering.
- Human-readable views may be generated from the structured trace later, but they should not become the source of truth.
- The benchmark report may summarize traces across cases, but per-case trace objects remain the evidence layer.
- `relation_judge.reviewed_candidates` records the actual bounded judge input so failure attribution can distinguish retrieval/selection misses from ordering failures.
- Trace diagnosis should stay rule-based first. LLM-written summaries can be added later as a view or explanation layer, after the deterministic signal is stable.
