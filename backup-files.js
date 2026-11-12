(function (root) {
'use strict';

const FILE_NAME = 'practice-timer.json';
const DB_NAME = 'practice-timer-backup-files';
const STORE = 'settings';
const IDLE_MS = 120_000;
const MAX_MS = 300_000;

// ファイルハンドルと、最後に確認したファイルのハッシュを同じトランザクションで記憶する。
async function record(value) {
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

function mount({ snapshot, content, canWrite }) {
  const $ = id => document.getElementById(id);
  const supported = typeof root.showSaveFilePicker === 'function' && !!root.indexedDB && !!root.crypto?.subtle;
  let targets = [], auto = true, readyDone = false, busy = false;
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
    if (!readyDone || busy || !auto || !canWrite() || !targets.some(target => !target.issue && target.verified !== observed)) return;
    if (idleTimer !== null) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => writeAll(true), IDLE_MS);
    if (maxTimer === null) maxTimer = setTimeout(() => writeAll(true), MAX_MS);
  }
  function status(target) {
    if (target.issue === 'conflict') return '外部で更新されています。自動保存を停止しました。内容を確認して「保存」を押してください。';
    if (target.issue === 'permission') return 'アクセス再許可が必要です。「保存」を押してください。';
    if (target.issue === 'error') return '保存できませんでした。保存先を確認して「保存」で再試行してください。';
    return target.verified === observed ? '現在の内容を保存済みです。' : '更新待ちです。';
  }
  function refresh() {
    $('backup-add').disabled = !supported || !readyDone || busy || !canWrite();
    $('backup-label').disabled = $('backup-add').disabled;
    $('backup-save').disabled = $('backup-add').disabled || !targets.length;
    $('backup-auto').disabled = !supported || !readyDone || busy;
    $('backup-auto').checked = auto;
    const saved = targets.filter(target => !target.issue && target.verified === observed).length;
    $('backup-auto-status').textContent = !supported
      ? 'このブラウザでは保存先への自動保存を利用できません。JSONをダウンロードしてください。'
      : !canWrite() ? 'ブラウザの保存データを読めないため、JSONへの保存を停止しています。バックアップを読み込んで復元してください。'
      : !targets.length ? '保存先を追加すると自動保存できます。'
      : `${targets.length}件中${saved}件を保存済みです。` + (busy ? ' 保存中です。' : auto ? '' : ' 自動保存はオフです。') +
        (remembered ? '' : ' 保存先の設定を記憶できません。次回は再設定が必要な場合があります。');
    for (const target of targets) {
      const detail = details.get(target.id);
      if (!detail) continue;
      detail.text.textContent = status(target) + (target.savedAt ? ` 最終保存：${new Date(target.savedAt).toLocaleString('ja-JP')}` : '');
      for (const button of detail.buttons) button.disabled = busy || !canWrite();
    }
  }
  function renderTargets() {
    const list = $('backup-targets');
    list.replaceChildren(); details.clear();
    for (const target of targets) {
      const card = document.createElement('div'); card.className = 'backup-target';
      const title = document.createElement('strong'); title.textContent = target.label;
      const file = document.createElement('p'); file.className = 'subtle'; file.textContent = target.handle.name;
      const text = document.createElement('p'); text.className = 'subtle';
      const actions = document.createElement('div'); actions.className = 'backup-actions';
      const buttons = [
        ['保存', () => writeAll(false, [target.id])],
        ['変更', () => choose(target.id)],
        ['解除', () => remove(target.id)],
      ].map(([label, action]) => {
        const button = document.createElement('button'); button.type = 'button'; button.textContent = label;
        button.addEventListener('click', action); actions.append(button); return button;
      });
      card.append(title, file, text, actions); list.append(card);
      details.set(target.id, { text, buttons });
    }
    refresh();
  }
  async function remember() {
    try {
      await record({ auto, targets: targets.map(({ id, label, handle, baseline, savedAt }) => ({ id, label, handle, baseline, savedAt })) });
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
      if (diskHash !== target.baseline && (automatic || !confirm(`「${target.label}」のJSONは外部で更新されています。現在の練習タイマーの内容で上書きしますか？`))) {
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
          else message('別のタブで保存中です。少し後で再試行します。');
        });
      } else await operation();
    } catch { message('JSONを保存できませんでした。保存先を確認してください。'); }
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
      const handle = await root.showSaveFilePicker({
        id: 'practice-timer-json', suggestedName: FILE_NAME,
        types: [{ description: '練習タイマーJSON', accept: { 'application/json': ['.json'] } }],
      });
      if (handle.name !== FILE_NAME) { message(`ファイル名は ${FILE_NAME} にしてください。`); return; }
      for (const target of targets) {
        if (target.id !== replaceId && await target.handle.isSameEntry(handle)) {
          message('このファイルは既に登録されています。'); return;
        }
      }
      if (!await permit(handle, false)) { message('ファイルへの書き込みが許可されませんでした。'); return; }
      const disk = await (await handle.getFile()).text();
      let same = false;
      try { same = JSON.stringify(JSON.parse(disk)) === content(); } catch {}
      if (disk && !same && !confirm('選んだJSONには別の内容があります。現在のタスク・時間・テーマ・各設定で上書きしますか？')) return;
      const old = targets.find(target => target.id === replaceId);
      const target = { id: old?.id || root.crypto.randomUUID(),
        label: old?.label || $('backup-label').value.trim() || `保存先${targets.length + 1}`,
        handle, baseline: await hash(disk), savedAt: null, verified: null, issue: null };
      if (old) targets[targets.indexOf(old)] = target;
      else { targets.push(target); $('backup-label').value = ''; }
      nextId = target.id;
      await remember(); renderTargets(); message('');
    } catch (error) {
      if (error?.name !== 'AbortError') message('保存先を設定できませんでした。アクセス権と保存先を確認してください。');
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
    message('保存先の登録を解除しました。ファイルは削除していません。' + (saved ? '' : ' 設定を記憶できなかったため、次回も表示される場合は再度解除してください。'));
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
  $('backup-save').addEventListener('click', () => writeAll());
  $('backup-auto').addEventListener('change', async () => {
    if (busy) return;
    busy = true;
    auto = $('backup-auto').checked;
    clearTimers(); refresh();
    await remember();
    busy = false; refresh();
    if (auto) schedule();
  });
  const ready = (async () => {
    if (supported) {
      try {
        const saved = await record();
        auto = saved?.auto !== false;
        targets = (Array.isArray(saved?.targets) ? saved.targets : []).filter(target =>
          target?.handle?.kind === 'file' && target.handle.name === FILE_NAME && typeof target.baseline === 'string')
          .map(target => ({ ...target, verified: null, issue: null }));
      } catch { message('保存先の設定を読み込めませんでした。保存先を追加し直してください。'); }
    }
    readyDone = true; renderTargets();
    if (auto) await writeAll(true);
  })();
  refresh();
  return { changed, ready };
}

root.PracticeBackupFiles = { mount };
})(globalThis);
