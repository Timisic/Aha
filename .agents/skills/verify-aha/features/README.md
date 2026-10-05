# Aha verification map

Use these pages as the maintained list of user entry points and observable outcomes. The default helper run verifies only the paths listed in its `report.json`.

## Baseline

Launch through [the skill](../SKILL.md). The fixture contains `Source.md` linking to `Counterexample.md`, and `Backlink.md` linking to Source. It enables only Aha Dev, uses an empty Session Store, and selects Neighborhood through an unavailable QMD executable. Doctor must confirm the owned instance before input.

## Driving conventions

Each feature recipe names calls inside the executable helper's `drive(run)` function. Reuse its CDP input helpers when extending a scenario. `command(cdp, 'Run')` means the actual command palette, not calling plugin methods. `click` requires a unique visible selector and optionally exact button text. Capture with `snapshot(run, cdp, label)` after an action and a condition-based wait.

Run an edited scenario with `node .agents/skills/verify-aha/scripts/verify.mjs run`. Use a fresh launch for each complete drive. Keep evidence outside scratch and retain failed attempts. Record each entry point used and every skipped path. A passing alternative entry point does not prove the skipped one.

## Features

- [Search and panel restoration](search.md) covers command and panel runs, capability tiers, and stale results.
- [Read candidates and follow notes](reading.md) covers candidate links, the editor command, pinning, and following.
- [Select and copy handoff](selection.md) covers selection persistence and clipboard output.
- [Record feedback](feedback.md) covers Surprise, accept, noise, and missing-memory feedback.
- [Save and revisit thoughts](thoughts.md) covers Markdown writes, saved search, editing, and reload.

- [Quick link insertion](quick-links.md) covers selected or paragraph input, real QMD recall, multiselect, insertion, undo, and cancellation.

## Coverage boundary

The generated scenario covers command Run in Neighborhood, a selection toggle, Surprise, button-based thought saving, saved search, and command Open Panel after reload. Other mapped paths are source-grounded recipes until executed. Provider-backed tiers need a separate configured fixture. The stock helper intentionally keeps QMD unavailable.

The separate `run-links` scenario covers quick insertion with real QMD in a synthetic index. Read its `report.json` for the exact executed branches.
