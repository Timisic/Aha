# Quick-link latency, 2026-10-06

Quick links now expose the ranked candidates before their original excerpts finish.
The scorer, candidate exclusions, ordering and excerpt-selection algorithm are unchanged.
Users can select or insert immediately; excerpt completion preserves their selection.

## Measured result

The existing 445-note QMD index was queried from isolated Obsidian instances using
local Markdown copies. Each of five alternating before/after launches ran the same
two synthetic questions, giving ten requests per version. Timing starts at command
activation and ends only after the popup has laid out inside the viewport.

| Milestone | Before median, range | After median, range |
|---|---|---|
| Candidates visible and selectable | 2.77 s, 2.42–3.36 s | 0.98 s, 0.60–1.32 s |
| Original excerpts complete | 2.77 s, 2.42–3.36 s | 2.82 s, 2.36–3.09 s |

All ten optimized requests matched the reference candidate order and exact original
excerpts. Selection made while excerpts were pending survived in all ten cases.
No timed request failed. These are observations on two questions, not a guarantee
for every vault or provider load. Complete excerpts have not reached a two-second
target; the selectable list has in these measured cases.

## Limiter and comparison

Phase measurements placed most remaining time in remote excerpt reranking. It uses
the existing Qwen3 reranker, sometimes with window ranking followed by sentence
refinement. QMD recall and safe note loading finish earlier. The change removes
that dependency from initial selection without substituting weaker excerpts.
No response cache, remote model change or server configuration change was used.

The compared product implementations are `d524cc0` and `0966ee5`. Later settings
copy and verification changes do not change this retrieval path. Local traces hold
the bundle hashes, per-request timings and private excerpt comparisons and are
intentionally excluded from Git.

## Repeat

Follow the production-index benchmark and archived-bundle instructions in
[verify-aha](../.agents/skills/verify-aha/SKILL.md). Report first selection and final
excerpt completion separately. Preserve actual provider results, count failures,
and compare output quality rather than treating a fast fallback as success.
