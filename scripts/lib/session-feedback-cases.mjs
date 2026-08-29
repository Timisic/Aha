// Turns Review Panel accept / reject_as_noise / should_have_found feedback
// (recorded live into the plugin's data.json Session Store, see ADR 0004)
// into draft benchmark cases. This is the direct successor to the removed
// scripts/lib/review-seeds.mjs, which parsed the same three actions out of
// exported Review Note markdown -- that export format is gone (see "Remove
// Review Note markdown feature entirely"), but the actions and their
// gold-label mapping are unchanged: accept -> gold.nice, reject_as_noise ->
// gold.noise, should_have_found -> gold.must. The source of truth is now
// read straight from Session Store, so this never needs a markdown export
// step in between.
//
// Grouping is per Session Store record (one record per source-note identity,
// see source-identity.ts), not per review note -- a record's `feedback[]`
// already spans every review round ever run for that note. Within a record,
// if the same memory path collected conflicting labels over time (e.g.
// accepted once, later marked noise), the most recent feedback entry wins;
// every conflict is still recorded in `feedback_label_conflicts` so nothing
// is silently dropped.

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { toVaultRelativePath } from "./vault-paths.mjs";

export const DEFAULT_SESSION_FEEDBACK_CASES_PATH = "bench/aha-memory-seed-cases.json";
export const DEFAULT_COLLECTION = "obsidian";

// Priority only matters as a tie-breaker display in feedback_label_conflicts;
// resolution itself is last-feedback-wins (see module comment).
const LABEL_PRIORITY = ["must_recall", "negative", "nice_to_have"];

export function buildSessionFeedbackCaseDocument(records, options = {}) {
  const generatedAt = options.generatedAt instanceof Date ? options.generatedAt : new Date(options.generatedAt ?? Date.now());
  const warnings = [];
  const cases = [];

  for (const record of records) {
    const feedback = Array.isArray(record?.feedback) ? record.feedback : [];
    if (feedback.length === 0) continue;

    const sourcePath = cleanPath(record.source?.path, options);
    const sourceTitle = record.source?.title || titleFromPath(sourcePath);
    if (!sourcePath) {
      warnings.push(`${record.key || "(unknown record)"}: skipped -- record has feedback but no source.path.`);
      continue;
    }

    // Two independent tracks: must/nice/noise are mutually-exclusive
    // classifications of a candidate (byMemory, last-feedback-wins), while
    // surprise is an additive tag layered on top -- a note can be both
    // accepted (nice) and surprising at once, so it never competes for or
    // overwrites a byMemory slot (see the "surprise" `gold` field's comment
    // in scripts/lib/bench-cases.mjs).
    const byMemory = new Map();
    const surpriseByMemory = new Map();
    for (const [seen, entry] of feedback.entries()) {
      const memoryPath = cleanPath(entry.memory, options);
      if (!memoryPath) {
        warnings.push(`${sourcePath}: skipped ${entry.action || entry.seedLabel || "unknown"} feedback without a memory path/text at ${entry.createdAt || "unknown time"}.`);
        continue;
      }
      if (entry.action === "should_have_found" && !looksLikeNotePath(memoryPath)) {
        warnings.push(`${sourcePath}: should_have_found memory "${memoryPath}" does not look like a note path -- verify/replace before promoting.`);
      }

      const key = canonicalPathKey(memoryPath);

      if (entry.seedLabel === "surprise") {
        if (!surpriseByMemory.has(key)) {
          surpriseByMemory.set(key, {
            path: memoryPath,
            action: entry.action,
            createdAt: entry.createdAt,
            relation: entry.relation,
            hit: entry.hit,
            why: entry.why,
            firstSeen: seen,
          });
        }
        continue;
      }

      const label = LABEL_PRIORITY.includes(entry.seedLabel) ? entry.seedLabel : "nice_to_have";
      const existing = byMemory.get(key);
      if (existing && existing.label !== label) {
        existing.conflictLabels.add(existing.label);
        existing.conflictLabels.add(label);
      }
      byMemory.set(key, {
        path: memoryPath,
        label,
        action: entry.action,
        createdAt: entry.createdAt,
        relation: entry.relation,
        hit: entry.hit,
        why: entry.why,
        firstSeen: existing?.firstSeen ?? seen,
        conflictLabels: existing?.conflictLabels ?? new Set(),
      });
    }

    if (byMemory.size === 0 && surpriseByMemory.size === 0) continue;

    const entries = Array.from(byMemory.values()).sort((a, b) => a.firstSeen - b.firstSeen);
    const surpriseEntries = Array.from(surpriseByMemory.values()).sort((a, b) => a.firstSeen - b.firstSeen);
    const must = entries.filter((entry) => entry.label === "must_recall").map((entry) => entry.path);
    const nice = entries.filter((entry) => entry.label === "nice_to_have").map((entry) => entry.path);
    const noise = entries.filter((entry) => entry.label === "negative").map((entry) => entry.path);
    const surprise = surpriseEntries.map((entry) => entry.path);
    const conflicts = entries
      .filter((entry) => entry.conflictLabels.size > 0)
      .map((entry) => ({
        memory: entry.path,
        seen_labels: Array.from(entry.conflictLabels).map(goldLabelForSeedLabel),
        resolved: goldLabelForSeedLabel(entry.label),
      }));

    const createdAtValues = feedback.map((entry) => entry.createdAt).filter(Boolean).sort();
    const actions = Array.from(new Set(feedback.map((entry) => entry.action).filter(Boolean))).sort();

    cases.push(compactObject({
      id: caseId(sourcePath, record.key, createdAtValues[0]),
      state: "draft",
      title: `Review feedback seeds for ${sourceTitle}`,
      input: {
        note: sourcePath,
        whole_note: true,
      },
      expected_no_recall: must.length === 0 ? true : undefined,
      gold: { must, nice, noise, surprise },
      why: `Generated from ${feedback.length} Session Store feedback entr${feedback.length === 1 ? "y" : "ies"}; inspect labels (especially should_have_found paths) and replace whole_note with a line range before promoting to active.`,
      feedback_label_conflicts: conflicts.length > 0 ? conflicts : undefined,
      feedback_provenance: {
        record_key: record.key,
        feedback_count: feedback.length,
        actions,
        first_seed_at: createdAtValues[0] || undefined,
        last_seed_at: createdAtValues.at(-1) || undefined,
        details: [...entries, ...surpriseEntries]
          .sort((a, b) => a.firstSeen - b.firstSeen)
          .map((entry) => compactObject({
            memory: entry.path,
            label: goldLabelForSeedLabel(entry.label ?? "surprise"),
            action: entry.action,
            created_at: entry.createdAt,
            relation: entry.relation,
            hit: entry.hit,
            why: entry.why,
          })),
      },
    }));
  }

  cases.sort((a, b) => a.id.localeCompare(b.id));

  return compactObject({
    _说明: {
      用途: "Aha Session Store 反馈动作 (accept / reject_as_noise / should_have_found / surprise) 生成的本地私有 draft cases；只作为 seed inbox，不会自动进入主 benchmark。",
      输入字段: {
        "input.note": "反馈记录的 source note 路径；目前没有行号时显式 whole_note，人工提升到主 benchmark 前应补 lines。",
        "input.whole_note": "显式表示当前 seed 暂时使用整篇 source note；不是漏写 lines 的隐式结果。",
      },
      评分字段: {
        "gold.must": "should_have_found seeds -- memory 字段是用户手输的路径/[[链接]]，promote 前务必核实真实存在。",
        "gold.nice": "accept seeds",
        "gold.noise": "reject_as_noise seeds",
        "gold.surprise": "surprise seeds -- 独立的附加标签，不参与 must/nice/noise 的冲突互斥，同一条 memory 可以同时出现在 gold.surprise 和其他 gold 分类里。暂未接入任何 eval-v2 打分指标，只是先把数据落到 case 里。",
      },
      冲突解决: "must/nice/noise 三者互斥：同一 source 下同一条 memory 出现多个不同标签时，取最新一次反馈的标签，所有历史标签都记在 feedback_label_conflicts。surprise 不参与这个互斥判定。",
    },
    description: "Aha Session Store Feedback Seeds - generated private draft cases",
    version: 3,
    collection: options.collection || DEFAULT_COLLECTION,
    expected_in_top_k: 10,
    nice_expected_in_top_k: 20,
    expanded_pool_expected_in_top_k: 20,
    generated_at: generatedAt.toISOString(),
    source: "session-store-feedback",
    seed_policy: "Generated from the plugin's Session Store feedback (data.json). Treat as draft; inspect labels before promoting to active benchmark cases.",
    cases,
    warnings: warnings.length > 0 ? warnings : undefined,
  });
}

