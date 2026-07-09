# Insight-to-Judgment Agent

This context names the cognitive workflow around turning a captured idea into a user-confirmed judgment. Its language should distinguish judgment formation from generic knowledge management, note summarization, or content collection.

## Language

Sections:

- Insight & Judgment Workflow
- Source Material
- Memory Retrieval
- Relation Judging
- Review & Selection
- Aha Session Records & Exports
- Grilling & Judgment Formation
- Benchmark & Evaluation
- Pipeline Trace & Diagnosis

### Insight & Judgment Workflow

**Insight**:
A short-lived idea, perception, or framing shift captured from reading, media, conversation, AI work, project work, or reflection. In this workflow, an insight is something the user has actively brought to the agent because it seems likely to update an older understanding.
_Avoid_: note, clipping, material, saved item

**Judgment**:
A user-confirmed stance about what is true, important, reusable, or action-relevant after an insight has been compared with prior memory and challenged. A judgment is stronger than a summary because it can change future decisions.
_Avoid_: conclusion, summary, takeaway

**Judgment Transformation**:
The process of turning an insight into a clearer, more stable, reusable judgment through memory retrieval, review, grilling, and synthesis.
_Avoid_: knowledge management, note summarization, collection

**Context**:
The current situation, problem, project, source material, or question that makes an insight meaningful.
_Avoid_: prompt, background text

**Insight Session**:
One run of the workflow around a raw insight and its context. The minimum required input is the raw insight plus context; a source note is common and has a special role in summary, but still belongs inside context.
_Avoid_: chat, task, isolated query

**Workflow Stage**:
The coarse state that controls what the agent should do next inside an insight session. The necessary stages are memory, review_grill, summary, and complete; complete is the terminal state.
_Avoid_: prompt reminder, detailed UI step

**Intake**:
The session creation condition where the user provides a raw insight and context. Intake is not a required active stage when those inputs are already present.
_Avoid_: context stage, onboarding

**Memory Stage**:
The workflow stage where the agent generates memory queries, retrieves prior memory, merges candidates, and presents them for user review. It is ready to hand off when a compact candidate table and any missing explicit cues have been shown.
_Avoid_: review stage, summary stage

**Review-Grill Stage**:
The workflow stage for the Review-Grill Loop. It combines user-side review with agent-side questioning because those activities are interleaved in real use.
_Avoid_: separate review stage, separate grill stage

**Summary Stage**:
The workflow stage entered only after the user explicitly indicates that the current judgment is ready to synthesize.
_Avoid_: automatic wrap-up, article writing

**Summary Readiness**:
A state where the conversation appears ready for synthesis but still requires the user to explicitly enter summary. The agent may point out summary readiness but should not switch stages by itself.
_Avoid_: automatic complete, silent transition

**Complete**:
A user-declared state that the current judgment transformation is sufficiently resolved for synthesis. The agent can propose readiness, but the user decides when the loop is complete.
_Avoid_: done by agent, automatic stop

### Source Material

**Source Note**:
The original Obsidian note or note excerpt the user provides as part of context for an insight session. It is optional, but when present it anchors the final summary draft and should not be edited directly by default.
_Avoid_: source of truth, output document

**Source Note Identity**:
The stable identity used by the Memory Surface to recognize the same source note across rename or move operations. It should prefer file identity when available and use the vault path only as a fallback locator.
_Avoid_: path string, note title, review note filename

**Source Note Snapshot**:
The captured content shape of a source note at intake, used to preserve summary structure and warn about drift without rewriting the original note.
_Avoid_: editable source, final document

**Stale Session Record**:
An Aha Session Record whose source note appears to have changed since the search round that produced its current Panel State. Staleness is a lightweight warning and rerun cue; it should not hide prior results, trigger automatic search, or treat the record as invalid.
_Avoid_: error state, automatic refresh, invalid history

**Insight Input**:
The actual material the user gives `/insight` at session start. It is usually a source note alone, or a source note plus one fresh user thought; it is not usually a short search query, remembered title, or isolated keyword.
_Avoid_: search query, keyword prompt, remembered title

### Memory Retrieval

**Memory**:
Prior notes, reviews, knowledge-base entries, judgments, projects, scenes, or artifacts that the user has written or confirmed before. Memory is local past material, not generic web search or temporary model association.
_Avoid_: database, archive, web search, model association

