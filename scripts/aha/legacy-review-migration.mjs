#!/usr/bin/env node
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const DEFAULT_REVIEW_FOLDER = "Aha/Reviews";
const DEFAULT_PLUGIN_ID = "aha-memory-surface";
const RECORD_SCHEMA_VERSION = 1;

export async function migrateLegacyReviews({ reviews, existingData = {}, sourceStats = {}, migratedAt = new Date().toISOString() }) {
  const nextData = {
    ...existingData,
    reviewIndex: { ...(existingData.reviewIndex ?? {}) },
    sessionStore: normalizeSessionStore(existingData.sessionStore),
  };
  const migrated = [];
  const unmatched = [];

  for (const review of reviews) {
    const result = migrateLegacyReviewNote({
      ...review,
      sourceStat: sourceStats[review.reviewPath],
      migratedAt,
    });
    if (!result.ok) {
      unmatched.push(result);
      continue;
    }
    const existing = nextData.sessionStore.records[result.record.key];
    if (existing && existing.source.path !== result.record.source.path) {
      unmatched.push({
        ok: false,
        reviewPath: review.reviewPath,
        reason: "ambiguous-source-record",
        sourceId: result.record.source.id,
        sourcePath: result.record.source.path,
      });
      continue;
    }
    if (existing && !existingRecordLooksMigrated(existing, review.reviewPath)) {
      unmatched.push({
        ok: false,
        reviewPath: review.reviewPath,
        reason: "existing-session-record",
        sourceId: result.record.source.id,
        sourcePath: result.record.source.path,
      });
      continue;
    }
    const legacyExisting = nextData.sessionStore.records[result.legacyKey];
    if (result.legacyKey !== result.record.key && legacyExisting?.source?.path === result.record.source.path) {
      delete nextData.sessionStore.records[result.legacyKey];
    }
    nextData.sessionStore.records[result.record.key] = result.record;
    nextData.reviewIndex[`${result.record.source.id}\0${result.record.source.path}`] = review.reviewPath;
    if (result.legacySourceId !== result.record.source.id) {
      nextData.reviewIndex[`${result.legacySourceId}\0${result.record.source.path}`] = review.reviewPath;
    }
    nextData.reviewIndex[`path:${result.record.source.path}`] = review.reviewPath;
    migrated.push({
      reviewPath: review.reviewPath,
      key: result.record.key,
      sourcePath: result.record.source.path,
      candidates: result.record.rounds[0]?.candidates.length ?? 0,
      selected: result.record.rounds[0]?.candidates.filter((candidate) => candidate.selected).length ?? 0,
      feedback: result.record.feedback.length,
    });
  }

  return { data: nextData, migrated, unmatched };
}

export function migrateLegacyReviewNote({ reviewPath, content, sourceStat, migratedAt = new Date().toISOString() }) {
  const legacySourceId = frontmatterValue(content, "source_id");
  const sourcePath = sourcePathFromFrontmatter(content);
  if (!legacySourceId || !sourcePath) {
    return { ok: false, reviewPath, reason: "missing-source-identity", sourceId: legacySourceId, sourcePath };
  }

  const selectedRound = latestSelectedMemoriesRound(content);
  const grillRound = selectedRound ? null : latestGrillHandoffRound(content);
  const round = selectedRound ?? grillRound;
  if (!round || round.candidates.length === 0) {
    return { ok: false, reviewPath, reason: "missing-recoverable-candidates", sourceId: legacySourceId, sourcePath };
  }

  const sourceId = sourceIdentityForSourceStat(sourceStat) ?? legacySourceId;
  const sourceTitle = noteTitle(sourcePath);
  const recordKey = sessionRecordKeyForSource(sourceId, sourcePath);
  const legacyKey = sessionRecordKeyForSource(legacySourceId, sourcePath);
  const roundId = `success:${round.generatedAt}`;
  const sourceSnapshot = sourceSnapshotFor(sourcePath, sourceStat);
  const record = {
    schemaVersion: RECORD_SCHEMA_VERSION,
    key: recordKey,
    source: {
      id: sourceId,
      path: sourcePath,
      title: sourceTitle,
      fallbackPath: sourcePath,
      ctime: sourceSnapshot.ctime,
      mtime: sourceSnapshot.mtime,
      size: sourceSnapshot.size,
    },
    rounds: [
      {
        id: roundId,
        status: "success",
        generatedAt: round.generatedAt,
        sourcePath,
        sourceTitle,
        sourceSnapshot,
        summary: `Migrated from legacy Review Note: ${reviewPath}`,
        warnings: ["Migrated from a legacy Aha Review Note; raw markdown history was not preserved."],
        candidates: round.candidates,
      },
    ],
    latestSuccessfulRoundId: roundId,
    feedback: parseReviewBenchmarkSeeds(content, sourcePath, sourceTitle),
    updatedAt: migratedAt,
  };

  return { ok: true, reviewPath, record, legacySourceId, legacyKey };
}

