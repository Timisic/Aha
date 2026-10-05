# Save and revisit thoughts

Users write what a surprising connection means, save it to their source note, and later find or edit it in saved Surprise.

## Sub-features

- `thought-save-button` saves a thought to Markdown and plugin state.
- `thought-save-keyboard` saves with Cmd+Enter or Ctrl+Enter.
- `thought-saved-search` filters saved Surprise entries.
- `thought-edit` replaces the earlier thought block without duplication.
- `thought-restore` restores saved text after app reload.

## How to get to it (user POV)

- Click Surprise, type in `我的想法`, then click `保存` or use the keyboard shortcut.
- Click `已保存`, whose accessible label is `查看已保存的 Surprise`.
- Search with `查找已保存的想法`, then choose `补充想法` or `编辑想法` on a saved entry.
- Click `返回结果` to return to the current results.

## Driving it with verify.mjs

Preconditions:

- Backlink has Surprise feedback in the temporary Source review.
- Only synthetic notes are used because saving writes source Markdown.

- Fill the row's `textarea[aria-label="我的想法"]` with the helper's `thought` string through `fill`. Click the row's button with exact text `保存`.
- Require the original Source bytes followed by one `[[Backlink]]` and thought block. Read `data.json` and require `feedback.note` plus `feedback.noteWrite.status === 'saved'`. Require both candidate files unchanged.
- Click `await click(cdp, 'button[aria-label="查看已保存的 Surprise"]')`. Require `.aha-saved-thought` to contain the exact thought.
- Fill `input[aria-label="查找已保存的想法"]` with `no-such-thought`. Require `没有匹配的记录`. Search `counterexample` and require one `.aha-saved-entry`.
- Reload, run doctor, reopen Source and Open Panel, and return to saved Surprise. Require the saved thought and feedback marking. These paths are in the default scenario.
- For the keyboard entry, fill a new thought, then call `await key(cdp, 'Enter', 'Enter', 4)` while its textarea is focused. Require the same disk and journal assertions.
- For editing, click `编辑想法` within the matching `.aha-saved-entry`, edit its textarea, and save. Require the old block to be replaced exactly once, with text outside the block unchanged.
- For return navigation, use `await click(cdp, '.aha-review-panel-seed-button', '返回结果')` and require the prior results.

## Gotchas

- Saved thoughts mutate the source note. The README's general no-rewrite language does not remove this explicit user-action side effect.
- Never overwrite `data.json` while the plugin is loaded. Read it for evidence.
- Unsaved drafts live in the view and do not survive plugin reload.
- If the original thought block was manually changed or duplicated, saving can report a conflict and retain the draft. Do not silently repair the user's text.
- Editing and keyboard-save paths remain unverified by the default scenario.
