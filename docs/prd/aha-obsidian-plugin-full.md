# Aha Obsidian Plugin Full PRD

## Problem Statement

The user wants Aha to become a long-term personal product for grounding new insights in their own historical notes. The current Pi Extension proved the Insight-to-Judgment workflow, but it is too tied to one chat runtime and stores too much workflow state outside the user's natural note environment.

The user needs a lighter Memory Surface in Obsidian: starting from the current note, explicitly retrieve related old notes, see why they matter, open them without losing the source note, preserve review artifacts in the vault, and hand selected memories to Codex for deeper grilling. The system should not pretend to find every relevant memory. It should make each recalled relationship inspectable, evidence-bound, rejectable, and available as future benchmark material.

## Solution

Aha should move to an Obsidian plugin plus repo-local wrapper plus Codex/QMD architecture.

From the user's perspective, the plugin adds a command that treats the current Obsidian note as the source insight, explicitly triggers Aha search, and creates an Aha Review Note in the vault. Codex acts as Retrieval Orchestration: it reads the source note, generates multiple structured QMD queries, calls QMD, expands Obsidian backlinks/outlinks, reads candidate note text, runs Relation Judge one candidate at a time, and returns 15-20 candidate old notes with relation, quote-backed hit, and sufficiently detailed reason.

The Aha Review Note becomes the durable human-readable artifact. It records the source insight link, search rounds, selected memories, relation reasons, optional quotes, a Grill Handoff section, and any explicitly saved Review Benchmark Seeds. Obsidian remains the user's note and review surface; Codex remains the reasoning workflow for retrieval, relation judging, grilling, and judgment synthesis.

## User Stories

1. As a note author, I want to trigger Aha search from the current Obsidian note, so that I can ground a fresh insight without leaving the note vault.
2. As a note author, I want search to run only when I explicitly trigger it, so that opening the plugin does not start background retrieval.
3. As a note author, I want an Aha Review Note created on first search, so that every insight review leaves a visible vault artifact.
4. As a note author, I want Aha Review Notes stored under one simple review area, so that I can find past review sessions easily.
5. As a note author, I want review filenames based on date and source title, so that the artifacts are readable in Obsidian.
6. As a note author, I want filename collision handling, so that repeated reviews on the same date do not overwrite each other.
7. As a note author, I want minimal frontmatter, so that future scripts can find Aha Review Notes without making the note feel like a database.
8. As a note author, I want Codex to generate multiple structured QMD queries, so that search covers claim, counterexample, boundary, analogy, and old decision angles.
9. As a note author, I want QMD to remain the retrieval backend, so that Aha uses the existing local semantic index.
10. As a note author, I want Obsidian backlink and outlink expansion, so that graph neighbors can surface old memories that pure semantic search misses.
11. As a note author, I want Codex to read candidate note text before judging, so that relation reasons are not based only on snippets.
12. As a note author, I want Relation Judge to compare one candidate note with the current insight at a time, so that relation labels are evidence-bound rather than ranking rationalizations.
13. As a note author, I want relation labels to include supports, challenges, resembles, bounds, and weak, so that the system can avoid forced classification.
14. As a note author, I want weak matches retained but downgraded, so that private associations are not discarded too early.
15. As a note author, I want strong relations to include one to three source quotes, so that I can inspect the evidence behind the label.
16. As a note author, I want relation reasons to be sufficiently detailed, so that Codex can later use the handoff without re-deriving every selection rationale.
17. As a note author, I want 15-20 candidate notes, so that there is enough breadth for manual deletion before grilling.
18. As a note author, I want candidates selected by default, so that I can review by removing low-value items rather than manually building the set from scratch.
19. As a note author, I want to open candidate old notes in a separate leaf or tab, so that my current insight note stays in place.
20. As a note author, I want quoted spans to point me to the relevant area of an old note when possible, so that review is faster.
21. As a note author, I want multiple search rounds to accumulate into one candidate pool, so that second-round search can deepen the same review.
22. As a note author, I want search rounds to remain visible as provenance, so that I know which direction produced each candidate.
23. As a note author, I want selected memories exported into a Grill Handoff section, so that I can continue in Codex with the right context.
24. As a note author, I want the Grill Handoff to use Obsidian links and reasons rather than full copied note bodies, so that the handoff remains compact and readable.
25. As a note author, I want the plugin to prepare the handoff but not automatically launch Codex, so that I stay in control of when grilling starts.
26. As a note author, I want to explicitly save Review Benchmark Seeds, so that only reviewed useful relations become future evaluation material.
27. As a note author, I want benchmark seeds stored first in the Aha Review Note, so that seed capture remains part of the review artifact before becoming formal benchmark JSON.
28. As a note author, I want future tooling to convert reviewed seeds into benchmark cases, so that real use improves evaluation over time.
29. As a note author, I want failed runs preserved in the Aha Review Note, so that failed attempts are visible and rerunnable.
30. As a note author, I want coarse progress feedback, so that I know Aha is running without needing to understand Codex internals.
31. As a note author, I want detailed logs available for debugging, so that speed and runtime failures can be improved later.
32. As a developer, I want the plugin shell to stay thin, so that Obsidian remains a Memory Surface rather than a second agent runtime.
33. As a developer, I want wrapper scripts to launch, constrain, capture, and write back Codex results, so that runtime integration is testable outside Obsidian.
34. As a developer, I want Codex to own query generation and QMD/backlink orchestration, so that the intelligent retrieval strategy remains in the Aha skill.
35. As a developer, I want the existing Pi Extension preserved during the transition, so that proven behavior remains available as reference.
36. As a developer, I want official Obsidian plugin conventions followed, so that the plugin remains maintainable and installable.
37. As a developer, I want desktop-only gating for external process calls, so that unsupported mobile behavior fails clearly.
38. As a developer, I want a high-level end-to-end test seam, so that the feature is validated by the review artifact users actually consume.

