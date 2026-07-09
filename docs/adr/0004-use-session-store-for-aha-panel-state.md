# Use Session Store for Aha panel state

Aha should keep per-source-note review state in a compact Obsidian plugin data Session Store, not in default-generated Aha Review Notes. The panel should reopen prior candidates, selection, feedback, staleness, and handoff state from this store, while Review Notes become explicit exports for moments when the user wants a durable vault artifact.

This keeps the Memory Surface low-burden and avoids filling the vault with review artifacts the user does not want to read. It also separates product state from process evidence: the Session Store keeps only Panel State, detailed retrieval and ranking evidence stays in traces, and old Review Notes are migrated once into Session Records before the user deletes them manually.

## Considered Options

- Keep Aha Review Notes as the source of truth. Rejected because it makes every run create a Markdown artifact and forces the panel to depend on a note the user does not want as part of the normal workflow.
- Store session records as hidden or JSON files in the vault. Rejected because it still turns tool state into vault clutter and makes cleanup feel like note management.
- Add a standing import command for old Review Notes. Rejected because this is a one-time migration for the user's current two legacy notes, not a recurring product workflow.

## Consequences

- Source note identity, not the review note path, is the primary key for panel history.
- Review Note export is a low-frequency command-palette action and does not appear in the panel.
- The panel follows the active source note by default, with optional pinning for focused review.
- Reruns preserve user feedback and handoff selection for repeated candidates while allowing model-generated relation text to refresh.
- Legacy Review Migration is judged by whether the panel can recover candidates, selection, feedback, and handoff from the old notes, not by perfect Markdown preservation.
