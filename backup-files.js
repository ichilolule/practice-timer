(function (root) {
'use strict';

const FILE_NAME = 'practice-timer.json';
const DB_NAME = 'practice-timer-backup-files';
const STORE = 'settings';
const IDLE_MS = 120_000;
const MAX_MS = 300_000;
const desktop = root.practiceDesktop;

function desktopHandle({ fileId, name = FILE_NAME }) {
  let expected = '';
  return { kind: 'file', name, fileId,
    queryPermission: async () => 'granted', requestPermission: async () => 'granted',
    isSameEntry: async other => other.fileId === fileId,
    getFile: async () => {
      const text = await desktop.readBackup(fileId);
      expected = text;
      return { text: async () => text };
    },
    createWritable: async () => {
      let text;
      return { write: async value => { text = value; },
        close: async () => { await desktop.writeBackup(fileId, text, expected); expected = text; }, abort: async () => {} };
    },
  };
}

// ファイルハンドルと、最後に確認したファイルのハッシュを同じトランザクションで記憶する。
async function record(value) {
  if (desktop) {
    if (value === undefined) return { targets: (await desktop.readBackupTargets()).map(target => ({ ...target, handle: desktopHandle(target) })) };
    await desktop.writeBackupTargets(value.targets.map(({ handle, ...target }) => ({ ...target, fileId: handle.fileId })));
    return;
  }
  const database = await new Promise((resolve, reject) => {
    const request = root.indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE, value === undefined ? 'readonly' : 'readwrite');
      const store = transaction.objectStore(STORE);
      const request = value === undefined ? store.get('destinations') : store.put(value, 'destinations');
      transaction.oncomplete = () => resolve(request.result);
      transaction.onerror = transaction.onabort = () => reject(transaction.error);
    });
  } finally { database.close(); }
}

async function hash(text) {
  const digest = await root.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('');
}

