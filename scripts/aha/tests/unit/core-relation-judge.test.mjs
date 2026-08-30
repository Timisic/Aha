// Tests for the shared-core LLM Relation Judge (ADR 0005, issue #57).
//
// The compiled core artifact is never committed, so this test rebuilds it the
// same way scripts/lib/core-artifact.mjs does and imports
// obsidian-plugin/dist/core.mjs directly. LLM effects are all injected: a
// recording fake httpPost plus a recording fake sleep, matching the style of
// core-llm-transport.test.mjs.
//
// Quote-evidence demotion-to-Weak parity: `legacyHasQuoteEvidence` /
// `legacyEnforceQuoteBackedRelation` below are a verbatim transcription of
// git show 71547be:scripts/aha/relation-judge.mjs's hasQuoteEvidence /
// enforceQuoteBackedRelation (the baseline before this migration touched the
// file) — not an import of a frozen copy, per issue #57's instructions. The
// parity test runs a matrix of quote/excerpt combinations through both the
// legacy snippet and the ported core function and asserts identical output.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const repoRoot = path.resolve(import.meta.dirname, "..", "..", "..", "..");
const pluginDir = path.join(repoRoot, "obsidian-plugin");
const artifactPath = path.join(pluginDir, "dist", "core.mjs");

const build = spawnSync(process.execPath, ["esbuild.config.mjs", "core"], {
  cwd: pluginDir,
  encoding: "utf-8",
});
if (build.error) {
  throw new Error(`core artifact build failed to spawn: ${build.error.message}`);
}
if (build.status !== 0) {
  throw new Error(`core artifact build failed (exit ${build.status}):\n${build.stdout ?? ""}${build.stderr ?? ""}`);
}

const core = await import(pathToFileURL(artifactPath).href);
const {
  RELATION_JUDGE_PROMPT_VERSION,
  buildRelationJudgePrompt,
  composeFinalSlate,
  enforceQuoteBackedRelation,
  hasQuoteEvidence,
  judgeCandidateRelationsViaLlm,
  judgeRelationsRawViaLlm,
  mergeJudgedCandidates,
  orderJudgedCandidates,
} = core;

// --- fakes ---

function fakeDeps(script) {
  const calls = [];
  let index = 0;
  return {
    calls,
    deps: {
      httpPost: async (url, headers, body, timeoutMs) => {
        calls.push({ url, headers, body: JSON.parse(body), timeoutMs });
        const step = script[Math.min(index, script.length - 1)];
        index += 1;
        if (step instanceof Error) throw step;
        return step;
      },
      sleep: async () => {},
    },
  };
}

const responsesEnvelope = (json) => ({
  status: 200,
  bodyText: JSON.stringify({ output_text: JSON.stringify(json) }),
});

const transportRequest = () => ({
  baseUrl: "https://api.openai.com/v1",
  apiKey: "sk-test",
  model: "gpt-test",
  protocol: "responses",
  timeoutMs: 60_000,
});

const retrievalCandidates = [
  {
    notePath: "Memory/Feedback.md",
    noteTitle: "Feedback",
    relation: "weak",
    hit: "retrieval hit",
    why: "Retrieval surfaced this candidate.",
    quotes: [],
    selected: true,
  },
];

const candidateInputs = [
  {
    notePath: "Memory/Feedback.md",
    noteTitle: "Feedback",
    retrievalHit: "retrieval hit",
    retrievalWhy: "retrieval why",
    excerpt: "Feedback loops expose experience gaps and help judgment improve.",
  },
];

function judgeResultPayload(candidatePatch) {
  return {
    ok: true,
    sourcePath: "Source.md",
    generatedAt: null,
    summary: "Fixture relation judge output.",
    warnings: [],
    error: null,
    candidates: [
      {
        notePath: "Memory/Feedback.md",
        noteTitle: "Feedback",
        relation: "weak",
        hit: "\"Feedback loops expose experience gaps\"",
        why: "Feedback evidence connects the old note to the current source insight.",
        quotes: ["Feedback loops expose experience gaps"],
        selected: true,
        ...candidatePatch,
      },
    ],
  };
}

// --- basic prompt/version sanity ---

test("RELATION_JUDGE_PROMPT_VERSION is aha-relation-judge-v7", () => {
  assert.equal(RELATION_JUDGE_PROMPT_VERSION, "aha-relation-judge-v7");
});

