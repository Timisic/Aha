# Test layout

Three tiers, matching a standard test pyramid:

- **`unit/`** — pure logic, no real subprocess, no real network. Fast,
  deterministic. Many of these rebuild `obsidian-plugin/dist/core.mjs` via a
  real `esbuild` compile step (core is TypeScript), but that's an
  implementation detail of testing compiled TS as `.mjs` — the tests
  themselves exercise one module's logic in isolation with injected fakes.
- **`integration/`** — real subprocess spawns (the CLI wrapper,
  `qmd`/`obsidian` stand-ins, `curl`), real `esbuild` + dynamic
  import of the compiled artifact, real localhost HTTP servers standing in
  for the LLM provider. These catch wiring bugs (arg-passing, env handling,
  protocol/URL construction) across multiple real components — but the LLM
  *content* they receive is still a hand-written JSON payload known in
  advance to be valid.
- **`e2e/`** uses real DeepSeek and QMD services with synthetic notes in an
  explicitly selected temporary vault. Only `npm run test:e2e:real` enables it.
  An API key in the shell never opts normal tests into this tier.

## Why the e2e tier exists

Every unit and integration test mocks the LLM transport with a payload the
test author already knows is schema-valid. That's structurally incapable of
catching a real model deviating from an under-specified prompt — which is
exactly how the 2026-08-26 Relation-Judge-all-weak bug (see git log:
"Fix Relation Judge silently going all-weak on DeepSeek") slipped through
314 passing mocked tests. The `e2e/` tier exists specifically to catch that
class of bug: it's the only place a prompt or protocol change is checked
against what the real model actually returns.

## Running

```sh
npm test           # unit and integration, from root or obsidian-plugin/
npm run verify     # static checks, unit/integration tests, types and build
```

For real provider tests, prepare a disposable vault below the system temporary
directory with `.obsidian/plugins` and index its synthetic notes in a separate
QMD index. Set `AHA_E2E_VAULT_ROOT`, `AHA_E2E_QMD_INDEX`, and `DEEPSEEK_API_KEY`,
then run `npm run test:e2e:real`. The runner rejects the normal `obsidian` index
and vault paths outside the temporary directory, including symlink escapes.
It never updates an index. The batch test creates a scratch note and a test
plugin directory, refuses existing paths, and removes its own files afterward.
Provider tests make real network calls and can incur charges.

For interactive verification, use `.agents/skills/verify-aha/SKILL.md`.
Its scripts are included in `npm run lint` and `npm run check:scripts`.
