# Insight-to-Judgment Agent

This context names the cognitive workflow around turning a captured idea into a user-confirmed judgment. Its language should distinguish judgment formation from generic knowledge management, note summarization, or content collection.

## Language

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

**Source Note**:
The original Obsidian note or note excerpt the user provides as part of context for an insight session. It is optional, but when present it anchors the final summary draft and should not be edited directly by default.
_Avoid_: source of truth, output document

**Source Note Snapshot**:
The captured content shape of a source note at intake, used to preserve summary structure and warn about drift without rewriting the original note.
_Avoid_: editable source, final document

**Insight Input**:
The actual material the user gives `/insight` at session start. It is usually a source note alone, or a source note plus one fresh user thought; it is not usually a short search query, remembered title, or isolated keyword.
_Avoid_: search query, keyword prompt, remembered title

**Connected History Notes**:
Old notes named or requested by the user as especially relevant history for the current insight. They are explicit retrieval cues inside the context, not automatically accepted evidence.
_Avoid_: backlinks, automatic related notes

**Explicit Memory Cue**:
A user-provided title, keyword, or note reference that should be searched for directly because the user has already marked it as historically relevant.
_Avoid_: inferred related note, semantic guess

**Missing Explicit Cue**:
An explicit memory cue that the system attempted to retrieve but could not find. It should be surfaced to the user rather than silently dropped.
_Avoid_: irrelevant cue, failed judgment

**Explicit Cue Result**:
The retrieval status of a user-provided memory cue: found in displayed candidates, found only in the pool, not found, or ambiguous.
_Avoid_: missing cue only, search score

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
One explicit retrieval pass triggered by the user from the current insight, source note, or a newly opened direction. Search rounds should remain visible as provenance, while their candidates accumulate into one memory candidate pool for deduplication, selection, and handoff export.
_Avoid_: automatic background crawl, passive refresh

**Review**:
The user's own cognitive work while checking whether memory is truly related, thinking through relationships between old notes and a new insight, or reflecting during an agent exchange. Review can include reading, comparing, remembering, judging, and answering; it can happen before, during, and after grilling rather than as a strictly separate stage.
_Avoid_: passive reading, agent analysis

**Review-Grill Loop**:
The central interactive loop where the user reviews memory and the agent asks clarifying or challenging questions. Review is the user's cognitive work; Grill is the agent's pressure and interaction inside the same loop.
_Avoid_: separate review phase, separate interview phase

**Memory Relation**:
A tentative label the agent uses to present how an old note may relate to the current insight before the user completes Review. The core relation labels are supports, challenges, resembles, bounds, and weak.
_Avoid_: completed review, relevance score, background

**Relation Evaluation Target**:
An optional benchmark label for a specific insight-memory pair when the case is meant to test Relation Judge quality. It should not be required for every benchmark case because ordinary recall cases primarily evaluate candidate concentration, ranking, and noise control.
_Avoid_: required case field, retrieval gold label, user review shortcut

**Relation Judge**:
The evidence-bound step that compares one current insight with one candidate old note and proposes a Memory Relation, quoted source evidence, and a short reason. It runs after retrieval and before final candidate presentation or ranking.
_Avoid_: reranker, search score, final judgment

**Relation Quote**:
One to three short source-text spans from the candidate old note used to anchor a Relation Judge output. Strong relations require at least one quote; summaries may explain the quote but cannot replace it.
_Avoid_: generated summary, retrieval snippet, invented evidence

**Memory Candidate**:
A retrieved old note presented for the user's review. Memory candidates may be merged from multiple searches, deduplicated, and shown in a compact table with title, relation, reason, and why to read it first, not as a completed interpretation.
_Avoid_: reviewed note, final evidence, exhaustive result

**Memory Candidate Pool**:
The bounded pool of retrieved candidates accumulated across memory search rounds for deduplication, selection, and handoff export. Search round grouping may stay visible as provenance, but the pool is the shared review set.
_Avoid_: visible table, final evidence

