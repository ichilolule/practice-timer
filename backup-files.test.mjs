import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

class Element {
  children = [];
  listeners = new Map();
  value = '';
  checked = true;
  textContent = '';
  append(...children) { this.children.push(...children); }
  replaceChildren() { this.children = []; }
  addEventListener(type, callback) { this.listeners.set(type, callback); }
  async trigger(type = 'click') { return this.listeners.get(type)?.(); }
}

function database() {
  const state = { value: undefined, fail: false };
  state.open = () => {
    const request = {};
    queueMicrotask(() => {
      request.result = {
        close() {},
        transaction() {
          const transaction = {
            objectStore() {
              function operation(value, writing) {
                const result = {};
                queueMicrotask(() => {
                  if (state.fail) { transaction.error = new Error('storage blocked'); transaction.onabort(); return; }
                  if (writing) state.value = value;
                  else result.result = state.value;
                  transaction.oncomplete();
                });
                return result;
              }
              return { get: () => operation(null, false), put: value => operation(value, true) };
            },
          };
          return transaction;
        },
      };
      request.onsuccess();
    });
    return request;
  };
  return state;
}

function file() {
  return {
    kind: 'file', name: 'practice-timer.json', text: '', writes: [], prompts: 0, access: 'granted',
    async isSameEntry(other) { return this === other; },
    async queryPermission() { return this.access; },
    async requestPermission() { this.prompts++; return this.access = 'granted'; },
    async getFile() { return { text: async () => this.text }; },
    async createWritable() {
      if (this.fail) throw new Error('disk unavailable');
      let next;
      return { write: async text => { next = text; await this.onWrite?.(); },
        close: async () => { this.text = next; this.writes.push(next); }, abort: async () => {} };
    },
  };
}

async function mount({ db = database(), initial = { tasks: [], run: null }, supported = true, readable = true, locks } = {}) {
  const elements = new Map(['backup-file-message', 'backup-add', 'backup-save', 'backup-label', 'backup-auto', 'backup-auto-status', 'backup-targets']
    .map(id => [id, new Element()]));
  let value = initial, nextFile, accept = true, now = 1_000_000, nextTimer = 0;
  const timers = new Map();
  const context = vm.createContext({
    document: { getElementById: id => elements.get(id), createElement: () => new Element() },
    crypto: webcrypto, TextEncoder, indexedDB: supported ? db : undefined,
    navigator: { locks },
    showSaveFilePicker: supported ? async () => {
      if (nextFile instanceof Error) throw nextFile;
      return nextFile;
    } : undefined,
    confirm: () => accept,
    Date: class extends Date { static now() { return now; } },
    setTimeout(callback, delay) { const id = ++nextTimer; timers.set(id, { at: now + delay, callback }); return id; },
    clearTimeout(id) { timers.delete(id); },
  });
  vm.runInContext(readFileSync(new URL('./backup-files.js', import.meta.url), 'utf8'), context);
  const controller = context.PracticeBackupFiles.mount({ snapshot: () => value, content: () => JSON.stringify(value), canWrite: () => readable });
  await controller.ready;
  return {
    elements, db, controller,
    get status() { return elements.get('backup-auto-status').textContent; },
    get message() { return elements.get('backup-file-message').textContent; },
    get cards() { return elements.get('backup-targets').children; },
    get value() { return value; },
    set accept(value) { accept = value; },
    async add(handle, name = '') { nextFile = handle; elements.get('backup-label').value = name; await elements.get('backup-add').trigger(); },
    async auto(enabled) { elements.get('backup-auto').checked = enabled; await elements.get('backup-auto').trigger('change'); },
    edit(next) { value = next; controller.changed(JSON.stringify(next)); },
    async advance(ms) {
      now += ms;
      for (const [id, timer] of [...timers]) if (timers.has(id) && timer.at <= now) { timers.delete(id); await timer.callback(); }
    },
  };
}

test('複数保存先を同じJSONで更新し、変更が止まって2分後に自動保存する', async () => {
  const app = await mount();
  const first = file(), second = file();
  await app.add(first, 'iCloud Drive'); await app.add(second, '別の保存先');
  assert.equal(app.cards.length, 2);
  assert.equal(first.writes.length, 1);
  app.edit({ tasks: [{ title: '人体' }], run: null });
  await app.advance(119_999);
  assert.equal(first.writes.length, 1);
  await app.advance(1);
  assert.equal(first.text, second.text);
  assert.equal(JSON.parse(first.text).tasks[0].title, '人体');
  assert.match(app.status, /2件中2件を保存済み/);
});

