# Split memory surface from reasoning workflow

Aha will move away from a Pi Extension-shaped product toward a lighter architecture where the memory surface lives near the user's notes and the reasoning workflow lives in Codex skills. The memory surface owns explicit search triggering, candidate display, relation evidence, user review choices, additional search rounds, note/span opening, benchmark seed capture, and the grill handoff; Codex plus the retrieval backend owns retrieval, relation judging, grilling, and judgment synthesis.

This keeps the note environment focused on reviewing and selecting memory rather than becoming a second agent runtime. It also preserves the core human-authored, agent-retrieved boundary: old notes remain under the user's control, while agent work produces inspectable candidates, quotes, reasons, and handoff material.

## Considered Options

- Continue with the Pi Extension as the primary product shape. Rejected because the workflow became too tied to one chat runtime and made the memory-review surface heavier than it needs to be.
- Put the full grilling conversation state inside the note plugin. Rejected because it would turn the plugin into a workflow engine instead of a focused memory review surface.

## Consequences

- The plugin should persist only Memory Review State, not the later grilling transcript.
- The plugin should create one Aha Review Note per insight review when the user explicitly triggers the first memory search. That note can live in the user's note vault and gather the source insight link, search rounds, Selected Memories, relation reasons, optional quotes, grill handoff section, and any benchmark seeds saved from the review.
- The default vault storage should stay simple: `Aha/Reviews/` contains one review note per insight; an optional `Aha/Seeds Index.md` can summarize saved seeds later. Avoid splitting handoffs, seeds, and reports into separate folders until actual use requires it.
- Aha Review Note filenames should be readable by default, using `{YYYY-MM-DD} {source insight title}.md`; sanitize long or invalid titles and append a short suffix only when needed to prevent collisions.
- Aha Review Notes should use minimal frontmatter for extraction and filtering, such as `aha: review`, `source`, `created`, and `status`; detailed candidates and reasons remain in human-readable Markdown sections. Initial statuses are `memory_review`, `handoff_ready`, and `grilled`.
- Retrieval Orchestration belongs to Codex, not the plugin wrapper. The wrapper may launch `codex exec`, pass the source note and output schema, constrain permissions, and capture results, but Codex should generate structured QMD queries, call QMD, expand backlinks/outlinks, read final candidate notes, and produce evidence-bound relation outputs.
- Relation Judge should run one candidate at a time inside a single Codex run for the search round, rather than starting one Codex process per candidate. This preserves independent per-candidate judgment while avoiding process startup overhead and simplifying progress reporting.
- MVP progress reporting should stay coarse: the plugin only needs running time, success/failure, and the Aha Review Note path. Detailed Codex events and per-stage logs can be captured by the wrapper for debugging and speed optimization, but they are not part of the first plugin UI contract.
- Failed runs should preserve the Aha Review Note and append a failure record rather than deleting the note. This keeps the attempted review visible and lets the user rerun from the same review note after fixing Codex, QMD, or path problems.
- The first Obsidian plugin MVP should prove a compact loop: trigger Aha search from the current note, run the wrapper/Codex retrieval flow in the background, generate or update an Aha Review Note under `Aha/Reviews/`, open that note when done, and prepare a Grill Handoff Markdown section for later Codex use. Side panels, seed indexes, and automatic Codex launch are later work.
- The first Obsidian plugin branch should keep the existing Pi Extension code intact as historical/runtime reference. It may add an Obsidian plugin, wrapper scripts, schemas, and docs, but should not delete or migrate `insight-package/` until the new path works.
- The first Obsidian plugin UI should be command-palette first, with `Aha: Search from current note` as the core command and optionally a simple `Aha: Open current review note` helper. A side panel is later work.
- MVP code should use a simple directory split: `obsidian-plugin/` for the plugin shell, and `scripts/aha/` for wrapper scripts, prompts, and schemas. The existing `insight-package/` remains untouched.
- MVP retrieval output should target 15-20 candidate notes, not a short 5-note sample, because the user expects enough breadth to remove weak items manually before handoff.
- Candidate note links and quote targets should open in a separate Obsidian leaf/tab so the current insight note is not replaced.
- The plugin implementation should follow official Obsidian plugin conventions: TypeScript plugin structure, command-palette first behavior, settings through Obsidian plugin APIs, vault-safe file writes, minimal dependencies, and desktop-only gating for any Node/Electron process calls needed to launch the wrapper.
- The handoff to Codex should be a concise section of the Aha Review Note, using links to the source insight and Selected Memories plus sufficiently detailed relation reasons. Candidates may be selected by default after retrieval, but only the currently selected set is exported. The handoff should avoid copying full note bodies by default, but the reasons must be rich enough for Codex to understand why each memory was selected.
- Future implementation should keep relation judging and benchmark seed capture independent from Pi-specific stage machinery.
