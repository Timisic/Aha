# Aha Memory Benchmark

This folder holds the small evaluation set for Aha / Pi `/insight` memory recall.

## What To Maintain

Real benchmark cases live in the local-only `aha-memory-cases.json`. This file can contain private note text and Obsidian paths, so it is ignored by Git and should not be committed.

Review feedback seeds can also be collected into the local-only `aha-memory-seed-cases.json`. This second file is an ignored benchmark-like inbox: it is generated from Obsidian Review Notes, stays `state: draft`, and is meant for human review before any case is copied or promoted into `aha-memory-cases.json`.

Start by copying the sanitized template:

```bash
cp bench/aha-memory-cases.example.json bench/aha-memory-cases.json
```

Then edit `aha-memory-cases.json` using the v3 primary benchmark schema. Prefer vault-relative note paths, not full local paths. In other words, write:

```json
"Categories/Evergreen/example-feedback-density.md"
```

instead of:

```json
"/path/to/vault/Categories/Evergreen/example-feedback-density.md"
```

The runner resolves these short paths under `AHA_BENCH_VAULT_ROOT` / `~/Obsidian Notes`.

The fields you must fill for each real case are:

- `id`: a stable short id, such as `aha-001`.
- `state`: case lifecycle state:
  - `active`: included in normal benchmark runs.
  - `draft`: ignored by normal runs; use while you are still confirming the case.
  - `off`: retained but excluded even when drafts are included.
- `title`: short human label for reports and curation. It is not retrieval input and does not affect scoring.
- `input`: the real material you would give `/insight`:
  - `input.note`: optional Obsidian note path. Prefer a path relative to the vault root.
  - `input.lines`: required by default when `input.note` is present; 1-based inclusive line range, e.g. `[8, 20]`.
  - `input.whole_note`: set to `true` only when the whole note is intentionally the benchmark input. Do not use missing `lines` as an implicit whole-note read.
  - `input.thought`: the real `/insight` thought; with `note` it is extra focus, without `note` it is the complete standalone input.
- `gold`: human labels used for scoring:
  - `gold.must`: 1-8 old note paths, preferably vault-relative, that must appear in the ten-candidate Review Attention Budget unless `expected_no_recall` is explicitly true.
  - `gold.nice`: useful old notes that improve review quality but should not count as hard failures if missing.
  - `gold.noise`: superficially related notes that should be treated as noise if surfaced as useful.
- `why`: short annotation rationale for future human maintenance. It is not retrieval input and does not affect scoring.

Useful optional fields:

- `expected_no_recall`: set to `true` only for draft/no-must cases such as accept-only seed inbox entries.
- `expected_in_top_k`: override the default Review Attention Budget of `10` only when you have a reason.
- `nice_expected_in_top_k`: override the default `20` for nice-to-have recall only.
- `expanded_pool_expected_in_top_k`: override the default diagnostic budget of `20` for expanded-pool reach checks.

Legacy flat fields (`status`, `source_note_path`, `source_note_start_line`, `insight_input`, `must_recall`, `nice_to_have`, `negative`, `description`, `annotation_note`) are still readable for migration, but new files should use v3.

Preview the exact source-note excerpt before promoting or running a case:

```bash
node scripts/bench/extract-note-excerpt.mjs \
  --note "Projects/path/to/source.md" \
  --lines 8:20 \
  --vault-root "$HOME/Obsidian Notes"
```

Or preview a case directly:

```bash
node scripts/bench/extract-note-excerpt.mjs --case aha-001 --full-input
```

The preview script refuses to read a whole note unless `--allow-full-note` is explicit on the CLI or `input.whole_note: true` is explicit in the case. This is a safety check: benchmark inputs should normally expose only the original line range to the LLM, not the entire evolving note.

If a case file has already accumulated full vault paths, normalize it back to the shorter writing style:

```bash
node scripts/bench/normalize-case-paths.mjs bench/aha-memory-cases.json
```

With no file arguments, the script normalizes existing local benchmark case files under `bench/`.