## Implementation Decisions

- The new product shape is Memory Surface plus Reasoning Workflow: Obsidian owns note-facing review and artifact storage; Codex owns retrieval orchestration, relation judging, grilling, and synthesis.
- The existing Pi Extension stays intact during the first Obsidian plugin branch. It remains a historical and runtime reference until the new path works.
- The plugin is command-palette first. The core command searches from the current note; a helper command can open the current review note. Side panels are later work.
- The plugin creates one Aha Review Note per insight review when the user explicitly triggers the first memory search.
- Aha Review Notes live in a simple reviews area in the vault. A seed index may be added later, but handoffs, seeds, and reports should not be split into separate folders until usage demands it.
- Aha Review Note filenames use date plus source insight title, with sanitized/truncated titles and a short suffix only for collisions.
- Aha Review Notes use minimal frontmatter for type, source link, creation time, and coarse status.
- Initial review statuses are memory_review, handoff_ready, and grilled.
- The wrapper launches Codex in non-interactive mode with explicit sandbox, approval, schema, and output settings. It should not contain query-generation, reranking, or relation-judging intelligence.
- Codex runs as the retrieval orchestrator. It generates structured QMD queries, calls QMD, expands backlinks/outlinks, reads final candidate notes, and produces evidence-bound relation outputs.
- Relation Judge runs one candidate at a time inside a single Codex run per search round, not one Codex process per candidate.
- Strong relations require source-text quotes. The explanation may summarize or connect, but the quote must be copied from the old note text.
- The output contract centers on candidate note, relation, hit, and why. Hit should be quote-backed; why should be detailed enough for later Codex grilling.
- The plugin opens candidate notes in a separate leaf/tab rather than replacing the current insight note.
- The plugin prepares a Grill Handoff Markdown section but does not automatically launch Codex or embed a grill UI.
- Selected candidates are included in the handoff; selected does not mean accepted as final judgment evidence.
- Review Benchmark Seeds are created only by explicit save action, first as structured entries inside the review note.
- Failed runs preserve and append to the review note rather than deleting the artifact.
- Official Obsidian plugin conventions guide the implementation: TypeScript plugin structure, command registration through the plugin API, settings through plugin APIs, vault-safe file writes, minimal dependencies, and desktop-only gating for external process calls.

## Testing Decisions

- The highest-value seam is the end-to-end review artifact: given a current source note, the system should create or update an Aha Review Note with candidates, relations, quotes/reasons, and handoff material.
- Wrapper behavior should be tested outside Obsidian with a fixture source note and mocked or recorded Codex output where possible.
- Plugin behavior should be tested at the command boundary: current note resolution, review note creation/opening, background process status, failure recording, and candidate note opening in a separate leaf.
- Relation output should be schema-validated before writing to the review note.
- Failure tests should cover missing Codex CLI, missing QMD, failed QMD health, unreadable source note, malformed Codex output, and review note collision.
- Existing benchmark and pipeline scripts are prior art for QMD query generation, backlink expansion, candidate scoring, path identity, and report metadata.
- Existing extension tests are prior art for command-level workflow contracts, source-note non-mutation, and failure handling.
- Tests should assert user-visible behavior and artifact shape, not internal implementation steps.

## Out of Scope

- Rewriting or deleting the existing Pi Extension during the first branch.
- Automatically editing the user's source notes.
- Automatically launching or running Codex grilling from Obsidian.
- Building a complex side panel before the command-first workflow works.
- Converting benchmark seeds directly into committed benchmark JSON during MVP.
- Multi-agent distribution inside the plugin.
- Supporting Obsidian mobile for external process execution.

## Further Notes

The strongest product claim is not "Aha finds all relevant memories." The stronger and more honest claim is that Aha makes retrieved memory relations evidence-bound, reviewable, rejectable, and reusable. This is why Relation Judge and Review Benchmark Seeds are central to the product shape.
