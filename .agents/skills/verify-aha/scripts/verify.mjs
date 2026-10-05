#!/usr/bin/env node
import assert from 'node:assert/strict';
import { hostState, assertHostUnchanged } from './host-state.mjs';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile, appendFile, copyFile, readdir, rm, realpath, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const pluginId = 'aha-memory-surface-dev';
const binary = '/Applications/Obsidian.app/Contents/MacOS/Obsidian';
const source = '# Verification source\n\nA reversible trial can test an assumption before a larger commitment.\n\n[[Counterexample]]\n';
const notes = {
  'Source.md': source,
  'Counterexample.md': '# Counterexample\n\nAn earlier trial failed and changed the decision.\n',
  'Backlink.md': '# Backlink\n\n[[Source]] reminded me to check the earlier evidence.\n',
};
const thought = 'AHA verification thought: check the earlier counterexample before committing.';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const json = async file => JSON.parse(await readFile(file, 'utf8'));
const save = (file, value) => writeFile(file, JSON.stringify(value, null, 2) + '\n');
const hash = async file => createHash('sha256').update(await readFile(file)).digest('hex');
const dataPath = run => path.join(run.vault, '.obsidian/plugins', pluginId, 'data.json');
const event = (run, action, observed) => appendFile(path.join(run.evidence, 'actions.jsonl'), JSON.stringify({ at: new Date().toISOString(), action, observed }) + '\n');
const persist = run => save(path.join(run.evidence, 'run.json'), run);

async function until(check, label, timeout = 20000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try { const result = await check(); if (result) return result; } catch (error) { last = error; }
    await sleep(200);
  }
  throw new Error(`Timed out: ${label}${last ? ` (${last.message})` : ''}`);
}

class Cdp {
  constructor(socket, run) {
    this.socket = socket;
    this.run = run;
    this.sequence = 0;
    this.pending = new Map();
    socket.addEventListener('message', ({ data }) => {
      const message = JSON.parse(data);
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
      else pending.resolve(message.result);
    });
    socket.addEventListener('close', () => {
      for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('CDP connection closed')); }
      this.pending.clear();
    });
  }
  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 15000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression) {
    const value = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (value.exceptionDetails) throw new Error(value.exceptionDetails.exception?.description || value.exceptionDetails.text);
    return value.result.value;
  }
  close() { this.socket.close(); }
}

async function connect(run, kind = 'main') {
  const port = Number((await readFile(path.join(run.profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]);
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(3000) })).json();
  const target = targets.find(item => item.type === 'page' && (kind === 'settings' ? /设置|Settings/.test(item.title) && item.url === 'about:blank' : item.url === 'app://obsidian.md/index.html'));
  assert(target, 'The owned profile must contain the Obsidian main renderer');
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.close(); reject(new Error('CDP connection timeout')); }, 5000);
    socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
    socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('CDP connection failed')); }, { once: true });
  });
  const cdp = new Cdp(socket, run);
  cdp.targetId = target.id;
  return cdp;
}

async function click(cdp, selector, text) {
  let previous;
  const point = await until(async () => {
    const measured = await cdp.evaluate(`(() => {
    const elements = [...document.querySelectorAll(${JSON.stringify(selector)})].filter(e => e.checkVisibility() && e.getBoundingClientRect().width && e.getBoundingClientRect().height ${text === undefined ? '' : `&& e.textContent.trim() === ${JSON.stringify(text)}`});
    if (elements.length !== 1) return null;
    const element = elements[0]; if (element.disabled) return null;
    let r = element.getBoundingClientRect();
    if (r.top < 0 || r.bottom > innerHeight) { element.scrollIntoView({block:'nearest'}); r = element.getBoundingClientRect(); }
    return {x:r.x+r.width/2, y:r.y+r.height/2};
  })()`);
    const stable = measured && previous && measured.x === previous.x && measured.y === previous.y;
    previous = measured;
    return stable ? measured : null;
  }, `one stable enabled visible ${selector} ${text ?? ''}`);
  await event(cdp.run, 'click', { selector, text });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
}

async function key(cdp, key, code, modifiers = 0) {
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, modifiers });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, modifiers });
}

