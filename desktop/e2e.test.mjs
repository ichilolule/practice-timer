import test from 'node:test';
import assert from 'node:assert/strict';
import { _electron as electron } from 'playwright-core';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, writeFile, rm, mkdir, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../', import.meta.url));
const executablePath = require('electron');
const fixture = { format: 'practice-timer-beta', version: 1,
  steps: [{ type: 'work', minutes: 25 }, { type: 'rest', minutes: 5 }],
  tasks: [], groups: [], sessions: [], run: null, totalWorkMs: 0, sound: { volume: 0, pitch: 0 } };

async function launch(directory) {
  return electron.launch({ executablePath, args: [root],
    env: { ...process.env, PRACTICE_TIMER_DATA_DIR: directory }, timeout: 30_000 });
}
async function command(app, type, extra = {}) {
  await app.evaluate(({ BrowserWindow }, value) => BrowserWindow.getAllWindows()[0].webContents.send('desktop:command', value), { type, ...extra });
}
async function state(page) { return page.evaluate(() => JSON.parse(practiceDesktop.loadState().value)); }
async function quit(app) {
  const closed = app.waitForEvent('close', { timeout: 15_000 });
  await app.evaluate(({ app }) => app.quit());
  await closed;
}

test('desktop: native menus, hidden timing, shortcuts, backups, suspend, restart and mobile Web', { timeout: 120_000 }, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'practice-timer-e2e-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(path.join(directory, 'desktop-settings.json'), JSON.stringify({ shortcuts: { toggle: 'Control+Alt+Shift+F11', end: 'Control+Alt+Shift+F12' } }));
  await writeFile(path.join(directory, 'practice-timer.json'), JSON.stringify(fixture));
  let app = await launch(directory);
  t.after(async () => { if (app) await app.close().catch(() => {}); });
  let page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => document.title === 'Practice Timer');
  assert.equal(await page.title(), 'Practice Timer');
  assert.equal(await page.locator('#desktop-banner').isVisible(), false);
  assert.equal(await page.locator('#desktop-save-status').textContent(), '');
  assert.match(page.url(), /^http:\/\/127\.0\.0\.1:/);
  assert.equal(await page.evaluate(() => typeof window.require), 'undefined');
  await app.evaluate(({ Tray }) => {
    const title = Tray.prototype.setTitle, menu = Tray.prototype.setContextMenu;
    Tray.prototype.setTitle = function (...args) { globalThis.lastTrayTitle = args[0]; return title.apply(this, args); };
    Tray.prototype.setContextMenu = function (value) { globalThis.lastTrayMenu = value; return menu.call(this, value); };
  });
  await page.locator('#timer-quick-task-title').fill('Desktop test task');
  await page.locator('#timer-quick-task-title').press('Enter');
  await command(app, 'toggle');
  await page.waitForFunction(() => document.getElementById('main-action').getAttribute('aria-label') === 'Pause');
  assert.equal((await state(page)).run.status, 'running');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), false);
  await page.waitForFunction(() => document.getElementById('clock').textContent === '24:58');
  assert.match(await app.evaluate(() => globalThis.lastTrayTitle), /^24:5[78]$/);
  await app.evaluate(() => globalThis.lastTrayMenu.items.find(item => item.label === 'Pause').click());
  await page.waitForFunction(() => document.getElementById('main-action').getAttribute('aria-label') === 'Resume');
  assert.match(await app.evaluate(() => globalThis.lastTrayTitle), /^Ⅱ /);
  assert.equal((await state(page)).run.status, 'paused');
  await app.evaluate(() => globalThis.lastTrayMenu.items.find(item => item.label === 'Show timer').click());
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), true);
  await command(app, 'settings');
  await page.waitForSelector('#desktop-settings:visible');
  assert.equal(await page.locator('#desktop-settings-title').textContent(), 'Shortcut keys');
  assert.equal(await page.locator('#desktop-shortcut-help').count(), 0);
  assert.equal(await page.locator('.settings-column').first().locator('.settings-section').last().getAttribute('id'), 'desktop-settings');
  assert.equal((await page.evaluate(() => practiceDesktop.settings())).shortcuts.skip, 'Command+Shift+Right');
  const shortcuts = { toggle: 'Control+Alt+Shift+F11', skip: 'Control+Alt+Shift+F9', end: 'Control+Alt+Shift+F12' };
  const result = await page.evaluate(value => practiceDesktop.setShortcuts(value), shortcuts);
  assert.equal(result.ok, true);
  assert.deepEqual(result.registration, { toggle: true, skip: true, end: true });
  const failed = await page.evaluate(() => practiceDesktop.setShortcuts({ toggle: 'Control+F10', skip: 'Control+F9', end: 'Control+F10' }));
  assert.equal(failed.ok, false);
  assert.deepEqual(failed.shortcuts, shortcuts);
  await app.evaluate(({ globalShortcut }) => {
    globalThis.originalRegister = globalShortcut.register;
    globalShortcut.register = (key, callback) => key === 'Control+Alt+Shift+F10' ? false : globalThis.originalRegister(key, callback);
  });
  const conflict = await page.evaluate(value => practiceDesktop.setShortcuts(value), { ...shortcuts, toggle: 'Control+Alt+Shift+F10' });
  assert.equal(conflict.ok, false);
  assert.deepEqual(conflict.shortcuts, shortcuts);
  assert.deepEqual(conflict.registration, { toggle: true, skip: true, end: true });
  await app.evaluate(({ globalShortcut }) => { globalShortcut.register = globalThis.originalRegister; });
  await page.locator('#desktop-shortcut-toggle').focus();
  await page.waitForTimeout(100);
  assert.equal(await app.evaluate(({ globalShortcut }) => globalShortcut.isRegistered('Control+Alt+Shift+F11')), false);
  await page.locator('#desktop-shortcut-toggle').press('Control+Alt+Shift+P');
  await page.waitForFunction(() => document.getElementById('desktop-shortcut-status').textContent === 'Shortcuts saved.');
  await page.locator('#desktop-shortcut-reset').focus();
  await page.waitForTimeout(100);
  assert.equal(await app.evaluate(({ globalShortcut }) => globalShortcut.isRegistered('Control+Alt+Shift+P')), true);
  await page.locator('#desktop-shortcut-skip').focus();
  await page.locator('#desktop-shortcut-skip').press('Control+Alt+Shift+ArrowRight');
  await page.waitForFunction(() => document.getElementById('desktop-shortcut-status').textContent === 'Shortcuts saved.');
  await page.locator('#desktop-shortcut-reset').focus();
  assert.equal((await page.evaluate(() => practiceDesktop.settings())).shortcuts.skip, 'Control+Alt+Shift+Right');
  await page.evaluate(value => practiceDesktop.setShortcuts(value), shortcuts);
  const backupDirectory = path.join(directory, 'backup');
  await mkdir(backupDirectory);
  const backupPath = path.join(backupDirectory, 'practice-timer.json');
  await app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, backupPath);
  await page.locator('#backup-add').click();
  await page.waitForFunction(() => document.getElementById('backup-auto-status').textContent.includes('1 of 1 destinations saved'));
  const backup = JSON.parse(await readFile(backupPath, 'utf8'));
  assert.equal(backup.run.status, 'paused');
  assert.equal(backup.tasks[0].title, 'Desktop test task');
  await writeFile(backupPath, JSON.stringify({ ...backup, externalChange: true }));
  await page.evaluate(() => { window.confirm = () => false; });
  await page.locator('#backup-save').click();
  await page.waitForFunction(() => document.querySelector('.backup-target-status').textContent === 'Changed elsewhere');
  assert.equal(JSON.parse(await readFile(backupPath, 'utf8')).externalChange, true);
  await page.screenshot({ path: '/private/tmp/practice-timer-desktop-settings.png' });
  await page.locator('#nav-timer').click();
  await command(app, 'toggle');
  await page.waitForFunction(() => document.getElementById('main-action').getAttribute('aria-label') === 'Pause');
  await command(app, 'suspend', { at: Date.now() });
  await page.waitForFunction(() => document.getElementById('main-action').getAttribute('aria-label') === 'Resume');
  const beforeQuit = (await state(page)).run.remainingMs;
  await page.screenshot({ path: '/private/tmp/practice-timer-desktop.png' });

  // A second browser window without preload uses the unchanged mobile Web storage.
  const webWindowPromise = app.waitForEvent('window');
  await app.evaluate(async ({ BrowserWindow }, url) => {
    const web = new BrowserWindow({ width: 390, height: 844, show: false,
      webPreferences: { contextIsolation: true, nodeIntegration: false } });
    await web.loadURL(url);
  }, page.url());
  const web = await webWindowPromise;
  await web.waitForSelector('#main-action');
  assert.equal(await web.evaluate(() => typeof practiceDesktop), 'undefined');
  assert.equal(await web.locator('#desktop-banner').isVisible(), false);
  assert.equal(await web.locator('#desktop-settings').isVisible(), false);
  await web.locator('#main-action').click();
  await web.locator('#add-step').click();
  await web.locator('#add-step').click();
  await web.locator('#nav-timer').click();
  await web.locator('#main-action').click();
  assert.equal(await web.locator('#main-action').getAttribute('aria-label'), 'Pause');
  await web.screenshot({ path: '/private/tmp/practice-timer-mobile-web.png' });
  await web.locator('#settings-toggle').click();
  assert.equal(await web.locator('.routine-section').evaluate(element => getComputedStyle(element).borderTopWidth), '0px');
  await web.close();
  await quit(app); app = null;
  const onDisk = JSON.parse(await readFile(path.join(directory, 'practice-timer.json'), 'utf8'));
  assert.equal(onDisk.run.status, 'paused');
  assert.equal(onDisk.tasks[0].title, 'Desktop test task');
  app = await launch(directory); page = await app.firstWindow();
  await page.waitForFunction(() => document.title === 'Practice Timer');
  assert.equal(await page.locator('#main-action').getAttribute('aria-label'), 'Resume');
  assert.equal((await state(page)).run.remainingMs, beforeQuit);
  assert.deepEqual((await page.evaluate(() => practiceDesktop.settings())).shortcuts, shortcuts);
  const targets = await page.evaluate(() => practiceDesktop.readBackupTargets());
  assert.equal(targets.length, 1);
  assert.equal((await page.evaluate(() => practiceDesktop.loadState())).ok, true);
  assert.equal(JSON.parse(await readFile(backupPath, 'utf8')).externalChange, true);
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 1 });
  });
  // Reattach a tray-menu observer after restarting the app.
  await app.evaluate(({ Tray }) => {
    const original = Tray.prototype.setContextMenu;
    Tray.prototype.setContextMenu = function (menu) { globalThis.lastTrayMenu = menu; return original.call(this, menu); };
  });
  await command(app, 'toggle');
  await page.waitForFunction(() => document.getElementById('main-action').getAttribute('aria-label') === 'Pause');
  await app.evaluate(() => globalThis.lastTrayMenu.items.find(item => item.label === 'End session…').click());
  assert.notEqual((await state(page)).run, null);
  await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 0 }); });
  await app.evaluate(() => globalThis.lastTrayMenu.items.find(item => item.label === 'End session…').click());
  await page.waitForFunction(() => document.getElementById('main-action').getAttribute('aria-label') === 'Start');
  const finished = await state(page);
  assert.equal(finished.run, null);
  assert.ok(finished.sessions.length > 0);
  assert.equal(finished.sessions[0].taskTitle, 'Desktop test task');
  assert.deepEqual(errors, []);
  await quit(app); app = null;
});

