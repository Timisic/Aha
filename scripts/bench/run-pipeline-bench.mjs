#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, relative, resolve } from "node:path";
import {
  collectResultItems,
  filterSourceNoteFromResults,
  pathsMatch,
  pickFirstString,
  readBenchmarkCases,
  resolveQmdQueriesForCase,
  scoreNiceToHave,
  scoreResults,
  sourceNotePathForCase,
  summarizePipelineEvaluation,
  textFromUnknown,
} from "../lib/aha-bench-common.mjs";
import { rerankCandidatesForCase } from "../lib/aha-agent-rerank.mjs";
import {
  buildVaultPathResolver as sharedBuildVaultPathResolver,
  deterministicFallbackCanonicalId,
  normalizeIdentityHint,
  resolveNoteIdentity,
  resolveVaultPath as sharedResolveVaultPath,
} from "../../insight-package/src/path-resolver.js";

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
  queryAgentBin: "codex",
  queryAgentModel: "",
  queryAgentCache: "bench/generated/qmd-query-agent-cache.json",
  queryAgentFallback: true,
  queryAgentTimeoutMs: 120_000,
  reranker: "agent",
  rerankAgentBin: "codex",
  rerankAgentModel: "",
  rerankAgentCache: "bench/generated/agent-rerank-cache.json",
  rerankAgentFallback: true,
  rerankAgentTimeoutMs: 300_000,
  includeDraft: false,
  backlinks: true,
  queryMode: "multi",
  seedStrategy: "fair",
  sourceNoteFilter: true,
};

function usage() {
  return [
    "Usage:",
    "  node scripts/bench/run-pipeline-bench.mjs [options]",
    "",
    "Options:",
    "  --cases <path>                 Default: bench/aha-memory-cases.json",
    "  --report <path>                Default: bench/reports/latest/pipeline.json",
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
    "  --query-generator <agent|rules> Default: agent",
    "  --query-agent-bin <bin>         Default: codex",
    "  --query-agent-model <model>",
    "  --query-agent-cache <path>      Default: bench/generated/qmd-query-agent-cache.json",
    "  --query-agent-timeout-ms <n>    Default: 120000",
    "  --no-query-agent-cache",
    "  --no-query-agent-fallback",
    "  --reranker <agent|none>         Default: agent",
    "  --rerank-agent-bin <bin>        Default: codex",
    "  --rerank-agent-model <model>",
    "  --rerank-agent-cache <path>     Default: bench/generated/agent-rerank-cache.json",
    "  --rerank-agent-timeout-ms <n>   Default: 300000",
    "  --no-rerank-agent-cache",
    "  --no-rerank-agent-fallback",
    "  --include-draft                Include draft cases",
    "  --no-backlinks                 Disable Obsidian backlink expansion",
    "  --query-mode <multi|raw-only>   Default: multi",
    "  --seed-strategy <fair|first>    Backlink seed strategy, default fair",
    "  --no-source-note-filter        Keep source note self-hits in scoring",
  ].join("\n");
}