async function closeSettings(main, settings) {
  await settings.send('Page.bringToFront');
  await click(settings, '.setting-search-container input');
  try { await key(settings, 'Escape', 'Escape'); }
  catch (error) { if (error.message !== 'CDP connection closed') throw error; }
  finally { settings.close(); }
  await main.send('Page.bringToFront');
  await click(main, '.nav-file-title[data-path="Source.md"]');
  await until(() => main.evaluate('activeWindow === window'), 'main shortcut scope restored');
}

async function fill(cdp, selector, value) {
  await click(cdp, selector);
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 4, commands: ['selectAll'] });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 4 });
  await cdp.send('Input.insertText', { text: value });
  assert.equal(await cdp.evaluate(`document.querySelector(${JSON.stringify(selector)}).value`), value, 'Input must contain exactly the requested text');
  await event(cdp.run, 'type', { selector, value });
}

async function command(cdp, name) {
  await key(cdp, 'p', 'KeyP', 4);
  await fill(cdp, '.prompt-input', `Aha (Dev): ${name}`);
  await until(() => cdp.evaluate(`document.querySelectorAll('.suggestion-item').length === 1 && document.querySelector('.suggestion-item').textContent.includes(${JSON.stringify(name)})`), `unique command ${name}`);
  await click(cdp, '.suggestion-item');
}

function processIdentity(pid) {
  const result = spawnSync('ps', ['-p', String(pid), '-o', 'lstart=,command='], { encoding: 'utf8' });
  if (result.status !== 0 || !result.stdout.trim()) return null;
  return result.stdout.trim();
}

async function owned(run) {
  assert.equal(await readFile(path.join(run.scratch, 'owner'), 'utf8'), run.id, 'Scratch owner mismatch');
  assert.equal(await realpath(run.scratch), run.scratch, 'Scratch path must not be a symlink');
  assert.equal(path.dirname(run.scratch), await realpath(tmpdir()));
  assert(path.basename(run.scratch).startsWith('aha-verify-'));
  assert.equal(path.dirname(run.vault), run.scratch);
  assert.equal(path.dirname(run.profile), run.scratch);
  assert(!path.relative(run.scratch, run.evidence).split(path.sep).every(part => part !== '..'), 'Evidence must survive scratch cleanup');
  const identity = run.pid ? processIdentity(run.pid) : null;
  if (identity) assert.equal(identity, run.processIdentity, 'PID identity mismatch; refusing to drive or signal it');
  return identity;
}

async function doctor(run, cdp) {
  assert(await owned(run), 'Owned process is not running');
  assert.equal(await hash(path.join(run.vault, '.obsidian/plugins', pluginId, 'main.js')), run.buildHash, 'Installed build changed');
  assert.equal(await hash(run.bundleSource ?? path.join(repo, 'obsidian-plugin/main.js')), run.buildHash, 'Checkout build changed; start a fresh run');
  const observed = await cdp.evaluate(`({vault:app.vault.adapter.basePath, home:require('os').homedir(), version:app.plugins.plugins[${JSON.stringify(pluginId)}]?.manifest.version, plugins:Object.keys(app.plugins.plugins), commands:Object.keys(app.commands.commands).filter(id=>id.startsWith(${JSON.stringify(pluginId + ':')})), qmdCommand:app.plugins.plugins[${JSON.stringify(pluginId)}]?.settings.qmdCommand})`);
  assert.equal(await realpath(observed.vault), await realpath(run.vault));
  assert.equal(await realpath(observed.home), await realpath(run.home));
  observed.mockKeychain = processIdentity(run.pid)?.includes(' --use-mock-keychain') === true;
  assert.equal(observed.mockKeychain, true, 'Synthetic test instances must not access the macOS keychain');
  assert.deepEqual(observed.plugins, [pluginId]);
  assert.equal(observed.version, run.version);
  for (const id of ['aha-readiness-check', 'aha-run', 'aha-open-panel', 'aha-open-candidate-under-cursor', 'aha-insert-related-links']) assert(observed.commands.includes(`${pluginId}:${id}`), `Missing command ${id}`);
  assert(observed.commands.includes(`${pluginId}:aha-run`));
  assert.equal(observed.qmdCommand, run.qmdCommand);
  await save(path.join(run.evidence, 'doctor.json'), observed);
  return observed;
}

