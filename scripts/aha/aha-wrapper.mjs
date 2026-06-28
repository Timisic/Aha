#!/usr/bin/env node
import { access, mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { validateAhaResult } from "./lib/aha-result-schema.mjs";
import { notePathForObsidian, normalizeNoteIdentity, sameNotePath } from "./lib/note-identity.mjs";

const JSON_BEGIN = "AHA_RESULT_JSON_BEGIN";
const JSON_END = "AHA_RESULT_JSON_END";
const QUERY_PLAN_KINDS = ["raw", "abstracted_judgment", "contextual", "explicit_cue", "bounds"];
const QUERY_PLAN_COMMANDS = ["qmd query", "qmd search"];
const MIN_TARGET_CANDIDATES = 15;
const MAX_TARGET_CANDIDATES = 20;
const DEFAULT_MAX_OUTPUT_BYTES = 5 * 1024 * 1024;
const DEFAULT_QMD_QUERY_TIMEOUT_MS = 30_000;
const DEFAULT_QMD_CANDIDATE_LIMIT = 20;
const MAX_QMD_LEX_TERMS = 4;
const MAX_QMD_LEX_CHARS = 32;
const MAX_QMD_INTENT_CHARS = 180;
const MAX_QMD_VEC_CHARS = 360;
const MAX_QMD_HYDE_CHARS = 320;

main().catch((error) => {
  emitJson(failedAhaResult({
    sourcePath: null,
    summary: "Aha wrapper failed before completing the search round.",
    message: "Aha wrapper failed.",
    tool: "wrapper",
    details: error instanceof Error ? error.message : String(error),
  }), 1);
});

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.checkReadiness) {
    const result = await readiness(args);
    emitJson(result, result.ok ? 0 : 2);
    return;
  }

  if (args.fixture) {
    const fixture = JSON.parse(await readFile(args.fixture, "utf8"));
    const validation = validateAhaResult(fixture);
    if (!validation.ok) {
      emitJson(failedAhaResult({
        sourcePath: args.sourcePath,
        summary: "Fixture result failed schema validation.",
        message: "Fixture result is malformed.",
        tool: "wrapper",
        details: validation.errors.join("; "),
      }), 3);
      return;
    }
    emitJson({
      ...fixture,
      generatedAt: fixture.generatedAt ?? new Date().toISOString(),
      sourcePath: fixture.sourcePath ?? args.sourcePath,
    });
    return;
  }

  const prerequisites = await readiness(args);
  if (!prerequisites.ok) {
    emitJson(failedAhaResult({
      sourcePath: args.sourcePath,
      summary: "Aha prerequisites are not ready.",
      message: "Aha prerequisites are not ready.",
      tool: "wrapper",
      details: prerequisites.checks.filter((check) => !check.ok).map((check) => `${check.name}: ${check.message}`).join("; "),
    }), 4);
    return;
  }

  const sourceFilePath = await resolveSourceFilePath(args);
  if (!sourceFilePath) {
    emitJson(failedAhaResult({
      sourcePath: args.sourcePath,
      summary: "Aha source note failed the vault boundary check.",
      message: "Aha source note is outside the configured vault.",
      tool: "wrapper",
      details: "The source note path did not resolve inside vaultRoot after realpath symlink resolution.",
    }), 4);
    return;
  }

  const sourceText = await readFile(sourceFilePath, "utf8");

  if (args.strategy === "pipeline") {
    const result = await pipelineRecall(args, sourceText);
    emitJson(result, result.ok ? 0 : 2);
    return;
  }

  if (args.strategy === "qmd-only") {
    const recall = await qmdRecall(args, sourceText);
    emitJson(weakFallbackFromRows(args, recall.rows, "Codex relation judging skipped by qmd-only strategy."));
    return;
  }

  if (args.strategy !== "codex-orchestrated") {
    const recall = await qmdRecall(args, sourceText);
    const prompt = await buildRelationJudgePrompt(args, sourceText, recall.rows);
    let codexOutput;
    try {
      codexOutput = await runCodex(args, prompt);
    } catch (error) {
      emitJson(relationJudgeFailureFromRows(args, recall.rows, `Codex relation judging failed: ${error.message}`), 2);
      return;
    }
    if (codexOutput.code !== 0) {
      emitJson(relationJudgeFailureFromRows(
        args,
        recall.rows,
        `Codex relation judging exited ${codexOutput.code}: ${firstLine(codexOutput.stderr || codexOutput.stdout) || "no diagnostic"}`,
      ), 2);
      return;
    }
    let parsed;
    try {
      parsed = normalizeStructuredResult(extractCodexJson(codexOutput.stdout));
    } catch (error) {
      emitJson(relationJudgeFailureFromRows(args, recall.rows, `Codex relation judging returned non-JSON output: ${error.message}`), 2);
      return;
    }
    const validation = validateAhaResult(parsed);
    if (!validation.ok) {
      emitJson(relationJudgeFailureFromRows(args, recall.rows, `Codex relation judging returned malformed output: ${validation.errors.join("; ")}`), 2);
      return;
    }
    emitJson({
      ...parsed,
      generatedAt: parsed.generatedAt ?? new Date().toISOString(),
      sourcePath: parsed.sourcePath ?? args.sourcePath,
      warnings: [
        ...(parsed.warnings ?? []),
        "Retrieval used bounded wrapper-side QMD recall; Codex judged the returned candidate excerpts.",
      ],
    });
    return;
  }

  const prompt = buildCodexPrompt(args, sourceText);
  let codexOutput;
  try {
    codexOutput = await runCodex(args, prompt);
  } catch (error) {
    emitJson(await codexOrchestrationFailure(args, sourceText, `Codex run failed: ${error.message}`), 2);
    return;
  }

  if (codexOutput.code !== 0) {
    emitJson(await codexOrchestrationFailure(
      args,
      sourceText,
      `Codex exited ${codexOutput.code}: ${firstLine(codexOutput.stderr || codexOutput.stdout) || "no diagnostic"}`,
    ), 2);
    return;
  }
  let parsed;
  try {
    parsed = normalizeStructuredResult(extractCodexJson(codexOutput.stdout));
  } catch (error) {
    emitJson(await codexOrchestrationFailure(args, sourceText, `Codex returned non-JSON output: ${error.message}`), 2);
    return;
  }
  const validation = validateAhaResult(parsed);
  if (!validation.ok) {
    emitJson(await codexOrchestrationFailure(args, sourceText, `Codex returned malformed Aha output: ${validation.errors.join("; ")}`), 2);
    return;
  }

  emitJson({
    ...parsed,
    generatedAt: parsed.generatedAt ?? new Date().toISOString(),
    sourcePath: parsed.sourcePath ?? args.sourcePath,
  });
}

async function readiness(args) {
  const checks = [];
  checks.push(await checkWorkspace(args.workspace));
  checks.push(await checkReadableSourceNote(args));
  checks.push(await checkCommand("Codex CLI", args.codexCommand, ["--version"]));
  checks.push(await checkCommand("QMD CLI", args.qmdCommand, ["--version"]));
  checks.push(await checkCommand("Obsidian CLI", args.obsidianCommand, ["files", "total"]));
  return {
    ok: checks.every((check) => check.ok),
    checks,
  };
}