test('corrupt native data is kept intact until a valid JSON is explicitly imported', { timeout: 45_000 }, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'practice-timer-corrupt-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = path.join(directory, 'practice-timer.json');
  await writeFile(filename, '{broken');
  const app = await launch(directory);
  t.after(() => app.close().catch(() => {}));
  const page = await app.firstWindow();
  await page.waitForSelector('#desktop-banner:visible');
  assert.match(await page.locator('#desktop-save-status').textContent(), /could not be read/);
  await page.locator('#main-action').click();
  await page.locator('#add-step').click();
  assert.equal(await readFile(filename, 'utf8'), '{broken');
  await page.evaluate(() => { window.confirm = () => true; });
  await page.locator('#import-file').setInputFiles({ name: 'practice-timer.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(fixture)) });
  await page.waitForFunction(() => document.getElementById('backup-status').textContent === 'JSON imported.');
  assert.equal(JSON.parse(await readFile(filename, 'utf8')).steps.length, 2);
  assert.equal(await page.locator('#desktop-banner').isVisible(), false);
  assert.equal(await page.locator('#desktop-save-status').textContent(), '');
  await quit(app);
});

test('hidden phase changes and quitting a running timer preserve elapsed work', { timeout: 45_000 }, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'practice-timer-phases-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(path.join(directory, 'practice-timer.json'), JSON.stringify({ ...fixture,
    steps: [{ type: 'work', minutes: 0.1 }, { type: 'rest', minutes: 1 }] }));
  const app = await launch(directory);
  t.after(() => app.close().catch(() => {}));
  const page = await app.firstWindow();
  await page.waitForFunction(() => document.title === 'Practice Timer');
  await command(app, 'toggle');
  await page.waitForFunction(() => document.getElementById('main-action').getAttribute('aria-label') === 'Pause');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  await page.waitForFunction(() => JSON.parse(practiceDesktop.loadState().value).run.phase === 'rest');
  await quit(app);
  const saved = JSON.parse(await readFile(path.join(directory, 'practice-timer.json'), 'utf8'));
  assert.equal(saved.run.status, 'paused');
  assert.equal(saved.run.phase, 'rest');
  assert.equal(saved.run.totalWorkMs, 6000);
  assert.equal(saved.run.sessionWorkMs, 6000);
});