export function sessionRecordKeyForSource(sourceId, sourcePath) {
  return sourceId.startsWith("srcfs:") ? sourceId : `${sourceId}\0${sourcePath}`;
}

export function sourcePathFromFrontmatter(content) {
  const source = frontmatterValue(content, "source");
  return markdownPathForWikiLink(source) ?? ensureMarkdownPath(frontmatterValue(content, "source_path") ?? "");
}

function latestSelectedMemoriesRound(content) {
  const body = generatedBlockBody(content, "selected-memories");
  if (!body) return null;
  const section = latestRoundSection(body, ["纳入 Handoff 的记忆", "Selected Memories"]);
  if (!section) return null;
  return {
    generatedAt: section.generatedAt,
    candidates: parseCandidateList(section.text),
  };
}

function latestGrillHandoffRound(content) {
  const body = generatedBlockBody(content, "grill-handoff");
  if (!body) return null;
  const section = latestRoundSection(body, ["Grill Handoff"]);
  if (!section) return null;
  return {
    generatedAt: section.generatedAt,
    candidates: parseGrillHandoffCandidates(section.text),
  };
}

function latestRoundSection(body, headings) {
  const escaped = headings.map(escapeRegExp).join("|");
  const pattern = new RegExp(`(^|\\n)### (${escaped}) - ([^\\n]+)`, "g");
  let match;
  let latest = null;
  while ((match = pattern.exec(body)) !== null) {
    latest = {
      start: match.index + (match[1] === "\n" ? 1 : 0),
      generatedAt: match[3].trim(),
    };
  }
  if (!latest) return null;
  const nextSection = body.slice(latest.start + 1).search(/\n### /);
  const end = nextSection === -1 ? body.length : latest.start + 1 + nextSection;
  return {
    generatedAt: latest.generatedAt,
    text: body.slice(latest.start, end).trim(),
  };
}

function parseCandidateList(section) {
  const candidates = [];
  let current = null;
  for (const line of section.split("\n")) {
    const candidateMatch = line.match(/^(\d+)\.\s+\[([ xX])\]\s+(.+)$/);
    if (candidateMatch) {
      const link = parseWikiLink(candidateMatch[3]);
      if (!link) {
        current = null;
        continue;
      }
      current = {
        index: Number(candidateMatch[1]),
        selected: candidateMatch[2].toLowerCase() === "x",
        notePath: link.path,
        noteTitle: link.title,
        relation: "weak",
        hit: "",
        why: "",
        quotes: [],
      };
      candidates.push(current);
      continue;
    }
    if (!current) continue;
    const field = line.match(/^\s*-\s*([^:：]+)\s*[:：]\s*(.*)$/);
    if (!field) continue;
    const key = field[1].trim().toLowerCase();
    const value = stripBackticks(field[2].trim());
    if (key === "relation" || key === "关系") current.relation = value || "weak";
    if (key === "hit" || key === "命中") current.hit = value;
    if (key === "why" || key === "理由") current.why = value;
    if (key === "quote" || key === "引用") current.quotes.push(value);
  }
  return candidates;
}

function parseGrillHandoffCandidates(section) {
  const candidates = [];
  for (const line of section.split("\n")) {
    const match = line.match(/^-\s+(\[\[[^\]]+\]\])\s+\(([^)]+)\):\s+(.+)$/);
    if (!match) continue;
    const link = parseWikiLink(match[1]);
    if (!link) continue;
    const hitIndex = match[3].lastIndexOf(" hit: ");
    const why = hitIndex === -1 ? match[3].trim() : match[3].slice(0, hitIndex).trim();
    const hit = hitIndex === -1 ? "" : match[3].slice(hitIndex + " hit: ".length).trim();
    candidates.push({
      index: candidates.length + 1,
      selected: true,
      notePath: link.path,
      noteTitle: link.title,
      relation: match[2].trim() || "weak",
      hit,
      why,
      quotes: [],
    });
  }
  return candidates;
}

