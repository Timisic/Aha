# Select candidates and copy handoff

Users select the old notes they want to bring into Grilling and copy a handoff containing those selections.

## Sub-features

- `select-toggle` includes or excludes a candidate.
- `select-restore` restores selections after reload.
- `select-copy` copies the selected evidence to the clipboard.

## How to get to it (user POV)

- Toggle a candidate checkbox in the `纳入` column.
- Click `复制 Grill Handoff` below the results.

## Driving it with verify.mjs

Preconditions:

- The default Neighborhood search has completed.
- For clipboard checks, preserve the user's clipboard with its formats and restore it afterwards. Omit copying if the driver cannot preserve it.

- Read the checked value, then use `await click(cdp, '.aha-review-panel-row:has(a[title="Counterexample.md"]) input[type="checkbox"]')`.
- Require the row's persisted `selected` value to invert in `await storedRound(run)`. Require the panel count to agree.
- Reload, reopen Source and Open Panel, and require the checkbox to retain that value. The default scenario covers this branch.
- For copying, explicitly select only Backlink, then use `await click(cdp, '.aha-review-panel-copy')`. Read the actual clipboard through the platform API. Require Source context and Backlink, with Counterexample excluded. Preserve the copied text as evidence before restoring the original clipboard.

## Gotchas

- Copy writes the system clipboard shared with the user's other apps. Separate Electron profiles do not isolate it.
- Noise feedback can clear a selection. Check selections after feedback if testing the combined path.
- The default scenario verifies checkbox persistence and leaves clipboard copying unverified.
