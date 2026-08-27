# Test layout

Three tiers, matching a standard test pyramid:

- **`unit/`** (27 files) — pure logic, no real subprocess, no real network. Fast,
  deterministic. Many of these rebuild `obsidian-plugin/dist/core.mjs` via a
  real `esbuild` compile step (core is TypeScript), but that's an
  implementation detail of testing compiled TS as `.mjs` — the tests
  themselves exercise one module's logic in isolation with injected fakes.
- **`integration/`** (9 files) — real subprocess spawns (the CLI wrapper,
  `qmd`/`obsidian` stand-ins, `curl`), real `esbuild` + dynamic
  import of the compiled artifact, real localhost HTTP servers standing in
  for the LLM provider. These catch wiring bugs (arg-passing, env handling,
  protocol/URL construction) across multiple real components — but the LLM
  *content* they receive is still a hand-written JSON payload known in
  advance to be valid.
- **`e2e/`** (1 file) — real network calls to the real DeepSeek API. Asserts
  on structural properties (schema validity, enum membership), never exact
  content, since model output isn't deterministic. Auto-runs whenever
  `DEEPSEEK_API_KEY` is present in the environment; skips with a clear
  message otherwise, so a normal test run never silently costs money or
  flakes on network access when the key is absent.

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

```bash
npm test                                     # everything (root or obsidian-plugin/)
node --test scripts/aha/tests/**/*.test.mjs  # equivalent, from repo root
node --test scripts/aha/tests/unit/*.test.mjs        # one tier only
```

Note: `node --test <directory>` (with no glob) does not auto-discover
`*.test.mjs` files in this Node version — always pass an explicit glob.
