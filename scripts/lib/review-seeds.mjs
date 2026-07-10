import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { benchVaultRoot, expandHome, normalizeSlash, splitPathDecorations, toVaultRelativePath } from "./vault-paths.mjs";

export const DEFAULT_REVIEW_FOLDER = "Aha/Reviews";
export const DEFAULT_SEED_CASES_PATH = "bench/aha-memory-seed-cases.json";
export const DEFAULT_COLLECTION = "obsidian";
export const DEFAULT_PLUGIN_ID = "aha-memory-surface";
export const SEED_INBOX_SUITE_VERSION = "seed-inbox-v1";

const LABEL_FOR_ACTION = {
  accept: "nice_to_have",
  reject_as_noise: "negative",
  should_have_found: "must_recall",
};

const LABEL_PRIORITY = ["must_recall", "negative", "nice_to_have"];

export function parseReviewBenchmarkSeedsFromContent(content, fallback = {}) {
  const body = generatedBlockBody(content, "review-benchmark-seeds");
  if (!body) return [];

  return body
    .split(/\n(?=### Review Benchmark Seed - )/)
    .map((section) => section.trim())
    .filter((section) => section.startsWith("### Review Benchmark Seed - "))
    .map((section) => parseReviewBenchmarkSeedSection(section, content, fallback))
    .filter(Boolean);
}

export function buildReviewSeedCaseDocument(reviewNotes, options = {}) {
  const generatedAt = options.generatedAt instanceof Date ? options.generatedAt : new Date(options.generatedAt ?? Date.now());
  const warnings = [];
  const groups = new Map();
  let seen = 0;

  for (const note of reviewNotes) {
    const notePath = normalizeSlash(note.path ?? "");
    const content = String(note.content ?? "");
    const fallback = {
      sourcePath: frontmatterField(content, "source_path"),
      sourceTitle: frontmatterSourceTitle(content),
      reviewNotePath: notePath,
      vaultRoot: options.vaultRoot,
    };
    const seeds = parseReviewBenchmarkSeedsFromContent(content, fallback);
    for (const seed of seeds) {
      seen += 1;
      const sourcePath = cleanPath(seed.sourcePath || fallback.sourcePath, options);
      const memoryPath = cleanPath(seed.memoryPath || seed.memory, options);
      const label = seedLabel(seed);
      if (!sourcePath) {
        warnings.push(`${notePath || "(unknown review note)"}: skipped seed without source path at ${seed.createdAt || "unknown time"}`);
        continue;
      }
      if (!memoryPath) {
        warnings.push(`${notePath || "(unknown review note)"}: skipped ${label} seed without memory path at ${seed.createdAt || "unknown time"}`);
        continue;
      }
      if (!groups.has(sourcePath)) {
        groups.set(sourcePath, makeEmptyGroup(sourcePath, seed.sourceTitle || fallback.sourceTitle || titleFromPath(sourcePath)));
      }
      addSeedToGroup(groups.get(sourcePath), {
        ...seed,
        label,
        sourcePath,
        sourceTitle: seed.sourceTitle || fallback.sourceTitle || titleFromPath(sourcePath),
        memoryPath,
        reviewNotePath: notePath,
        seen,
      });
    }
  }

  const cases = Array.from(groups.values())
    .map(groupToCase)
    .filter(Boolean)
    .sort((a, b) => a.id.localeCompare(b.id));

  return compactObject({
    _说明: {
      用途: "Aha Review Note 反馈动作生成的本地私有 draft cases；只作为 seed inbox，不会自动进入主 benchmark。",
      输入字段: {
        "input.note": "Review Note 记录的 source note 路径；目前没有行号时显式 whole_note，人工提升到主 benchmark 前应补 lines。",
        "input.whole_note": "显式表示当前 seed 暂时使用整篇 source note；不是漏写 lines 的隐式结果。",
      },
      评分字段: {
        "gold.must": "should_have_found seeds",
        "gold.nice": "accept seeds",
        "gold.noise": "reject_as_noise seeds",
      },
    },
    description: "Aha Review Benchmark Seeds - generated private draft cases",
    version: 3,
    collection: options.collection || DEFAULT_COLLECTION,
    suites: {
      development: { version: SEED_INBOX_SUITE_VERSION },
    },
    expected_in_top_k: 10,
    nice_expected_in_top_k: 20,
    expanded_pool_expected_in_top_k: 20,
    generated_at: generatedAt.toISOString(),
    source: "review-benchmark-seeds",
    review_seed_policy: "Generated from Obsidian Review Note actions. Treat as a development draft; inspect labels and mode before activation. Never promote directly into holdout.",
    cases,
    warnings: warnings.length > 0 ? warnings : undefined,
  });
}

export function buildSessionFeedbackSeedCaseDocument(pluginData, options = {}) {
  const sessionStore = requireSessionStore(pluginData);
  const generatedAt = options.generatedAt instanceof Date ? options.generatedAt : new Date(options.generatedAt ?? Date.now());
  const warnings = [];
  const groups = new Map();
  const seenEventIds = new Set();
  let seen = 0;

  for (const [recordKey, record] of Object.entries(sessionStore.records).sort(([left], [right]) => left.localeCompare(right))) {
    const recordLabel = sessionRecordLabel(recordKey);
    if (!isRecord(record) || record.schemaVersion !== 1 || !isRecord(record.source)) {
      warnings.push(`${recordLabel}: skipped malformed Session Record.`);
      continue;
    }
    if (!Array.isArray(record.feedback)) {
      warnings.push(`${recordLabel}: skipped Session Record without a feedback array.`);
      continue;
    }

    for (const [feedbackIndex, feedback] of record.feedback.entries()) {
      const feedbackLabel = `${recordLabel} feedback[${feedbackIndex}]`;
      if (!isRecord(feedback)) {
        warnings.push(`${feedbackLabel}: skipped malformed feedback entry.`);
        continue;
      }
      const action = typeof feedback.action === "string" ? feedback.action : "";
      if (!Object.hasOwn(LABEL_FOR_ACTION, action)) {
        warnings.push(`${feedbackLabel}: skipped unsupported action.`);
        continue;
      }
      const createdAt = normalizedTimestamp(feedback.createdAt);
      if (!createdAt) {
        warnings.push(`${feedbackLabel}: skipped feedback with invalid createdAt.`);
        continue;
      }
      const rawSourcePath = typeof feedback.sourcePath === "string" && feedback.sourcePath.trim()
        ? feedback.sourcePath
        : typeof record.source.path === "string"
          ? record.source.path
          : "";
      const sourceResult = cleanSessionFeedbackPath(rawSourcePath, options);
      const sourcePath = sourceResult.path;
      if (sourceResult.vaultExternalAbsolute) {
        warnings.push(`${feedbackLabel}: skipped feedback with vault-external absolute source path.`);
        continue;
      }
      if (!sourcePath) {
        warnings.push(`${feedbackLabel}: skipped feedback without source path.`);
        continue;
      }
      const memoryResult = cleanSessionFeedbackPath(typeof feedback.memory === "string" ? feedback.memory : "", options);
      const memoryPath = memoryResult.path;
      if (memoryResult.vaultExternalAbsolute) {
        warnings.push(`${feedbackLabel}: skipped ${LABEL_FOR_ACTION[action]} feedback with vault-external absolute memory path.`);
        continue;
      }
      if (!memoryPath) {
        warnings.push(`${feedbackLabel}: skipped ${LABEL_FOR_ACTION[action]} feedback without memory path.`);
        continue;
      }

      const eventId = sessionFeedbackEventId({ action, createdAt, sourcePath, memoryPath });
      if (seenEventIds.has(eventId)) {
        warnings.push(`${feedbackLabel}: ignored duplicate feedback event ${eventId}.`);
        continue;
      }
      seenEventIds.add(eventId);
      seen += 1;

      const sourceTitle = typeof feedback.sourceTitle === "string" && feedback.sourceTitle.trim()
        ? feedback.sourceTitle.trim()
        : typeof record.source.title === "string" && record.source.title.trim()
          ? record.source.title.trim()
          : titleFromPath(sourcePath);
      if (!groups.has(sourcePath)) {
        groups.set(sourcePath, makeEmptyGroup(sourcePath, sourceTitle));
      }
      addSeedToGroup(groups.get(sourcePath), {
        action,
        label: LABEL_FOR_ACTION[action],
        createdAt,
        eventId,
        memoryPath,
        seen,
        sourcePath,
        sourceTitle,
      });
    }
  }

  const cases = Array.from(groups.values())
    .map(groupToCase)
    .filter(Boolean)
    .sort((a, b) => a.id.localeCompare(b.id));
  if (seenEventIds.size === 0) {
    warnings.push("No supported Session Store feedback events were found; the draft seed inbox is empty.");
  }

  return compactObject({
    _说明: {
      用途: "Aha Session Store 反馈动作生成的本地私有 draft cases；只作为 seed inbox，不会自动进入主 benchmark。",
      输入字段: {
        "input.note": "Session Record 记录的 source note 路径；目前没有行号时显式 whole_note，人工提升到主 benchmark 前应补 lines。",
        "input.whole_note": "显式表示当前 seed 暂时使用整篇 source note；不是漏写 lines 的隐式结果。",
      },
      评分字段: {
        "gold.must": "should_have_found feedback",
        "gold.nice": "accept feedback",
        "gold.noise": "reject_as_noise feedback",
      },
    },
    description: "Aha Session Feedback Seeds - generated private draft cases",
    version: 3,
    collection: options.collection || DEFAULT_COLLECTION,
    suites: {
      development: { version: SEED_INBOX_SUITE_VERSION },
    },
    expected_in_top_k: 10,
    nice_expected_in_top_k: 20,
    expanded_pool_expected_in_top_k: 20,
    generated_at: generatedAt.toISOString(),
    source: "session-feedback-seeds",
    review_seed_policy: "Generated from compact Aha Session Store feedback. Treat as a development draft; inspect labels and mode before activation. Never promote directly into holdout.",
    cases,
    warnings: warnings.length > 0 ? warnings : undefined,
  });
}

export function collectSessionFeedbackSeedCases(options = {}) {
  const vaultRoot = resolve(options.vaultRoot ? expandHome(options.vaultRoot) : benchVaultRoot());
  const pluginDataPath = options.pluginDataPath
    ? resolve(expandHome(options.pluginDataPath))
    : resolve(vaultRoot, ".obsidian", "plugins", options.pluginId || DEFAULT_PLUGIN_ID, "data.json");
  let pluginData;
  try {
    pluginData = JSON.parse(readFileSync(pluginDataPath, "utf-8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not read valid Aha plugin data from ${pluginDataPath}: ${message}`);
  }
  const document = buildSessionFeedbackSeedCaseDocument(pluginData, { ...options, vaultRoot });
  return {
    vaultRoot,
    pluginDataPath,
    feedbackEventCount: document.cases.reduce((total, caseItem) => total + caseItem.seed_provenance.seed_count, 0),
    ...document,
  };
}

export function collectReviewSeedCasesFromVault(options = {}) {
  const vaultRoot = resolve(options.vaultRoot ? expandHome(options.vaultRoot) : benchVaultRoot());
  const rawReviewFolder = normalizeSlash(options.reviewFolder || DEFAULT_REVIEW_FOLDER);
  const reviewFolder = isAbsolute(rawReviewFolder)
    ? rawReviewFolder.replace(/\/+$/g, "")
    : rawReviewFolder.replace(/^\/+|\/+$/g, "");
  const reviewRoot = isAbsolute(reviewFolder) ? reviewFolder : resolve(vaultRoot, reviewFolder);
  const notes = listMarkdownFiles(reviewRoot).map((file) => ({
    path: relative(vaultRoot, file).replace(/\\/g, "/"),
    content: readFileSync(file, "utf-8"),
  }));
  const document = buildReviewSeedCaseDocument(notes, { ...options, vaultRoot });
  return {
    vaultRoot,
    reviewRoot,
    reviewNoteCount: notes.length,
    ...document,
  };
}

export function writeReviewSeedCaseDocument(document, outputPath = DEFAULT_SEED_CASES_PATH) {
  for (const caseItem of document?.cases ?? []) {
    if (caseItem?.state !== "draft" || caseItem?.suite !== "development") {
      throw new Error("Seed inbox only accepts draft development cases; holdout and active cases require a separate curated workflow.");
    }
  }
  const resolved = resolve(outputPath);
  mkdirSync(dirname(resolved), { recursive: true });
  const temporaryPath = resolve(dirname(resolved), `.${basename(resolved)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(document, null, 2)}\n`, { encoding: "utf-8", mode: 0o600, flag: "wx" });
    renameSync(temporaryPath, resolved);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
  return resolved;
}

function parseReviewBenchmarkSeedSection(section, fullContent, fallback) {
  const createdAt = section.match(/^### Review Benchmark Seed - (.+)$/m)?.[1]?.trim() || "";
  const fields = new Map();
  for (const line of section.split("\n")) {
    const field = line.match(/^-\s*([^:]+):\s*(.*)$/);
    if (field) fields.set(field[1].trim(), stripWrappingBackticks(field[2].trim()));
  }

  const source = fields.get("source") || "";
  const parsedSource = parseObsidianMarkdownLink(source);
  const memory = fields.get("memory") || "";
  const parsedMemory = parseObsidianMarkdownLink(memory);
  const action = fields.get("action") || "accept";
  const seedLabel = fields.get("seed_label") || LABEL_FOR_ACTION[action] || "nice_to_have";

  return {
    action,
    status: "draft",
    seedLabel,
    createdAt,
    sourcePath: cleanPath(parsedSource?.path || source || fallback.sourcePath || frontmatterField(fullContent, "source_path"), fallback),
    sourceTitle: parsedSource?.title || fallback.sourceTitle || "",
    memory: memory || undefined,
    memoryPath: cleanPath(parsedMemory?.path || memory, fallback),
    relation: fields.get("relation") || undefined,
    hit: fields.get("hit") || undefined,
    why: fields.get("why") || undefined,
    note: fields.get("note") || undefined,
  };
}

function generatedBlockBody(content, blockName) {
  const start = `<!-- aha:${blockName}:start -->`;
  const end = `<!-- aha:${blockName}:end -->`;
  const startIndex = content.indexOf(start);
  const endIndex = content.indexOf(end);
  if (startIndex < 0 || endIndex < 0 || endIndex < startIndex) return null;
  return content.slice(startIndex + start.length, endIndex).trim();
}

function makeEmptyGroup(sourcePath, sourceTitle) {
  return {
    sourcePath,
    sourceTitle,
    labels: {
      must_recall: new Map(),
      nice_to_have: new Map(),
      negative: new Map(),
    },
    reviewNotePaths: new Set(),
    actions: new Set(),
    seeds: [],
  };
}

function addSeedToGroup(group, seed) {
  const label = LABEL_PRIORITY.includes(seed.label) ? seed.label : "nice_to_have";
  const key = canonicalPathKey(seed.memoryPath);
  if (!group.labels[label].has(key)) {
    group.labels[label].set(key, {
      path: seed.memoryPath,
      firstSeen: seed.seen,
      createdAt: seed.createdAt,
      relation: seed.relation,
      hit: seed.hit,
      why: seed.why,
    });
  }
  if (seed.reviewNotePath) group.reviewNotePaths.add(seed.reviewNotePath);
  group.actions.add(seed.action);
  group.seeds.push(seed);
}

function groupToCase(group) {
  const conflicts = resolveLabelConflicts(group.labels);
  const mustRecall = orderedPaths(group.labels.must_recall);
  const niceToHave = orderedPaths(group.labels.nice_to_have);
  const negative = orderedPaths(group.labels.negative);
  const seedCount = group.seeds.length;
  if (mustRecall.length + niceToHave.length + negative.length === 0) return null;

  const createdAtValues = group.seeds.map((seed) => seed.createdAt).filter(Boolean).sort();
  const feedbackEvents = group.seeds
    .filter((seed) => seed.eventId)
    .map((seed) => ({
      event_id: seed.eventId,
      action: seed.action,
      created_at: seed.createdAt,
    }))
    .sort((left, right) => left.created_at.localeCompare(right.created_at) || left.event_id.localeCompare(right.event_id));
  const fromSessionStore = feedbackEvents.length > 0;
  return compactObject({
    id: seedCaseId(group.sourcePath, Array.from(group.reviewNotePaths), createdAtValues[0]),
    state: "draft",
    suite: "development",
    evaluation_mode: "discovery",
    mode_review_required: true,
    provenance: {
      origin: fromSessionStore ? "session_feedback" : "legacy_review_note",
      reason: fromSessionStore
        ? "Uncurated Session Store feedback seed; verify labels, input range, and discovery mode before activation."
        : "Uncurated Review Note feedback seed; verify labels, input range, and discovery mode before activation.",
    },
    title: `Review feedback seeds for ${group.sourceTitle || group.sourcePath}`,
    input: {
      note: group.sourcePath,
      whole_note: true,
    },
    expected_no_recall: mustRecall.length === 0 ? true : undefined,
    gold: {
      must: mustRecall,
      nice: niceToHave,
      noise: negative,
    },
    why: fromSessionStore
      ? `Generated from ${seedCount} compact Aha Session Store feedback event${seedCount === 1 ? "" : "s"}; inspect labels and replace whole_note with line range before promotion.`
      : `Generated from ${seedCount} Obsidian Review Benchmark Seed${seedCount === 1 ? "" : "s"}; inspect labels and replace whole_note with line range before changing state to active.`,
    seed_label_conflicts: conflicts.length > 0 ? conflicts : undefined,
    seed_provenance: {
      review_note_paths: fromSessionStore ? undefined : Array.from(group.reviewNotePaths).sort(),
      feedback_events: fromSessionStore ? feedbackEvents : undefined,
      seed_count: seedCount,
      actions: Array.from(group.actions).sort(),
      first_seed_at: createdAtValues[0] || undefined,
      last_seed_at: createdAtValues.at(-1) || undefined,
    },
  });
}

function requireSessionStore(pluginData) {
  if (!isRecord(pluginData)) {
    throw new Error("Aha plugin data must be a JSON object.");
  }
  const sessionStore = pluginData.sessionStore;
  if (!isRecord(sessionStore) || sessionStore.schemaVersion !== 1) {
    throw new Error("Aha plugin data must contain Session Store schemaVersion 1.");
  }
  if (!isRecord(sessionStore.records)) {
    throw new Error("Aha Session Store must contain a records object.");
  }
  return sessionStore;
}

function normalizedTimestamp(value) {
  if (typeof value !== "string" || !value.trim()) return "";
  const timestamp = new Date(value);
  return Number.isNaN(timestamp.getTime()) ? "" : timestamp.toISOString();
}

function sessionFeedbackEventId({ action, createdAt, sourcePath, memoryPath }) {
  const hash = createHash("sha256")
    .update(["aha-session-feedback-v1", createdAt, action, sourcePath, memoryPath].join("\0"))
    .digest("hex")
    .slice(0, 24);
  return `session-feedback-${hash}`;
}

function sessionRecordLabel(recordKey) {
  const hash = createHash("sha256").update(String(recordKey)).digest("hex").slice(0, 10);
  return `Session Record ${hash}`;
}

function resolveLabelConflicts(labels) {
  const byMemory = new Map();
  for (const label of LABEL_PRIORITY) {
    for (const [key, record] of labels[label]) {
      const item = byMemory.get(key) ?? { memory: record.path, labels: [] };
      item.labels.push(label);
      byMemory.set(key, item);
    }
  }

  const conflicts = [];
  for (const [key, item] of byMemory) {
    if (item.labels.length <= 1) continue;
    const resolution = LABEL_PRIORITY.find((label) => item.labels.includes(label));
    for (const label of LABEL_PRIORITY) {
      if (label !== resolution) labels[label].delete(key);
    }
    conflicts.push({
      memory: item.memory,
      labels: item.labels.map(goldLabelForSeedLabel),
      resolution: goldLabelForSeedLabel(resolution),
    });
  }
  return conflicts;
}

function orderedPaths(map) {
  return Array.from(map.values())
    .sort((a, b) => a.firstSeen - b.firstSeen)
    .map((record) => record.path);
}

function goldLabelForSeedLabel(label) {
  if (label === "must_recall") return "must";
  if (label === "nice_to_have") return "nice";
  if (label === "negative") return "noise";
  return label;
}

function seedCaseId(sourcePath, reviewNotePaths, firstSeedAt) {
  const date = String(firstSeedAt || "seed")
    .slice(0, 10)
    .replace(/[^0-9]/g, "") || "seed";
  const sourceSlug = slug(basename(sourcePath, ".md")) || "source";
  const hash = createHash("sha256")
    .update([sourcePath, ...reviewNotePaths.sort()].join("\0"))
    .digest("hex")
    .slice(0, 8);
  return `seed-${date}-${sourceSlug}-${hash}`.slice(0, 96);
}

function seedLabel(seed) {
  const label = seed.seedLabel || LABEL_FOR_ACTION[seed.action];
  return LABEL_PRIORITY.includes(label) ? label : "nice_to_have";
}

function listMarkdownFiles(root) {
  if (!existsSync(root)) return [];
  const files = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const fullPath = resolve(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...listMarkdownFiles(fullPath));
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
      files.push(fullPath);
    }
  }
  return files.sort();
}

function parseObsidianMarkdownLink(value) {
  const match = String(value ?? "").match(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/);
  if (!match) return null;
  const target = match[1].replace(/\\\|/g, "|").trim();
  const alias = match[2]?.replace(/\\\|/g, "|").trim();
  return {
    path: ensureMarkdownExtension(target),
    title: alias || stripMarkdownExtension(basename(target)),
  };
}

function ensureMarkdownExtension(target) {
  if (/^qmd:\/\//i.test(target)) return target;
  const match = target.match(/^([^#^]+)(.*)$/);
  if (!match) return target;
  const base = match[1];
  const suffix = match[2] ?? "";
  return /\.md$/i.test(base) ? `${base}${suffix}` : `${base}.md${suffix}`;
}

function cleanPath(value, options = {}) {
  const raw = stripWrappingBackticks(String(value ?? "").trim());
  if (!raw) return "";
  const parsed = parseObsidianMarkdownLink(raw);
  if (parsed) return toVaultRelativePath(parsed.path, options);
  return toVaultRelativePath(raw.replace(/^<|>$/g, "").trim(), options);
}

function cleanSessionFeedbackPath(value, options = {}) {
  const raw = stripWrappingBackticks(String(value ?? "").trim());
  if (!raw) return { path: "", vaultExternalAbsolute: false };
  const parsed = parseObsidianMarkdownLink(raw);
  const target = parsed?.path || raw.replace(/^<|>$/g, "").trim();
  const { path: undecoratedPath } = splitPathDecorations(target);
  const expandedPath = expandHome(undecoratedPath);
  if (isAbsolute(expandedPath)) {
    const configuredRoot = String(options.vaultRoot ?? "").trim();
    if (!configuredRoot || isOutsideRoot(expandedPath, configuredRoot)) {
      return { path: "", vaultExternalAbsolute: true };
    }
  }
  return {
    path: toVaultRelativePath(target, options),
    vaultExternalAbsolute: false,
  };
}

function isOutsideRoot(candidatePath, rootPath) {
  const rel = normalizeSlash(relative(resolve(expandHome(rootPath)), resolve(expandHome(candidatePath))));
  return rel === ".." || rel.startsWith("../") || isAbsolute(rel);
}

function canonicalPathKey(value) {
  return cleanPath(value).replace(/[?#].*$/, "").replace(/^qmd:\/\/[^/]+\//, "").toLowerCase();
}

function frontmatterField(content, key) {
  const match = String(content ?? "").match(/^---\n([\s\S]*?)\n---/);
  if (!match) return "";
  const line = match[1].split(/\r?\n/).find((item) => item.match(new RegExp(`^${escapeRegExp(key)}\\s*:`)));
  if (!line) return "";
  return line.replace(/^[^:]+:\s*/, "").replace(/^"|"$/g, "").trim();
}

function frontmatterSourceTitle(content) {
  const source = frontmatterField(content, "source");
  const parsed = parseObsidianMarkdownLink(source);
  return parsed?.title || "";
}

function stripWrappingBackticks(value) {
  return value.replace(/^`([^`]+)`$/, "$1").trim();
}

function stripMarkdownExtension(value) {
  return String(value ?? "").replace(/\.md$/i, "");
}

function titleFromPath(value) {
  return stripMarkdownExtension(basename(String(value ?? ""))) || "Untitled Insight";
}

function slug(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/\.md$/i, "")
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function compactObject(value) {
  if (Array.isArray(value)) return value.map(compactObject);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .map(([key, entry]) => [key, compactObject(entry)]),
  );
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
