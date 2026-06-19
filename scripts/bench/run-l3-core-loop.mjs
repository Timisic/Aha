#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";

const DEFAULT_REPORT = "bench/reports/latest/l3-core-loop.json";

function parseArgs() {
  const options = { report: DEFAULT_REPORT };
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--report") {
      options.report = args[++index] ?? options.report;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function timestampForPath() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function archiveReportPath(reportPath) {
  return resolve("bench/reports/archive", `${basename(reportPath, ".json")}-${timestampForPath()}.json`);
}

function runUltraqa() {
  return spawnSync("npm", ["run", "test:ultraqa"], {
    cwd: resolve("insight-package"),
    encoding: "utf-8",
    timeout: 120_000,
  });
}

function extractUltraqaMatrix(output) {
  const marker = "ULTRAQA_MATRIX ";
  const start = output.indexOf(marker);
  if (start < 0) return [];
  const after = output.slice(start + marker.length);
  const endMarker = "\nultraqa insight extension adversarial tests passed";
  const end = after.indexOf(endMarker);
  const json = end >= 0 ? after.slice(0, end) : after;
  try {
    return JSON.parse(json);
  } catch {
    return [];
  }
}

function main() {
  const options = parseArgs();
  const result = runUltraqa();
  const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
  const matrix = extractUltraqaMatrix(output);
  const ok = result.status === 0 && matrix.length > 0 && matrix.every((item) => item.status === "pass");
  const report = {
    generated_at: new Date().toISOString(),
    benchmark: "aha-l3-core-loop",
    ok,
    command: "cd insight-package && npm run test:ultraqa",
    exit_status: result.status,
    checks: [
      "candidate table appears before grill",
      "user accept/reject review state is persisted",
      "summary before readiness is rejected",
      "used memory requires accepted review",
      "summary draft writes artifact after readiness",
      "source note is not rewritten",
      "resume preserves stage/review state",
      "new insight can trigger a second memory search",
    ],
    ultraqa_matrix: matrix,
    output_tail: output.split(/\r?\n/).slice(-80),
  };

  mkdirSync(dirname(resolve(options.report)), { recursive: true });
  writeFileSync(resolve(options.report), `${JSON.stringify(report, null, 2)}\n`);
  const archivePath = archiveReportPath(options.report);
  mkdirSync(dirname(archivePath), { recursive: true });
  writeFileSync(archivePath, `${JSON.stringify(report, null, 2)}\n`);

  console.log(`L3 report: ${options.report}`);
  console.log(`L3 status: ${ok ? "pass" : "fail"}`);
  if (!ok) process.exit(1);
}

main();