**Memory Query**:
A search request generated from the raw insight and context to retrieve prior memory. The first pass should favor semantic relevance; structural similarity can be explored later when the review needs it.
_Avoid_: final interpretation, prompt

**Structured Memory Query**:
A memory query that combines an explicit retrieval intent, short lexical anchors, semantic paraphrases, and a hypothetical shape of the old memory that would satisfy the search. It should preserve the user's insight input while making the retrieval target precise.
_Avoid_: raw prompt passthrough, keyword-only query, generic semantic search

**Retrieval Orchestration**:
The agent-owned step that generates structured memory queries, calls the retrieval backend, expands graph neighbors, reads candidate note text, and prepares candidates for relation judging. It belongs to the Reasoning Workflow, while a wrapper script may only launch, constrain, and capture it.
_Avoid_: plugin-side retrieval logic, fixed keyword extraction, raw search passthrough

**Memory Surface**:
The user-facing place where a source note can trigger memory retrieval, display memory candidates with relation reasons, open old notes or quoted spans, collect review choices, launch additional search rounds, and save reviewed candidates for future evaluation. It is an operating surface, not the reasoning workflow itself.
_Avoid_: agent brain, retrieval backend, automatic judge

**Reasoning Workflow**:
The agent-guided process that turns retrieved memory candidates into evidence-bound relations, review actions, grilling, and eventual judgment synthesis. It owns interpretation and pressure, while the Memory Surface owns display, selection, and handoff.
_Avoid_: plugin UI, note browser, search result page

**Memory Search Round**:
One explicit retrieval pass triggered by the user from the current insight, source note, or a newly opened direction. Search rounds remain visible as provenance; the Aha Panel defaults to the latest successful round while keeping older and failed rounds available as history.
_Avoid_: automatic background crawl, passive refresh

**Search Round History**:
The ordered history of memory search rounds for one Aha Session Record, including successful, running, and failed rounds. A failed latest round should not erase the latest successful review surface.
_Avoid_: append-only audit log, overwritten result, hidden failure

**Rerun Merge**:
The rule for applying a new memory search round to an existing Aha Session Record. When the same memory candidate reappears, user-owned choices and feedback carry forward, while model-owned relation text, hit, why, and quotes may refresh from the latest run.
_Avoid_: clearing user feedback, freezing old model output, forcing old candidates into the latest view

**Memory Candidate**:
A retrieved old note presented for the user's review. Memory candidates may be merged from multiple searches, deduplicated, and shown in a compact table with title, relation, reason, and why to read it first, not as a completed interpretation.
_Avoid_: reviewed note, final evidence, exhaustive result

**Memory Candidate Pool**:
The bounded pool of retrieved candidates accumulated across memory search rounds for deduplication, selection, and handoff export. It may be maintained behind the panel, but the main review surface should stay anchored to the latest successful round unless the user opens history.
_Avoid_: visible table, final evidence

**Explicit Memory Cue**:
A user-provided title, keyword, or note reference that should be searched for directly because the user has already marked it as historically relevant.
_Avoid_: inferred related note, semantic guess

**Missing Explicit Cue**:
An explicit memory cue that the system attempted to retrieve but could not find. It should be surfaced to the user rather than silently dropped.
_Avoid_: irrelevant cue, failed judgment

**Explicit Cue Result**:
The retrieval status of a user-provided memory cue: found in displayed candidates, found only in the pool, not found, or ambiguous.
_Avoid_: missing cue only, search score

**Connected History Notes**:
Old notes named or requested by the user as especially relevant history for the current insight. They are explicit retrieval cues inside the context, not automatically accepted evidence.
_Avoid_: backlinks, automatic related notes

**Search Signal**:
A retrieval clue such as rank, score, or query source that helps the agent organize candidates. Search signals are not part of the user's judgment and should not be presented as evidence by default.
_Avoid_: evidence, confidence, priority

### Relation Judging

**Relation Judge**:
The evidence-bound step that compares one current insight with one candidate old note and proposes a Memory Relation, quoted source evidence, and a short reason. It runs after retrieval and before final candidate presentation or ranking.
_Avoid_: reranker, search score, final judgment

**Memory Relation**:
A tentative label the agent uses to present how an old note may relate to the current insight before the user completes Review. The core relation labels are supports, challenges, resembles, bounds, and weak.
_Avoid_: completed review, relevance score, background

