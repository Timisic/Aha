import { spawn } from "node:child_process";
import { basename, join, resolve } from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "./runtime-paths.ts";
import { BACKLINK_CANDIDATE_LIMIT, BACKLINK_CONCURRENCY, BACKLINK_SEED_LIMIT, BACKLINKS_PER_SEED_LIMIT, COMMAND_OUTPUT_MAX_BYTES, GRILL_INSIGHT_PATH, OBSIDIAN_TIMEOUT_MS, PROCESS_KILL_GRACE_MS, QMD_TIMEOUT_MS, type ActiveSession, type CommandResult, type InsightSession, type MemoryCandidate, type MemoryCandidateSource, type MemoryQueryCommand, type MemoryQueryInputKind, type MemoryQueryKind, type MemoryRelation, type MemorySearchCandidate, type ObsidianBacklink, type QmdStructuredQuery, type SimpleComponent, compactLine, configuredSourceRoots, shortId, slugify } from "./domain.ts";
import { buildVaultPathResolver, deterministicFallbackCanonicalId, normalizeIdentityHint, resolveNoteIdentity, resolveVaultPath, stripPathDecorations } from "./path-resolver.js";
import { obsidianCommand } from "./source-note.ts";
import { summaryDraftPathFor } from "./session.ts";

export function stableCandidateId(slug: string | undefined, title: string, queryText: string, content = ""): string {
  const normalizedSlug = stripPathDecorations(slug);
  if (normalizedSlug) return normalizedSlug;
  return deterministicFallbackCanonicalId({ title: title || slugify(queryText), queryText, content });
}

export function textFromUnknown(value: unknown): string {
  if (typeof value === "string") return value;
  if (value == null) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function pickFirstString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

export function collectResultItems(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  for (const key of ["results", "items", "pages", "matches", "data"]) {
    const nested = record[key];
    if (Array.isArray(nested)) return nested;
  }
  return [];
}

export function appendCappedOutput(
  current: string,
  chunk: unknown,
  label: "stdout" | "stderr",
  onExceeded: (label: "stdout" | "stderr") => void,
): string {
  const marker = `\n[insight] ${label} exceeded ${COMMAND_OUTPUT_MAX_BYTES} bytes and was truncated.\n`;
  const next = current + Buffer.from(String(chunk)).toString("utf-8");
  if (Buffer.byteLength(next, "utf-8") <= COMMAND_OUTPUT_MAX_BYTES) return next;
  onExceeded(label);
  return next.slice(0, COMMAND_OUTPUT_MAX_BYTES) + marker;
}

export function killProcessTree(pid: number): void {
  if (process.platform === "win32") {
    try {
      spawn("taskkill", ["/F", "/T", "/PID", String(pid)], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      }).unref();
    } catch {
      // Best effort cleanup.
    }
    return;
  }

  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Process already exited.
    }
  }
}

export function qmdCommand(): string {
  return process.env.QMD_BIN?.trim() || "qmd";
}

