#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const source = '在投入大量资源之前，先做一个小规模、可撤回的实验，检验最关键的假设。\n这能让我及时改变决定。';
const fixtures = {
  'Source.md': source,
  '试错.md': '---\nowner: 不应出现在摘要中的元数据\nreview_status: 待整理\n---\n# 试错\n\n## 下周安排\n周末整理书架并归档旧文件。\n\n## 实验教训\n在投入大量资源前，先用小规模、可撤回的实验检验假设，可以降低错误决策的成本。\n',
  'README.md': '# README\n\n在投入大量资源之前，先做一个小规模、可撤回的实验，检验最关键的假设。这能让我及时改变决定。\n',
  '项目规划.md': '# 项目规划\n\n在投入大量资源之前，先做一个小规模、可撤回的实验，检验最关键的假设。这能让我及时改变决定。\n',
  '反例 #1.md': '# 反例\n\n过去的失败案例提醒我，不能只寻找支持自己观点的证据。应主动设计小实验，考虑什么结果会推翻当前假设。\n',
  '有限投入.md': '# 有限投入\n\n做决定时先限制投入，保留退出的选择。小规模试验有助于判断是否值得继续。\n',
  '可逆决策.md': '# 可逆决策\n\n可撤回的决定允许我们从反馈中学习，在验证假设后再投入资源。\n',
  '50% 预算.md': '# 一半预算\n\n先投入总预算的一半，也就是百分之五十，剩余资金保留到实验结束后再决定是否投入。\n',
  '园艺.md': '# 园艺\n\n阳台植物需要适量光照和浇水，夏天注意通风。\n',
};

export async function prepare(run) {
  assert(process.env.QMD_REMOTE_EMBED_URL, 'run-links requires an existing QMD_REMOTE_EMBED_URL; it will not download models');
  const resolved = spawnSync('which', [process.env.AHA_VERIFY_QMD_COMMAND || 'qmd'], { encoding: 'utf8' });
  assert.equal(resolved.status, 0, 'QMD CLI is required for the real recall proof');
  const executable = resolved.stdout.trim();
  for (const [name, text] of Object.entries(fixtures)) await writeFile(path.join(run.vault, name), text);
  const config = path.join(run.scratch, 'qmd-config');
  const cache = path.join(run.scratch, 'qmd-cache');
  await mkdir(config);
  const env = { ...process.env, QMD_CONFIG_DIR: config, XDG_CACHE_HOME: cache };
  for (const args of [['collection', 'add', run.vault, '--name', 'obsidian', '--index', 'obsidian'], ['embed', '--index', 'obsidian']]) {
    const result = spawnSync(executable, args, { env, encoding: 'utf8', timeout: 90000 });
    await writeFile(path.join(run.evidence, `qmd-${args[0]}.log`), (result.stdout || '') + (result.stderr || ''));
    assert.equal(result.status, 0, `Real QMD ${args[0]} failed; inspect the evidence log`);
  }
  const log = path.join(run.evidence, 'qmd-requests.jsonl');
  const output = path.join(run.evidence, 'qmd-last-result.json');
  run.qmdCommand = path.join(run.scratch, 'qmd-recorded.mjs');
  await writeFile(run.qmdCommand, `#!${process.execPath}
import {spawn} from 'node:child_process';
import {appendFileSync,writeFileSync} from 'node:fs';
const started = Date.now();
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, JSON.stringify({event:'start',at:started,args})+'\\n');
const child = spawn(${JSON.stringify(executable)},args,{stdio:['ignore','pipe','pipe'],env:process.env});
let stdout='';
child.stdout.on('data',data=>{stdout+=data;process.stdout.write(data)});
child.stderr.on('data',data=>process.stderr.write(data));
process.on('SIGTERM',()=>child.kill('SIGTERM'));
child.on('error',()=>process.exit(1));
child.on('close',(code,signal)=>{writeFileSync(${JSON.stringify(output)},stdout);appendFileSync(${JSON.stringify(log)},JSON.stringify({event:'end',at:Date.now(),code,signal,elapsedMs:Date.now()-started})+'\\n');process.exit(code??1)});
`);
  await chmod(run.qmdCommand, 0o755);
}

