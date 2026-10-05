---
name: verify-aha
description: Verify the Aha Obsidian desktop plugin through an isolated macOS app, real command-palette and panel actions, screenshots, and persisted files. Use after changing Aha user behavior or when collecting acceptance evidence. Includes a feature map and executable Neighborhood, Surprise, and QMD quick-link proofs.
---

# Verify Aha

Read [the feature map](features/README.md) and the page for the behavior under test. The primary user interface is Obsidian. Node tests and batch tools are secondary checks.

## Launch

Run from the repository root on macOS. Require Node 22 or newer with global `WebSocket`, npm, and `/Applications/Obsidian.app/Contents/MacOS/Obsidian`.

Install missing dependencies using the lockfiles, then check the base.

```sh
npm ci
npm --prefix obsidian-plugin ci
npm run verify
```

Use the baseline acceptance run by default. It does not cover every feature.

```sh
node .agents/skills/verify-aha/scripts/verify.mjs run
```

The helper prints an absolute evidence directory under `traces/verification/`. It builds through `npm run dev:install` with an explicit temporary `AHA_DEV_VAULT_ROOT`. It creates three synthetic notes, an empty Session Store, and an isolated Electron profile. It starts Obsidian directly with `--user-data-dir` and an ephemeral loopback CDP port. It accepts the trust dialog only inside that owned vault.

The fixture sets QMD to an unavailable absolute executable and leaves credentials empty. `Run` uses the real Neighborhood fallback after the QMD availability probe. No successful search round is injected. Obsidian itself may check for updates, as recorded in `obsidian.log`. This is not a claim that the whole desktop process makes no network requests.

For inspection between steps, choose a new evidence directory and retain the printed path.

```sh
node .agents/skills/verify-aha/scripts/verify.mjs launch /tmp/aha-proof-inspect
node .agents/skills/verify-aha/scripts/verify.mjs doctor /tmp/aha-proof-inspect
node .agents/skills/verify-aha/scripts/verify.mjs drive /tmp/aha-proof-inspect
node .agents/skills/verify-aha/scripts/verify.mjs cleanup /tmp/aha-proof-inspect
```

`launch` refuses an existing evidence directory. Ready means the owned renderer has the expected vault, the expected build, and all five Aha commands. A listening debug port alone is insufficient. `drive` requires a fresh Session Store and runs the same scenario as `run`.

Each launch has its own profile, vault, process, and port. Run UI drives serially because macOS focus and the clipboard remain shared. Enable only the Dev plugin in the temporary vault. The Dev and production plugins share `aha-review-panel` despite separate plugin IDs. The normal `obsidian` CLI targets the existing application and is not this helper's driver.

## Doctor

Run the read-only `doctor` command above whenever the instance looks wrong. It checks the PID start identity, scratch ownership, vault path, plugin version, copied bundle hash, current checkout bundle hash, enabled plugin ID, command registration, and QMD fixture configuration. It writes observations to `doctor.json` without changing app state.

Aha's `Check Readiness` command tests QMD and the configured DeepSeek connection. It is not a read-only substitute for this doctor. If the checkout build changes, clean up and launch again.

## Drive

The helper uses Node's built-in WebSocket for CDP. `click` locates a unique visible DOM element and sends mouse input. `fill` sends text input. `command` opens the real command palette with Cmd+P and chooses the displayed command. Runtime evaluation observes state and locates controls. It does not assign plugin state or call internal search functions.

The default scenario performs these actions.

1. Open `Source.md` from the file explorer and choose `Aha (Dev): Run`.
2. Require `Backlink.md` and `Counterexample.md` as the two weak Neighborhood candidates. Require source exclusion and unchanged source text.
3. Toggle the Counterexample selection and read the persisted value.
4. Click Surprise on Backlink, type a thought, and click `保存`.
5. Require the thought in both `data.json` and the source Markdown. Require one thought block and unchanged candidate files.
6. Open saved Surprise, exercise empty and matching searches, reload the app, and reopen the panel.
7. Require restored selection, Surprise marking, and the saved thought.
8. Edit the saved thought with Cmd+Enter and require exact replacement in Markdown and a saved journal.
9. Open a candidate while pinned, return through the source link, then unpin and require the panel to follow another note.
10. Return to Source and rerun from the panel button. Require a new successful round and unchanged note text.

The feature pages list additional entry points and checks. Extend the existing `drive` scenario for those paths, using its `click`, `fill`, `command`, `snapshot`, and `key` helpers. Keep ownership checks and cleanup intact. Run each new scenario against fresh state. A default passing run does not verify every mapped path.

## Evidence

Keep `actions.jsonl`, checkpoint PNGs and text, copied plugin data, copied source Markdown, `doctor.json`, `build.log`, `obsidian.log`, pipeline traces, `report.json`, and `cleanup.json` in the printed evidence directory. `run.json` records process identity, temporary paths, version, commit, and bundle hash. These local artifacts are ignored by Git through `traces/`.

Pair the initiating action with the resulting UI and stored files. Read the actual files after a mutation. Verify persistence after reload. Do not count unit tests, a final screenshot, seeded results, internal setters, or a mocked Obsidian host as desktop proof. Use mocks only at an existing production boundary and label the reduced claim.

The default fixture proves deterministic Neighborhood behavior and persistence. QMD recall, DeepSeek judgment, and the value of a Surprise connection require separate evidence. Use only authorized notes and services for such checks. A script named dry-run is not proof of no writes or networking. Inspect its implementation and compare observed files, requests, and Git refs before making that claim.

## Cleanup

