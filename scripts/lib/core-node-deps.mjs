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
