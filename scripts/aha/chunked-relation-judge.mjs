export const DEFAULT_CHUNKED_JUDGE_POLICY = Object.freeze({
  retrievalPoolBudget: 80,
  judgeReviewBudget: 60,
  finalDisplayBudget: 20,
  chunkSize: 20,
  concurrency: 3,
  globalComparisonBudget: 40,
});

const POLICY_LIMITS = Object.freeze({
  retrievalPoolBudget: [1, 200],
  judgeReviewBudget: [1, 100],
  finalDisplayBudget: [1, 50],
  chunkSize: [1, 50],
  concurrency: [1, 8],
  globalComparisonBudget: [1, 100],
});

export function validateChunkedJudgePolicy(policy = {}) {
  const value = { ...DEFAULT_CHUNKED_JUDGE_POLICY, ...policy };
  for (const [name, [minimum, maximum]] of Object.entries(POLICY_LIMITS)) {
    if (!Number.isInteger(value[name]) || value[name] < minimum || value[name] > maximum) {
      throw new RangeError(`${name} must be an integer between ${minimum} and ${maximum}.`);
    }
  }
  if (value.judgeReviewBudget > value.retrievalPoolBudget) {
    throw new RangeError("judgeReviewBudget must not exceed retrievalPoolBudget.");
  }
  if (value.finalDisplayBudget > value.judgeReviewBudget) {
    throw new RangeError("finalDisplayBudget must not exceed judgeReviewBudget.");
  }
  if (value.globalComparisonBudget > value.judgeReviewBudget) {
    throw new RangeError("globalComparisonBudget must not exceed judgeReviewBudget.");
  }
  return Object.freeze(value);
}

export async function runChunkedRelationJudge({
  candidates = [],
  policy,
  judgeChunk,
  compareGlobally,
  validateEvidence = (candidate) => candidate,
  candidateId = defaultCandidateId,
} = {}) {
  const effectivePolicy = validateChunkedJudgePolicy(policy);
  if (typeof judgeChunk !== "function") throw new TypeError("judgeChunk must be a function.");
  if (typeof validateEvidence !== "function") throw new TypeError("validateEvidence must be a function.");

  const retrievalPool = candidates.slice(0, effectivePolicy.retrievalPoolBudget);
  const reviewPool = retrievalPool.slice(0, effectivePolicy.judgeReviewBudget);
  assertUniqueCandidateIds(reviewPool, candidateId);
  const chunks = chunk(reviewPool, effectivePolicy.chunkSize);
  const settled = await boundedAllSettled(chunks, effectivePolicy.concurrency, async (items, chunkIndex) => {
    const output = await judgeChunk(items, { chunkIndex, chunkCount: chunks.length, policy: effectivePolicy });
    return validateJudgedSet(output, items, validateEvidence, candidateId);
  });
  const failures = settled
    .map((entry, chunkIndex) => entry.status === "rejected" ? traceFailure(entry.reason, chunkIndex) : null)
    .filter(Boolean);

  const baseCounts = {
    retrieval_pool_count: retrievalPool.length,
    judge_input_count: reviewPool.length,
    reviewed_count: settled.reduce((count, entry) => count + (entry.status === "fulfilled" ? entry.value.length : 0), 0),
    chunk_count: chunks.length,
    successful_chunk_count: settled.filter((entry) => entry.status === "fulfilled").length,
    final_count: 0,
  };
  if (failures.length > 0) {
    const errorCategory = commonFailureValue(failures, "category");
    return {
      ok: false,
      candidates: [],
      error: errorCategory === "empty_candidates"
        ? "No vault-contained excerpts were readable, so Relation Judge failed closed."
        : "Relation Judge failed closed because one or more chunks were not reviewed.",
      error_category: errorCategory,
      tool: commonFailureValue(failures, "tool"),
      failures,
      counts: baseCounts,
      policy: effectivePolicy,
    };
  }

  const judged = settled.flatMap((entry) => entry.value);
  let ordered = stableOrder(judged, reviewPool, candidateId);
  if (chunks.length > 1 && typeof compareGlobally === "function") {
    const comparisonInput = ordered.slice(0, effectivePolicy.globalComparisonBudget);
    try {
      const compared = await compareGlobally(comparisonInput, { policy: effectivePolicy, chunkCount: chunks.length });
      const validated = validateJudgedSet(compared, comparisonInput, validateEvidence, candidateId);
      const comparedIds = new Set(validated.map(candidateId));
      ordered = [...validated, ...ordered.filter((candidate) => !comparedIds.has(candidateId(candidate)))];
    } catch (error) {
      return {
        ok: false,
        candidates: [],
        error: "Relation Judge failed closed because global comparison did not complete.",
        failures: [traceFailure(error, "global")],
        error_category: error?.category ?? null,
        tool: error?.tool ?? null,
        counts: baseCounts,
        policy: effectivePolicy,
      };
    }
  }

  const finalCandidates = ordered.slice(0, effectivePolicy.finalDisplayBudget);
  return {
    ok: true,
    candidates: finalCandidates,
    failures: [],
    counts: { ...baseCounts, reviewed_count: judged.length, final_count: finalCandidates.length },
    policy: effectivePolicy,
  };
}