export function qmdEnv(): NodeJS.ProcessEnv {
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

export function qmdIndexName(): string {
  return process.env.INSIGHT_QMD_INDEX?.trim() || "obsidian";
}

export function qmdCollectionName(): string {
  return process.env.INSIGHT_QMD_COLLECTION?.trim() || "obsidian";
}

export function normalizeMemoryQueryCommand(command: MemoryQueryCommand | undefined, kind: MemoryQueryKind): MemoryQueryCommand {
  if (command === "qmd query") return "qmd query";
  if (command === "qmd search") return "qmd search";
  if (command === "qmd vsearch") return "qmd vsearch";
  return kind === "explicit_cue" ? "qmd search" : "qmd query";
}

export function structuredQmdQuery(query: string, kind: MemoryQueryKind): string {
  const normalized = compactLine(query, 900);
  const lexTerms = Array.from(new Set([
    ...normalized
      .split(/[,\n，。；;、|/]+/)
      .map((term) => compactLine(term, 32))
      .filter((term) => visibleWidth(term) >= 2)
      .slice(0, 3),
    "旧判断",
    "反例 边界",
    "相似结构",
    "判断转化",
  ])).slice(0, 7);

  return [
    `intent: 召回和当前 /insight ${kind} 记忆查询相关的旧判断、反例、边界条件和相似结构；优先返回能帮助判断转化、验证或修正当前 insight 的旧笔记。`,
    ...lexTerms.map((term) => `lex: ${term}`),
    `vec: ${normalized}`,
    `hyde: 一篇相关旧笔记可能记录了相似经历、失败反例、边界条件、旧判断变化、跨领域结构或可复用的判断框架；它能帮助判断当前 insight 改变了什么、哪里不成立、下一步如何验证。`,
  ].join("\n");
}

export function structuredQmdQueryFromObject(query: QmdStructuredQuery, fallbackText: string, kind: MemoryQueryKind): string {
  const fallback = structuredQmdQuery(fallbackText, kind);
  const intent = compactLine(query.intent, 500);
  const lex = Array.isArray(query.lex)
    ? Array.from(new Set(query.lex.map((term) => compactLine(term, 48)).filter(Boolean))).slice(0, 7)
    : [];
  const vec = compactLine(query.vec, 900);
  const hyde = compactLine(query.hyde, 900);

  if (!intent || lex.length === 0 || !vec || !hyde) return fallback;
  return [
    `intent: ${intent}`,
    ...lex.map((term) => `lex: ${term}`),
    `vec: ${vec}`,
    `hyde: ${hyde}`,
  ].join("\n");
}

export function runQmdCall(
  commandKind: MemoryQueryCommand,
  query: string,
  limit: number,
  ctx: ExtensionCommandContext,
  signal?: AbortSignal,
  timeoutMs = Number(process.env.INSIGHT_QMD_TIMEOUT_MS) || QMD_TIMEOUT_MS,
  kind: MemoryQueryKind = "contextual",
  qmd?: QmdStructuredQuery,
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const subcommand =
      commandKind === "qmd search" ? "search" :
      commandKind === "qmd vsearch" ? "vsearch" :
      "query";
    const qmdQuery = commandKind === "qmd search"
      ? query
      : qmd
        ? structuredQmdQueryFromObject(qmd, query, kind)
        : structuredQmdQuery(query, kind);
    const child = spawn(qmdCommand(), [
      "--index",
      qmdIndexName(),
      subcommand,
      qmdQuery,
      "-c",
      qmdCollectionName(),
      "-n",
      String(limit),
      "--full-path",
      "--line-numbers",
      "--format",
      "json",
    ], {
      cwd: ctx.cwd,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      env: qmdEnv(),
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    let killed = false;
    let settled = false;
    let timedOut = false;
    let cancelled = signal?.aborted === true;

    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };

    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ stdout, stderr, code, killed, timedOut, cancelled });
    };

    const kill = () => {
      if (settled) return;
      killed = true;
      if (child.pid) {
        killProcessTree(child.pid);
      } else {
        child.kill("SIGKILL");
      }
      setTimeout(() => finish(null), PROCESS_KILL_GRACE_MS);
    };

    const onAbort = () => {
      cancelled = true;
      kill();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });

    const onOutputExceeded = () => {
      if (!killed) kill();
    };

    child.stdout?.on("data", (chunk) => {
      stdout = appendCappedOutput(stdout, chunk, "stdout", onOutputExceeded);
    });
    child.stderr?.on("data", (chunk) => {
      stderr = appendCappedOutput(stderr, chunk, "stderr", onOutputExceeded);
    });
    child.on("error", (error) => {
      stderr = appendCappedOutput(stderr, error.message, "stderr", onOutputExceeded);
      finish(127);
    });
    child.on("close", (code) => {
      finish(code);
    });
  });
}

