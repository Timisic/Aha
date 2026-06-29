import * as path from "path";
import { Platform } from "obsidian";
import type { AhaPluginSettings } from "./settings";

export interface WrapperRunInput {
  reviewPath: string;
  sourceAbsolutePath: string;
  sourcePath: string;
  vaultRoot: string;
}

export interface ReadinessCheck {
  name: string;
  ok: boolean;
  message: string;
}

export interface ReadinessResult {
  ok: boolean;
  checks: ReadinessCheck[];
}

const WRAPPER_TIMEOUT_MS = 16 * 60 * 1000;
const COMMAND_CHECK_TIMEOUT_MS = 15 * 1000;
const MAX_WRAPPER_OUTPUT_BYTES = 5 * 1024 * 1024;
const OUTPUT_PREVIEW_LIMIT = 500;
const DESKTOP_PATH_ENTRIES = [
  "/opt/homebrew/bin",
  "/opt/homebrew/sbin",
  "/usr/local/bin",
  "/usr/bin",
  "/bin",
  "/usr/sbin",
  "/sbin",
  "/Users/hong/.local/bin",
  "/Users/hong/.npm-global/bin",
  "/Users/hong/.bun/bin",
];
const NODE_CANDIDATES = [
  "/opt/homebrew/bin/node",
  "/usr/local/bin/node",
  "/Users/hong/.local/bin/node",
  "/Users/hong/.npm-global/bin/node",
];

export function canRunExternalProcesses(): boolean {
  try {
    return Platform.isDesktopApp && typeof getNodeRequire() === "function";
  } catch {
    return false;
  }
}

export async function runReadinessCheck(settings: AhaPluginSettings): Promise<ReadinessResult> {
  const nodeCommand = await resolveNodeCommand(settings);
  const nodeCheck = await checkLocalCommand("Node CLI", nodeCommand, ["--version"], settings.ahaWorkspace);
  if (!nodeCheck.ok) {
    return {
      ok: false,
      checks: [nodeCheck],
    };
  }

  const payload = await runWrapperJson(settings, [
    "--check-readiness",
    ...wrapperRuntimeArgs(settings),
  ]);

  const wrapperResult = payload as ReadinessResult;
  return {
    ok: nodeCheck.ok && wrapperResult.ok,
    checks: [nodeCheck, ...wrapperResult.checks],
  };
}

export async function runAhaWrapper(settings: AhaPluginSettings, input: WrapperRunInput): Promise<unknown> {
  const args = [
    ...wrapperRuntimeArgs(settings),
    "--source-path",
    input.sourcePath,
    "--source-absolute-path",
    input.sourceAbsolutePath,
    "--review-path",
    input.reviewPath,
    "--vault-root",
    input.vaultRoot,
    "--target-candidates",
    String(settings.targetCandidates),
  ];

  if (settings.useFixtureResult) {
    args.push("--fixture", path.join(settings.ahaWorkspace, "scripts/aha/fixtures/stub-result.json"));
  }

  return runWrapperJson(settings, args);
}

function wrapperRuntimeArgs(settings: AhaPluginSettings): string[] {
  const args = [
    "--workspace",
    settings.ahaWorkspace,
    "--llm-provider",
    settings.llmProvider,
    "--llm-base-url",
    settings.llmBaseUrl,
    "--llm-model",
    settings.llmModel,
    "--llm-api-key-env",
    settings.llmApiKeyEnv,
    "--codex-command",
    settings.codexCommand,
    "--codex-model",
    settings.codexModel,
    "--codex-sandbox",
    settings.codexSandbox,
    "--codex-reasoning-effort",
    settings.codexReasoningEffort,
    "--qmd-runner",
    settings.qmdRunner,
    "--qmd-command",
    settings.qmdCommand,
    "--qmd-index",
    settings.qmdIndex,
    "--obsidian-command",
    settings.obsidianCommand,
  ];

  if (settings.qmdSdkModule.trim()) {
    args.push("--qmd-sdk-module", settings.qmdSdkModule.trim());
  }
  if (settings.qmdRerank) {
    args.push("--qmd-rerank");
  }
  return args;
}

async function runWrapperJson(settings: AhaPluginSettings, args: string[]): Promise<unknown> {
  if (!canRunExternalProcesses()) {
    throw new Error("Aha wrapper can only run in Obsidian desktop with Node integration.");
  }

  if (!settings.ahaWorkspace.trim()) {
    throw new Error("Set the Aha workspace path before running Aha.");
  }

  const wrapperPath = path.resolve(settings.ahaWorkspace, settings.wrapperRelativePath);
  const nodeCommand = await resolveNodeCommand(settings);
  const nodeCheck = await checkLocalCommand("Node CLI", nodeCommand, ["--version"], settings.ahaWorkspace);
  if (!nodeCheck.ok) {
    throw new Error(`Node CLI is not runnable (${nodeCommand}): ${nodeCheck.message}`);
  }

  const output = await execFileJson(nodeCommand, [wrapperPath, ...args], settings.ahaWorkspace, WRAPPER_TIMEOUT_MS, settings);
  try {
    return JSON.parse(output);
  } catch (error) {
    const preview = firstLine(output).slice(0, OUTPUT_PREVIEW_LIMIT) || "empty stdout";
    throw new Error(`Aha wrapper returned invalid JSON: ${preview}`);
  }
}

