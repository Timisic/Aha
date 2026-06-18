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

**Memory**:
Prior notes, reviews, knowledge-base entries, judgments, projects, scenes, or artifacts that the user has written or confirmed before. Memory is local past material, not generic web search or temporary model association.
_Avoid_: database, archive, web search, model association

**Memory Query**:
A search request generated from the raw insight and context to retrieve prior memory. The first pass should favor semantic relevance; structural similarity can be explored later when the review needs it.
_Avoid_: final interpretation, prompt

**Structured Memory Query**:
A memory query that combines an explicit retrieval intent, short lexical anchors, semantic paraphrases, and a hypothetical shape of the old memory that would satisfy the search. It should preserve the user's insight input while making the retrieval target precise.
_Avoid_: raw prompt passthrough, keyword-only query, generic semantic search

**Review**:
The user's own cognitive work while checking whether memory is truly related, thinking through relationships between old notes and a new insight, or reflecting during an agent exchange. Review can include reading, comparing, remembering, judging, and answering; it can happen before, during, and after grilling rather than as a strictly separate stage.
_Avoid_: passive reading, agent analysis

**Review-Grill Loop**:
The central interactive loop where the user reviews memory and the agent asks clarifying or challenging questions. Review is the user's cognitive work; Grill is the agent's pressure and interaction inside the same loop.
_Avoid_: separate review phase, separate interview phase

**Memory Relation**:
A tentative label the agent uses to present how an old note may relate to the current insight before the user completes Review. The core relation labels are supports, challenges, resembles, and bounds.
_Avoid_: completed review, relevance score, background

**Memory Candidate**:
A retrieved old note presented for the user's review. Memory candidates may be merged from multiple searches, deduplicated, and shown in a compact table with title, relation, reason, and why to read it first, not as a completed interpretation.
_Avoid_: reviewed note, final evidence, exhaustive result

**Memory Candidate Recall Benchmark**:
A small retrieval benchmark that evaluates whether the Memory Stage surfaces the old notes that should become review candidates for a realistic insight input. It scores candidate-note recall and ranking, not the quality of the final judgment, grilling, or summary draft.
_Avoid_: full Aha quality evaluation, final-answer evaluation, summary quality score

**Memory Pipeline Benchmark**:
A benchmark that approximates the Memory Stage retrieval pipeline by running structured QMD retrieval, expanding QMD seed candidates through Obsidian backlinks, merging candidates, and scoring whether must-recall memories appear in the final candidate list.
_Avoid_: QMD-only benchmark, final summary evaluation, human judgment quality score

**Benchmark Case**:
One human-authored evaluation example for the Memory Candidate Recall Benchmark. Its source of truth is the realistic insight input plus the must-recall memories; executable QMD queries may be derived from it by an agent or script.
_Avoid_: synthetic search query, metric output, generated-only test case

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
