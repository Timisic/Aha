#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFile, chmod, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

export async function drive(run, api) {
  const { connect, doctor, click, fill, key, until, snapshot, event, json, save, dataPath } = api;
  const cdp = await connect(run);
  let settings;
  const state = async () => (await json(dataPath(run))).indexState;
  const requests = async () => (await readFile(path.join(run.evidence,'qmd-requests.jsonl'),'utf8').catch(()=>''))
    .trim().split('\n').filter(Boolean).map(JSON.parse);
  const jobs = async () => (await requests()).filter(r=>r.event==='start' && ['update','embed'].includes(r.args[0]));
  const create = async n => {
    const name=`Added-${String(n).padStart(2,'0')}.md`;
    await writeFile(path.join(run.vault,name),`# Auto index note ${n}\n\nThis new note contains autoproof${n}. It records an incremental indexing acceptance check.\n`);
    await event(run,'create Markdown through vault filesystem',{path:name});
  };
  const openSettings = async () => {
    await cdp.send('Page.bringToFront');
    await key(cdp,',','Comma',4);
    settings=await until(()=>connect(run,'settings'),'owned Settings window');
    await settings.send('Page.bringToFront');
    await click(settings,'.vertical-tab-nav-item','Aha');
    await until(()=>settings.evaluate('!!document.querySelector(\'[aria-label="Automatic QMD index updates"]\')'),'index controls');
  };
  const capture = async label => {
    await settings.evaluate("document.querySelector('.aha-embed-status').scrollIntoView({block:'center'})");
    await settings.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    await snapshot(run,settings,label);
  };
  try {
    await doctor(run,cdp);
    await until(async()=>(await state())?.initialized,'inventory baseline');
    assert.deepEqual((await state()).pending,[]);
    assert.equal((await json(dataPath(run))).settings.autoIndexEnabled,false);
    await openSettings();
    await fill(settings,'input[aria-label="New notes per index update"]','10');
    await click(settings,'[aria-label="Automatic QMD index updates"]');
    await until(async()=>(await json(dataPath(run))).settings.autoIndexEnabled===true,'automatic indexing enabled from UI');
    await capture('index-enabled');
    for(let n=1;n<=9;n++)await create(n);
    await until(async()=>(await state()).pending.length===9,'nine new notes pending');
    assert.equal((await jobs()).length,0,'nine notes must not start an index job');
    await rename(path.join(run.vault,'Added-01.md'),path.join(run.vault,'Renamed-01.md'));
    await until(async()=>(await state()).notes.some(n=>n.path==='Renamed-01.md'),'rename reconciled');
    assert.equal((await state()).pending.length,9);
    await appendFile(path.join(run.vault,'Source.md'),'\n\nAn edit does not count as a new note.\n');
    await rm(path.join(run.vault,'Added-02.md'));
    await until(async()=>(await state()).pending.length===8,'deleted pending note removed');
    await create(2);
    await until(async()=>(await state()).pending.length===9,'replacement addition counted once');
    assert.equal((await jobs()).length,0);
    await capture('index-nine');
    await create(10);
    await until(async()=>(await jobs()).some(r=>r.args[0]==='update'),'tenth note starts real qmd update');
    await create(11);
    await create(12);
    await until(async()=>{
      const current=await state();
      return current.lastSuccess && current.pending.length===2 && (await jobs()).length===2;
    },'first real update and embed complete; concurrent additions retained',60000);
    assert.deepEqual((await jobs()).map(r=>r.args[0]),['update','embed']);
    await capture('index-first-success');
    const env={...process.env,QMD_CONFIG_DIR:path.join(run.scratch,'qmd-config'),XDG_CACHE_HOME:path.join(run.scratch,'qmd-cache')};
    delete env.INDEX_PATH;
    const search=spawnSync(run.qmdCommand,['search','autoproof10','--index','obsidian','-c','obsidian','--format','json','--full-path','-n','3'],{env,encoding:'utf8',timeout:10000});
    assert.equal(search.status,0);
    const result=JSON.parse(search.stdout.slice(search.stdout.indexOf('['),search.stdout.lastIndexOf(']')+1));
    assert(result.some(r=>r.file.endsWith('/Added-10.md')),'new note must be searchable in the real QMD index');
    await save(path.join(run.evidence,'index-new-note-search.json'),result);
    const vector=spawnSync(run.qmdCommand,['vsearch','This new note contains autoproof10. It records an incremental indexing acceptance check.','--index','obsidian','-c','obsidian','--format','json','--full-path','-n','20'],{env,encoding:'utf8',timeout:15000});
    assert.equal(vector.status,0);
    const vectorResult=JSON.parse(vector.stdout.slice(vector.stdout.indexOf('['),vector.stdout.lastIndexOf(']')+1));
    assert(vectorResult.some(r=>r.file.endsWith('/Added-10.md')),'new note must be returned by real vector search');
    await save(path.join(run.evidence,'index-new-note-vector-search.json'),vectorResult);
    await api.closeSettings(cdp, settings);
    settings=undefined;
    const previousDocument=await cdp.evaluate('performance.timeOrigin');
    await cdp.send('Page.reload',{ignoreCache:true});
    await until(()=>cdp.evaluate(`performance.timeOrigin !== ${previousDocument} && typeof app !== 'undefined' && !!app.plugins?.plugins?.['aha-memory-surface-dev']?.indexUpdates`),'plugin restarted');
    await doctor(run,cdp);
    await until(async()=>(await state()).pending.length===2,'pending survives reload');
    await openSettings();
    await chmod(run.qmdCommand,0o600);
    for(let n=13;n<=20;n++)await create(n);
    await until(async()=>{
      const current=await state();return current.pending.length===10 && current.error && current.retryAfter>Date.now();
    },'failed automatic update retains pending and cooldown');
    await capture('index-failed');
    await chmod(run.qmdCommand,0o755);
    await click(settings,'[aria-label="Embed now"]');
    await until(async()=>{
      const current=await state();return current.pending.length===0 && current.error===null && (await jobs()).length===4;
    },'manual retry completes one real update and embed',60000);
    assert.deepEqual((await jobs()).map(r=>r.args[0]),['update','embed','update','embed']);
    await capture('index-retry-success');
    await click(settings,'[aria-label="Automatic QMD index updates"]');
    await until(async()=>(await json(dataPath(run))).settings.autoIndexEnabled===false,'auto indexing disabled');
    for(let n=21;n<=30;n++)await create(n);
    await until(async()=>(await state()).pending.length===10,'disabled mode retains new-note ledger');
    assert.equal((await jobs()).length,4,'disabled mode cannot start another update');
    await capture('index-final');
    const observed=await state();
    await save(path.join(run.evidence,'report.json'),{status:'passed',fixture:'Real Obsidian vault file events and real QMD update/embed, isolated config/cache and synthetic notes',verified:['index.settings-toggle-threshold','index.initial-baseline','index.nine-does-not-run','index.tenth-runs-update-embed','index.rename-not-counted','index.edits-not-counted','index.delete-pending','index.concurrent-additions-retained','index.new-note-searchable','index.new-note-vector-searchable','index.pending-survives-reload','index.failure-pending-cooldown','index.manual-retry','index.disabled-retains-without-running'],notVerified:['offline rename without filesystem identity','Obsidian editor New note entry point'],pendingAtEnd:observed.pending.length,jobCommands:(await jobs()).map(r=>r.args[0]),buildHash:run.buildHash,version:run.version});
    await event(run,'automatic indexing proof passed',{pending:observed.pending.length});
  }catch(error){
    await save(path.join(run.evidence,'report.json'),{status:'failed',error:error.stack});
    await event(run,'index drive failed',error.stack);
    await snapshot(run,settings??cdp,'index-failure').catch(()=>{});
    throw error;
  }finally{settings?.close();cdp.close();}
}
