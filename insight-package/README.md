# Pi Insight Package

`pi-insight-package` provides the `/insight` Pi extension as a Git-manageable Pi package.

The package preserves the existing Insight-to-Judgment workflow:

- `/insight` creates a session from editor input, or cancels active insight mode.
- `/insight <content>` creates a session directly.
- `/insight list`, `/insight resume <selector>`, and `/insight current` keep the existing behavior.
- Existing session state remains under the configured Insight runtime root, normally `~/.pi/agent/insights/`.

## Package Layout

- `extensions/insight.ts` is the Pi extension entrypoint.
- `src/domain.ts` defines session schema types, stage names, constants, and shared utilities.
- `src/session.ts` handles state paths, index files, session restore, bindings, and grill-context files.
- `src/source-note.ts` handles Obsidian/source-note parsing, source-root limits, size limits, structure hints, and refresh.
- `src/memory.ts` handles QMD search, backlink expansion, dedupe, labels, rendering, and memory-stage guardrails.
- `src/prompts.ts` builds stage prompts and Review-Grill briefing.
- `src/commands.ts` registers `/insight`.
- `src/tools.ts` registers `insight_search_memory`, `insight_update_state`, `insight_append_grill_context`, and `insight_save_summary`.
- `tests/` contains regression and adversarial workflow tests.

## Loading Locally

Install or load the package from its directory:

```bash
pi install /Users/hong/Downloads/Pi/insight-package
```

For a one-off smoke test without changing settings:

```bash
pi --verbose --offline --no-tools --no-extensions -e /Users/hong/Downloads/Pi/insight-package --print ""
```

Do not also keep the old single-file extension enabled at `~/.pi/agent/extensions/insight.ts`, or Pi will try to register `/insight` twice.

## Tests

```bash
npm test
npm run test:ultraqa
npm run build
npm run smoke:offline
```

The adversarial test covers resume, stage guardrails, QMD timeout cleanup, oversized output, misleading failed output, corrupt state, path spoofing, cancel behavior, and summary saving.

## Git Boundary

Git should manage this package directory only. Do not initialize Git in `~/.pi/agent`.

Excluded runtime/private data includes:

- Pi sessions, logs, settings, auth, and model files
- insight runtime state under `~/.pi/agent/insights/`
- `node_modules`, build outputs, local env files, and backups

## Rollback

The old single-file extension can be kept as a backup with a non-`.ts` suffix, for example:

```bash
~/.pi/agent/extensions/insight.ts.bak-20260609
```

To roll back, remove this package from Pi settings, rename the backup to `insight.ts`, then reload Pi.