**Relation Quote**:
One to three short source-text spans from the candidate old note used to anchor a Relation Judge output. Strong relations require at least one quote; summaries may explain the quote but cannot replace it.
_Avoid_: generated summary, retrieval snippet, invented evidence

**Relation Evaluation Target**:
An optional benchmark label for a specific insight-memory pair when the case is meant to test Relation Judge quality. It should not be required for every benchmark case because ordinary recall cases primarily evaluate candidate concentration, ranking, and noise control.
_Avoid_: required case field, retrieval gold label, user review shortcut

**Supports**:
A memory relation where an old note strengthens, confirms, or gives evidence for the current insight.
_Avoid_: same as, proof

**Challenges**:
A memory relation where an old note conflicts with, complicates, or puts pressure on the current insight. A challenging memory is valuable because it may force the current insight to gain a boundary, exception, or revision.
_Avoid_: unrelated, wrong

**Resembles**:
A memory relation where an old note has a similar structure or pattern even if it comes from another domain.
_Avoid_: duplicate, same topic

**Bounds**:
A memory relation where an old note helps define where the current insight applies, stops applying, or needs qualification.
_Avoid_: background, limitation only

**Weak**:
A memory relation where the old note may be related, but the quoted evidence is not strong enough to call it supports, challenges, resembles, or bounds. Weak candidates should remain visible in the main review list with muted treatment, default out of handoff selection, and not be treated as judgment evidence until the user reviews them.
_Avoid_: irrelevant, needs_human, forced classification

### Review & Selection

**Review**:
The user's own cognitive work while checking whether memory is truly related, thinking through relationships between old notes and a new insight, or reflecting during an agent exchange. Review can include reading, comparing, remembering, judging, and answering; it can happen before, during, and after grilling rather than as a strictly separate stage.
_Avoid_: passive reading, agent analysis

**Review-Grill Loop**:
The central interactive loop where the user reviews memory and the agent asks clarifying or challenging questions. Review is the user's cognitive work; Grill is the agent's pressure and interaction inside the same loop.
_Avoid_: separate review phase, separate interview phase

**Memory Review**:
The user's explicit acceptance, rejection, or uncertainty judgment about a memory candidate before it can shape grill or summary.
_Avoid_: passive viewing, agent-selected evidence

**Memory Review State**:
The minimal persisted state owned by the Memory Surface: source insight identity, search round summaries, visible candidates, relation outputs, user review choices, and draft review benchmark seeds. For the Obsidian plugin path, the Aha Session Record is the source of truth; Review Notes are optional exports rather than default state storage. It deliberately excludes trace logs, raw retrieval diagnostics, and the later grilling conversation.
_Avoid_: grill transcript, full workflow state, chat history, trace log, raw pipeline evidence

**Panel State**:
The subset of Memory Review State required to reopen the Aha Review Panel, show prior candidates, restore user choices, and rebuild the Grill Handoff. It should store only visible candidate fields and compact feedback, not raw prompts, full old-note bodies, pipeline events, rerank internals, or unbounded round logs.
_Avoid_: complete run log, raw retrieval cache, trace archive, full candidate documents

**Selected Memory**:
A memory candidate currently marked to be included in the Grill Handoff. Selection is distinct from review feedback: it decides handoff inclusion, while accept/noise records future learning signals. Non-weak candidates are selected by default after retrieval, weak candidates default out, and the user can override selection before exporting the handoff; in the Obsidian plugin path, selection belongs to the Aha Session Record.
_Avoid_: automatically accepted evidence, final used memory, forced top-N, benchmark signal

**Used Memory**:
A memory item that actually shaped the final judgment or summary draft. Used memory is narrower than memory candidates and should be named in the summary only when it contributed to the judgment transformation.
_Avoid_: all retrieved notes, search result list

**Candidate Open Action**:
A Memory Surface action that opens a candidate old note or quoted span in a separate note leaf so the user's current insight note remains in place.
_Avoid_: replacing the current insight note, raw filesystem reveal only

**Review Feedback Action**:
A low-friction user action captured in the Aha Session Record during memory review as a byproduct of normal product use. The primary actions are accept, reject_as_noise, and should_have_found; relation fixes may exist in candidate details but should not interrupt the main review flow.
_Avoid_: separate annotation task, full benchmark editing, hidden implicit feedback

**Accepted Memory Signal**:
A user review signal that a memory candidate was useful for the current insight. Accepted memories become draft nice-to-have seed material by default, but accept does not force handoff inclusion; only selection controls the Grill Handoff.
_Avoid_: automatic must-recall label, final evidence, hidden preference update