test('計測中など変更が続いても5分で保存し、書き込み中の変更も次回へ引き継ぐ', async () => {
  const app = await mount(); const handle = file(); await app.add(handle);
  for (let i = 1; i <= 300; i++) {
    app.edit({ tasks: [], run: { remainingMs: 600_000 - i * 1000, status: 'paused' } });
    await app.advance(1000);
  }
  assert.equal(handle.writes.length, 2);
  assert.equal(JSON.parse(handle.text).run.remainingMs, 300_000);
  handle.onWrite = () => { app.edit({ tasks: [{ title: '保存中の編集' }], run: null }); handle.onWrite = null; };
  app.edit({ tasks: [{ title: '保存開始時' }], run: null });
  await app.advance(120_000);
  assert.match(app.status, /1件中0件/);
  await app.advance(120_000);
  assert.equal(JSON.parse(handle.text).tasks[0].title, '保存中の編集');
});

test('外部変更を自動上書きせず、その保存先だけ停止し、手動保存で確認する', async () => {
  const app = await mount(); const first = file(), second = file();
  await app.add(first); await app.add(second);
  first.text = '{"external":true}';
  app.edit({ tasks: [{ title: '色塗り' }], run: null });
  await app.advance(120_000);
  assert.equal(first.text, '{"external":true}');
  assert.equal(JSON.parse(second.text).tasks[0].title, '色塗り');
  assert.match(app.cards[0].children[2].textContent, /外部で更新/);
  app.accept = false;
  await app.cards[0].children[3].children[0].trigger();
  assert.equal(first.writes.length, 1);
  app.accept = true;
  await app.cards[0].children[3].children[0].trigger();
  assert.equal(first.text, second.text);
  assert.match(app.status, /2件中2件/);
});

test('再起動後は保存先を復元し、権限切れでは自動の許可要求をせず手動保存で再許可する', async () => {
  const app = await mount(); const handle = file(); await app.add(handle);
  handle.access = 'prompt';
  const restored = await mount({ db: app.db, initial: { tasks: ['new'], run: null } });
  assert.equal(restored.cards.length, 1);
  assert.equal(handle.prompts, 0);
  assert.equal(handle.writes.length, 1);
  assert.match(restored.cards[0].children[2].textContent, /再許可/);
  await restored.elements.get('backup-save').trigger();
  assert.equal(handle.prompts, 1);
  assert.deepEqual(JSON.parse(handle.text).tasks, ['new']);
});

test('自動保存のオフと解除を記憶し、解除してもファイルは残す', async () => {
  const app = await mount(); const handle = file(); await app.add(handle); await app.auto(false);
  app.edit({ tasks: ['変更'], run: null }); await app.advance(600_000);
  assert.equal(handle.writes.length, 1);
  const restored = await mount({ db: app.db });
  assert.equal(restored.elements.get('backup-auto').checked, false);
  await restored.cards[0].children[3].children[2].trigger();
  assert.equal(restored.cards.length, 0);
  assert.ok(handle.text.length);
  assert.equal((await mount({ db: app.db })).cards.length, 0);
});

test('選択キャンセル・重複・既存内容の上書き辞退で登録を増やさない', async () => {
  const app = await mount(); const handle = file(); await app.add(handle);
  const cancel = new Error(); cancel.name = 'AbortError'; await app.add(cancel);
  await app.add(handle);
  assert.match(app.message, /既に登録/);
  const other = file(); other.text = '{"old":true}'; app.accept = false; await app.add(other);
  assert.equal(app.cards.length, 1);
  assert.equal(other.writes.length, 0);
  assert.equal(other.text, '{"old":true}');
});

test('保存先の記憶に失敗してもJSONを書き出し、保存先の一部失敗でもほかへ保存する', async () => {
  const app = await mount(); const first = file(), second = file();
  await app.add(first); app.db.fail = true; await app.add(second);
  assert.match(app.status, /設定を記憶できません/);
  assert.equal(second.writes.length, 1);
  first.fail = true;
  app.edit({ tasks: ['次の内容'], run: null }); await app.advance(120_000);
  assert.match(app.cards[0].children[2].textContent, /保存できません/);
  assert.deepEqual(JSON.parse(second.text).tasks, ['次の内容']);
});

test('非対応ブラウザと読めないローカルデータでは直接保存を無効にする', async () => {
  const unsupported = await mount({ supported: false });
  assert.equal(unsupported.elements.get('backup-add').disabled, true);
  assert.match(unsupported.status, /ダウンロード/);
  const app = await mount(); const handle = file(); await app.add(handle);
  const unreadable = await mount({ db: app.db, readable: false });
  assert.equal(unreadable.elements.get('backup-save').disabled, true);
  assert.match(unreadable.status, /保存を停止/);
  assert.equal(handle.writes.length, 1);
});

test('別タブが保存中なら上書きせず、後の保存で再試行する', async () => {
  let locked = false;
  const app = await mount({ locks: { request: async (_name, _options, callback) => callback(locked ? null : {}) } });
  const handle = file(); await app.add(handle);
  locked = true; app.edit({ tasks: ['別タブ確認'], run: null }); await app.advance(120_000);
  assert.equal(handle.writes.length, 1);
  locked = false; await app.advance(120_000);
  assert.deepEqual(JSON.parse(handle.text).tasks, ['別タブ確認']);
});
