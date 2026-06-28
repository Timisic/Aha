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
const MAX_WRAPPER_OUTPUT_BYTES = 5 * 1024 * 1024;
const OUTPUT_PREVIEW_LIMIT = 500;

export function canRunExternalProcesses(): boolean {
  try {
    return Platform.isDesktopApp && typeof getNodeRequire() === "function";
  } catch {
    return false;
  }
}

export async function runReadinessCheck(settings: AhaPluginSettings): Promise<ReadinessResult> {
  const payload = await runWrapperJson(settings, [
    "--check-readiness",
    "--workspace",
    settings.ahaWorkspace,
    "--codex-command",
    settings.codexCommand,
    "--codex-model",
    settings.codexModel,
    "--codex-sandbox",
    settings.codexSandbox,
    "--codex-reasoning-effort",
    settings.codexReasoningEffort,
    "--qmd-command",
    settings.qmdCommand,
    "--obsidian-command",
    settings.obsidianCommand,
  ]);

  return payload as ReadinessResult;
}

export async function runAhaWrapper(settings: AhaPluginSettings, input: WrapperRunInput): Promise<unknown> {
  const args = [
    "--workspace",
    settings.ahaWorkspace,
    "--source-path",
    input.sourcePath,
    "--source-absolute-path",
    input.sourceAbsolutePath,
    "--review-path",
    input.reviewPath,
    "--vault-root",
    input.vaultRoot,
    "--codex-command",
    settings.codexCommand,
    "--codex-model",
    settings.codexModel,
    "--codex-sandbox",
    settings.codexSandbox,
    "--codex-reasoning-effort",
    settings.codexReasoningEffort,
    "--qmd-command",
    settings.qmdCommand,
    "--obsidian-command",
    settings.obsidianCommand,
    "--target-candidates",
    String(settings.targetCandidates),
  ];

  if (settings.useFixtureResult) {
    args.push("--fixture", path.join(settings.ahaWorkspace, "scripts/aha/fixtures/stub-result.json"));
  }

  return runWrapperJson(settings, args);
}

async function runWrapperJson(settings: AhaPluginSettings, args: string[]): Promise<unknown> {
  if (!canRunExternalProcesses()) {
    throw new Error("Aha wrapper can only run in Obsidian desktop with Node integration.");
  }

  if (!settings.ahaWorkspace.trim()) {
    throw new Error("Set the Aha workspace path before running Aha.");
  }

  const wrapperPath = path.resolve(settings.ahaWorkspace, settings.wrapperRelativePath);
  const output = await execFileJson(wrapperPath, args, settings.ahaWorkspace, WRAPPER_TIMEOUT_MS);
  try {
    return JSON.parse(output);
  } catch (error) {
    const preview = firstLine(output).slice(0, OUTPUT_PREVIEW_LIMIT) || "empty stdout";
    throw new Error(`Aha wrapper returned invalid JSON: ${preview}`);
  }
}

function execFileJson(command: string, args: string[], cwd: string, timeoutMs: number): Promise<string> {
  const childProcess = getNodeRequire()("child_process") as typeof import("child_process");

  return new Promise((resolve, reject) => {
    const child = childProcess.spawn(command, args, {
      cwd,
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
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill("SIGTERM");
      reject(error);
    };
    const timer = setTimeout(() => {
      fail(new Error(`Aha wrapper timed out after ${timeoutMs}ms.`));
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
      const trimmedStdout = stdout.trim();
      if (code === 0) {
        resolve(trimmedStdout);
        return;
      }

      if (looksLikeJson(trimmedStdout)) {
        resolve(trimmedStdout);
        return;
      }

      reject(new Error(firstLine(stderr) || firstLine(stdout) || `Aha wrapper exited with code ${code ?? "unknown"}.`));
    });
  });
}

function looksLikeJson(value: string): boolean {
  return value.startsWith("{") && value.endsWith("}");
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
