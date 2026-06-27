# Aha Obsidian Plugin MVP PRD

## Problem Statement

The user wants to start implementing the new Obsidian plugin path without turning the first branch into a full rewrite. The first version must prove the smallest useful loop: from the current Obsidian note, explicitly run Aha search, let Codex orchestrate QMD/backlink retrieval and Relation Judge, then write a readable Aha Review Note that the user can inspect and later bring into Codex for grilling.

The MVP should be fast enough to build, easy to verify, and narrow enough that the user can confirm issues and environment readiness before formal development proceeds.

## Solution

Build a command-palette-first Obsidian plugin MVP backed by a repo-local wrapper. The plugin resolves the current note, creates or updates an Aha Review Note, starts the wrapper in the background, shows coarse running time and success/failure, then opens the Review Note when done.

The wrapper launches `codex exec` with the Aha skill and a structured output schema. Codex reads the source note, generates structured QMD queries, calls QMD, expands Obsidian backlinks/outlinks when available, reads candidate note text, runs Relation Judge one candidate at a time inside the same Codex run, and returns 15-20 candidates. The wrapper writes those candidates into the Aha Review Note with relation, quote-backed hit, sufficiently detailed reason, and a Grill Handoff Markdown section.

## User Stories

1. As a note author, I want to run Aha search from the current Obsidian note, so that I can use the note as the current insight.
2. As a note author, I want search to start only after an explicit command, so that the plugin does not run retrieval just because I opened it.
3. As a note author, I want an Aha Review Note created on first search, so that this review leaves a visible artifact in my vault.
4. As a note author, I want the Review Note opened when the run completes, so that I can inspect the output immediately.
5. As a note author, I want the plugin to show that Aha is running and how long it has been running, so that I know it has not frozen.
6. As a note author, I want a clear failure message recorded in the Review Note, so that failed runs are not invisible.
7. As a note author, I want 15-20 candidate old notes returned, so that I have enough breadth to remove weaker candidates manually.
8. As a note author, I want each candidate to include relation, hit, and why, so that I can understand why it was retrieved.
9. As a note author, I want strong relation hits to be quote-backed, so that I can inspect evidence from the old note.
10. As a note author, I want weak relation available, so that the agent does not force a misleading strong label.
11. As a note author, I want candidate notes opened in a separate leaf or tab, so that my source insight note stays visible.
12. As a note author, I want the Review Note to include a Grill Handoff section, so that I can later continue in Codex using a compact Markdown context.
13. As a note author, I want the handoff to contain source insight link, selected old-note links, and detailed reasons, so that Codex can read the linked notes and understand why they matter.
14. As a developer, I want the plugin to stay thin, so that Obsidian does not become the reasoning runtime.
15. As a developer, I want the wrapper to be runnable outside Obsidian, so that I can debug Codex/QMD integration from the terminal.
16. As a developer, I want Codex to own QMD query generation and backlink expansion, so that the existing Aha skill remains the retrieval strategy.
17. As a developer, I want the first branch to preserve the Pi Extension code, so that the MVP does not become a migration or cleanup task.
18. As a developer, I want official Obsidian plugin conventions followed, so that the plugin can grow without fighting the platform.

## Implementation Decisions

- The MVP is command-palette first. The core command searches from the current note. A helper command may open the current Aha Review Note.
- The plugin creates or updates one Aha Review Note for the current insight review when the user triggers search.
- The Review Note contains minimal frontmatter, source insight link, search round summary, selected memories, relation details, optional quotes, and Grill Handoff.
- The MVP returns 15-20 candidates by default.
- Candidates are selected by default in the Review Note, but the first MVP does not need a complex checkbox UI beyond Markdown output.
- Candidate links open in a separate leaf/tab.
- The wrapper starts a single Codex run for the search round. Inside that run, Codex handles structured QMD query generation, QMD calls, backlink/outlink expansion, candidate reading, Relation Judge, and final ranking.
- Relation Judge labels are supports, challenges, resembles, bounds, and weak.
- Strong relations require quote-backed hits from old note text.
- The plugin only needs coarse status: running time, success/failure, and Review Note path.
- Failed runs append a failure record to the Review Note.
- The MVP prepares Grill Handoff Markdown but does not launch Codex automatically.
- The existing Pi Extension remains untouched.

## Testing Decisions

- Primary acceptance is an end-to-end manual smoke from a real Obsidian note: run the command, wait for completion, inspect the generated Review Note, and open at least one candidate in a separate leaf/tab.
- Wrapper smoke should verify that Codex CLI, QMD, and Obsidian CLI are discoverable and that a structured result can be written.
- Plugin smoke should verify current note detection, Review Note creation/opening, command registration, and failure recording.
- Schema validation should reject malformed Codex output before it is written as final candidate results.
- Failure cases should cover missing CLI tools and Codex/QMD run failure.
- Tests should prioritize artifact shape and visible behavior rather than implementation details.

## Out of Scope

- Side panel UI.
- Seed index.
- Automatic Codex launch or embedded grilling.
- Formal benchmark JSON generation.
- Deleting, archiving, or migrating the Pi Extension.
- Mobile support for external process execution.
- Full multi-round search UI beyond the first search loop.

## Further Notes

MVP success means the new architecture is real: Obsidian can act as the Memory Surface, Codex can orchestrate retrieval and relation judging, and the user's vault receives a durable Aha Review Note that is good enough to inspect and carry into later grilling.
