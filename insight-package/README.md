# Aha Pi Extension Package

This package contains Aha's installable `/insight` Pi extension.

## Package contract

- Package name: `@timisic/aha-pi-insight`.
- Install path today: Git checkout or Git dependency.
- License: MIT.
- Supported host: macOS/Linux, Node.js `>=22.19.0 <26`, Bun `>=1.2.0 <2` for builds.
- Supported peers: `@earendil-works/pi-coding-agent >=0.79.0 <0.80.0`, `@earendil-works/pi-tui >=0.79.0 <0.80.0`, `typebox >=1.1.0 <2`.

Normal dependency resolution uses package imports. `PI_TYPEBOX_PATH` and `PI_TUI_PATH` remain advanced escape hatches for non-standard Pi installs.

## Commands

```text
/insight
/insight <raw thought and context>
/insight list
/insight resume <session-id-or-directory>
/insight current
/insight doctor
/insight doctor --json
```

`/insight doctor` is read-only except for a small write probe in the configured insight home. It runs one synthetic QMD query and does not enumerate or print real note contents.

## Local setup

```bash
npm ci
npm run typecheck
npm test
npm run test:doctor
npm run test:ultraqa
npm run build
npm run demo:offline
```

Load in Pi from this directory:

```bash
pi install .
```

Smoke load from the repository root:

```bash
pi --verbose --offline --no-tools --no-extensions -e ./insight-package --print ""
```

Do not keep the legacy single-file extension enabled at `~/.pi/agent/extensions/insight.ts`; Pi will register `/insight` twice.

## Layout

- `extensions/insight.ts`: Pi extension entrypoint.
- `src/config.ts`: supported envelope and configuration defaults.
- `src/doctor.ts`: `/insight doctor` checks and formatting.
- `src/commands.ts`: command registration.
- `src/tools.ts`: workflow tools.
- `src/session.ts`: session state and artifact paths.
- `src/memory*.ts`: QMD/backlink retrieval and reranking.
- `demo-vault/`: public synthetic first-run fixture.
- `tests/`: regression, UltraQA, and doctor tests.

## Rollback

Remove this package from Pi settings or reinstall a previous Git revision. Keep old backups renamed with a non-`.ts` suffix.
