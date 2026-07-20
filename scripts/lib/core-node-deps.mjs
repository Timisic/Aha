// Node implementations of the shared-core dependency seam (ADR 0005).
// Bench scripts inject these into core entry points so the compiled core
// stays free of node imports while behaving exactly like the legacy
// scripts/aha/lib modules it replaces.

import { existsSync, readdirSync, statSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";

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
