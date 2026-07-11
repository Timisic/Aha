#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, relative, resolve } from "node:path";
import {
  collectResultItems,
  droppedMustFromExpandedPool,
  filterSourceNoteFromResults,
  pathsMatch,
  pickFirstString,
  readBenchmarkCases,
  resolveQmdQueriesForCase,
  scoreNiceToHave,
  scoreEvalV2,
  scoreResults,
  sourceNotePathForCase,
  summarizePipelineEvaluation,
  textFromUnknown,
} from "../lib/bench-cases.mjs";
import {
  comparePipelineStability,
  failureAttributionFromTrace,
  summarizePipelineEvaluationGroups,
} from "../lib/bench-scoring.mjs";
import {
  RELATION_JUDGE_PROMPT_VERSION,
  relationJudgeCandidatesForCase,
} from "../aha/relation-judge.mjs";
import { QUERY_PLAN_PROMPT_VERSION } from "../aha/query-plan.mjs";
import { runRetrievalPipeline } from "../aha/retrieval-pipeline.mjs";
import { DIAGNOSTIC_RETRIEVAL_POLICY_V2 } from "../aha/retrieval-policies.mjs";
import { excerptNoteMarkdown } from "../lib/note-excerpt.mjs";
import {
  PIPELINE_TRACE_SCHEMA,
  PIPELINE_TRACE_VERSION,
  buildPipelineTrace,
  summarizeTraceDiagnoses,
  writePipelineTraceForReport,
} from "../lib/pipeline-trace.mjs";
import {
  candidatePath,
  candidateSourceLabel as sourceLabel,
  candidateSourceList as sourceList,
  isExcludedCandidatePath,
} from "../lib/candidate-fields.mjs";
import {
  mergeOpenAiTransportStats,
  normalizeOpenAiTransportStats,
} from "../lib/openai-transport.mjs";
import {
  buildVaultPathResolver as sharedBuildVaultPathResolver,
  resolveVaultPath as sharedResolveVaultPath,
} from "../aha/lib/note-identity.mjs";
import { benchVaultRoot } from "../lib/vault-paths.mjs";
import {
  DEFAULT_OPENAI_API_KEY_ENV,
  DEFAULT_OPENAI_BASE_URL,
  DEFAULT_OPENAI_MODEL,
} from "../lib/openai-json-agent.mjs";

const WORKSPACE_ROOT = resolve(import.meta.dirname, "../..");
const SHIPPED_WRAPPER = resolve(WORKSPACE_ROOT, "scripts/aha/run-insight-search.mjs");

const DEFAULTS = {
  cases: "bench/aha-memory-cases.json",
  report: "bench/reports/latest/pipeline.json",
  index: "obsidian",
  collection: "",
  qmd: "qmd",
  obsidian: "obsidian",
  limit: 20,
  seedLimit: 10,
  backlinksPerSeed: 5,
  backlinkLimit: 20,
  qmdTimeoutMs: 90_000,
  obsidianTimeoutMs: 8_000,
  queryGenerator: "agent",
  llmProvider: process.env.AHA_BENCH_LLM_PROVIDER || "openai",
  llmBaseUrl: process.env.AHA_BENCH_LLM_BASE_URL || DEFAULT_OPENAI_BASE_URL,
  llmModel: process.env.AHA_BENCH_LLM_MODEL || DEFAULT_OPENAI_MODEL,
  llmApiKeyEnv: process.env.AHA_BENCH_LLM_API_KEY_ENV || DEFAULT_OPENAI_API_KEY_ENV,
  queryAgentProvider: process.env.AHA_BENCH_QUERY_AGENT_PROVIDER || process.env.AHA_BENCH_LLM_PROVIDER || "openai",
  queryAgentBin: "codex",
  queryAgentModel: "",
  queryAgentCache: "bench/generated/qmd-query-agent-cache.json",
  queryAgentFallback: true,
  queryAgentTimeoutMs: 120_000,
  relationJudgeMode: "agent",
  relationJudgeAgentProvider: process.env.AHA_BENCH_RELATION_JUDGE_AGENT_PROVIDER
    || process.env.AHA_BENCH_RERANK_AGENT_PROVIDER
    || process.env.AHA_BENCH_LLM_PROVIDER
    || "openai",
  relationJudgeAgentBin: "codex",
  relationJudgeAgentModel: "",
  relationJudgeAgentCache: "bench/generated/relation-judge-cache.json",
  relationJudgeAgentFallback: true,
  relationJudgeAgentTimeoutMs: 300_000,
  includeDraft: false,
  only: [],
  backlinks: true,
  queryMode: "multi",
  seedStrategy: "fair",
  sourceNoteFilter: true,
  profile: "diagnostic-enhanced",
  runtimeQmdRunner: "sdk",
  runtimeQmdSdkModule: "",
  runtimeQmdRerank: false,
  runtimeCodexCommand: "codex",
  runtimeCodexModel: "gpt-5.3-codex-spark",
  runtimeCodexReasoningEffort: "low",
  runtimeCodexSandbox: "danger-full-access",
  runtimeTimeoutMs: 900_000,
  compareReport: "",
  suite: "all",
  noArchive: false,
};

function usage() {
  return [
    "Usage:",
    "  node scripts/bench/run-pipeline-bench.mjs [options]",
    "",
    "Options:",
    "  --cases <path>                 Default: bench/aha-memory-cases.json",
    "  --report <path>                Default: bench/reports/latest/pipeline.json",
    "  --profile <diagnostic-enhanced|product-parity> Default: diagnostic-enhanced",
    "  --suite <development|holdout|all> Default: all",
    "  --compare-report <path>        Compatible prior report used for Stability@K",
    "  --no-archive                   Skip the legacy timestamped archive copy",
    "  --index <name>                 Default: obsidian",
    "  --collection <name>            Default: cases file collection",
    "  --qmd <bin>                    Default: qmd",
    "  --obsidian <bin>               Default: obsidian",
    "  --limit <n>                    Final candidate limit, default 20",
    "  --seed-limit <n>               QMD seeds used for backlinks, default 10",
    "  --backlinks-per-seed <n>       Default 5",
    "  --backlink-limit <n>           Default 20",
    "  --qmd-timeout-ms <n>           Default: 90000",
    "  --obsidian-timeout-ms <n>      Default: 8000",
    "  --llm-provider <openai|codex-cli> Default: openai",
    "  --llm-base-url <url>           Default: https://api.openai.com/v1",
    "  --llm-model <model>            Default: gpt-5.5",
    "  --llm-api-key-env <name>       Default: OPENAI_API_KEY",
    "  --query-generator <agent|rules> Default: agent",
    "  --query-agent-provider <openai|codex-cli> Default: --llm-provider",
    "  --query-agent-bin <bin>         Default: codex",
    "  --query-agent-model <model>     Overrides --llm-model for query generation",
    "  --query-agent-cache <path>      Default: bench/generated/qmd-query-agent-cache.json",
    "  --query-agent-timeout-ms <n>    Default: 120000",
    "  --no-query-agent-cache",
    "  --no-query-agent-fallback",
    "  --relation-judge <agent|none>   Default: agent (--reranker kept as deprecated alias)",
    "  --relation-judge-agent-provider <openai|codex-cli> Default: --llm-provider",
    "  --relation-judge-agent-bin <bin>        Default: codex",
    "  --relation-judge-agent-model <model>    Overrides --llm-model for relation judging",
    "  --relation-judge-agent-cache <path>     Default: bench/generated/relation-judge-cache.json",
    "  --relation-judge-agent-timeout-ms <n>   Default: 300000",
    "  --no-relation-judge-agent-cache",
    "  --no-relation-judge-agent-fallback",
    "  (--rerank-agent-* flags remain as deprecated aliases)",
    "  --only <id[,id...]>            Run only the listed case ids (fast iteration)",
    "  --include-draft                Include draft cases",
    "  --no-backlinks                 Disable Obsidian backlink expansion",
    "  --query-mode <multi|raw-only>   Default: multi",
    "  --seed-strategy <fair|first>    Backlink seed strategy, default fair",
    "  --no-source-note-filter        Keep source note self-hits in scoring",
    "  --runtime-qmd-runner <sdk|cli>  Product parity only; default: sdk (plugin default)",
    "  --runtime-qmd-sdk-module <path> Product parity only; optional QMD SDK module",
    "  --runtime-qmd-rerank            Product parity only; enable wrapper QMD reranking",
    "  --runtime-codex-command <bin>   Product parity only; default: codex",
    "  --runtime-codex-model <model>   Product parity only; default: gpt-5.3-codex-spark",
    "  --runtime-codex-reasoning-effort <value> Product parity only; default: low",
    "  --runtime-codex-sandbox <mode>  Product parity only; default: danger-full-access",
    "  --runtime-timeout-ms <n>        Product parity wrapper timeout, default: 900000",
  ].join("\n");
}

