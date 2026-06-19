# Aha GPT Pro Review Issues

This file turns the GPT Pro review into repo-local, independently grabbable issues.
Each issue is a vertical slice with behavior, state, tests, and benchmark/docs where applicable.

## Issue 01: Enforce the Insight stage machine at tool boundaries

## What to build

Make the `/insight` workflow stages system-enforced instead of prompt-enforced:
memory retrieval is the only path into the candidate checkpoint, user review is required before grill, explicit readiness is required before summary, summary save defaults to staying in summary, and complete sessions cannot be reopened implicitly.

## Acceptance criteria

- [x] Direct `insight_save_summary` before readiness is rejected.
- [x] Direct `insight_update_state(stage="complete")` outside summary is rejected.
- [x] `insight_search_memory` cannot move a complete or summary session back to memory review.
- [x] Tests cover failed bypass attempts and the valid readiness path.

## Blocked by

None - can start immediately.

## Issue 02: Persist user memory review provenance

## What to build

Record candidate-level user review decisions and require accepted review provenance before a memory can become `usedMemoryIds`.

## Acceptance criteria

- [x] State stores accepted/rejected/uncertain memory review records with timestamp and user-text hash.
- [x] Unknown, rejected, or unreviewed memory IDs are rejected by update and summary tools.
- [x] Entering grill requires at least one recorded user candidate review.
- [x] Candidate judgments have stable IDs, evidence memory IDs, replacement links, and durable user confirmation fields.

## Blocked by

Issue 01.

## Issue 03: Align runtime retrieval with L2 benchmark defaults and evidence merging

## What to build

Make runtime retrieval behavior match the benchmark pipeline for backlink expansion and candidate evidence aggregation.

## Acceptance criteria

- [x] Backlink expansion is on by default and can be disabled with false-like environment values.
- [x] Duplicate candidates aggregate sources/evidence before dedupe can discard data.
- [x] Runtime and benchmark share one Obsidian path resolver for `qmd://`, absolute, vault-relative, slug, and basename inputs.
- [x] Runtime backlink lookup handles `qmd://`, absolute, vault-relative, slug, and basename candidate identities.
- [x] Basename/path collisions are surfaced as ambiguity instead of silently choosing one file.

## Blocked by

None - can start immediately.

## Issue 04: Remove source-note self-hits from runtime candidate slots

## What to build

Filter exact source-note self-hits from the runtime candidate pool before rerank/top-K selection, matching benchmark scoring behavior while recording the filtered rank in trajectory.

## Acceptance criteria

- [x] Runtime filters candidates matching the session source note path/identity before final top-K.
- [x] Trajectory records source-note self-hit rank and candidate identity when filtered.
- [x] Tests prove a source note no longer consumes one displayed review slot.

## Blocked by

Issue 03.

## Issue 05: Persist a bounded candidate pool and explicit cue results

## What to build

Store a bounded full candidate pool separately from displayed top-K so repeat searches can rerank old and new evidence together, and report explicit cue status using pool-aware results.

## Acceptance criteria

- [x] State has `memoryCandidatePool` and displayed `memoryCandidates`.
- [x] Each retrieval reranks the full bounded pool and then selects top-K for display.
- [x] `explicitCueResults` distinguishes `found_top_k`, `found_pool`, `not_found`, and `ambiguous`.
- [x] Tests cover an explicit cue found below top-K without marking it missing.

## Blocked by

Issue 03.

## Issue 06: Use fair backlink seed selection

## What to build

Avoid allowing the first query shape to monopolize backlink seeds; choose seeds across query kinds with a simple round-robin or RRF-style ranking.

## Acceptance criteria

- [x] Backlink seeds include candidates from multiple query kinds when available.
- [x] Trajectory records seed selection inputs and selected seed IDs.
- [x] Tests cover raw/query/search candidates competing for the seed limit.

## Blocked by

Issue 05.

## Issue 07: Harden state schema, migration, and writes

## What to build

Make persisted session state versioned, migrated, default-filled, and safely written.

## Acceptance criteria

