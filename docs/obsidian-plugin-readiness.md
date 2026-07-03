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

- Binary: `~/.npm-global/bin/qmd`
- Version: `qmd 2.5.3`
- Obsidian index: `~/.cache/qmd/obsidian.sqlite`
- Indexed markdown files: 380
- Embedded vectors: 567
- Collection: `obsidian`
- Smoke search: passed with one JSON result for a small query.
- Plugin default runner: QMD SDK. The wrapper first tries `@tobilu/qmd`; if that package is not resolvable from the repo, it can infer the SDK module from the configured `qmd` command, for example `~/.npm-global/lib/node_modules/@tobilu/qmd/dist/index.js`.
- Plugin default QMD rerank: off. Aha still performs multi-query mixed retrieval, wrapper scoring/reranking, candidate excerpt reads, and bounded Relation Judge.

### QMD Remote Services

- Launchd tunnel: healthy
- Local ports: `127.0.0.1:18081`, `18082`, `18083`
- Remote services: embedding, generation, and rerank active
- Endpoint health: embedding, generation, and rerank all healthy

### Obsidian CLI

- Preferred CLI path for the search runner's Obsidian integration: `/Applications/Obsidian.app/Contents/MacOS/obsidian-cli`
- Smoke command: `files total`
- Result: 396 files

Note: `~/.local/bin/obsidian` also returned the CLI result, but emitted Electron helper warnings on stderr. Prefer the direct `obsidian-cli` path in plugin settings and wrapper defaults.

### OpenAI API

- Plugin default provider: `openai`
- Base URL: `https://api.openai.com/v1`
- Model: `gpt-5.5`
- API key source: plugin setting first; if empty, local environment variable, default `OPENAI_API_KEY`
- Readiness behavior: checks the configured OpenAI key source. A direct plugin key is injected only into the search runner child process environment and is not passed as a CLI argument.

### Codex CLI Fallback

- Binary: `~/.local/bin/codex`
- Version: `codex-cli 0.142.3`
- Non-interactive smoke: passed with `codex-smoke-ok`
- Correct fallback invocation shape for this installed version:

```bash
codex --ask-for-approval never --sandbox read-only exec --ephemeral -C "$AHA_PROJECT_ROOT" "<prompt>"
```

## Development Branch Gate

Before implementation starts, confirm:

- The issue breakdown in #14-#20 is reasonable.
- The direct Obsidian CLI path is acceptable as the default configured command.
- The MVP remains command-palette first and does not include a side panel.
- The MVP prepares Grill Handoff Markdown but does not automatically launch Codex.
- The normal plugin path uses OpenAI API for query planning and Relation Judge; Codex CLI remains a fallback provider.
- The normal plugin path uses QMD SDK with QMD internal rerank off; QMD CLI remains available for fallback and diagnostics.
