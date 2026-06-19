import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { insightConfig, normalizeRerankerMode, sourceRootStatuses, supportedHostChecks, SUPPORTED_OBSIDIAN_CLI_RANGE, SUPPORTED_PI_RANGE, SUPPORTED_QMD_RANGE, versionSatisfies } from "./config.ts";
import { COMMAND_OUTPUT_MAX_BYTES } from "./domain.ts";
import { qmdCollectionName, qmdCommand, qmdEnv, qmdIndexName } from "./memory.ts";
import { obsidianCommand } from "./source-note.ts";
import { insightRoot, sessionsRoot } from "./session.ts";
import type { InsightRuntime } from "./runtime.ts";

export type DoctorStatus = "pass" | "warn" | "fail";

export interface DoctorCheck {
  id: string;
  label: string;
  status: DoctorStatus;
  summary: string;
  required: boolean;
  fix?: string;
  details?: unknown;
}

export interface DoctorReport {
  ok: boolean;
  generatedAt: string;
  privacy: "no-real-note-content";
  checks: DoctorCheck[];
  config: ReturnType<typeof insightConfig>;
}

function statusRank(status: DoctorStatus): number {
  return status === "fail" ? 2 : status === "warn" ? 1 : 0;
}

function runVersionCommand(command: string, args: string[] = ["--version"]): { ok: boolean; version?: string; stdout: string; stderr: string; error?: string; status: number | null } {
  const result = spawnSync(command, args, {
    encoding: "utf-8",
    timeout: 5_000,
    maxBuffer: COMMAND_OUTPUT_MAX_BYTES,
    windowsHide: true,
  });
  return {
    ok: !result.error && result.status === 0,
    version: `${result.stdout ?? ""}\n${result.stderr ?? ""}`.match(/\d+\.\d+\.\d+/)?.[0],
    stdout: (result.stdout ?? "").trim(),
    stderr: (result.stderr ?? "").trim(),
    error: result.error?.message,
    status: result.status,
  };
}

function commandCheck(id: string, label: string, command: string, range: string, required: boolean, fix: string): DoctorCheck {
  const result = runVersionCommand(command);
  if (!result.ok) {
    return {
      id,
      label,
      status: required ? "fail" : "warn",
      required,
      summary: `${command} is unavailable or failed to report a version`,
      fix,
      details: result,
    };
  }
  const ok = versionSatisfies(result.version, range);
  return {
    id,
    label,
    status: ok ? "pass" : required ? "fail" : "warn",
    required,
    summary: ok ? `${command} ${result.version} satisfies ${range}` : `${command} ${result.version ?? "unknown"} is outside ${range}`,
    fix,
    details: result,
  };
}

function checkWritableInsightHome(cwd: string): DoctorCheck {
  const root = insightRoot(cwd);
  const sessions = sessionsRoot(cwd);
  const probe = join(sessions, `.aha-doctor-${process.pid}-${Date.now()}.tmp`);
  try {
    mkdirSync(sessions, { recursive: true });
    writeFileSync(probe, "doctor\n", "utf-8");
    accessSync(probe, constants.R_OK | constants.W_OK);
    rmSync(probe, { force: true });
    return {
      id: "insight-home-writable",
      label: "Insight storage",
      status: "pass",
      required: true,
      summary: `Writable insight home: ${root}`,
      details: { root, sessions },
    };
  } catch (error) {
    return {
      id: "insight-home-writable",
      label: "Insight storage",
      status: "fail",
      required: true,
      summary: `Insight home is not writable: ${root}`,
      fix: `Set INSIGHT_HOME to a writable directory, for example: export INSIGHT_HOME="$PWD/.aha-demo/insights"`,
      details: { root, sessions, error: error instanceof Error ? error.message : String(error) },
    };
  }
}

