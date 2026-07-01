import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { expandHome, normalizeSlash, toVaultRelativePath } from "./vault-paths.mjs";

export const DEFAULT_REVIEW_FOLDER = "Aha/Reviews";
export const DEFAULT_SEED_CASES_PATH = "bench/aha-memory-seed-cases.json";
export const DEFAULT_COLLECTION = "obsidian";

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
    expected_in_top_k: 10,
    nice_expected_in_top_k: 20,
    expanded_pool_expected_in_top_k: 20,
    generated_at: generatedAt.toISOString(),
    source: "review-benchmark-seeds",
    review_seed_policy: "Generated from Obsidian Review Note actions. Treat as draft; inspect labels before promoting to active benchmark cases.",
    cases,
    warnings: warnings.length > 0 ? warnings : undefined,
  });
}

export function collectReviewSeedCasesFromVault(options = {}) {
  const vaultRoot = resolve(expandHome(options.vaultRoot || process.env.AHA_BENCH_VAULT_ROOT || "/Users/hong/Obsidian Notes"));
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
  const resolved = resolve(outputPath);
  mkdirSync(dirname(resolved), { recursive: true });
  writeFileSync(resolved, `${JSON.stringify(document, null, 2)}\n`);
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
  return compactObject({
    id: seedCaseId(group.sourcePath, Array.from(group.reviewNotePaths), createdAtValues[0]),
    state: "draft",
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
    why: `Generated from ${seedCount} Obsidian Review Benchmark Seed${seedCount === 1 ? "" : "s"}; inspect labels and replace whole_note with line range before changing state to active.`,
    seed_label_conflicts: conflicts.length > 0 ? conflicts : undefined,
    seed_provenance: {
      review_note_paths: Array.from(group.reviewNotePaths).sort(),
      seed_count: seedCount,
      actions: Array.from(group.actions).sort(),
      first_seed_at: createdAtValues[0] || undefined,
      last_seed_at: createdAtValues.at(-1) || undefined,
    },
  });
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