test("buildRelationJudgePrompt embeds sourcePath and candidateInputs JSON", () => {
  const prompt = buildRelationJudgePrompt({ sourcePath: "Source.md", sourceText: "insight text", candidateInputs });
  assert.match(prompt, /sourcePath: Source\.md/);
  assert.match(prompt, /"notePath": "Memory\/Feedback\.md"/);
});

// --- judgeCandidateRelationsViaLlm: success, failure, repair-retry ---

for (const hit of [undefined, "", "Memory/Feedback.md"]) {
  test(`weak candidate without evidence never substitutes its path for hit (${hit})`, async () => {
    const { deps } = fakeDeps([responsesEnvelope(judgeResultPayload({ hit, quotes: [] }))]);
    const result = await judgeCandidateRelationsViaLlm({
      sourcePath: "Source.md", sourceText: "An insight about practice.",
      candidates: retrievalCandidates, candidateInputs,
    }, transportRequest(), deps);
    assert.equal(result.ok, true);
    assert.equal(result.candidates[0].relation, "weak");
    assert.notEqual(result.candidates[0].hit, "Memory/Feedback.md");
    assert.deepEqual(result.candidates[0].quotes, []);
  });
}

test("successful LLM call preserves a quote-backed strong relation", async () => {
  const { deps } = fakeDeps([responsesEnvelope(judgeResultPayload({
    relation: "supports",
    hit: "\"Feedback loops expose experience gaps\"",
    quotes: ["Feedback loops expose experience gaps"],
  }))]);
  const result = await judgeCandidateRelationsViaLlm({
    sourcePath: "Source.md",
    sourceText: "I need old notes about feedback loops.",
    candidates: retrievalCandidates,
    candidateInputs,
    generatedBy: "llm",
  }, transportRequest(), deps);

  assert.equal(result.ok, true);
  assert.equal(result.relation_judge_generated_by, "llm");
  assert.equal(result.candidates[0].relation, "supports");
  assert.deepEqual(result.candidates[0].quotes, ["Feedback loops expose experience gaps"]);
});

test("hallucinated quote evidence is downgraded to weak by the merge step", async () => {
  const { deps } = fakeDeps([responsesEnvelope(judgeResultPayload({
    relation: "supports",
    hit: "\"This quote is not in the excerpt\"",
    quotes: ["This quote is not in the excerpt"],
  }))]);
  const result = await judgeCandidateRelationsViaLlm({
    sourcePath: "Source.md",
    sourceText: "I need old notes about feedback loops.",
    candidates: retrievalCandidates,
    candidateInputs,
  }, transportRequest(), deps);

  assert.equal(result.ok, true);
  assert.equal(result.candidates[0].relation, "weak");
  assert.deepEqual(result.candidates[0].quotes, []);
  assert.match(result.candidates[0].why, /Downgraded to weak/);
});

test("LLM transport failure produces a structured failed record, never a fake success", async () => {
  const { deps } = fakeDeps([new Error("connection refused")]);
  const result = await judgeCandidateRelationsViaLlm({
    sourcePath: "Source.md",
    sourceText: "I need old notes about feedback loops.",
    candidates: retrievalCandidates,
    candidateInputs,
    generatedBy: "deepseek",
  }, transportRequest(), deps);

  assert.equal(result.ok, false);
  assert.equal(result.tool, "deepseek");
  assert.match(result.error, /failed relation judging/);
  assert.deepEqual(result.candidates, retrievalCandidates);
  assert.equal(result.relation_judge_prompt_version, RELATION_JUDGE_PROMPT_VERSION);
});

test("empty candidateInputs produces a structured failed record without calling the LLM", async () => {
  const { deps, calls } = fakeDeps([responsesEnvelope(judgeResultPayload({}))]);
  const result = await judgeCandidateRelationsViaLlm({
    sourcePath: "Source.md",
    sourceText: "text",
    candidates: retrievalCandidates,
    candidateInputs: [],
  }, transportRequest(), deps);

  assert.equal(result.ok, false);
  assert.equal(result.tool, "qmd");
  assert.match(result.error, /No candidate excerpts were readable/);
  assert.equal(calls.length, 0);
});