function mount({ snapshot, content, canWrite, download }) {
  const $ = id => document.getElementById(id);
  const supported = (!!desktop || (typeof root.showSaveFilePicker === 'function' && !!root.indexedDB)) && !!root.crypto?.subtle;
  let targets = [], readyDone = false, busy = false;
  let idleTimer = null, maxTimer = null, observed = content(), remembered = true;
  let wasWritable = canWrite();
  const details = new Map();

  function message(text) { $('backup-file-message').textContent = text; }
  function clearTimers() {
    if (idleTimer !== null) clearTimeout(idleTimer);
    if (maxTimer !== null) clearTimeout(maxTimer);
    idleTimer = maxTimer = null;
  }
  function schedule() {
    if (!readyDone || busy || !canWrite() || !targets.some(target => !target.issue && target.verified !== observed)) return;
    if (idleTimer !== null) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => writeAll(true), IDLE_MS);
    if (maxTimer === null) maxTimer = setTimeout(() => writeAll(true), MAX_MS);
  }
  function status(target) {
    if (target.issue === 'conflict') return 'This file changed elsewhere. Autosave paused. Review it, then choose Save.';
    if (target.issue === 'permission') return 'File access needs to be renewed. Choose Save.';
    if (target.issue === 'error') return 'Could not save. Check the destination and choose Save to try again.';
    return target.verified === observed ? 'Up to date.' : 'Changes pending.';
  }
  function refresh() {
    $('backup-add').disabled = !supported || !readyDone || busy || !canWrite();
    $('backup-label').disabled = $('backup-add').disabled;
    $('backup-save').disabled = !readyDone || busy || !canWrite();
    const saved = targets.filter(target => !target.issue && target.verified === observed).length;
    $('backup-auto-status').textContent = !canWrite()
      ? `File saving is paused because ${desktop ? 'saved' : 'browser'} data could not be read. Import a backup to restore your data.`
      : !supported ? 'File autosave is not available in this browser. Save now downloads a JSON backup.'
      : !targets.length ? 'Add a backup destination to enable autosave.'
      : `${saved} of ${targets.length} destinations saved.` + (busy ? ' Saving…' : '') +
        (remembered ? '' : ' Backup destinations could not be remembered. You may need to add them again next time.');
    for (const target of targets) {
      const detail = details.get(target.id);
      if (!detail) continue;
      detail.text.textContent = target.issue === 'conflict' ? 'Changed elsewhere' : target.issue === 'permission' ? 'Needs access'
        : target.issue === 'error' ? 'Save failed' : target.verified === observed ? '✓ Saved' : 'Pending';
      detail.text.className = `backup-target-status${target.issue ? ' has-issue' : ''}`;
      detail.info.textContent = status(target) + (target.savedAt ? ` Last saved: ${new Date(target.savedAt).toLocaleString('en-US')}` : '');
      for (const button of detail.buttons) button.disabled = busy || !canWrite();
    }
  }
  function renderTargets() {
    const list = $('backup-targets');
    list.replaceChildren(); details.clear();
    for (const target of targets) {
      const card = document.createElement('div'); card.className = 'backup-target';
      const title = document.createElement('strong'); title.textContent = target.label;
      const file = document.createElement('p'); file.className = 'sr-only'; file.textContent = target.handle.name;
      const text = document.createElement('p'); text.className = 'backup-target-status';
      const menu = document.createElement('details'); menu.className = 'backup-target-menu';
      const toggle = document.createElement('summary'); toggle.textContent = '•••';
      toggle.title = `Manage ${target.label}`;
      const info = document.createElement('p'); info.className = 'subtle';
      const actions = document.createElement('div'); actions.className = 'backup-actions';
      menu.append(toggle, info, actions);
      const buttons = [
        ['Save', () => writeAll(false, [target.id])],
        ['Change', () => choose(target.id)],
        ['Remove', () => remove(target.id)],
      ].map(([label, action]) => {
        const button = document.createElement('button'); button.type = 'button'; button.textContent = label;
        button.addEventListener('click', action); actions.append(button); return button;
      });
      card.append(title, file, text, menu); list.append(card);
      details.set(target.id, { text, info, buttons });
    }
    refresh();
  }
  async function remember() {
    try {
      await record({ auto: true, targets: targets.map(({ id, label, handle, baseline, savedAt }) => ({ id, label, handle, baseline, savedAt })) });
      remembered = true;
    } catch { remembered = false; }
    return remembered;
  }
  async function permit(handle, automatic) {
    let permission = await handle.queryPermission({ mode: 'readwrite' });
    if (permission !== 'granted' && !automatic) permission = await handle.requestPermission({ mode: 'readwrite' });
    return permission === 'granted';
  }
  async function writeOne(target, value, serialized, automatic) {
    if (automatic && target.issue) return;
    try {
      if (!await permit(target.handle, automatic)) { target.issue = 'permission'; return; }
      const disk = await (await target.handle.getFile()).text();
      const diskHash = await hash(disk);
      // 同一データなら外部の整形や、保存途中の再読み込みでも無用な上書きをしない。
      let same = false;
      try { same = JSON.stringify(JSON.parse(disk)) === JSON.stringify(value); } catch {}
      if (same) { target.baseline = diskHash; target.verified = JSON.stringify(value); target.issue = null; return; }
      if (diskHash !== target.baseline && (automatic || !confirm(`The JSON for “${target.label}” changed elsewhere. Overwrite it with the current Practice timer data?`))) {
        target.issue = 'conflict'; return;
      }
      const writable = await target.handle.createWritable();
      try { await writable.write(serialized); await writable.close(); }
      catch (error) { await writable.abort?.().catch(() => {}); throw error; }
      target.baseline = await hash(serialized);
      target.savedAt = Date.now(); target.verified = JSON.stringify(value); target.issue = null;
    } catch { target.issue = 'error'; }
  }
  async function writeAll(automatic = false, ids = null) {
    if (!readyDone || busy || !canWrite()) return;
    clearTimers();
    const selected = targets.filter(target => (!ids || ids.includes(target.id)) && (!automatic || !target.issue));
    if (!selected.length) return;
    busy = true; message(''); refresh();
    try {
      const operation = async () => {
        // 計測中の時間も含め、全保存先へ同じ時点のデータを書き出す。
        const value = JSON.parse(JSON.stringify(snapshot()));
        observed = content();
        const serialized = JSON.stringify(value, null, 2);
        for (const target of selected) await writeOne(target, value, serialized, automatic);
        await remember();
      };
      if (root.navigator?.locks) {
        await root.navigator.locks.request('practice-timer-backup-files', { ifAvailable: true }, async lock => {
          if (lock) await operation();
          else message('Another tab is saving. Will try again shortly.');
        });
      } else await operation();
    } catch { message('Could not save JSON. Check the destination.'); }
    finally {
      busy = false; refresh();
      // 書き込み中の編集を次の保存へ引き継ぐ。エラーのある保存先は明示的な再試行を待つ。
      schedule();
    }
  }
  async function choose(replaceId = null) {
    if (!supported || !readyDone || busy || !canWrite()) return;
    clearTimers();
    busy = true; refresh();
    let nextId = null;
    try {
      const picked = desktop ? await desktop.pickBackup() : null;
      if (desktop && !picked) return;
      const handle = desktop ? desktopHandle(picked) : await root.showSaveFilePicker({
        id: 'practice-timer-json', suggestedName: FILE_NAME,
        types: [{ description: 'Practice timer JSON', accept: { 'application/json': ['.json'] } }],
      });
      if (handle.name !== FILE_NAME) { message(`Use the filename ${FILE_NAME}.`); return; }
      for (const target of targets) {
        if (target.id !== replaceId && await target.handle.isSameEntry(handle)) {
          message('This file is already registered.'); return;
        }
      }
      if (!await permit(handle, false)) { message('Permission to write this file was not granted.'); return; }
      const disk = await (await handle.getFile()).text();
      let same = false;
      try { same = JSON.stringify(JSON.parse(disk)) === content(); } catch {}
      if (disk && !same && !confirm('This JSON contains different data. Overwrite it with your current tasks, time, themes and settings?')) return;
      const old = targets.find(target => target.id === replaceId);
      const target = { id: old?.id || root.crypto.randomUUID(),
        label: old?.label || $('backup-label').value.trim() || `Backup ${targets.length + 1}`,
        handle, baseline: await hash(disk), savedAt: null, verified: null, issue: null };
      if (old) targets[targets.indexOf(old)] = target;
      else { targets.push(target); $('backup-label').value = ''; }
      nextId = target.id;
      await remember(); renderTargets(); message('');
    } catch (error) {
      if (error?.name !== 'AbortError') message('Could not add a backup destination. Check access and the destination.');
    } finally { busy = false; refresh(); schedule(); }
    if (nextId) await writeAll(false, [nextId]);
  }
  async function remove(id) {
    if (busy) return;
    clearTimers();
    busy = true; refresh();
    targets = targets.filter(target => target.id !== id);
    const saved = await remember();
    busy = false; renderTargets();
    message('Backup destination removed. The file was kept.' + (saved ? '' : ' This change could not be remembered. Remove the destination again if it reappears.'));
    schedule();
  }
  function changed(next) {
    const resumed = !wasWritable && canWrite();
    wasWritable = canWrite();
    if (observed === next && !resumed) return;
    observed = next;
    refresh();
    if (!busy) schedule();
  }

  $('backup-add').addEventListener('click', () => choose());
  async function saveNow() {
    if (!readyDone || busy || !canWrite()) return;
    if (!supported || !targets.length) { download?.(); return; }
    await writeAll();
  }
  $('backup-save').addEventListener('click', saveNow);
  const ready = (async () => {
    if (supported) {
      try {
        const saved = await record();
        targets = (Array.isArray(saved?.targets) ? saved.targets : []).filter(target =>
          target?.handle?.kind === 'file' && target.handle.name === FILE_NAME && typeof target.baseline === 'string')
          .map(target => ({ ...target, verified: null, issue: null }));
      } catch { message('Could not load backup destinations. Please add them again.'); }
    }
    readyDone = true; renderTargets();
    await writeAll(true);
  })();
  refresh();
  return { changed, ready, saveNow };
}

root.PracticeBackupFiles = { mount };
})(globalThis);
