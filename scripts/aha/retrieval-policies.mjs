export const RETRIEVAL_POLICY_VERSION = 2;

const shared = Object.freeze({
  version: RETRIEVAL_POLICY_VERSION,
  queryLimit: 7,
  supplements: Object.freeze({ sourceExcerpt: true, thought: true }),
  graphExpansion: Object.freeze({
    enabled: true,
    seedLimit: 4,
    linksLimit: 5,
    backlinksLimit: 5,
    perSeedLimit: 8,
    globalCandidateLimit: 24,
  }),
  candidateBudgets: Object.freeze({
    retrievalPoolBudget: 80,
    judgeReviewBudget: 60,
    finalDisplayBudget: 20,
    chunkSize: 20,
    concurrency: 3,
    globalComparisonBudget: 40,
  }),
});

export const PRODUCT_RETRIEVAL_POLICY_V2 = Object.freeze({
  ...shared,
  id: "product-v2",
});

export const DIAGNOSTIC_RETRIEVAL_POLICY_V2 = Object.freeze({
  ...shared,
  id: "diagnostic-v2",
});

// Explicit rollback target. Keep this behavior stable until product-v2 is promoted.
export const LEGACY_RETRIEVAL_POLICY_V1 = Object.freeze({
  id: "legacy-v1",
  version: 1,
  queryLimit: 5,
  supplements: Object.freeze({ sourceExcerpt: false, thought: false }),
  graphExpansion: Object.freeze({ enabled: true, seedLimit: 0 }),
  candidateBudgets: Object.freeze({
    retrievalPoolBudget: 20,
    judgeReviewBudget: 20,
    finalDisplayBudget: 20,
    chunkSize: 20,
    concurrency: 1,
    globalComparisonBudget: 20,
  }),
});

export function policyWithDisplayBudget(base, finalDisplayBudget) {
  const display = Number.isInteger(finalDisplayBudget) ? finalDisplayBudget : base.candidateBudgets.finalDisplayBudget;
  return {
    ...base,
    candidateBudgets: { ...base.candidateBudgets, finalDisplayBudget: display },
  };
}