async function snapshot(run, cdp, label) {
  const png = await cdp.send('Page.captureScreenshot', { format: 'png' });
  await writeFile(path.join(run.evidence, `${label}.png`), Buffer.from(png.data, 'base64'));
  await writeFile(path.join(run.evidence, `${label}.txt`), await cdp.evaluate('document.body.innerText'));
  await save(path.join(run.evidence, `${label}.controls.json`), await cdp.evaluate(`[...document.querySelectorAll('button,input,textarea,a')].filter(e=>e.checkVisibility() && e.getBoundingClientRect().width).map(e=>({tag:e.tagName,text:e.textContent,label:e.getAttribute('aria-label'),value:e.value,checked:e.checked,pressed:e.getAttribute('aria-pressed')}))`));
  await copyFile(dataPath(run), path.join(run.evidence, `${label}.data.json`));
  await copyFile(path.join(run.vault, 'Source.md'), path.join(run.evidence, `${label}.Source.md`));
  await event(run, 'snapshot', { label });
}

async function launch(evidence, scenario = 'neighborhood') {
  const hostBefore = await hostState();
  await mkdir(evidence, { recursive: false });
  const scratch = await realpath(await mkdtemp(path.join(tmpdir(), 'aha-verify-')));
  const run = { schemaVersion: 1, hostBefore, id: randomUUID(), evidence, scratch, vault: path.join(scratch, 'vault'), profile: path.join(scratch, 'profile'), home: path.join(scratch, 'home'), state: 'prepared', pid: null, scenario, qmdCommand: path.join(scratch, 'unavailable-qmd') };
  await writeFile(path.join(scratch, 'owner'), run.id);
  await persist(run);
  await save(path.join(evidence, 'host-before.json'), hostBefore);
  await event(run, 'prepared isolated instance', { scenario });
  try {
    await mkdir(path.join(run.vault, '.obsidian'), { recursive: true });
    await mkdir(run.profile);
    await mkdir(run.home);
    for (const [name, content] of Object.entries(notes)) await writeFile(path.join(run.vault, name), content);
    if (scenario === 'production-links') await (await import('./production-links-fixture.mjs')).prepare(run);
    if (scenario === 'quick-links' || scenario === 'auto-index') await (await import('./quick-links-proof.mjs')).prepare(run);
    await save(path.join(run.profile, 'obsidian.json'), { vaults: { a1a1a1a1a1a1a1a1: { path: run.vault, ts: Date.now(), open: true } } });
    await save(path.join(run.vault, '.obsidian/community-plugins.json'), [pluginId]);
    await save(path.join(run.vault, '.obsidian/core-plugins.json'), ['file-explorer', 'switcher', 'command-palette']);
    await save(path.join(run.vault, '.obsidian/app.json'), { defaultViewMode: 'source' });
    if (scenario === 'quick-links' || scenario === 'production-links') await save(path.join(run.vault, '.obsidian/hotkeys.json'), { [`${pluginId}:aha-insert-related-links`]: [{ modifiers: ['Mod', 'Shift'], key: 'L' }] });
    const build = spawnSync('npm', ['run', 'dev:install'], { cwd: repo, env: { ...process.env, AHA_DEV_VAULT_ROOT: run.vault }, encoding: 'utf8', timeout: 120000 });
    await writeFile(path.join(evidence, 'build.log'), (build.stdout ?? '') + (build.stderr ?? ''));
    assert.equal(build.status, 0, 'Build/install failed; inspect build.log');
    if (process.env.AHA_VERIFY_BUNDLE_DIR) {
      run.bundleSource = path.resolve(process.env.AHA_VERIFY_BUNDLE_DIR, 'main.js');
      for (const name of ['main.js', 'styles.css']) await copyFile(path.resolve(process.env.AHA_VERIFY_BUNDLE_DIR, name), path.join(run.vault, '.obsidian/plugins', pluginId, name));
    }
    run.buildHash = await hash(path.join(run.vault, '.obsidian/plugins', pluginId, 'main.js'));
    run.version = (await json(path.join(repo, 'obsidian-plugin/manifest.json'))).version;
    run.commit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).stdout.trim();
    await save(dataPath(run), { schemaVersion: 4, settings: { qmdCommand: run.qmdCommand, qmdIndex: 'obsidian', qmdEnvironment: ['quick-links', 'auto-index'].includes(scenario) ? `QMD_CONFIG_DIR=${path.join(scratch, 'qmd-config')}\nXDG_CACHE_HOME=${path.join(scratch, 'qmd-cache')}` : '', deepseekApiKey: '', deepseekApiKeyEnv: 'AHA_VERIFY_NO_KEY', traceDirectory: path.join(evidence, 'pipeline') }, sessionStore: { schemaVersion: 1, records: {} } });
    const log = await open(path.join(evidence, 'obsidian.log'), 'a');
    const env = { ...process.env, HOME: run.home }; delete env.INDEX_PATH; delete env.DEEPSEEK_API_KEY; delete env.AHA_VERIFY_NO_KEY;
    const child = spawn(binary, [`--user-data-dir=${run.profile}`, '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1', '--use-mock-keychain'], { detached: true, stdio: ['ignore', log.fd, log.fd], env });
    try {
      await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
      run.pid = child.pid;
      run.processIdentity = processIdentity(run.pid);
      assert(run.processIdentity?.includes(`--user-data-dir=${run.profile}`));
      child.unref();
      run.state = 'running';
      await persist(run);
    } finally { await log.close(); }
    const cdp = await until(() => connect(run), 'owned Obsidian CDP', 30000);
    try {
      await cdp.send('Page.bringToFront');
      await until(() => cdp.evaluate('typeof app !== "undefined" && !!app.vault'), 'vault ready');
      await until(() => cdp.evaluate(`!!app.plugins?.plugins?.[${JSON.stringify(pluginId)}] || [...document.querySelectorAll('.modal button')].some(e=> /信任仓库作者并启用插件|Trust author and enable plugins/.test(e.textContent))`), 'trust dialog or loaded plugin');
      const trust = await cdp.evaluate('[...document.querySelectorAll(".modal button")].map(e=>e.textContent.trim())');
      const label = trust.find(value => value === '信任仓库作者并启用插件' || value === 'Trust author and enable plugins');
      if (label) await click(cdp, '.modal button', label);
      await until(() => cdp.evaluate(`!!app.plugins?.plugins?.[${JSON.stringify(pluginId)}] && app.workspace.layoutReady`), 'Aha plugin and workspace layout ready');
      if (label) {
        const settings = await until(() => connect(run, 'settings'), 'post-trust settings window', 3000).catch(() => null);
        if (settings) {
          await closeSettings(cdp, settings);
        }
      }
      await until(() => cdp.evaluate('activeWindow === window'), 'owned main window accepts shortcuts');
      await cdp.send('Page.bringToFront');
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
      await doctor(run, cdp);
      await snapshot(run, cdp, '00-launched');
    } catch (error) {
      await snapshot(run, cdp, 'launch-failure').catch(() => {});
      throw error;
    } finally { cdp.close(); }
    return run;
  } catch (error) {
    await event(run, 'launch failed', error.message);
    await cleanup(run);
    throw error;
  }
}