function parseArgs() {
  const options = { ...DEFAULTS };
  const args = process.argv.slice(2);

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
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
    if (arg === "--no-query-agent-cache") {
      options.queryAgentCache = "";
      continue;
    }
    if (arg === "--no-query-agent-fallback") {
      options.queryAgentFallback = false;
      continue;
    }
    if (arg === "--no-rerank-agent-cache") {
      options.rerankAgentCache = "";
      continue;
    }
    if (arg === "--no-rerank-agent-fallback") {
      options.rerankAgentFallback = false;
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
      case "--query-generator":
        options.queryGenerator = value;
        break;
      case "--query-mode":
        options.queryMode = value;
        break;
      case "--query-agent-bin":
        options.queryAgentBin = value;
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
      case "--reranker":
        options.reranker = value;
        break;
      case "--rerank-agent-bin":
        options.rerankAgentBin = value;
        break;
      case "--rerank-agent-model":
        options.rerankAgentModel = value;
        break;
      case "--rerank-agent-cache":
        options.rerankAgentCache = value;
        break;
      case "--rerank-agent-timeout-ms":
        options.rerankAgentTimeoutMs = Number(value);
        break;
      case "--seed-strategy":
        options.seedStrategy = value;
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }

  for (const key of ["limit", "seedLimit", "backlinksPerSeed", "backlinkLimit", "qmdTimeoutMs", "obsidianTimeoutMs", "queryAgentTimeoutMs", "rerankAgentTimeoutMs"]) {
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
    cwd: resolve("."),
    encoding: "utf-8",
    timeout: options.timeoutMs,
    env: options.env ?? process.env,
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

function candidatePath(candidate) {
  return candidate.canonicalPath || candidate.file || candidate.path || candidate.slug || candidate.title;
}

function candidateIdentityKey(candidate) {
  if (candidate.canonicalId) return candidate.canonicalId;
  const resolver = buildVaultResolver();
  const resolved = resolveNoteIdentity(candidatePath(candidate), resolver);
  if (resolved.status === "resolved") return resolved.canonicalId;
  if (resolved.status === "ambiguous") return deterministicFallbackCanonicalId({ path: candidatePath(candidate), title: candidate.title, content: candidate.content });
  return normalizeIdentityHint(candidatePath(candidate)) || deterministicFallbackCanonicalId({ title: candidate.title, content: candidate.content });
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
  return resolve(process.env.AHA_BENCH_VAULT_ROOT?.trim() || "~/Obsidian Notes");
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

function tokenizeForRelevance(text) {
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

function isBacklinkRelevant(backlink, caseItem, queryText) {
  const haystack = `${backlink.title}\n${backlink.path ?? ""}\n${backlink.content ?? ""}`;
  const candidateTokens = tokenizeForRelevance(haystack);
  if (candidateTokens.size === 0) return false;

  const queryTokens = tokenizeForRelevance([
    caseItem._resolved_insight_input,
    queryText,
  ].join("\n"));
  let overlap = 0;
  for (const token of queryTokens) {
    if (candidateTokens.has(token)) overlap += 1;
  }
  return overlap >= 1;
}

function readObsidianNote(backlink, options) {
  const args = backlink.path
    ? ["read", `path=${backlink.path}`]
    : ["read", `file=${backlink.title}`];
  const result = run(options.obsidian, args, { timeoutMs: options.obsidianTimeoutMs });
  if (result.code !== 0 || result.error || result.timedOut) return "";
  const output = result.stdout.trim();
  if (!output || /^Error:\s+/i.test(output)) return "";
  return output;
}

function backlinkArgSets(seed, resolver) {
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

function expandBacklinkCandidates(seeds, caseItem, queryText, options, resolver) {
  const candidates = [];
  const errors = [];
  const seen = new Set();

  for (const seed of seeds.slice(0, options.seedLimit)) {
    let backlinks = [];
    for (const args of backlinkArgSets(seed, resolver)) {
      const result = run(options.obsidian, args, { timeoutMs: options.obsidianTimeoutMs });
      if (result.error) {
        errors.push(`${seed.title}: ${result.error}`);
        continue;
      }
      if (result.timedOut) {
        errors.push(`${seed.title}: obsidian backlinks timed out`);
        continue;
      }
      if (result.code !== 0 || !result.stdout.trim()) continue;
      backlinks = parseBacklinksOutput(result.stdout, seed);
      if (backlinks.length > 0) break;
    }

    for (const backlink of backlinks.slice(0, options.backlinksPerSeed)) {
      const key = backlink.path || backlink.title;
      if (!key || seen.has(key)) continue;
      seen.add(key);

      backlink.content = readObsidianNote(backlink, options);
      if (!isBacklinkRelevant(backlink, caseItem, queryText)) continue;

      candidates.push({
        id: backlink.path || backlink.title,
        title: backlink.title,
        file: backlink.path,
        content: backlink.content,
        rank: backlink.count,
        queryText: `backlinks:${seed.title}`,
        source: "backlink",
        expansionFrom: seed.file || seed.title,
      });
      if (candidates.length >= options.backlinkLimit) return { candidates, errors };
    }
  }

  return { candidates, errors };
}

function selectQuerySpecs(querySpecs, options) {
  if (options.queryMode === "multi") return querySpecs;
  const rawQuery = querySpecs.find((query) => query.kind === "raw");
  return [rawQuery ?? querySpecs[0]].filter(Boolean);
}

function seedGroup(candidate) {
  return candidate.queryKind || candidate.queryCommand || candidate.source || "unknown";
}

function selectBacklinkSeeds(candidates, options) {
  if (options.seedStrategy === "first") return candidates.slice(0, options.seedLimit);

  const grouped = new Map();
  for (const candidate of candidates) {
    const key = seedGroup(candidate);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(candidate);
  }

  const groups = Array.from(grouped.values());
  const selected = [];
  for (let offset = 0; selected.length < options.seedLimit; offset += 1) {
    let added = false;
    for (const group of groups) {
      if (!group[offset]) continue;
      selected.push(group[offset]);
      added = true;
      if (selected.length >= options.seedLimit) break;
    }
    if (!added) break;
  }
  return selected;
}

function mergeCandidates(candidates, limit) {
  const seen = new Set();
  const merged = [];
  for (const candidate of candidates) {
    const key = candidateIdentityKey(candidate);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    merged.push(candidate);
    if (merged.length >= limit) break;
  }
  return merged;
}

function sourceList(candidate) {
  if (Array.isArray(candidate.sources) && candidate.sources.length > 0) {
    return candidate.sources;
  }
  return candidate.source ? [candidate.source] : [];
}

function sourceLabel(candidate) {
  const sources = sourceList(candidate);
  return sources.length > 0 ? sources.join("+") : candidate.source;
}

function mergeCandidateEvidence(candidates) {
  const byKey = new Map();
  const merged = [];
  for (const candidate of candidates) {
    const key = candidateIdentityKey(candidate);
    if (!key) continue;
    const existing = byKey.get(key);
    if (!existing) {
      const next = {
        ...candidate,
        sources: sourceList(candidate),
        expansionSources: candidate.expansionFrom ? [candidate.expansionFrom] : [],
      };
      byKey.set(key, next);
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

function sourceForExpected(expected, candidates) {
  const match = candidates.find((candidate) => pathsMatch(candidatePath(candidate), expected));
  return match ? sourceLabel(match) : "missing";
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

function printSummary(report) {
  console.log("# Aha Memory Pipeline Bench Summary");
  console.log("");
  console.log(`Report: ${report.report}`);
  console.log(`Cases: ${report.summary.cases}`);
  console.log(`Query mode: ${report.query_mode}`);
  console.log(`Backlinks: ${report.backlinks_enabled ? "enabled" : "disabled"}`);
  console.log(`Seed strategy: ${report.seed_strategy}`);
  console.log(`Source-note filter: ${report.source_note_filter_enabled ? "enabled" : "disabled"}`);
  console.log(`Reranker: ${report.reranker}`);
  console.log("");

  if (report.results.length === 0) {
    console.log("No active cases found. Add active cases to bench/aha-memory-cases.json first.");
    return;
  }

  console.log("| Case | Must K | QMD R@K | Pipeline R@K | Nice K | Nice R@K | Must-recall ranks | Nice ranks | Missing |");
  console.log("|---|---:|---:|---:|---:|---:|---|---|---|");
  for (const result of report.results) {
    const ranks = result.pipeline.score.found_must_recall_ranks
      .join(", ");
    const niceRanks = result.pipeline.nice_to_have.found_nice_to_have_ranks
      .join(", ");
    const niceRecall = result.pipeline.nice_to_have.recall_at_k;
    const missing = result.pipeline.score.unmatched_expected_files.join("<br>") || "-";
    const topK = result.pipeline.score.top_k || result.qmd.score.top_k || "K";
    const niceTopK = result.pipeline.nice_to_have.top_k || "K";
    console.log(`| ${result.id} | ${topK} | ${fixed(result.qmd.score.recall_at_k)} | ${fixed(result.pipeline.score.recall_at_k)} | ${niceTopK} | ${niceRecall === null ? "-" : fixed(niceRecall)} | [${ranks}] | [${niceRanks}] | ${missing} |`);
  }

  console.log("");
  console.log("| Summary | Value |");
  console.log("|---|---:|");
  console.log(`| avg QMD R@K | ${fixed(report.summary.avg_qmd_recall_at_k)} |`);
  console.log(`| avg pipeline R@K | ${fixed(report.summary.avg_pipeline_recall_at_k)} |`);
  console.log(`| avg pipeline nice-to-have R@20 | ${report.summary.avg_pipeline_nice_to_have_recall_at_k === null ? "-" : fixed(report.summary.avg_pipeline_nice_to_have_recall_at_k)} |`);
  console.log(`| avg worst must-rank | ${fixed(report.summary.avg_worst_must_rank, 1)} |`);
  console.log(`| avg expanded-pool recall | ${fixed(report.summary.avg_expanded_pool_recall)} |`);
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
      root,
      markdown_file_count: markdownFileCount,
      hash: hash.digest("hex"),
    };
  } catch (error) {
    return {
      root,
      markdown_file_count: markdownFileCount,
      hash: null,
      error: error.message,
    };
  }
}

function commandOutput(command, args) {
  const result = spawnSync(command, args, {
    encoding: "utf-8",
    timeout: 10_000,
  });
  if (result.error || result.status !== 0) return "";
  return String(result.stdout || result.stderr || "").trim().split(/\r?\n/)[0] ?? "";
}

function reportMetadata(options) {
  return {
    generated_at: new Date().toISOString(),
    git_commit: commandOutput("git", ["rev-parse", "HEAD"]),
    git_status_short: commandOutput("git", ["status", "--short"]),
    pipeline_version: "aha-pipeline-bench-v2",
    query_prompt_version: "aha-qmd-query-plan-agent-v1",
    rerank_prompt_version: "aha-agent-rerank-v1",
    query_agent_bin: options.queryAgentBin,
    query_agent_version: commandOutput(options.queryAgentBin, ["--version"]),
    query_agent_model: options.queryAgentModel || null,
    query_agent_cache: options.queryAgentCache || null,
    rerank_agent_bin: options.rerankAgentBin,
    rerank_agent_version: commandOutput(options.rerankAgentBin, ["--version"]),
    rerank_agent_model: options.rerankAgentModel || null,
    rerank_agent_cache: options.rerankAgentCache || null,
    qmd_bin: options.qmd,
    qmd_version: commandOutput(options.qmd, ["--version"]),
    obsidian_bin: options.obsidian,
    obsidian_version: commandOutput(options.obsidian, ["--version"]),
    vault_root: vaultRoot(),
    vault_snapshot: vaultSnapshotMetadata(),
    index_snapshot: {
      index: options.index,
      collection: options.collection || null,
      qmd_bin: options.qmd,
    },
  };
}

function sourceNoteEval(files, sourceNotePath, options) {
  if (options.sourceNoteFilter) return filterSourceNoteFromResults(files, sourceNotePath);
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
  const rerankCacheHits = countBy(results, (result) => result.pipeline?.rerank_generated_by === "agent-cache");
  const rerankAgentRuns = countBy(results, (result) => result.pipeline?.rerank_generated_by === "agent");
  const rerankFallbacks = countBy(results, (result) => !!result.pipeline?.rerank_fallback);
  const qmdTimeouts = countErrors(results, /qmd query timed out/i);
  const obsidianTimeouts = countErrors(results, /obsidian backlinks timed out/i);

  return {
    query_cache_hits: queryCacheHits,
    query_cache_misses: queryAgentRuns,
    query_fallbacks: queryFallbacks,
    rerank_cache_hits: rerankCacheHits,
    rerank_cache_misses: rerankAgentRuns,
    rerank_fallbacks: rerankFallbacks,
    fallback_count: queryFallbacks + rerankFallbacks,
    qmd_timeout_count: qmdTimeouts,
    obsidian_timeout_count: obsidianTimeouts,
    timeout_count: qmdTimeouts + obsidianTimeouts,
  };
}

function main() {
  const options = parseArgs();
  const { cases, collection: defaultCollection, expectedInTopK, expectedNiceInTopK } = readBenchmarkCases(options.cases, {
    includeDraft: options.includeDraft,
  });
  const collection = options.collection || defaultCollection;
  const resolver = buildVaultResolver();
  const results = [];

  for (const caseItem of cases) {
    const startedAt = Date.now();
    const generatedQuery = resolveQmdQueriesForCase(caseItem, options);
    const querySpecs = selectQuerySpecs(generatedQuery.queries, options);
    const queryText = querySpecs.map((query) => query.query || query.text || "").join("\n\n---\n\n");
    const qmdRuns = runQmdQueries(querySpecs, collection, options);
    const qmdCandidates = mergeCandidateEvidence(qmdRuns.flatMap((runItem) => runItem.candidates));
    const qmdErrors = qmdRuns.flatMap((runItem) => runItem.errors);
    const backlinkSeeds = selectBacklinkSeeds(qmdCandidates, options);

    const backlinkResult = options.backlinks
      ? expandBacklinkCandidates(backlinkSeeds, caseItem, queryText, options, resolver)
      : { candidates: [], errors: [] };
    const expandedPool = mergeCandidateEvidence([...qmdCandidates, ...backlinkResult.candidates]);
    const rerankResult = rerankCandidatesForCase(
      {
        ...caseItem,
        query_object: generatedQuery.query_object,
        query_objects: generatedQuery.query_objects,
        queries: querySpecs,
      },
      expandedPool,
      options,
    );
    const finalCandidates = mergeCandidates(rerankResult.candidates, options.limit);
    const topK = Number(caseItem.expected_in_top_k ?? expectedInTopK);
    const niceTopK = Number(caseItem.nice_expected_in_top_k ?? expectedNiceInTopK);
    const niceToHave = caseItem.nice_to_have ?? [];
    const sourceNotePath = sourceNotePathForCase(caseItem);
    const qmdFiles = candidateFiles(qmdCandidates);
    const pipelineFiles = candidateFiles(finalCandidates);
    const expandedPoolFiles = candidateFiles(expandedPool);
    const qmdEval = sourceNoteEval(qmdFiles, sourceNotePath, options);
    const pipelineEval = sourceNoteEval(pipelineFiles, sourceNotePath, options);
    const expandedPoolEval = sourceNoteEval(expandedPoolFiles, sourceNotePath, options);
    const qmdScore = scoreResults(qmdEval.files, caseItem.must_recall, topK);
    const qmdNiceScore = scoreNiceToHave(qmdEval.files, niceToHave, niceTopK);
    const pipelineScore = scoreResults(pipelineEval.files, caseItem.must_recall, topK);
    const pipelineNiceScore = scoreNiceToHave(pipelineEval.files, niceToHave, niceTopK);
    const expandedPoolScore = scoreResults(
      expandedPoolEval.files,
      caseItem.must_recall,
      Math.max(topK, expandedPool.length || topK),
    );
    const expandedPoolDroppedFromTopK = expandedPoolScore.matched_files.filter((file) =>
      pipelineScore.unmatched_expected_files.includes(file),
    );
    const expandedPoolNiceScore = scoreNiceToHave(
      expandedPoolEval.files,
      niceToHave,
      Math.max(niceTopK, expandedPool.length || niceTopK),
    );

    results.push({
      id: caseItem.id,
      type: caseItem.type || "semantic",
      description: caseItem.description || caseItem.annotation_note || caseItem.id,
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
      query_mode: options.queryMode,
      expected_files: caseItem.must_recall,
      expected_in_top_k: topK,
      nice_expected_in_top_k: niceTopK,
      source_note_path: sourceNotePath || null,
      nice_to_have_files: niceToHave,
      qmd: {
        score: qmdScore,
        nice_to_have: qmdNiceScore,
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
        source_note_rank: pipelineEval.source_note_rank,
        rerank_generated_by: rerankResult.rerank_generated_by,
        rerank_fallback: rerankResult.rerank_fallback,
        rerank_error: rerankResult.rerank_error,
        rerank_ranked_ids: rerankResult.rerank_ranked_ids,
        top_candidates: finalCandidates.map((candidate) => ({
          rerankId: candidate.rerankId,
          title: candidate.title,
          file: candidatePath(candidate),
          source: sourceLabel(candidate),
          sources: sourceList(candidate),
          expansionFrom: candidate.expansionFrom,
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
        nice_to_have: expandedPoolNiceScore,
        source_note_rank: expandedPoolEval.source_note_rank,
        candidate_count: expandedPool.length,
        qmd_candidate_count: qmdCandidates.length,
        backlink_candidate_count: backlinkResult.candidates.length,
        dropped_from_final_top_k: expandedPoolDroppedFromTopK,
      },
      must_recall_sources: pipelineScore.must_recall_ranks.map((item) => ({
        file: item.file,
        rank: item.rank,
        source: sourceForExpected(item.file, finalCandidates),
        in_expanded_pool: sourceForExpected(item.file, expandedPool) !== "missing",
      })),
      nice_to_have_sources: pipelineNiceScore.nice_to_have_ranks.map((item) => ({
        file: item.file,
        rank: item.rank,
        source: sourceForExpected(item.file, finalCandidates),
        in_expanded_pool: sourceForExpected(item.file, expandedPool) !== "missing",
      })),
      latency_ms: Date.now() - startedAt,
    });
  }

  const report = {
    timestamp: new Date().toISOString(),
    report: options.report,
    metadata: reportMetadata(options),
    cases: options.cases,
    index: options.index,
    collection,
    candidate_limit: options.limit,
    seed_limit: options.seedLimit,
    backlinks_per_seed: options.backlinksPerSeed,
    backlink_limit: options.backlinkLimit,
    backlinks_enabled: options.backlinks,
    query_mode: options.queryMode,
    seed_strategy: options.seedStrategy,
    source_note_filter_enabled: options.sourceNoteFilter,
    reranker: options.reranker,
    results,
    diagnostics: reportDiagnostics(results),
    summary: summarizePipelineEvaluation(results),
  };

  mkdirSync(dirname(resolve(options.report)), { recursive: true });
  writeFileSync(resolve(options.report), `${JSON.stringify(report, null, 2)}\n`);
  const stampedReport = archiveReportPath(options.report);
  mkdirSync(dirname(stampedReport), { recursive: true });
  writeFileSync(stampedReport, `${JSON.stringify(report, null, 2)}\n`);
  printSummary(report);
}

main();
