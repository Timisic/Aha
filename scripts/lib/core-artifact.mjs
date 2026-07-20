// Rebuild-first loader for the shared core artifact (ADR 0005).
//
// The compiled artifact (obsidian-plugin/dist/core.mjs) is never committed, so
// every importer must rebuild it from src/core before use. Importing this
// module does exactly that: it spawns the esbuild core build synchronously,
// then dynamically imports the fresh artifact and re-exports its functions
// with Node deps bound, keeping the legacy call-site signatures. Where the
// legacy behavior read process.env (AHA_EXCLUDED_FOLDERS, AHA_BENCH_VAULT_ROOT),
// this binding layer reads the same env vars so bench behavior is unchanged;
// core itself never touches process.env.

import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { coreLlmTransportDeps, coreNodeDeps, coreVaultBoundaryDeps, createQmdCliRunner } from "./core-node-deps.mjs";
import { DEFAULT_VAULT_ROOT } from "./vault-paths.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");
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
  throw new Error(
    `core artifact build failed (exit ${build.status}):\n${build.stdout ?? ""}${build.stderr ?? ""}`,
  );
}

const core = await import(pathToFileURL(artifactPath).href);

// --- note-identity (issue #54) ---

export const normalizeNoteIdentity = core.normalizeNoteIdentity;
export const sameNotePath = core.sameNotePath;
export const stripPathDecorations = core.stripPathDecorations;
export const slugPath = core.slugPath;
export const resolveVaultPath = core.resolveVaultPath;
export const equivalentVaultPath = core.equivalentVaultPath;

export function notePathForObsidian(args, row) {
  return core.notePathForObsidian(args, row, coreNodeDeps.path);
}

export function buildVaultPathResolver(root) {
  return core.buildVaultPathResolver(root, coreNodeDeps);
}

// --- candidates (issue #56) ---

export const DEFAULT_EXCLUDED_CANDIDATE_FOLDERS = core.DEFAULT_EXCLUDED_CANDIDATE_FOLDERS;
export const candidatePath = core.candidatePath;
export const candidateSourceList = core.candidateSourceList;
export const candidateSourceLabel = core.candidateSourceLabel;
export const candidateRerankId = core.candidateRerankId;
export const annotateCandidateRerankIds = core.annotateCandidateRerankIds;
export const isObsidianQmdUri = core.isObsidianQmdUri;

export function excludedCandidateFolders(extraEnvValue = process.env.AHA_EXCLUDED_FOLDERS) {
  return core.excludedCandidateFolders(extraEnvValue);
}

function vaultRootPrefix() {
  return process.env.AHA_BENCH_VAULT_ROOT || DEFAULT_VAULT_ROOT;
}

export function isExcludedCandidatePath(rawPath, folders = excludedCandidateFolders()) {
  return core.isExcludedCandidatePath(rawPath, folders, vaultRootPrefix());
}

export function resolveVaultContainedPath(args, location) {
  return core.resolveVaultContainedPath(args, location, coreVaultBoundaryDeps);
}

export function isCandidatePathAllowed(args, notePath, row) {
  return core.isCandidatePathAllowed(args, notePath, row, coreVaultBoundaryDeps);
}

export function qmdUriVaultPath(args, value) {
  return core.qmdUriVaultPath(args, value, coreVaultBoundaryDeps);
}

export function isSourceCandidate(args, notePath, row) {
  return core.isSourceCandidate(args, notePath, row, coreNodeDeps.path);
}

export function isGeneratedReviewCandidate(args, notePath, row) {
  return core.isGeneratedReviewCandidate(args, notePath, row, coreNodeDeps.path);
}

// --- query-plan-deterministic (issue #56) ---

export const QUERY_PLAN_KINDS = core.QUERY_PLAN_KINDS;
export const QUERY_PLAN_FALLBACK_KINDS = core.QUERY_PLAN_FALLBACK_KINDS;
export const QUERY_PLAN_COMMANDS = core.QUERY_PLAN_COMMANDS;
export const MAX_QMD_LEX_TERMS = core.MAX_QMD_LEX_TERMS;
export const MAX_QMD_LEX_CHARS = core.MAX_QMD_LEX_CHARS;
export const MAX_QMD_INTENT_CHARS = core.MAX_QMD_INTENT_CHARS;
export const MAX_QMD_VEC_CHARS = core.MAX_QMD_VEC_CHARS;
export const MAX_QMD_HYDE_CHARS = core.MAX_QMD_HYDE_CHARS;
export const compactLine = core.compactLine;
export const unique = core.unique;
export const splitLexCandidates = core.splitLexCandidates;
export const normalizeLex = core.normalizeLex;
export const normalizeQueryPlan = core.normalizeQueryPlan;
export const deterministicSourceFallbackQuery = core.deterministicSourceFallbackQuery;
export const normalizeQueryPlanItem = core.normalizeQueryPlanItem;
export const normalizeQmdObject = core.normalizeQmdObject;
export const fallbackQmdObject = core.fallbackQmdObject;
export const qmdQueryFromObject = core.qmdQueryFromObject;
export const queryPlanFromFallbackRules = core.queryPlanFromFallbackRules;
export const normalizeQueryKind = core.normalizeQueryKind;
export const normalizeQueryCommand = core.normalizeQueryCommand;
export const queryTextForCommand = core.queryTextForCommand;
export const sanitizeQmdLine = core.sanitizeQmdLine;

