# Aha Obsidian Plugin Readiness

Created: 2026-06-27

## GitHub Issues

- Full PRD: https://github.com/Timisic/Aha/issues/12
- MVP PRD: https://github.com/Timisic/Aha/issues/13
- MVP Issue 1: https://github.com/Timisic/Aha/issues/14
- MVP Issue 2: https://github.com/Timisic/Aha/issues/15
- MVP Issue 3: https://github.com/Timisic/Aha/issues/16
- MVP Issue 4: https://github.com/Timisic/Aha/issues/17
- MVP Issue 5: https://github.com/Timisic/Aha/issues/18
- MVP Issue 6: https://github.com/Timisic/Aha/issues/19
- MVP Issue 7: https://github.com/Timisic/Aha/issues/20

## Local Tool Checks

### QMD

- Binary: `/Users/hong/.npm-global/bin/qmd`
- Version: `qmd 2.5.3`
- Obsidian index: `/Users/hong/.cache/qmd/obsidian.sqlite`
- Indexed markdown files: 380
- Embedded vectors: 567
- Collection: `obsidian`
- Smoke search: passed with one JSON result for a small query.

### QMD Remote Services

- Launchd tunnel: healthy
- Local ports: `127.0.0.1:18081`, `18082`, `18083`
- Remote services: embedding, generation, and rerank active
- Endpoint health: embedding, generation, and rerank all healthy

### Obsidian CLI

- Preferred CLI path for the wrapper: `/Applications/Obsidian.app/Contents/MacOS/obsidian-cli`
- Smoke command: `files total`
- Result: 396 files

Note: `/Users/hong/.local/bin/obsidian` also returned the CLI result, but emitted Electron helper warnings on stderr. Prefer the direct `obsidian-cli` path in plugin settings and wrapper defaults.

### Codex CLI

- Binary: `/Users/hong/.local/bin/codex`
- Version: `codex-cli 0.142.3`
- Non-interactive smoke: passed with `codex-smoke-ok`
- Correct invocation shape for this installed version:

```bash
codex --ask-for-approval never --sandbox read-only exec --ephemeral -C "$AHA_PROJECT_ROOT" "<prompt>"
```

## Development Branch Gate

Before implementation starts, confirm:

- The issue breakdown in #14-#20 is reasonable.
- The direct Obsidian CLI path is acceptable as the default configured command.
- The MVP remains command-palette first and does not include a side panel.
- The MVP prepares Grill Handoff Markdown but does not automatically launch Codex.
