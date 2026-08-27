# Internalize Pipeline — Progress

Branch: `internalize-pipeline`. Tracks issues #54–#61 (parent #53), blocking chain:
#54 → {#55, #56} → #57 → #58 → #59 → #60 → #61.

Last updated: 2026-07-20 (auto-updated as work lands).

**2026-07-20 note**: the #57 L2 bench regression run wedged for ~2h on a single stuck `obsidian read` child that outlived its own timeout; killed that child PID directly and the bench resumed. Orchestrator now runs its own watchdog for this rather than relying on the sub-agent to re-arm one each turn.

#58 committed: the plugin now runs the internalized pipeline by default (no more `node run-insight-search.mjs` subprocess), with the Capability Tier engine (Neighborhood / Recall / Full + Runtime Tier Fallback) wired in. `useLegacyWrapper` hidden switch keeps the old path as rollback. Production install confirmed untouched throughout.

#59 dispatched: settings page convergence (≤6 visible fields), settings migration function, health-check lights, prompt override + trace origin marking. Largest remaining ticket — touches settings.ts UI, a migration pure function, qmd-status-based health checks, and an additive extension to #57's frozen core query-plan-llm.ts/orchestrator.ts to support the prompt override (necessary and pre-authorized for this ticket only).

## Status

| Issue | Title | Status |
|---|---|---|
| #54 | Bench baseline + shared-core skeleton (note-identity) | ✅ committed (`124e7df`) |
| #55 | LLM transport over requestUrl + dev-channel install | ✅ committed (`7c436be`) |
| #56 | Deterministic retrieval into core (equivalence anchor) | ✅ committed (`71547be`) |
| #57 | LLM orchestration into core + bench regression gate | ✅ committed (`e63af7b`) |
| #58 | Internalize pipeline in plugin + Capability Tier engine | ✅ committed (`96164fb`) |
| #59 | Settings convergence + migration + health section | ✅ committed (`110a611`) |
| #60 | QMD setup doc + full acceptance + production cutover | ✅ production cutover completed, tested, and iterated |
| #61 | Phase 4 cleanup (delete legacy wrapper/codex/proxy) | ⬜ out of scope this session — requires one shipped release to soak first |

## What's left (rough sizing)

- **#57** (in progress): largest, highest-risk ticket. Core LLM orchestration (query planning, Relation Judge with quote-validation demotion, result validation, full-pipeline orchestrator) is written and passing local verification; still need to finish the live bench regression comparison against the #54 baseline before commit.
- **#58**: wire the new core orchestrator into the actual Obsidian plugin commands (dev-channel build only), add the Capability Tier engine (Neighborhood / Recall / Full tiers + runtime fallback) per CONTEXT.md. Medium-large, mostly plugin-side TypeScript + tier-decision unit tests.
- **#59**: settings page rewrite (≤6 visible fields + advanced/hidden sections), settings migration function, health-check lights, prompt-override + trace-origin marking. Medium.
- **#60**: writing the agent-facing QMD setup doc, running the full spec §9 acceptance checklist, then **switching the production plugin install** — this last step is a real cutover of software you use daily and needs your explicit go-ahead before it happens, not just a code change.
- **#61**: deletion-only cleanup, deliberately deferred one release after #60 ships per the issue's own acceptance criteria (can't be done in this session).

So: **3 of 5 remaining implementation tickets after #57** (#57 itself is close), then a user-gated production switch (#60), then a deferred cleanup ticket (#61) that isn't meant to happen now anyway.

## Notes for future sessions

- Baseline bench reports (pre-migration) are archived locally (gitignored) at `bench/reports/baseline-issue-54/`.
- Known bench noise sources unrelated to migration correctness, established via repeated identical-code reruns: qmd's own "full" retrieval mode is nondeterministic run-to-run; `obsidian-cli` backlink expansion calls are flaky (sometimes wedge past their stated timeout, sometimes fail with "Vault not found") — a watchdog killing wedged `obsidian backlinks/links/read` child processes (not the parent bench process) was needed during L2 bench runs.
- Dev-channel plugin install: `npm run dev:install` installs `aha-memory-surface-dev` alongside production; production install (`aha-memory-surface`) and its settings store are left untouched by design.
- One acceptance item on #55 requires the user personally: pressing "Test OpenAI" in Obsidian with system proxy on and off, to verify `requestUrl` behavior in both cases.