test("schema-invalid output retries once with a repair prompt, then succeeds", async () => {
  let calls = 0;
  const deps = {
    httpPost: async (_url, _headers, body) => {
      calls += 1;
      const parsed = JSON.parse(body);
      if (calls === 1) {
        assert.doesNotMatch(parsed.input, /previous JSON failed validation/i);
        return responsesEnvelope(judgeResultPayload({ why: "太短" }));
      }
      assert.match(parsed.input, /previous JSON failed validation/i);
      return responsesEnvelope(judgeResultPayload({
        why: "旧笔记里的反馈闭环说明，沉默或缺少回应本身也可以成为修正当前判断的具体证据。",
      }));
    },
    sleep: async () => {},
  };
  const result = await judgeCandidateRelationsViaLlm({
    sourcePath: "Source.md",
    sourceText: "I need old notes about feedback loops.",
    candidates: retrievalCandidates,
    candidateInputs,
    generatedBy: "deepseek",
  }, transportRequest(), deps);

  assert.equal(calls, 2);
  assert.equal(result.ok, true);
  assert.equal(result.relation_judge_generated_by, "deepseek");
  assert.ok(result.warnings.some((warning) => warning.includes("retried once")));
});

test("a repair retry that still fails validation is a structured failure, not a fake success", async () => {
  const { deps } = fakeDeps([
    responsesEnvelope(judgeResultPayload({ why: "太短" })),
    responsesEnvelope(judgeResultPayload({ why: "还是太短" })),
  ]);
  const result = await judgeCandidateRelationsViaLlm({
    sourcePath: "Source.md",
    sourceText: "text",
    candidates: retrievalCandidates,
    candidateInputs,
    generatedBy: "fake-agent",
  }, transportRequest(), deps);

  assert.equal(result.ok, false);
  assert.equal(result.tool, "fake-agent");
  assert.match(result.error, /failed relation judging/i);
});

// --- judgeRelationsRawViaLlm: the chunk-friendly primitive ---

test("judgeRelationsRawViaLlm returns raw (unmerged) candidates on success", async () => {
  const { deps } = fakeDeps([responsesEnvelope(judgeResultPayload({ relation: "resembles" }))]);
  const raw = await judgeRelationsRawViaLlm({
    sourcePath: "Source.md",
    sourceText: "text",
    candidateInputs,
  }, transportRequest(), deps);

  assert.equal(raw.ok, true);
  assert.equal(raw.repaired, false);
  assert.equal(raw.candidates[0].relation, "resembles");
  // Unmerged: no retrieval-side fields like `selected` defaults or rerankId spliced in beyond what the model returned.
  assert.equal(raw.candidates[0].notePath, "Memory/Feedback.md");
});

// Regression: DeepSeek (chat-completions protocol, no structured-output
// schema enforcement -- unlike OpenAI's "responses" protocol, which is no
// longer a supported provider) reliably returns a bare single-candidate
// object -- {hit, why, quotes, notePath} -- omitting `relation` entirely,
// because buildRelationJudgePrompt's field list never named it as a
// required output key. normalizeStructuredResult already wrapped the bare
// object into {ok:true, candidates:[...]}, but only coerced an *invalid*
// relation *string* to "weak" -- a *missing* relation (undefined) fell
// through unchanged and failed validateAhaResult with "relation is
// invalid", so ~14/15 real candidates failed relation judging on a real
// plugin round (2026-08-26, deepseek-v4-flash). Captured verbatim from a
// live DeepSeek response.
test("a bare candidate object with no relation field at all still judges successfully (real DeepSeek output shape)", async () => {
  const { deps } = fakeDeps([responsesEnvelope({
    hit: "我想着要在心理学领域做出点成果来，想着给石头出个心理传记，想着运动心理。",
    why: "旧笔记中11月的理想主义激情与当前insight的迷茫低效形成对比。",
    quotes: ["我想着要在心理学领域做出点成果来"],
    notePath: "Memory/Feedback.md",
  })]);
  const raw = await judgeRelationsRawViaLlm({
    sourcePath: "Source.md",
    sourceText: "text",
    candidateInputs,
  }, transportRequest(), deps);

  assert.equal(raw.ok, true, raw.error);
  assert.equal(raw.candidates[0].relation, "weak");
  assert.equal(raw.candidates[0].notePath, "Memory/Feedback.md");
});