async function storedRound(run) {
  const data = await json(dataPath(run));
  const record = Object.values(data.sessionStore.records).find(item => item.source.path === 'Source.md');
  return { data, record, round: record?.rounds.find(item => item.id === record.latestSuccessfulRoundId) };
}

async function drive(run) {
  if (run.scenario === 'auto-index') return (await import('./index-proof.mjs')).drive(run, { closeSettings, connect, doctor, click, fill, key, until, snapshot, event, command, json, save, dataPath });
  if (run.scenario === 'quick-links') {
    return (await import('./quick-links-proof.mjs')).drive(run, { closeSettings, connect, doctor, click, fill, key, until, snapshot, event, command, json, save, dataPath });
  }
  const cdp = await connect(run);
  try {
    await doctor(run, cdp);
    assert.equal(Object.keys((await json(dataPath(run))).sessionStore.records).length, 0, 'Drive requires a fresh launch; start another run to repeat');
    await click(cdp, '.nav-file-title[data-path="Source.md"]');
    await until(() => cdp.evaluate('app.workspace.getActiveFile()?.path === "Source.md"'), 'source opened');
    await command(cdp, 'Run');
    await until(async () => (await storedRound(run)).round?.status === 'success', 'Neighborhood round persisted');
    await until(() => cdp.evaluate('document.querySelectorAll(".aha-review-panel-note-link").length === 2'), 'two rendered candidates');
    const { round } = await storedRound(run);
    assert.deepEqual(round.candidates.map(item => item.notePath).sort(), ['Backlink.md', 'Counterexample.md']);
    assert(round.candidates.every(item => item.relation === 'weak'));
    assert.equal(await readFile(path.join(run.vault, 'Source.md'), 'utf8'), source);
    await snapshot(run, cdp, '01-neighborhood');
    const checkbox = '.aha-review-panel-row:has(a[title="Counterexample.md"]) input[type="checkbox"]';
    const selectedBefore = await cdp.evaluate(`document.querySelector(${JSON.stringify(checkbox)}).checked`);
    await click(cdp, checkbox);
    await until(async () => (await storedRound(run)).round.candidates.find(item => item.notePath === 'Counterexample.md').selected === !selectedBefore, 'selection persisted');
    assert((await cdp.evaluate("document.querySelector('.aha-review-panel-count').textContent")).includes('1 / 2 纳入'));
    await snapshot(run, cdp, '02-selection');
    const row = '.aha-review-panel-row:has(a[title="Backlink.md"])';
    await click(cdp, `${row} button[data-action="surprise"]`);
    await until(async () => (await storedRound(run)).record.feedback.some(item => item.action === 'surprise'), 'Surprise persisted');
    await fill(cdp, `${row} textarea[aria-label="我的想法"]`, thought);
    await click(cdp, `${row} button`, '保存');
    await until(async () => (await readFile(path.join(run.vault, 'Source.md'), 'utf8')).includes(thought), 'thought written to source');
    await until(async () => (await storedRound(run)).record.feedback.some(item => item.note === thought && item.noteWrite?.status === 'saved'), 'thought write journal saved');
    const after = await readFile(path.join(run.vault, 'Source.md'), 'utf8');
    assert(after.startsWith(source));
    assert.equal(after.split(thought).length - 1, 1);
    assert(after.includes('[[Backlink]]'));
    assert.equal(await readFile(path.join(run.vault, 'Backlink.md'), 'utf8'), notes['Backlink.md']);
    assert.equal(await readFile(path.join(run.vault, 'Counterexample.md'), 'utf8'), notes['Counterexample.md']);
    await snapshot(run, cdp, '03-thought-saved');
    await click(cdp, 'button[aria-label="查看已保存的 Surprise"]');
    await until(() => cdp.evaluate(`document.querySelector('.aha-saved-thought')?.textContent === ${JSON.stringify(thought)}`), 'saved thought visible');
    await fill(cdp, 'input[aria-label="查找已保存的想法"]', 'no-such-thought');
    await until(() => cdp.evaluate('document.querySelector(".aha-saved-list")?.textContent.includes("没有匹配的记录")'), 'empty saved search');
    await fill(cdp, 'input[aria-label="查找已保存的想法"]', 'counterexample');
    await until(() => cdp.evaluate('document.querySelectorAll(".aha-saved-entry").length === 1'), 'saved search match');
    await snapshot(run, cdp, '04-saved-search');
    const previousDocument = await cdp.evaluate('performance.timeOrigin');
    await event(run, 'reload app', { previousDocument });
    await cdp.send('Page.reload', { ignoreCache: true });
    await until(() => cdp.evaluate(`performance.timeOrigin !== ${previousDocument} && typeof app !== 'undefined' && !!app.plugins?.plugins?.[${JSON.stringify(pluginId)}]`), 'plugin reloaded');
    await doctor(run, cdp);
    await click(cdp, '.nav-file-title[data-path="Source.md"]');
    await command(cdp, 'Open Panel');
    await until(() => cdp.evaluate(`document.querySelector(${JSON.stringify(row + ' button[data-action="surprise"]')})?.getAttribute('aria-pressed') === 'true'`), 'Surprise restored after reload');
    assert.equal(await cdp.evaluate(`document.querySelector(${JSON.stringify(checkbox)}).checked`), !selectedBefore);
    await click(cdp, 'button[aria-label="查看已保存的 Surprise"]');
    await until(() => cdp.evaluate(`document.querySelector('.aha-saved-thought')?.textContent === ${JSON.stringify(thought)}`), 'saved thought restored after reload');
    await snapshot(run, cdp, '05-reloaded');
    let editedThought = 'AHA edited thought: seek disconfirming evidence before the next trial.';
    const beforeEdit = await readFile(path.join(run.vault, 'Source.md'), 'utf8');
    await click(cdp, '.aha-saved-entry button', '编辑想法');
    await fill(cdp, '.aha-saved-entry textarea[aria-label="我的想法"]', editedThought);
    await save(path.join(run.evidence, 'thought-focus.json'), await cdp.evaluate("({tag:document.activeElement?.tagName, value:document.activeElement?.value, class:document.activeElement?.className})"));
    await key(cdp, 'Enter', 'Enter', 4);
    await until(async () => (await storedRound(run)).record.feedback.some(item => item.note === editedThought && item.noteWrite?.status === 'saved'), 'edited thought journal saved');
    assert.equal(await readFile(path.join(run.vault, 'Source.md'), 'utf8'), beforeEdit.replace(thought, editedThought));
    await snapshot(run, cdp, '06-thought-edited');
    editedThought += ' Ctrl+Enter also saves.';
    await fill(cdp, '.aha-saved-entry textarea[aria-label="我的想法"]', editedThought);
    await key(cdp, 'Enter', 'Enter', 2);
    await until(async () => (await storedRound(run)).record.feedback.some(item => item.note === editedThought && item.noteWrite?.status === 'saved'), 'Ctrl+Enter edit journal saved');
    assert.equal(await readFile(path.join(run.vault, 'Source.md'), 'utf8'), beforeEdit.replace(thought, editedThought));
    await key(cdp, 'p', 'KeyP', 4);
    await until(() => cdp.evaluate("!!document.querySelector('.prompt-input')"), 'unrelated Cmd+P still opens palette from thought editor');
    await key(cdp, 'Escape', 'Escape');
    await snapshot(run, cdp, '06b-keyboard-scope');

    await click(cdp, '.aha-review-panel-seed-button', '返回结果');
    await click(cdp, 'button[aria-label="固定当前笔记"]');
    await until(() => cdp.evaluate(`!!document.querySelector('button[aria-label="跟随当前笔记"]')`), 'panel pinned');
    await click(cdp, '.aha-review-panel-note-link[title="Counterexample.md"]');
    await until(() => cdp.evaluate('app.workspace.getActiveFile()?.path === "Counterexample.md"'), 'candidate opened');
    assert.equal(await cdp.evaluate("document.querySelector('.aha-review-panel-source-link')?.title"), 'Source.md');
    await snapshot(run, cdp, '07-pinned-candidate');
    await click(cdp, '.aha-review-panel-source-link');
    await until(() => cdp.evaluate('app.workspace.getActiveFile()?.path === "Source.md"'), 'source link returned');
    await click(cdp, 'button[aria-label="跟随当前笔记"]');
    await until(() => cdp.evaluate(`!!document.querySelector('button[aria-label="固定当前笔记"]')`), 'panel follows notes');
    await click(cdp, '.aha-review-panel-note-link[title="Counterexample.md"]');
    await until(() => cdp.evaluate("document.querySelector('.aha-review-panel-source-link')?.title === 'Counterexample.md'"), 'panel followed candidate');
    await snapshot(run, cdp, '08-followed-candidate');
    await click(cdp, '.nav-file-title[data-path="Source.md"]');
    await until(() => cdp.evaluate("document.querySelector('.aha-review-panel-source-link')?.title === 'Source.md'"), 'panel returned to source');
    const previousRoundId = (await storedRound(run)).round.id;
    await click(cdp, '.aha-review-panel-run');
    await until(async () => { const latest = (await storedRound(run)).round; return latest?.id !== previousRoundId && latest?.status === 'success'; }, 'panel rerun persisted a new successful round');
    assert.equal(await readFile(path.join(run.vault, 'Source.md'), 'utf8'), beforeEdit.replace(thought, editedThought));
    for (const name of ['Backlink.md', 'Counterexample.md']) assert.equal(await readFile(path.join(run.vault, name), 'utf8'), notes[name]);
    await snapshot(run, cdp, '09-panel-rerun');
    const report = { status: 'passed', fixture: 'synthetic Markdown; no seeded search results', verified: ['search.command-run.neighborhood', 'selection.checkbox.persistence', 'feedback.surprise', 'thoughts.save.source-and-store', 'thoughts.saved-search', 'panel.command-open.restore-after-reload', 'thoughts.edit.cmd-enter-save', 'thoughts.edit.ctrl-enter-save', 'thoughts.unrelated-shortcut', 'reading.candidate-source-pin-follow', 'search.panel-rerun'], notVerified: ['QMD recall', 'DeepSeek Full tier', 'clipboard handoff', 'editor Open Candidate command', 'accept/noise/must feedback'], buildHash: run.buildHash, version: run.version };
    await save(path.join(run.evidence, 'report.json'), report);
    await event(run, 'proof passed', report.verified);
  } catch (error) {
    await event(run, 'drive failed', error.stack);
    await save(path.join(run.evidence, 'report.json'), { status: 'failed', error: error.stack });
    await snapshot(run, cdp, 'failure').catch(() => {});
    throw error;
  } finally { cdp.close(); }
}

