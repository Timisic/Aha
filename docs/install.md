# Install Aha

Aha is shipped as an installable Pi package from this repository. The supported public path is a Git checkout or Git dependency; npm publication can be added later without changing the package contract.

## Supported envelope

| Surface | Supported range | Required | Notes |
| --- | --- | --- | --- |
| OS | macOS or Linux | yes | Windows is unsupported except through a supported container/VM. |
| Node.js | `>=22.19.0 <26` | yes | Matches current Pi package requirements. |
| Bun | `>=1.2.0 <2` | build only | Used by `npm run build`. |
| Pi | `@earendil-works/pi-coding-agent >=0.79.0 <0.80.0` | yes | Aha validates API shape and reports host version when available. |
| Pi TUI | `@earendil-works/pi-tui >=0.79.0 <0.80.0` | yes | Resolved through normal package imports. |
| TypeBox | `typebox >=1.1.0 <2` | yes | Resolved through normal package imports. |
| QMD | `>=0.1.0` | yes for retrieval | Set `QMD_BIN` if it is not on `PATH`. |
| Obsidian CLI | `>=0.1.0` | optional | Needed for source-note reads and backlink expansion. |

## Clean checkout setup

```bash
git clone git@github.com:Timisic/Aha.git
cd Aha/insight-package
npm ci
npm run typecheck
npm run test:doctor
npm run build
```

## Load in Pi

From the repository root:

```bash
pi install ./insight-package
```

One-off smoke load without changing settings:

```bash
pi --verbose --offline --no-tools --no-extensions -e ./insight-package --print ""
```

Then open Pi and run:

```text
/insight doctor
```

## Update, rollback, uninstall

```bash
git pull --ff-only
cd insight-package
npm ci
npm run verify
pi install .
```

Rollback by checking out the previous Git revision and reinstalling the package. Uninstall by removing this package from Pi settings. If a legacy single-file `insight.ts` extension exists, keep it disabled or renamed with a non-`.ts` suffix so `/insight` is registered once.
