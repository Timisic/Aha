# Record candidate feedback

Users classify candidates, mark a surprising connection, and identify a note the search missed.

## Sub-features

- `feedback-surprise` marks a candidate and opens the thought editor.
- `feedback-classify` switches accept or noise.
- `feedback-repeat` avoids duplicate records for a repeated marked action.
- `feedback-missing` records should-have-found feedback.

## How to get to it (user POV)

- Click `surprise`, `accept`, or `noise` in a candidate row.
- Click `record must` and save a missing note in the modal.

## Driving it with verify.mjs

Preconditions:

- Search has completed for Source.
- Scope all candidate controls to a row containing its exact note path.

- Use `const row = '.aha-review-panel-row:has(a[title="Backlink.md"])'`, then `await click(cdp, row + ' button[data-action="surprise"]')`.
- Require a persisted feedback item with action `surprise`, matching candidate path, and `aria-pressed="true"` on that row's button. The thought textarea becomes available. The default scenario covers this branch.
- Click the marked Surprise again. Require the same feedback count and an available editor.
- Click `await click(cdp, row + ' button[data-action="accept"]')`, then the `reject_as_noise` action. Require latest classification noise, cleared selection, and Surprise still marked.
- Open missing-memory input with `await click(cdp, '.aha-review-panel-seed-button', 'record must')`. Fill `.modal input[type="text"]` with `Counterexample.md`, then click `.modal button` with exact text `保存`. Require `should_have_found` in persisted feedback.
- Capture the affected row, feedback records, and post-reload markings for each branch executed.

## Gotchas

- A highlighted button alone does not prove a durable write. Read `data.json` and reopen the panel.
- Saving disables that candidate's feedback controls temporarily. Wait for persistence before the next action.
- Only Surprise marking is covered by the default scenario. Classification, duplicates, and missing-memory paths need separate execution.