async function checkWorkspace(workspace) {
  if (!workspace) return { name: "Aha workspace", ok: false, message: "Not configured." };
  try {
    const info = await stat(workspace);
    return info.isDirectory()
      ? { name: "Aha workspace", ok: true, message: workspace }
      : { name: "Aha workspace", ok: false, message: "Path is not a directory." };
  } catch (error) {
    return { name: "Aha workspace", ok: false, message: error.message };
  }
}

async function checkReadableSourceNote(args) {
  if (!args.sourceAbsolutePath) return { name: "Wrapper source note", ok: true, message: "Skipped." };
  try {
    const sourceFilePath = await resolveSourceFilePath(args);
    if (!sourceFilePath) {
      return { name: "Wrapper source note", ok: false, message: "Source note must resolve inside vaultRoot." };
    }
    await access(sourceFilePath, fsConstants.R_OK);
    return { name: "Wrapper source note", ok: true, message: sourceFilePath };
  } catch (error) {
    return { name: "Wrapper source note", ok: false, message: error.message };
  }
}

async function checkCommand(name, command, args) {
  if (!command) return { name, ok: false, message: "Not configured." };
  try {
    const result = await runCommand(command, args, { timeoutMs: 15_000 });
    return result.code === 0
      ? { name, ok: true, message: firstLine(result.stdout || result.stderr) || "OK" }
      : { name, ok: false, message: firstLine(result.stderr || result.stdout) || `Exited ${result.code}` };
  } catch (error) {
    return { name, ok: false, message: error.message };
  }
}

function buildCodexPrompt(args, sourceText) {
  const target = Number(args.targetCandidates || 20);
  return [
    "You are running the Aha retrieval orchestration for an Obsidian plugin MVP.",
    "Do not modify Obsidian notes or repository files.",
    "Stay bounded: return within five minutes with partial useful candidates rather than exploring indefinitely.",
    "Use QMD for semantic recall. Run at most two QMD query commands and at most eight candidate read commands.",
    "Read candidate note text before assigning supports, challenges, resembles, or bounds. If you only have snippets, label the candidate weak.",
    "",
    "Local commands:",
    `- qmd command: ${args.qmdCommand}`,
    `- obsidian command: ${args.obsidianCommand}`,
    `- Aha workspace: ${args.workspace}`,
    `- vault root: ${args.vaultRoot}`,
    `- source vault path: ${args.sourcePath}`,
    `- source absolute path: ${args.sourceAbsolutePath}`,
    "",
    `Return up to ${target} candidate old notes; target 15-20 when enough candidates exist.`,
    "Allowed relation labels: supports, challenges, resembles, bounds, weak.",
    "For supports, challenges, resembles, and bounds, include quote-backed hit material from the old note text.",
    "",
    "Return only JSON as the final answer. It must match this shape:",
    JSON.stringify({
      ok: true,
      summary: "short search-round summary",
      warnings: [],
      candidates: [
        {
          notePath: "vault-relative/path.md",
          noteTitle: "Readable title",
          relation: "supports",
          hit: "\"short quote from old note\"",
          quotes: ["short quote from old note"],
          why: "Detailed reason this old note matters for the current insight.",
          selected: true,
        },
      ],
    }, null, 2),
    "",
    "If your Codex CLI output-schema support is unavailable, you may instead wrap the same JSON between these exact fallback markers:",
    JSON_BEGIN,
    "{...same JSON shape...}",
    JSON_END,
    "",
    "Source note content:",
    "```markdown",
    sourceText.slice(0, 12_000),
    "```",
  ].join("\n");
}

