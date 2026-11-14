'use strict';
const { app, BrowserWindow, Menu, Tray, nativeImage, ipcMain, dialog, globalShortcut, powerMonitor, Notification } = require('electron');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createStorage, atomicWrite, readText, checkState } = require('./storage.cjs');
const { serve } = require('./server.cjs');
const { createNativeSounds } = require('./native-sounds.cjs');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_SHORTCUTS = { toggle: 'Command+Shift+Space', end: 'Command+Shift+Enter' };
app.setName('Practice Timer');
// Tests use a separate directory and never import or overwrite the user's data.
if (process.env.PRACTICE_TIMER_DATA_DIR) app.setPath('userData', path.resolve(process.env.PRACTICE_TIMER_DATA_DIR));

let window, tray, server, storage, preferences;
let ready = false, allowQuit = false, quitPending = false, quitTimeout;
let status = { status: 'ready', phase: 'work', time: '00:00', task: '', canStart: false };
let shortcuts = { ...DEFAULT_SHORTCUTS }, registration = {};
let suspendedAt = null;
let recordingShortcut = false, endDialogOpen = false, trayMenu, traySignature;
let nativeSounds;
const allowedFiles = new Map();

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => showWindow());
  app.whenReady().then(start).catch(error => {
    dialog.showErrorBox('Practice Timer could not start', error.message); allowQuit = true; app.quit();
  });
}

function showWindow(settings = false) {
  if (!window || window.isDestroyed()) return;
  if (window.isMinimized()) window.restore();
  window.show(); window.focus();
  if (settings && ready) send('settings');
}
function send(type, extra = {}) {
  if (ready && !window.isDestroyed()) window.webContents.send('desktop:command', { type, ...extra });
}
async function endSession(source = 'menu') {
  if (status.status === 'ready' || quitPending || recordingShortcut || endDialogOpen) return;
  endDialogOpen = true;
  try {
    const { response } = await dialog.showMessageBox(window, {
      type: 'question', message: 'End this session?', detail: 'Your work time will be recorded.',
      buttons: ['End session', 'Cancel'], defaultId: 1, cancelId: 1,
    });
    if (response === 0) send('end', { source });
  } finally { endDialogOpen = false; }
}
function toggle(source = 'menu') {
  if (quitPending || recordingShortcut || endDialogOpen) return;
  if (status.status === 'ready' && !status.canStart) showWindow(true);
  else send('toggle', { source });
}
function shortcutAction(key) { return () => key === 'toggle' ? toggle('shortcut') : endSession('shortcut'); }
function setShortcuts(next) {
  if (!next || !['toggle', 'end'].every(key => typeof next[key] === 'string' &&
      /^(?:(?:Command|Control|Alt|Shift)\+)+(?:[A-Z0-9]|Space|Enter|Period|Comma|F(?:[1-9]|1[0-2]))$/.test(next[key]) &&
      /(?:Command|Control|Alt)\+/.test(next[key])) || next.toggle === next.end) {
    throw new Error('Choose two different shortcuts with modifier keys.');
  }
  const previous = { ...shortcuts };
  const register = values => Object.fromEntries(Object.entries(values).map(([key, accelerator]) =>
    [key, globalShortcut.register(accelerator, shortcutAction(key))]));
  globalShortcut.unregisterAll();
  let result;
  try { result = register(next); } catch { result = {}; }
  if (!result.toggle || !result.end) {
    globalShortcut.unregisterAll(); registration = register(previous);
    if (recordingShortcut) globalShortcut.unregisterAll();
    throw new Error('That shortcut is in use or unavailable. The previous shortcuts were kept.');
  }
  shortcuts = { ...next }; registration = result;
  if (recordingShortcut) globalShortcut.unregisterAll();
}
function setRecording(active) {
  if (recordingShortcut === active) return;
  recordingShortcut = active;
  if (active) globalShortcut.unregisterAll();
  else for (const [key, accelerator] of Object.entries(shortcuts)) {
    try { registration[key] = globalShortcut.register(accelerator, shortcutAction(key)); }
    catch { registration[key] = false; }
  }
}
function publicSettings() { return { shortcuts, defaults: DEFAULT_SHORTCUTS, registration }; }
function persistPreferences() { storage.writeSettings(preferences); }
function checkedFile(id) {
  const filename = allowedFiles.get(id);
  if (!filename) throw new Error('Choose this backup destination again.');
  return filename;
}
function refreshTray() {
  if (!tray) return;
  const phase = status.phase === 'rest' ? 'Break' : 'Work';
  const prefix = status.status === 'paused' ? 'Ⅱ ' : status.status === 'running' ? '' : '○ ';
  tray.setTitle(`${prefix}${status.time}`, { fontType: 'monospacedDigit' });
  tray.setToolTip(`Practice Timer — ${phase}${status.task ? ` · ${status.task}` : ''}`);
  const description = `${phase} · ${status.time}${status.status === 'paused' ? ' · paused' : ''}`;
  const signature = JSON.stringify([status.status, status.phase, status.task, ready, quitPending]);
  if (trayMenu && signature === traySignature) {
    trayMenu.getMenuItemById('phase-status').label = description;
    return;
  }
  traySignature = signature;
  trayMenu = Menu.buildFromTemplate([
    { label: 'Practice Timer', enabled: false },
    { id: 'phase-status', label: description, enabled: false },
    ...(status.task ? [{ label: status.task, enabled: false }] : []),
    { type: 'separator' },
    { label: 'Show timer', click: () => showWindow() },
    { label: status.status === 'running' ? 'Pause' : status.status === 'paused' ? 'Resume' : 'Start',
      enabled: ready && !quitPending, click: () => toggle() },
    { label: 'End session…', enabled: ready && status.status !== 'ready' && !quitPending, click: () => endSession() },
    { type: 'separator' },
    { label: 'Settings…', click: () => showWindow(true) },
    { label: 'Export JSON…', enabled: ready, click: () => send('export') },
    { type: 'separator' },
    { label: 'Quit Practice Timer', click: () => app.quit() },
  ]);
  tray.setContextMenu(trayMenu);
}

