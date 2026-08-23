// Plugin-side qmd CLI subprocess adapter (issue #58). Implements
// core/qmd.ts's QmdDeps by spawning the configured qmd binary directly from
// the plugin's own desktop Node runtime -- this is still "no external Node
// process" in the issue's sense: the thing eliminated is the
// `node run-insight-search.mjs` wrapper-script subprocess, not qmd itself.
// Spawning the qmd binary is the same category of local-tool subprocess
// process.ts already uses for readiness checks (see checkLocalCommand /
// execFileText there); this module ports that same bounded-spawn safety
// pattern (closed stdin, timeout with SIGTERM/SIGKILL, output-size bounding)
// rather than importing process.ts's wrapper-specific functions, and mirrors
// buildQmdCommandArgv's exact argv shape from scripts/lib/core-node-deps.mjs
// (the Node/bench-side equivalent) so retrieval behavior matches.
//
// process.ts stays untouched: this is a new sibling file, not an edit to the
// frozen legacy wrapper rollback path.

import type { QmdDeps, QmdQueryLike } from "./core";
import type { AhaPluginSettings } from "./settings";

const READINESS_PROBE_TIMEOUT_MS = 8_000;
const MAX_QMD_OUTPUT_BYTES = 5 * 1024 * 1024;
const DEFAULT_QMD_CANDIDATE_LIMIT = 20;

interface BoundedCommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

interface BoundedCommandOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
}

function getNodeRequire(): NodeRequire {
  const globalRequire = (globalThis as { require?: NodeRequire }).require;
  if (typeof globalRequire === "function") return globalRequire;
  const windowRequire = (globalThis as { window?: { require?: NodeRequire } }).window?.require;
  if (typeof windowRequire === "function") return windowRequire;
  throw new Error("Node require is unavailable.");
}

/**
 * Bounded async spawn: closed stdin, a hard timeout that SIGTERMs then
 * SIGKILLs the child, and output-size bounding on stdout/stderr. Mirrors the
 * spawn-safety properties of scripts/lib/core-node-deps.mjs's
 * runCommandBounded and this plugin's own process.ts execFileText.
 */