function checkQmdSynthetic(ctx: ExtensionCommandContext): DoctorCheck {
  const query = [
    "intent: Aha doctor synthetic connectivity query; do not require personal note contents.",
    "lex: aha doctor synthetic",
    "vec: synthetic first run diagnostic",
    "hyde: A tiny public diagnostic query verifies that the configured index and collection can be reached.",
  ].join("\n");
  const result = spawnSync(qmdCommand(), [
    "--index",
    qmdIndexName(),
    "query",
    query,
    "-c",
    qmdCollectionName(),
    "-n",
    "1",
    "--format",
    "json",
  ], {
    cwd: ctx.cwd,
    encoding: "utf-8",
    timeout: Number(process.env.INSIGHT_QMD_TIMEOUT_MS) || 15_000,
    maxBuffer: COMMAND_OUTPUT_MAX_BYTES,
    env: qmdEnv(),
    windowsHide: true,
  });
  const stdout = (result.stdout ?? "").trim();
  const stderr = (result.stderr ?? "").trim();
  if (result.error || result.status !== 0) {
    return {
      id: "qmd-synthetic-query",
      label: "QMD index/collection",
      status: "fail",
      required: true,
      summary: `Synthetic QMD query failed for index=${qmdIndexName()} collection=${qmdCollectionName()}`,
      fix: `Create or select a QMD index/collection, then set INSIGHT_QMD_INDEX and INSIGHT_QMD_COLLECTION if they differ from "obsidian".`,
      details: { status: result.status, error: result.error?.message, stderr, stdout: stdout.slice(0, 500) },
    };
  }
  try {
    JSON.parse(stdout || "[]");
    return {
      id: "qmd-synthetic-query",
      label: "QMD index/collection",
      status: "pass",
      required: true,
      summary: `Synthetic QMD query succeeded for index=${qmdIndexName()} collection=${qmdCollectionName()}`,
      details: { status: result.status, stdoutBytes: Buffer.byteLength(stdout), stderr },
    };
  } catch (error) {
    return {
      id: "qmd-synthetic-query",
      label: "QMD index/collection",
      status: "warn",
      required: true,
      summary: "Synthetic QMD query returned non-JSON output",
      fix: "Run the command with --format json and verify QMD is configured for JSON output.",
      details: { error: error instanceof Error ? error.message : String(error), stdout: stdout.slice(0, 500), stderr },
    };
  }
}

function checkExtensionRegistration(pi: ExtensionAPI): DoctorCheck {
  const count = Number((globalThis as { __ahaInsightExtensionRegisterCount?: number }).__ahaInsightExtensionRegisterCount ?? 0);
  const hasApi = typeof pi.registerCommand === "function" && typeof pi.registerTool === "function" && typeof pi.on === "function";
  if (count > 1) {
    return {
      id: "extension-registration",
      label: "Extension registration",
      status: "fail",
      required: true,
      summary: `Aha extension appears to be loaded ${count} times`,
      fix: "Remove the legacy single-file insight.ts extension or duplicate package entry, then restart Pi.",
      details: { count, hasApi },
    };
  }
  return {
    id: "extension-registration",
    label: "Extension registration",
    status: hasApi ? "pass" : "fail",
    required: true,
    summary: hasApi ? "Aha extension API is present and loaded once" : "Pi extension API is missing required methods",
    fix: "Upgrade Pi to a supported version and load Aha as a package extension.",
    details: { count, hasApi },
  };
}

function checkPiHost(pi: ExtensionAPI): DoctorCheck {
  const record = pi as unknown as Record<string, unknown>;
  const rawVersion = [record.version, record.piVersion, record.hostVersion]
    .find((item) => typeof item === "string") as string | undefined;
  if (!rawVersion) {
    return {
      id: "pi-host-version",
      label: "Pi host",
      status: "warn",
      required: true,
      summary: `Pi host version is not exposed; API shape will be checked instead (${SUPPORTED_PI_RANGE} expected).`,
      fix: "If commands or tools fail to register, upgrade @earendil-works/pi-coding-agent to the supported range.",
      details: { expected: SUPPORTED_PI_RANGE },
    };
  }
  const ok = versionSatisfies(rawVersion, SUPPORTED_PI_RANGE);
  return {
    id: "pi-host-version",
    label: "Pi host",
    status: ok ? "pass" : "fail",
    required: true,
    summary: ok ? `Pi host ${rawVersion} satisfies ${SUPPORTED_PI_RANGE}` : `Pi host ${rawVersion} is outside ${SUPPORTED_PI_RANGE}`,
    fix: `Install a Pi version satisfying ${SUPPORTED_PI_RANGE}.`,
    details: { version: rawVersion, expected: SUPPORTED_PI_RANGE },
  };
}

