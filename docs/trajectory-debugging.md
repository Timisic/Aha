# L2 trajectory debugging

The `/insight` trajectory recorder is an opt-in developer debug side channel. It is disabled by default and writes only under the active runtime session directory.

Enable it for a local Pi run:

```sh
INSIGHT_TRAJECTORY=1 pi
```

For a session created under `~/.pi/agent/insights/sessions/<session>/`, trajectory files live in:

```text
~/.pi/agent/insights/sessions/<session>/trajectory/
  events.jsonl
  contexts/
  memory/
  tool-calls/
  tool-results/
```

`events.jsonl` is the main inspection path. Each line is a JSON event with the session id, current workflow stage, event name, timestamp, and bounded debug data. Larger payloads are referenced as artifacts under the sibling directories.

Useful events:

- `session_started` and `session_restored`: session lifecycle.
- `context_seen` and `context_built`: hidden Aha context injection, compact mode, insertion point, message counts, and context hash.
- `tool_call_requested` and `tool_call_blocked`: stage-policy decisions for model tool attempts.
- `tool_started` and `tool_finished`: registered Aha tool execution, duration, status, and result artifact.
- `memory_query_started` and `qmd_call_finished`: generated QMD query shape, command kind, exit status, parsed candidate count, and connectivity issues.
- `backlink_expansion_finished`, `memory_candidates_merged`, `rerank_finished`, and `state_saved`: the retrieval pipeline after QMD.

The recorder does not write to `state.json`, `grill-context.md`, or Pi's global session JSONL. It is meant for L2 trajectory debugging only, not verifier or ablation workflows.