function parseArgs() {
  const options = { ...DEFAULTS };
  const args = process.argv.slice(2);

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--only") {
      options.only = [
        ...options.only,
        ...String(args[index + 1] ?? "").split(",").map((value) => value.trim()).filter(Boolean),
      ];
      index += 1;
      continue;
    }
    if (arg === "--include-draft") {
      options.includeDraft = true;
      continue;
    }
    if (arg === "--no-backlinks") {
      options.backlinks = false;
      continue;
    }
    if (arg === "--no-source-note-filter") {
      options.sourceNoteFilter = false;
      continue;
    }
    if (arg === "--runtime-qmd-rerank") {
      options.runtimeQmdRerank = true;
      continue;
    }
    if (arg === "--no-archive") {
      options.noArchive = true;
      continue;
    }
    if (arg === "--no-query-agent-cache") {
      options.queryAgentCache = "";
      continue;
    }
    if (arg === "--no-query-agent-fallback") {
      options.queryAgentFallback = false;
      continue;
    }
    if (arg === "--no-relation-judge-agent-cache" || arg === "--no-rerank-agent-cache") {
      options.relationJudgeAgentCache = "";
      continue;
    }
    if (arg === "--no-relation-judge-agent-fallback" || arg === "--no-rerank-agent-fallback") {
      options.relationJudgeAgentFallback = false;
      continue;
    }
    if (!arg.startsWith("--")) {
      console.error(usage());
      process.exit(1);
    }

    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      console.error(usage());
      process.exit(1);
    }
    index += 1;

    switch (arg) {
      case "--cases":
        options.cases = value;
        break;
      case "--report":
        options.report = value;
        break;
      case "--profile":
        options.profile = value;
        break;
      case "--suite":
        options.suite = value;
        break;
      case "--compare-report":
        options.compareReport = value;
        break;
      case "--index":
        options.index = value;
        break;
      case "--collection":
        options.collection = value;
        break;
      case "--qmd":
        options.qmd = value;
        break;
      case "--obsidian":
        options.obsidian = value;
        break;
      case "--limit":
        options.limit = Number(value);
        break;
      case "--seed-limit":
        options.seedLimit = Number(value);
        break;
      case "--backlinks-per-seed":
        options.backlinksPerSeed = Number(value);
        break;
      case "--backlink-limit":
        options.backlinkLimit = Number(value);
        break;
      case "--qmd-timeout-ms":
        options.qmdTimeoutMs = Number(value);
        break;
      case "--obsidian-timeout-ms":
        options.obsidianTimeoutMs = Number(value);
        break;
      case "--llm-provider":
        options.llmProvider = value;
        if (!options.queryAgentProviderExplicit) options.queryAgentProvider = value;
        if (!options.relationJudgeAgentProviderExplicit) options.relationJudgeAgentProvider = value;
        break;
      case "--llm-base-url":
        options.llmBaseUrl = value;
        break;
      case "--llm-model":
        options.llmModel = value;
        break;
      case "--llm-api-key-env":
        options.llmApiKeyEnv = value;
        break;
      case "--query-generator":
        options.queryGenerator = value;
        break;
      case "--query-mode":
        options.queryMode = value;
        break;
      case "--query-agent-bin":
        options.queryAgentBin = value;
        break;
      case "--query-agent-provider":
        options.queryAgentProvider = value;
        options.queryAgentProviderExplicit = true;
        break;
      case "--query-agent-model":
        options.queryAgentModel = value;
        break;
      case "--query-agent-cache":
        options.queryAgentCache = value;
        break;
      case "--query-agent-timeout-ms":
        options.queryAgentTimeoutMs = Number(value);
        break;
      case "--relation-judge":
      case "--reranker":
        options.relationJudgeMode = value;
        break;
      case "--relation-judge-agent-provider":
      case "--rerank-agent-provider":
        options.relationJudgeAgentProvider = value;
        options.relationJudgeAgentProviderExplicit = true;
        break;
      case "--relation-judge-agent-bin":
      case "--rerank-agent-bin":
        options.relationJudgeAgentBin = value;
        break;
      case "--relation-judge-agent-model":
      case "--rerank-agent-model":
        options.relationJudgeAgentModel = value;
        break;
      case "--relation-judge-agent-cache":
      case "--rerank-agent-cache":
        options.relationJudgeAgentCache = value;
        break;
      case "--relation-judge-agent-timeout-ms":
      case "--rerank-agent-timeout-ms":
        options.relationJudgeAgentTimeoutMs = Number(value);
        break;
      case "--seed-strategy":
        options.seedStrategy = value;
        break;
      case "--runtime-qmd-runner":
        options.runtimeQmdRunner = value;
        break;
      case "--runtime-qmd-sdk-module":
        options.runtimeQmdSdkModule = value;
        break;
      case "--runtime-codex-model":
        options.runtimeCodexModel = value;
        break;
      case "--runtime-codex-command":
        options.runtimeCodexCommand = value;
        break;
      case "--runtime-codex-reasoning-effort":
        options.runtimeCodexReasoningEffort = value;
        break;
      case "--runtime-codex-sandbox":
        options.runtimeCodexSandbox = value;
        break;
      case "--runtime-timeout-ms":
        options.runtimeTimeoutMs = Number(value);
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }

  for (const key of ["limit", "seedLimit", "backlinksPerSeed", "backlinkLimit", "qmdTimeoutMs", "obsidianTimeoutMs", "queryAgentTimeoutMs", "relationJudgeAgentTimeoutMs", "runtimeTimeoutMs"]) {
    if (!Number.isFinite(options[key]) || options[key] < 1) {
      throw new Error(`${key} must be a positive number.`);
    }
  }
  if (!["multi", "raw-only"].includes(options.queryMode)) {
    throw new Error("queryMode must be multi or raw-only.");
  }
  if (!["fair", "first"].includes(options.seedStrategy)) {
    throw new Error("seedStrategy must be fair or first.");
  }
  if (!["diagnostic-enhanced", "product-parity"].includes(options.profile)) {
    throw new Error("profile must be diagnostic-enhanced or product-parity.");
  }
  if (!["development", "holdout", "all"].includes(options.suite)) {
    throw new Error("suite must be development, holdout, or all.");
  }
  if (!["sdk", "cli"].includes(options.runtimeQmdRunner)) {
    throw new Error("runtimeQmdRunner must be sdk or cli.");
  }
  for (const [key, value] of [
    ["llmProvider", options.llmProvider],
    ["queryAgentProvider", options.queryAgentProvider],
    ["relationJudgeAgentProvider", options.relationJudgeAgentProvider],
  ]) {
    if (!["openai", "codex", "codex-cli"].includes(String(value || "").toLowerCase())) {
      throw new Error(`${key} must be openai or codex-cli.`);
    }
  }
  delete options.queryAgentProviderExplicit;
  delete options.relationJudgeAgentProviderExplicit;
  return options;
}

function qmdEnv() {
  return {
    ...process.env,
    QMD_REMOTE_EMBED_URL:
      process.env.QMD_REMOTE_EMBED_URL?.trim() ||
      "http://127.0.0.1:18081/v1/embeddings",
    QMD_REMOTE_EMBED_MODEL:
      process.env.QMD_REMOTE_EMBED_MODEL?.trim() ||
      "Qwen3-Embedding-8B",
    QMD_REMOTE_GENERATE_URL:
      process.env.QMD_REMOTE_GENERATE_URL?.trim() ||
      "http://127.0.0.1:18082/completion",
    QMD_REMOTE_GENERATE_MODEL:
      process.env.QMD_REMOTE_GENERATE_MODEL?.trim() ||
      "qmd-query-expansion-1.7B",
    QMD_REMOTE_RERANK_URL:
      process.env.QMD_REMOTE_RERANK_URL?.trim() ||
      "http://127.0.0.1:18083/v1/rerank",
    QMD_REMOTE_RERANK_MODEL:
      process.env.QMD_REMOTE_RERANK_MODEL?.trim() ||
      "Qwen3-Reranker-0.6B",
  };
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? resolve("."),
    encoding: "utf-8",
    timeout: options.timeoutMs,
    env: options.env ?? process.env,
    maxBuffer: options.maxBuffer ?? 16 * 1024 * 1024,
  });
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    code: result.status,
    error: result.error?.message,
    timedOut: result.signal === "SIGTERM" || result.error?.code === "ETIMEDOUT",
  };
}

function fileLabel(path) {
  const value = String(path ?? "").trim();
  if (!value) return undefined;
  return basename(value).replace(/\.md$/i, "") || value;
}