test('desktop security: imported markup, denied browser permissions, foreign windows and outside requests', { timeout: 45_000 }, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'practice-timer-security-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const payload = '<img src=x onerror="window.__injected=true">';
  const initial = { ...fixture, tasks: [{ id: 'security-task', title: payload, firstStep: '', targetId: null, completedAt: null }] };
  await writeFile(path.join(directory, 'practice-timer.json'), JSON.stringify(initial));
  const app = await launch(directory);
  t.after(() => app.close().catch(() => {}));
  const page = await app.firstWindow();
  await page.waitForFunction(() => document.title === 'Practice Timer');
  assert.ok((await page.locator('#task-picker-list').textContent()).includes(payload));
  assert.equal(await page.locator('#task-picker-list img').count(), 0);
  assert.equal(await page.evaluate(() => window.__injected), undefined);
  const permissions = await page.evaluate(async () => Promise.all(
    ['clipboard-read', 'geolocation', 'camera', 'microphone'].map(async name => (await navigator.permissions.query({ name })).state)));
  assert.deepEqual(permissions, ['denied', 'denied', 'denied', 'denied']);
  await assert.rejects(page.evaluate(() => practiceDesktop.readBackup('../../unrelated-file')), /Choose this backup destination again/);

  let requests = 0;
  const outside = http.createServer((_request, response) => { requests++; response.end('Untrusted test page'); });
  await new Promise(resolve => outside.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => outside.close(resolve)));
  const outsideURL = `http://127.0.0.1:${outside.address().port}/`;
  const ownURL = page.url();
  assert.equal(await page.evaluate(async url => { try { await fetch(url); return true; } catch { return false; } }, outsideURL), false);
  await page.evaluate(url => { window.location.href = url; window.open(url); }, outsideURL);
  await page.waitForTimeout(150);
  assert.equal(page.url(), ownURL);
  assert.equal(app.windows().length, 1);
  assert.equal(requests, 0);

  const foreignWindow = app.waitForEvent('window');
  await app.evaluate(async ({ BrowserWindow }, { url, preload }) => {
    const foreign = new BrowserWindow({ show: false, webPreferences: {
      preload, sandbox: true, contextIsolation: true, nodeIntegration: false,
    } });
    await foreign.loadURL(url);
  }, { url: ownURL, preload: path.join(root, 'desktop/preload.cjs') });
  const foreign = await foreignWindow;
  await foreign.waitForSelector('#desktop-banner:visible');
  assert.equal((await foreign.evaluate(() => practiceDesktop.loadState())).ok, false);
  assert.equal((await foreign.evaluate(value => practiceDesktop.saveState(value), JSON.stringify(initial))).ok, false);
  await assert.rejects(foreign.evaluate(() => practiceDesktop.readBackupTargets()), /Untrusted request/);
  await assert.rejects(foreign.evaluate(() => practiceDesktop.settings()), /Untrusted request/);
  await assert.rejects(foreign.evaluate(() => practiceDesktop.sounds()), /Untrusted request/);
  await assert.rejects(foreign.evaluate(() => practiceDesktop.playSound('mac:Glass.aiff', 1, 0)), /Untrusted request/);
  await foreign.close();
  assert.equal((await state(page)).tasks[0].title, payload);
  await quit(app);
});


