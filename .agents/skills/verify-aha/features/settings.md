# Configure Aha

Common controls stay visible. Connection defaults, search limits, advanced fields,
and diagnostics use native disclosures. Current index progress and failure recovery
remain visible while diagnostics are collapsed.

## Live recipe

Launch the owned baseline instance through `verify.mjs launch`, then run
`node .agents/skills/verify-aha/scripts/settings-proof.mjs <evidence-directory>`.
Use `cleanup` afterward. The proof opens Settings with the real shortcut and selects
Aha Dev. It checks four collapsed sections, visible common controls, persisted
connection and advanced edits, keyboard disclosure toggling, discoverable health
failures, and no horizontal overflow at a narrow width.

`settings-compact`, `settings-advanced`, `settings-health`, and `settings-narrow`
retain screenshots and control observations. `settings-report.json` lists actual
coverage. The separate `run-index` proof exercises automation and manual retry with
the existing embedding service through `[aria-label="Embed now"]`.

## Boundaries

- Health checks can probe configured services when Settings opens.
- API keys entered directly are stored in plugin settings. Fixtures use no key.
- Exclusion folders filter candidates, not QMD indexing or remote transmission.
- The proof inspects accessible copy controls without replacing the user clipboard.
- Close Settings using its native Escape key. Closing only its CDP target can leave
  the native window and shortcut scope active.