function runBoundedCommand(command: string, args: string[], options: BoundedCommandOptions): Promise<BoundedCommandResult> {
  const childProcess = getNodeRequire()("child_process") as typeof import("child_process");

  return new Promise((resolve, reject) => {
    const child = childProcess.spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill("SIGTERM");
      const killTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }, 1_000);
      killTimer.unref?.();
      reject(error);
    };
    const timer = setTimeout(() => {
      fail(new Error(`${command} timed out after ${options.timeoutMs}ms.`));
    }, options.timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stdoutBytes += Buffer.byteLength(text);
      if (stdoutBytes > MAX_QMD_OUTPUT_BYTES) {
        fail(new Error(`${command} stdout exceeded ${MAX_QMD_OUTPUT_BYTES} bytes.`));
        return;
      }
      stdout += text;
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stderrBytes += Buffer.byteLength(text);
      if (stderrBytes > MAX_QMD_OUTPUT_BYTES) {
        fail(new Error(`${command} stderr exceeded ${MAX_QMD_OUTPUT_BYTES} bytes.`));
        return;
      }
      stderr += text;
    });
    child.on("error", (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

function firstLine(value: string): string {
  return value.trim().split(/\r?\n/, 1)[0] ?? "";
}

/**
 * Parses the settings-page "QMD environment" advanced field (issue #59):
 * one `KEY=VALUE` line per entry, injected into the qmd subprocess verbatim
 * -- not restricted to the old fixed QMD_REMOTE_* key allowlist, per the
 * issue text ("KEY=VALUE lines injected into the qmd subprocess", i.e. fully
 * general). Blank lines and lines without an `=` are ignored; leading/
 * trailing whitespace around both key and value is trimmed; a key that
 * appears more than once keeps its last occurrence (same "last wins"
 * convention a real .env-style file would apply).
 */
export function parseQmdEnvironment(raw: string): Record<string, string> {
  const entries: Record<string, string> = {};
  for (const line of String(raw ?? "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex <= 0) continue;
    const key = trimmed.slice(0, separatorIndex).trim();
    const value = trimmed.slice(separatorIndex + 1).trim();
    if (key) entries[key] = value;
  }
  return entries;
}

/**
 * Builds the qmd subprocess env: inherits the plugin's own process.env, then
 * overlays whatever KEY=VALUE pairs settings.qmdEnvironment parses to
 * (issue #59; replaces the old 6 discrete qmdRemote* fields this function
 * used to read one by one -- see process.ts's still-frozen
 * wrapperChildEnv/qmdRemoteEnvironment for the legacy wrapper's own
 * unrelated copy of that old convention).
 */
// macOS GUI apps (Obsidian included) inherit a minimal PATH that typically
// excludes Homebrew, npm-global, and nvm/fnm-managed Node. Augment PATH
// so that both the qmd binary and its #!/usr/bin/env node shebang resolve.
function augmentedPath(): string {
  const base = process.env.PATH ?? "/usr/bin:/bin";
  const home = process.env.HOME ?? "";
  const extras = [
    "/opt/homebrew/bin",
    "/usr/local/bin",
    home ? `${home}/.npm-global/bin` : "",
    home ? `${home}/.nvm/versions/node` : "",
  ].filter(Boolean);
  // nvm: pick the highest installed version's bin directory
  if (home) {
    try {
      const fs = getNodeRequire()("fs") as typeof import("fs");
      const nvmBase = `${home}/.nvm/versions/node`;
      if (fs.existsSync(nvmBase)) {
        const versions = fs.readdirSync(nvmBase).filter((d: string) => d.startsWith("v")).sort();
        const latest = versions.at(-1);
        if (latest) extras.push(`${nvmBase}/${latest}/bin`);
      }
    } catch { /* nvm not installed — fine */ }
  }
  const seen = new Set(base.split(":"));
  const additions = extras.filter((p) => !seen.has(p));
  return additions.length > 0 ? `${additions.join(":")}:${base}` : base;
}

function qmdChildEnv(settings: AhaPluginSettings): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: augmentedPath() };
  for (const [name, value] of Object.entries(parseQmdEnvironment(settings.qmdEnvironment))) {
    if (value) env[name] = value;
  }
  return env;
}

/**
 * Lightweight readiness pre-check: a cheap `qmd --version` probe (closed
 * stdin, short timeout) -- never a real query. Never throws; any kind of
 * unavailability (missing binary, non-zero exit, timeout) resolves false.
 * Callers must invoke this fresh every round (nothing here is cached), so an
 * environment repair -- e.g. installing qmd -- upgrades the tier on the very
 * next round without restarting Obsidian.
 */
export async function probeQmdAvailable(settings: AhaPluginSettings): Promise<boolean> {
  const command = settings.qmdCommand?.trim() || "qmd";
  try {
    const result = await runBoundedCommand(command, ["--version"], {
      cwd: settings.ahaWorkspace?.trim() || undefined,
      env: qmdChildEnv(settings),
      timeoutMs: READINESS_PROBE_TIMEOUT_MS,
    });
    return result.code === 0;
  } catch {
    return false;
  }
}

function qmdCandidateLimit(targetCandidates: number): number {
  return Math.max(Number(targetCandidates || DEFAULT_QMD_CANDIDATE_LIMIT), DEFAULT_QMD_CANDIDATE_LIMIT);
}

/**
 * Ported argv construction, matching buildQmdCommandArgv in
 * scripts/lib/core-node-deps.mjs verbatim (same flags, same order).
 */
export function buildQmdCommandArgv(query: QmdQueryLike, settings: AhaPluginSettings): string[] {
  const command = String(query.command || "qmd query");
  const subcommand = command.startsWith("qmd search") ? "search" : "query";
  const text = String(query.query || query.text || "");
  const targetCandidates = settings.targetCandidates;
  const args = [
    "--index",
    settings.qmdIndex,
    subcommand,
    text,
    "-c",
    settings.qmdIndex,
    "-n",
    String(Math.max(Number(targetCandidates || 20), 15)),
    "-C",
    String(qmdCandidateLimit(targetCandidates)),
    "--full-path",
    "--line-numbers",
    "--format",
    "json",
  ];
  if (subcommand === "query" && !settings.qmdRerank) {
    args.push("--no-rerank");
  }
  return args;
}

/**
 * Builds the QmdDeps.runQmdQuery adapter (core/qmd.ts) by spawning the
 * configured qmd binary directly. Resolves with raw stdout text (core owns
 * row parsing); rejects with an Error whose message includes
 * "timed out after" on a timeout so core's retry-on-timeout policy applies,
 * or with the qmd CLI's own failure message on a non-zero exit.
 */
export function createQmdRequestDeps(settings: AhaPluginSettings): QmdDeps {
  return {
    async runQmdQuery(query: QmdQueryLike, timeoutMs: number): Promise<string> {
      const command = settings.qmdCommand?.trim() || "qmd";
      const args = buildQmdCommandArgv(query, settings);
      const result = await runBoundedCommand(command, args, {
        cwd: settings.ahaWorkspace?.trim() || undefined,
        env: qmdChildEnv(settings),
        timeoutMs,
      });
      if (result.code !== 0) {
        throw new Error(firstLine(result.stderr || result.stdout) || `QMD exited ${result.code}`);
      }
      return result.stdout;
    },
  };
}

// --- Health section / embed-button subprocess adapters (issue #59) ---------
// Thin injected-I/O wrappers only: all decision logic (parsing qmd status
// text, deciding a light's color, sequencing update-then-embed) lives in
// health-checks.ts as pure/injectable functions so it is testable without a
// real qmd binary. These three functions are the only place that actually
// spawns `qmd status` / `qmd update` / `qmd embed`.

const STATUS_PROBE_TIMEOUT_MS = 20_000;
const EMBED_STEP_TIMEOUT_MS = 10 * 60 * 1000;

export interface QmdSubcommandResult {
  ok: boolean;
  stdout: string;
  message: string;
}

async function runQmdSubcommand(settings: AhaPluginSettings, args: string[], timeoutMs: number): Promise<QmdSubcommandResult> {
  const command = settings.qmdCommand?.trim() || "qmd";
  try {
    const result = await runBoundedCommand(command, args, {
      cwd: settings.ahaWorkspace?.trim() || undefined,
      env: qmdChildEnv(settings),
      timeoutMs,
    });
    if (result.code !== 0) {
      return { ok: false, stdout: result.stdout, message: firstLine(result.stderr || result.stdout) || `${command} ${args.join(" ")} exited ${result.code}` };
    }
    return { ok: true, stdout: result.stdout, message: firstLine(result.stdout) || `${command} ${args.join(" ")} succeeded.` };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, stdout: "", message };
  }
}

/** Runs `qmd status --index <qmdIndex>` for the index-coverage/endpoints health lights. Never throws. */
export function runQmdStatus(settings: AhaPluginSettings): Promise<QmdSubcommandResult> {
  return runQmdSubcommand(settings, ["status", "--index", settings.qmdIndex], STATUS_PROBE_TIMEOUT_MS);
}

/** Runs `qmd update --index <qmdIndex>` -- the first of the embed button's two sequenced steps. Never throws. */
export function runQmdUpdate(settings: AhaPluginSettings): Promise<QmdSubcommandResult> {
  return runQmdSubcommand(settings, ["update", "--index", settings.qmdIndex], EMBED_STEP_TIMEOUT_MS);
}

/** Runs `qmd embed --index <qmdIndex>` -- the second of the embed button's two sequenced steps. Never throws. */
export function runQmdEmbed(settings: AhaPluginSettings): Promise<QmdSubcommandResult> {
  return runQmdSubcommand(settings, ["embed", "--index", settings.qmdIndex], EMBED_STEP_TIMEOUT_MS);
}