async function cleanup(run) {
  if (run.state === 'cleaned') { assertHostUnchanged(run.hostBefore, await hostState()); assert(await readFile(path.join(run.evidence, 'cleanup.json'))); return; }
  const identity = await owned(run);
  if (identity) {
    process.kill(run.pid, 'SIGTERM');
    try { await until(() => !processIdentity(run.pid), 'owned Obsidian process stopped', 15000); }
    catch (error) {
      await event(run, 'owned process did not exit after SIGTERM', error.message);
      if (await owned(run)) process.kill(run.pid, 'SIGKILL');
      await until(() => !processIdentity(run.pid), 'owned process stopped after SIGKILL', 5000);
    }
  }
  await rm(run.scratch, { recursive: true });
  run.state = 'cleaned';
  await persist(run);
  const retained = await readdir(run.evidence);
  assert(retained.includes('run.json') && retained.includes('actions.jsonl'));
  const hostAfter = await hostState();
  await save(path.join(run.evidence, 'host-after.json'), hostAfter);
  await save(path.join(run.evidence, 'cleanup.json'), { ownedProcessStopped: true, scratchRemoved: true, evidenceRetained: retained, hostUnchanged: JSON.stringify(hostAfter) === JSON.stringify(run.hostBefore) });
  assertHostUnchanged(run.hostBefore, hostAfter);
}