**Memory Review**:
The user's explicit acceptance, rejection, or uncertainty judgment about a memory candidate before it can shape grill or summary.
_Avoid_: passive viewing, agent-selected evidence

**Memory Review State**:
The persisted state owned by the Memory Surface: source insight, search rounds, candidate pool, relation outputs, user review choices, and review benchmark seeds. For the Obsidian plugin path, user review choices should be stored in the Aha Review Note's visible Markdown checkboxes rather than hidden plugin data. It deliberately excludes the later grilling conversation.
_Avoid_: grill transcript, full workflow state, chat history

**Aha Review Note**:
One Markdown note in the user's note vault, stored by default under `Aha/Reviews/`, created for a specific insight review when the user explicitly triggers the first memory search. It gathers the source insight link, search round summaries, selected memories, relation reasons, optional relation quotes, grill handoff material, and any review benchmark seeds saved during that insight review.
_Avoid_: global benchmark file, per-seed file, final summary

**Aha Review Panel**:
A low-friction Memory Surface view for actively reviewing one Aha Review Note. It presents memory candidates, relation evidence, and user review choices so the user can decide which candidates become Selected Memories and then export the Grill Handoff. The Aha Review Note remains the persistent Markdown backing artifact.
_Avoid_: agent chat UI, embedded grill, final judgment editor, replacement for the review note, instructional copy, marketing copy

**Aha Review Filename**:
The human-readable filename for an Aha Review Note, preferably `{YYYY-MM-DD} {source insight title}.md`, with title sanitization and a short suffix only when needed to avoid collisions on the same date or title.
_Avoid_: opaque session id, global counter, title-less hash

**Aha Review Frontmatter**:
A minimal YAML header on an Aha Review Note used for stable extraction and filtering. It should identify the note as an Aha review, link the source insight, record creation time, and track coarse status without turning the note into a database.
_Avoid_: full candidate JSON, hidden workflow state, verbose metadata

**Aha Review Status**:
The coarse lifecycle marker in Aha Review Frontmatter. The initial statuses are memory_review, handoff_ready, and grilled.
_Avoid_: complete workflow stage machine, archived, summary_done

**Selected Memory**:
A memory candidate currently marked to be included in the Grill Handoff. Candidates are selected by default after retrieval, and the user removes low-value items before exporting the handoff; in the Obsidian plugin path, the Aha Review Note checkbox state is the source of truth.
_Avoid_: automatically accepted evidence, final used memory, forced top-N

**Handoff Export**:
An explicit Memory Surface action that first syncs the current panel selection into the Aha Review Note checkboxes, rebuilds or updates the Review Note's Grill Handoff from Selected Memories, and copies that handoff so the user can paste it into Codex for grilling. Exporting a handoff does not mean the selected memories have become benchmark seeds or final judgment evidence.
_Avoid_: automatic Codex launch, benchmark save, final summary, hidden agent run

**Candidate Open Action**:
A Memory Surface action that opens a candidate old note or quoted span in a separate note leaf so the user's current insight note remains in place.
_Avoid_: replacing the current insight note, raw filesystem reveal only

**Grill Handoff**:
A concise section of an Aha Review Note that passes the current insight link, Selected Memory links, and sufficiently detailed relation reasons from the Memory Surface into the Reasoning Workflow. It starts grilling by pointing Codex to readable notes and explaining why each selected memory matters, but is not itself a grill transcript.
_Avoid_: final summary, complete session state, automatic rewrite, copied full note bodies

**Codex Grill Launch**:
An explicit user action from the Memory Surface that prepares the Grill Handoff Markdown for later use in Codex. It does not start an embedded grill UI or automatically run Codex.
_Avoid_: plugin-owned grill conversation, automatic summary, hidden agent run, opening Codex as a side effect

**Review Benchmark Seed**:
A reviewed memory candidate and relation result that the user explicitly saves as material for a future benchmark case, usually first as a structured entry inside an Aha Review Note. It records a real use discovery after review; it is not an automatic gold label at retrieval time or a committed benchmark case.
_Avoid_: auto-generated benchmark answer, unreviewed candidate, exhaustive relevance set, direct bench JSON write