export function runCommand(
  command: string,
  args: string[],
  ctx: ExtensionCommandContext,
  signal?: AbortSignal,
  timeoutMs = OBSIDIAN_TIMEOUT_MS,
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: ctx.cwd,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    let killed = false;
    let settled = false;
    let timedOut = false;
    let cancelled = signal?.aborted === true;

    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };

    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ stdout, stderr, code, killed, timedOut, cancelled });
    };

    const kill = () => {
      if (settled) return;
      killed = true;
      if (child.pid) killProcessTree(child.pid);
      else child.kill("SIGKILL");
      setTimeout(() => finish(null), PROCESS_KILL_GRACE_MS);
    };

    const onAbort = () => {
      cancelled = true;
      kill();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });

    const onOutputExceeded = () => {
      if (!killed) kill();
    };

    child.stdout?.on("data", (chunk) => {
      stdout = appendCappedOutput(stdout, chunk, "stdout", onOutputExceeded);
    });
    child.stderr?.on("data", (chunk) => {
      stderr = appendCappedOutput(stderr, chunk, "stderr", onOutputExceeded);
    });
    child.on("error", (error) => {
      stderr = appendCappedOutput(stderr, error.message, "stderr", onOutputExceeded);
      finish(127);
    });
    child.on("close", (code) => {
      finish(code);
    });
  });
}

export function parseBacklinksOutput(output: string, source: { id: string; title: string }): ObsidianBacklink[] {
  const trimmed = output.trim();
  if (!trimmed) return [];
  if (/^Error:\s+/i.test(trimmed)) return [];

  try {
    const parsed = JSON.parse(trimmed);
    const items = collectResultItems(parsed);
    return items
      .map((item) => {
        const record = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
        const path = pickFirstString(record, ["path", "file", "sourcePath", "linkpath"]);
        const title =
          pickFirstString(record, ["title", "name", "basename", "file", "path", "source"]) ??
          path ??
          textFromUnknown(item);
        const countValue = record.count ?? record.linkCount ?? record.occurrences;
        const count = typeof countValue === "number" ? countValue : undefined;
        return {
          title,
          path,
          count,
          sourceCandidateId: source.id,
          sourceTitle: source.title,
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
        const title = path ?? parts[0] ?? line;
        const count = Number(parts.find((part) => /^\d+$/.test(part)));
        return {
          title,
          path,
          count: Number.isFinite(count) ? count : undefined,
          sourceCandidateId: source.id,
          sourceTitle: source.title,
        };
      })
      .filter((item) => item.title && !/^file\b|^path\b/i.test(item.title));
  }
}

export function tokenizeForRelevance(text: string): Set<string> {
  const tokens = new Set<string>();
  const normalized = text.toLowerCase();
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

export function isBacklinkRelevant(backlink: ObsidianBacklink, session: InsightSession): boolean {
  const haystack = `${backlink.title}\n${backlink.path ?? ""}\n${backlink.content ?? ""}`;
  const candidateTokens = tokenizeForRelevance(haystack);
  if (candidateTokens.size === 0) return false;

  const queryTokens = tokenizeForRelevance(
    [
      session.rawInsight,
      session.context,
      ...session.explicitMemoryCues,
      ...session.memoryQueries.map((query) => query.text),
    ].join("\n"),
  );
  let overlap = 0;
  for (const token of queryTokens) {
    if (candidateTokens.has(token)) overlap += 1;
  }
  return overlap >= 1;
}

export async function readObsidianNote(
  backlink: ObsidianBacklink,
  ctx: ExtensionCommandContext,
  signal?: AbortSignal,
  timeoutMs = OBSIDIAN_TIMEOUT_MS,
): Promise<string | undefined> {
  const command = obsidianCommand();
  const args = backlink.path
    ? ["read", `path=${backlink.path}`]
    : ["read", `file=${backlink.title}`];
  const result = await runCommand(command, args, ctx, signal, timeoutMs);
  if (result.killed || result.code !== 0) return undefined;
  const output = result.stdout.trim();
  if (!output || /^Error:\s+/i.test(output)) return undefined;
  return output;
}

function uniqueArgSets(argSets: string[][]): string[][] {
  const seen = new Set<string>();
  const unique: string[][] = [];
  for (const args of argSets) {
    const key = args.join("\u0000");
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(args);
  }
  return unique;
}

type BacklinkResolutionWarning = {
  seedId: string;
  seedTitle: string;
  value: string;
  matches: string[];
};

function obsidianBacklinkArgSets(seed: MemoryCandidate, cwd: string): {
  argSets: string[][];
  warnings: BacklinkResolutionWarning[];
} {
  const values = [seed.slug, seed.id, seed.title]
    .map((value) => stripPathDecorations(value))
    .filter(Boolean);
  const argSets: string[][] = [];
  const warnings: BacklinkResolutionWarning[] = [];
  const resolvers = configuredSourceRoots(cwd).map((root) => buildVaultPathResolver(root));

  for (const value of values) {
    const pathCandidates = new Set<string>();
    let ambiguous = false;
    for (const resolver of resolvers) {
      const resolved = resolveVaultPath(value, resolver);
      if (resolved.status === "resolved" && resolved.path) pathCandidates.add(resolved.path);
      if (resolved.status === "ambiguous") {
        ambiguous = true;
        warnings.push({
          seedId: seed.id,
          seedTitle: seed.title,
          value,
          matches: resolved.matches,
        });
      }
    }
    if (!ambiguous && pathCandidates.size === 0 && (value.includes("/") || value.endsWith(".md"))) {
      pathCandidates.add(value.replace(/^\/+/, ""));
    }

    for (const candidatePath of pathCandidates) {
      if (candidatePath.includes("/") || candidatePath.endsWith(".md")) {
        argSets.push(["backlinks", `path=${candidatePath}`, "format=json"]);
        if (!candidatePath.endsWith(".md")) {
          argSets.push(["backlinks", `path=${candidatePath}.md`, "format=json"]);
        }
      }
      const base = basename(candidatePath, ".md");
      if (base && !ambiguous) argSets.push(["backlinks", `file=${base}`, "format=json"]);
    }
  }

  if (seed.identityStatus !== "ambiguous") argSets.push(["backlinks", `file=${seed.title}`, "format=json"]);
  return {
    argSets: uniqueArgSets(argSets),
    warnings,
  };
}

async function mapBounded<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(Math.max(1, concurrency), items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await worker(items[index]);
    }
  });
  await Promise.all(runners);
  return results;
}