async function runCodex(args, prompt, options = {}) {
  const schemaPath = options.schemaPath ?? path.join(args.workspace, "scripts/aha/aha-result.schema.json");
  const tempDir = await mkdtemp(path.join(tmpdir(), "aha-codex-"));
  const codexCwd = options.isolateCwd ? tempDir : options.codexCwd ?? args.workspace;
  const outputFile = path.join(tempDir, options.outputFileName ?? "last-message.json");
  const codexArgs = [
    "--ask-for-approval",
    "never",
    "--model",
    args.codexModel,
    "--sandbox",
    options.sandbox ?? args.codexSandbox,
    "exec",
    "--ephemeral",
  ];

  if (options.skipGitRepoCheck) {
    codexArgs.push("--skip-git-repo-check");
  }

  if (options.ignoreRules) {
    codexArgs.push("--ignore-rules");
  }

  codexArgs.push(
    "-C",
    codexCwd,
    "--disable",
    "hooks",
    "-c",
    `model_reasoning_effort="${args.codexReasoningEffort}"`,
  );

  if (await exists(schemaPath)) {
    codexArgs.push("--output-schema", schemaPath);
  }

  codexArgs.push(
    "--output-last-message",
    outputFile,
    prompt,
  );

  try {
    const result = await runCommand(args.codexCommand, codexArgs, {
      cwd: codexCwd,
      timeoutMs: Number(options.timeoutMs ?? args.timeoutMs),
    });
    const lastMessage = await readFile(outputFile, "utf8").catch(() => "");
    return {
      ...result,
      stdout: lastMessage.trim() || result.stdout,
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function qmdFallback(args, sourceText, reason) {
  try {
    const recall = await qmdRecall(args, sourceText);
    return weakFallbackFromRows(args, recall.rows, reason);
  } catch (error) {
    return failedAhaResult({
      sourcePath: args.sourcePath,
      summary: "Aha retrieval failed and QMD fallback could not run.",
      warnings: [reason],
      message: "Aha retrieval failed and QMD fallback could not run.",
      tool: "qmd",
      details: error.message,
    });
  }
}

async function codexOrchestrationFailure(args, sourceText, reason) {
  const fallback = await qmdFallback(args, sourceText, reason);
  return {
    ...fallback,
    ok: false,
    summary: "Codex orchestration failed before it could assign reliable relations.",
    warnings: [
      reason,
      "Weak QMD candidates are included only as diagnostics; this search round must be treated as failed.",
    ],
    error: {
      message: "Aha Codex orchestration failed.",
      tool: "codex",
      details: fallback.error?.details ?? reason,
    },
  };
}

async function qmdRecall(args, sourceText) {
  const query = fallbackQmdQuery(args, sourceText);
  const result = await runCommand(args.qmdCommand, [
    "--index",
    "obsidian",
    "query",
    query,
    "-c",
    "obsidian",
    "-n",
    String(args.targetCandidates || 20),
    "--full-path",
    "--line-numbers",
    "--format",
    "json",
  ], { cwd: args.workspace, timeoutMs: Math.min(Number(args.timeoutMs || 300_000), 300_000) });

  if (result.code !== 0) {
    throw new Error(firstLine(result.stderr || result.stdout) || `QMD exited ${result.code}`);
  }

  return { query, rows: extractJsonArray(result.stdout) };
}

async function pipelineRecall(args, sourceText) {
  const plan = await generateQueryPlan(args, sourceText);

  const { queryResults, warnings: queryWarnings, errors } = await runQmdPlanQueries(args, plan.queries.slice(0, 5));
  const graphExpansion = await obsidianGraphExpansion(args);
  if (graphExpansion.rows.length > 0) {
    queryResults.push({
      query: {
        kind: "obsidian_graph",
        command: "obsidian links/backlinks",
      },
      rows: graphExpansion.rows,
    });
  }

  const candidates = (await rerankPipelineCandidates(args, queryResults))
    .slice(0, Number(args.targetCandidates || 20))
    .map((candidate) => pipelineCandidate(candidate));

  if (candidates.length === 0) {
    return failedAhaResult({
      sourcePath: args.sourcePath,
      summary: "Aha mixed retrieval returned no usable candidates.",
      warnings: [
        `Query plan generated by ${plan.query_generated_by}${plan.query_generation_fallback ? ` after fallback: ${plan.query_generation_error}` : ""}.`,
        ...graphExpansion.warnings,
        ...errors.map((error) => `Skipped failed query: ${error}`),
      ],
      message: "Aha retrieval returned no usable candidates.",
      tool: "qmd",
      details: errors.length > 0 ? errors.join("; ") : "QMD and Obsidian graph expansion returned no vault-contained candidates after self-hit and path-boundary filtering.",
    });
  }

  const relationJudge = await judgePipelineCandidates(args, sourceText, candidates);
  const finalCandidates = relationJudge.candidates ?? candidates;
  const warnings = [
    `Query plan generated by ${plan.query_generated_by}${plan.query_generation_fallback ? ` after fallback: ${plan.query_generation_error}` : ""}.`,
    relationJudge.ok
      ? "Relation Judge ran on bounded candidate excerpts; strong relation labels require quote evidence from the excerpt."
      : `Relation Judge unavailable; returning structured failure instead of treating weak candidates as success: ${relationJudge.error}`,
    ...graphExpansion.warnings,
    ...relationJudge.warnings,
    ...queryWarnings,
    ...errors.map((error) => `Skipped failed query: ${error}`),
  ];
  const summary = plan.query_generated_by === "codex"
    ? `Codex generated ${plan.queries.length} QMD queries; mixed retrieval returned ${candidates.length} reranked candidates; Relation Judge reviewed ${relationJudge.reviewedCount} candidate excerpts.`
    : `Rule fallback generated ${plan.queries.length} QMD queries; mixed retrieval returned ${candidates.length} reranked candidates; Relation Judge reviewed ${relationJudge.reviewedCount} candidate excerpts.`;

  if (!relationJudge.ok) {
    return failedAhaResult({
      sourcePath: args.sourcePath,
      summary,
      warnings,
      message: relationJudge.message ?? "Aha Relation Judge failed.",
      tool: relationJudge.tool ?? "codex",
      details: relationJudge.error,
      candidates: finalCandidates.map((candidate) => stripInternalCandidateFields(candidate)),
    });
  }

  return {
    ok: true,
    sourcePath: args.sourcePath,
    generatedAt: new Date().toISOString(),
    summary,
    warnings,
    candidates: finalCandidates.map((candidate) => stripInternalCandidateFields(candidate)),
  };
}

async function obsidianGraphExpansion(args) {
  if (!(await sourceIsVaultBacked(args))) {
    return { rows: [], warnings: [] };
  }

  const warnings = [];
  const seen = new Set();
  const rows = [];
  const sources = [
    ["links", "outlink"],
    ["backlinks", "backlink"],
  ];

  for (const [command, kind] of sources) {
    try {
      const commandArgs = command === "backlinks"
        ? [command, `path=${args.sourcePath}`, "format=json"]
        : [command, `path=${args.sourcePath}`];
      const result = await runCommand(args.obsidianCommand, commandArgs, {
        cwd: args.workspace,
        timeoutMs: 15_000,
      });
      if (result.code !== 0) {
        warnings.push(`Obsidian ${command} expansion skipped: ${firstLine(result.stderr || result.stdout) || `exited ${result.code}`}`);
        continue;
      }
      for (const notePath of parseObsidianPathList(result.stdout)) {
        if (!notePath.endsWith(".md")) continue;
        if (sameNotePath(notePath, args.sourcePath)) continue;
        const key = normalizeNoteIdentity(notePath);
        if (seen.has(key)) continue;
        seen.add(key);
        rows.push({
          score: kind === "backlink" ? 0.18 : 0.14,
          file: `qmd://obsidian/${notePath}?index=obsidian`,
          title: path.basename(notePath, ".md"),
          snippet: `Obsidian ${kind}: ${notePath}`,
        });
      }
    } catch (error) {
      warnings.push(`Obsidian ${command} expansion failed: ${error.message}`);
    }
  }

  return {
    rows,
    warnings,
  };
}

async function sourceIsVaultBacked(args) {
  if (!args.vaultRoot || !args.sourcePath) return false;
  if (args.sourceAbsolutePath) {
    const relative = path.relative(args.vaultRoot, args.sourceAbsolutePath);
    if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) return true;
  }
  return exists(path.join(args.vaultRoot, args.sourcePath));
}

function parseObsidianPathList(output) {
  const text = String(output ?? "").trim();
  if (!text || /^No .* found\./i.test(text)) return [];
  if (text.startsWith("[") || text.startsWith("{")) {
    try {
      return collectPathsFromJson(JSON.parse(text));
    } catch {
      // Fall back to line parsing below.
    }
  }
  return text
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\t|,/)[0]?.trim())
    .filter(Boolean)
    .filter((line) => !/^No .* found\./i.test(line));
}

function collectPathsFromJson(value) {
  if (Array.isArray(value)) return value.flatMap((item) => collectPathsFromJson(item));
  if (!value || typeof value !== "object") return [];
  const direct = [value.path, value.file, value.source, value.sourcePath, value.target, value.targetPath]
    .filter((item) => typeof item === "string");
  return [
    ...direct,
    ...Object.values(value).flatMap((item) => collectPathsFromJson(item)),
  ];
}

async function judgePipelineCandidates(args, sourceText, candidates) {
  const candidateInputs = [];
  const excerptWarnings = [];
  for (const candidate of candidates) {
    const excerpt = await readPipelineCandidateExcerpt(args, candidate);
    if (!excerpt) {
      excerptWarnings.push(`Could not read a vault-contained excerpt for ${candidate.notePath}; relation judging skipped this candidate.`);
      continue;
    }
    candidateInputs.push({
      notePath: candidate.notePath,
      noteTitle: candidate.noteTitle,
      retrievalHit: candidate.hit,
      retrievalWhy: candidate.why,
      excerpt: compactLine(excerpt, 1400),
    });
  }

  if (candidateInputs.length === 0) {
    return {
      ok: false,
      reviewedCount: 0,
      warnings: excerptWarnings,
      message: "Aha Relation Judge had no vault-contained excerpts.",
      tool: "qmd",
      error: "No vault-contained excerpts were readable after the vault realpath boundary check, so Relation Judge did not run.",
      candidates,
    };
  }

  const prompt = buildPipelineRelationJudgePrompt(args, sourceText, candidateInputs);
  try {
    const codexOutput = await runCodex(args, prompt, {
      schemaPath: path.join(args.workspace, "scripts/aha/aha-result.schema.json"),
      outputFileName: "relation-judge.json",
      timeoutMs: Math.min(Number(args.timeoutMs || 300_000), 120_000),
      sandbox: "read-only",
      isolateCwd: true,
      ignoreRules: true,
      skipGitRepoCheck: true,
    });
    if (codexOutput.code !== 0) {
      throw new Error(firstLine(codexOutput.stderr || codexOutput.stdout) || `Codex exited ${codexOutput.code}`);
    }
    const parsed = normalizeStructuredResult(extractCodexJson(codexOutput.stdout));
    const validation = validateAhaResult(parsed);
    if (!validation.ok) {
      throw new Error(validation.errors.join("; "));
    }
    const judged = mergeJudgedCandidates(candidates, parsed.candidates ?? [], candidateInputs);
    return {
      ok: true,
      reviewedCount: candidateInputs.length,
      warnings: [
        ...excerptWarnings,
        ...((parsed.warnings ?? []).map((warning) => `Relation Judge: ${warning}`)),
      ],
      candidates: judged,
    };
  } catch (error) {
    return {
      ok: false,
      reviewedCount: candidateInputs.length,
      warnings: excerptWarnings,
      error: error.message,
      candidates,
    };
  }
}