function parseReviewBenchmarkSeeds(content, fallbackSourcePath, fallbackSourceTitle) {
  const body = generatedBlockBody(content, "review-benchmark-seeds");
  if (!body || body.includes("审阅动作会在这里保存为草稿 benchmark seed")) return [];
  return body
    .split(/\n(?=### Review Benchmark Seed - )/)
    .map((section) => section.trim())
    .filter((section) => section.startsWith("### Review Benchmark Seed - "))
    .map((section) => feedbackFromSeedSection(section, fallbackSourcePath, fallbackSourceTitle))
    .filter(Boolean);
}

function feedbackFromSeedSection(section, fallbackSourcePath, fallbackSourceTitle) {
  const createdAt = section.match(/^### Review Benchmark Seed - (.+)$/m)?.[1]?.trim();
  if (!createdAt) return null;
  const fields = new Map();
  for (const line of section.split("\n")) {
    const field = line.match(/^-\s*([^:]+):\s*(.*)$/);
    if (field) fields.set(field[1].trim(), stripBackticks(field[2].trim()));
  }
  const action = fields.get("action") || "accept";
  const source = parseWikiLink(fields.get("source") || "");
  return {
    action,
    status: "draft",
    seedLabel: fields.get("seed_label") || seedLabelForAction(action),
    createdAt,
    sourcePath: source?.path ?? fallbackSourcePath,
    sourceTitle: source?.title ?? fallbackSourceTitle,
    memory: markdownPathForWikiLink(fields.get("memory") || "") ?? ensureMarkdownPath(fields.get("memory") || ""),
    relation: fields.get("relation"),
    hit: fields.get("hit"),
    why: fields.get("why"),
    note: fields.get("note"),
  };
}

function generatedBlockBody(content, blockName) {
  const start = `<!-- aha:${blockName}:start -->`;
  const end = `<!-- aha:${blockName}:end -->`;
  const startIndex = content.indexOf(start);
  const endIndex = content.indexOf(end);
  if (startIndex === -1 || endIndex === -1 || endIndex < startIndex) return null;
  return content.slice(startIndex + start.length, endIndex).trim();
}

function frontmatterValue(content, key) {
  const frontmatter = content.match(/^---\n([\s\S]*?)\n---\n?/)?.[1];
  if (!frontmatter) return null;
  const match = frontmatter.match(new RegExp(`^${escapeRegExp(key)}:\\s*(.+)$`, "m"));
  return match ? unquoteYamlScalar(match[1]).trim() : null;
}

function parseWikiLink(value) {
  const match = value.match(/\[\[([^\]|#^]+)(?:[^\]|]*?)?(?:\|([^\]]+))?\]\]/);
  if (!match) return null;
  return {
    path: ensureMarkdownPath(match[1].trim()),
    title: match[2]?.trim() || noteTitle(match[1].trim()),
  };
}

function markdownPathForWikiLink(value) {
  return parseWikiLink(value)?.path ?? null;
}

function ensureMarkdownPath(value) {
  const trimmed = String(value).trim();
  if (!trimmed) return "";
  return /\.md$/i.test(trimmed) ? trimmed : `${trimmed}.md`;
}

function noteTitle(notePath) {
  return path.basename(notePath, ".md");
}

function sourceSnapshotFor(sourcePath, sourceStat) {
  return {
    path: sourcePath,
    ctime: finiteNumber(sourceStat?.ctimeMs),
    mtime: finiteNumber(sourceStat?.mtimeMs),
    size: finiteNumber(sourceStat?.size),
  };
}

function sourceIdentityForSourceStat(sourceStat) {
  if (!sourceStat) return null;
  if (Number.isFinite(sourceStat.dev) && Number.isFinite(sourceStat.ino) && sourceStat.ino > 0) {
    return `srcfs:${stableHashToken([
      "aha-source-v3",
      String(sourceStat.dev),
      String(sourceStat.ino),
      String(Math.trunc(sourceStat.birthtimeMs ?? 0)),
    ].join("\0"))}`;
  }
  if (Number.isFinite(sourceStat.ctimeMs)) {
    return `src:${stableHashToken(["aha-source-v2", String(sourceStat.ctimeMs)].join("\0"))}`;
  }
  return null;
}

function normalizeSessionStore(value) {
  return value && value.schemaVersion === RECORD_SCHEMA_VERSION && value.records && typeof value.records === "object"
    ? { schemaVersion: RECORD_SCHEMA_VERSION, records: { ...value.records } }
    : { schemaVersion: RECORD_SCHEMA_VERSION, records: {} };
}

function existingRecordLooksMigrated(record, reviewPath) {
  if (!Array.isArray(record.rounds) || record.rounds.length === 0) return false;
  return record.rounds.every((round) => round?.summary === `Migrated from legacy Review Note: ${reviewPath}`);
}

function seedLabelForAction(action) {
  if (action === "reject_as_noise") return "negative";
  if (action === "should_have_found") return "must_recall";
  return "nice_to_have";
}

function stripBackticks(value) {
  return value.replace(/^`([^`]+)`$/, "$1").trim();
}

function unquoteYamlScalar(value) {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  return trimmed;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stableHashToken(value) {
  return createHash("sha256").update(value).digest("base64url").slice(0, 24);
}

async function main(argv) {
  const args = parseArgs(argv);
  if (!args.vaultRoot) {
    throw new Error("Usage: legacy-review-migration.mjs --vault-root <path> [--write]");
  }
  const pluginId = args.pluginId ?? DEFAULT_PLUGIN_ID;
  const reviewFolder = args.reviewFolder ?? DEFAULT_REVIEW_FOLDER;
  const pluginDataPath = path.join(args.vaultRoot, ".obsidian/plugins", pluginId, "data.json");
  const reviewRoot = path.join(args.vaultRoot, reviewFolder);
  const reviewNames = (await readdir(reviewRoot)).filter((name) => name.endsWith(".md")).sort();
  const reviews = [];
  const sourceStats = {};

  for (const name of reviewNames) {
    const absolutePath = path.join(reviewRoot, name);
    const reviewPath = path.posix.join(reviewFolder, name);
    const content = await readFile(absolutePath, "utf8");
    reviews.push({ reviewPath, content });
    const sourcePath = sourcePathFromFrontmatter(content);
    if (sourcePath) {
      try {
        sourceStats[reviewPath] = await stat(path.join(args.vaultRoot, sourcePath));
      } catch {
        // Missing source notes are allowed; migrated records stay orphaned.
      }
    }
  }

  const existingData = JSON.parse(await readFile(pluginDataPath, "utf8"));
  const result = await migrateLegacyReviews({ reviews, existingData, sourceStats });
  if (!args.write) {
    process.stdout.write(`${JSON.stringify({
      write: false,
      migrated: result.migrated,
      unmatched: result.unmatched,
    }, null, 2)}\n`);
    return;
  }

  await mkdir(path.dirname(pluginDataPath), { recursive: true });
  const backupPath = `${pluginDataPath}.legacy-review-migration-backup-${backupTimestamp()}`;
  await copyFile(pluginDataPath, backupPath);
  await writeFile(pluginDataPath, `${JSON.stringify(result.data, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({
    write: true,
    backupPath,
    migrated: result.migrated,
    unmatched: result.unmatched,
  }, null, 2)}\n`);
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--write") {
      args.write = true;
    } else if (arg === "--vault-root") {
      args.vaultRoot = argv[++index];
    } else if (arg === "--plugin-id") {
      args.pluginId = argv[++index];
    } else if (arg === "--review-folder") {
      args.reviewFolder = argv[++index];
    }
  }
  return args;
}

function backupTimestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