- [x] Restored older state gets defaults for missing array fields.
- [x] `state.json` and `index.json` writes use a temp-file then rename path.
- [x] State includes `schemaVersion`.
- [x] A migration function upgrades older state shapes explicitly.
- [x] Mutating tools are serialized or protected from concurrent state writes.

## Blocked by

Issue 01.

## Issue 08: Replace source-note heading hard gate with drift-aware warnings

## What to build

Keep source-note structure as guidance, but avoid failing default summary saves solely because headings changed or were intentionally omitted. Preserve a hard gate only when explicitly requested.

## Acceptance criteria

- [x] Intake stores source note content hash and heading snapshot.
- [x] Summary save detects source note drift and returns warnings.
- [x] Missing headings are warnings by default.
- [x] `preserveSourceStructure: true` keeps the hard validation behavior.
- [x] Tests cover drift, default warning save, and opt-in hard failure.

## Blocked by

Issue 01.

## Issue 09: Correct benchmark identity matching and ranking metrics

## What to build

Make benchmark scoring use canonical vault-relative identity instead of suffix matches, and make reported recall/rank metrics penalize misses correctly.

## Acceptance criteria

- [x] `precision_at_k` uses the returned-results denominator.
- [x] `target_coverage_at_k`, `all_must_recalled_at_k`, and `missing_must_count` are reported.
- [x] Missed must-recall files contribute `K + 1` to `worst_must_rank`.
- [x] Path matching uses exact normalized or canonical slug identity instead of suffix matching.
- [x] Ambiguous benchmark gold paths fail fast as benchmark configuration errors.

## Blocked by

Issue 03.

## Issue 10: Add benchmark ablations and reproducibility metadata

## What to build

Every L2 report should explain where recall was gained or lost, and should be reproducible across model/binary/index changes.

## Acceptance criteria

- [x] Reports include raw-only vs multi-query, backlinks off/on, reranker none/agent, first-10 vs fair seeds, and source-note filter off/on ablations.
- [x] Reports identify cases where expanded pool had an answer but final top-K dropped it.
- [x] Reports include git commit, pipeline/prompt versions, query/rerank model, agent binary version, QMD/Obsidian CLI versions, vault/index snapshot hash, cache hit/miss, fallback counts, and timeout counts.
- [x] Reports include git commit, pipeline/prompt versions, query/rerank model, agent binary version, QMD/Obsidian CLI versions, and configured vault root.
- [x] Cache keys include model and binary/prompt versions.

## Blocked by

Issues 03, 04, 05, 06, 09.

## Issue 11: Expand L2 benchmark case coverage

## What to build

Grow benchmark cases from the current small source-note-anchored set to a representative suite covering the review's retrieval edge cases.

## Acceptance criteria

- [x] 12-20 active cases cover semantic-only, exact explicit cue, explicit cue miss, challenge, bounds, resemblance, negative/no-related-memory, source-note self-hit, duplicate names, aliases, absolute paths, `qmd://`, long source note, second-round retrieval, QMD partial failure, query fallback, and reranker fallback.
- [x] Cases remain based on real `/insight` input rather than synthetic query strings.
- [x] README documents how to add and validate new cases.

## Blocked by

Issues 03, 04, 05, 09.

## Issue 12: Add scripted L3 core-loop benchmark

## What to build

Add a deterministic end-to-end benchmark for the human-in-the-loop contract: fake QMD candidates, scripted accept/reject review, grill, failed pre-readiness summary attempt, readiness confirmation, summary draft, resume, and second memory search.

## Acceptance criteria

- [x] L3 benchmark wrapper exists and writes latest/archive reports from the deterministic UltraQA harness.
- [x] L3 verifies candidate table appears before grill.
- [x] L3 verifies missing cue display.
- [x] L3 verifies accepted/rejected memory reviews are in state.
- [x] L3 verifies accepted memory reviews are in state.
- [x] L3 verifies summary before readiness is rejected.
- [x] L3 verifies used memories were accepted by user review.
- [x] L3 verifies summary contains judgment shift, boundary, and unresolved questions.
- [x] L3 verifies source note is not rewritten.
- [x] L3 verifies resume preserves stage/review state and a new insight can trigger second memory search.

## Blocked by

Issues 01, 02, 04, 05, 08.
