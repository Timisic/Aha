// Node implementations of the shared-core dependency seam (ADR 0005).
// Bench scripts inject these into core entry points so the compiled core
// stays free of node imports while behaving exactly like the legacy
// scripts/aha/lib modules it replaces.

import { existsSync, readdirSync, statSync } from "node:fs";
import { realpath, readdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_MAX_OUTPUT_BYTES = 5 * 1024 * 1024;
const DEFAULT_QMD_CANDIDATE_LIMIT = 20;

export const coreNodeDeps = {
  path: {
    isAbsolute: (value) => path.isAbsolute(value),
    relative: (from, to) => path.relative(from, to),
    resolve: (...segments) => path.resolve(...segments),
    basename: (value, ext) => (ext === undefined ? path.basename(value) : path.basename(value, ext)),
  },
  fs: {
    exists: (absolutePath) => existsSync(absolutePath),
    statIsFile: (absolutePath) => statSync(absolutePath).isFile(),
    listDir: (absolutePath) => readdirSync(absolutePath, { withFileTypes: true }).map((entry) => ({
      name: entry.name,
      isDirectory: entry.isDirectory(),
      isFile: entry.isFile(),
    })),
  },
};

// Vault-boundary deps for candidates.ts / pool.ts (isCandidatePathAllowed,
// resolveVaultContainedPath, isSafeVaultRelativePath, pathIsInside).
export const coreVaultBoundaryDeps = {
  path: coreNodeDeps.path,
  posixNormalize: (value) => path.posix.normalize(value),
  realpath: (absolutePath) => realpath(absolutePath),
  listDirectory: (absolutePath) => readdir(absolutePath),
};

// --- LLM transport deps (issue #57) ---
//
// Node binding for llm-transport.ts's llmJsonCall: a fetch-based HTTP POST
// (Node 25 ships a global fetch; see esbuild.config.mjs's core "platform:
// neutral" build, which never touches this file) plus a setTimeout-based
// sleep. This intentionally does NOT shell out to curl the way the legacy
// scripts/lib/openai-json-agent.mjs did — the entire point of the #55/#57
// migration is moving off a subprocess-per-call transport. Known gap: unlike
// openai-json-agent.mjs's curl path, this does not consult HTTPS_PROXY /
// scripts/lib/https-proxy.mjs; Node's global fetch does not honor proxy env
// vars without an extra dependency (undici's ProxyAgent, not currently a
// project dependency). Bench/plugin traffic in this migration's environment
// does not require a proxy; if one becomes necessary, add undici as a
// dependency and wire a ProxyAgent dispatcher in here, not in core.
export async function coreHttpJsonPost(url, headers, body, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body,
      signal: controller.signal,
    });
    const bodyText = await response.text();
    return { status: response.status, bodyText };
  } finally {
    clearTimeout(timer);
  }
}

export function coreSleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

export const coreLlmTransportDeps = {
  httpPost: coreHttpJsonPost,
  sleep: coreSleep,
};

function firstLine(value) {
  return String(value ?? "").split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "";
}

function childCommandEnvironment(sensitiveEnvName) {
  const env = { ...process.env };
  if (sensitiveEnvName) delete env[sensitiveEnvName];
  return env;
}