function stripPathDecorations(path) {
  return String(path ?? "")
    .trim()
    .replace(/[?#].*$/, "")
    .replace(/\\/g, "/");
}

function qmdUriPath(path) {
  const value = stripPathDecorations(path);
  if (!value.startsWith("qmd://")) return "";
  const withoutScheme = value.slice("qmd://".length);
  const slashIndex = withoutScheme.indexOf("/");
  return slashIndex >= 0 ? withoutScheme.slice(slashIndex + 1) : withoutScheme;
}

function vaultRoot() {
  return resolve(benchVaultRoot());
}

function buildVaultResolver() {
  return sharedBuildVaultPathResolver(vaultRoot());
}

function candidateVaultRelativePath(path, resolver) {
  const resolved = sharedResolveVaultPath(path, resolver);
  if (resolved.status === "resolved") return resolved.path;
  if (resolved.status === "ambiguous") {
    throw new Error(`Ambiguous benchmark candidate path: ${path} -> ${resolved.matches.join(", ")}`);
  }
  return "";
}

function uniqueArgSets(argSets) {
  const seen = new Set();
  const unique = [];
  for (const args of argSets) {
    const key = args.join("\u0000");
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(args);
  }
  return unique;
}

function parseQmdCandidates(output, queryText) {
  const trimmed = output.trim();
  if (!trimmed) return [];
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return [];
  }

  return collectResultItems(parsed)
    .map((item, index) => {
      const record = item && typeof item === "object" ? item : {};
      const file = pickFirstString(record, ["file", "path", "slug", "id", "page"]);
      const title =
        pickFirstString(record, ["title", "name", "basename", "slug", "path", "file"]) ||
        fileLabel(file) ||
        `QMD result ${index + 1}`;
      const content =
        pickFirstString(record, ["snippet", "content", "text", "chunk_text", "summary", "body"]) ||
        textFromUnknown(item).slice(0, 500);

      return {
        id: file || title,
        title,
        file,
        content,
        rank: index + 1,
        queryText,
        source: "qmd",
      };
    })
    .filter((candidate) => candidate.title.trim());
}

function parseBacklinksOutput(output, seed) {
  const trimmed = output.trim();
  if (!trimmed || /^Error:\s+/i.test(trimmed)) return [];

  try {
    const parsed = JSON.parse(trimmed);
    return collectResultItems(parsed)
      .map((item) => {
        const record = item && typeof item === "object" ? item : {};
        const path = pickFirstString(record, ["path", "file", "sourcePath", "linkpath"]);
        const title =
          pickFirstString(record, ["title", "name", "basename", "file", "path", "source"]) ||
          path ||
          textFromUnknown(item);
        const countValue = record.count ?? record.linkCount ?? record.occurrences;
        return {
          title,
          path,
          count: typeof countValue === "number" ? countValue : undefined,
          sourceCandidateId: seed.id,
          sourceTitle: seed.title,
        };
      })
      .filter((item) => item.title.trim());
  } catch {
    return trimmed
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((line) => !line.includes("FATAL:electron/"))
      .filter((line) => !/^Error:\s+/i.test(line))
      .map((line) => {
        const parts = line.split(/\t|,/).map((part) => part.trim()).filter(Boolean);
        const path = parts.find((part) => part.endsWith(".md") || part.includes("/"));
        const title = path || parts[0] || line;
        const count = Number(parts.find((part) => /^\d+$/.test(part)));
        return {
          title,
          path,
          count: Number.isFinite(count) ? count : undefined,
          sourceCandidateId: seed.id,
          sourceTitle: seed.title,
        };
      })
      .filter((item) => item.title && !/^file\b|^path\b/i.test(item.title));
  }
}

function _tokenizeForRelevance(text) {
  const tokens = new Set();
  const normalized = String(text ?? "").toLowerCase();
  for (const token of normalized.match(/[a-z0-9][a-z0-9_-]{2,}/g) ?? []) {
    tokens.add(token);
  }
  for (const sequence of normalized.match(/[\p{Script=Han}]{2,}/gu) ?? []) {
    tokens.add(sequence);
    for (const size of [2, 3, 4]) {
      for (let index = 0; index <= sequence.length - size; index += 1) {
        tokens.add(sequence.slice(index, index + size));
      }
    }
  }
  return tokens;
}

function _isBacklinkRelevant(backlink, caseItem, queryText) {
  const haystack = `${backlink.title}\n${backlink.path ?? ""}\n${backlink.content ?? ""}`;
  const candidateTokens = _tokenizeForRelevance(haystack);
  if (candidateTokens.size === 0) return false;

  const queryTokens = _tokenizeForRelevance([
    caseItem._resolved_insight_input,
    queryText,
  ].join("\n"));
  let overlap = 0;
  for (const token of queryTokens) {
    if (candidateTokens.has(token)) overlap += 1;
  }
  return overlap >= 1;
}

function _readObsidianNote(backlink, options) {
  const args = backlink.path
    ? ["read", `path=${backlink.path}`]
    : ["read", `file=${backlink.title}`];
  const result = run(options.obsidian, args, { timeoutMs: options.obsidianTimeoutMs });
  if (result.code !== 0 || result.error || result.timedOut) return "";
  const output = result.stdout.trim();
  if (!output || /^Error:\s+/i.test(output)) return "";
  return output;
}

function parseSourceLinkPaths(output) {
  const trimmed = output.trim();
  if (!trimmed || /^Error:\s+/i.test(trimmed)) return [];
  try {
    const parsed = JSON.parse(trimmed);
    return collectResultItems(parsed)
      .map((item) => pickFirstString(item && typeof item === "object" ? item : {}, ["path", "file", "linkpath"]))
      .filter(Boolean);
  } catch {
    return trimmed
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !/^\[\d+\//.test(line));
  }
}

function diagnosticGraphAdapters(caseItem, options, resolver) {
  const sourcePath = sourceNotePathForCase(caseItem);
  const command = (name) => async ({ path: originPath, limit }) => {
    const relativePath = candidateVaultRelativePath(originPath, resolver) || originPath;
    const args = name === "backlinks"
      ? [name, `path=${relativePath}`, "format=json"]
      : [name, `path=${relativePath}`];
    const result = run(options.obsidian, args, { timeoutMs: options.obsidianTimeoutMs });
    if (result.error || result.timedOut || result.code !== 0) {
      throw new Error(result.error || (result.timedOut ? "obsidian graph command timed out" : `obsidian ${name} exited ${result.code}`));
    }
    const paths = name === "backlinks"
      ? parseBacklinksOutput(result.stdout, { file: relativePath, title: basename(relativePath, ".md") })
        .map((candidate) => candidate.path)
      : parseSourceLinkPaths(result.stdout);
    return paths.filter(Boolean).slice(0, limit).map((file) => ({
      id: file,
      title: basename(file, ".md"),
      file,
      source: name === "backlinks" ? "backlink" : "source_link",
      expansionFrom: relativePath,
    }));
  };
  return {
    links: command("links"),
    backlinks: command("backlinks"),
    admitCandidate: (candidate) => {
      const resolved = sharedResolveVaultPath(candidatePath(candidate), resolver);
      if (resolved.status !== "resolved") return null;
      if (sourcePath && pathsMatch(resolved.path, sourcePath, { resolver })) return null;
      if (isExcludedCandidatePath(resolved.path)) return null;
      return enrichCandidateBodies([{ ...candidate, file: resolved.path }], resolver)[0];
    },
    canonicalIdentity: (candidate) => candidatePath(candidate).toLowerCase(),
  };
}

function _backlinkArgSets(seed, resolver) {
  const argSets = [];
  const relativePath = candidateVaultRelativePath(seed.file, resolver);
  if (relativePath) {
    argSets.push(["backlinks", `path=${relativePath}`, "format=json"]);
    argSets.push(["backlinks", `file=${basename(relativePath, ".md")}`, "format=json"]);
  }

  const fileLabelTarget = fileLabel(stripPathDecorations(qmdUriPath(seed.file) || seed.file));
  if (fileLabelTarget) argSets.push(["backlinks", `file=${fileLabelTarget}`, "format=json"]);
  if (seed.title) argSets.push(["backlinks", `file=${seed.title}`, "format=json"]);

  return uniqueArgSets(argSets);
}

function selectQuerySpecs(querySpecs, options) {
  if (options.queryMode === "multi") return querySpecs;
  const rawQuery = querySpecs.find((query) => query.kind === "raw");
  return [rawQuery ?? querySpecs[0]].filter(Boolean);
}

function _seedGroup(candidate) {
  return candidate.queryKind || candidate.queryCommand || candidate.source || "unknown";
}

function mergeCandidates(candidates, limit) {
  const seen = new Set();
  const merged = [];
  for (const candidate of candidates) {
    const key = candidatePath(candidate);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    merged.push(candidate);
    if (merged.length >= limit) break;
  }
  return merged;
}

function completeDiagnosticJudgedSet(judgedCandidates, reviewInputs) {
  const reviewedIds = new Set((judgedCandidates ?? []).map(candidatePath));
  return [
    ...(judgedCandidates ?? []),
    ...(reviewInputs ?? []).filter((candidate) => !reviewedIds.has(candidatePath(candidate))),
  ];
}

function dropExcludedCandidates(candidates) {
  return (candidates ?? []).filter((candidate) => !isExcludedCandidatePath(candidatePath(candidate)));
}

function enrichCandidateBodies(candidates, resolver) {
  return (candidates ?? []).map((candidate) => {
    const resolved = sharedResolveVaultPath(candidatePath(candidate), resolver);
    if (resolved.status !== "resolved") return candidate;
    // Canonicalize to the vault-relative real path so duplicate path forms
    // (qmd URI / absolute / relative) merge into one pool entry.
    const canonical = { ...candidate, file: resolved.path, raw_file: candidate.file };
    try {
      const body = excerptNoteMarkdown(readFileSync(resolve(resolver.root, resolved.path), "utf-8"));
      if (!body) return canonical;
      return { ...canonical, content: body, excerpt_source: "note_body" };
    } catch {
      return canonical;
    }
  });
}

function mergeCandidateEvidence(candidates) {
  const byKey = new Map();
  const merged = [];
  for (const candidate of candidates) {
    const key = candidatePath(candidate);
    if (!key) continue;
    const normalizedKey = key.toLowerCase();
    const existing = byKey.get(normalizedKey);
    if (!existing) {
      const next = {
        ...candidate,
        sources: sourceList(candidate),
        expansionSources: candidate.expansionFrom ? [candidate.expansionFrom] : [],
      };
      byKey.set(normalizedKey, next);
      merged.push(next);
      continue;
    }

    existing.sources = Array.from(new Set([...sourceList(existing), ...sourceList(candidate)]));
    if (!existing.content && candidate.content) existing.content = candidate.content;
    if (candidate.expansionFrom) {
      existing.expansionSources = Array.from(new Set([
        ...(existing.expansionSources ?? []),
        candidate.expansionFrom,
      ]));
      existing.expansionFrom = existing.expansionSources.join("; ");
    }
  }
  return merged;
}

function candidateFiles(candidates) {
  return candidates.map(candidatePath).filter(Boolean);
}

function sourceForExpected(expected, candidates, resolver) {
  const match = candidates.find((candidate) => pathsMatch(candidatePath(candidate), expected, { resolver }));
  return match ? sourceLabel(match) : "missing";
}

function isGraphOnlySource(source) {
  const tokens = String(source ?? "").split("+").map((value) => value.trim().toLowerCase()).filter(Boolean);
  const hasGraph = tokens.some((value) => ["obsidian_graph", "source_link", "source_backlink", "outlink", "backlink"].includes(value));
  const hasDirectRetrieval = tokens.some((value) => value.startsWith("qmd"));
  return hasGraph && !hasDirectRetrieval;
}

function modeEvaluationForCase(caseItem, mustSources) {
  if (caseItem.identity_evaluation?.status !== "ready") {
    return { status: "not_scored", reason: "identity_validation" };
  }
  if (caseItem.suite_evaluation?.status !== "ready") {
    return { status: "not_scored", reason: "suite_validation" };
  }
  if (
    caseItem.evaluation_mode === "discovery"
    && (mustSources ?? []).some((item) => item.rank !== null && isGraphOnlySource(item.source))
  ) {
    return { status: "not_scored", reason: "graph_evidence_contradiction" };
  }
  return { status: "scored" };
}

function qmdSourceForCommand(command) {
  if (command === "qmd search") return "qmd_search";
  if (command === "qmd vsearch") return "qmd_vsearch";
  return "qmd_query";
}

function runQmdQuery(querySpec, collection, options) {
  const command = querySpec.command || "qmd query";
  const subcommand =
    command === "qmd search" ? "search" :
    command === "qmd vsearch" ? "vsearch" :
    "query";
  const queryText = querySpec.query || querySpec.text || "";
  const args = [
    "--index",
    options.index,
    subcommand,
    queryText,
    "-c",
    collection,
    "-n",
    String(options.limit),
    "--full-path",
    "--line-numbers",
    "--format",
    "json",
  ];
  return run(options.qmd, args, {
    timeoutMs: options.qmdTimeoutMs,
    env: qmdEnv(),
  });
}

function runQmdQueries(querySpecs, collection, options) {
  return querySpecs.map((querySpec, index) => {
    const result = runQmdQuery(querySpec, collection, options);
    const queryText = querySpec.query || querySpec.text || "";
    const candidates = parseQmdCandidates(result.stdout, queryText).map((candidate) => ({
      ...candidate,
      source: qmdSourceForCommand(querySpec.command),
      queryKind: querySpec.kind,
      queryCommand: querySpec.command,
    }));
    const errors = [
      result.error,
      result.timedOut ? `${querySpec.kind}: qmd query timed out` : "",
      result.code !== 0
        ? `${querySpec.kind}: ${result.stderr.trim() || `qmd query exited with ${result.code}`}`
        : "",
    ].filter(Boolean);
    return {
      index: index + 1,
      kind: querySpec.kind,
      command: querySpec.command,
      query: queryText,
      qmd: querySpec.qmd,
      candidates,
      errors,
    };
  });
}

function fixed(value) {
  return Number(value || 0).toFixed(3);
}

function stabilityDisplay(stability) {
  return stability?.status === "measured" && typeof stability.score === "number"
    ? fixed(stability.score)
    : `not measured (${stability?.reason || "no_comparison_report"})`;
}

function printSummary(report) {
  console.log("# Aha Memory Pipeline Bench Summary");
  console.log("");
  console.log(`Report: ${report.report}`);
  console.log(`Profile: ${report.profile}`);
  console.log(`Cases: ${report.summary.cases}`);
  console.log(`Query mode: ${report.query_mode}`);
  console.log(`Backlinks: ${report.profile === "product-parity" ? "runtime source graph" : report.backlinks_enabled ? "enabled" : "disabled"}`);
  console.log(`Seed strategy: ${report.seed_strategy ?? "runtime"}`);
  console.log(`Source-note filter: ${report.source_note_filter_enabled ? "enabled" : "disabled"}`);
  console.log(`Relation judge: ${report.relation_judge_mode}`);
  console.log("");

  if (report.results.length === 0) {
    console.log("No active cases found. Add active cases to bench/aha-memory-cases.json first.");
    return;
  }

  console.log("| Case | Must K | Must Recall@K | Useful Precision@K | nDCG@K | Negative Rate@K | Expanded Pool Recall@20 | Dropped Must Count | Stability@K | Missing |");
  console.log("|---|---:|---:|---:|---:|---:|---:|---:|---:|---|");
  for (const result of report.results) {
    const missing = result.pipeline.score.unmatched_expected_files.join("<br>") || "-";
    const topK = result.pipeline.score.top_k || result.qmd.score.top_k || "K";
    const evalV2 = result.pipeline.eval_v2 ?? {};
    const expandedRecall = result.expanded_pool?.recall_at_20 ?? result.expanded_pool?.score_at_20?.recall_at_k ?? result.expanded_pool?.score?.recall;
    const droppedMustCount = result.expanded_pool?.dropped_must_count ?? result.expanded_pool?.dropped_from_final_top_k?.length ?? 0;
    console.log(`| ${result.id} | ${topK} | ${fixed(evalV2.must_recall_at_k)} | ${fixed(evalV2.useful_precision_at_k)} | ${fixed(evalV2.ndcg_at_k)} | ${fixed(evalV2.negative_rate_at_k)} | ${fixed(expandedRecall)} | ${droppedMustCount} | ${stabilityDisplay(result.pipeline.stability)} | ${missing} |`);
  }

  console.log("");
  console.log("| Summary | Value |");
  console.log("|---|---:|");
  console.log(`| avg QMD R@K | ${fixed(report.summary.avg_qmd_recall_at_k)} |`);
  console.log(`| avg pipeline R@K | ${fixed(report.summary.avg_pipeline_recall_at_k)} |`);
  console.log(`| avg Must Recall@10 | ${fixed(report.summary.eval_v2?.avg_must_recall_at_k)} |`);
  console.log(`| avg Useful Precision@10 | ${fixed(report.summary.eval_v2?.avg_useful_precision_at_k)} |`);
  console.log(`| avg nDCG@10 | ${fixed(report.summary.eval_v2?.avg_ndcg_at_k)} |`);
  console.log(`| avg Negative Rate@10 | ${fixed(report.summary.eval_v2?.avg_negative_rate_at_k)} |`);
  console.log(`| avg pipeline nice-to-have R@20 | ${report.summary.avg_pipeline_nice_to_have_recall_at_k === null ? "-" : fixed(report.summary.avg_pipeline_nice_to_have_recall_at_k)} |`);
  console.log(`| avg worst must-rank | ${fixed(report.summary.avg_worst_must_rank, 1)} |`);
  console.log(`| avg Expanded Pool Recall@20 | ${fixed(report.summary.avg_expanded_pool_recall_at_20 ?? report.summary.avg_expanded_pool_recall)} |`);
  console.log(`| Dropped Must Count | ${report.summary.dropped_must_count ?? report.summary.expanded_pool_dropped_topk_count} |`);
  console.log(`| avg Stability@10 | ${stabilityDisplay(report.summary.stability)} |`);
  console.log(`| Unattributed failures | ${report.summary.unattributed_failure_count ?? 0} |`);
  for (const [group, count] of Object.entries(report.summary.failure_attribution_counts ?? {})) {
    console.log(`| Failure Attribution: ${group} | ${count} |`);
  }
  for (const [group, count] of Object.entries(report.summary.trace_diagnosis_counts ?? {})) {
    console.log(`| Trace Diagnosis: ${group} | ${count} |`);
  }
  console.log(`| QMD direct must-recall matches | ${report.summary.qmd_direct_matches} |`);
  console.log(`| backlink must-recall matches | ${report.summary.backlink_matches} |`);
  console.log(`| missing must-recall matches | ${report.summary.missing_matches} |`);
  console.log(`| expanded pool hits dropped from top-K | ${report.summary.expanded_pool_dropped_topk_count} |`);
  console.log(`| fallbacks | ${report.diagnostics.fallback_count} |`);
  console.log(`| timeouts | ${report.diagnostics.timeout_count} |`);
}

function timestampForPath() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function safePathIdentifier(pathValue) {
  const value = String(pathValue ?? "").trim();
  if (!value) return null;
  const absolutePath = resolve(value);
  for (const base of [WORKSPACE_ROOT, resolve(".")]) {
    const relativePath = relative(base, absolutePath).replace(/\\/g, "/");
    if (relativePath === "") return ".";
    if (relativePath !== ".." && !relativePath.startsWith("../")) return relativePath;
  }
  return `sha256:${sha256(absolutePath)}`;
}

function fileContentIdentity(pathValue) {
  const value = String(pathValue ?? "").trim();
  if (!value) return null;
  try {
    return `sha256:${sha256(readFileSync(resolve(value)))}`;
  } catch {
    return `sha256:${sha256(`unreadable:${resolve(value)}`)}`;
  }
}

function privateValueIdentity(value) {
  const normalized = String(value ?? "").trim();
  return normalized ? `sha256:${sha256(normalized)}` : null;
}

function qmdRemoteServices() {
  const service = (urlKey, modelKey) => ({
    endpoint_identity: privateValueIdentity(process.env[urlKey]),
    model: process.env[modelKey]?.trim() || null,
  });
  return {
    embed: service("QMD_REMOTE_EMBED_URL", "QMD_REMOTE_EMBED_MODEL"),
    generate: service("QMD_REMOTE_GENERATE_URL", "QMD_REMOTE_GENERATE_MODEL"),
    rerank: service("QMD_REMOTE_RERANK_URL", "QMD_REMOTE_RERANK_MODEL"),
  };
}

function archiveReportPath(reportPath) {
  const rawName = basename(reportPath, ".json");
  const prefix =
    rawName === "pipeline" || rawName === "pipeline-rerank-none"
      ? rawName
      : `pipeline-${rawName}`;
  return resolve("bench/reports/archive", `${prefix}-${timestampForPath()}.json`);
}

function vaultSnapshotMetadata(root = vaultRoot()) {
  const hash = createHash("sha256");
  let markdownFileCount = 0;

  function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const fullPath = resolve(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
        continue;
      }
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".md")) continue;
      const relativePath = relative(root, fullPath).replace(/\\/g, "/");
      const stat = statSync(fullPath);
      markdownFileCount += 1;
      hash.update(relativePath);
      hash.update("\0");
      hash.update(String(stat.size));
      hash.update("\0");
      hash.update(String(Math.floor(stat.mtimeMs)));
      hash.update("\0");
    }
  }

  try {
    walk(root);
    return {
      markdown_file_count: markdownFileCount,
      hash: hash.digest("hex"),
    };
  } catch (error) {
    return {
      markdown_file_count: markdownFileCount,
      hash: null,
      error: error?.code || error?.name || "snapshot_failed",
    };
  }
}

