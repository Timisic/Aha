import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, copyFile, mkdir, readdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';

export async function prepare(run) {
  assert(process.env.AHA_VERIFY_SOURCE_VAULT_ROOT, 'Set AHA_VERIFY_SOURCE_VAULT_ROOT explicitly for a read-only production-index benchmark');
  const sourceRoot = await realpath(process.env.AHA_VERIFY_SOURCE_VAULT_ROOT);
  assert(sourceRoot !== run.vault);
  const copied = [];
  async function copyNotes(relative = '') {
    for (const entry of await readdir(path.join(sourceRoot, relative), { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const target = path.join(relative, entry.name);
      if (entry.isDirectory()) await copyNotes(target);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
        assert(target !== 'Source.md', 'Fixture Source.md must not shadow a real indexed note');
        await mkdir(path.dirname(path.join(run.vault, target)), { recursive: true });
        await copyFile(path.join(sourceRoot, target), path.join(run.vault, target));
        copied.push(target);
      }
    }
  }
  await copyNotes();
  const resolved = spawnSync('which', [process.env.AHA_VERIFY_QMD_COMMAND || 'qmd'], { encoding: 'utf8' });
  assert.equal(resolved.status, 0, 'QMD CLI is required');
  run.qmdCommand = path.join(run.scratch, 'qmd-readonly.mjs');
  const log = path.join(run.evidence, 'qmd-requests.jsonl');
  await writeFile(run.qmdCommand, `#!${process.execPath}
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {appendFileSync} from 'node:fs';
const args=process.argv.slice(2);
assert(args[0]==='query' && args.includes('--no-rerank'), 'Production fixture permits read-only quick-link queries only');
const env={...process.env,HOME:${JSON.stringify(process.env.HOME)}};
delete env.QMD_CONFIG_DIR;delete env.XDG_CACHE_HOME;delete env.INDEX_PATH;
const start=Date.now();appendFileSync(${JSON.stringify(log)},JSON.stringify({event:'start',at:start,args})+'\\n');
const child=spawn(${JSON.stringify(resolved.stdout.trim())},args,{env,stdio:['ignore','pipe','pipe']});let output='';
child.stdout.on('data',data=>output+=data);child.stderr.on('data',data=>process.stderr.write(data));
process.on('SIGTERM',()=>child.kill('SIGTERM'));
child.on('error',()=>process.exit(1));
child.on('close',(code,signal)=>{process.stdout.write(output.split(${JSON.stringify(sourceRoot + path.sep)}).join(${JSON.stringify(run.vault + path.sep)}));appendFileSync(${JSON.stringify(log)},JSON.stringify({event:'end',at:Date.now(),code,signal,elapsedMs:Date.now()-start})+'\\n');process.exit(code??1)});
`);
  await chmod(run.qmdCommand, 0o755);
  await writeFile(path.join(run.evidence, 'production-fixture.json'), JSON.stringify({ sourceRoot, copiedMarkdownFiles: copied.length, indexAccess: 'query only; absolute result paths mapped to owned snapshot; no index updates', privacy: 'Local evidence may contain copied private note excerpts and titles. Never commit it.' }, null, 2));
}