// Verbatim port of the bounded async spawn helper (`runCommand`) in the
// frozen legacy wrapper scripts/aha/run-insight-search.mjs: closed stdin,
// a hard timeout that SIGTERMs then SIGKILLs the child, and output-size
// bounding on both stdout and stderr.
function runCommandBounded(command, args, options = {}) {
  const timeoutMs = Number(options.timeoutMs ?? 900_000);
  const maxOutputBytes = Number(options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: childCommandEnvironment(options.sensitiveEnvName),
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

// --- Obsidian graph expansion (ADR 0005 follow-up) ---
//
// Verbatim port of obsidianGraphExpansion's I/O half from the frozen legacy
// wrapper scripts/aha/run-insight-search.mjs: shells out to the `obsidian`
// CLI for `links`/`backlinks`, parsing either JSON or line-oriented output.
// Row-shaping (scores, qmd:// URIs, dedup) lives in core's graph-expansion.ts
// -- this only resolves the raw neighbor list.

async function sourceIsVaultBacked(config, sourcePath) {
  if (!config.vaultRoot || !sourcePath) return false;
  if (config.sourceAbsolutePath) {
    const relative = path.relative(config.vaultRoot, config.sourceAbsolutePath);
    if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) return true;
  }
  return existsSync(path.join(config.vaultRoot, sourcePath));
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

/**
 * Builds core's OrchestratorDeps.listGraphNeighbors: `config` closes over the
 * Node/CLI-specific configuration (obsidianCommand, workspace, vaultRoot,
 * sourceAbsolutePath, sensitiveEnvName) the way the legacy wrapper closed
 * over `args`. Best-effort per direction (links/backlinks independently), a
 * failed direction becomes a warning rather than aborting the other.
 */
export function createObsidianGraphNeighborsRunner(config) {
  return async function listGraphNeighbors(sourcePath) {
    if (!(await sourceIsVaultBacked(config, sourcePath))) {
      return { neighbors: [], warnings: [] };
    }

    const warnings = [];
    const neighbors = [];
    const sources = [
      ["links", "outlink"],
      ["backlinks", "backlink"],
    ];

    for (const [command, kind] of sources) {
      try {
        const commandArgs = command === "backlinks"
          ? [command, `path=${sourcePath}`, "format=json"]
          : [command, `path=${sourcePath}`];
        const result = await runCommandBounded(config.obsidianCommand, commandArgs, {
          cwd: config.workspace,
          sensitiveEnvName: config.sensitiveEnvName,
          timeoutMs: 15_000,
        });
        if (result.code !== 0) {
          warnings.push(`Obsidian ${command} expansion skipped: ${firstLine(result.stderr || result.stdout) || `exited ${result.code}`}`);
          continue;
        }
        for (const notePath of parseObsidianPathList(result.stdout)) {
          neighbors.push({ notePath, kind });
        }
      } catch (error) {
        warnings.push(`Obsidian ${command} expansion failed: ${error.message}`);
      }
    }

    return { neighbors, warnings };
  };
}

function qmdCandidateLimit(config) {
  return Math.max(Number(config.targetCandidates || DEFAULT_QMD_CANDIDATE_LIMIT), DEFAULT_QMD_CANDIDATE_LIMIT);
}

// Verbatim port of the argv construction in runQmdPlanQueryCommand.
export function buildQmdCommandArgv(query, config) {
  const command = String(query.command || "qmd query");
  const subcommand = command.startsWith("qmd search") ? "search" : "query";
  const text = query.query || query.text;
  const commandArgs = [
    "--index",
    config.qmdIndex,
    subcommand,
    text,
    "-c",
    config.qmdIndex,
    "-n",
    String(Math.max(Number(config.targetCandidates || 20), 15)),
    "-C",
    String(qmdCandidateLimit(config)),
    "--full-path",
    "--line-numbers",
    "--format",
    "json",
  ];
  if (subcommand === "query" && !config.qmdRerank) {
    commandArgs.push("--no-rerank");
  }
  return commandArgs;
}

/**
 * Builds the `runQmdQuery` dep that core's qmd.ts orchestration calls per
 * query. `config` closes over the Node/CLI-specific configuration (qmdCommand,
 * qmdIndex, targetCandidates, qmdRerank, workspace, sensitiveEnvName) the way
 * the legacy wrapper closed over `args`. Resolves with raw stdout text (core
 * owns row parsing); rejects with an Error including "timed out after" on a
 * timeout so core's retry-on-timeout policy can recognize it, or with the
 * QMD CLI's own failure message on a non-zero exit.
 */
export function createQmdCliRunner(config) {
  return {
    async runQmdQuery(query, timeoutMs) {
      const commandArgs = buildQmdCommandArgv(query, config);
      const result = await runCommandBounded(config.qmdCommand, commandArgs, {
        cwd: config.workspace,
        sensitiveEnvName: config.sensitiveEnvName,
        timeoutMs,
      });
      if (result.code !== 0) {
        throw new Error(firstLine(result.stderr || result.stdout) || `QMD exited ${result.code}`);
      }
      return result.stdout;
    },
  };
}

// --- QMD SDK runner (verbatim port of the frozen legacy wrapper's
// runQmdPlanQuerySdk / loadQmdSdk / qmdSdkCandidates family) ---
//
// "sdk" is DEFAULT_QMD_RUNNER in the legacy wrapper and settings.ts's
// DEFAULT_SETTINGS.qmdRunner, so this is the runner the plugin's #58
// legacy-wrapper rollback path actually exercises by default. core's qmd.ts
// only knows a text-in/text-out `runQmdQuery(query, timeoutMs): Promise<string>`
// contract (it parses rows out of stdout-shaped text via extractQmdRows), so
// this JSON.stringifies the SDK's row array back into that same shape --
// core's bracket-matching parse round-trips it losslessly.

const COMMON_COMMAND_DIRS = [
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/usr/bin",
  "/bin",
  "/usr/sbin",
  "/sbin",
  path.join(homedir(), ".local/bin"),
  path.join(homedir(), ".npm-global/bin"),
  path.join(homedir(), ".bun/bin"),
];

function withTimeout(promise, timeoutMs, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

function uniqueValues(values) {
  return [...new Set(values)];
}

function uniqueBy(values, keyFn) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const key = keyFn(value);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

async function resolveCommandPath(command) {
  const raw = String(command || "").trim();
  if (!raw) return "";
  const candidates = raw.includes("/") || path.isAbsolute(raw)
    ? [raw]
    : uniqueValues([...(process.env.PATH || "").split(path.delimiter), ...COMMON_COMMAND_DIRS]).map((dir) => path.join(dir, raw));
  for (const candidate of candidates) {
    try {
      return await realpath(candidate);
    } catch {
      // Try the next PATH entry.
    }
  }
  return "";
}

async function inferQmdSdkModuleFromCommand(command) {
  const commandPath = await resolveCommandPath(command);
  if (!commandPath) return "";
  const packageRoot = path.resolve(path.dirname(commandPath), "..");
  const sdkModule = path.join(packageRoot, "dist", "index.js");
  return existsSync(sdkModule) ? sdkModule : "";
}

async function importModuleSpecifier(specifier) {
  if (/^file:\/\//i.test(specifier) || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(specifier)) {
    return import(specifier);
  }
  if (path.isAbsolute(specifier) || specifier.startsWith(".")) {
    return import(pathToFileURL(path.resolve(specifier)).href);
  }
  return import(specifier);
}

async function qmdSdkCandidatesFor(config) {
  const candidates = [];
  if (config.qmdSdkModule) {
    candidates.push({ label: config.qmdSdkModule, specifier: config.qmdSdkModule });
  }
  candidates.push({ label: "@tobilu/qmd", specifier: "@tobilu/qmd" });
  const inferred = await inferQmdSdkModuleFromCommand(config.qmdCommand);
  if (inferred) {
    candidates.push({ label: inferred, specifier: inferred });
  }
  return uniqueBy(candidates, (candidate) => candidate.specifier);
}

async function loadQmdSdk(config) {
  const candidates = await qmdSdkCandidatesFor(config);
  const errors = [];
  for (const candidate of candidates) {
    try {
      const module = await importModuleSpecifier(candidate.specifier);
      return { module, source: candidate.label };
    } catch (error) {
      errors.push(`${candidate.label}: ${error.message}`);
    }
  }
  throw new Error(errors.length > 0 ? errors.join("; ") : "No QMD SDK module candidate could be resolved.");
}

function qmdDbPath(config) {
  return expandHome(config.qmdDbPath || path.join(process.env.XDG_CACHE_HOME || path.join(homedir(), ".cache"), "qmd", `${config.qmdIndex}.sqlite`));
}

function expandHome(value) {
  const raw = String(value || "");
  return raw === "~" || raw.startsWith("~/")
    ? path.join(homedir(), raw.slice(2))
    : raw;
}

function qmdSdkExpandedQueries(query) {
  const qmd = query?.qmd;
  if (!qmd || typeof qmd !== "object") return [];
  return [
    ...(Array.isArray(qmd.lex) ? qmd.lex.map((item) => ({ type: "lex", query: item })) : []),
    qmd.vec ? { type: "vec", query: qmd.vec } : null,
    qmd.hyde ? { type: "hyde", query: qmd.hyde } : null,
  ].filter((item) => item?.query);
}

function qmdSdkSearchOptions(config, query, limit) {
  const expanded = qmdSdkExpandedQueries(query);
  const base = {
    collections: [config.qmdIndex],
    limit,
    candidateLimit: qmdCandidateLimit(config),
    rerank: Boolean(config.qmdRerank),
    explain: false,
  };
  if (query?.qmd?.intent) base.intent = query.qmd.intent;
  if (expanded.length > 0) {
    return { ...base, queries: expanded };
  }
  return { ...base, query: String(query.query || query.text || "") };
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function normalizeQmdSdkFile(config, rawFile, row) {
  const value = String(rawFile ?? "").trim();
  if (!value) return `${row.title || "unknown"}.md`;
  if (/^qmd:\/\//i.test(value) || path.isAbsolute(value)) return value;
  const normalized = value.replace(/^\/+/, "");
  const collectionPrefix = `${config.qmdIndex}/`;
  return normalized.startsWith(collectionPrefix)
    ? normalized.slice(collectionPrefix.length)
    : normalized;
}

function normalizeQmdSdkRow(config, row) {
  if (!row || typeof row !== "object") return null;
  const rawFile = row.file ?? row.uri ?? row.path ?? row.filepath ?? row.displayPath;
  const snippet = firstString(row.snippet, row.bestChunk, row.body, row.context, row.title);
  return {
    ...row,
    file: normalizeQmdSdkFile(config, rawFile, row),
    title: firstString(row.title, path.basename(String(rawFile || "unknown.md"), ".md")),
    snippet,
    score: Number.isFinite(Number(row.score)) ? Number(row.score) : 0,
  };
}

function normalizeQmdSdkRows(config, rows) {
  if (!Array.isArray(rows)) return [];
  return rows.map((row) => normalizeQmdSdkRow(config, row)).filter(Boolean);
}

async function runQmdSdkQuery(config, query) {
  const sdk = await loadQmdSdk(config);
  const store = await sdk.module.createStore({ dbPath: qmdDbPath(config) });
  try {
    const command = String(query.command || "qmd query");
    const limit = Math.max(Number(config.targetCandidates || 20), 15);
    const rows = command.startsWith("qmd search")
      ? await store.searchLex(String(query.query || query.text || ""), { collection: config.qmdIndex, limit })
      : await store.search(qmdSdkSearchOptions(config, query, limit));
    return normalizeQmdSdkRows(config, rows);
  } finally {
    if (typeof store?.close === "function") {
      await store.close();
    }
  }
}

/**
 * Builds core's QmdDeps.runQmdQuery for the SDK runner: `config` closes over
 * qmdCommand/qmdSdkModule/qmdDbPath/qmdIndex/qmdRerank/targetCandidates the
 * way the legacy wrapper closed over `args`. Rejects with an Error including
 * "timed out after" on a timeout, matching the CLI runner's contract.
 */
export function createQmdSdkRunner(config) {
  return {
    async runQmdQuery(query, timeoutMs) {
      const rows = await withTimeout(
        runQmdSdkQuery(config, query),
        timeoutMs,
        `QMD SDK timed out after ${timeoutMs}ms.`,
      );
      return JSON.stringify(rows);
    },
  };
}