function buildPipelineRelationJudgePrompt(args, sourceText, candidateInputs) {
  return [
    "You are the bounded Aha Relation Judge.",
    "Do not read files, run tools, or use external knowledge. Judge only from the source summary and candidate excerpts below.",
    "Return JSON only. It must match the output schema.",
    "",
    "Relation rules:",
    "- Use supports, challenges, resembles, or bounds only when the candidate excerpt contains a concrete quote that justifies the label.",
    "- Use weak when the excerpt is only topically similar, too thin, or lacks quote evidence.",
    "- hit must be a short quote or exact snippet from the candidate excerpt.",
    "- why must explain why this old note matters for the current source insight, not just restate retrieval score.",
    "- Preserve the candidate notePath values exactly.",
    "",
    `sourcePath: ${args.sourcePath}`,
    "sourceSummary:",
    queryPlanSourceSummary(args, sourceText).slice(0, 3500),
    "",
    "candidates:",
    JSON.stringify(candidateInputs, null, 2),
    "",
    "Return this JSON shape:",
    JSON.stringify({
      ok: true,
      sourcePath: args.sourcePath,
      generatedAt: null,
      summary: "short relation-judge summary",
      warnings: [],
      error: null,
      candidates: [
        {
          notePath: "same candidate notePath",
          noteTitle: "candidate title",
          relation: "weak",
          hit: "short quote/snippet from excerpt",
          why: "specific relevance explanation",
          quotes: ["optional exact quote from excerpt"],
          selected: true,
        },
      ],
    }, null, 2),
  ].join("\n");
}

function mergeJudgedCandidates(retrievalCandidates, judgedCandidates, candidateInputs) {
  const excerpts = new Map(candidateInputs.map((candidate) => [
    candidate.notePath,
    `${candidate.excerpt}\n${candidate.retrievalHit}`,
  ]));
  const judgedByPath = new Map();
  for (const candidate of judgedCandidates) {
    if (!candidate?.notePath) continue;
    judgedByPath.set(candidate.notePath, candidate);
  }

  return retrievalCandidates.map((retrievalCandidate) => {
    const judged = judgedByPath.get(retrievalCandidate.notePath);
    if (!judged) return retrievalCandidate;
    const merged = {
      ...retrievalCandidate,
      ...judged,
      notePath: retrievalCandidate.notePath,
      noteTitle: judged.noteTitle || retrievalCandidate.noteTitle,
      selected: judged.selected ?? true,
      quotes: Array.isArray(judged.quotes) ? judged.quotes : [],
    };
    return enforceQuoteBackedRelation(merged, excerpts.get(retrievalCandidate.notePath) || "");
  });
}

function enforceQuoteBackedRelation(candidate, excerpt) {
  if (candidate.relation === "weak") return candidate;
  if (hasQuoteEvidence(candidate, excerpt)) return candidate;
  return {
    ...candidate,
    relation: "weak",
    why: `${candidate.why} Downgraded to weak because the bounded excerpt did not contain the returned quote evidence.`,
    quotes: [],
  };
}

