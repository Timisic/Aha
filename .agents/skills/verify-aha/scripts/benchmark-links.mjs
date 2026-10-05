#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { driver } from './verify.mjs';

const [directory, label = 'baseline', sampleArgument = '10', referenceFile] = process.argv.slice(2);
assert(directory, 'Usage: benchmark-links.mjs <owned evidence directory> <label> [samples]');
assert(/^[a-zA-Z0-9-]+$/.test(label), 'Use a filename-safe measurement label');
const count = Number(sampleArgument);
assert(Number.isInteger(count) && count >= 2 && count <= 100);
const run = await driver.json(path.join(directory, 'run.json'));
const cdp = await driver.connect(run);
const cases = [
  { query: '怎样尽量少付代价判断一件事值不值得继续做？\n我希望保留随时改变决定的余地。', expected: '在投入大量资源前，先用小规模、可撤回的实验检验假设，可以降低错误决策的成本。' },
  { query: '用户访谈怎么减少受访者迎合我？让他们先回顾实际发生的事，再谈不同意见。', expected: '访谈时先让参与者独立回忆具体经历，再追问反对意见，可以减少迎合研究者的回答。' },
];
const samples = [];
const reference = referenceFile ? await driver.json(referenceFile) : null;
try {
  await driver.doctor(run, cdp);
  await cdp.send('Page.bringToFront');
  await driver.click(cdp, '.nav-file-title[data-path="Source.md"]');
  for (let i = 0; i < count; i++) {
    const scenario = cases[i % cases.length];
    await driver.click(cdp, '.markdown-source-view .cm-content[contenteditable="true"]');
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 4, commands: ['selectAll'] });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 4 });
    await cdp.send('Input.insertText', { text: scenario.query });
    await driver.until(async () => await readFile(path.join(run.vault, 'Source.md'), 'utf8') === scenario.query, 'fixture edit persisted before timing');
    await driver.key(cdp, 'p', 'KeyP', 4);
    await driver.fill(cdp, '.prompt-input', 'Aha (Dev): Insert related links');
    await driver.until(() => cdp.evaluate("document.querySelectorAll('.suggestion-item').length === 1"), 'unique quick-link command');
    const point = await cdp.evaluate("(()=>{const r=document.querySelector('.suggestion-item').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()");
    await cdp.evaluate(`(() => {
      const observation = globalThis.__ahaTiming = { started: performance.now(), elapsedMs: null, firstVisibleMs: null };
      let scheduled = false;
      const observer = new MutationObserver(schedule);
      function schedule() {
        if (scheduled || observation.elapsedMs !== null) return;
        scheduled = true;
        requestAnimationFrame(() => requestAnimationFrame(measure));
      }
      function measure() {
        scheduled = false;
        if (!document.querySelector('.aha-quick-link-option') || observation.elapsedMs !== null) return;
        const popup = document.querySelector('.aha-quick-links');
        const r = popup.getBoundingClientRect();
        if (!r.width || !r.height || r.left < 0 || r.top < 0 || r.right > innerWidth + 1 || r.bottom > innerHeight + 1) { schedule(); return; }
        if (observation.firstVisibleMs === null) observation.firstVisibleMs = performance.now() - observation.started;
        if (popup.dataset.excerptsPending === 'true') return;
        observation.elapsedMs = performance.now() - observation.started;
        observer.disconnect();
      }
      observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-excerpts-pending'] });
    })()`);
    const requestsBefore = (await readFile(path.join(run.evidence, 'qmd-requests.jsonl'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).length;
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
    await driver.until(() => cdp.evaluate('globalThis.__ahaTiming?.firstVisibleMs'), 'first selectable candidates', 20000);
    const pending = await cdp.evaluate("document.querySelector('.aha-quick-links')?.dataset.excerptsPending === 'true'");
    let selected = [];
    if (pending) {
      await driver.key(cdp, ' ', 'Space');
      selected = await cdp.evaluate("[...document.querySelectorAll('.aha-quick-link-option[aria-selected=true]')].map(e=>e.dataset.path)");
      assert.equal(selected.length, 1, 'Pending candidates must already support selection');
    }
    const elapsedMs = await driver.until(() => cdp.evaluate('globalThis.__ahaTiming?.elapsedMs'), 'rendered complete quick-link results', 20000);
    if (pending) assert.deepEqual(await cdp.evaluate("[...document.querySelectorAll('.aha-quick-link-option[aria-selected=true]')].map(e=>e.dataset.path)"), selected);
    const candidates = await cdp.evaluate(`[...document.querySelectorAll('.aha-quick-link-option')].map(e => ({ path: e.dataset.path, excerpt: e.querySelector('.aha-quick-link-excerpt')?.textContent, method: e.dataset.excerptMethod }))`);
    assert(candidates.length > 0 && candidates.length <= 4);
    if (run.scenario !== 'production-links') {
    const match = candidates.find(candidate => candidate.path === '试错.md');
    assert.equal(match?.excerpt, scenario.expected);
    assert.equal(match?.method, 'semantic');
    }
    if (reference) {
      const previous = reference.samples.find(sample => sample.case === i % cases.length && sample.candidates.every(candidate => candidate.method === 'semantic'));
      assert(previous, 'Reference needs a complete semantic sample for each query');
      assert.deepEqual(candidates, previous.candidates, 'Candidate ordering and original excerpts must match the baseline');
    }
    assert(!candidates.some(candidate => ['Source.md', 'README.md', '项目规划.md'].includes(candidate.path)));
    const requests = (await readFile(path.join(run.evidence, 'qmd-requests.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).slice(requestsBefore).map(JSON.parse);
    const qmd = requests.find(request => request.event === 'end');
    assert.equal(requests.filter(request => request.event === 'start').length, 1);
    assert.equal(qmd?.code, 0);
    samples.push({ iteration: i, case: i % cases.length, selectionRetainedDuringExcerpts: pending ? true : null, firstVisibleMs: await cdp.evaluate('globalThis.__ahaTiming.firstVisibleMs'), elapsedMs, qmdMs: qmd.elapsedMs, candidates });
    await driver.save(path.join(run.evidence, `benchmark-${label}.json`), { label, buildHash: run.buildHash, scope: `${run.scenario === 'production-links' ? 'Production index, copied Markdown snapshot' : 'Synthetic index'}; command click preparation to complete candidates after layout settles inside the viewport; every sample runs real QMD and semantic excerpt selection; excludes human choice time`, samples });
    await driver.key(cdp, 'Escape', 'Escape');
    await driver.until(() => cdp.evaluate("!document.querySelector('.aha-quick-links')"), 'popup closed');
  }
  const times = samples.map(sample => sample.elapsedMs).sort((a, b) => a - b);
  console.log(JSON.stringify({ label, samples: count, medianMs: (times[Math.floor((count - 1) / 2)] + times[Math.floor(count / 2)]) / 2, minMs: times[0], maxMs: times.at(-1), failures: 0 }));
} catch (error) {
  await driver.save(path.join(run.evidence, `benchmark-${label}-failure.json`), { error: error.stack, samples });
  await driver.doctor(run, cdp);
  throw error;
} finally { cdp.close(); }
