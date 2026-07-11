# Aha Memory Benchmark

This directory contains Aha's evaluation contract, sanitized examples, and ignored local run artifacts. The benchmark measures whether a real insight review surfaces useful old memories inside a ten-candidate attention budget.

## Files and privacy

- `aha-memory-cases.example.json` is a tracked, synthetic schema example. It must not contain real note text, private paths, or case-to-note mappings.
- `aha-memory-cases.json` is the ignored private benchmark. Real inputs, labels, and vault-relative paths stay here.
- `aha-memory-seed-cases.json` is the ignored development inbox generated from feedback. Its cases remain `draft` until a human reviews and promotes them. Custom collector outputs must also stay inside this repository and be Git ignored; tracked, canonical, or repo-external targets are rejected before collection.
- `reports/runs/<run-id>/` contains immutable local run manifests, reports, and traces.
- `reports/latest/product-parity.json` is a small, hash-verified pointer to the most recent eligible baseline. It is never a mutable report body.

Start a new private suite with:

```bash
cp bench/aha-memory-cases.example.json bench/aha-memory-cases.json
npm run bench:validate -- --private
```

The private file and generated reports are Git ignored. Prefer vault-relative paths such as `Knowledge/example.md`; never copy absolute vault paths into tracked fixtures.

## Case contract

The primary schema is v3. Legacy flat fields remain readable only through the shared normalizer; new cases should use the current shape:

```json
{
  "version": 3,
  "suites": {
    "development": { "version": "dev-v1" },
    "holdout": {
      "version": "holdout-v1",
      "frozen": true,
      "change_reason": "Initial frozen split."
    }
  },
  "cases": [
    {
      "id": "aha-001",
      "state": "active",
      "suite": "development",
      "evaluation_mode": "discovery",
      "provenance": {
        "origin": "private_human_curation",
        "reason": "Human-reviewed real insight case."
      },
      "title": "Short maintenance label",
      "input": {
        "note": "path/to/source.md",
        "lines": [8, 20],
        "thought": "Optional fresh focus."
      },
      "gold": {
        "must": ["path/to/required-memory.md"],
        "nice": ["path/to/useful-memory.md"],
        "noise": ["path/to/false-friend.md"]
      },
      "why": "Why these labels are correct for this insight."
    }
  ]
}
```

Required maintenance fields:

- `state`: `active`, `draft`, or `off`. Normal runs score only active cases, while `bench:validate` checks every state so disabled data cannot hide an invalid identity, suite, mode, or provenance record.
- `suite`: `development` or `holdout`.
- `evaluation_mode`: `discovery` or `graph_assisted`.
- `provenance.origin` and `provenance.reason`: enough context to audit why the case exists.
- `input.note` plus `input.lines`, or explicit `input.whole_note: true`; a standalone `input.thought` is also supported.
- `gold.must`, `gold.nice`, and `gold.noise`: human labels for this specific insight.

For `graph_assisted`, declare the known graph edge to a gold note:

```json
"evaluation_mode": "graph_assisted",
"graph_evidence": [
  { "target": "path/to/linked-memory.md", "kind": "source_link" }
]
```

Valid evidence kinds are `source_link`, `backlink`, and `obsidian_graph`. A graph-only hit in a `discovery` case is marked `not_scored`, not credited as pure discovery.

### Development and holdout

- Development cases are the only default destination for feedback pooling and label iteration.
- Holdout is frozen. Changing its inputs, labels, modes, or membership requires a new holdout version and an explicit `change_reason`.
- The validator detects unresolved or ambiguous canonical note identities, duplicate case IDs, cross-suite duplicate fingerprints, missing provenance, and graph-mode contradictions.
- Reports keep development/holdout and discovery/graph-assisted metrics separate.

Canonical note identity is resolved against the real vault before scoring. Absolute, vault-relative, QMD URI, encoded, and moved-note representations can converge on one identity; duplicate representations cannot inflate a metric. Ambiguous or unresolved identities are data-quality failures and are excluded from scored summaries.

Preview a source excerpt before activation:

```bash
node scripts/bench/extract-note-excerpt.mjs --case aha-001 --full-input
```

The preview refuses implicit whole-note reads. Use an explicit line range or `input.whole_note: true`.

Standalone-thought cases can support L1 or focused diagnostic work, but they cannot enter the product-parity baseline because the shipped Obsidian runtime starts from a real source note. Keep such cases out of the active baseline suites.

## Feedback loop

The Aha Session Store in `.obsidian/plugins/aha-memory-surface/data.json` is the default feedback source of truth. Review Notes are optional exports and are not required for normal collection.

```text
Panel feedback
  -> compact Session Record event
  -> ignored draft seed inbox
  -> human checks input, label, identity, and mode
  -> explicit promotion into development
  -> validate / diagnostic / baseline
```

Collect current feedback:

```bash
node scripts/bench/collect-review-seeds.mjs \
  --vault-root "$HOME/Obsidian Notes" \
  --output bench/aha-memory-seed-cases.json
```

Mappings are:

- `accept` -> draft `gold.nice`
- `reject_as_noise` -> draft `gold.noise`
- `should_have_found` -> draft `gold.must`

Each event has a stable ID plus action and timestamp provenance. Re-running is idempotent; malformed, unsupported, duplicate, or empty feedback produces warnings instead of corrupting the inbox. Generated cases are always `development`, `draft`, and `mode_review_required`; they cannot be written as active or holdout cases by the collector.

