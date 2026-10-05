# Quickly insert related wiki links

While writing, users request a short list of related notes, choose one or several, and insert their wiki links without replacing the source text.

## Sub-features

- `links-input` uses selected text, the full current paragraph, or the previous paragraph on a blank line.
- `links-recall` makes one semantic QMD request and shows at most four safe, distinct Markdown candidates.
- `links-choose` supports arrows, Space, mouse toggles, and Enter for checked or highlighted candidates.
- `links-insert` preserves the source and inserts all links in one undo step.
- `links-cancel` closes on Escape, the close button, outside click, stale editor context, or a replaced request.

## How to get to it (user POV)

- In a Markdown editor, choose `Aha (Dev): Insert related links` from the command palette.
- Assign that command a shortcut in Obsidian Settings, Hotkeys. The fixture assigns Mod+Shift+L.
- Select text first to choose the retrieval input. With no selection, leave the caret in the intended paragraph or on the blank line after it.

## Driving it with verify.mjs

Preconditions:

- Launch with `run-links` or `launch-links` and existing QMD embedding environment variables.
- Doctor passes for the owned instance. The synthetic QMD index has completed real embedding.

- Open Source through `.nav-file-title[data-path="Source.md"]`. Focus its `.cm-content[contenteditable="true"]` and select text through actual keyboard input.
- Press the configured shortcut using `key(cdp, 'L', 'KeyL', 12)`. Require `.aha-quick-links` and one to four `.aha-quick-link-option` rows.
- Inspect each row's `data-path`. Require no Source result, duplicates, or missing/outside-vault notes. Read `qmd-requests.jsonl` to require exactly one structured `vec:` query per completed trigger, with no expansion, rerank, or readiness subprocess.
- Use Space, ArrowDown, Space, Enter. Require two native links appended at the captured selection end, unchanged original content, actual link resolution, and persisted Markdown.
- Undo once. Require the exact original text. Press the shortcut again and Escape. Require unchanged text.
- Type two trailing newlines and trigger again. Require the preceding full paragraph in the actual QMD argument. Enter without checked rows must insert the highlighted result at the blank-line caret.
- Toggle a row by mouse. Require `aria-selected` to change. Cancel with Escape, then cancel another request while it is loading. Require the child command to exit and no late popup or edit.
- Capture `links-candidates`, `links-inserted`, `links-previous-paragraph`, and `links-final`, plus the copied source and CLI records. Require the Session Store to remain empty and all candidate files to remain unchanged.
- For additional entry-point coverage, call `command(cdp, 'Insert related links')`. Exercise the close button `button[aria-label="取消插入双链"]`, outside click, typing during loading, file switching, repeat invocation, empty input, and QMD errors. Only mark branches actually exercised in the report.

## Gotchas

- The production plugin does not assign a default shortcut. The fixture shortcut belongs only to its scratch vault.
- Candidate highlight is separate from checked selection. Enter uses the highlight only when nothing is checked.
- Full Review Panel retrieval, DeepSeek, and Session Store are not part of this command.
- A changed document or selection invalidates the captured insertion location. Cancellation is preferable to inserting at a stale offset.
- A small synthetic index can prove the path and ranking for its fixture. It cannot establish personal-vault retrieval quality or production latency.
- Remote model availability is a prerequisite for this real retrieval proof. Report failure rather than silently replacing QMD results.