Do not hand-write search keywords as the source of truth. The source of truth is the realistic insight input plus the human labels (`gold.must`, `gold.nice`, and `gold.noise`).
Benchmark queries are generated from the resolved raw input only; they do not read gold labels, `title`, or `why`, and cases should not contain hand-tuned query fields.
By default the scripts ask a query-generation agent to translate raw input into `intent:` / `lex:` / `vec:` / `hyde:`. The old deterministic extraction rules remain as fallback for offline or failed agent runs.

During early curation, keep only human-vetted cases as `active`, even if that means the default suite has just a few cases. As the suite matures, aim for 12-20 real active cases. Engineering edge cases such as exact cue handling, duplicate basenames, qmd URI resolution, source-note self-hit filtering, and no-related-memory behavior belong in a separate regression fixture, not in the primary benchmark score. Local private regression cases can live in ignored `bench/aha-memory-regression-cases.json`.

Review Feedback Actions are a separate daily flow. The Obsidian Review Note can record visible **Review Benchmark Seeds**:

- `accept` -> draft `gold.nice` seed material.
- `reject_as_noise` -> draft `gold.noise` seed material.
- `should_have_found` -> draft `gold.must` seed material.

These seeds are inspectable Markdown in the Review Note. They do **not** mutate `bench/aha-memory-cases.json`.

To avoid hand-copying Markdown fields, collect Review Note seeds into the ignored seed inbox:

```bash
node scripts/bench/collect-review-seeds.mjs \
  --vault-root "$HOME/Obsidian Notes" \
  --output bench/aha-memory-seed-cases.json
```

The collector scans `Aha/Reviews` by default and writes v3 draft cases grouped by source note:

- `accept` seeds become `gold.nice`.
- `reject_as_noise` seeds become `gold.noise`.
- `should_have_found` seeds become `gold.must`.
- accept-only or noise-only groups get `expected_no_recall: true` so they remain valid draft eval-v2 cases without inventing a must label.
- same-memory label conflicts are resolved as `must > noise > nice` and recorded in `seed_label_conflicts` for human inspection.
- because current Review Notes do not store source line ranges, seed inbox cases use `input.whole_note: true`; replace it with `input.lines` before promoting to active when the original excerpt is known.

Seed inbox cases do not become active Benchmark Cases until a human copies/promotes them into `aha-memory-cases.json` and changes `state` deliberately.

You can smoke-test the seed inbox without touching the active suite:

```bash
node scripts/bench/run-pipeline-bench.mjs \
  --cases bench/aha-memory-seed-cases.json \
  --include-draft
```

Path notes:

- `input.note` can still be an absolute path, a path relative to this `bench/` folder, or a path under the Obsidian vault root, but vault-relative paths are the recommended hand-editing format.
- By default the vault root is the local Obsidian vault, usually `~/Obsidian Notes`.
- Override it with `AHA_BENCH_VAULT_ROOT=/path/to/vault` if needed.
- `gold.must` / `gold.nice` / `gold.noise` paths can be absolute or collection-relative, but vault-relative is preferred and they must resolve to a unique canonical vault-relative identity. The scorer no longer accepts suffix-only matches because duplicate basenames can create false hits.

Minimal source-note excerpt case:

```json
{
  "id": "aha-001",
  "state": "active",
  "title": "Short human-readable case title",
  "input": {
    "note": "path/to/source.md",
    "lines": [9, 18],
    "thought": "Optional fresh thought that you would type after the note excerpt."
  },
  "gold": {
    "must": [
      "path/to/old-note.md"
    ],
    "nice": [
      "path/to/useful-but-optional.md"
    ],
    "noise": [
      "path/to/false-friend-noise.md"
    ]
  },
  "why": "One sentence explaining why the labels are present."
}
```

Minimal standalone thought case:

