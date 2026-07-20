// Candidate identity/filter helpers for the bench pipeline.
//
// The implementation now lives in obsidian-plugin/src/core/candidates.ts
// (ADR 0005, issue #56); this module is a thin re-export of the compiled
// core artifact that keeps the exact call-site signatures every consumer
// (scripts/bench/run-pipeline-bench.mjs, scripts/lib/pipeline-trace.mjs, and
// the test suite) already relies on, including reading AHA_EXCLUDED_FOLDERS
// and AHA_BENCH_VAULT_ROOT at call time so bench behavior is unchanged.
export {
  DEFAULT_EXCLUDED_CANDIDATE_FOLDERS,
  annotateCandidateRerankIds,
  candidatePath,
  candidateRerankId,
  candidateSourceLabel,
  candidateSourceList,
  excludedCandidateFolders,
  isExcludedCandidatePath,
} from "./core-artifact.mjs";