export function collectSessionFeedbackCasesFromSessionStore(sessionStore, options = {}) {
  const records = Object.values(sessionStore?.records ?? {});
  return buildSessionFeedbackCaseDocument(records, options);
}

export function writeSessionFeedbackCaseDocument(document, outputPath = DEFAULT_SESSION_FEEDBACK_CASES_PATH) {
  const resolved = resolve(outputPath);
  mkdirSync(dirname(resolved), { recursive: true });
  writeFileSync(resolved, `${JSON.stringify(document, null, 2)}\n`);
  return resolved;
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
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  const parsed = parseObsidianMarkdownLink(raw);
  if (parsed) return toVaultRelativePath(parsed.path, options);
  return toVaultRelativePath(raw, options);
}

function canonicalPathKey(value) {
  return String(value ?? "").replace(/[?#].*$/, "").replace(/^qmd:\/\/[^/]+\//, "").toLowerCase();
}

function looksLikeNotePath(value) {
  return /\.md($|[?#])/i.test(value) || value.includes("/");
}

function goldLabelForSeedLabel(label) {
  if (label === "must_recall") return "must";
  if (label === "nice_to_have") return "nice";
  if (label === "negative") return "noise";
  return label;
}

function caseId(sourcePath, recordKey, firstSeedAt) {
  const date = String(firstSeedAt || "seed").slice(0, 10).replace(/[^0-9]/g, "") || "seed";
  const sourceSlug = slug(basename(sourcePath, ".md")) || "source";
  const hash = createHash("sha256").update(String(recordKey ?? sourcePath)).digest("hex").slice(0, 8);
  return `seed-${date}-${sourceSlug}-${hash}`.slice(0, 96);
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
    .replace(/[^a-z0-9一-鿿]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
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