function checkReranker(): DoctorCheck {
  const mode = normalizeRerankerMode();
  if (mode === "off" || mode === "none") {
    return {
      id: "reranker-mode",
      label: "Reranker",
      status: "pass",
      required: false,
      summary: `Reranker is disabled (${mode}); offline-safe path is active`,
      details: { mode },
    };
  }
  if (mode === "agent") {
    const command = process.env.INSIGHT_MEMORY_RERANK_AGENT_BIN?.trim() || "codex";
    const result = runVersionCommand(command, ["--version"]);
    return {
      id: "reranker-mode",
      label: "Reranker",
      status: result.ok ? "pass" : "warn",
      required: false,
      summary: result.ok ? `Agent reranker is available via ${command}` : `Agent reranker ${command} is unavailable; set INSIGHT_MEMORY_RERANKER=off for offline demos`,
      fix: `Install ${command}, or run: export INSIGHT_MEMORY_RERANKER=off`,
      details: { mode, command, result },
    };
  }
  return {
    id: "reranker-mode",
    label: "Reranker",
    status: "warn",
    required: false,
    summary: `Reranker mode ${mode} is configured; provider-specific diagnostics are not yet available`,
    fix: "Use INSIGHT_MEMORY_RERANKER=off for clean offline smoke tests.",
    details: { mode },
  };
}

function checkSourceRoots(cwd: string): DoctorCheck {
  const roots = sourceRootStatuses(cwd);
  const missing = roots.filter((root) => !root.exists);
  return {
    id: "source-roots",
    label: "Source roots",
    status: missing.length === 0 ? "pass" : "warn",
    required: false,
    summary: missing.length === 0 ? `${roots.length} configured source root(s) exist` : `${missing.length} configured source root(s) do not exist`,
    fix: "Set INSIGHT_SOURCE_ROOTS to existing vault/demo directories before reading source notes.",
    details: { roots },
  };
}

function checkPrivacy(): DoctorCheck {
  return {
    id: "privacy-mode",
    label: "Privacy",
    status: "pass",
    required: true,
    summary: "Doctor uses version checks, write probes, and one synthetic QMD query; it does not enumerate or print real note contents.",
    details: { mode: "no-real-note-content" },
  };
}

export async function runInsightDoctor(pi: ExtensionAPI, runtime: InsightRuntime, ctx: ExtensionCommandContext): Promise<DoctorReport> {
  void runtime;
  const checks: DoctorCheck[] = [];
  checks.push(...supportedHostChecks({
    nodeVersion: process.env.AHA_DOCTOR_TEST_NODE_VERSION,
    platform: process.env.AHA_DOCTOR_TEST_PLATFORM as NodeJS.Platform | undefined,
  }).map((item) => ({
    id: item.name.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
    label: item.name,
    status: item.ok ? "pass" as const : item.required ? "fail" as const : "warn" as const,
    required: item.required,
    summary: item.ok ? `${item.name} ${item.current} satisfies ${item.range}` : `${item.name} ${item.current ?? "unknown"} is outside ${item.range}`,
    fix: item.fix,
    details: item,
  })));
  checks.push(checkExtensionRegistration(pi));
  checks.push(checkPiHost(pi));
  checks.push(checkWritableInsightHome(ctx.cwd));
  checks.push(commandCheck("qmd-version", "QMD binary", qmdCommand(), SUPPORTED_QMD_RANGE, true, "Install qmd or set QMD_BIN to the qmd executable."));
  checks.push(checkQmdSynthetic(ctx));
  checks.push(commandCheck("obsidian-version", "Obsidian CLI", obsidianCommand(), SUPPORTED_OBSIDIAN_CLI_RANGE, false, "Install obsidian CLI or set OBSIDIAN_BIN; source-note/backlink helpers will be limited until then."));
  checks.push(checkReranker());
  checks.push(checkSourceRoots(ctx.cwd));
  checks.push(checkPrivacy());

  const ok = !checks.some((check) => check.required && check.status === "fail");
  checks.sort((a, b) => statusRank(b.status) - statusRank(a.status));
  return {
    ok,
    generatedAt: new Date().toISOString(),
    privacy: "no-real-note-content",
    checks,
    config: insightConfig(ctx.cwd),
  };
}

export function formatDoctorTable(report: DoctorReport): string {
  const lines = [
    `Aha doctor: ${report.ok ? "PASS" : "FAIL"}`,
    "",
    "| Status | Check | Required | Result | Fix |",
    "| --- | --- | --- | --- | --- |",
  ];
  for (const check of report.checks) {
    const icon = check.status === "pass" ? "PASS" : check.status === "warn" ? "WARN" : "FAIL";
    lines.push(`| ${icon} | ${check.label} | ${check.required ? "yes" : "no"} | ${check.summary.replace(/\|/g, "\\|")} | ${(check.fix ?? "").replace(/\|/g, "\\|")} |`);
  }
  lines.push("", "Structured result:", "", "```json", JSON.stringify(report, null, 2), "```");
  return lines.join("\n");
}
