import { existsSync } from "node:fs";
import { delimiter, resolve } from "node:path";

export type RerankerMode = "agent" | "off" | "none" | "local" | "external";

export interface AhaConfigValue {
  name: string;
  value: string;
  defaultValue: string;
  source: "env" | "default";
  description: string;
}

export interface SupportedRange {
  name: string;
  range: string;
  current?: string;
  ok: boolean;
  required: boolean;
  fix: string;
}

export const AHA_PACKAGE_NAME = "@timisic/aha-pi-insight";
export const SUPPORTED_NODE_RANGE = ">=22.19.0 <26";
export const SUPPORTED_BUN_RANGE = ">=1.2.0 <2";
export const SUPPORTED_PI_RANGE = ">=0.79.0 <0.80.0";
export const SUPPORTED_QMD_RANGE = ">=0.1.0";
export const SUPPORTED_OBSIDIAN_CLI_RANGE = ">=0.1.0";
export const SUPPORTED_PLATFORMS = new Set(["darwin", "linux"]);

export function envValue(name: string, defaultValue: string, description: string): AhaConfigValue {
  const raw = process.env[name]?.trim();
  return {
    name,
    value: raw || defaultValue,
    defaultValue,
    source: raw ? "env" : "default",
    description,
  };
}

export function insightConfig(cwd: string): AhaConfigValue[] {
  const defaultAgentDir = `${process.env.HOME ?? "~"}/.pi/agent`;
  const defaultInsightHome = `${process.env.PI_CODING_AGENT_DIR?.trim() || defaultAgentDir}/insights`;
  return [
    envValue("INSIGHT_HOME", defaultInsightHome, "Aha session/index/artifact storage root."),
    envValue("PI_CODING_AGENT_DIR", defaultAgentDir, "Pi agent home used when INSIGHT_HOME is not set."),
    envValue("QMD_BIN", "qmd", "QMD executable used for retrieval diagnostics and memory search."),
    envValue("INSIGHT_QMD_INDEX", "obsidian", "QMD index name."),
    envValue("INSIGHT_QMD_COLLECTION", "obsidian", "QMD collection name."),
    envValue("OBSIDIAN_BIN", "obsidian", "Obsidian CLI executable used for source-note/backlink helpers."),
    envValue("INSIGHT_SOURCE_ROOTS", `${process.env.HOME ?? "~"}/Obsidian Notes${delimiter}${cwd}`, "Path-list of allowed source-note roots."),
    envValue("INSIGHT_MEMORY_RERANKER", "agent", "Reranker mode: agent, local/external provider, or off/none."),
    envValue("INSIGHT_MEMORY_RERANK_AGENT_BIN", "codex", "Agent reranker executable when INSIGHT_MEMORY_RERANKER=agent."),
    envValue("INSIGHT_QMD_TIMEOUT_MS", "90000", "Per-QMD-call deadline in milliseconds."),
    envValue("INSIGHT_OBSIDIAN_TIMEOUT_MS", "8000", "Per-Obsidian-command deadline in milliseconds."),
    envValue("INSIGHT_COMMAND_OUTPUT_MAX_BYTES", "1000000", "Maximum captured provider output before termination."),
    envValue("QMD_REMOTE_EMBED_URL", "http://127.0.0.1:18081/v1/embeddings", "Optional/local QMD embedding endpoint."),
    envValue("QMD_REMOTE_GENERATE_URL", "http://127.0.0.1:18082/completion", "Optional/local QMD query-generation endpoint."),
    envValue("QMD_REMOTE_RERANK_URL", "http://127.0.0.1:18083/v1/rerank", "Optional/local QMD rerank endpoint."),
    envValue("PI_TYPEBOX_PATH", "", "Advanced escape hatch for non-standard TypeBox installs."),
    envValue("PI_TUI_PATH", "", "Advanced escape hatch for non-standard Pi TUI installs."),
  ];
}

export function parseVersion(input: string | undefined): [number, number, number] | undefined {
  const match = input?.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareVersion(a: [number, number, number], b: [number, number, number]): number {
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}

export function versionSatisfies(version: string | undefined, range: string): boolean {
  const parsed = parseVersion(version);
  if (!parsed) return false;
  const clauses = range.split(/\s+/).filter(Boolean);
  for (const clause of clauses) {
    const match = clause.match(/^(>=|>|<=|<|=)?(.+)$/);
    if (!match) continue;
    const op = match[1] || "=";
    const target = parseVersion(match[2]);
    if (!target) continue;
    const cmp = compareVersion(parsed, target);
    if (op === ">=" && cmp < 0) return false;
    if (op === ">" && cmp <= 0) return false;
    if (op === "<=" && cmp > 0) return false;
    if (op === "<" && cmp >= 0) return false;
    if (op === "=" && cmp !== 0) return false;
  }
  return true;
}

export function supportedHostChecks(options: { nodeVersion?: string; platform?: NodeJS.Platform } = {}): SupportedRange[] {
  const nodeVersion = options.nodeVersion ?? process.version;
  const platform = options.platform ?? process.platform;
  return [
    {
      name: "operating system",
      range: "darwin or linux",
      current: platform,
      ok: SUPPORTED_PLATFORMS.has(platform),
      required: true,
      fix: "Run Aha on macOS or Linux, or use a supported container/VM.",
    },
    {
      name: "Node.js",
      range: SUPPORTED_NODE_RANGE,
      current: nodeVersion,
      ok: versionSatisfies(nodeVersion, SUPPORTED_NODE_RANGE),
      required: true,
      fix: "Install Node.js 22.19.x through 25.x and rerun npm ci.",
    },
  ];
}

export function splitSourceRoots(value: string): string[] {
  return value
    .split(delimiter)
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => item.replace(/^~(?=$|\/)/, process.env.HOME ?? "~"))
    .map((item) => resolve(item));
}

export function sourceRootStatuses(cwd: string): Array<{ path: string; exists: boolean }> {
  const roots = insightConfig(cwd).find((item) => item.name === "INSIGHT_SOURCE_ROOTS")?.value ?? cwd;
  return splitSourceRoots(roots).map((path) => ({ path, exists: existsSync(path) }));
}

export function normalizeRerankerMode(value = process.env.INSIGHT_MEMORY_RERANKER?.trim().toLowerCase() || "agent"): RerankerMode {
  if (value === "0" || value === "false" || value === "off") return "off";
  if (value === "none") return "none";
  if (value === "local") return "local";
  if (value === "external") return "external";
  return "agent";
}
