# Read candidates and follow notes

Users open the old note behind a candidate and decide whether the panel stays with the source or follows the active note.

## Sub-features

- `read-link` opens a candidate from the panel.
- `read-command` opens the first wiki link on the cursor line.
- `read-source` returns to the source note.
- `read-pin-follow` fixes the panel to a source or follows the active note.

## How to get to it (user POV)

- Click a candidate title or the source link in the panel.
- Put the editor cursor on a wiki-link line and choose `Aha: Open Candidate`.
- Click the panel pin button labeled `固定当前笔记` or `跟随当前笔记`.

## Driving it with verify.mjs

Preconditions:

- Search has completed in the temporary vault.
- Run this branch before leaving results for the saved-thought view.

- Pin with `await click(cdp, 'button[aria-label="固定当前笔记"]')`. Require its label to become `跟随当前笔记`.
- Open the old note with `await click(cdp, '.aha-review-panel-note-link[title="Counterexample.md"]')`. Observe the active file path and visible Counterexample content. Require the panel source to remain Source while pinned.
- Click `await click(cdp, '.aha-review-panel-source-link')`. Require Source to become active.
- Unpin with `await click(cdp, 'button[aria-label="跟随当前笔记"]')`. Open Counterexample again and require the panel source to follow it.
- For the editor entry, open Source, focus its editor, position the cursor on `[[Counterexample]]` with keyboard input, and call `await command(cdp, 'Open Candidate')`. Require a new tab with Counterexample. Record the cursor position with the action.
- Capture screenshots and active-file observations. Compare all fixture Markdown files before and after this read-only flow.

## Gotchas

- Candidate opening changes the active note. Pin first when subsequent feedback must stay attached to Source.
- The editor command reads the first wiki link on the current line. A note containing a link elsewhere is insufficient.
- The default scenario exercises candidate and source links, pinning, and following. The editor Open Candidate command remains a separate recipe.