test('fixed sound choices, button/shortcut parity, skip keys and coffee tray icon', { timeout: 120_000 }, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'practice-timer-sounds-'));
  await writeFile(path.join(directory, 'practice-timer.json'), JSON.stringify(fixture));
  let app = await launch(directory);
  t.after(async () => {
    if (app) app.process().kill('SIGKILL');
    await rm(directory, { recursive: true, force: true });
  });
  let page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => document.title === 'Practice Timer');
  await command(app, 'settings');
  await page.waitForSelector('#sound-start:visible');
  await page.waitForFunction(() => document.querySelector('#sound-start optgroup[label="Mac sounds"]'));
  for (const id of ['sound-pitch', 'sound-operation-volume', 'shortcut-sounds']) {
    assert.equal(await page.locator(`#${id}`).count(), 0);
  }
  const sounds = await page.evaluate(() => practiceDesktop.sounds());
  const installed = (await readdir('/System/Library/Sounds')).filter(name => /\.(aiff?|wav|caf|m4a|mp3)$/i.test(name)).sort();
  assert.deepEqual(sounds.map(sound => sound.id), installed.map(name => `mac:${name}`));
  const builtIns = await page.evaluate(() => Object.keys(PracticeSounds.BUILT_INS));
  for (const event of ['start', 'pause', 'resume', 'skip', 'end', 'work', 'rest']) {
    assert.equal(await page.locator(`#sound-${event} option`).count(), sounds.length + builtIns.length);
    const labels = await page.locator(`#sound-${event} option`).allTextContents();
    assert.equal(new Set(labels).size, labels.length);
    for (const variant of ['Start', 'Pause', 'Resume', 'Skip', 'End']) assert.ok(labels.includes(`Electronic (${variant})`));
  }
  async function volume(value) {
    await page.locator('#sound-volume').evaluate((element, value) => {
      element.value = String(value);
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
    }, value);
  }
  await volume(1);
  const rendered = await page.evaluate(async () => {
    const result = [];
    for (const id of Object.keys(PracticeSounds.BUILT_INS).filter(id => id !== 'none')) {
      const context = new OfflineAudioContext(1, 44_100, 44_100);
      PracticeSounds.synthesize(context, id, 500);
      const samples = (await context.startRendering()).getChannelData(0);
      let peak = 0, energy = 0;
      for (const value of samples) { peak = Math.max(peak, Math.abs(value)); energy += value * value; }
      result.push({ id, peak, energy });
    }
    return result;
  });
  assert.ok(rendered.every(sound => sound.peak > 0.01 && sound.peak < 1 && sound.energy > 0));
  assert.equal(new Set(rendered.map(sound => sound.energy)).size, 20);
  for (const id of [...builtIns.filter(id => id !== 'none'), ...sounds.map(sound => sound.id)]) {
    await page.selectOption('#sound-start', id);
    await page.locator('#preview-start').click();
    await page.waitForFunction(() => !document.getElementById('preview-start').disabled);
    assert.equal(await page.locator('#sound-status').textContent(), '');
  }
  await page.selectOption('#sound-end', sounds[0].id);
  await page.locator('#preview-end').click();
  await page.waitForFunction(() => !document.getElementById('preview-end').disabled);
  const assigned = { start: 'electronic-end', pause: 'electronic-pause', resume: 'electronic-start', skip: 'electronic-resume', end: 'electronic-skip' };
  for (const [event, id] of Object.entries(assigned)) await page.selectOption(`#sound-${event}`, id);
  await volume(0);
  for (const event of Object.keys(assigned)) assert.equal(await page.locator(`#preview-${event}`).isDisabled(), true);
  await volume(1);
  await page.locator('#sound-start').scrollIntoViewIfNeeded();
  await page.screenshot({ path: '/private/tmp/practice-timer-sound-settings.png' });
  await page.evaluate(() => {
    globalThis.played = [];
    const original = AudioContext.prototype.createOscillator;
    AudioContext.prototype.createOscillator = function (...args) {
      const oscillator = original.apply(this, args);
      const start = oscillator.start.bind(oscillator), stop = oscillator.stop.bind(oscillator);
      let at;
      oscillator.start = value => { at = value; start(value); };
      oscillator.stop = value => { played.push([oscillator.type, oscillator.frequency.value, Math.round((value - at) * 1e6)]); stop(value); };
      return oscillator;
    };
  });
  const expectedIcons = await app.evaluate(({ Tray, nativeImage }, root) => {
    const original = Tray.prototype.setImage;
    Tray.prototype.setImage = function (image) { globalThis.lastTrayImage = image.toPNG().toString('base64'); return original.call(this, image); };
    return Object.fromEntries(['work', 'rest'].map(phase => {
      const name = phase === 'rest' ? 'breakTrayTemplate.png' : 'trayTemplate.png';
      const image = nativeImage.createFromPath(`${root}/desktop/${name}`);
      if (image.isEmpty()) throw new Error('Missing tray icon');
      return [phase, image.toPNG().toString('base64')];
    }));
  }, root);
  const iconIs = async phase => assert.equal(await app.evaluate(() => globalThis.lastTrayImage), expectedIcons[phase]);
  async function action(callback, count) {
    await page.evaluate(() => { played = []; });
    await callback();
    await page.waitForFunction(count => played.length === count, count);
    return page.evaluate(() => played);
  }
  await app.evaluate(({ globalShortcut }) => {
    globalThis.soundShortcutCallbacks = new Map();
    const original = globalShortcut.register;
    globalShortcut.register = (key, callback) => { soundShortcutCallbacks.set(key, callback); return original.call(globalShortcut, key, callback); };
  });
  const shortcuts = { toggle: 'Control+Alt+Shift+F11', skip: 'Control+Alt+Shift+F9', end: 'Control+Alt+Shift+F12' };
  assert.equal((await page.evaluate(value => practiceDesktop.setShortcuts(value), shortcuts)).ok, true);
  const press = key => app.evaluate((_electron, key) => globalThis.soundShortcutCallbacks.get(key)(), key);
  await page.locator('#nav-timer').click();
  const clicked = {};
  clicked.start = await action(() => page.locator('#main-action').click(), 3);
  clicked.pause = await action(() => page.locator('#main-action').click(), 1);
  clicked.resume = await action(() => page.locator('#main-action').click(), 2);
  clicked.skip = await action(() => page.locator('#skip').click(), 2);
  assert.equal((await state(page)).run.phase, 'rest');
  await iconIs('rest');
  await action(() => page.locator('#main-action').click(), 1);
  assert.equal((await state(page)).run.status, 'paused');
  await iconIs('rest');
  // Skipping a paused break starts work and restores the stopwatch icon.
  assert.deepEqual(await action(() => page.locator('#skip').click(), 2), clicked.skip);
  assert.equal((await state(page)).run.phase, 'work');
  assert.equal((await state(page)).run.status, 'running');
  await iconIs('work');
  clicked.end = await action(() => page.locator('#end').click(), 2);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].hide());
  assert.deepEqual(await action(() => press(shortcuts.toggle), 3), clicked.start);
  assert.deepEqual(await action(() => press(shortcuts.toggle), 1), clicked.pause);
  assert.deepEqual(await action(() => press(shortcuts.toggle), 2), clicked.resume);
  assert.deepEqual(await action(() => press(shortcuts.skip), 2), clicked.skip);
  assert.equal((await state(page)).run.phase, 'rest');
  await iconIs('rest');
  await page.evaluate(() => { played = []; });
  await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1 }); });
  await press(shortcuts.end);
  assert.deepEqual(await page.evaluate(() => played), []);
  assert.notEqual((await state(page)).run, null);
  await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 0 }); });
  assert.deepEqual(await action(() => press(shortcuts.end), 2), clicked.end);
  await page.waitForFunction(() => JSON.parse(practiceDesktop.loadState().value).run === null);
  await iconIs('work');
  await page.evaluate(() => { played = []; });
  await press(shortcuts.skip);
  await page.waitForTimeout(100);
  assert.deepEqual(await page.evaluate(() => played), []);
  const savedSound = (await state(page)).sound;
  assert.equal(savedSound.volume, 5);
  assert.equal('pitch' in savedSound, false);
  await command(app, 'settings');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].show());
  await page.locator('#step-list .step-delete').first().click();
  await page.locator('#step-list .step-delete').first().click();
  await press(shortcuts.toggle);
  await page.waitForTimeout(100);
  assert.deepEqual(await page.evaluate(() => played), []);
  assert.equal((await state(page)).run, null);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(360, 740));
  await page.waitForFunction(() => innerWidth === 360);
  await page.locator('#sound-start').scrollIntoViewIfNeeded();
  await page.screenshot({ path: '/private/tmp/practice-timer-sound-small.png' });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await quit(app); app = null;
  app = await launch(directory); page = await app.firstWindow();
  await page.waitForFunction(() => document.title === 'Practice Timer');
  await command(app, 'settings');
  await page.waitForSelector('#sound-start:visible');
  assert.deepEqual((await state(page)).sound, savedSound);
  assert.equal(await page.locator('#sound-start').inputValue(), 'electronic-end');
  assert.deepEqual((await page.evaluate(() => practiceDesktop.settings())).shortcuts, shortcuts);
  assert.deepEqual(errors, []);
  await quit(app); app = null;
});
