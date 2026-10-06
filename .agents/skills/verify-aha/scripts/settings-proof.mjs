#!/usr/bin/env node
import assert from 'node:assert/strict';
import path from 'node:path';
import { driver } from './verify.mjs';

const [directory] = process.argv.slice(2);
assert(directory, 'Usage: settings-proof.mjs <owned evidence directory>');
const run = await driver.json(path.join(directory, 'run.json'));
const main = await driver.connect(run);
let settings;
try {
  await driver.doctor(run, main);
  await main.send('Page.bringToFront');
  await driver.key(main, ',', 'Comma', 4);
  settings = await driver.until(() => driver.connect(run, 'settings'), 'owned settings window');
  await settings.send('Page.bringToFront');
  await driver.click(settings, '.vertical-tab-nav-item', 'Aha');
  await driver.until(() => settings.evaluate("document.querySelector('.aha-health-section summary')?.textContent.includes('需处理')"), 'health failure remains discoverable');
  const initial = await settings.evaluate(`({disclosures:[...document.querySelectorAll('.aha-settings details')].map(e=>({name:e.querySelector('summary').textContent,open:e.open})),visibleControls:[...document.querySelectorAll('.aha-settings input,.aha-settings textarea,.aha-settings button')].filter(e=>e.checkVisibility() && e.getBoundingClientRect().width).map(e=>e.getAttribute('aria-label')),body:document.querySelector('.aha-settings').innerText})`);
  assert.equal(initial.disclosures.length, 4);
  assert(initial.disclosures.every(section => !section.open));
  for (const label of ['排除文件夹', 'New notes per index update', 'Embed now']) assert(initial.visibleControls.includes(label));
  assert(!initial.visibleControls.includes('API key'), 'Optional relation-judgment configuration stays folded');
  await driver.snapshot(run, settings, 'settings-compact');
  await driver.click(settings, '.aha-settings details summary', '关系判断（DeepSeek，可选）');
  await driver.fill(settings, 'input[aria-label="模型"]', 'verification-model');
  await driver.until(async () => (await driver.json(driver.dataPath(run))).settings.deepseekModel === 'verification-model', 'connection setting persisted');
  await driver.fill(settings, 'input[aria-label="模型"]', 'deepseek-v4-pro');
  await driver.click(settings, '.aha-settings details summary', '关系判断（DeepSeek，可选）');
  await driver.click(settings, '.aha-settings details summary', '高级设置');
  await driver.fill(settings, 'textarea[aria-label="查询提示词"]', 'Synthetic verification prompt.');
  await driver.until(async () => (await driver.json(driver.dataPath(run))).settings.queryPromptOverride === 'Synthetic verification prompt.', 'advanced setting persisted');
  await driver.fill(settings, 'textarea[aria-label="查询提示词"]', '');
  await driver.snapshot(run, settings, 'settings-advanced');
  await driver.click(settings, '.aha-settings details summary', '高级设置');
  await driver.click(settings, '.aha-health-section summary');
  assert(await settings.evaluate("document.querySelector('.aha-health-section').open"));
  await driver.snapshot(run, settings, 'settings-health');
  const fixes = await settings.evaluate("[...document.querySelectorAll('.aha-health-fix')].map(e=>({role:e.getAttribute('role'),tabIndex:e.tabIndex,label:e.getAttribute('aria-label')}))");
  assert(fixes.length > 0 && fixes.every(fix => fix.role === 'button' && fix.tabIndex === 0 && fix.label));
  await driver.click(settings, '.aha-health-section summary');
  await driver.key(settings, ' ', 'Space');
  await driver.until(() => settings.evaluate("document.querySelector('.aha-health-section').open"), 'disclosure opens with keyboard');
  await driver.key(settings, ' ', 'Space');
  await driver.until(() => settings.evaluate("!document.querySelector('.aha-health-section').open"), 'disclosure closes with keyboard');
  await settings.send('Emulation.setDeviceMetricsOverride', { width: 760, height: 800, deviceScaleFactor: 1, mobile: false });
  const overflow = await settings.evaluate("(()=>{const e=document.querySelector('.aha-settings');return {width:e.clientWidth,scrollWidth:e.scrollWidth}})()");
  assert(overflow.scrollWidth <= overflow.width + 1, 'Settings must not overflow horizontally at narrow width');
  await driver.snapshot(run, settings, 'settings-narrow');
  await driver.save(path.join(run.evidence, 'settings-report.json'), { status: 'passed', initial, fixes, overflow, verified: ['compact-defaults', 'connection-save', 'advanced-save', 'health-discoverability', 'native-keyboard-disclosures', 'narrow-no-overflow'], notVerified: ['real DeepSeek connection', 'clipboard write to preserve user clipboard'] });
  await driver.closeSettings(main, settings);
} catch (error) {
  await driver.snapshot(run, settings ?? main, 'settings-failure').catch(() => {});
  await driver.doctor(run, main);
  throw error;
} finally { settings?.close(); main.close(); }