function trusted(event) {
  return window && event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame &&
    event.senderFrame.url === `${server.origin}/`;
}
function handle(channel, callback) {
  ipcMain.handle(channel, (event, ...args) => {
    if (!trusted(event)) throw new Error('Untrusted request.');
    return callback(...args);
  });
}

async function start() {
  storage = createStorage(app.getPath('userData'));
  nativeSounds = createNativeSounds();
  try { preferences = storage.readSettings(); }
  catch (error) { throw new Error(`Desktop settings could not be read. Your data was kept. ${error.message}`); }
  for (const target of preferences.targets || []) {
    if (typeof target.fileId === 'string' && typeof target.path === 'string') allowedFiles.set(target.fileId, target.path);
  }
  shortcuts = preferences.shortcuts || shortcuts;
  // A conflict at launch must not prevent the app itself from opening.
  for (const [key, accelerator] of Object.entries(shortcuts)) {
    try { registration[key] = globalShortcut.register(accelerator, shortcutAction(key)); }
    catch { registration[key] = false; }
  }
  server = await serve(ROOT);
  window = new BrowserWindow({
    title: 'Practice Timer', width: 1100, height: 820, minWidth: 360, minHeight: 500,
    show: false, backgroundColor: '#fbf5ef', icon: path.join(ROOT, 'stopwatch-dock-icon-512.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true,
      nodeIntegration: false, sandbox: true, backgroundThrottling: false, spellcheck: false },
  });
  // A monochrome stopwatch remains legible in both light and dark menu bars.
  const icon = nativeImage.createFromPath(path.join(__dirname, 'trayTemplate.png'));
  icon.setTemplateImage(true);
  tray = new Tray(icon);
  refreshTray();
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'Practice Timer', submenu: [
      { label: 'About Practice Timer', role: 'about' }, { type: 'separator' },
      { label: 'Settings…', accelerator: 'CommandOrControl+,', click: () => showWindow(true) },
      { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
      { type: 'separator' }, { label: 'Quit Practice Timer', accelerator: 'CommandOrControl+Q', click: () => app.quit() },
    ] },
    { role: 'editMenu' },
    { label: 'Window', submenu: [{ role: 'minimize' }, { role: 'zoom' },
      { label: 'Close window', accelerator: 'CommandOrControl+W', click: () => window.close() },
      { type: 'separator' }, { label: 'Show timer', click: () => showWindow() }] },
  ]));
  window.on('close', event => { if (!allowQuit) { event.preventDefault(); window.hide(); } });
  window.on('blur', () => setRecording(false));
  window.webContents.on('will-navigate', (event, url) => { if (url !== `${server.origin}/`) event.preventDefault(); });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.session.setPermissionCheckHandler(() => false);
  window.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  window.webContents.on('render-process-gone', () => {
    ready = false; status = { ...status, status: 'paused' }; refreshTray();
    dialog.showErrorBox('Practice Timer stopped', 'Your last saved data was kept. Quit and reopen the app to restore it paused.');
  });
  window.once('ready-to-show', () => showWindow());
  ipcMain.on('desktop:load', event => {
    if (!trusted(event)) { event.returnValue = { ok: false }; return; }
    try { event.returnValue = { ok: true, value: storage.readState() }; }
    catch (error) { event.returnValue = { ok: false, error: error.message }; }
  });
  ipcMain.on('desktop:save', (event, value) => {
    if (!trusted(event)) { event.returnValue = { ok: false }; return; }
    try { storage.writeState(value); event.returnValue = { ok: true }; }
    catch (error) { event.returnValue = { ok: false, error: error.message }; }
  });
  ipcMain.on('desktop:state', (event, next) => {
    if (!trusted(event) || !next || !['ready', 'running', 'paused'].includes(next.status) ||
        !/^\d{1,3}:\d{2}(?::\d{2})?$/.test(next.time)) return;
    const previous = JSON.stringify(status);
    const wasReady = ready;
    status = { status: next.status, phase: next.phase === 'rest' ? 'rest' : 'work', time: next.time,
      task: String(next.task || '').slice(0, 100), canStart: Boolean(next.canStart) };
    ready = true;
    if (!wasReady || previous !== JSON.stringify(status)) refreshTray();
  });
  ipcMain.on('desktop:quit-result', async (event, ok) => {
    if (!trusted(event) || !quitPending) return;
    clearTimeout(quitTimeout);
    if (ok === true) { allowQuit = true; app.quit(); return; }
    quitPending = false;
    showWindow(); refreshTray();
    dialog.showErrorBox('Data could not be saved', 'The app was kept open. Export a JSON backup before quitting.');
  });
  handle('desktop:settings', publicSettings);
  handle('desktop:sounds', () => nativeSounds.list());
  handle('desktop:play-sound', (id, volume, pitch) => nativeSounds.play(id, volume, pitch));
  ipcMain.on('desktop:shortcut-recording', (event, active) => { if (trusted(event)) setRecording(active === true); });
  handle('desktop:shortcuts', next => {
    const previous = { ...shortcuts };
    try {
      setShortcuts(next); preferences.shortcuts = shortcuts; persistPreferences(); refreshTray();
      return { ok: true, ...publicSettings() };
    } catch (error) {
      if (JSON.stringify(shortcuts) !== JSON.stringify(previous)) {
        try { setShortcuts(previous); } catch {}
        preferences.shortcuts = previous;
      }
      return { ok: false, error: error.message, ...publicSettings() };
    }
  });
  ipcMain.on('desktop:notify', (event, phase, minutes) => {
    if (trusted(event) && Notification.isSupported() && ['work', 'rest'].includes(phase) && Number.isFinite(minutes)) {
      new Notification({ title: phase === 'work' ? 'Work started' : 'Break started', body: `${minutes} minutes.`, silent: true }).show();
    }
  });
  handle('desktop:export', async value => {
    checkState(value);
    const { canceled, filePath } = await dialog.showSaveDialog(window, { defaultPath: 'practice-timer.json',
      filters: [{ name: 'Practice Timer JSON', extensions: ['json'] }] });
    if (canceled || !filePath) return false;
    atomicWrite(filePath, value); return true;
  });
  handle('desktop:backup-pick', async () => {
    const { canceled, filePath } = await dialog.showSaveDialog(window, { defaultPath: 'practice-timer.json',
      filters: [{ name: 'Practice Timer JSON', extensions: ['json'] }] });
    if (canceled || !filePath) return null;
    const fileId = [...allowedFiles].find(([, filename]) => filename === filePath)?.[0] || randomUUID();
    allowedFiles.set(fileId, filePath);
    return { fileId, name: path.basename(filePath) };
  });
  handle('desktop:backup-targets', () => (preferences.targets || []).map(({ path: _path, ...target }) => target));
  handle('desktop:backup-remember', targets => {
    if (!Array.isArray(targets)) throw new Error('Invalid destinations.');
    preferences.targets = targets.map(target => ({ id: target.id, label: target.label, baseline: target.baseline,
      savedAt: target.savedAt, fileId: target.fileId, path: checkedFile(target.fileId) }));
    persistPreferences();
  });
  handle('desktop:backup-read', id => readText(checkedFile(id)));
  handle('desktop:backup-write', (id, value, expected) => {
    checkState(value);
    const filename = checkedFile(id);
    if (readText(filename) !== expected) throw new Error('This file changed while saving. Review it and try again.');
    atomicWrite(filename, value);
  });
  powerMonitor.on('suspend', () => { suspendedAt = Date.now(); send('suspend', { at: suspendedAt }); });
  powerMonitor.on('resume', () => { if (suspendedAt !== null) send('suspend', { at: suspendedAt }); suspendedAt = null; });
  await window.loadURL(`${server.origin}/`);
}

app.on('activate', () => showWindow());
app.on('window-all-closed', () => {});
app.on('before-quit', event => {
  if (allowQuit) return;
  if (!ready) { allowQuit = true; return; }
  event.preventDefault();
  if (quitPending) return;
  quitPending = true; refreshTray(); send('quit');
  quitTimeout = setTimeout(() => {
    quitPending = false; showWindow(); refreshTray();
    dialog.showErrorBox('Practice Timer is not responding', 'The app was kept open so that unsaved work is not discarded.');
  }, 10_000);
});
app.on('will-quit', () => { globalShortcut.unregisterAll(); nativeSounds?.stop(); tray?.destroy(); server?.close(); });
