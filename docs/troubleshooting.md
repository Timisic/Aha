# Aha Troubleshooting

Start with:

```text
/insight doctor
```

For machine-readable output:

```text
/insight doctor --json
```

## Common failures

| Message | Meaning | Fix |
| --- | --- | --- |
| `qmd is unavailable or failed to report a version` | `QMD_BIN` is not installed or not executable. | Install QMD or export `QMD_BIN=/path/to/qmd`. |
| `Synthetic QMD query failed` | The configured index/collection or local QMD endpoints are unavailable. | Set `INSIGHT_QMD_INDEX`, `INSIGHT_QMD_COLLECTION`, and check QMD endpoint processes. |
| `Insight home is not writable` | Aha cannot create session artifacts. | `export INSIGHT_HOME="$PWD/.aha-insights"` or choose another writable directory. |
| `Aha extension appears to be loaded ... times` | Both package and legacy single-file extension are active. | Disable one extension; keep old backups with a non-`.ts` suffix. |
| `Pi host ... is outside ...` | Pi package/API version is unsupported. | Install a Pi version satisfying `>=0.79.0 <0.80.0`. |
| `Agent reranker ... is unavailable` | Optional reranker CLI is missing. | For offline mode, `export INSIGHT_MEMORY_RERANKER=off`. |
| `configured source root(s) do not exist` | Source-note fallback roots are not present. | Set `INSIGHT_SOURCE_ROOTS` to existing vault/demo directories. |

Doctor does not enumerate or print real note contents. Its content-touching check is one synthetic QMD query used only to verify the configured index/collection path.