function commandOutput(command, args) {
  const result = spawnSync(command, args, {
    cwd: WORKSPACE_ROOT,
    encoding: "utf-8",
    timeout: 10_000,
  });
  if (result.error || result.status !== 0) return "";
  return String(result.stdout || result.stderr || "").trim().split(/\r?\n/)[0] ?? "";
}

function runtimeTargetCandidateLimit(value) {
  return Math.min(20, Math.max(15, Number(value) || 20));
}

function effectiveConfiguration(options, collection) {
  if (options.profile === "product-parity") {
    const runtimeFinal = runtimeTargetCandidateLimit(options.limit);
    return {
      profile: options.profile,
      index: options.index,
      collection: collection || null,
      source_note_filter: options.sourceNoteFilter,
      llm: {
        provider: options.llmProvider,
        model: options.llmModel,
        endpoint_identity: privateValueIdentity(options.llmBaseUrl),
      },
      runtime_codex: {
        command: basename(options.runtimeCodexCommand),
        version: commandOutput(options.runtimeCodexCommand, ["--version"]) || null,
        model: options.runtimeCodexModel,
        reasoning_effort: options.runtimeCodexReasoningEffort,
        sandbox: options.runtimeCodexSandbox,
      },
      qmd: {
        runner: options.runtimeQmdRunner,
        command: basename(options.qmd),
        version: commandOutput(options.qmd, ["--version"]) || null,
        rerank: options.runtimeQmdRerank,
        sdk_module_identity: options.runtimeQmdRunner === "sdk"
          ? fileContentIdentity(options.runtimeQmdSdkModule) || "builtin:qmd-sdk"
          : null,
        remote_services: qmdRemoteServices(),
      },
      obsidian: {
        command: basename(options.obsidian),
        version: commandOutput(options.obsidian, ["--version"]) || null,
      },
      prompt_versions: {
        query_plan: QUERY_PLAN_PROMPT_VERSION,
        relation_judge: RELATION_JUDGE_PROMPT_VERSION,
      },
      candidate_limits: {
        requested_final: options.limit,
        runtime_final: runtimeFinal,
        qmd_pool: Math.max(runtimeFinal, 20),
        query_plan: 5,
        relation_judge: runtimeFinal,
      },
    };
  }
  return {
    profile: options.profile,
    index: options.index,
    collection: collection || null,
    candidate_limit: options.limit,
    source_note_filter: options.sourceNoteFilter,
    llm_provider: options.llmProvider,
    llm_model: options.llmModel,
    query_mode: options.profile === "diagnostic-enhanced" ? options.queryMode : "runtime",
    seed_strategy: options.profile === "diagnostic-enhanced" ? options.seedStrategy : null,
    relation_judge_mode: options.profile === "diagnostic-enhanced" ? options.relationJudgeMode : "runtime",
    runtime_qmd_runner: options.profile === "product-parity" ? options.runtimeQmdRunner : null,
    runtime_qmd_rerank: options.profile === "product-parity" ? options.runtimeQmdRerank : null,
    prompt_versions: {
      query_plan: QUERY_PLAN_PROMPT_VERSION,
      relation_judge: RELATION_JUDGE_PROMPT_VERSION,
    },
  };
}

