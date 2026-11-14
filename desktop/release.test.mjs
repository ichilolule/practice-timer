import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, writeFile, readFile, rm, cp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { getCurrentFuseWire, FuseV1Options as F, FuseState } from '@electron/fuses';

const bundle = fileURLToPath(new URL('../dist/Practice Timer.app', import.meta.url));
const executable = path.join(bundle, 'Contents/MacOS/Practice Timer');

async function launch(profile, extraEnv = {}) {
  const child = spawn(executable, ['--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', '--inspect=0'], {
    env: { ...process.env, ...extraEnv, PRACTICE_TIMER_DATA_DIR: profile }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  let timer;
  const endpoint = await new Promise((resolve, reject) => {
    timer = setTimeout(() => { child.kill(); reject(new Error(`Release did not start: ${output}`)); }, 25_000);
    child.stderr.on('data', value => {
      output += value;
      const match = output.match(/DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/[^\s]+)/);
      if (match) resolve(match[1]);
    });
    child.once('error', reject);
    child.once('exit', code => reject(new Error(`Release exited ${code}: ${output}`)));
  }).finally(() => clearTimeout(timer));
  const browser = await chromium.connectOverCDP(endpoint);
  const context = browser.contexts()[0];
  const page = context.pages()[0] || await context.waitForEvent('page');
  await page.waitForSelector('#desktop-settings', { state: 'attached' });
  assert.equal(await page.title(), 'Practice Timer');
  assert.equal(await page.locator('#desktop-banner').isVisible(), false);
  return { child, page, output: () => output, stop: async () => {
    const exit = once(child, 'exit');
    child.kill('SIGTERM');
    await exit;
    await browser.close().catch(() => {});
  } };
}

test('release disables Node execution, environment injection and main-process inspection; validates bundled code', async () => {
  const wire = await getCurrentFuseWire(bundle);
  for (const key of [F.RunAsNode, F.EnableNodeOptionsEnvironmentVariable, F.EnableNodeCliInspectArguments, F.GrantFileProtocolExtraPrivileges]) {
    assert.equal(wire[key], FuseState.DISABLE);
  }
  for (const key of [F.EnableEmbeddedAsarIntegrityValidation, F.OnlyLoadAppFromAsar]) assert.equal(wire[key], FuseState.ENABLE);
});

test('hardened release starts normally despite injection flags, saves and restores a timer', { timeout: 60_000 }, async t => {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'practice-timer-release-'));
  t.after(() => rm(profile, { recursive: true, force: true }));
  const marker = path.join(profile, 'unexpected-node-execution');
  const probe = path.join(profile, 'probe.cjs');
  await writeFile(probe, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'must not execute');`);
  await writeFile(path.join(profile, 'practice-timer.json'), JSON.stringify({ format: 'practice-timer-beta', version: 1,
    steps: [{ type: 'work', minutes: 25 }, { type: 'rest', minutes: 5 }], tasks: [], groups: [], sessions: [],
    totalWorkMs: 0, run: null, sound: { volume: 0, pitch: 0 } }));
  let running;
  t.after(async () => { if (running) await running.stop().catch(() => {}); });
  running = await launch(profile, { ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: `--require=${probe}` });
  assert.equal(await running.page.evaluate(() => typeof window.require), 'undefined');
  await assert.rejects(readFile(marker), { code: 'ENOENT' });
  assert.doesNotMatch(running.output(), /Debugger listening on/);
  const sounds = await running.page.evaluate(() => practiceDesktop.sounds());
  assert.ok(sounds.length > 0);
  await running.page.evaluate(id => practiceDesktop.playSound(id, 1, 0), sounds[0].id);
  await running.page.locator('#settings-toggle').click();
  await running.page.selectOption('#sound-start', sounds[0].id);
  await running.page.locator('#nav-timer').click();
  await running.page.locator('#main-action').click();
  await running.page.waitForFunction(() => JSON.parse(practiceDesktop.loadState().value).run?.remainingMs < 1_499_000);
  await running.page.locator('#skip').click();
  assert.equal((await running.page.evaluate(() => JSON.parse(practiceDesktop.loadState().value))).run.phase, 'rest');
  await running.page.locator('#main-action').click();
  assert.equal(JSON.parse(await readFile(path.join(profile, 'practice-timer.json'), 'utf8')).run.status, 'paused');
  await running.stop(); running = null;
  running = await launch(profile);
  assert.equal(await running.page.locator('#main-action').getAttribute('aria-label'), 'Resume');
  assert.equal((await running.page.evaluate(() => JSON.parse(practiceDesktop.loadState().value))).run.phase, 'rest');
  await running.page.locator('#settings-toggle').click();
  assert.equal(await running.page.locator('#sound-start').inputValue(), sounds[0].id);
  const permissions = await running.page.evaluate(async () => (await navigator.permissions.query({ name: 'clipboard-read' })).state);
  assert.equal(permissions, 'denied');
  await running.stop(); running = null;
});

test('release rejects a modified application archive before its code can run', { timeout: 60_000 }, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'practice-timer-tamper-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const copy = path.join(directory, 'Practice Timer.app');
  await cp(bundle, copy, { recursive: true, verbatimSymlinks: true });
  const archive = path.join(copy, 'Contents/Resources/app.asar');
  const bytes = await readFile(archive);
  const position = bytes.indexOf(Buffer.from('"hash":"')) + 8;
  assert.ok(position > 8);
  bytes[position] = bytes[position] === 0x61 ? 0x62 : 0x61;
  await writeFile(archive, bytes);
  const child = spawn(path.join(copy, 'Contents/MacOS/Practice Timer'), [], {
    env: { ...process.env, PRACTICE_TIMER_DATA_DIR: path.join(directory, 'profile') }, stdio: ['ignore', 'ignore', 'pipe'],
  });
  let output = '';
  child.stderr.on('data', value => { output += value; });
  const timer = setTimeout(() => child.kill(), 20_000);
  t.after(() => { clearTimeout(timer); if (child.exitCode === null && child.signalCode === null) child.kill(); });
  const [code, signal] = await once(child, 'exit');
  clearTimeout(timer);
  assert.ok(code !== 0 || signal);
  assert.match(output, /integrity|hash mismatch/i);
});