**Rejected Noise Signal**:
A user review signal that a memory candidate was not useful in the current review. Rejected noise first remains draft noise seed material and should remove the candidate from handoff selection by default, but it is still feedback rather than the selection state itself.
_Avoid_: automatic negative label, ordinary skip, permanent dislike

**Should-Have-Found Signal**:
A user review signal that a missing memory should have appeared in the current review. It becomes draft must-recall seed material because it marks a real recall gap, but it still requires explicit collection before entering the active benchmark suite.
_Avoid_: casual suggestion, automatic benchmark case, ordinary search hint

### Aha Session Records & Exports

**Aha Session Record**:
The compact tool-state record for one source insight inside the Memory Surface, keyed by Source Note Identity when a source note exists. It stores only the Memory Review State needed to reopen the panel, preserve user choices, detect lightweight staleness, and export handoff; it is not an Obsidian note, exported artifact, trace log, or grill transcript.
_Avoid_: review note, markdown state, hidden chat history, pipeline trace, long-running log

**Aha Session Store**:
The Obsidian plugin data store that holds Aha Session Records. It should remain compact and product-facing, keeping only Panel State plus minimal source/session metadata while leaving detailed retrieval traces and process diagnostics outside the vault-facing plugin state.
_Avoid_: vault folder, review-note database, trace archive, raw event log

**Orphaned Session Record**:
An Aha Session Record whose source note can no longer be found in the vault. Orphaned records should be retained quietly and excluded from the active-note panel flow until a matching source note reappears or the user explicitly cleans them up.
_Avoid_: immediate deletion, noisy missing-file warning, active panel result

**Aha Review Note**:
An optional Markdown export of an Aha Session Record, created only when the user explicitly asks for a durable vault artifact. It can gather the source insight link, search round summaries, selected memories, relation reasons, optional relation quotes, grill handoff material, and review benchmark seeds saved during that insight review.
_Avoid_: default state store, global benchmark file, per-seed file, final summary

**Aha Review Panel**:
A low-friction Memory Surface view for actively reviewing one Aha Session Record. It presents memory candidates, relation evidence, and user review choices so the user can decide which candidates become Selected Memories and then export the Grill Handoff.
_Avoid_: agent chat UI, embedded grill, final judgment editor, markdown editor replacement, instructional copy, marketing copy

**Panel Follow Mode**:
The default Aha Review Panel behavior where the panel context follows the currently active source note and displays that note's Aha Session Record or empty state.
_Avoid_: review-note-bound panel, static sidebar context

**Pinned Panel Context**:
A temporary panel state where the Aha Review Panel stays focused on one source note even if the active Obsidian note changes. Pinning protects focused review without changing the underlying Aha Session Record.
_Avoid_: permanent session ownership, hidden active-note override

**Aha Review Filename**:
The human-readable filename for an exported Aha Review Note, preferably `{YYYY-MM-DD} {source insight title}.md`, with title sanitization and a short suffix only when needed to avoid collisions on the same date or title.
_Avoid_: opaque session id, global counter, title-less hash

**Aha Review Frontmatter**:
A minimal YAML header on an exported Aha Review Note used for stable extraction and filtering. It should identify the note as an Aha review export, link the source insight, record creation time, and track coarse status without turning the note into a database.
_Avoid_: full candidate JSON, hidden workflow state, verbose metadata

**Aha Review Status**:
The coarse lifecycle marker for an exported Aha Review Note. The initial statuses are memory_review, handoff_ready, and grilled.
_Avoid_: complete workflow stage machine, archived, summary_done

**Handoff Export**:
An explicit Memory Surface action that builds the Grill Handoff from Selected Memories and copies that handoff so the user can paste it into Codex for grilling. Exporting a handoff does not mean the selected memories have become benchmark seeds, final judgment evidence, or a Review Note.
_Avoid_: automatic Codex launch, benchmark save, final summary, hidden agent run, review note export

**Grill Handoff**:
A concise handoff text that passes the current insight link, Selected Memory links, and sufficiently detailed relation reasons from the Memory Surface into the Reasoning Workflow. It starts grilling by pointing Codex to readable notes and explaining why each selected memory matters, but is not itself a grill transcript.
_Avoid_: final summary, complete session state, automatic rewrite, copied full note bodies

