# Search and restore the panel

Aha finds old notes for the active Markdown note and restores the latest saved review when the panel reopens.

## Sub-features

- `search-command` runs from the command palette.
- `search-panel` runs from the panel button.
- `search-neighborhood` shows backlinks and outlinks when QMD is unavailable.
- `search-recall-full` uses QMD and optionally DeepSeek when configured.
- `search-restore-stale` restores results and identifies changed source text.

## How to get to it (user POV)

- Open a Markdown note and choose `Aha (Dev): Run` in the command palette.
- Choose `Aha (Dev): Open Panel`, then click `运行 Aha`.
- Reopen a previous source note and its panel after restarting Obsidian.

## Driving it with verify.mjs

Preconditions:

- Doctor passes for a fresh fixture.
- Source has one outlink and one backlink. The default fixture has no working QMD or API credentials.

- Open the source with `await click(cdp, '.nav-file-title[data-path="Source.md"]')`. Wait for `app.workspace.getActiveFile()?.path === 'Source.md'` through read-only observation.
- Run with `await command(cdp, 'Run')`. Require exactly Backlink and Counterexample in `.aha-review-panel-note-link`, both with relation `weak`.
- Inspect `await storedRound(run)`. Require success, no duplicates, and no Source candidate. Require original Markdown unchanged before thought saving. Capture `01-neighborhood`.
- For the panel entry, use `await command(cdp, 'Open Panel')`, then `await click(cdp, '.aha-review-panel-run')`. Require a new successful round. This entry is not exercised by the default scenario.
- For restoration, use `await cdp.send('Page.reload', {ignoreCache:true})`, wait for the plugin, rerun doctor, reopen Source, and choose Open Panel. Require the saved candidates and selection.
- To test empty Neighborhood, use a fresh fixture with an unlinked source. Require a successful zero-candidate round.
- For Recall or Full, create a separately configured synthetic fixture and update doctor expectations. Observe the actual tier, candidate files, and trace failures. A weak Neighborhood result does not verify these tiers.

## Gotchas

- Run needs an active Markdown note. Source text changes can make the saved review stale.
- The availability probe executes QMD with `--version`. Neighborhood avoids QMD retrieval and LLM calls after the probe fails.
- Full can fall back to Recall. Check trace outcome and warnings before claiming a Full success.
- `Check Readiness` can send a real provider request.
