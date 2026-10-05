# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

TypeScript Obsidian desktop plugin, with native Obsidian controls and CodeMirror editor extensions. QMD runs through a local CLI. This is an editor plugin, not a standalone website. macOS is the primary development and verification environment.

## Users

Aha is used by a note author while writing and revisiting a personal Obsidian vault. The author decides which old notes matter and what to write next.

## Product Purpose

Aha brings older notes into current thinking. It supports focused review of an insight and quick insertion of related wiki links while writing.

## Positioning

The Review Panel asks whether an older note supports, challenges, resembles, or bounds a current judgment. Quick related links provides a smaller writing-time action. Neither retrieval score nor an AI explanation proves that a connection is useful. The author supplies that judgment.

## Operating Context

- The vault remains the source of truth for authored notes.
- The Review Panel uses QMD retrieval and optional DeepSeek relation judgment. It stores review state and feedback in plugin data.
- Quick related links uses selected text or the current paragraph, displays at most four candidates beside the caret, and inserts only the links the author confirms.
- QMD indexes live on the local machine. Configured remote inference services receive readable text for the operations they perform. See [data flow](data-flow.md).
- Automatic index maintenance is optional. Its default threshold is ten new Markdown notes. A refresh includes both `qmd update` and `qmd embed`.

## Capabilities and Constraints

The plugin supports the Review Panel, candidate navigation, selection, Surprise feedback, saved thoughts, quick wiki links, and configurable index maintenance. It requires desktop process access for QMD.

Saving a thought explicitly appends or updates a thought block in the source note. Confirming quick links inserts links at the captured selection end or caret. Both actions preserve unrelated source text. Cancelling quick links writes nothing.

Automatic indexing does not imply local-only inference. Its transmission boundary follows the user's QMD configuration. Candidate exclusion folders are retrieval filters, not an indexing privacy policy.

## Brand Commitments

Aha is quiet, precise, and low-burden. Keep the interaction inside the user's existing Obsidian workflow. Preserve the established native controls, theme variables, and restrained presentation. Avoid marketing panels, decorative AI symbols, large cards, and explanations that compete with the source note.

## Evidence on Hand

The repository contains unit and integration tests and a project-local [verification skill](../.agents/skills/verify-aha/SKILL.md). Its isolated Obsidian fixtures exercise actual UI actions and persisted files. The quick-link fixture uses real QMD against synthetic notes.

Synthetic acceptance proves those mechanics. It does not establish retrieval quality, Surprise value, or latency on every personal vault. No claim of improved long-term judgment has been established.

## Product Principles

- Keep understanding and final selection with the author.
- Keep writing-time actions brief, with few candidates and no unnecessary confirmation steps.
- Preserve existing text and review history. Make intentional mutations visible and reversible.
- Show honest empty, failure, and fallback states.
- Distinguish authored content, retrieved evidence, model explanations, and user feedback.

## Accessibility & Inclusion

Preserve keyboard operation and editor focus. Announce quick-link candidate and selection changes through the editor's accessible live region. Use native theme colors and controls. Verify the actual interaction as well as its appearance.