```json
{
  "id": "aha-002",
  "state": "draft",
  "title": "Standalone insight case",
  "input": {
    "thought": "Paste the exact standalone /insight text here."
  },
  "gold": {
    "must": [
      "path/to/old-note.md"
    ],
    "nice": [],
    "noise": []
  },
  "why": "Use standalone thought only when there is no source-note excerpt."
}
```

Explicit whole-note case:

```json
{
  "id": "aha-003",
  "state": "draft",
  "title": "Whole-note insight case",
  "input": {
    "note": "path/to/source.md",
    "whole_note": true,
    "thought": "Optional extra focus."
  },
  "gold": {
    "must": [
      "path/to/old-note.md"
    ],
    "nice": [],
    "noise": []
  },
  "why": "Use whole_note only when the whole note is the intended input."
}
```

## Generated Files

`scripts/bench/build-fixture.mjs` converts active cases into a QMD fixture:

```bash
node scripts/bench/build-fixture.mjs bench/aha-memory-cases.json bench/generated/qmd-fixture.json
```

The default query generator is `agent`. Use `--query-generator rules` only when you need a fully deterministic offline fallback:

```bash
node scripts/bench/build-fixture.mjs bench/aha-memory-cases.json bench/generated/qmd-fixture.json --query-generator rules
```

The generated fixture contains executable structured QMD queries:

```text
intent: ...
lex: ...
vec: ...
hyde: ...
```

Review this generated file when scores move unexpectedly. A score can change because the case changed, the generated query changed, or QMD retrieval changed.
Agent-generated query objects are cached under `bench/generated/qmd-query-agent-cache.json` by raw-input hash, so repeated runs do not keep changing the query unless the raw input or query prompt version changes.

## Run

L1: QMD retrieval only.

```bash
node scripts/bench/run-qmd-bench.mjs
```

This builds `bench/generated/qmd-fixture.json`, runs:

```bash
qmd --index obsidian bench bench/generated/qmd-fixture.json --json
```

and writes the latest report to `bench/reports/latest/qmd.json`.
Timestamped copies go under `bench/reports/archive/`.
The report fixture records `query_generated_by`, `query_object`, and any fallback error so query-generation drift is visible.
The benchmark policy boundary is split by module: `scripts/lib/aha-query-generation.mjs` owns query generation and its `rules` / cached Codex exec adapters; `scripts/lib/aha-bench-evaluation.mjs` owns path matching, source-note exclusion, must-recall / nice-to-have scoring, and report summary policy.

L2: Memory pipeline approximation.

```bash
node scripts/bench/run-pipeline-bench.mjs
```

This reads the same active cases, asks the query-generation agent for 3-5 structured QMD queries, runs QMD for seed candidates, expands backlinks from the top 10 QMD seeds with Obsidian CLI, merges QMD/backlink evidence, asks a rerank agent to rank the combined candidate pool, and writes `bench/reports/latest/pipeline.json`.

L2 answers a different question from L1:

- L1: can QMD directly retrieve the must-recall notes?
- L2: can QMD plus Obsidian backlink expansion produce a candidate pool, and can the rerank agent concentrate useful notes into the final top ten?

The L2 report marks each must-recall note as `qmd_query`, `qmd_vsearch`, `qmd_search`, `backlink`, a combined source label, or `missing`.

L2 still does not evaluate the final Agent presentation. It does not judge whether the final `Note | Relation | Hit | Why` table is persuasive; it checks whether required notes are present after agent reranking.

Run the standard ablation suite:

```bash
node scripts/bench/run-pipeline-ablations.mjs
```

This writes one child report per variant under `bench/reports/latest/pipeline-ablations/` and a summary at `bench/reports/latest/pipeline-ablations.json`. The variants compare:

- `raw-only` versus multi-query retrieval.
- backlinks off versus on.
- `reranker none` versus the configured reranker.
- first-10 backlink seeds versus fair query-kind seeds.
- source-note filter off versus on.

Use `-- <pipeline options>` to pass options through to every child run, for example:

```bash
node scripts/bench/run-pipeline-ablations.mjs -- --query-generator rules --reranker none
```