export async function expandBacklinkCandidates(
  seeds: InsightSession["memoryCandidates"],
  session: InsightSession,
  ctx: ExtensionCommandContext,
  signal?: AbortSignal,
  options: { concurrency?: number; timeoutMs?: number } = {},
): Promise<{
  candidates: InsightSession["memoryCandidates"];
  resolutionWarnings: BacklinkResolutionWarning[];
}> {
  const command = obsidianCommand();
  const timeoutMs = Math.max(1, options.timeoutMs ?? OBSIDIAN_TIMEOUT_MS);
  const concurrency = Math.max(1, options.concurrency ?? BACKLINK_CONCURRENCY);

  const perSeed = await mapBounded(seeds.slice(0, BACKLINK_SEED_LIMIT), concurrency, async (seed) => {
    const backlinkResolution = obsidianBacklinkArgSets(seed, ctx.cwd);
    let backlinks: ObsidianBacklink[] = [];
    for (const args of backlinkResolution.argSets) {
      if (signal?.aborted) break;
      const result = await runCommand(command, args, ctx, signal, timeoutMs);
      if (result.killed || result.code !== 0 || !result.stdout.trim()) continue;
      backlinks = parseBacklinksOutput(result.stdout, { id: seed.id, title: seed.title });
      if (backlinks.length > 0) break;
    }

    const candidates: InsightSession["memoryCandidates"] = [];
    for (const backlink of backlinks.slice(0, BACKLINKS_PER_SEED_LIMIT)) {
      if (signal?.aborted) break;
      backlink.content = await readObsidianNote(backlink, ctx, signal, timeoutMs);
      if (!isBacklinkRelevant(backlink, session)) continue;
      candidates.push(toMemoryCandidate(
        {
          id: stableCandidateId(backlink.path, backlink.title, seed.title),
          title: backlink.title,
          slug: backlink.path,
          content: backlink.content,
          rank: backlink.count,
          queryText: `backlinks:${seed.title}`,
          source: "obsidian_backlink",
          expansionFrom: seed.id,
          expansionType: "backlink",
        },
        session,
      ));
    }

    return {
      candidates,
      resolutionWarnings: backlinkResolution.warnings,
    };
  });

  const backlinkCandidates: InsightSession["memoryCandidates"] = [];
  const resolutionWarnings = perSeed.flatMap((item) => item.resolutionWarnings);
  const seen = new Set<string>();
  for (const item of perSeed) {
    for (const candidate of item.candidates) {
      const key = candidate.slug || candidate.title;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      backlinkCandidates.push(candidate);
      if (backlinkCandidates.length >= BACKLINK_CANDIDATE_LIMIT) {
        return { candidates: backlinkCandidates, resolutionWarnings };
      }
    }
  }

  return { candidates: backlinkCandidates, resolutionWarnings };
}


