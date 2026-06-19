#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";

const ROOT = resolve(process.env.AHA_BENCH_VAULT_ROOT || "bench/synthetic/vault");

const CANDIDATES = [
  "support/direct-support.md",
  "challenge/counterexample.md",
  "boundary/quiet-boundary.md",
  "resemblance/garden-resemblance.md",
  "duplicates/alpha/project-note.md",
  "duplicates/beta/project-note.md",
  "aliases/north-star.md",
  "source/old-memory.md",
  "cues/deep-cue.md",
  "second-round/second-round.md",
  "source/source-note.md",
  "none/unrelated.md",
];

const BACKLINKS = {
  "support/direct-support.md": ["source/old-memory.md"],
  "source/source-note.md": ["source/old-memory.md"],
  "cues/deep-cue.md": ["second-round/second-round.md"],
};

function notePath(relativePath) {
  return resolve(ROOT, relativePath);
}

function readNote(relativePath) {
  const path = notePath(relativePath);
  return existsSync(path) ? readFileSync(path, "utf-8") : "";
}

function titleFor(relativePath) {
  const content = readNote(relativePath);
  const heading = content.match(/^#\s+(.+)$/m)?.[1];
  return heading || basename(relativePath, ".md");
}

function row(relativePath, index, query = "synthetic") {
  return {
    file: relativePath,
    path: relativePath,
    title: titleFor(relativePath),
    snippet: readNote(relativePath).replace(/^#.*\n?/, "").trim().replace(/\s+/g, " ").slice(0, 300),
    score: Number((1 - index / 100).toFixed(3)),
    query,
  };
}

function orderedCandidates(query = "synthetic") {
  const text = String(query || "");
  if (!/Source note:/i.test(text)) return CANDIDATES;
  return [
    "source/source-note.md",
    ...CANDIDATES.filter((candidate) => candidate !== "source/source-note.md"),
  ];
}

function qmdRows(query = "synthetic") {
  return orderedCandidates(query).map((candidate, index) => row(candidate, index, query));
}

function emitJson(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function handleBenchFixture(args) {
  const fixturePath = args.find((arg) => arg.endsWith(".json") && existsSync(resolve(arg)));
  const fixture = fixturePath ? JSON.parse(readFileSync(resolve(fixturePath), "utf-8")) : { queries: [] };
  const results = (fixture.queries || []).map((query) => ({
    id: query.id,
    query: query.query,
    backends: {
      full: {
        top_files: qmdRows(query.query).map((item) => item.file),
        latency_ms: 1,
      },
    },
  }));
  emitJson({
    metadata: {
      provider: "aha-synthetic-provider",
      fixture: fixturePath || null,
    },
    results,
    summary: {
      full: {
        cases: results.length,
        avg_latency_ms: 1,
      },
    },
  });
}

function valueAfterPrefix(args, prefix) {
  const item = args.find((arg) => arg.startsWith(prefix));
  return item ? item.slice(prefix.length) : "";
}

function normalizeFile(value) {
  const raw = String(value || "").replace(/^path=/, "").replace(/^file=/, "").replace(/\\/g, "/");
  const withoutRoot = raw.startsWith(ROOT) ? raw.slice(ROOT.length + 1) : raw;
  const byPath = CANDIDATES.find((candidate) => candidate === withoutRoot || candidate.endsWith(`/${withoutRoot}`));
  if (byPath) return byPath;
  const byTitle = CANDIDATES.find((candidate) => titleFor(candidate) === raw || basename(candidate, ".md") === raw);
  return byTitle || withoutRoot;
}

function handleBacklinks(args) {
  const target = normalizeFile(valueAfterPrefix(args, "path=") || valueAfterPrefix(args, "file="));
  const links = (BACKLINKS[target] || []).map((relativePath) => ({
    path: relativePath,
    title: titleFor(relativePath),
    count: 1,
  }));
  emitJson(links);
}

function handleRead(args) {
  const target = normalizeFile(valueAfterPrefix(args, "path=") || valueAfterPrefix(args, "file="));
  const content = readNote(target);
  if (!content) {
    process.stderr.write(`not found: ${target}\n`);
    process.exit(1);
  }
  process.stdout.write(content);
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes("--version") || args[0] === "version") {
    console.log("aha-synthetic-provider 1.0.0");
    return;
  }
  if (args[0] === "backlinks") return handleBacklinks(args.slice(1));
  if (args[0] === "read") return handleRead(args.slice(1));

  const subcommand = args.find((arg) => ["query", "vsearch", "search"].includes(arg));
  if (subcommand) {
    const query = args[args.indexOf(subcommand) + 1] || "synthetic";
    emitJson(qmdRows(query));
    return;
  }

  if (args.includes("bench") || args.some((arg) => arg.endsWith(".json"))) {
    handleBenchFixture(args);
    return;
  }

  emitJson([]);
}

main();