function validateJudgedSet(output, inputs, validateEvidence, candidateId) {
  if (!Array.isArray(output)) throw new TypeError("Judge output must be an array.");
  const expected = new Set(inputs.map(candidateId));
  const seen = new Set();
  const validated = output.map((candidate) => {
    const id = candidateId(candidate);
    if (!id || !expected.has(id) || seen.has(id)) throw new Error("Judge output has missing, duplicate, or unknown candidate identity.");
    seen.add(id);
    const value = validateEvidence(candidate, inputs.find((input) => candidateId(input) === id));
    if (!value) throw new Error("Judge evidence validation rejected a candidate.");
    return value;
  });
  if (seen.size !== expected.size) throw new Error("Judge output did not review every candidate in its chunk.");
  return validated;
}

function stableOrder(judged, retrievalOrder, candidateId) {
  const rank = new Map(retrievalOrder.map((candidate, index) => [candidateId(candidate), index]));
  return judged
    .map((candidate, index) => ({ candidate, index }))
    .sort((left, right) => (rank.get(candidateId(left.candidate)) ?? left.index) - (rank.get(candidateId(right.candidate)) ?? right.index))
    .map(({ candidate }) => candidate);
}

async function boundedAllSettled(items, limit, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      try { results[index] = { status: "fulfilled", value: await worker(items[index], index) }; }
      catch (reason) { results[index] = { status: "rejected", reason }; }
    }
  });
  await Promise.all(lanes);
  return results;
}

function chunk(items, size) {
  const chunks = [];
  for (let start = 0; start < items.length; start += size) chunks.push(items.slice(start, start + size));
  return chunks;
}

function assertUniqueCandidateIds(candidates, candidateId) {
  const ids = candidates.map(candidateId);
  if (ids.some((id) => !id) || new Set(ids).size !== ids.length) {
    throw new Error("Review candidates must have unique stable identities.");
  }
}

function defaultCandidateId(candidate) {
  return candidate?.notePath ?? candidate?.file ?? candidate?.rerankId ?? "";
}

function traceFailure(error, chunkIndex) {
  return {
    chunk_index: chunkIndex,
    error_name: error?.name || "Error",
    error_code: typeof error?.code === "string" ? error.code : null,
    category: error?.category ?? (/timed out|timeout/i.test(String(error?.message ?? "")) ? "timeout" : "stage_error"),
    tool: typeof error?.tool === "string" ? error.tool : null,
  };
}

function commonFailureValue(failures, key) {
  const values = [...new Set(failures.map((failure) => failure[key]).filter(Boolean))];
  return values.length === 1 ? values[0] : null;
}