**Review Note Export**:
An explicit low-frequency Memory Surface action that creates or updates an Aha Review Note from the current Panel State when the user wants a durable vault artifact. It exports the current review surface rather than full Search Round History or trace detail, belongs in the command palette rather than the Aha Review Panel, is separate from Handoff Export, and should not happen as a side effect of copying handoff text.
_Avoid_: default session creation, copy handoff, hidden markdown write, panel button

**Legacy Review Migration**:
A one-time agent-assisted migration from existing Aha Review Notes into Aha Session Records. It succeeds when the panel can reopen the old candidates, restore selection and draft feedback, and rebuild handoff from the migrated record; unmatched or ambiguous notes should be reported rather than guessed. It is not a standing product command; after successful migration, the user may manually delete old Review Notes without losing panel history.
_Avoid_: recurring import command, automatic vault cleanup, destructive migration, perfect markdown preservation

**Codex Grill Launch**:
An explicit user action from the Memory Surface that prepares the Grill Handoff Markdown for later use in Codex. It does not start an embedded grill UI or automatically run Codex.
_Avoid_: plugin-owned grill conversation, automatic summary, hidden agent run, opening Codex as a side effect

### Grilling & Judgment Formation

**Grill**:
A challenge phase where the agent interacts with the user to pressure acceptance, rejection, revision, or bounding of a candidate judgment. Grill and Review form a small loop: the agent asks, and the user's thinking in response is Review.
_Avoid_: interview, Q&A, discussion

**Grill Insight**:
A focused grilling artifact or session that helps externalize, challenge, and record emerging judgment during the Review-Grill loop. It is a process record for judgment formation, not the final synthesis.
_Avoid_: generic interview, final summary

**Candidate Judgment**:
A proposed judgment that is not yet the user's confirmed position. In this workflow, the agent may propose a candidate judgment when the user starts restating a stable judgment; intermediate judgment work may also be carried by Grill Insight.
_Avoid_: final answer, AI conclusion

**Judgment Card**:
A compact structure inside a summary draft that records the confirmed judgment, the insight it came from, the memory it connects to, its boundary, action relevance, and remaining uncertainty.
_Avoid_: required standalone file, article, essay, long summary

**Summary Draft**:
A draft output shaped around the user's original Obsidian note after the judgment has become clear enough to preserve. It should not directly rewrite the source note, but may offer additions, critiques, or suggested changes for the user to absorb.
_Avoid_: rewritten source note, final note, direct edit

**Judgment Shift**:
The explicit movement from a possible old understanding to a new or revised judgment. Summary drafts should name this shift even when the old understanding is only implicit.
_Avoid_: simple conclusion, nicer wording

**Grill Turn**:
One interaction unit inside the Review-Grill loop, pairing an agent question with the user's answer and any resulting insight. Grill turns preserve the thread of reasoning better than separate question and answer lists.
_Avoid_: question log, answer log

**New Insight**:
A fresh direction or idea discovered during review or grilling that is important enough to open a new direction. It may trigger another memory retrieval when the user explicitly asks for connected history notes or when the direction requires more old material.
_Avoid_: side thought, tangent

**Review Action**:
A user move inside the Review-Grill Stage, such as confirming a memory candidate, rejecting a memory candidate, naming a new insight, asking for another memory search, or declaring readiness for summary.
_Avoid_: agent action, passive response

### Benchmark & Evaluation

**Review Benchmark Seed**:
A reviewed memory candidate and relation result that the user explicitly saves as material for a future benchmark case, usually first as a structured entry inside an Aha Review Note. It records a real use discovery after review; it is not an automatic gold label at retrieval time or a committed benchmark case.
_Avoid_: auto-generated benchmark answer, unreviewed candidate, exhaustive relevance set, direct bench JSON write

**Memory Candidate Recall Benchmark**:
A small retrieval benchmark that evaluates whether the Memory Stage surfaces the old notes that should become review candidates for a realistic insight input. It scores candidate-note recall and ranking, not the quality of the final judgment, grilling, or summary draft.
_Avoid_: full Aha quality evaluation, final-answer evaluation, summary quality score

**Memory Pipeline Benchmark**:
A benchmark that approximates the Memory Stage retrieval pipeline by running structured QMD retrieval, expanding QMD seed candidates through Obsidian backlinks, merging candidates, and scoring whether must-recall memories appear in the final candidate list.
_Avoid_: QMD-only benchmark, final summary evaluation, human judgment quality score