**Review Feedback Action**:
A low-friction user action captured during memory review as a byproduct of normal product use. The primary actions are accept, reject_as_noise, and should_have_found; relation fixes may exist in candidate details but should not interrupt the main review flow.
_Avoid_: separate annotation task, full benchmark editing, hidden implicit feedback

**Accepted Memory Signal**:
A user review signal that a memory candidate was useful for the current insight. Accepted memories should become nice-to-have benchmark material by default, and only become must-recall memories when the user explicitly marks them as required for future runs.
_Avoid_: automatic must-recall label, final evidence, hidden preference update

**Memory Candidate Recall Benchmark**:
A small retrieval benchmark that evaluates whether the Memory Stage surfaces the old notes that should become review candidates for a realistic insight input. It scores candidate-note recall and ranking, not the quality of the final judgment, grilling, or summary draft.
_Avoid_: full Aha quality evaluation, final-answer evaluation, summary quality score

**Memory Pipeline Benchmark**:
A benchmark that approximates the Memory Stage retrieval pipeline by running structured QMD retrieval, expanding QMD seed candidates through Obsidian backlinks, merging candidates, and scoring whether must-recall memories appear in the final candidate list.
_Avoid_: QMD-only benchmark, final summary evaluation, human judgment quality score

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

**Core Loop Benchmark**:
A scripted benchmark for the human-in-the-loop contract across candidate display, memory review, readiness gating, summary save, source-note non-mutation, resume, and second memory search.
_Avoid_: retrieval benchmark, summary quality score

**Failure Attribution**:
The single primary reason assigned to a benchmark miss or poor candidate ranking so the next improvement target is clear. The first Aha taxonomy is case_label_failure, input_representation_failure, query_failure, retrieval_failure, rerank_failure, and relation_failure; auxiliary flags may record secondary symptoms, but each failure should have one primary attribution.
_Avoid_: vague bad result, multi-paragraph postmortem, metric-only failure

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

**Rejected Noise Signal**:
A user review signal that a memory candidate was not useful in the current review. Rejected noise should first remain draft benchmark material, and should become an active negative memory only when the candidate is a misleading false positive rather than merely unnecessary for that moment.
_Avoid_: automatic negative label, ordinary skip, permanent dislike

**Search Signal**:
A retrieval clue such as rank, score, or query source that helps the agent organize candidates. Search signals are not part of the user's judgment and should not be presented as evidence by default.
_Avoid_: evidence, confidence, priority

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
A memory relation where the old note may be related, but the quoted evidence is not strong enough to call it supports, challenges, resembles, or bounds. Weak candidates may still be shown or saved, but should not be treated as judgment evidence until the user reviews them.
_Avoid_: irrelevant, needs_human, forced classification

**New Insight**:
A fresh direction or idea discovered during review or grilling that is important enough to open a new direction. It may trigger another memory retrieval when the user explicitly asks for connected history notes or when the direction requires more old material.
_Avoid_: side thought, tangent

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

**Review Action**:
A user move inside the Review-Grill Stage, such as confirming a memory candidate, rejecting a memory candidate, naming a new insight, asking for another memory search, or declaring readiness for summary.
_Avoid_: agent action, passive response

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

**Used Memory**:
A memory item that actually shaped the final judgment or summary draft. Used memory is narrower than memory candidates and should be named in the summary only when it contributed to the judgment transformation.
_Avoid_: all retrieved notes, search result list

**Grill Turn**:
One interaction unit inside the Review-Grill loop, pairing an agent question with the user's answer and any resulting insight. Grill turns preserve the thread of reasoning better than separate question and answer lists.
_Avoid_: question log, answer log

**Judgment Shift**:
The explicit movement from a possible old understanding to a new or revised judgment. Summary drafts should name this shift even when the old understanding is only implicit.
_Avoid_: simple conclusion, nicer wording

**Complete**:
A user-declared state that the current judgment transformation is sufficiently resolved for synthesis. The agent can propose readiness, but the user decides when the loop is complete.
_Avoid_: done by agent, automatic stop