function reportMetadata(options, collection) {
  const gitStatus = commandOutput("git", ["status", "--porcelain"]);
  const vault = vaultRoot();
  const configuration = effectiveConfiguration(options, collection);
  return {
    generated_at: new Date().toISOString(),
    profile: options.profile,
    git_commit: commandOutput("git", ["rev-parse", "HEAD"]),
    git_clean: gitStatus.length === 0,
    pipeline_version: "aha-pipeline-bench-v2",
    trace_schema: PIPELINE_TRACE_SCHEMA,
    trace_version: PIPELINE_TRACE_VERSION,
    effective_configuration: configuration,
    effective_config_id: sha256(JSON.stringify(configuration)),
    runtime_configuration: options.profile === "product-parity" ? {
      entry_point: "scripts/aha/run-insight-search.mjs",
      strategy: "pipeline",
      llm_provider: options.llmProvider,
      llm_model: options.llmModel,
      llm_api_key_env: options.llmApiKeyEnv,
      codex_command: basename(options.runtimeCodexCommand),
      codex_model: options.runtimeCodexModel,
      codex_reasoning_effort: options.runtimeCodexReasoningEffort,
      codex_sandbox: options.runtimeCodexSandbox,
      qmd_runner: options.runtimeQmdRunner,
      qmd_sdk_module_configured: Boolean(options.runtimeQmdSdkModule),
      qmd_sdk_module_identity: options.runtimeQmdRunner === "sdk"
        ? fileContentIdentity(options.runtimeQmdSdkModule) || "builtin:qmd-sdk"
        : null,
      qmd_rerank: options.runtimeQmdRerank,
      target_candidates: runtimeTargetCandidateLimit(options.limit),
    } : null,
    query_prompt_version: QUERY_PLAN_PROMPT_VERSION,
    relation_judge_prompt_version: RELATION_JUDGE_PROMPT_VERSION,
    llm_provider: options.llmProvider,
    llm_base_url: options.llmBaseUrl,
    llm_model: options.llmModel,
    llm_api_key_env: options.llmApiKeyEnv,
    query_agent_provider: options.queryAgentProvider,
    query_agent_bin: basename(options.queryAgentBin),
    query_agent_version: ["codex", "codex-cli"].includes(String(options.queryAgentProvider).toLowerCase())
      ? commandOutput(options.queryAgentBin, ["--version"])
      : null,
    query_agent_model: options.queryAgentModel || options.llmModel || null,
    query_agent_cache_enabled: Boolean(options.queryAgentCache),
    relation_judge_agent_provider: options.relationJudgeAgentProvider,
    relation_judge_agent_bin: basename(options.relationJudgeAgentBin),
    relation_judge_agent_version: ["codex", "codex-cli"].includes(String(options.relationJudgeAgentProvider).toLowerCase())
      ? commandOutput(options.relationJudgeAgentBin, ["--version"])
      : null,
    relation_judge_agent_model: options.relationJudgeAgentModel || options.llmModel || null,
    relation_judge_agent_cache_enabled: Boolean(options.relationJudgeAgentCache),
    qmd_bin: basename(options.qmd),
    qmd_version: commandOutput(options.qmd, ["--version"]),
    obsidian_bin: basename(options.obsidian),
    obsidian_version: commandOutput(options.obsidian, ["--version"]),
    vault_id: createHash("sha256").update(vault).digest("hex"),
    vault_snapshot: vaultSnapshotMetadata(vault),
    index_snapshot: {
      index: options.index,
      collection: collection || null,
      qmd_bin: basename(options.qmd),
    },
  };
}

function sourceNoteEval(files, sourceNotePath, options, resolver) {
  if (options.sourceNoteFilter) return filterSourceNoteFromResults(files, sourceNotePath, { resolver });
  return {
    files,
    source_note_rank: null,
  };
}

function countBy(results, predicate) {
  return results.reduce((count, result) => count + (predicate(result) ? 1 : 0), 0);
}

function countErrors(results, pattern) {
  let count = 0;
  for (const result of results) {
    for (const error of result.pipeline?.errors ?? []) {
      if (pattern.test(error)) count += 1;
    }
  }
  return count;
}

function reportDiagnostics(results) {
  const queryCacheHits = countBy(results, (result) => result.query_generated_by === "agent-cache");
  const queryAgentRuns = countBy(results, (result) => result.query_generated_by === "agent");
  const queryFallbacks = countBy(results, (result) => !!result.query_generation_fallback);
  const relationJudgeCacheHits = countBy(results, (result) => result.pipeline?.relation_judge_generated_by === "agent-cache");
  const relationJudgeAgentRuns = countBy(results, (result) => result.pipeline?.relation_judge_generated_by === "agent");
  const relationJudgeFallbacks = countBy(results, (result) => !!result.pipeline?.relation_judge_fallback);
  const qmdTimeouts = countErrors(results, /qmd query timed out/i);
  const obsidianTimeouts = countErrors(results, /obsidian backlinks timed out/i);
  const queryTransport = mergeOpenAiTransportStats(
    ...results.map((result) => result.openai_transport?.query_generation),
  );
  const relationTransport = mergeOpenAiTransportStats(
    ...results.map((result) => result.openai_transport?.relation_judge),
  );

  return {
    query_cache_hits: queryCacheHits,
    query_cache_misses: queryAgentRuns,
    query_fallbacks: queryFallbacks,
    relation_judge_cache_hits: relationJudgeCacheHits,
    relation_judge_cache_misses: relationJudgeAgentRuns,
    relation_judge_fallbacks: relationJudgeFallbacks,
    fallback_count: queryFallbacks + relationJudgeFallbacks,
    qmd_timeout_count: qmdTimeouts,
    obsidian_timeout_count: obsidianTimeouts,
    timeout_count: qmdTimeouts + obsidianTimeouts,
    openai_transport: {
      query_generation: queryTransport,
      relation_judge: relationTransport,
      total: mergeOpenAiTransportStats(queryTransport, relationTransport),
    },
  };
}

