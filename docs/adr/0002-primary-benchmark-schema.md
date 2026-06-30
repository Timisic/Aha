# Keep the primary benchmark real and explicit

The primary Aha benchmark should measure whether the Memory Stage surfaces useful old notes for real user insight inputs, so its private case file should contain only real or draft insight cases, not engineering regression fixtures. Source-note cases should normally point to an explicit line range; whole-note inputs are allowed only when the case explicitly says the whole note is the intended input.

## Considered Options

- Keep AI-written `insight_input` prompts in the main benchmark. Rejected because they drift away from how the user actually invokes `/insight`.
- Keep technical edge cases such as duplicate basenames, qmd URI handling, missing cues, and source-note self-hit behavior in the primary suite. Rejected because they protect implementation behavior rather than product-quality recall for real insights.
- Treat a missing line range as permission to read the whole note. Rejected because that can silently expose unrelated note context to query generation and reranking.

## Consequences

- The primary benchmark schema should group fields into `input` and `gold`, with `input.note`, `input.lines`, `input.thought`, and `gold.must` / `gold.nice` / `gold.noise`.
- `input.thought` is the single free-text input field: it supplements a source-note excerpt, or becomes the whole standalone insight when no source note exists.
- `description` and `annotation_note` should be replaced by human-facing `title` and `why`; neither affects retrieval, reranking, or scoring.
- Main case lifecycle should stay small: `active`, `draft`, and `off`.
- Relation-judge evaluation and engineering regression fixtures should live outside the primary benchmark suite.
- A whole source note can be benchmark input, but the case must make that explicit, for example with `input.whole_note: true`.