// Regression: DeepSeek very frequently returns `quotes` as a bare string
// instead of a one-element array (observed in 5 of 6 real responses during
// the 2026-08-26 live-plugin debugging session), which used to fail
// validateAhaResult's "quotes must be an array of strings" check and, for
// strong relations, the quote-backed-hit check too (hasQuoteEvidence reads
// candidate.quotes as an array). Captured verbatim from a live response.
test("quotes returned as a bare string (not an array) is coerced and still judges successfully", async () => {
  const { deps } = fakeDeps([responsesEnvelope({
    relation: "supports",
    hit: "总是在设定任务之后就不会无所事事",
    why: "旧笔记中曾记录设定细致任务能摆脱无所事事与未来焦虑，与当前迷茫期的低效且混乱的秩序状态感受相呼应。",
    quotes: "除非某项工作能占据较长时间，否则没有为自己设定任务就会变得无所事事",
    notePath: "Memory/Feedback.md",
  })]);
  const raw = await judgeRelationsRawViaLlm({
    sourcePath: "Source.md",
    sourceText: "text",
    candidateInputs,
  }, transportRequest(), deps);

  assert.equal(raw.ok, true, raw.error);
  assert.equal(raw.candidates[0].relation, "supports");
  assert.deepEqual(raw.candidates[0].quotes, ["除非某项工作能占据较长时间，否则没有为自己设定任务就会变得无所事事"]);
});

// Regression: DeepSeek sometimes omits notePath entirely from a bare
// candidate object. normalizeStructuredResult's bare-candidate-object
// detection keys off notePath being a string, so a missing notePath used to
// leave the response completely unwrapped and fail with the unhelpful
// "Result must include boolean ok." judgeRelationsRawViaLlm is only ever
// called with exactly one candidateInput from the per-candidate judging path
// (judgeCandidateRelationsViaLlm), so the caller already knows which
// notePath the response must be for. Captured verbatim from a live response.
test("a bare candidate object missing notePath backfills it from the single candidateInput", async () => {
  const { deps } = fakeDeps([responsesEnvelope({
    relation: "supports",
    hit: "自考完最后一门试，状态便一落千丈。",
    why: "旧笔记中放假后状态一落千丈的体验，与当前洞察中假期迷茫、无动力的状态形成呼应。",
    quotes: "自考完最后一门试，状态便一落千丈。",
  })]);
  const raw = await judgeRelationsRawViaLlm({
    sourcePath: "Source.md",
    sourceText: "text",
    candidateInputs,
  }, transportRequest(), deps);

  assert.equal(raw.ok, true, raw.error);
  assert.equal(raw.candidates[0].notePath, "Memory/Feedback.md");
});

// --- Quote-evidence demotion to Weak: decision-for-decision parity ---
//
// Legacy baseline transcribed verbatim from git show 71547be:scripts/aha/relation-judge.mjs.