export async function resolveNodeCommand(settings: AhaPluginSettings): Promise<string> {
  const configured = settings.nodeCommand?.trim();
  if (configured) return configured;

  const processExecPath = process.execPath;
  if (looksLikeNodeExecutable(processExecPath)) return processExecPath;

  for (const candidate of NODE_CANDIDATES) {
    if (await pathExists(candidate)) return candidate;
  }
  return "node";
}

function execFileJson(command: string, args: string[], cwd: string, timeoutMs: number, settings?: AhaPluginSettings): Promise<string> {
  return execFileText(command, args, cwd, timeoutMs, settings).then((result) => {
    const jsonStdout = extractJsonPayload(result.stdout);
    if (result.code === 0) return jsonStdout;
    if (looksLikeJson(jsonStdout)) return jsonStdout;
    throw new Error(firstLine(result.stderr) || firstLine(stripAnsiControls(result.stdout)) || `Aha wrapper exited with code ${result.code ?? "unknown"}.`);
  });
}

function checkLocalCommand(name: string, command: string, args: string[], cwd: string): Promise<ReadinessCheck> {
  return execFileText(command, args, cwd, COMMAND_CHECK_TIMEOUT_MS)
    .then((result) => result.code === 0
      ? { name, ok: true, message: firstLine(result.stdout || result.stderr) || command }
      : { name, ok: false, message: firstLine(result.stderr || result.stdout) || `Exited ${result.code}` })
    .catch((error: Error) => ({ name, ok: false, message: error.message }));
}

function execFileText(command: string, args: string[], cwd: string, timeoutMs: number, settings?: AhaPluginSettings): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const childProcess = getNodeRequire()("child_process") as typeof import("child_process");

  return new Promise((resolve, reject) => {
    const child = childProcess.spawn(command, args, {
      cwd,
      env: wrapperChildEnv(settings),
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
      reject(error);
    };
    const timer = setTimeout(() => {
      fail(new Error(`${command} timed out after ${timeoutMs}ms.`));
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stdoutBytes += Buffer.byteLength(text);
      if (stdoutBytes > MAX_WRAPPER_OUTPUT_BYTES) {
        fail(new Error(`Aha wrapper stdout exceeded ${MAX_WRAPPER_OUTPUT_BYTES} bytes.`));
        return;
      }
      stdout += text;
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stderrBytes += Buffer.byteLength(text);
      if (stderrBytes > MAX_WRAPPER_OUTPUT_BYTES) {
        fail(new Error(`Aha wrapper stderr exceeded ${MAX_WRAPPER_OUTPUT_BYTES} bytes.`));
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

function wrapperChildEnv(settings?: AhaPluginSettings): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: desktopToolPath(process.env.PATH),
  };
  const directKey = (settings?.llmApiKey ?? "").trim();
  const keyEnvName = (settings?.llmApiKeyEnv ?? "").trim();
  if (settings?.llmProvider === "openai" && directKey && keyEnvName) {
    env[keyEnvName] = directKey;
  }
  return env;
}

function desktopToolPath(currentPath: string | undefined): string {
  const entries = [
    ...(currentPath ?? "").split(path.delimiter),
    ...DESKTOP_PATH_ENTRIES,
  ].map((entry) => entry.trim()).filter(Boolean);
  return [...new Set(entries)].join(path.delimiter);
}

function looksLikeNodeExecutable(value: string): boolean {
  const name = path.basename(value).toLowerCase();
  return name === "node" || name === "node.exe";
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    const fs = getNodeRequire()("fs") as typeof import("fs");
    await fs.promises.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function looksLikeJson(value: string): boolean {
  return value.startsWith("{") && value.endsWith("}");
}

function extractJsonPayload(value: string): string {
  const clean = stripAnsiControls(value).trim();
  if (looksLikeJson(clean)) return clean;
  const start = clean.indexOf("{");
  const end = clean.lastIndexOf("}");
  if (start !== -1 && end > start) return clean.slice(start, end + 1).trim();
  return clean;
}

function stripAnsiControls(value: string): string {
  return value.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "");
}

function firstLine(value: string): string {
  return value.trim().split(/\r?\n/, 1)[0] ?? "";
}

function getNodeRequire(): NodeRequire {
  const globalRequire = (globalThis as { require?: NodeRequire }).require;
  if (typeof globalRequire === "function") return globalRequire;
  const windowRequire = (globalThis as { window?: { require?: NodeRequire } }).window?.require;
  if (typeof windowRequire === "function") return windowRequire;
  throw new Error("Node require is unavailable.");
}