async function main() {
const [action = 'run', argument] = process.argv.slice(2);
assert(['run', 'launch', 'run-links', 'launch-links', 'run-index', 'launch-index', 'launch-production-links', 'doctor', 'drive', 'cleanup'].includes(action), 'Usage: verify.mjs run|launch|run-links|launch-links|run-index|launch-index [evidence-directory] OR doctor|drive|cleanup <evidence-directory>');
const evidence = path.resolve(argument || path.join(repo, 'traces/verification', `${new Date().toISOString().replaceAll(':', '-')}-${randomUUID().slice(0, 8)}`));
if (['run', 'launch', 'run-links', 'launch-links', 'run-index', 'launch-index', 'launch-production-links'].includes(action)) {
  await mkdir(path.dirname(evidence), { recursive: true });
  console.log(evidence);
  const run = await launch(evidence, action === 'launch-production-links' ? 'production-links' : action.endsWith('-links') ? 'quick-links' : action.endsWith('-index') ? 'auto-index' : 'neighborhood');
  if (action.startsWith('run')) {
    try {
      if (process.env.AHA_VERIFY_FAIL_AFTER_LAUNCH === '1') throw new Error('Intentional isolation cleanup probe');
      await drive(run);
    } catch (error) {
      const diagnostic = await connect(run).catch(() => null);
      if (diagnostic) {
        try { await doctor(run, diagnostic); } finally { diagnostic.close(); }
      }
      await event(run, 'run failed before cleanup', error.message);
      throw error;
    } finally { await cleanup(run); }
    for (const name of ['report.json', 'actions.jsonl', 'doctor.json', run.scenario === 'quick-links' ? 'links-final.png' : run.scenario === 'auto-index' ? 'index-final.png' : '09-panel-rerun.png', 'cleanup.json']) await readFile(path.join(evidence, name));
    console.log('PASS: proof retained after cleanup');
  }
} else {
  assert(argument, 'An evidence directory from this helper is required');
  const run = await json(path.join(evidence, 'run.json'));
  assert.equal(run.evidence, evidence);
  if (action === 'cleanup') await cleanup(run);
  else if (action === 'drive') await drive(run);
  else {
    const cdp = await connect(run);
    try { console.log(JSON.stringify(await doctor(run, cdp), null, 2)); } finally { cdp.close(); }
  }
}

}

export const driver = { closeSettings, connect, doctor, click, fill, key, until, snapshot, event, command, json, save, dataPath };
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
