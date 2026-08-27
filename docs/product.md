# Product

## Register

product

## Users

Aha is used by one note author inside a local Obsidian vault. The user is reviewing a current insight while staying close to their source note, old notes, and later Codex handoff.

## Product Purpose

Aha grounds a fresh insight in older personal notes. The Obsidian plugin acts as the Memory Surface: it runs an explicit search, shows candidate old notes with relation reasons, lets the user choose what belongs in the handoff, and keeps compact session state for reopening the panel without creating default review-note artifacts.

## Brand Personality

Quiet, precise, low-burden. The interface should feel like a native Obsidian tool for judgment review, not a separate product surface.

## Anti-references

Avoid marketing-style panels, explanatory onboarding text, oversized cards, decorative color, and spreadsheet layouts that waste horizontal space. Do not make the panel compete with the source note.

## Design Principles

- Keep the source note and candidate review visible at the same time.
- Put judgment evidence first: old note, relation, reason, and optional hit.
- Prefer compact native controls over custom UI.
- Use an icon that suggests memory relationships around an insight, such as `orbit`; avoid checklist, generic AI sparkle, or generic lightbulb metaphors.
- Keep command-palette commands short and product-shaped: `Aha: Run`, `Aha: Open Panel`, `Aha: Check Readiness`.
- Keep the no-history panel state quiet: show the current source note, a short `No history yet` state, and one primary `Run Aha` action.
- Let the user decide what enters the handoff; never auto-promote candidates beyond the visible selection state.
- Keep session state compact.
- Keep the panel footer focused on one primary action, `Copy handoff`; place rerun in the header, candidate feedback inline, and low-frequency actions outside the panel.
- Let the panel follow the active source note by default, with a pin control for focused review that should not change when the active note changes.
- Preserve user choices and feedback across reruns when the same memory candidate appears again, while allowing model-generated relation text to refresh.
- Keep handoff selection separate from feedback signals: `noise` may default a candidate out of selection, but only selection controls the handoff and only feedback controls draft seed material.
- Keep explicit handoff checkboxes: non-weak candidates default selected, `weak` candidates default unselected, and marking a candidate as `noise` automatically clears its selection.
- Keep `weak` candidates visible in the main list with muted treatment rather than hiding them in a collapsed section.

## Accessibility & Inclusion

Use Obsidian theme variables, native focus behavior, semantic controls, and restrained motion. Text should remain readable in light and dark themes, with useful hit targets for checkbox and note-opening actions.
