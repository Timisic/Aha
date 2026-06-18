# Insight-to-Judgment Agent PRD v0.1

## Purpose

Build a Pi extension that helps the user turn a captured insight into a clearer, reusable, action-relevant judgment.

The product is not a generic knowledge-management system and not an automatic note summarizer. It is a guided judgment-transformation workflow:

```text
raw insight + context
-> memory retrieval
-> review-grill loop
-> summary draft
-> complete
```

## Product Philosophy

This project should follow Pi's protocol-first philosophy:

- Keep Pi core untouched.
- Put product-specific behavior in an extension.
- Use skills for workflow instructions rather than runtime machinery.
- Use tools for runtime capabilities such as gbrain retrieval and local state updates.
- Treat local JSON state as product-layer session state, not as Pi core memory.
- Avoid building a large framework around the workflow before the first loop works.

The first version should be a small product shell composed from existing Pi mechanisms:

```text
Pi Extension
-> /insight slash command
-> per-session files under global insight storage
-> gbrain CLI calls
-> grill-insight process document
-> summary draft output
```

## Goals

1. Start an insight session from a raw insight and context.
2. Retrieve relevant old notes from the user's local memory.
3. Present 5-8 memory candidates in a compact table.
4. Support a review-grill loop where the user reviews memory and the agent asks questions.
5. Track session state in a local JSON file that can be updated after each state change.
6. Produce a summary draft without directly modifying the original Obsidian note.

## Non-Goals

- Do not modify Pi core.
- Do not build a separate web or visual prototype in v0.1.
- Do not directly edit the user's Obsidian source note by default.
- Do not implement complex memory ranking.
- Do not implement multi-agent orchestration.
- Do not build an MCP server for this workflow in v0.1.
- Do not save every temporary candidate judgment as a durable record.
- Do not depend on the old `grill-tui` extension in v0.1.

## User Inputs

Minimum required input:

- `rawInsight`: the insight the user wants to examine.
- `context`: the surrounding situation, source material, current problem, or original Obsidian note text.

Optional input:

- `sourceNote`: original Obsidian note path and/or content, when available.
- `connectedHistoryNotes`: explicit note titles, keywords, or references written by the user.

The `/insight` command does not need a complex intake UI in v0.1. The user can paste all content into the normal Pi input box, and the agent should extract `rawInsight`, `context`, optional source-note material, and explicit memory cues from that message.

## Workflow Stages

### 1. Memory

The agent generates memory queries from `rawInsight` and `context`, then retrieves old notes from gbrain.

Default retrieval strategy:

- Run semantic retrieval first with `gbrain query`.
- Generate three initial query shapes:
  - close to the raw insight
  - abstracted into the core judgment
  - combined with current context
- If the user supplied connected history notes, also run direct keyword lookup with `gbrain search`.
- Merge and deduplicate results.
- Surface missing explicit cues instead of dropping them silently.
- Run gbrain calls serially, not in parallel, because local PGLite can lock under concurrent queries.
- Accept parseable stdout as usable results even when the gbrain process does not exit cleanly before timeout.

Memory stage exits only after the agent presents:

- a compact memory-candidate table
- any missing explicit cues

### 2. Review-Grill

This is the central loop.

Review is the user's cognitive work: reading, comparing, remembering, judging, and answering.

Grill is the agent's interaction: asking clarifying questions, applying pressure, proposing candidate judgments when the user's wording stabilizes, and recording the thread of reasoning.

Supported user actions:

- confirm a memory candidate as relevant
- reject a memory candidate
- name a new insight
- ask for another memory search
- declare readiness for summary

The agent should not claim to have completed Review. It can only present candidates, relation hypotheses, and questions.

### 3. Summary

Entered only when the user explicitly says the judgment is ready to summarize, such as:

- "可以总结了"
- "进入 summary"
- "complete"

The summary draft should include:

- original insight
- possible old judgment
- new or revised judgment
- judgment shift
- used memory
- boundaries or exceptions
- unresolved questions
- suggested additions or critiques for the source note

The summary draft should be output in chat by default. Saving to a local draft file is supported only when the user asks for it.

### 4. Complete

Terminal state after the summary draft is delivered.

## Memory Candidate Table

The candidate table should show 5-8 rows by default.

Columns:

| Column | Meaning |
| --- | --- |
| Title | Old note title or slug |
| Relation | `supports`, `challenges`, `resembles`, or `bounds` |
| Reason | Why this note may matter |
| Why read first | Why the user should prioritize it |

Do not show raw gbrain score by default. Scores and ranks are search signals, not user judgment.

## Session State

Store session state in global Pi insight storage, not under the current working directory by default. The extension should update the state JSON whenever a meaningful state transition occurs.

Suggested path:

```text
$PI_CODING_AGENT_DIR/insights/sessions/{yyyy-mm-dd}-{short-slug}-{sessionId}/state.json
```

