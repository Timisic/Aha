# Aha Configuration Reference

Precedence is environment variable first, then the default shown below. Path-list values use the platform path delimiter (`:` on macOS/Linux).

| Variable | Default | Mode | Purpose |
| --- | --- | --- | --- |
| `INSIGHT_HOME` | `$PI_CODING_AGENT_DIR/insights` or `~/.pi/agent/insights` | local | Session index, state, grill context, stage briefing, and summary draft storage. |
| `PI_CODING_AGENT_DIR` | `~/.pi/agent` | local | Pi agent home used when `INSIGHT_HOME` is not set. |
| `QMD_BIN` | `qmd` | local | QMD executable. |
| `INSIGHT_QMD_INDEX` | `obsidian` | local | QMD index name. |
| `INSIGHT_QMD_COLLECTION` | `obsidian` | local | QMD collection name. |
| `OBSIDIAN_BIN` | `obsidian` | local | Obsidian CLI executable for safe reads/backlinks. |
| `INSIGHT_SOURCE_ROOTS` | `~/Obsidian Notes:<cwd>` | local | Allowed roots for source-note file fallback. |
| `INSIGHT_MEMORY_RERANKER` | `agent` | local/external/off | `agent` uses a local CLI agent; `off`/`none` preserves QMD order for offline demos. |
| `INSIGHT_MEMORY_RERANK_AGENT_BIN` | `codex` | external/local | Agent reranker executable when reranker mode is `agent`. |
| `INSIGHT_MEMORY_RERANK_AGENT_MODEL` | empty | external/local | Optional model override passed to the reranker agent. |
| `INSIGHT_MEMORY_RERANK_TIMEOUT_MS` | `300000` | external/local | Reranker deadline. |
| `INSIGHT_QMD_TIMEOUT_MS` | `90000` | local | Per-QMD-call deadline. |
| `INSIGHT_OBSIDIAN_TIMEOUT_MS` | `8000` | local | Per-Obsidian-command deadline. |
| `INSIGHT_COMMAND_OUTPUT_MAX_BYTES` | `1000000` | local | Max provider output before truncation/termination. |
| `QMD_REMOTE_EMBED_URL` | `http://127.0.0.1:18081/v1/embeddings` | local endpoint | QMD embedding endpoint. |
| `QMD_REMOTE_GENERATE_URL` | `http://127.0.0.1:18082/completion` | local endpoint | QMD query-generation endpoint. |
| `QMD_REMOTE_RERANK_URL` | `http://127.0.0.1:18083/v1/rerank` | local endpoint | QMD rerank endpoint. |
| `PI_TYPEBOX_PATH` | unset | advanced | Escape hatch for non-standard TypeBox installs. Normal path is package import. |
| `PI_TUI_PATH` | unset | advanced | Escape hatch for non-standard Pi TUI installs. Normal path is package import. |

## Data boundaries

Aha keeps the product boundary human-authored and agent-retrieved. It reads configured local sources only when you provide an insight/source-note flow that needs them. It writes session-local artifacts under `INSIGHT_HOME`; it does not publish summary drafts into Obsidian or mutate source notes.

Delete all local Aha session artifacts with:

```bash
rm -rf "${INSIGHT_HOME:-${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/insights}"
```

Archive before deleting with:

```bash
tar -czf aha-insights-archive.tgz "${INSIGHT_HOME:-${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/insights}"
```