export function parseMemorySearchCandidates(
  output: string,
  queryText: string,
  allowTextFallback = true,
): MemorySearchCandidate[] {
  const trimmed = output.trim();
  if (!trimmed) return [];

  try {
    const parsed = JSON.parse(trimmed);
    return collectResultItems(parsed)
      .map((item, index) => {
        const record = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
        const slug = pickFirstString(record, ["file", "path", "slug", "id", "page"]);
        const title =
          pickFirstString(record, ["title", "name", "slug", "path"]) ??
          `Memory result ${index + 1}`;
        const content =
          pickFirstString(record, ["snippet", "content", "text", "chunk_text", "summary", "body"]) ??
          textFromUnknown(item).slice(0, 500);
        const score = record.score;
        return {
          id: stableCandidateId(slug, title, queryText, content),
          title,
          slug,
          content,
          rank: typeof score === "number" ? Math.round(score * 1000) : index + 1,
          queryText,
        };
      })
      .filter((candidate) => candidate.title.trim());
  } catch {
    if (!allowTextFallback) return [];
    const blocks = trimmed
      .split(/\n(?=(?:[-*]\s+)?(?:title|slug|#|\d+\.|•)|\n{2,})/i)
      .map((block) => block.trim())
      .filter(Boolean);
    return blocks.slice(0, 8).map((block, index) => {
      const firstLine = block.split(/\r?\n/)[0]?.replace(/^[-*#\d.\s]+/, "").trim();
      const title = firstLine || `Memory result ${index + 1}`;
      return {
        id: stableCandidateId(undefined, title, queryText, block.slice(0, 500)),
        title,
        content: block.slice(0, 500),
        rank: index + 1,
        queryText,
      };
    });
  }
}

export function inferRelation(candidate: MemorySearchCandidate, session: InsightSession): MemoryRelation {
  const text = `${candidate.title}\n${candidate.content ?? ""}`.toLowerCase();
  if (/(反例|冲突|挑战|不成立|例外|矛盾|counter|challenge)/i.test(text)) return "challenges";
  if (/(边界|条件|限制|只在|适用|不适用|boundary|limit|condition)/i.test(text)) return "bounds";
  if (/(类似|相似|结构|模式|同构|analogy|resembles|pattern)/i.test(text)) return "resembles";
  if (session.rawInsight && text.includes(session.rawInsight.toLowerCase().slice(0, 12))) {
    return "supports";
  }
  return "supports";
}

function resolveCandidateIdentity(candidate: MemorySearchCandidate, session: InsightSession): Pick<MemorySearchCandidate, "id" | "canonicalPath" | "canonicalId" | "identityStatus" | "identityMatches" | "aliases"> {
  for (const root of configuredSourceRoots(session.originCwd)) {
    const resolver = buildVaultPathResolver(root);
    for (const value of [candidate.slug, candidate.id, candidate.title]) {
      if (!value) continue;
      const resolved = resolveNoteIdentity(value, resolver);
      if (resolved.status === "resolved") {
        return {
          id: resolved.canonicalId,
          canonicalPath: resolved.canonicalPath,
          canonicalId: resolved.canonicalId,
          identityStatus: "resolved",
          aliases: resolved.aliases,
        };
      }
      if (resolved.status === "ambiguous") {
        return {
          id: deterministicFallbackCanonicalId({ path: candidate.slug, title: candidate.title, content: candidate.content, queryText: candidate.queryText }),
          identityStatus: "ambiguous",
          identityMatches: resolved.matches.map((match: { canonicalId: string }) => match.canonicalId),
        };
      }
    }
  }
  return {
    id: deterministicFallbackCanonicalId({ path: candidate.slug, title: candidate.title, content: candidate.content, queryText: candidate.queryText }),
    identityStatus: "unresolved",
  };
}

export function toMemoryCandidate(candidate: MemorySearchCandidate, session: InsightSession) {
  const relation = inferRelation(candidate, session);
  const snippet = (candidate.content ?? "").replace(/\s+/g, " ").slice(0, 140);
  const identity = resolveCandidateIdentity(candidate, session);
  return {
    id: identity.id,
    title: candidate.title,
    slug: candidate.slug ?? identity.canonicalPath,
    canonicalPath: identity.canonicalPath,
    canonicalId: identity.canonicalId,
    identityStatus: identity.identityStatus,
    identityMatches: identity.identityMatches,
    aliases: identity.aliases,
    relation,
    reason: snippet || "Retrieved by QMD as potentially relevant prior memory.",
    whyReadFirst:
      relation === "challenges"
        ? "It may force a boundary, exception, or revision."
        : relation === "bounds"
          ? "It may clarify where the current insight applies or stops applying."
          : relation === "resembles"
            ? "It may reveal a cross-domain structural similarity."
            : "It may support or enrich the current judgment direction.",
    searchSignals: {
      queryText: candidate.queryText,
      rank: candidate.rank,
      queryKind: candidate.queryKind,
      queryKinds: candidate.queryKinds ?? (candidate.queryKind ? [candidate.queryKind] : undefined),
      source: candidate.source,
      sources: candidate.sources ?? (candidate.source ? [candidate.source] : undefined),
      expansionFrom: candidate.expansionFrom,
      expansionFroms: candidate.expansionFroms ?? (candidate.expansionFrom ? [candidate.expansionFrom] : undefined),
      expansionType: candidate.expansionType,
    },
  };
}

function candidateIdentityKey(candidate: InsightSession["memoryCandidates"][number]): string {
  return candidate.canonicalId || candidate.id || normalizeIdentityHint(candidate.slug) || normalizeIdentityHint(candidate.title);
}

export function mergeCandidates(
  existing: InsightSession["memoryCandidates"],
  incoming: InsightSession["memoryCandidates"],
): InsightSession["memoryCandidates"] {
  const seen = new Set(existing.map(candidateIdentityKey));
  const merged = [...existing];
  for (const candidate of incoming) {
    const key = candidateIdentityKey(candidate);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(candidate);
  }
  return merged;
}

export function mergeCandidateEvidence(
  candidates: InsightSession["memoryCandidates"],
): InsightSession["memoryCandidates"] {
  const byKey = new Map<string, InsightSession["memoryCandidates"][number]>();
  const merged: InsightSession["memoryCandidates"] = [];

  for (const candidate of candidates) {
    const key = candidateIdentityKey(candidate);
    if (!key) continue;
    const existing = byKey.get(key);
    if (!existing) {
      const sources = candidate.searchSignals?.sources ??
        (candidate.searchSignals?.source ? [candidate.searchSignals.source] : undefined);
      const queryKinds = candidate.searchSignals?.queryKinds ??
        (candidate.searchSignals?.queryKind ? [candidate.searchSignals.queryKind] : undefined);
      const expansionFroms = candidate.searchSignals?.expansionFroms ??
        (candidate.searchSignals?.expansionFrom ? [candidate.searchSignals.expansionFrom] : undefined);
      const next = {
        ...candidate,
        searchSignals: {
          ...candidate.searchSignals,
          queryKinds,
          sources,
          expansionFroms,
        },
      };
      byKey.set(key, next);
      merged.push(next);
      continue;
    }

    const existingSignals = existing.searchSignals ?? {};
    const incomingSignals = candidate.searchSignals ?? {};
    existing.searchSignals = {
      ...existingSignals,
      sources: Array.from(new Set([
        ...(existingSignals.sources ?? (existingSignals.source ? [existingSignals.source] : [])),
        ...(incomingSignals.sources ?? (incomingSignals.source ? [incomingSignals.source] : [])),
      ])),
      queryKinds: Array.from(new Set([
        ...(existingSignals.queryKinds ?? (existingSignals.queryKind ? [existingSignals.queryKind] : [])),
        ...(incomingSignals.queryKinds ?? (incomingSignals.queryKind ? [incomingSignals.queryKind] : [])),
      ])),
      expansionFroms: Array.from(new Set([
        ...(existingSignals.expansionFroms ?? (existingSignals.expansionFrom ? [existingSignals.expansionFrom] : [])),
        ...(incomingSignals.expansionFroms ?? (incomingSignals.expansionFrom ? [incomingSignals.expansionFrom] : [])),
      ])),
    };
    if (!existing.slug && candidate.slug) existing.slug = candidate.slug;
    if (!existing.canonicalPath && candidate.canonicalPath) existing.canonicalPath = candidate.canonicalPath;
    if (!existing.canonicalId && candidate.canonicalId) existing.canonicalId = candidate.canonicalId;
    if (!existing.aliases && candidate.aliases) existing.aliases = candidate.aliases;
    if (!existing.reason && candidate.reason) existing.reason = candidate.reason;
    if (!existing.whyReadFirst && candidate.whyReadFirst) existing.whyReadFirst = candidate.whyReadFirst;
  }

  return merged;
}

export function sourceLabel(candidate: InsightSession["memoryCandidates"][number]): string {
  const sources = candidate.searchSignals?.sources;
  if (sources && sources.length > 0) {
    return sources.map((source) => {
      if (source === "obsidian_backlink") return "backlink";
      if (source === "qmd_query") return "qmd query";
      if (source === "qmd_search") return "qmd search";
      return "qmd vsearch";
    }).join("+");
  }
  const source = candidate.searchSignals?.source;
  if (source === "obsidian_backlink") return "backlink";
  if (source === "qmd_query") return "qmd query";
  if (source === "qmd_search") return "qmd search";
  return "qmd vsearch";
}

export function relationLabel(relation: MemoryRelation): string {
  switch (relation) {
    case "supports":
      return "supports / 支持";
    case "challenges":
      return "challenges / 挑战";
    case "resembles":
      return "resembles / 相似结构";
    case "bounds":
      return "bounds / 边界";
  }
}

export function tableCell(value: string, limit = 110): string {
  return compactLine(value, limit).replace(/\|/g, "/");
}

export function clipVisual(value: string, width: number): string {
  if (width <= 1) return "";
  const normalized = value.replace(/\s+/g, " ");
  return truncateToWidth(normalized, width, "…");
}

export function padVisual(value: string, width: number): string {
  const clipped = clipVisual(value, width);
  return `${clipped}${" ".repeat(Math.max(0, width - visibleWidth(clipped)))}`;
}

export function formatMemoryCandidateTable(candidates: InsightSession["memoryCandidates"]): string {
  if (candidates.length === 0) return "No memory candidates have been recorded yet.";
  return [
    "| Note | Relation | Hit | Why |",
    "| --- | --- | --- | --- |",
    ...candidates.map((candidate, index) => {
      return [
        tableCell(`${index + 1}. ${candidate.title}`, 72),
        relationLabel(candidate.relation),
        tableCell(candidate.reason, 140),
        tableCell(candidate.whyReadFirst, 120),
      ].join(" | ");
    }).map((row) => `| ${row} |`),
  ].join("\n");
}

export function renderMemoryCandidateLines(candidates: InsightSession["memoryCandidates"], width: number): string[] {
  const safeWidth = Math.max(40, width - 2);
  if (candidates.length === 0) {
    return ["insight_search_memory", "", "No memory candidates yet."].map((line) =>
      truncateToWidth(line, safeWidth, ""),
    );
  }

  const gaps = 3;
  const titleWidth = Math.min(24, Math.max(10, Math.floor(safeWidth * 0.2)));
  const relationWidth = Math.min(17, Math.max(12, Math.floor(safeWidth * 0.18)));
  const remaining = Math.max(12, safeWidth - titleWidth - relationWidth - gaps);
  const hitWidth = Math.max(8, Math.floor(remaining * 0.62));
  const whyWidth = Math.max(4, remaining - hitWidth);

  const line = [
    padVisual("Note", titleWidth),
    padVisual("Relation", relationWidth),
    padVisual("Hit", hitWidth),
    padVisual("Why", whyWidth),
  ].join(" ");
  const divider = "-".repeat(Math.min(safeWidth, visibleWidth(line)));
  const rows = candidates.map((candidate, index) => {
    return [
      padVisual(`${index + 1}. ${candidate.title}`, titleWidth),
      padVisual(relationLabel(candidate.relation), relationWidth),
      padVisual(candidate.reason, hitWidth),
      padVisual(candidate.whyReadFirst, whyWidth),
    ].join(" ");
  });

  return [
    `insight_search_memory · cumulative candidates: ${candidates.length}`,
    "",
    line,
    divider,
    ...rows,
  ].map((renderedLine) => truncateToWidth(renderedLine, safeWidth, ""));
}

export function memorySearchResultComponent(result: { details?: unknown }): SimpleComponent {
  return {
    render(width: number): string[] {
      const details = (result.details && typeof result.details === "object"
        ? result.details
        : {}) as {
        candidates?: InsightSession["memoryCandidates"];
        memoryCandidates?: InsightSession["memoryCandidates"];
      };
      return renderMemoryCandidateLines(details.candidates ?? details.memoryCandidates ?? [], width);
    },
  };
}

export function isInsightStateDiscoveryCommand(command: string): boolean {
  const normalized = command.replace(/\s+/g, " ").trim();
  if (!/\b(find|fd|rg|ls)\b/.test(normalized)) return false;
  return /(state\.json|grill-context\.md|grill-briefing\.md|stage-briefing\.md|summary-draft\.md)/.test(normalized);
}

export function isDirectQmdShellCommand(command: string): boolean {
  const normalized = command.replace(/\s+/g, " ").trim();
  return /(^|[;&|]\s*)(?:env\s+[^;&|]*\s+)?qmd\b/.test(normalized);
}

export function qmdConnectivityIssue(output: string): string | undefined {
  if (!/(Remote .* endpoint failed|fetch failed|ECONNREFUSED|Failed to connect to 127\.0\.0\.1:1808[123]|connect .*127\.0\.0\.1:1808[123])/i.test(output)) {
    return undefined;
  }
  return "QMD remote model tunnel is unavailable; local 127.0.0.1:18081/18082/18083 did not answer.";
}

export function expandHomePath(path: string): string {
  const home = process.env.HOME ?? "";
  if (path === "~") return home || path;
  if (path.startsWith("~/")) return home ? join(home, path.slice(2)) : path;
  return path;
}

export function isInsightMemoryStageReadBlocked(input: unknown, activeSession?: ActiveSession): boolean {
  const path = String((input as { path?: unknown } | undefined)?.path ?? "").trim();
  if (!path) return true;

  const normalized = resolve(expandHomePath(path));
  const protectedPaths = activeSession
    ? [
        activeSession.statePath,
        activeSession.grillContextPath,
        activeSession.stageBriefingPath,
        activeSession.grillBriefingPath,
        summaryDraftPathFor(activeSession.sessionDir),
        GRILL_INSIGHT_PATH,
      ].map((item) => resolve(item))
    : [resolve(GRILL_INSIGHT_PATH)];

  return protectedPaths.includes(normalized);
}