**Core Loop Benchmark**:
A scripted benchmark for the human-in-the-loop contract across candidate display, memory review, readiness gating, summary save, source-note non-mutation, resume, and second memory search.
_Avoid_: retrieval benchmark, summary quality score

**Benchmark Case**:
One human-authored evaluation example for the Memory Candidate Recall Benchmark. Its source of truth is the Benchmark Insight Input plus human review labels; executable QMD queries may be derived from it by an agent or script.
_Avoid_: synthetic search query, metric output, generated-only test case

**Benchmark Insight Input**:
The original insight material used to run a benchmark case, usually the exact text the user would give `/insight` or a source-note excerpt plus an optional fresh thought. It should preserve the user's real context and should not be replaced by an AI-written search prompt.
_Avoid_: synthetic prompt, hand-written search query, keyword bundle

**Source-Note Excerpt Benchmark Input**:
The preferred form of Benchmark Insight Input when the insight came from part of an Obsidian note. It identifies the source note and excerpt range, with an optional fresh thought, so the benchmark can preserve real context without copying large private text into JSON.
_Avoid_: copied full note body, AI-rewritten insight, detached prompt

**Benchmark Line Range**:
The 1-based inclusive source-note line span used by a Source-Note Excerpt Benchmark Input. When a benchmark input references a note, the line range should be present by default so retrieval agents see only the original insight excerpt, not the whole evolving note.
_Avoid_: whole-note default, vague excerpt, hidden surrounding context

**Whole-Note Benchmark Input**:
A source-note Benchmark Insight Input that intentionally uses the entire note because the whole note is the original insight material. It must be explicit in the case, for example `input.whole_note: true`, instead of being the silent fallback when no line range is present.
_Avoid_: accidental full-note read, implicit allow all, missing line range fallback

**Benchmark Input Block**:
The grouped `input` field inside a Benchmark Case. It should contain a source-note excerpt reference when one exists, plus a `thought` field that either supplements the source excerpt or, when no source note exists, holds the full standalone insight the user would have given `/insight`; whole-note inputs require an explicit whole-note flag.
_Avoid_: flat source fields, generated prompt fields, mixed query metadata

**Standalone Benchmark Text**:
The fallback use of `input.thought` for cases that did not originate from a source-note excerpt. It must be the user's real standalone `/insight` input, not an AI-written benchmark prompt.
_Avoid_: input.text, synthetic insight_input, rewritten search request, convenience prompt

**Benchmark Gold Block**:
The grouped `gold` field inside a Benchmark Case. It contains human review labels for scoring: required memories, useful optional memories, and misleading noise memories.
_Avoid_: scattered recall fields, generated expected answers, relation-judge output

**Required Gold Memory**:
A `gold.must` memory in a Benchmark Case. Missing it from the review candidate budget is a hard recall failure.
_Avoid_: nice-to-have memory, broad related context, optional tangent

**Helpful Gold Memory**:
A `gold.nice` memory in a Benchmark Case. Finding it improves review quality but missing it should not be treated as a hard recall failure.
_Avoid_: must-recall memory, noise label, exhaustive related note

**Noise Gold Memory**:
A `gold.noise` memory in a Benchmark Case. Surfacing it as useful indicates misleading retrieval or ranking because the note is superficially related but unhelpful for this insight.
_Avoid_: random irrelevant note, ordinary skip, merely low-priority memory

**Benchmark Case Title**:
A short human-readable label for a Benchmark Case, used only to recognize the case in reports and during curation. It is not retrieval input and does not affect scoring.
_Avoid_: description, query summary, scoring reason

**Benchmark Case Why**:
A brief human-maintenance note explaining why the gold labels are present. It records annotation rationale for future review, but is not retrieval input and does not affect scoring.
_Avoid_: annotation_note, model instruction, hidden scoring rule

**Primary Benchmark Suite**:
The local private benchmark file that scores Aha against the user's real insight workflow. It should contain only real or draft Benchmark Cases derived from actual insight inputs, not engineering edge-case tests.
_Avoid_: regression fixture, synthetic test suite, path-resolution test file

**Benchmark Case State**:
The lifecycle marker for a case inside the Primary Benchmark Suite. The allowed states are `active` for default scoring, `draft` for human curation before scoring, and `off` for retained-but-unused cases.
_Avoid_: holdout, tech, disabled, implementation status

