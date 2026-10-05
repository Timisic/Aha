# Maintain the QMD index after new notes

Users can update manually or enable an update after a configurable number of new Markdown notes. The operation updates local text and then creates embeddings.

## Sub-features

- `index-configure` toggles automation and sets a positive note threshold.
- `index-trigger` counts distinct additions without counting ordinary edits or renames.
- `index-refresh` runs one update followed by embed, shared by manual and automatic callers.
- `index-persist` retains pending work across reload and failures.
- `index-recover` reports failure and supports a manual retry without losing pending notes.

## How to get to it (user POV)

- Open Settings, Aha, 索引.
- Set `Automatic QMD index updates` and `New notes per index update`.
- Use `立即更新` with accessible label `Embed now` for an immediate refresh or retry.
- Create Markdown notes in the vault, including through normal filesystem synchronization.

## Driving it with verify.mjs

Preconditions:

- `run-index` can access the configured QMD CLI and an existing embedding endpoint.
- The helper owns the temporary vault, QMD configuration/cache, home, profile, and CDP targets.

- Open Settings with `key(cdp, ',', 'Comma', 4)` and connect to the owned settings target. Choose Aha Dev.
- Set `input[aria-label="New notes per index update"]` to `10`. Click `[aria-label="Automatic QMD index updates"]`. Read settings from the fixture's data.json.
- Create nine Markdown fixtures. Require nine pending tokens and no update/embed commands in `qmd-requests.jsonl`.
- Rename one, modify Source, delete another, and recreate it. Require the expected pending count with no premature job.
- Create the tenth. Observe one update/embed pair. Create two more while it runs; require those two to remain pending after success.
- Run real QMD lexical and vector searches for the tenth fixture's unique term. Require its actual note path in returned results.
- Reload the app and require two pending tokens. Make the owned recording executable non-executable, then add eight notes. Require ten pending tokens, a persisted error, and a cooldown.
- Restore executable permission and click `[aria-label="Embed now"]`. Require one successful update/embed pair and zero pending tokens.
- Disable automation and add ten notes. Require ten pending tokens without another job. Capture `index-final` and retain report/CLI/file evidence after cleanup.

## Gotchas

- The fixture creates notes through the real vault filesystem watcher. It does not claim to verify Obsidian's editor New note command.
- Do not write the plugin data file while the plugin is active. Use real controls and inspect disk afterward.
- Aha candidate exclusions do not bound QMD index scope or text transmission.
- A failed acknowledgment save must retain pending work even when QMD itself completed.
- Live renames retain identity. Offline rename recognition depends on preserved filesystem identity; offline renames without identity are not proven by this fixture.
- Disabling automation prevents new automatic jobs and lets an already running job finish.
- No repeating retry timer exists. Manual retry can bypass cooldown; a subsequent automatic trigger must respect it.
- General plugin defaults remain disabled. Enabling this user's main vault is a separate authorized configuration action.