export async function drive(run, api) {
  const { connect, doctor, click, key, until, snapshot, event, json, save, dataPath } = api;
  const cdp = await connect(run);
  const popup = '.aha-quick-links';
  const row = '.aha-quick-link-option';
  const editorText = () => cdp.evaluate('app.workspace.activeEditor?.editor.getValue()');
  const closed = () => until(() => cdp.evaluate(`!document.querySelector(${JSON.stringify(popup)})`), 'quick-link popup closed');
  const trigger = async () => {
    await event(run, 'press configured hotkey', 'Mod+Shift+L');
    await key(cdp, 'L', 'KeyL', 12);
  };
  const selectAll = async () => {
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 4, commands: ['selectAll'] });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 4 });
  };
  const ready = async () => {
    await until(() => cdp.evaluate(`document.querySelectorAll(${JSON.stringify(row)}).length > 0`), 'real QMD candidates', 12000);
    const candidates = await cdp.evaluate(`[...document.querySelectorAll(${JSON.stringify(row)})].map(e=>({path:e.getAttribute('data-path'),text:e.textContent}))`);
    assert(candidates.length > 0 && candidates.length <= 4);
    assert.equal(new Set(candidates.map(c=>c.path)).size,candidates.length);
    assert(candidates.every(c=>c.path && c.path!=='Source.md'));
    assert(candidates.some(c=>c.path==='试错.md'));
    return candidates;
  };
  const replaceDocument = async text => {
    await click(cdp, '.workspace-leaf.mod-active .cm-content[contenteditable="true"]');
    await selectAll();
    await cdp.send('Input.insertText', { text });
    await until(async () => await editorText() === text, 'typed fixture content');
  };
  try {
    await doctor(run, cdp);
    await click(cdp, '.nav-file-title[data-path="Source.md"]');
    await click(cdp, '.workspace-leaf.mod-active .cm-content[contenteditable="true"]');
    await selectAll();
    assert.equal(await cdp.evaluate('app.workspace.activeEditor.editor.getSelection()'), source);
    const started = Date.now();
    await trigger();
    const candidates = await ready();
    const observedWaitUpperBoundMs = Date.now() - started;
    const geometry = await cdp.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(popup)}),r=e.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,viewportWidth:innerWidth,viewportHeight:innerHeight,hasBackdrop:!!document.querySelector('.modal-container')}})()`);
    assert(geometry.width <= 460 && geometry.height <= 400);
    assert(geometry.x >= 0 && geometry.y >= 0 && geometry.x+geometry.width <= geometry.viewportWidth+1 && geometry.y+geometry.height <= geometry.viewportHeight+1);
    assert.equal(geometry.hasBackdrop, false);
    await save(path.join(run.evidence, 'links-popup.json'), {candidates, geometry, observedWaitUpperBoundMs, timingScope:'One synthetic-index hotkey-to-visible-result observation, includes driver polling up to 200ms and recording proxy overhead; no production latency claim.'});
    await snapshot(run, cdp, 'links-candidates');
    const hoverText = async selector => {
      const point=await cdp.evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
      await cdp.send('Input.dispatchMouseEvent',{type:'mouseMoved',...point});
      await new Promise(resolve=>setTimeout(resolve,900));
      return cdp.evaluate("[...document.querySelectorAll('.tooltip')].map(e=>e.textContent)");
    };
    const rowHover=await hoverText(row);
    await snapshot(run,cdp,'links-row-hover');
    const closeHover=await hoverText('.aha-quick-links-close');
    await snapshot(run,cdp,'links-close-hover');
    const relevantExcerpt=await cdp.evaluate(`document.querySelector(${JSON.stringify(row+'[data-path="试错.md"] .aha-quick-link-excerpt')})?.textContent`);
    await save(path.join(run.evidence,'excerpt-and-hover.json'),{candidates,rowHover,closeHover,relevantExcerpt});
    assert(candidates.every(c=>!['README.md','项目规划.md'].includes(c.path)), 'README or planning note displayed');
    assert.equal(relevantExcerpt,'在投入大量资源前，先用小规模、可撤回的实验检验假设，可以降低错误决策的成本。','Excerpt must use query-relevant original prose');
    assert(![...rowHover,...closeHover].some(t=>/相关笔记|取消插入双链/.test(t)), 'Unwanted hover tooltip displayed');
    await cdp.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:20,y:20});
    await until(()=>cdp.evaluate(`document.querySelector('.workspace-leaf.mod-active .cm-announced[aria-live="polite"]')?.textContent.includes(${JSON.stringify(candidates[0].path.replace(/\.md$/,''))})`),'candidate announced through native editor live region');
    await key(cdp, ' ', 'Space');
    await key(cdp, 'ArrowDown', 'ArrowDown');
    await key(cdp, ' ', 'Space');
    const chosen = await cdp.evaluate(`[...document.querySelectorAll(${JSON.stringify(row+'[aria-selected="true"]')})].map(e=>e.getAttribute('data-path'))`);
    assert.equal(chosen.length, 2);
    const announcement=await cdp.evaluate(`document.querySelector('.workspace-leaf.mod-active .cm-announced[aria-live="polite"]')?.textContent`);
    assert(announcement?.includes(candidates[1].path.replace(/\.md$/,'')));
    await save(path.join(run.evidence,'links-accessibility.json'),{announcement,focus:await cdp.evaluate('document.activeElement?.className')});
    await event(run, 'choose two candidates', chosen);
    await key(cdp, 'Enter', 'Enter');
    await closed();
    const inserted = await editorText();
    assert(inserted.startsWith(source));
    assert.equal([...inserted.matchAll(/\[\[[^\]]+\]\]/g)].length,2);
    await until(async()=>await readFile(path.join(run.vault,'Source.md'),'utf8')===inserted,'inserted links saved');
    const resolved = await cdp.evaluate(`app.metadataCache.getFileCache(app.workspace.getActiveFile())?.links?.map(l=>({link:l.link,path:app.metadataCache.getFirstLinkpathDest(l.link,'Source.md')?.path}))`);
    await until(async()=>{
      const links=await cdp.evaluate(`app.metadataCache.getFileCache(app.workspace.getActiveFile())?.links?.map(l=>app.metadataCache.getFirstLinkpathDest(l.link,'Source.md')?.path)`);
      return links?.length===2 && chosen.every(p=>links.includes(p));
    },'inserted wiki links resolve to chosen notes');
    await snapshot(run, cdp, 'links-inserted');
    await key(cdp, 'z', 'KeyZ', 4);
    await until(async()=>await editorText()===source,'one undo restores original source');
    await trigger();
    await ready();
    await key(cdp, 'Escape', 'Escape');
    await closed();
    assert.equal(await editorText(),source);
    await replaceDocument(source+'\n\n');
    await trigger();
    await ready();
    await snapshot(run, cdp, 'links-previous-paragraph');
    await key(cdp, 'Enter', 'Enter');
    await closed();
    const single=await editorText();
    assert(single.startsWith(source+'\n\n'));
    assert.equal([...single.matchAll(/\[\[[^\]]+\]\]/g)].length,1);
    await key(cdp,'z','KeyZ',4);
    await until(async()=>await editorText()===source+'\n\n','single undo restores blank-line context');
    await trigger();
    await ready();
    await click(cdp, `${row}[data-path=${JSON.stringify(candidates[0].path)}]`);
    await snapshot(run,cdp,'links-mouse-selected');
    await key(cdp,'Escape','Escape');
    await closed();
    assert.equal(await editorText(),source+'\n\n');
    await trigger();
    await until(()=>cdp.evaluate(`!!document.querySelector(${JSON.stringify(popup)})`),'loading popup');
    await key(cdp,'Escape','Escape');
    await closed();
    await until(async()=>{
      const lines=(await readFile(path.join(run.evidence,'qmd-requests.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
      return lines.filter(l=>l.event==='start').length === lines.filter(l=>l.event==='end').length;
    },'cancelled QMD command exited');
    await new Promise(resolve=>setTimeout(resolve,400));
    assert.equal(await cdp.evaluate(`!!document.querySelector(${JSON.stringify(popup)})`),false);
    assert.equal(await editorText(),source+'\n\n');
    await trigger();
    await ready();
    await click(cdp, 'button[aria-label="取消插入双链"]');
    await closed();
    assert.equal(await editorText(),source+'\n\n');
    await trigger();
    await ready();
    await cdp.send('Input.insertText',{text:'临时输入'});
    await closed();
    assert.equal(await editorText(),source+'\n\n临时输入');
    await replaceDocument(source);
    await key(cdp,'ArrowLeft','ArrowLeft');
    const caret=await cdp.evaluate('app.workspace.activeEditor.editor.posToOffset(app.workspace.activeEditor.editor.getCursor())');
    await trigger();
    await ready();
    await key(cdp,'Enter','Enter');
    await closed();
    const mid=await editorText();
    assert(mid.startsWith(source.slice(0,caret)));
    assert(mid.endsWith(source.slice(caret)));
    assert.equal([...mid.matchAll(/\[\[[^\]]+\]\]/g)].length,1);
    await key(cdp,'z','KeyZ',4);
    await until(async()=>await editorText()===source,'mid-paragraph insertion undoes');
    await trigger();
    await ready();
    await click(cdp,'.nav-file-title[data-path="园艺.md"]');
    await closed();
    await until(()=>cdp.evaluate('app.workspace.getActiveFile()?.path === "园艺.md"'),'different note active');
    assert.equal(await readFile(path.join(run.vault,'Source.md'),'utf8'),source);
    await click(cdp,'.nav-file-title[data-path="Source.md"]');
    await until(()=>cdp.evaluate('app.workspace.activeEditor?.file?.path === "Source.md" && app.workspace.activeEditor.editor.getValue() === '+JSON.stringify(source)), 'source editor reopened');
    await cdp.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    const specialQuery='过去的失败案例提醒我，要主动寻找能够推翻假设的反例证据。';
    await replaceDocument(specialQuery);
    await trigger();
    await until(()=>cdp.evaluate(`!!document.querySelector(${JSON.stringify(row+'[data-path="反例 #1.md"]')})`),'special filename returned by real QMD');
    await click(cdp,row+'[data-path="反例 #1.md"]');
    await key(cdp,'Enter','Enter');
    await closed();
    const specialText=await editorText();
    await until(async()=>{
      const links=await cdp.evaluate(`app.metadataCache.getFileCache(app.workspace.getActiveFile())?.links?.map(l=>app.metadataCache.getFirstLinkpathDest(l.link,'Source.md')?.path)`);
      return links?.length===1 && links[0]==='反例 #1.md';
    },'encoded wiki target resolves to actual filename');
    await snapshot(run,cdp,'links-special-filename');
    assert(specialText.startsWith(specialQuery));
    const percentQuery='先投入百分之五十的预算，剩余资金等实验结果出来再决定。';
    await replaceDocument(percentQuery);
    await trigger();
    await until(()=>cdp.evaluate(`!!document.querySelector(${JSON.stringify(row+'[data-path="50% 预算.md"]')})`),'percent filename recalled');
    await click(cdp,row+'[data-path="50% 预算.md"]');
    await key(cdp,'Enter','Enter');
    await closed();
    await until(async()=>{
      const links=await cdp.evaluate(`app.metadataCache.getFileCache(app.workspace.getActiveFile())?.links?.map(l=>app.metadataCache.getFirstLinkpathDest(l.link,'Source.md')?.path)`);
      return links?.length===1 && links[0]==='50% 预算.md';
    },'literal percent wiki target resolves');
    await snapshot(run,cdp,'links-percent-filename');
    await replaceDocument('');
    const requestsBeforeEmpty=await readFile(path.join(run.evidence,'qmd-requests.jsonl'),'utf8');
    await trigger();
    await until(()=>cdp.evaluate(`document.querySelector('.aha-quick-links-message')?.textContent.includes('先写一段话')`),'empty input guidance');
    await snapshot(run,cdp,'links-empty');
    assert.equal(await readFile(path.join(run.evidence,'qmd-requests.jsonl'),'utf8'),requestsBeforeEmpty);
    await key(cdp,'Escape','Escape');
    await closed();
    await replaceDocument(source);
    await api.command(cdp,'Insert related links');
    await ready();
    await click(cdp,'button[aria-label="取消插入双链"]');
    await closed();
    await chmod(run.qmdCommand,0o600);
    await trigger();
    await until(()=>cdp.evaluate(`document.querySelector('.aha-quick-links-message')?.textContent.includes('QMD 暂时不可用')`),'unavailable QMD guidance');
    await snapshot(run,cdp,'links-unavailable');
    await key(cdp,'Escape','Escape');
    await closed();
    assert.equal(await editorText(),source);
    await chmod(run.qmdCommand,0o755);
    await replaceDocument(source+'\n\n');
    await until(async()=>await readFile(path.join(run.vault,'Source.md'),'utf8')===source+'\n\n','final source saved');
    for(const [name,text] of Object.entries(fixtures)) if(name!=='Source.md')assert.equal(await readFile(path.join(run.vault,name),'utf8'),text);
    assert.deepEqual((await json(dataPath(run))).sessionStore.records,{});
    const requests=(await readFile(path.join(run.evidence,'qmd-requests.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
    const starts=requests.filter(r=>r.event==='start');
    assert(starts.length>=4);
    for(const request of starts){
      assert(request.args.includes('--no-rerank'));
      assert(request.args.includes('query'));
      assert(request.args.some(a=>a==='vec: '+source.replace(/\s+/g,' ').trim() || a==='vec: '+specialQuery || a==='vec: '+percentQuery));
      assert(!request.args.includes('--version'));
    }
    await save(path.join(run.evidence,'report.json'),{status:'passed',fixture:'Real QMD CLI, isolated index, existing embedding service, synthetic notes',verified:['quick-links.selected-text','quick-links.configured-hotkey','quick-links.real-semantic-query','quick-links.max-four','quick-links.keyboard-multiselect','quick-links.preserved-text-and-insertion','quick-links.native-wiki-resolution','quick-links.single-undo','quick-links.escape','quick-links.previous-paragraph','quick-links.enter-highlight','quick-links.mouse-toggle','quick-links.cancel-in-flight','quick-links.no-session-store-write','quick-links.close-button','quick-links.cancel-on-typing','quick-links.current-paragraph','quick-links.insert-at-caret','quick-links.cancel-on-file-switch','quick-links.special-filename','quick-links.percent-filename','quick-links.empty-no-request','quick-links.command-palette','quick-links.unavailable','quick-links.native-announcements'],notVerified:['production-vault relevance','popout window','main-vault latency'],chosen,resolved,observedWaitUpperBoundMs,buildHash:run.buildHash});
    await snapshot(run,cdp,'links-final');
  } catch(error){
    await event(run,'quick-links drive failed',error.stack);
    await save(path.join(run.evidence,'report.json'),{status:'failed',error:error.stack});
    await snapshot(run,cdp,'links-failure').catch(()=>{});
    throw error;
  } finally{cdp.close();}
}