If `PI_CODING_AGENT_DIR` is not set, the default is:

```text
~/.pi/agent/insights/sessions/{yyyy-mm-dd}-{short-slug}-{sessionId}/state.json
```

`INSIGHT_HOME` may override the insight storage root for tests or future configuration.

Each insight session must have its own directory so sessions from different days or different insights do not collide.

Suggested per-session files:

```text
~/.pi/agent/insights/
  index.json
  sessions/
    2026-06-06-feedback-loop-a1b2c3/
      state.json
      grill-context.md
      summary-draft.md
```

File rules:

- Generate a stable session id for every new `/insight` run.
- Include date and a short slug in the directory name for human browsing.
- Never reuse a directory for a different insight.
- Maintain `index.json` so recent sessions can be listed and resumed across Pi sessions started from different paths.
- Record `originCwd` in `state.json` so the user can see where the session was started.
- Keep active state in `state.json`.
- Let `grill-insight` write or preserve its own process context document, represented here as `grill-context.md`.
- Save summary drafts under the same session directory when the user asks to save them.

Suggested v0.1 shape:

```ts
type InsightSession = {
  id: string
  stage: "memory" | "review_grill" | "summary" | "complete"
  originCwd: string

  rawInsight: string
  context: string
  sourceNote?: {
    path?: string
    content: string
  }

  memoryQueries: Array<{
    text: string
    kind: "raw" | "abstracted_judgment" | "contextual" | "explicit_cue"
    command: "gbrain query" | "gbrain search"
  }>

  explicitMemoryCues: string[]
  missingExplicitCues: string[]

  memoryCandidates: Array<{
    id: string
    title: string
    slug?: string
    relation: "supports" | "challenges" | "resembles" | "bounds"
    reason: string
    whyReadFirst: string
    searchSignals?: {
      queryText?: string
      rank?: number
    }
  }>

  usedMemoryIds: string[]

  newInsights: Array<{
    text: string
    openedDirection: boolean
    triggeredMemorySearch: boolean
  }>

  grillTurns: Array<{
    question: string
    answer?: string
    resultingInsight?: string
    createdAt: string
  }>

  candidateJudgments: Array<{
    text: string
    userStatus: "pending" | "accepted" | "rejected" | "revised"
  }>

  summaryDraft?: string
  unresolvedQuestions: string[]

  createdAt: string
  updatedAt: string
}
```

## Pi Extension Design

v0.1 should use extension-level composition:

- register `/insight` to start or resume the workflow
- register a tool for memory retrieval
- register a tool for updating local session state
- optionally inject workflow instructions before agent start when the workflow mode is active
- reuse `grill-insight` as the process artifact for the review-grill loop
- ignore or disable the old `grill-tui` extension path for this workflow
- use Pi's existing TUI primitives, command handling, normal input box, notifications, and optional editor/input dialogs instead of a separate visual prototype

Prototype tools:

- `insight_search_memory`: serialized gbrain retrieval, candidate merge/dedupe, state update, candidate table return.
- `insight_update_state`: stage, used memory, new insight, grill turn, candidate judgment, note, and summary-field updates for the active session.
- `insight_append_grill_context`: append stable language or process notes to `grill-context.md`.
- `insight_save_summary`: write `summary-draft.md`, update `state.json`, and optionally mark the session complete.

The extension should prefer product-layer hooks and tools over core changes.

## Interaction Surface

The v0.1 surface is Pi TUI, not a web prototype.

Primary interaction:

```text
/insight
<user pastes raw insight + context + optional source note>
```

The agent extracts the session inputs from the pasted message, creates an isolated global insight session directory, writes `state.json`, retrieves memory, and returns a memory-candidate table in the conversation.

Optional TUI affordances may be added later:

- an input/editor dialog for raw insight and context
- a status indicator showing the active insight session

These are helpful but not required for the first working loop.

Supported commands:

- `/insight` opens an editor for a new session.
- `/insight <pasted content>` starts a new session from inline content.
- `/insight list` shows recent sessions.
- `/insight resume <session-id-or-directory-fragment>` resumes a prior session.
- `/insight current` shows the active session.

Prompt pattern for pasted input:

```text
Insight: ...

Context: ...

Source Note: ...

Connected History Notes:
- ...
```

`grill-context.md` is created by the extension at session creation and can be appended during the Review-Grill loop.

## Acceptance Criteria

1. User can start a session with raw insight and context.
2. Session state is written to local JSON.
3. Memory retrieval runs through gbrain.
4. The agent presents a 5-8 row memory candidate table.
5. Explicit memory cues that cannot be found are surfaced.
6. User can ask for another memory search during review-grill.
7. User can explicitly enter summary.
8. Summary draft includes judgment shift and used memory.
9. Original Obsidian note is not modified by default.
10. Multiple `/insight` sessions create isolated directories under global insight storage.
11. `/insight list` and `/insight resume` work across different cwd launch paths.
