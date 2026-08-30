// Rename runtime traces without rewriting their evidence. Dry run by default.
// Apply makes a private backup + mapping first. Session Store updates are done
// through the running plugin, never by racing its data.json with offline writes.
import { copyFile, link, mkdir, readFile, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { traceFileBaseName } from "../lib/session-artifact.mjs";

export async function planTraceRenames(directory) {
  const root = path.resolve(directory);
  const names = (await readdir(root)).sort();
  const used = new Set(names);
  const entries = [];
  for (const name of names.filter(n => n.endsWith(".json"))) {
    const from = path.join(root, name);
    const bytes = await readFile(from);
    let trace;
    try { trace = JSON.parse(bytes); } catch { continue; }
    if (trace.schema !== "PipelineTrace" || !["plugin", "batch"].includes(trace.origin)) continue;
    const stamp = name.match(/-(\d{13})(?:-[a-f0-9]+)?\.json$/)?.[1];
    const named = name.match(/__(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})(?:-\d+)?\.json$/);
    const namedDate = named ? new Date(Number(named[1]), Number(named[2]) - 1, Number(named[3]), Number(named[4]), Number(named[5]), Number(named[6])) : null;
    const generatedAt = trace.generated_at || (stamp ? new Date(Number(stamp)).toISOString() : namedDate ? namedDate.toISOString() : (await stat(from)).mtime.toISOString());
    const base = traceFileBaseName(trace.case.title || path.basename(trace.case.id, ".md"), generatedAt);
    // Already-normalized files must keep their collision suffix on reruns.
    let target = name.startsWith(`${base}.`) || name.startsWith(`${base}-`) ? name : `${base}.json`;
    if (target !== name) {
      for (let i = 2; used.has(target); i++) target = `${base}-${i}.json`;
    }
    used.add(target);
    entries.push({ from, to: path.join(root, target), sourcePath: trace.case.id, origin: trace.origin, generatedAt, sha256: createHash("sha256").update(bytes).digest("hex") });
  }
  return entries;
}

export async function applyTraceRenames(entries, backupDirectory) {
  await mkdir(backupDirectory, { recursive: true, mode: 0o700 });
  await writeFile(path.join(backupDirectory, "mapping.json"), JSON.stringify(entries, null, 2), { mode: 0o600, flag: "wx" });
  for (const entry of entries.filter(e => e.from !== e.to)) {
    const current = await readFile(entry.from);
    if (createHash("sha256").update(current).digest("hex") !== entry.sha256) throw new Error(`Trace changed after planning: ${entry.from}`);
    await copyFile(entry.from, path.join(backupDirectory, path.basename(entry.from)));
    // Same-directory link + unlink preserves bytes/mtime and atomically
    // refuses collisions, including files created after planning.
    await link(entry.from, entry.to);
    await unlink(entry.from);
  }
}

export function relinkTraceReferences(store, entries) {
  let linked = 0;
  for (const record of Object.values(store.records ?? {})) {
    for (const round of record.rounds ?? []) {
      const exact = entries.filter(e => round.trace?.path === e.from || round.trace?.path === e.to || (round.warnings ?? []).includes(`Pipeline trace saved: ${e.from}`));
      const matches = exact.length ? exact : entries.filter(e => e.sourcePath === round.sourcePath && Math.abs(Date.parse(e.generatedAt) - Date.parse(round.generatedAt)) < 1000);
      if (matches.length !== 1) continue;
      const entry = matches[0];
      round.trace = { path: entry.to, origin: entry.origin };
      round.warnings = (round.warnings ?? []).map(w => w === `Pipeline trace saved: ${entry.from}` ? `Pipeline trace saved: ${entry.to}` : w);
      linked++;
    }
  }
  return linked;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [directory, ...flags] = process.argv.slice(2);
  if (!directory || flags.some(f => f !== "--apply")) throw new Error("Usage: node scripts/dev/rename-traces.mjs <directory> [--apply]");
  const entries = await planTraceRenames(directory);
  if (flags.includes("--apply")) {
    const backup = path.join(path.resolve(directory), ".filename-backups", new Date().toISOString().replace(/[:.]/g, "-"));
    await applyTraceRenames(entries, backup);
    console.error(`Backup and mapping: ${backup}`);
  }
  console.log(JSON.stringify(entries, null, 2));
}