If an existing inbox is present and the Session Store yields no supported events, the collector refuses to replace it. Use `--dry-run` to inspect the diagnosis; `--allow-empty` is the explicit destructive override.

Legacy Review Note import is explicit:

```bash
node scripts/bench/collect-review-seeds.mjs \
  --legacy-review-notes \
  --review-folder Aha/Reviews
```

Collection never mutates `aha-memory-cases.json`. Promotion means manually reviewing a draft, replacing `whole_note` with the original line range when possible, confirming canonical identities and evaluation mode, then deliberately copying it into the development suite.

## Named workflows

Use these stable entry points instead of assembling raw runner flags for routine work:

```bash
npm run bench:validate
npm run bench:validate -- --private
npm run bench:smoke
npm run bench:diagnostic
npm run bench:baseline
```

| Workflow | Purpose | Profile and suites | Promotion |
|---|---|---|---|
| `bench:validate` | Validate the tracked synthetic fixture without a private vault; add `-- --private` for the local suite | no live retrieval | never |
| `bench:smoke` | Fast deterministic tests for schemas, evidence, profiles, and workflows | synthetic only | never |
| `bench:diagnostic` | Investigate retrieval with the benchmark-enhanced pipeline | `diagnostic-enhanced`, development only | never |
| `bench:baseline` | Measure the product users actually receive | `product-parity`, development and holdout separately | eligible complete runs only |

`baseline` invokes the shipped runtime with trace enabled, not a copied benchmark implementation. `diagnostic` keeps the deeper top-seed expansion and judge-reordering experiment under an explicit non-product profile.

The live workflows load the current plugin settings from `<vault>/.obsidian/plugins/aha-memory-surface/data.json` by default; override that source with `-- --plugin-data <path>`. Model, QMD/Obsidian commands, QMD runner, target count, and other behavior-affecting settings are passed to the runner and represented by a privacy-safe configuration identity. A stored API key is injected only through the configured child-process environment variable and is never written to arguments, manifests, reports, or traces. Fixture mode or a plugin workspace/wrapper mismatch blocks product parity.

An eligible baseline requires the same clean Git commit from start to finish, unchanged case-file hash, ready suite and identity validation, the exact active case set, successful scored runtime results, compatible `PipelineTrace` v2 artifacts, and product-parity provenance. Dirty, stale, partial, incompatible, or failed runs remain under `reports/runs/` with machine-readable reasons and do not replace the latest pointer.

The first baseline has no compatible comparison, so stability is honestly `not_measured`. A later compatible baseline may compare against the latest pointer.

Advanced direct commands remain available:

```bash
node scripts/bench/run-qmd-bench.mjs --suite development
node scripts/bench/run-pipeline-bench.mjs --profile product-parity --suite development
node scripts/bench/run-pipeline-bench.mjs --profile diagnostic-enhanced --suite development --only aha-001
node scripts/bench/summarize-report.mjs bench/reports/latest/product-parity.json
```

The QMD-only runner is L1. Product-parity and diagnostic-enhanced are two explicit L2 policies over the same `scripts/aha/retrieval-pipeline.mjs` mechanics; do not compare their headline scores as if they used the same budgets or enabled strategies. Product-parity still launches `scripts/aha/run-insight-search.mjs` as a process so transport, configuration, serialization, and failures remain measured. Case data, gold labels, scoring, failure attribution, reports, and promotion stay outside the runtime pipeline.
When L1 runs `--suite all`, its report still separates `by_suite` and `by_mode` metrics instead of presenting only a collapsed headline.

## Evidence, statistics, and action

- **Trace = evidence.** One privacy-bounded `PipelineTrace` per case records query planning, QMD rounds, source-graph expansion, candidates actually reviewed by the Relation Judge, final ordering, and stage errors. Trace collection is off in normal product use and is not stored in Session Records.
- **Summary = statistics.** Reports aggregate scored cases by suite and evaluation mode. Invalid cases do not become ordinary misses.
- **Feedback = decision/action.** A diagnosis should identify what to inspect or improve next; it is not another copy of the trace.

Traces exclude note bodies, full prompts, secrets, settings, and private absolute paths. They keep bounded identities, ranks, scores, relations, evidence metadata, and deterministic gold overlays needed for evaluation.

Primary @10 metrics:

- `Must Recall@10`
- `Useful Precision@10`
- `nDCG@10`
- `Negative Rate@10`

Diagnostics include `Expanded Pool Recall@20`, `Dropped Must Count`, evidence-based failure attribution, and `Stability@10` when a compatible comparison exists.

Stability is top-k overlap across runs only when suite version, profile, trace schema/version, effective configuration, candidate limit, and case set are compatible. Otherwise it is `not_measured` with a reason.

Failure attribution follows the observed trace. It can identify case/input, query, retrieval, relation judgment, ordering, or explicit runtime evidence. A deep candidate outside the Relation Judge review budget is retrieval evidence, not automatically a rerank failure. If the trace is incomplete, the result stays `unattributed`.

## Verification

Repository-wide deterministic verification:

```bash
npm run verify
```

Focused evaluation checks:

```bash
npm run bench:smoke
node --test scripts/aha/tests/bench-scoring.test.mjs
node --test scripts/aha/tests/review-seeds-collector.test.mjs
```

Private notes, local QMD state, and live model credentials are not required by the tracked CI/synthetic checks.