`run` cleans up in `finally`. Failed launches also clean up. After an interrupted or manual drive, run `cleanup` with its evidence directory. Cleanup verifies the owner marker and PID start identity, signals only that PID, waits for exit, and removes only its scratch directory. A mismatched PID causes refusal. Never kill Obsidian by process name or delete an unverified directory.

Evidence is outside scratch and survives cleanup. Require `cleanup.json`, `report.json`, and the last checkpoint PNG after a successful run. The report must say `passed`. A failed attempt can retain diagnostic evidence without a passing report. Cleanup is repeatable. `host-before.json` and `host-after.json` record the main
CLI socket identity, its read-only version response, home, and default keychain.
Cleanup requires these observations to match. An absent main socket is recorded
as absent; it is not permission to launch the main application.

Exercise failure cleanup with a fresh evidence directory:

```sh
AHA_VERIFY_FAIL_AFTER_LAUNCH=1 node .agents/skills/verify-aha/scripts/verify.mjs run
```

This probe must exit nonzero with `Intentional isolation cleanup probe`. Require
`cleanup.json` with `hostUnchanged: true`, an absent scratch directory, and the
retained launch screenshot. Run `cleanup` again to check repeatability.

## Helpers

The executable [scripts/verify.mjs](scripts/verify.mjs) provides `run`, `launch`, `doctor`, `drive`, and `cleanup`. No global skill installation or additional browser package is required. Use `pstack-personal:maintain-verification-skill` when commands, controls, or persistence behavior change.

## Quick link insertion

Use `run-links` for the real QMD quick-link path. It creates a separate QMD configuration and cache inside scratch, indexes synthetic Chinese notes, and embeds them through an existing configured endpoint. It never updates the main index. Provide the embedding service through `QMD_REMOTE_EMBED_URL` and the excerpt reranker through `QMD_REMOTE_RERANK_URL` and its existing model or authentication environment variables. Credentials stay in process environment and are not copied into evidence.

```sh
node .agents/skills/verify-aha/scripts/verify.mjs run-links
```

Use `launch-links` instead to hold the instance, then run `doctor`, `drive`, and `cleanup` with its evidence path. The [quick-link proof module](scripts/quick-links-proof.mjs) runs through this entrypoint. It requires a real endpoint and does not download a local model. `AHA_VERIFY_QMD_COMMAND` optionally selects the installed QMD executable.

The proof also asks two different questions about the same noisy note and requires two different, exact original sentences. It records this synthetic quality check separately from unverified production-vault relevance.

The fixture assigns Mod+Shift+L only inside its temporary vault. It records QMD arguments and actual results through a forwarding executable. This records real calls rather than replacing the retrieval boundary. Input text and results are synthetic. Read [quick link insertion](features/quick-links.md) for coverage and additional states. The stock `run` keeps the existing Neighborhood and Surprise proof.

## Automatic index maintenance

Run the real index-maintenance scenario with the same existing embedding environment required by `run-links`.

```sh
node .agents/skills/verify-aha/scripts/verify.mjs run-index
```

The [index proof module](scripts/index-proof.mjs) enables the setting through the actual Settings window. It proves nine additions do not run a job, the tenth starts update then embed, concurrent additions remain pending, and the new content becomes searchable. It also exercises rename, edit, delete, reload, a genuinely unavailable executable, manual retry, and disabling automatic work. Read [index maintenance](features/index-maintenance.md) before extending it.

Each temporary Obsidian process has an isolated home as well as a profile and vault. Obsidian's CLI socket lives in the home directory even with `--user-data-dir`; profile isolation alone can disrupt the user's existing CLI connection. The helper checks the child home in Doctor and never changes the parent shell's home. Settings use a separate owned CDP target. Secrets remain in the child environment, not its saved test settings.

On macOS the synthetic instance must include `--use-mock-keychain`. A temporary home without that flag can trigger repeated missing-keychain dialogs. Doctor checks the flag. Never apply this test-only flag to the user's main vault, store real credentials in the fixture, or reset the user's login keychain to repair a test launch.

## Settings and latency

After `launch`, run `node .agents/skills/verify-aha/scripts/settings-proof.mjs <evidence-directory>`.
It opens the real Settings window, checks collapsed defaults, keyboard disclosures,
persisted edits, visible failures, and narrow-window overflow. Then run `cleanup`.

After `launch-links`, run `node .agents/skills/verify-aha/scripts/benchmark-links.mjs <evidence-directory> <label> 10`.
It measures command activation to first selectable candidates and to completed
original excerpts separately. It checks actual QMD completion and semantic source
sentences. Polling does not determine the recorded timestamps. The normal quality
proof still uses the configured hotkey. Timing uses command-palette activation.

For an authorized personal-index benchmark, set `AHA_VERIFY_SOURCE_VAULT_ROOT`
explicitly and run `launch-production-links`. The helper copies Markdown into
scratch, permits only QMD quick-link queries, and maps absolute result paths to
the copies. It does not run index updates or mutate original notes. Evidence can
contain private note titles and excerpts; keep it local. Use the same configured
QMD endpoints and the default `obsidian` index. Pass a previous benchmark JSON as
the fourth benchmark argument to assert identical candidate order and excerpts.

`AHA_VERIFY_BUNDLE_DIR` selects an archived `main.js` and `styles.css` only for
isolated comparisons. Doctor checks the installed hash against that pinned bundle.
Alternate fresh before/after instances, at least five runs per side. Keep source
commits, hashes, sample ranges, failures, and both latency milestones in the local
report. Complete excerpts may still take longer than two seconds; first selectable
candidates are a separate claim. Every manual launch requires final `cleanup`.