**Benchmark Regression Fixture**:
A separate test artifact for engineering edge cases such as duplicate basenames, qmd URI resolution, missing explicit cues, source-note self-hit filtering, or no-related-memory behavior. It protects implementation behavior but should not contribute to the Primary Benchmark Suite's product-quality score.
_Avoid_: primary benchmark case, personal memory quality score, real insight case

**Relation Evaluation Benchmark**:
A future separate benchmark for whether Relation Judge labels and evidence are correct after a memory has already been retrieved. It should not be mixed into the Primary Benchmark Suite, which first measures candidate recall, ranking, and noise control.
_Avoid_: required field in recall cases, primary memory candidate benchmark, gold recall label

**Review Attention Budget**:
The default number of memory candidates the user is expected to scan in one benchmarked review batch. Aha's first evaluation budget is ten candidates, so primary recall, precision, ranking, and noise metrics should be reported at 10 unless a case explicitly justifies another cutoff.
_Avoid_: unlimited result list, hidden scoring limit, arbitrary top-k

**Expanded Pool Diagnostic Budget**:
The wider internal candidate cutoff used to decide whether a must-recall memory was reached by retrieval before final ranking. Aha may use twenty candidates for this diagnostic even when user-facing review metrics remain fixed at ten.
_Avoid_: user review budget, primary quality metric, final candidate list

**Executable Benchmark Query**:
The structured memory query derived from a benchmark case and passed to QMD for automatic scoring. It is a machine-executable artifact, not the human-authored evaluation source.
_Avoid_: original insight input, gold label, user-authored question

**Source-Note Anchored Benchmark Query**:
A benchmark query built from a realistic insight input where the source note itself carries most of the retrieval signal. It tests whether the Memory Stage can infer related prior memory from the note's situation, judgment, and unresolved tension, without relying on a remembered title or explicit keyword.
_Avoid_: exact-title query, keyword-only search, artificial lookup prompt

**Must-Recall Memory**:
A prior note that should be counted as required ground truth for a Memory Candidate Recall Benchmark query. If it is missing from the Memory Stage candidates, the benchmark should treat that as a real recall failure.
_Avoid_: all related notes, nice-to-have context, interesting tangent

**Nice-to-Have Memory**:
A prior note that would be useful or interesting if retrieved for a benchmark query, but should not count as required ground truth for automatic recall metrics.
_Avoid_: required hit, failure condition, exhaustive relevance set

**Negative Memory**:
A prior note that looks superficially related to the insight but should not be ranked as useful because it does not help the user form, challenge, or bound the current judgment. Negative memories are core evaluation labels for noise control, not casual irrelevant notes.
_Avoid_: random irrelevant note, unscored false positive, harmless tangent

### Pipeline Trace & Diagnosis

**Pipeline Trace**:
A structured evidence record for one Memory Pipeline Benchmark case. It shows the retrieval path from benchmark input through query generation, QMD retrieval, backlink expansion, the pre-rerank candidate pool, final ranking, gold-memory positions, and diagnosis. Its purpose is to explain where the case succeeded or failed so the next product optimization target is clear.
_Avoid_: agent runtime log, Markdown report, complete note backup, generic debug dump

**Pre-Rerank Candidate Pool**:
The merged candidate set available to the reranker after QMD retrieval and backlink expansion but before final ranking. It is the key boundary for separating retrieval failures from rerank failures.
_Avoid_: final candidate list, expanded score only, hidden reranker input

**Gold Position**:
The observed stage and rank of a Required Gold Memory, Helpful Gold Memory, or Noise Gold Memory within a Pipeline Trace. Gold Position should make it clear whether a gold memory was missing entirely, present before rerank but dropped later, or surfaced inside the Review Attention Budget.
_Avoid_: score-only hit, vague match, manual postmortem

**Trace Diagnosis**:
The rule-based optimization signal attached to a Pipeline Trace. It names the primary next target, such as query generation, retrieval, backlink expansion, reranking, case labeling, or runtime reliability, using the trace evidence rather than a free-form narrative.
_Avoid_: long explanation, LLM-only summary, unsupported blame

**Failure Attribution**:
The single primary reason assigned to a benchmark miss or poor candidate ranking so the next improvement target is clear. The first Aha taxonomy is case_label_failure, input_representation_failure, query_failure, retrieval_failure, rerank_failure, and relation_failure; auxiliary flags may record secondary symptoms, but each failure should have one primary attribution.
_Avoid_: vague bad result, multi-paragraph postmortem, metric-only failure