function hasQuoteEvidence(candidate, excerpt) {
  const haystack = normalizeEvidenceText(excerpt);
  const haystackFingerprint = evidenceFingerprint(excerpt);
  const needles = [
    candidate.hit,
    ...(Array.isArray(candidate.quotes) ? candidate.quotes : []),
  ]
    .map((value) => normalizeEvidenceText(value).replace(/^["'“”‘’]+|["'“”‘’]+$/g, ""))
    .filter((value) => value.length >= 8);
  return needles.some((needle) => {
    if (haystack.includes(needle)) return true;
    const fingerprint = evidenceFingerprint(needle);
    return fingerprint.length >= 8 && haystackFingerprint.includes(fingerprint);
  });
}

function normalizeEvidenceText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function evidenceFingerprint(value) {
  return String(value ?? "").replace(/[\s\p{P}\p{S}]+/gu, "");
}

async function generateQueryPlan(args, sourceText) {
  const schemaPath = path.join(args.workspace, "scripts/aha/aha-query-plan.schema.json");
  try {
    const codexOutput = await runCodex(args, buildQueryPlanPrompt(args, sourceText), {
      schemaPath,
      outputFileName: "query-plan.json",
      timeoutMs: Math.min(Number(args.timeoutMs || 300_000), 60_000),
      sandbox: "read-only",
      isolateCwd: true,
      ignoreRules: true,
      skipGitRepoCheck: true,
    });
    if (codexOutput.code !== 0) {
      throw new Error(firstLine(codexOutput.stderr || codexOutput.stdout) || `Codex exited ${codexOutput.code}`);
    }
    const plan = normalizeQueryPlan(extractCodexJson(codexOutput.stdout), args, sourceText);
    return {
      ...plan,
      query_generated_by: "codex",
      query_generation_fallback: false,
      query_generation_error: null,
    };
  } catch (error) {
    const plan = buildRuleQueryPlan(args, sourceText);
    return {
      ...plan,
      query_generated_by: "rules",
      query_generation_fallback: true,
      query_generation_error: error.message,
    };
  }
}

function buildQueryPlanPrompt(args, sourceText) {
  const sourceSummary = queryPlanSourceSummary(args, sourceText);
  return [
    "你是 Aha/Pi /insight 的检索查询生成子 agent。",
    "只根据下面 source summary 生成 3-5 条 QMD 检索查询计划；不要读取文件、不要运行命令、不要搜索外部资料、不要检查仓库。",
    "",
    "目标：让 wrapper 后续用 QMD 混合召回旧笔记中的旧判断、反例、边界条件、相似结构和明确线索。",
    "",
    "查询形态：",
    "- raw: 贴近原文的语义检索。",
    "- abstracted_judgment: 抽象出判断结构、关系模式、反例或边界。",
    "- contextual: 保留具体语境，但不引入 source note 之外的新事实。",
    "- explicit_cue: source note 里有明确实体、概念、短语时可用。",
    "- bounds: 主动找不成立、限制条件、相反经验。",
    "",
    "command 选择：",
    "- 默认使用 qmd query，并填写 qmd.intent / qmd.lex / qmd.vec / qmd.hyde。",
    "- raw、abstracted_judgment、contextual、bounds 都使用 qmd query。",
    "- qmd search 只用于非常明确的短实体、概念、原句线索；text 必须是实际搜索短语。",
    "",
    "QMD 字段长度约束：",
    "- lex 最多 4 条，每条是短词或短短语，不要写整句。",
    "- intent 不超过 180 字；vec 不超过 360 字；hyde 不超过 320 字。",
    "- 字段里不要包含换行、项目符号、Markdown 引号或额外的 intent:/lex:/vec:/hyde: 前缀。",
    "",
    "输出必须是 JSON，只包含 queries 字段，并匹配 output schema。",
    `source path: ${args.sourcePath}`,
    "",
    "<source_summary>",
    sourceSummary,
    "</source_summary>",
  ].join("\n");
}

function queryPlanSourceSummary(args, sourceText) {
  const title = path.basename(args.sourcePath || "source", ".md");
  const headings = [...sourceText.matchAll(/^#{1,4}\s+(.+)$/gm)]
    .map((match) => compactLine(match[1], 120))
    .slice(0, 12);
  const wikiLinks = [...sourceText.matchAll(/\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]/g)]
    .map((match) => compactLine(match[1], 80))
    .slice(0, 20);
  const bodyLines = sourceText
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/^---[\s\S]*?---/m, " ")
    .split(/\r?\n/)
    .map((line) => line.replace(/^[-*]\s+/, "").replace(/^\d+\.\s+/, "").trim())
    .filter((line) => line.length >= 12 && line.length <= 220)
    .slice(0, 60);
  return [
    `title: ${title}`,
    headings.length > 0 ? `headings: ${headings.join(" | ")}` : "",
    wikiLinks.length > 0 ? `wiki links: ${wikiLinks.join(" | ")}` : "",
    "salient lines:",
    ...bodyLines.map((line) => `- ${line}`),
  ].filter(Boolean).join("\n").slice(0, 5_000);
}

function normalizeQueryPlan(value, args, sourceText) {
  const rawQueries = Array.isArray(value?.queries) ? value.queries : [];
  const queries = [];
  const seen = new Set();
  for (const item of rawQueries) {
    const query = normalizeQueryPlanItem(item, args, sourceText, queries.length);
    const key = `${query.command}\0${query.query}`;
    if (seen.has(key)) continue;
    seen.add(key);
    queries.push(query);
    if (queries.length >= 5) break;
  }
  if (queries.length < 3) {
    throw new Error("Codex query plan returned fewer than 3 usable queries.");
  }
  return { queries };
}

function normalizeQueryPlanItem(item, args, sourceText, index) {
  const kind = QUERY_PLAN_KINDS.includes(item?.kind) ? item.kind : QUERY_PLAN_KINDS[index] ?? "contextual";
  const command = QUERY_PLAN_COMMANDS.includes(item?.command)
    ? item.command
    : kind === "explicit_cue" ? "qmd search" : "qmd query";
  const qmd = normalizeQmdObject(item?.qmd, args, sourceText);
  const text = compactLine(item?.text || qmd.vec || qmd.lex.join(" "), 300);
  const query = queryTextForCommand(command, text, qmd);
  return {
    kind,
    command,
    text,
    query,
    qmd,
  };
}

function queryTextForCommand(command, text, qmd) {
  if (command === "qmd search") return compactLine(text || qmd.lex.join(" "), 300);
  return qmdQueryFromObject(qmd);
}

function buildRuleQueryPlan(args, sourceText) {
  const base = normalizeQmdObject({}, args, sourceText);
  const raw = compactLine(base.vec, 900);
  const plan = [
    {
      kind: "raw",
      command: "qmd query",
      text: "贴近 source note 原始判断的语义检索",
      qmd: base,
    },
    {
      kind: "abstracted_judgment",
      command: "qmd query",
      text: "抽象判断结构、反例和边界",
      qmd: {
        intent: "召回能支持、挑战或限定当前 insight 判断结构的旧笔记。",
        lex: unique([...base.lex, "旧判断", "反例", "边界条件", "相似结构"]).slice(0, 7),
        vec: raw,
        hyde: "一篇相关旧笔记会记录类似判断如何形成、哪里被现实修正、哪些边界条件让原判断不再成立，以及这种变化如何影响后续选择。",
      },
    },
    {
      kind: "contextual",
      command: "qmd query",
      text: "保留具体语境的结构化语义检索",
      qmd: {
        intent: "召回和当前语境、经历场景、关系模式或行动选择相似的旧笔记。",
        lex: unique([...base.lex, "相似经历", "关系模式", "行动选择"]).slice(0, 7),
        vec: raw,
        hyde: "一篇相关旧笔记会包含相似场景中的真实经历、情绪线索、关系互动或行动取舍，能帮助用户比较这一次 insight 和过去经验之间的结构关系。",
      },
    },
    {
      kind: "explicit_cue",
      command: "qmd search",
      text: base.lex.slice(0, 4).join(" "),
      qmd: {
        intent: "召回 source note 中明确短语、概念或实体对应的旧笔记。",
        lex: base.lex,
        vec: raw,
        hyde: base.hyde,
      },
    },
  ];
  return {
    queries: plan.map((item, index) => normalizeQueryPlanItem(item, args, sourceText, index)),
  };
}

function normalizeQmdObject(value, args, sourceText) {
  const fallback = fallbackQmdObject(args, sourceText);
  const lex = unique(Array.isArray(value?.lex) ? [...value.lex, ...fallback.lex] : fallback.lex)
    .map((item) => sanitizeQmdLine(item, MAX_QMD_LEX_CHARS))
    .filter((item) => item.length >= 2)
    .slice(0, MAX_QMD_LEX_TERMS);
  return {
    intent: sanitizeQmdLine(value?.intent || fallback.intent, MAX_QMD_INTENT_CHARS),
    lex: lex.length > 0 ? lex : fallback.lex.slice(0, MAX_QMD_LEX_TERMS),
    vec: sanitizeQmdLine(value?.vec || fallback.vec, MAX_QMD_VEC_CHARS),
    hyde: sanitizeQmdLine(value?.hyde || fallback.hyde, MAX_QMD_HYDE_CHARS),
  };
}

function fallbackQmdObject(args, sourceText) {
  const title = path.basename(args.sourcePath || "source", ".md");
  const heading = sourceText.match(/^#{1,3}\s+(.+)$/m)?.[1]?.trim() || title;
  const wikiLinks = [...sourceText.matchAll(/\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]/g)]
    .map((match) => match[1].trim())
    .filter(Boolean);
  const lineSignals = sourceText
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/^---[\s\S]*?---/m, " ")
    .split(/\r?\n/)
    .map((line) => line.replace(/^#+\s*/, "").trim())
    .filter((line) => line.length > 12 && line.length < 180);
  const lex = unique([heading, title, ...wikiLinks, ...lineSignals.flatMap((line) => line.split(/[，。；;、,.!?！？|/（）()【】\[\]《》<>：:\s]+/).slice(0, 2))])
    .filter((item) => item.length >= 2 && item.length <= 48)
    .slice(0, 7);
  const vec = lineSignals.slice(0, 6).join(" ") || heading;
  return {
    intent: "召回与当前 Aha insight/source note 相关的旧判断、反例、边界和相似结构。",
    lex: lex.slice(0, MAX_QMD_LEX_TERMS),
    vec: compactLine(vec, MAX_QMD_VEC_CHARS),
    hyde: `一篇旧笔记讨论与「${heading}」相关的经验、判断变化、产品边界或记忆检索线索。`,
  };
}

function sanitizeQmdLine(value, maxLength) {
  return compactLine(value, maxLength)
    .replace(/^(?:intent|lex|vec|hyde)\s*:\s*/i, "")
    .replace(/["`]+/g, "'")
    .replace(/^[*-]\s+/, "")
    .trim();
}

function qmdQueryFromObject(qmd) {
  return [
    `intent: ${qmd.intent}`,
    ...qmd.lex.map((item) => `lex: ${item}`),
    `vec: ${qmd.vec}`,
    `hyde: ${qmd.hyde}`,
  ].join("\n");
}

async function runQmdPlanQuery(args, query) {
  const timeoutMs = qmdQueryTimeoutMs(args);
  try {
    return await runQmdPlanQueryCommand(args, query, { timeoutMs });
  } catch (error) {
    if (!isQmdRetryableTimeout(error, query)) throw error;
    try {
      const result = await runQmdPlanQueryCommand(args, query, { timeoutMs });
      return {
        ...result,
        warning: `${query.kind}/${query.command} timed out once (${error.message}); retry succeeded with qmd query.`,
      };
    } catch (retryError) {
      throw new Error(`${error.message}; retry failed: ${retryError.message}`);
    }
  }
}

async function runQmdPlanQueryCommand(args, query, options) {
  const command = String(query.command || "qmd query");
  const subcommand = command.startsWith("qmd search")
    ? "search"
    : "query";
  const text = query.query || query.text;
  const result = await runCommand(args.qmdCommand, [
    "--index",
    "obsidian",
    subcommand,
    text,
    "-c",
    "obsidian",
    "-n",
    String(Math.max(Number(args.targetCandidates || 20), 15)),
    "-C",
    String(qmdCandidateLimit(args)),
    "--full-path",
    "--line-numbers",
    "--format",
    "json",
  ], { cwd: args.workspace, timeoutMs: options.timeoutMs });

  if (result.code !== 0) {
    throw new Error(firstLine(result.stderr || result.stdout) || `QMD exited ${result.code}`);
  }

  return {
    query,
    rows: extractJsonArray(result.stdout),
  };
}

function qmdQueryTimeoutMs(args) {
  return Math.min(Number(args.timeoutMs || 300_000), Number(args.qmdQueryTimeoutMs || DEFAULT_QMD_QUERY_TIMEOUT_MS));
}

function qmdCandidateLimit(args) {
  return Math.max(Number(args.targetCandidates || DEFAULT_QMD_CANDIDATE_LIMIT), DEFAULT_QMD_CANDIDATE_LIMIT);
}

function isQmdRetryableTimeout(error, query) {
  const command = String(query.command || "qmd query");
  return command === "qmd query" && String(error?.message ?? error).includes("timed out after");
}

async function runQmdPlanQueries(args, queries) {
  const settled = [];
  for (const query of queries) {
    try {
      settled.push({ ok: true, result: await runQmdPlanQuery(args, query) });
    } catch (error) {
      settled.push({ ok: false, error: `${query.kind}/${query.command}: ${error.message}` });
    }
  }
  return {
    queryResults: settled.filter((item) => item.ok).map((item) => item.result),
    warnings: settled.filter((item) => item.ok && item.result.warning).map((item) => item.result.warning),
    errors: settled.filter((item) => !item.ok).map((item) => item.error),
  };
}

async function rerankPipelineCandidates(args, queryResults) {
  const byPath = new Map();
  for (const queryResult of queryResults) {
    for (const [index, row] of queryResult.rows.entries()) {
      const notePath = notePathForObsidian(args, row);
      if (!(await isCandidatePathAllowed(args, notePath, row))) continue;
      if (isSourceCandidate(args, notePath, row)) continue;
      if (isGeneratedReviewCandidate(args, notePath, row)) continue;
      const existing = byPath.get(notePath) ?? {
        notePath,
        noteTitle: typeof row.title === "string" && row.title.trim()
          ? row.title.trim()
          : path.basename(notePath, ".md"),
        hit: firstSnippetLine(row.snippet) || `QMD score ${row.score ?? "unknown"}`,
        bestScore: 0,
        rankScore: 0,
        queryKinds: new Set(),
        commands: new Set(),
        rawLocations: new Set(),
        sources: [],
      };
      const score = Number(row.score ?? 0);
      existing.bestScore = Math.max(existing.bestScore, Number.isFinite(score) ? score : 0);
      existing.rankScore += 1 / (index + 1);
      existing.queryKinds.add(queryResult.query.kind);
      existing.commands.add(queryResult.query.command);
      for (const location of [row.file, row.path, row.uri]) {
        if (typeof location === "string" && location.trim()) existing.rawLocations.add(location.trim());
      }
      existing.sources.push({
        kind: queryResult.query.kind,
        command: queryResult.query.command,
        rank: index + 1,
        score: Number.isFinite(score) ? score : null,
      });
      byPath.set(notePath, existing);
    }
  }

  return [...byPath.values()]
    .map((candidate) => {
      const diversity = candidate.queryKinds.size * 0.12 + candidate.commands.size * 0.04;
      return {
        ...candidate,
        finalScore: candidate.bestScore + candidate.rankScore * 0.18 + diversity,
      };
    })
    .sort((a, b) => b.finalScore - a.finalScore);
}

function pipelineCandidate(candidate) {
  const kinds = [...candidate.queryKinds].filter(Boolean);
  const commands = [...candidate.commands].filter(Boolean);
  const strongest = candidate.sources
    .slice()
    .sort((a, b) => (a.rank ?? 999) - (b.rank ?? 999))
    .slice(0, 3)
    .map((source) => `${source.kind}/${source.command}#${source.rank}`)
    .join(", ");
  return {
    notePath: candidate.notePath,
    noteTitle: candidate.noteTitle,
    relation: "weak",
    hit: candidate.hit,
    why: `Mixed QMD retrieval ranked this candidate from ${kinds.length} query kind(s) (${kinds.join(", ")}) via ${commands.join(", ")}. Strongest retrieval signals: ${strongest}. Relation is weak pending quote-backed judging.`,
    quotes: [],
    selected: true,
    _rawLocations: [...candidate.rawLocations],
  };
}

async function buildRelationJudgePrompt(args, sourceText, rows) {
  const candidates = [];
  for (const row of rows.slice(0, Number(args.targetCandidates || 20))) {
    candidates.push({
      notePath: notePathForObsidian(args, row),
      noteTitle: typeof row.title === "string" ? row.title : undefined,
      snippet: typeof row.snippet === "string" ? row.snippet.slice(0, 1600) : "",
      excerpt: await readCandidateExcerpt(args, row),
    });
  }

  return [
    "You are the Aha Relation Judge for an Obsidian plugin MVP.",
    "Do not run shell commands. Judge only from the source note and candidate excerpts below.",
    "Return JSON only. Use supports, challenges, resembles, bounds, or weak.",
    "Use supports/challenges/resembles/bounds only when the candidate excerpt contains quote evidence. Otherwise use weak.",
    "The hit field must be a short quote or concrete snippet from the candidate excerpt.",
    "The why field should explain why this old note is worth reading for the current insight.",
    "",
    `Source path: ${args.sourcePath}`,
    "Source excerpt:",
    "```markdown",
    sourceText.slice(0, 8000),
    "```",
    "",
    "Candidates:",
    JSON.stringify(candidates, null, 2),
    "",
    "Required JSON shape:",
    JSON.stringify({
      ok: true,
      sourcePath: args.sourcePath,
      summary: "one sentence summary",
      warnings: [],
      error: null,
      candidates: [
        {
          notePath: "candidate path",
          noteTitle: "candidate title",
          relation: "weak",
          hit: "short quote/snippet",
          why: "specific reason",
          quotes: ["optional quote"],
          selected: true,
        },
      ],
    }, null, 2),
  ].join("\n");
}

async function readCandidateExcerpt(args, row) {
  const notePath = String(row.file ?? row.path ?? row.uri ?? "");
  if (!notePath) return "";
  try {
    if (isObsidianQmdUri(notePath)) {
      const filePath = await qmdUriVaultPath(args, notePath);
      if (filePath) return (await readFile(filePath, "utf8")).slice(0, 1200);
    }
    const filePath = await resolveVaultContainedPath(args, notePath);
    if (filePath) {
      return (await readFile(filePath, "utf8")).slice(0, 1200);
    }
  } catch {
    return "";
  }
  return "";
}

async function readPipelineCandidateExcerpt(args, candidate) {
  const raw = String(candidate.notePath ?? "");
  if (!raw) return "";
  const locations = unique([
    ...(Array.isArray(candidate._rawLocations) ? candidate._rawLocations : []),
    raw,
  ]);

  for (const location of locations) {
    if (isObsidianQmdUri(location)) {
      try {
        const filePath = await qmdUriVaultPath(args, location);
        if (filePath) return excerptMarkdown(await readFile(filePath, "utf8"));
      } catch {
        // Try the next plausible location.
      }
      continue;
    }

    try {
      const filePath = await resolveVaultContainedPath(args, location);
      if (filePath) return excerptMarkdown(await readFile(filePath, "utf8"));
    } catch {
      // Try the next plausible path.
    }
  }
  return "";
}

async function resolveVaultContainedPath(args, location) {
  if (!args.vaultRoot || !location || /^qmd:\/\//i.test(String(location))) return "";
  if (!path.isAbsolute(location) && !isSafeVaultRelativePath(location)) return "";
  const candidatePath = path.isAbsolute(location)
    ? location
    : path.resolve(args.vaultRoot, location);
  const [vaultRealPath, candidateRealPath] = await Promise.all([
    realpath(args.vaultRoot),
    realpath(candidatePath),
  ]);
  return pathIsInside(vaultRealPath, candidateRealPath) ? candidateRealPath : "";
}

async function resolveSourceFilePath(args) {
  return resolveVaultContainedPath(args, args.sourceAbsolutePath || args.sourcePath);
}

async function isCandidatePathAllowed(args, notePath, row) {
  const rawLocations = [row.file, row.path, row.uri]
    .filter((value) => typeof value === "string")
    .map((value) => value.trim())
    .filter(Boolean);
  if (rawLocations.length === 0) {
    return Boolean(await resolveVaultContainedPath(args, notePath).catch(() => ""));
  }

  for (const location of rawLocations) {
    if (isObsidianQmdUri(location)) {
      if (await qmdUriVaultPath(args, location).catch(() => "")) return true;
      continue;
    }
    if (await resolveVaultContainedPath(args, location).catch(() => "")) return true;
  }
  return false;
}

function isObsidianQmdUri(value) {
  return /^qmd:\/\/obsidian\//i.test(String(value ?? ""));
}

async function qmdUriVaultPath(args, value) {
  const notePath = notePathForObsidian(args, { file: value });
  return resolveVaultContainedPath(args, notePath);
}

function isSafeVaultRelativePath(value) {
  const raw = String(value ?? "").replace(/\\/g, "/").trim();
  if (!raw || path.isAbsolute(raw)) return false;
  const normalized = path.posix.normalize(raw);
  return normalized !== "." && normalized !== ".." && !normalized.startsWith("../");
}

function pathIsInside(basePath, candidatePath) {
  const relative = path.relative(path.resolve(basePath), path.resolve(candidatePath));
  return relative === "" || (relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function stripInternalCandidateFields(candidate) {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return candidate;
  const { _rawLocations, ...publicCandidate } = candidate;
  return publicCandidate;
}

function excerptMarkdown(markdown) {
  return String(markdown ?? "")
    .replace(/^qmd:\/\/[^\n]+\n(?:Folder Context:[^\n]*\n)?---\n?/m, "")
    .replace(/^---[\s\S]*?---\s*/m, "")
    .split(/\r?\n/)
    .map((line) => line.replace(/^\d+:\s?/, "").trimEnd())
    .filter((line) => line.trim() && !/^(create|cssclasses|tags|categories|emotion):\s*/.test(line.trim()))
    .slice(0, 60)
    .join("\n")
    .slice(0, 1800);
}

function weakFallbackFromRows(args, rows, reason) {
  const candidates = rows.slice(0, Number(args.targetCandidates || 20)).map((row) => fallbackCandidate(args, row));
  return {
    ok: true,
    sourcePath: args.sourcePath,
    generatedAt: new Date().toISOString(),
    summary: `Returned ${candidates.length} direct QMD recall candidates.`,
    warnings: [
      reason,
      "Fallback candidates are direct QMD recall results. Relation labels are weak unless later judged by Codex.",
    ],
    candidates,
  };
}

function relationJudgeFailureFromRows(args, rows, reason) {
  const fallback = weakFallbackFromRows(args, rows, reason);
  return {
    ...fallback,
    ok: false,
    summary: "Aha retrieved QMD candidates, but Relation Judge failed before it could assign reliable relations.",
    warnings: [
      reason,
      "Weak QMD candidates are included only as diagnostics; this search round must be treated as failed.",
    ],
    error: {
      message: "Aha Relation Judge failed.",
      tool: "codex",
      details: reason,
    },
  };
}

function fallbackQmdQuery(args, sourceText) {
  const title = path.basename(args.sourcePath || "source", ".md");
  const heading = sourceText.match(/^#{1,3}\s+(.+)$/m)?.[1]?.trim() || title;
  const wikiLinks = [...sourceText.matchAll(/\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]/g)]
    .map((match) => match[1].trim())
    .filter(Boolean);
  const lex = unique([heading, title, ...wikiLinks]).slice(0, 5);
  const vec = sourceText
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/^---[\s\S]*?---/m, " ")
    .split(/\r?\n/)
    .map((line) => line.replace(/^#+\s*/, "").trim())
    .filter((line) => line.length > 12 && line.length < 180)
    .slice(0, 6)
    .join(" ");

  return [
    `intent: 召回与当前 Aha insight/source note 相关的旧判断、反例、边界和相似结构。`,
    ...lex.map((item) => `lex: ${item}`),
    `vec: ${(vec || heading).slice(0, 500)}`,
    `hyde: 一篇旧笔记讨论与「${heading}」相关的经验、判断变化、产品边界或记忆检索线索。`,
  ].join("\n");
}

function fallbackCandidate(args, row) {
  const notePath = notePathForObsidian(args, row);
  const noteTitle = typeof row.title === "string" && row.title.trim()
    ? row.title.trim()
    : path.basename(notePath.replace(/^qmd:\/\/[^/]+\//, "").replace(/\?index=.*$/, ""), ".md");
  return {
    notePath,
    noteTitle,
    relation: "weak",
    hit: firstSnippetLine(row.snippet) || `QMD score ${row.score ?? "unknown"}`,
    why: "Direct QMD recall surfaced this note as a candidate; relation is marked weak pending Codex judging.",
    quotes: [],
    selected: true,
  };
}

function extractJsonArray(output) {
  const start = output.indexOf("[");
  const end = output.lastIndexOf("]");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("QMD output did not include a JSON array.");
  }
  return JSON.parse(output.slice(start, end + 1));
}

function firstSnippetLine(snippet) {
  if (typeof snippet !== "string") return "";
  return snippet
    .split(/\r?\n/)
    .map((line) => line.replace(/^\d+:\s*/, "").trim())
    .find((line) =>
      line &&
      !line.startsWith("@@") &&
      line !== "---" &&
      !/^(create|cssclasses|tags|categories|emotion):\s*/.test(line)
    ) ?? "";
}

function unique(values) {
  return [...new Set(values.map((value) => String(value ?? "").trim()).filter(Boolean))];
}

function compactLine(value, max = 900) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trim()}...`;
}

function isSourceCandidate(args, notePath, row) {
  if (sameNotePath(notePath, args.sourcePath)) return true;
  const rawPaths = [row.file, row.path, row.uri]
    .filter((value) => typeof value === "string")
    .map((value) => value.trim());
  return rawPaths.some((value) => {
    if (sameNotePath(notePathForObsidian(args, { file: value }), args.sourcePath)) return true;
    if (path.isAbsolute(value) && args.sourceAbsolutePath && path.resolve(value) === path.resolve(args.sourceAbsolutePath)) return true;
    return false;
  });
}

function isGeneratedReviewCandidate(args, notePath, row) {
  const rawPaths = [notePath, row.file, row.path, row.uri]
    .filter((value) => typeof value === "string")
    .map((value) => notePathForObsidian(args, { file: value.trim() }));
  if (args.reviewPath && rawPaths.some((value) => sameNotePath(value, args.reviewPath))) return true;
  return rawPaths.some((value) => {
    const normalized = normalizeNoteIdentity(value);
    return normalized === "aha/reviews" || normalized.startsWith("aha/reviews/");
  });
}

function safeCaseId(value) {
  return String(value || "source").replace(/[^a-zA-Z0-9_.-]+/g, "-").slice(0, 80) || "source";
}

function extractCodexJson(stdout) {
  const trimmed = stdout.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    return JSON.parse(trimmed);
  }

  const begin = stdout.indexOf(JSON_BEGIN);
  const end = stdout.lastIndexOf(JSON_END);
  if (begin === -1 || end === -1 || end <= begin) {
    throw new Error("Codex output did not include AHA_RESULT_JSON markers.");
  }
  const json = stdout.slice(begin + JSON_BEGIN.length, end).trim();
  return JSON.parse(json);
}

function normalizeStructuredResult(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const normalized = { ...value };
  for (const key of ["sourcePath", "generatedAt", "summary", "warnings", "error", "candidates"]) {
    if (normalized[key] === null) delete normalized[key];
  }
  if (Array.isArray(normalized.candidates)) {
    normalized.candidates = normalized.candidates.map((candidate) => {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return candidate;
      const next = { ...candidate };
      for (const key of ["noteTitle", "quotes", "selected"]) {
        if (next[key] === null) delete next[key];
      }
      return next;
    });
  }
  if (normalized.error && typeof normalized.error === "object" && !Array.isArray(normalized.error)) {
    normalized.error = { ...normalized.error };
    for (const key of ["tool", "details"]) {
      if (normalized.error[key] === null) delete normalized.error[key];
    }
  }
  return normalized;
}

async function exists(filePath) {
  try {
    await access(filePath, fsConstants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function runCommand(command, args, options = {}) {
  const timeoutMs = Number(options.timeoutMs ?? 900_000);
  const maxOutputBytes = Number(options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: process.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill("SIGTERM");
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }, 1_000).unref();
      reject(error);
    };
    const timer = setTimeout(() => {
      fail(new Error(`${command} timed out after ${timeoutMs}ms.`));
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      stdoutBytes += Buffer.byteLength(text);
      if (stdoutBytes > maxOutputBytes) {
        fail(new Error(`${command} stdout exceeded ${maxOutputBytes} bytes.`));
        return;
      }
      stdout += text;
    });
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderrBytes += Buffer.byteLength(text);
      if (stderrBytes > maxOutputBytes) {
        fail(new Error(`${command} stderr exceeded ${maxOutputBytes} bytes.`));
        return;
      }
      stderr += text;
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

function parseArgs(rawArgs) {
  const args = {
    checkReadiness: false,
    codexCommand: "codex",
    codexModel: "gpt-5.3-codex-spark",
    codexReasoningEffort: "low",
    codexSandbox: "danger-full-access",
    fixture: "",
    obsidianCommand: "obsidian",
    qmdCommand: "qmd",
    reviewPath: "",
    qmdQueryTimeoutMs: DEFAULT_QMD_QUERY_TIMEOUT_MS,
    sourceAbsolutePath: "",
    sourcePath: "",
    strategy: "pipeline",
    targetCandidates: 20,
    timeoutMs: 900_000,
    vaultRoot: "",
    workspace: process.cwd(),
  };

  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index];
    const next = () => rawArgs[++index] ?? "";
    switch (arg) {
      case "--check-readiness":
        args.checkReadiness = true;
        break;
      case "--codex-command":
        args.codexCommand = next();
        break;
      case "--codex-model":
        args.codexModel = next();
        break;
      case "--codex-reasoning-effort":
        args.codexReasoningEffort = next();
        break;
      case "--codex-sandbox":
        args.codexSandbox = next();
        break;
      case "--fixture":
        args.fixture = next();
        break;
      case "--obsidian-command":
        args.obsidianCommand = next();
        break;
      case "--qmd-command":
        args.qmdCommand = next();
        break;
      case "--review-path":
        args.reviewPath = next();
        break;
      case "--qmd-query-timeout-ms":
        args.qmdQueryTimeoutMs = Number(next());
        break;
      case "--source-absolute-path":
        args.sourceAbsolutePath = next();
        break;
      case "--source-path":
        args.sourcePath = next();
        break;
      case "--strategy":
        args.strategy = next();
        break;
      case "--target-candidates":
        args.targetCandidates = Number(next());
        break;
      case "--timeout-ms":
        args.timeoutMs = Number(next());
        break;
      case "--vault-root":
        args.vaultRoot = next();
        break;
      case "--workspace":
        args.workspace = next();
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  args.workspace = path.resolve(args.workspace);
  if (args.vaultRoot) args.vaultRoot = path.resolve(args.vaultRoot);
  args.targetCandidates = clampTargetCandidates(args.targetCandidates);
  args.qmdQueryTimeoutMs = clampPositiveInteger(args.qmdQueryTimeoutMs, DEFAULT_QMD_QUERY_TIMEOUT_MS);
  return args;
}

function clampTargetCandidates(value) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed)) return MAX_TARGET_CANDIDATES;
  return Math.min(MAX_TARGET_CANDIDATES, Math.max(MIN_TARGET_CANDIDATES, parsed));
}

function clampPositiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function emitJson(value, exitCode = 0) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  process.exit(exitCode);
}

function failedAhaResult({
  sourcePath,
  summary,
  warnings = [],
  message,
  tool,
  details,
  candidates = [],
}) {
  const detailText = String(details || message);
  return {
    ok: false,
    sourcePath,
    generatedAt: new Date().toISOString(),
    summary,
    warnings,
    error: {
      message,
      tool,
      details: detailText,
    },
    candidates,
  };
}

function firstLine(value) {
  return String(value ?? "").split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "";
}