function reportCaseCounts(results) {
  return {
    total: results.length,
    scored: countBy(results, (result) => result.evaluation_status !== "not_scored"),
    not_scored: countBy(results, (result) => result.evaluation_status === "not_scored"),
    discovery: countBy(results, (result) => result.evaluation_mode === "discovery"),
    graph_assisted: countBy(results, (result) => result.evaluation_mode === "graph_assisted"),
  };
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function writeReportWithTraces(report, reportPath, traces) {
  const reportCopy = cloneJson(report);
  reportCopy.report = safePathIdentifier(reportPath);
  reportCopy.results.forEach((result, index) => {
    result.trace_json = safePathIdentifier(writePipelineTraceForReport(traces[index], reportPath));
  });
  mkdirSync(dirname(resolve(reportPath)), { recursive: true });
  writeFileSync(resolve(reportPath), `${JSON.stringify(reportCopy, null, 2)}\n`);
  return reportCopy;
}

function reportSuite(options, suiteVersions) {
  if (options.suite === "all") {
    return { kind: "all", versions: suiteVersions };
  }
  return {
    kind: options.suite,
    version: suiteVersions?.[options.suite] ?? null,
  };
}

function readComparisonReport(reportPath) {
  if (!reportPath) return null;
  try {
    return JSON.parse(readFileSync(resolve(reportPath), "utf-8"));
  } catch {
    return null;
  }
}

function productParitySource(caseItem, resolver) {
  const sourcePath = sourceNotePathForCase(caseItem);
  if (!sourcePath) {
    throw new Error(`${caseItem.id}: product-parity requires input.note because the shipped plugin runtime starts from a vault note.`);
  }
  const resolved = sharedResolveVaultPath(sourcePath, resolver);
  if (resolved.status !== "resolved") {
    const detail = resolved.status === "ambiguous" ? ` (${resolved.matches.join(", ")})` : "";
    throw new Error(`${caseItem.id}: product-parity source note could not be resolved inside the benchmark vault${detail}.`);
  }
  return {
    relativePath: resolved.path,
    absolutePath: resolve(resolver.root, resolved.path),
  };
}

function productParityWrapperArgs(caseItem, options, resolver) {
  const source = productParitySource(caseItem, resolver);
  const args = [
    SHIPPED_WRAPPER,
    "--workspace", WORKSPACE_ROOT,
    "--strategy", "pipeline",
    "--source-path", source.relativePath,
    "--source-absolute-path", source.absolutePath,
    "--vault-root", resolver.root,
    "--target-candidates", String(options.limit),
    "--llm-provider", options.llmProvider,
    "--llm-base-url", options.llmBaseUrl,
    "--llm-model", options.llmModel,
    "--llm-api-key-env", options.llmApiKeyEnv,
    "--codex-command", options.runtimeCodexCommand,
    "--codex-model", options.runtimeCodexModel,
    "--codex-reasoning-effort", options.runtimeCodexReasoningEffort,
    "--codex-sandbox", options.runtimeCodexSandbox,
    "--qmd-runner", options.runtimeQmdRunner,
    "--qmd-command", options.qmd,
    "--qmd-index", options.index,
    "--obsidian-command", options.obsidian,
    "--timeout-ms", String(options.runtimeTimeoutMs),
    "--trace",
  ];
  if (options.runtimeQmdSdkModule) args.push("--qmd-sdk-module", options.runtimeQmdSdkModule);
  if (options.runtimeQmdRerank) args.push("--qmd-rerank");
  return { args, source };
}

function runProductParityRuntime(caseItem, options, resolver) {
  const { args, source } = productParityWrapperArgs(caseItem, options, resolver);
  const execution = run(process.execPath, args, {
    cwd: WORKSPACE_ROOT,
    env: process.env,
    timeoutMs: options.runtimeTimeoutMs + 5_000,
  });
  if (execution.error || execution.timedOut) {
    throw new Error(`${caseItem.id}: shipped runtime failed to execute: ${execution.error || "timed out"}`);
  }
  let output;
  try {
    output = JSON.parse(execution.stdout);
  } catch (error) {
    throw new Error(`${caseItem.id}: shipped runtime returned invalid JSON: ${error.message}; ${execution.stderr.trim()}`);
  }
  if (execution.code !== 0 && output.ok !== false) {
    throw new Error(`${caseItem.id}: shipped runtime exited ${execution.code} without a structured failure result.`);
  }
  if (!output.trace || output.trace.schema !== "PipelineTrace") {
    throw new Error(`${caseItem.id}: shipped runtime did not return the required PipelineTrace.`);
  }
  const finalCandidates = Array.isArray(output.candidates) ? output.candidates : [];
  const resultFiles = candidateFiles(finalCandidates);
  const traceFiles = candidateFiles(output.trace.steps?.final_candidates ?? []);
  if (JSON.stringify(resultFiles) !== JSON.stringify(traceFiles)) {
    throw new Error(`${caseItem.id}: shipped runtime result and trace final ordering diverged.`);
  }
  return { execution, output, finalCandidates, source };
}

function traceStageCandidates(trace, stage) {
  return mergeCandidates(trace.steps?.[stage] ?? [], Number.MAX_SAFE_INTEGER);
}

function qmdTraceCandidates(trace) {
  return mergeCandidates(
    (trace.steps?.qmd_runs ?? []).flatMap((runItem) => runItem.results ?? []),
    Number.MAX_SAFE_INTEGER,
  );
}

function productTraceDiagnosis(failureAttribution) {
  const primary = failureAttribution?.primary ?? null;
  const nextTarget = {
    case_label_failure: "case_labels",
    input_representation_failure: "input_representation",
    query_failure: "query_generation",
    retrieval_failure: "retrieval",
    rerank_failure: "rerank",
    relation_failure: "relation_judge",
  }[primary] ?? (failureAttribution?.status === "unattributed" ? "trace_evidence" : "none");
  return {
    primary,
    status: failureAttribution?.status ?? "not_applicable",
    flags: failureAttribution?.flags ?? [],
    next_target: nextTarget,
    signals: [],
  };
}

function terminalRuntimeFailureAttribution(trace) {
  if (trace?.status !== "failed") return null;
  const steps = trace.steps ?? {};
  const topLevelErrors = Array.isArray(trace.errors) ? trace.errors : [];
  const topErrorsFor = (...stages) => topLevelErrors.filter((error) => stages.includes(error?.stage));
  const attributed = (primary, stage, errors) => ({
    status: "attributed",
    primary,
    evidence: {
      stage,
      source: "terminal_runtime_trace",
      error_categories: Array.from(new Set((errors ?? []).map((error) => error?.category).filter(Boolean))),
    },
    flags: [],
  });

  const relationErrors = [
    ...(steps.relation_judge?.errors ?? []),
    ...topErrorsFor("relation_judge"),
  ];
  if (steps.relation_judge?.status === "failed" || relationErrors.length > 0) {
    return attributed("relation_failure", "relation_judge", relationErrors);
  }

  const retrievalErrors = [
    ...(steps.qmd_runs ?? []).flatMap((runItem) => runItem.errors ?? []),
    ...(steps.source_expansion?.errors ?? []),
    ...topErrorsFor("qmd_retrieval", "source_expansion", "retrieval"),
  ];
  if (retrievalErrors.length > 0) {
    return attributed("retrieval_failure", "retrieval", retrievalErrors);
  }

  const queryErrors = [
    ...(steps.query_generation?.errors ?? []),
    ...topErrorsFor("query_generation"),
  ];
  if (steps.query_generation?.status === "failed" || queryErrors.length > 0) {
    return attributed("query_failure", "query_generation", queryErrors);
  }

  return null;
}

function productParityCase(caseItem, options, resolver, expectedInTopK, expectedNiceInTopK) {
  const startedAt = Date.now();
  const runtime = runProductParityRuntime(caseItem, options, resolver);
  const runtimeTrace = runtime.output.trace;
  const finalCandidates = runtime.finalCandidates;
  const qmdCandidates = qmdTraceCandidates(runtimeTrace);
  const expandedPool = traceStageCandidates(runtimeTrace, "pre_judge_candidates");
  const topK = Number(caseItem.expected_in_top_k ?? expectedInTopK);
  const niceTopK = Number(caseItem.nice_expected_in_top_k ?? expectedNiceInTopK);
  const expandedPoolTopK = Number(caseItem.expanded_pool_expected_in_top_k ?? 20);
  const sourceNotePath = runtime.source.relativePath;
  const niceToHave = caseItem.nice_to_have ?? [];
  const negative = caseItem.negative ?? [];
  const qmdEval = sourceNoteEval(candidateFiles(qmdCandidates), sourceNotePath, options, resolver);
  const pipelineEval = sourceNoteEval(candidateFiles(finalCandidates), sourceNotePath, options, resolver);
  const expandedPoolEval = sourceNoteEval(candidateFiles(expandedPool), sourceNotePath, options, resolver);
  const scoreOptions = { resolver };
  const qmdScore = scoreResults(qmdEval.files, caseItem.must_recall, topK, scoreOptions);
  const qmdNiceScore = scoreNiceToHave(qmdEval.files, niceToHave, niceTopK, scoreOptions);
  const qmdEvalV2 = scoreEvalV2(qmdEval.files, {
    topK,
    mustRecallFiles: caseItem.must_recall,
    niceToHaveFiles: niceToHave,
    negativeFiles: negative,
    resolver,
  });
  const pipelineScore = scoreResults(pipelineEval.files, caseItem.must_recall, topK, scoreOptions);
  const pipelineNiceScore = scoreNiceToHave(pipelineEval.files, niceToHave, niceTopK, scoreOptions);
  const pipelineEvalV2 = scoreEvalV2(pipelineEval.files, {
    topK,
    mustRecallFiles: caseItem.must_recall,
    niceToHaveFiles: niceToHave,
    negativeFiles: negative,
    resolver,
  });
  const expandedPoolScore = scoreResults(
    expandedPoolEval.files,
    caseItem.must_recall,
    Math.max(topK, expandedPool.length || topK),
    scoreOptions,
  );
  const expandedPoolScoreAt20 = scoreResults(expandedPoolEval.files, caseItem.must_recall, expandedPoolTopK, scoreOptions);
  const expandedPoolNiceScore = scoreNiceToHave(
    expandedPoolEval.files,
    niceToHave,
    Math.max(niceTopK, expandedPool.length || niceTopK),
    scoreOptions,
  );
  const expandedPoolEvalV2 = scoreEvalV2(expandedPoolEval.files, {
    topK: expandedPoolTopK,
    mustRecallFiles: caseItem.must_recall,
    niceToHaveFiles: niceToHave,
    negativeFiles: negative,
    resolver,
  });
  const droppedMust = droppedMustFromExpandedPool(expandedPoolScoreAt20, pipelineScore, topK);
  const queryStep = runtimeTrace.steps?.query_generation ?? {};
  const judgeStep = runtimeTrace.steps?.relation_judge ?? {};
  const queryTransport = normalizeOpenAiTransportStats(queryStep);
  const relationTransport = normalizeOpenAiTransportStats(judgeStep);
  const openAiTransport = {
    query_generation: queryTransport,
    relation_judge: relationTransport,
    total: mergeOpenAiTransportStats(queryTransport, relationTransport),
  };
  const finalTraceCandidates = runtimeTrace.steps?.final_candidates ?? [];
  const trace = {
    ...runtimeTrace,
    profile: "product-parity",
    runtime_profile: runtimeTrace.profile,
    case: {
      id: caseItem.id,
      state: caseItem.state,
      title_hash: createHash("sha256").update(caseItem.title || caseItem.id).digest("hex"),
      resolved_input_hash: createHash("sha256").update(caseItem._resolved_insight_input ?? "").digest("hex"),
    },
  };
  const failureAttribution = terminalRuntimeFailureAttribution(runtimeTrace)
    ?? failureAttributionFromTrace(caseItem, trace, {
      topK,
      judgeBudget: 20,
      resolver,
    });
  const traceDiagnosis = productTraceDiagnosis(failureAttribution);
  trace.diagnosis = traceDiagnosis;
  const qmdErrors = (runtimeTrace.steps?.qmd_runs ?? []).flatMap((runItem) => runItem.errors ?? []);
  const sourceExpansionCandidates = runtimeTrace.steps?.source_expansion?.candidates ?? [];
  const runtimeErrors = runtimeTrace.errors ?? [];
  const caseResult = {
    id: caseItem.id,
    state: caseItem.state,
    title: caseItem.title || caseItem.id,
    why: caseItem.why || undefined,
    type: caseItem.type || "real",
    suite: caseItem.suite ?? null,
    suite_version: caseItem._suite_version ?? null,
    evaluation_mode: caseItem.evaluation_mode ?? null,
    provenance_origin: caseItem.provenance?.origin ?? null,
    profile: "product-parity",
    openai_transport: openAiTransport,
    runtime_status: runtimeTrace.status,
    runtime_exit_code: runtime.execution.code,
    runtime_error: runtime.output.error ? {
      tool: runtime.output.error.tool ?? "runtime",
      message: runtime.output.error.message ?? "Aha runtime failed.",
      details_hash: sha256(runtime.output.error.details ?? runtime.output.error.message ?? "runtime failure"),
    } : null,
    runtime_input: {
      source_note: sourceNotePath,
      benchmark_line_slice_applied: false,
      benchmark_thought_applied: false,
    },
    query: null,
    queries: queryStep.queries ?? [],
    query_object: null,
    query_objects: [],
    query_generated_by: queryStep.generated_by ?? null,
    query_generation_fallback: !!queryStep.fallback,
    query_generation_error: queryStep.errors?.[0] ?? null,
    query_plan_prompt_version: queryStep.prompt_version ?? null,
    query_mode: "runtime",
    expected_files: caseItem.must_recall,
    expected_in_top_k: topK,
    nice_expected_in_top_k: niceTopK,
    expanded_pool_expected_in_top_k: expandedPoolTopK,
    source_note_path: sourceNotePath,
    nice_to_have_files: niceToHave,
    negative_files: negative,
    qmd: {
      score: qmdScore,
      nice_to_have: qmdNiceScore,
      eval_v2: qmdEvalV2,
      source_note_rank: qmdEval.source_note_rank,
      top_files: candidateFiles(qmdCandidates),
      runs: (runtimeTrace.steps?.qmd_runs ?? []).map((runItem) => ({
        kind: runItem.kind,
        command: runItem.command,
        query_hash: runItem.query_hash,
        top_files: candidateFiles(runItem.results ?? []),
        errors: runItem.errors ?? [],
      })),
      errors: qmdErrors,
    },
    pipeline: {
      score: pipelineScore,
      nice_to_have: pipelineNiceScore,
      eval_v2: pipelineEvalV2,
      source_note_rank: pipelineEval.source_note_rank,
      relation_judge_generated_by: judgeStep.generated_by ?? null,
      relation_judge_fallback: !!judgeStep.fallback,
      relation_judge_error: judgeStep.errors?.[0] ?? null,
      relation_judge_ranked_ids: (judgeStep.decisions ?? []).map((candidate) => candidate.rerank_id).filter(Boolean),
      relation_judge_prompt_version: judgeStep.prompt_version ?? null,
      relation_judge_reviewed_candidates: judgeStep.reviewed_candidates ?? [],
      top_candidates: finalCandidates.map((candidate, index) => ({
        rerankId: finalTraceCandidates[index]?.rerank_id,
        title: candidate.noteTitle || candidate.title,
        file: candidatePath(candidate),
        source: finalTraceCandidates[index]?.source,
        sources: finalTraceCandidates[index]?.sources ?? [],
        relation: candidate.relation,
        hit: candidate.hit,
        why: candidate.why,
        quotes: candidate.quotes,
      })),
      errors: runtimeErrors,
    },
    backlink_seed_strategy: null,
    backlink_seeds: [],
    backlink_candidates: sourceExpansionCandidates,
    expanded_pool: {
      score: expandedPoolScore,
      score_at_20: expandedPoolScoreAt20,
      nice_to_have: expandedPoolNiceScore,
      eval_v2: expandedPoolEvalV2,
      recall_at_20: expandedPoolScoreAt20.recall_at_k,
      source_note_rank: expandedPoolEval.source_note_rank,
      candidate_count: expandedPool.length,
      qmd_candidate_count: qmdCandidates.length,
      backlink_candidate_count: sourceExpansionCandidates.length,
      dropped_from_final_top_k: droppedMust,
      dropped_must_count: droppedMust.length,
    },
    failure_attribution: failureAttribution,
    must_recall_sources: pipelineScore.must_recall_ranks.map((item) => ({
      file: item.file,
      rank: item.rank,
      source: sourceForExpected(item.file, finalTraceCandidates, resolver),
      in_expanded_pool: sourceForExpected(item.file, expandedPool, resolver) !== "missing",
    })),
    nice_to_have_sources: pipelineNiceScore.nice_to_have_ranks.map((item) => ({
      file: item.file,
      rank: item.rank,
      source: sourceForExpected(item.file, finalTraceCandidates, resolver),
      in_expanded_pool: sourceForExpected(item.file, expandedPool, resolver) !== "missing",
    })),
    latency_ms: Date.now() - startedAt,
    trace_diagnosis: traceDiagnosis,
  };
  caseResult.mode_evaluation = runtimeTrace.status === "success"
    ? modeEvaluationForCase(caseItem, caseResult.must_recall_sources)
    : { status: "not_scored", reason: "runtime_failure" };
  caseResult.evaluation_status = caseResult.mode_evaluation.status;
  return { caseResult, trace };
}

async function main() {
  const options = parseArgs();
  const {
    cases: allCases,
    collection: defaultCollection,
    expectedInTopK,
    expectedNiceInTopK,
    suiteEvaluation,
    suiteVersions,
  } = readBenchmarkCases(options.cases, {
    includeDraft: options.includeDraft,
  });
  const suiteCases = options.suite === "all"
    ? allCases
    : allCases.filter((caseItem) => caseItem.suite === options.suite);
  const cases = options.only.length > 0
    ? suiteCases.filter((caseItem) => options.only.includes(caseItem.id))
    : suiteCases;
  if (options.only.length > 0 && cases.length === 0) {
    throw new Error(`--only matched no cases: ${options.only.join(", ")}`);
  }
  const collection = options.collection || defaultCollection;
  const resolver = buildVaultResolver();
  const results = [];
  const traces = [];

  for (const caseItem of cases) {
    if (options.profile === "product-parity") {
      const { caseResult, trace } = productParityCase(
        caseItem,
        options,
        resolver,
        expectedInTopK,
        expectedNiceInTopK,
      );
      results.push(caseResult);
      traces.push(trace);
      continue;
    }
    const startedAt = Date.now();
    const diagnosticPipeline = await runRetrievalPipeline({
      insight: {
        text: textFromUnknown(caseItem.input),
        sourceExcerpt: caseItem._resolved_insight_input,
        thought: caseItem.input?.thought ?? caseItem.insight_input?.thought ?? "",
        sourcePath: sourceNotePathForCase(caseItem) || null,
      },
      policy: {
        ...DIAGNOSTIC_RETRIEVAL_POLICY_V2,
        queryLimit: options.queryMode === "raw-only" ? 1 : DIAGNOSTIC_RETRIEVAL_POLICY_V2.queryLimit,
        supplements: options.queryMode === "raw-only"
          ? { sourceExcerpt: false, thought: false }
          : DIAGNOSTIC_RETRIEVAL_POLICY_V2.supplements,
        finalCandidateLimit: options.limit,
        candidateBudgets: {
          ...DIAGNOSTIC_RETRIEVAL_POLICY_V2.candidateBudgets,
          finalDisplayBudget: options.limit,
        },
        graphExpansion: {
          ...DIAGNOSTIC_RETRIEVAL_POLICY_V2.graphExpansion,
          enabled: options.backlinks,
          seedLimit: options.seedLimit,
          backlinksLimit: options.backlinksPerSeed,
          perSeedLimit: options.backlinksPerSeed,
          globalCandidateLimit: options.backlinkLimit,
        },
      },
      adapters: {
        planQueries: async () => {
          const generated = resolveQmdQueriesForCase(caseItem, options);
          return {
            ...generated,
            queries: selectQuerySpecs(generated.queries, options),
          };
        },
        retrieve: async ({ queries }) => ({ runs: runQmdQueries(queries, collection, options) }),
        graphAdapters: () => diagnosticGraphAdapters(caseItem, options, resolver),
        selectCandidates: async ({ retrievalCandidates, graphCandidates }) => mergeCandidateEvidence(
          enrichCandidateBodies([
            ...dropExcludedCandidates(mergeCandidateEvidence(retrievalCandidates)),
            ...dropExcludedCandidates(graphCandidates),
          ], resolver),
        ),
        judgeRelationChunk: async ({ state, candidates }) => {
          const judged = await relationJudgeCandidatesForCase({
            ...caseItem,
            query_object: state.generatedQuery.query_object,
            query_objects: state.generatedQuery.query_objects,
            queries: state.queries,
          }, candidates, options);
          if (judged.ok === false) throw new Error(judged.error || "Diagnostic Relation Judge chunk failed.");
          return completeDiagnosticJudgedSet(judged.candidates, candidates);
        },
        compareRelationsGlobally: async ({ state, candidates }) => {
          const judged = await relationJudgeCandidatesForCase({
            ...caseItem,
            query_object: state.generatedQuery.query_object,
            query_objects: state.generatedQuery.query_objects,
            queries: state.queries,
          }, candidates, options);
          if (judged.ok === false) throw new Error(judged.error || "Diagnostic global comparison failed.");
          return completeDiagnosticJudgedSet(judged.candidates, candidates);
        },
        candidateId: (candidate) => candidatePath(candidate),
        validateRelationEvidence: (candidate) => candidate,
        formatResult: async ({ finalCandidates }) => ({ ok: true, candidates: finalCandidates }),
      },
    });
    const generatedQuery = diagnosticPipeline.state.generatedQuery;
    const querySpecs = diagnosticPipeline.state.queries;
    const queryText = querySpecs.map((query) => query.query || query.text || "").join("\n\n---\n\n");
    const qmdRuns = diagnosticPipeline.state.retrievalRuns;
    const qmdCandidates = dropExcludedCandidates(
      mergeCandidateEvidence(qmdRuns.flatMap((runItem) => runItem.candidates)),
    );
    const qmdErrors = qmdRuns.flatMap((runItem) => runItem.errors);
    const backlinkSeeds = diagnosticPipeline.state.graphExpansion?.seeds ?? [];
    const backlinkResult = diagnosticPipeline.state.graphExpansion
      ? {
        ...diagnosticPipeline.state.graphExpansion,
        errors: diagnosticPipeline.state.graphExpansion.errors
          ?? diagnosticPipeline.state.graphExpansion.failures?.map((failure) => `${failure.origin}/${failure.graphCommand}: graph command failed`)
          ?? [],
      }
      : { candidates: [], errors: [] };
    const expandedPool = diagnosticPipeline.state.selectedCandidates;
    const rerankResult = diagnosticPipeline.state.relationJudge;
    if (rerankResult?.counts) {
      rerankResult.relation_judge_reviewed_candidates = expandedPool.slice(0, rerankResult.counts.judge_input_count);
      rerankResult.relation_judge_generated_by = "shared-chunked-judge";
      rerankResult.relation_judge_fallback = false;
      rerankResult.relation_judge_error = rerankResult.error ?? null;
      rerankResult.relation_judge_prompt_version = RELATION_JUDGE_PROMPT_VERSION;
    }
    const finalCandidates = diagnosticPipeline.state.finalCandidates;
    const topK = Number(caseItem.expected_in_top_k ?? expectedInTopK);
    const niceTopK = Number(caseItem.nice_expected_in_top_k ?? expectedNiceInTopK);
    const niceToHave = caseItem.nice_to_have ?? [];
    const negative = caseItem.negative ?? [];
    const expandedPoolTopK = Number(caseItem.expanded_pool_expected_in_top_k ?? 20);
    const sourceNotePath = sourceNotePathForCase(caseItem);
    const qmdFiles = candidateFiles(qmdCandidates);
    const pipelineFiles = candidateFiles(finalCandidates);
    const expandedPoolFiles = candidateFiles(expandedPool);
    const qmdEval = sourceNoteEval(qmdFiles, sourceNotePath, options, resolver);
    const pipelineEval = sourceNoteEval(pipelineFiles, sourceNotePath, options, resolver);
    const expandedPoolEval = sourceNoteEval(expandedPoolFiles, sourceNotePath, options, resolver);
    const scoreOptions = { resolver };
    const qmdScore = scoreResults(qmdEval.files, caseItem.must_recall, topK, scoreOptions);
    const qmdNiceScore = scoreNiceToHave(qmdEval.files, niceToHave, niceTopK, scoreOptions);
    const qmdEvalV2 = scoreEvalV2(qmdEval.files, {
      topK,
      mustRecallFiles: caseItem.must_recall,
      niceToHaveFiles: niceToHave,
      negativeFiles: negative,
      resolver,
    });
    const pipelineScore = scoreResults(pipelineEval.files, caseItem.must_recall, topK, scoreOptions);
    const pipelineNiceScore = scoreNiceToHave(pipelineEval.files, niceToHave, niceTopK, scoreOptions);
    const pipelineEvalV2 = scoreEvalV2(pipelineEval.files, {
      topK,
      mustRecallFiles: caseItem.must_recall,
      niceToHaveFiles: niceToHave,
      negativeFiles: negative,
      resolver,
    });
    const expandedPoolScore = scoreResults(
      expandedPoolEval.files,
      caseItem.must_recall,
      Math.max(topK, expandedPool.length || topK),
      scoreOptions,
    );
    const expandedPoolScoreAt20 = scoreResults(
      expandedPoolEval.files,
      caseItem.must_recall,
      expandedPoolTopK,
      scoreOptions,
    );
    const expandedPoolEvalV2 = scoreEvalV2(expandedPoolEval.files, {
      topK: expandedPoolTopK,
      mustRecallFiles: caseItem.must_recall,
      niceToHaveFiles: niceToHave,
      negativeFiles: negative,
      resolver,
    });
    const expandedPoolDroppedFromTopK = droppedMustFromExpandedPool(expandedPoolScoreAt20, pipelineScore, topK);
    const expandedPoolNiceScore = scoreNiceToHave(
      expandedPoolEval.files,
      niceToHave,
      Math.max(niceTopK, expandedPool.length || niceTopK),
      scoreOptions,
    );
    const caseResult = {
      id: caseItem.id,
      state: caseItem.state,
      title: caseItem.title || caseItem.id,
      why: caseItem.why || undefined,
      type: caseItem.type || "real",
      suite: caseItem.suite ?? null,
      suite_version: caseItem._suite_version ?? null,
      evaluation_mode: caseItem.evaluation_mode ?? null,
      provenance_origin: caseItem.provenance?.origin ?? null,
      profile: "diagnostic-enhanced",
      query: queryText,
      queries: querySpecs.map((query) => ({
        kind: query.kind,
        command: query.command,
        text: query.text,
        query: query.query,
        qmd: query.qmd,
      })),
      query_object: generatedQuery.query_object,
      query_objects: generatedQuery.query_objects,
      query_generated_by: generatedQuery.query_generated_by,
      query_generation_fallback: generatedQuery.query_generation_fallback,
      query_generation_error: generatedQuery.query_generation_error,
      query_plan_prompt_version: generatedQuery.query_plan_prompt_version,
      query_mode: options.queryMode,
      expected_files: caseItem.must_recall,
      expected_in_top_k: topK,
      nice_expected_in_top_k: niceTopK,
      expanded_pool_expected_in_top_k: expandedPoolTopK,
      source_note_path: sourceNotePath || null,
      nice_to_have_files: niceToHave,
      negative_files: negative,
      qmd: {
        score: qmdScore,
        nice_to_have: qmdNiceScore,
        eval_v2: qmdEvalV2,
        source_note_rank: qmdEval.source_note_rank,
        top_files: candidateFiles(qmdCandidates).slice(0, options.limit),
        runs: qmdRuns.map((runItem) => ({
          kind: runItem.kind,
          command: runItem.command,
          top_files: candidateFiles(runItem.candidates).slice(0, options.limit),
          errors: runItem.errors,
        })),
        errors: qmdErrors,
      },
      pipeline: {
        score: pipelineScore,
        nice_to_have: pipelineNiceScore,
        eval_v2: pipelineEvalV2,
        source_note_rank: pipelineEval.source_note_rank,
        relation_judge_generated_by: rerankResult.relation_judge_generated_by,
        relation_judge_fallback: rerankResult.relation_judge_fallback,
        relation_judge_error: rerankResult.relation_judge_error,
        relation_judge_ranked_ids: rerankResult.relation_judge_ranked_ids,
        relation_judge_prompt_version: rerankResult.relation_judge_prompt_version,
        relation_judge_reviewed_candidates: rerankResult.relation_judge_reviewed_candidates ?? [],
        top_candidates: finalCandidates.map((candidate) => ({
          rerankId: candidate.rerankId,
          title: candidate.title,
          file: candidatePath(candidate),
          source: sourceLabel(candidate),
          sources: sourceList(candidate),
          expansionFrom: candidate.expansionFrom,
          relation: candidate.relation,
          hit: candidate.hit,
          why: candidate.why,
          quotes: candidate.quotes,
        })),
        errors: [...qmdErrors, ...backlinkResult.errors],
      },
      backlink_seed_strategy: options.seedStrategy,
      backlink_seeds: backlinkSeeds.map((candidate) => ({
        title: candidate.title,
        file: candidatePath(candidate),
        source: sourceLabel(candidate),
        queryKind: candidate.queryKind,
      })),
      backlink_candidates: backlinkResult.candidates.map((candidate) => ({
        title: candidate.title,
        file: candidatePath(candidate),
        source: sourceLabel(candidate),
        sources: sourceList(candidate),
        expansionFrom: candidate.expansionFrom,
      })),
      expanded_pool: {
        score: expandedPoolScore,
        score_at_20: expandedPoolScoreAt20,
        nice_to_have: expandedPoolNiceScore,
        eval_v2: expandedPoolEvalV2,
        recall_at_20: expandedPoolScoreAt20.recall_at_k,
        source_note_rank: expandedPoolEval.source_note_rank,
        candidate_count: expandedPool.length,
        qmd_candidate_count: qmdCandidates.length,
        backlink_candidate_count: backlinkResult.candidates.length,
        dropped_from_final_top_k: expandedPoolDroppedFromTopK,
        dropped_must_count: expandedPoolDroppedFromTopK.length,
      },
      must_recall_sources: pipelineScore.must_recall_ranks.map((item) => ({
        file: item.file,
        rank: item.rank,
        source: sourceForExpected(item.file, finalCandidates, resolver),
        in_expanded_pool: sourceForExpected(item.file, expandedPool, resolver) !== "missing",
      })),
      nice_to_have_sources: pipelineNiceScore.nice_to_have_ranks.map((item) => ({
        file: item.file,
        rank: item.rank,
        source: sourceForExpected(item.file, finalCandidates, resolver),
        in_expanded_pool: sourceForExpected(item.file, expandedPool, resolver) !== "missing",
      })),
      latency_ms: Date.now() - startedAt,
    };
    const traceInput = {
      caseItem: {
        ...caseItem,
        must_recall: caseItem.identity_evaluation?.gold?.must ?? caseItem.must_recall,
        nice_to_have: caseItem.identity_evaluation?.gold?.nice ?? caseItem.nice_to_have,
        negative: caseItem.identity_evaluation?.gold?.noise ?? caseItem.negative,
      },
      generatedQuery,
      querySpecs,
      qmdRuns,
      qmdCandidates,
      backlinkSeeds,
      backlinkResult,
      seedStrategy: options.seedStrategy,
      expandedPool,
      preRerankCandidates: expandedPool,
      rerankResult,
      finalCandidates,
      topK,
    };
    const evidenceTrace = buildPipelineTrace({ ...traceInput, failureAttribution: null });
    const failureAttribution = failureAttributionFromTrace(caseItem, evidenceTrace, {
      topK,
      judgeBudget: 20,
      resolver,
    });
    const trace = buildPipelineTrace({ ...traceInput, failureAttribution });
    caseResult.failure_attribution = failureAttribution;
    caseResult.mode_evaluation = modeEvaluationForCase(caseItem, caseResult.must_recall_sources);
    caseResult.evaluation_status = caseResult.mode_evaluation.status;
    caseResult.trace_diagnosis = trace.diagnosis;
    results.push(caseResult);
    traces.push(trace);
  }

  const report = {
    timestamp: new Date().toISOString(),
    report: options.report,
    profile: options.profile,
    metadata: reportMetadata(options, collection),
    suite: reportSuite(options, suiteVersions),
    suite_validation: {
      status: suiteEvaluation.status,
      suite_versions: suiteVersions,
    },
    cases: safePathIdentifier(options.cases),
    index: options.index,
    collection,
    candidate_limit: options.limit,
    seed_limit: options.seedLimit,
    backlinks_per_seed: options.backlinksPerSeed,
    backlink_limit: options.backlinkLimit,
    backlinks_enabled: options.profile === "diagnostic-enhanced" ? options.backlinks : null,
    query_mode: options.profile === "diagnostic-enhanced" ? options.queryMode : "runtime",
    seed_strategy: options.profile === "diagnostic-enhanced" ? options.seedStrategy : null,
    source_note_filter_enabled: options.sourceNoteFilter,
    relation_judge_mode: options.profile === "diagnostic-enhanced" ? options.relationJudgeMode : "runtime",
    results,
    case_counts: reportCaseCounts(results),
    diagnostics: reportDiagnostics(results),
  };
  const comparisonReport = readComparisonReport(options.compareReport);
  const stability = comparePipelineStability(report, comparisonReport, { resolver });
  for (const result of results) {
    result.pipeline.stability = stability.by_case[result.id]
      ?? {
        status: "not_measured",
        reason: "comparison_case_missing",
        metric: "top_k_overlap",
        top_k: result.pipeline.score?.top_k ?? 10,
        score: null,
      };
  }
  report.summary = {
    ...summarizePipelineEvaluation(results),
    by_suite: summarizePipelineEvaluationGroups(results),
    trace_diagnosis_counts: summarizeTraceDiagnoses(results),
  };

  const latestReport = writeReportWithTraces(report, options.report, traces);
  if (!options.noArchive) {
    const stampedReport = archiveReportPath(options.report);
    writeReportWithTraces(report, stampedReport, traces);
  }
  printSummary(latestReport);
}

await main();