// --- qmd (issue #56) ---

export const DEFAULT_QMD_QUERY_TIMEOUT_MS = core.DEFAULT_QMD_QUERY_TIMEOUT_MS;
export const isQmdRetryableTimeout = core.isQmdRetryableTimeout;
export const extractQmdRows = core.extractQmdRows;
export const runQmdPlanQuery = core.runQmdPlanQuery;
export const runQmdPlanQueries = core.runQmdPlanQueries;
export { createQmdCliRunner };

// --- pool (issue #56) ---

export function mergeAndRankQueryResults(args, queryResults, policy) {
  return core.mergeAndRankQueryResults(args, queryResults, policy, coreVaultBoundaryDeps);
}
export const pipelineCandidate = core.pipelineCandidate;
export const firstSnippetLine = core.firstSnippetLine;

// --- note-excerpt (issue #56) ---

export const parseLineRange = core.parseLineRange;
export const normalizeLineRange = core.normalizeLineRange;
export const sliceLineRange = core.sliceLineRange;
export const lineCount = core.lineCount;
export const excerptNoteMarkdown = core.excerptNoteMarkdown;

// --- result-validator (issue #57) ---

export const AHA_RESULT_SCHEMA = core.AHA_RESULT_SCHEMA;
export const RELATIONS = core.RELATIONS;
export const validateAhaResult = core.validateAhaResult;

// --- query-plan-llm (issue #57) ---

export const QUERY_PLAN_PROMPT_VERSION = core.QUERY_PLAN_PROMPT_VERSION;
export const QUERY_PLAN_SCHEMA_NAME = core.QUERY_PLAN_SCHEMA_NAME;
export const QUERY_PLAN_SCHEMA = core.QUERY_PLAN_SCHEMA;
export const buildQueryPlanPrompt = core.buildQueryPlanPrompt;
export const queryPlanSourceSummary = core.queryPlanSourceSummary;

export function generateQueryPlanViaLlm(args, sourceText, transportRequest) {
  return core.generateQueryPlanViaLlm(args, sourceText, transportRequest, coreLlmTransportDeps);
}

// --- relation-judge (issue #57) ---

export const RELATION_JUDGE_PROMPT_VERSION = core.RELATION_JUDGE_PROMPT_VERSION;
export const RELATION_JUDGE_SCHEMA_NAME = core.RELATION_JUDGE_SCHEMA_NAME;
export const DEFAULT_RELATION_JUDGE_CHUNK_SIZE = core.DEFAULT_RELATION_JUDGE_CHUNK_SIZE;
export const DEFAULT_RELATION_JUDGE_CONCURRENCY = core.DEFAULT_RELATION_JUDGE_CONCURRENCY;
export const RELATION_STRENGTH = core.RELATION_STRENGTH;
export const buildRelationJudgePrompt = core.buildRelationJudgePrompt;
export const buildRelationJudgeRepairPrompt = core.buildRelationJudgeRepairPrompt;
export const normalizeStructuredResult = core.normalizeStructuredResult;
export const enforceQuoteBackedRelation = core.enforceQuoteBackedRelation;
export const hasQuoteEvidence = core.hasQuoteEvidence;
export const mergeJudgedCandidates = core.mergeJudgedCandidates;
export const orderJudgedCandidates = core.orderJudgedCandidates;

export function composeFinalSlate(judgedOrdered, retrievalCandidates, options = {}) {
  const reservedPoolSlots = options.reservedPoolSlots
    ?? Number(process.env.AHA_SLATE_POOL_RESERVE ?? core.DEFAULT_SLATE_POOL_RESERVE);
  return core.composeFinalSlate(judgedOrdered, retrievalCandidates, { ...options, reservedPoolSlots });
}

export function judgeRelationsRawViaLlm(input, transportRequest) {
  return core.judgeRelationsRawViaLlm(input, transportRequest, coreLlmTransportDeps);
}

export function judgeCandidateRelationsViaLlm(input, transportRequest) {
  return core.judgeCandidateRelationsViaLlm(input, transportRequest, coreLlmTransportDeps);
}

// --- orchestrator (issue #57) ---

export function runFullPipeline(args, llm, partialDeps) {
  return core.runFullPipeline(args, llm, {
    ...coreLlmTransportDeps,
    ...coreVaultBoundaryDeps,
    readNote: (absolutePath) => readFile(absolutePath, "utf-8"),
    ...partialDeps,
  });
}