function legacyNormalizeEvidenceText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}
function legacyEvidenceFingerprint(value) {
  return String(value ?? "").replace(/[\s\p{P}\p{S}]+/gu, "");
}
function legacyHasQuoteEvidence(candidate, excerpt) {
  const haystack = legacyNormalizeEvidenceText(excerpt);
  const haystackFingerprint = legacyEvidenceFingerprint(excerpt);
  const needles = [
    candidate.hit,
    ...(Array.isArray(candidate.quotes) ? candidate.quotes : []),
  ]
    .map((value) => legacyNormalizeEvidenceText(value).replace(/^["'“”‘’]+|["'“”‘’]+$/g, ""))
    .filter((value) => value.length >= 8);
  return needles.some((needle) => {
    if (haystack.includes(needle)) return true;
    const fingerprint = legacyEvidenceFingerprint(needle);
    return fingerprint.length >= 8 && haystackFingerprint.includes(fingerprint);
  });
}
function legacyEnforceQuoteBackedRelation(candidate, excerpt) {
  if (candidate.relation === "weak") return candidate;
  if (legacyHasQuoteEvidence(candidate, excerpt)) return candidate;
  return {
    ...candidate,
    relation: "weak",
    why: `${candidate.why} Downgraded to weak because the bounded excerpt did not contain the returned quote evidence.`,
    quotes: [],
  };
}

const quoteMatrix = [
  {
    name: "quote present verbatim in excerpt -> relation preserved",
    candidate: { relation: "supports", hit: "\"Feedback loops expose gaps\"", why: "why text", quotes: ["Feedback loops expose gaps"] },
    excerpt: "Some preamble. Feedback loops expose gaps and drive change.",
  },
  {
    name: "quote present after whitespace normalization -> relation preserved",
    candidate: { relation: "challenges", hit: "\"Feedback   loops\nexpose gaps\"", why: "why text", quotes: [] },
    excerpt: "Feedback loops expose gaps in one long line without the original newline.",
  },
  {
    name: "quote present only after fingerprint (punctuation-insensitive) match -> relation preserved",
    candidate: { relation: "bounds", hit: "\"Feedback-loops, expose: gaps!\"", why: "why text", quotes: [] },
    excerpt: "FeedbackloopsexposegapsXX and other content padding the excerpt out.",
  },
  {
    name: "quote absent from excerpt -> demoted to weak",
    candidate: { relation: "resembles", hit: "\"Completely unrelated quote text\"", why: "why text", quotes: [] },
    excerpt: "Feedback loops expose gaps and drive change.",
  },
  {
    name: "short needle below the 8-char floor never counts as evidence -> demoted",
    candidate: { relation: "supports", hit: "\"short\"", why: "why text", quotes: [] },
    excerpt: "short appears right here in the excerpt text.",
  },
  {
    name: "weak relation is never checked or demoted, even with no matching quote",
    candidate: { relation: "weak", hit: "\"Nothing that matches\"", why: "why text", quotes: [] },
    excerpt: "Totally different excerpt content.",
  },
  {
    name: "quote comes from the quotes array, not hit -> relation preserved",
    candidate: { relation: "supports", hit: "a short unquoted hit note", why: "why text", quotes: ["Feedback loops expose gaps"] },
    excerpt: "Feedback loops expose gaps and drive change.",
  },
  {
    name: "empty excerpt with any strong relation -> demoted",
    candidate: { relation: "bounds", hit: "\"anything at all here\"", why: "why text", quotes: [] },
    excerpt: "",
  },
];

for (const { name, candidate, excerpt } of quoteMatrix) {
  test(`quote-evidence parity: ${name}`, () => {
    const legacyHas = legacyHasQuoteEvidence(candidate, excerpt);
    const coreHas = hasQuoteEvidence(candidate, excerpt);
    assert.equal(coreHas, legacyHas, "hasQuoteEvidence must match the legacy baseline");

    const legacyEnforced = legacyEnforceQuoteBackedRelation(candidate, excerpt);
    const coreEnforced = enforceQuoteBackedRelation(candidate, excerpt);
    assert.deepEqual(coreEnforced, legacyEnforced, "enforceQuoteBackedRelation must match the legacy baseline decision-for-decision");
  });
}

test("quote-evidence parity holds across the full matrix without any case being vacuous", () => {
  // Guard against a matrix that accidentally has zero demotions or zero preservations.
  const outcomes = quoteMatrix.map(({ candidate, excerpt }) => enforceQuoteBackedRelation(candidate, excerpt).relation === "weak");
  assert.ok(outcomes.some(Boolean), "expected at least one demotion case");
  assert.ok(outcomes.some((demoted) => !demoted), "expected at least one preserved-relation case");
});

// --- merge / order / slate (core re-exports; sanity, not full re-tests of
// the dedicated relation-judge-ordering.test.mjs / relation-judge-slate.test.mjs) ---

test("mergeJudgedCandidates applies quote enforcement while merging retrieval fields", () => {
  const judged = mergeJudgedCandidates(
    retrievalCandidates,
    [{ notePath: "Memory/Feedback.md", relation: "supports", hit: "\"nonexistent quote\"", why: "why", quotes: ["nonexistent quote"], selected: true }],
    candidateInputs,
    { preserveOrder: true },
  );
  assert.equal(judged[0].relation, "weak");
  assert.equal(judged[0].notePath, "Memory/Feedback.md");
});

test("orderJudgedCandidates and composeFinalSlate are re-exported and usable from core", () => {
  const ordered = orderJudgedCandidates(
    [{ notePath: "B.md", relation: "weak" }, { notePath: "A.md", relation: "supports" }],
    [{ notePath: "A.md" }, { notePath: "B.md" }],
  );
  assert.deepEqual(ordered.map((c) => c.notePath), ["A.md", "B.md"]);

  const slate = composeFinalSlate(
    [{ notePath: "A.md" }, { notePath: "B.md" }],
    [{ notePath: "B.md" }, { notePath: "A.md" }],
    { reservedPoolSlots: 0 },
  );
  assert.deepEqual(slate.map((c) => c.notePath), ["A.md", "B.md"]);
});