## L3 Core Loop

Run the scripted human-in-the-loop contract benchmark:

```bash
node scripts/bench/run-l3-core-loop.mjs
```

The L3 wrapper runs the deterministic UltraQA extension harness and writes `bench/reports/latest/l3-core-loop.json` plus a timestamped archive. It verifies the tool-level contract around candidate display, user memory review, readiness gating, summary artifact creation, source-note non-mutation, resume, and second memory search.

## Eval-v2 Metrics

Aha eval-v2 optimizes valuable old-memory concentration under a ten-candidate Review Attention Budget. The main question is not “did any search result look plausible,” but “did the ten items worth reviewing contain the required memories, useful optional memories, and little active noise?”

Primary metrics at `@10`:

- `Must Recall@10`: fraction of `must_recall` memories found inside the top ten.
- `Useful Precision@10`: distinct `must_recall` + `nice_to_have` hits inside the top ten, divided by ten.
- `nDCG@10`: ranking quality with non-negative graded relevance; `must_recall` is weighted above `nice_to_have`, while `negative` is measured separately.
- `Negative Rate@10`: active `negative` memories hit inside the top ten, divided by ten.

Diagnostics:

- `Expanded Pool Recall@20`: whether QMD + backlink expansion reached must-recall memories inside the wider diagnostic pool before final reranking.
- `Dropped Must Count`: must-recall memories reached by the expanded pool but absent from the final top ten, including items retained at rank 11+.
- `Stability@10`: deterministic report fingerprint/score for the final top-ten candidate order; repeated deterministic runs should stay stable.
- `Failure Attribution`: one primary group per failed/poor-ranking case, plus optional flags.

Failure Attribution primary groups:

- `case_label_failure`
- `input_representation_failure`
- `query_failure`
- `retrieval_failure`
- `rerank_failure`
- `relation_failure`

Diagnostic flags may record secondary symptoms such as instability, path aliasing, source self-hit, review-note pollution, runtime fallback, ambiguous identity, or dropped must-recall from final top-K. Flags do not replace the single primary attribution.

Legacy recall fields remain for compatibility:

- `target_coverage_at_k`, `found_must_recall_ranks`, `must_recall_ranks`, `worst_must_rank`, `all_must_recalled_at_k`, `missing_must_count`.
- `nice_to_have.recall_at_k` and `nice_to_have.found_nice_to_have_ranks`.
- `unmatched_expected_files` still means not found in the scored result list at all; use `Dropped Must Count` for top-ten misses reached by the expanded pool.

Precision and F1 are still shown by QMD where available, but they are not eval-v2 decision metrics because personal-note relevance is open-ended.

Reports include reproducibility metadata such as git commit, pipeline/prompt versions, agent bins/versions/models, cache paths, QMD/Obsidian CLI versions, and vault root. Agent cache keys include the prompt version, agent binary, and model so changing models cannot silently reuse stale query/rerank outputs.
L2 reports also include the configured query mode, backlink seed strategy, source-note filter status, a vault markdown snapshot hash, index/collection metadata, cache hit/miss counts inferred from agent generation provenance, fallback counts, and QMD/Obsidian timeout counts.

## Eval-v2 Verification Path

Use deterministic tests first; they do not call live QMD, Obsidian, model APIs, or private benchmark cases:

```bash
node --test scripts/aha/tests/aha-bench-eval-v2.test.mjs
node --test scripts/aha/tests/review-note.test.mjs
node --test scripts/aha/tests/review-seeds-collector.test.mjs
node --check scripts/bench/collect-review-seeds.mjs
node --check scripts/bench/run-pipeline-bench.mjs
node --check scripts/bench/summarize-report.mjs
```

For plugin-facing review seed changes, also run:

```bash
cd obsidian-plugin && npm run verify
```

For a live local benchmark smoke, run the L2 pipeline only after confirming `bench/aha-memory-cases.json` is the ignored private file you intend to use:

```bash
node scripts/bench/run-pipeline-bench.mjs
```
