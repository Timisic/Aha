# Aha Memory Benchmark

This folder holds the small evaluation set for Aha / Pi `/insight` memory recall.

## What To Maintain

Edit `aha-memory-cases.json`. The fields you must fill for each real case are:

- `id`: a stable short id, such as `aha-001`.
- `status`: set to `active` when the case is ready to score. `draft` cases are ignored.
- One input form:
  - `insight_input`: paste the real text you would give `/insight`; or
  - `source_note_path`: a Markdown note path, plus optional `insight_thought`.
- `must_recall`: 1-8 old note paths that must appear in the Memory Stage candidates.

Useful optional fields:

- `nice_to_have`: useful notes that should not count as automatic failures if missing.
- `type`: rough analysis label, such as `source-note anchored`, `semantic`, `challenge`, `bounds`, or `cross-domain`. Leave it out if it does not help you think.
- `annotation_note`: one sentence explaining why the must-recall notes should appear.
- `description`: short human label for what this case tests.
- `expected_in_top_k`: override the default `10` only when you have a reason.
- `nice_expected_in_top_k`: override the default `20` for nice-to-have recall only.
- `source_note_start_line` / `source_note_end_line`: when a source note already contains post-`/insight` sections, limit the input to the original lines.

Do not hand-write search keywords as the source of truth. The source of truth is the realistic insight input plus the must-recall memories.
Benchmark queries are generated from the resolved raw input only; they do not read `must_recall` or `nice_to_have`, and cases should not contain hand-tuned query fields.
By default the scripts ask a query-generation agent to translate raw input into `intent:` / `lex:` / `vec:` / `hyde:`. The old deterministic extraction rules remain as fallback for offline or failed agent runs.

Path notes:

- `source_note_path` can be an absolute path, a path relative to this `bench/` folder, or a path under the Obsidian vault root.
- By default the vault root is `/Users/hong/Obsidian Notes`.
- Override it with `AHA_BENCH_VAULT_ROOT=/path/to/vault` if needed.
- `must_recall` paths can be absolute or collection-relative. QMD bench compares path suffixes, so either form is usually fine.

Minimal path-based case:

```json
{
  "id": "aha-001",
  "status": "active",
  "source_note_path": "/Users/hong/Obsidian Notes/path/to/source.md",
  "source_note_start_line": 9,
  "source_note_end_line": 18,
  "insight_thought": "Optional fresh thought that you would type after the note.",
  "must_recall": [
    "/Users/hong/Obsidian Notes/path/to/old-note.md"
  ],
  "nice_to_have": []
}
```

Minimal pasted-input case:

```json
{
  "id": "aha-002",
  "status": "active",
  "insight_input": "Paste the note or note + fresh thought here.",
  "must_recall": [
    "path/to/old-note.md"
  ],
  "nice_to_have": []
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
- L2: can QMD plus Obsidian backlink expansion produce a candidate pool, and can the rerank agent place useful notes into the final top K?

The L2 report marks each must-recall note as `qmd_query`, `qmd_vsearch`, `qmd_search`, `backlink`, a combined source label, or `missing`.

L2 still does not evaluate the final Agent presentation. It does not judge whether the final `Note | Relation | Hit | Why` table is persuasive; it checks whether required notes are present after agent reranking.

## First-Version Metrics

Primary metric:

- `R@10`: whether must-recall notes appear in the top 10 results. This matches the current workflow assumption that scanning about ten personally-written notes is still cheap.
- Source notes are excluded before scoring, so a self-hit at rank 1 does not make the ranks look better than they are.

Review metric:

- `found_must_recall_ranks`: sorted ranks for found must-recall notes, such as `[2, 3, 7, 10]`.
- `must_recall_ranks`: file-by-file rank details for each must-recall note.
- `worst_must_rank`: the latest rank among the must-recall notes that were found.
- `nice_to_have.recall_at_k`: how many useful-but-not-required notes appeared in the nice-to-have top K, default `20`.
- `nice_to_have.found_nice_to_have_ranks`: sorted ranks for found nice-to-have notes.

Debug field:

- `unmatched_expected_files`: which must-recall notes were missed.

Precision and F1 are still shown by QMD, but they are not first-version decision metrics because personal-note relevance is open-ended.
