export const RETRIEVAL_POLICY_VERSION = 2;

const shared = Object.freeze({
  version: RETRIEVAL_POLICY_VERSION,
  queryLimit: 7,
  supplements: Object.freeze({ sourceExcerpt: true, thought: true, queryBudget: 2 }),
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
  chunkedJudge: false,
  failClosed: false,
  supplements: Object.freeze({ sourceExcerpt: false, thought: false }),
  graphExpansion: Object.freeze({ enabled: true, seedLimit: 0, unbounded: true }),
  candidateBudgets: Object.freeze({
    retrievalPoolBudget: 20,
    judgeReviewBudget: 20,
    finalDisplayBudget: 20,
    chunkSize: 20,
    concurrency: 1,
    globalComparisonBudget: 20,
  }),
});

// Candidate policy: keep the stable rollback retrieval surface, then let the
// quote-validated Relation Judge order the review slate with retrieval reserves.
export const RANKED_RETRIEVAL_POLICY_V1 = Object.freeze({
  ...LEGACY_RETRIEVAL_POLICY_V1,
  id: "ranked-v1",
  relationOrdering: "strength-with-pool-reserve",
});

// Keep the shipped default on the rollback contract until private development
// and holdout comparisons produce eligible promotion evidence.
export const DEFAULT_RETRIEVAL_POLICY_ID = LEGACY_RETRIEVAL_POLICY_V1.id;
export const RETRIEVAL_POLICY_IDS = Object.freeze([
  PRODUCT_RETRIEVAL_POLICY_V2.id,
  RANKED_RETRIEVAL_POLICY_V1.id,
  LEGACY_RETRIEVAL_POLICY_V1.id,
]);

export function retrievalPolicyById(id = DEFAULT_RETRIEVAL_POLICY_ID) {
  if (id === PRODUCT_RETRIEVAL_POLICY_V2.id) return PRODUCT_RETRIEVAL_POLICY_V2;
  if (id === RANKED_RETRIEVAL_POLICY_V1.id) return RANKED_RETRIEVAL_POLICY_V1;
  if (id === LEGACY_RETRIEVAL_POLICY_V1.id) return LEGACY_RETRIEVAL_POLICY_V1;
  throw new Error(`Unsupported retrieval policy: ${id}`);
}

export function policyWithDisplayBudget(base, finalDisplayBudget) {
  const display = Number.isInteger(finalDisplayBudget) ? finalDisplayBudget : base.candidateBudgets.finalDisplayBudget;
  return {
    ...base,
    candidateBudgets: { ...base.candidateBudgets, finalDisplayBudget: display },
  };
}
