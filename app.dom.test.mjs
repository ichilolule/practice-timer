import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

class Element {
  constructor(tagName = 'div') {
    this.tagName = tagName;
    this.children = [];
    this.listeners = new Map();
    this.hidden = false;
    this.disabled = false;
    this.value = '';
    this.textContent = '';
    this.classList = { toggle() {} };
  }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  addEventListener(type, handler) { this.listeners.set(type, handler); }
  setAttribute() {}
  removeAttribute() {}
  focus() {}
  click() {}
  remove() {}
  reset() { for (const child of this.children) { child.value = ''; child.reset(); } }
  async trigger(type) { return this.listeners.get(type)?.({ preventDefault() {} }); }
  get lastElementChild() { return this.children.at(-1); }
  querySelector(tag) {
    for (const child of this.children) {
      if (child.tagName === tag) return child;
      const found = child.querySelector(tag);
      if (found) return found;
    }
    return null;
  }
}

function mount(storage = new Map()) {
  const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
  const elements = new Map([...html.matchAll(/id="([^"]+)"/g)].map((match) => [match[1], new Element()]));
  const document = {
    getElementById: (id) => elements.get(id),
    createElement: (tag) => new Element(tag),
    body: new Element('body'),
  };
  let now = 1_000_000;
  let exportedBlob = null;
  const FakeDate = class extends Date { static now() { return now; } };
  const context = vm.createContext({
    document,
    localStorage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
    },
    window: { AudioContext: class { constructor() { throw new Error('audio unavailable'); } } },
    addEventListener() {},
    setInterval() {},
    setTimeout() {},
    confirm: () => true,
    prompt: () => null,
    Blob,
    URL: { createObjectURL(blob) { exportedBlob = blob; return 'blob:test'; }, revokeObjectURL() {} },
    Date: FakeDate,
  });
  for (const file of ['timer-core.js', 'practice-data.js', 'app.js']) {
    vm.runInContext(readFileSync(new URL(`./${file}`, import.meta.url), 'utf8'), context);
  }
  return { elements, storage, advance(ms) { now += ms; }, get exportedBlob() { return exportedBlob; } };
}

test('HTMLを直接開く構成で追加・保存・開始・次へが動く', async () => {
  const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
  assert.match(html, /<script defer src="timer-core\.js"><\/script>/);
  assert.match(html, /<script defer src="practice-data\.js"><\/script>/);
  assert.match(html, /<script defer src="app\.js"><\/script>/);
  assert.doesNotMatch(html, /type="module"/);
  assert.match(html, /class="beta">beta<\/span>/);
  assert.doesNotMatch(html, /id="sound-test"/);

  const { elements, storage } = mount();

  assert.equal(elements.get('timer-view').hidden, false);
  await elements.get('settings-toggle').trigger('click');
  assert.equal(elements.get('settings-view').hidden, false);
  assert.equal(elements.get('permission').hidden, false);
  await elements.get('add-step').trigger('click');
  const workRow = elements.get('step-list').children[0];
  const workType = workRow.querySelector('select');
  const workTime = workRow.querySelector('input');
  workType.value = 'work';
  workType.trigger('change');
  workTime.value = '0.1';
  workTime.trigger('input');

  await elements.get('add-step').trigger('click');
  const restRow = elements.get('step-list').children[1];
  const restType = restRow.querySelector('select');
  const restTime = restRow.querySelector('input');
  restType.value = 'rest';
  restType.trigger('change');
  restTime.value = '0.1';
  restTime.trigger('input');

  await elements.get('save-settings').trigger('click');
  assert.equal(elements.get('timer-view').hidden, false);
  assert.equal(elements.get('main-action').disabled, false);
  const startClick = elements.get('main-action').trigger('click');
  assert.equal(elements.get('phase-name').textContent, '作業');
  assert.equal(elements.get('main-action').textContent, '一時停止');
  const pauseClick = elements.get('main-action').trigger('click');
  assert.equal(elements.get('main-action').textContent, '再開');
  const resumeClick = elements.get('main-action').trigger('click');
  assert.equal(elements.get('main-action').textContent, '一時停止');
  await Promise.all([startClick, pauseClick, resumeClick]);
  await elements.get('skip').trigger('click');
  assert.equal(elements.get('phase-name').textContent, '休憩');
  assert.ok(storage.has('practice-timer-v1'));
});

test('タスクの後選択、未分類の再割り当て、文字JSONの保存・読み込み', async () => {
  const storage = new Map([['practice-timer-v1', JSON.stringify({
    steps: [{ type: 'work', minutes: 0.1 }, { type: 'rest', minutes: 0.1 }], totalWorkMs: 0,
  })]]);
  const app = mount(storage);
  const { elements } = app;
  await elements.get('nav-growth').trigger('click');
  elements.get('group-title').value = '人体';
  await elements.get('group-form').trigger('submit');
  const childForm = elements.get('group-list').children[0].querySelector('form');
  childForm.querySelector('input').value = '手';
  await childForm.trigger('submit');
  const savedGroups = JSON.parse(storage.get('practice-timer-v1')).groups;
  const handId = savedGroups[0].children[0].id;

  await elements.get('nav-tasks').trigger('click');
  elements.get('task-title').value = '手を描く';
  elements.get('task-first-step').value = '指を3案描く';
  elements.get('task-target').value = handId;
  await elements.get('task-form').trigger('submit');
  const taskId = JSON.parse(storage.get('practice-timer-v1')).tasks[0].id;

  await elements.get('nav-timer').trigger('click');
  await elements.get('main-action').trigger('click');
  elements.get('active-task').value = taskId;
  await elements.get('active-task').trigger('change');
  assert.equal(elements.get('active-task').disabled, true);
  app.advance(3000);
  await elements.get('end').trigger('click');
  let saved = JSON.parse(storage.get('practice-timer-v1'));
  assert.equal(saved.sessions[0].workMs, 3000);
  assert.equal(saved.sessions[0].targetId, handId);

  await elements.get('main-action').trigger('click');
  app.advance(2000);
  await elements.get('end').trigger('click');
  await elements.get('nav-growth').trigger('click');
  assert.equal(elements.get('unclassified-list').children.length, 1);
  const unclassified = elements.get('unclassified-list').children[0];
  unclassified.children[1].value = taskId;
  await unclassified.children[2].trigger('click');
  saved = JSON.parse(storage.get('practice-timer-v1'));
  assert.equal(saved.sessions[1].targetId, handId);
  assert.equal(saved.totalWorkMs, 5000);
  const record = elements.get('session-list').children[0];
  record.querySelector('select').value = handId;
  record.querySelector('input').value = '指の角度が硬い';
  await record.children.at(-1).trigger('click');
  saved = JSON.parse(storage.get('practice-timer-v1'));
  assert.equal(saved.sessions[1].note, '指の角度が硬い');

  await elements.get('nav-timer').trigger('click');
  await elements.get('settings-toggle').trigger('click');
  await elements.get('export-data').trigger('click');
  const backup = JSON.parse(await app.exportedBlob.text());
  assert.equal(backup.format, 'practice-timer-beta');
  assert.equal(backup.sessions.length, 2);
  assert.equal(JSON.stringify(backup).includes('data:image'), false);
  elements.get('import-file').files = [{ size: app.exportedBlob.size, text: () => app.exportedBlob.text() }];
  await elements.get('import-file').trigger('change');
  assert.match(elements.get('backup-status').textContent, /読み込みました/);
  assert.equal(elements.get('status').textContent, 'JSONを読み込みました。');
  const beforeInvalidImport = storage.get('practice-timer-v1');
  elements.get('import-file').files = [{ size: 20, text: async () => '{"format":"wrong"}' }];
  await elements.get('import-file').trigger('change');
  assert.match(elements.get('backup-status').textContent, /中止しました/);
  assert.equal(storage.get('practice-timer-v1'), beforeInvalidImport);
});

test('既存タイマーの累計は未分類記録として一度だけ引き継ぐ', async () => {
  const storage = new Map([['practice-timer-v1', JSON.stringify({
    steps: [{ type: 'work', minutes: 5 }, { type: 'rest', minutes: 3 }], totalWorkMs: 120000,
  })]]);
  const first = mount(storage);
  await first.elements.get('nav-growth').trigger('click');
  assert.equal(first.elements.get('unclassified-list').children.length, 1);
  first.elements.get('group-title').value = '練習';
  await first.elements.get('group-form').trigger('submit');
  assert.equal(JSON.parse(storage.get('practice-timer-v1')).sessions.length, 1);
  const second = mount(storage);
  await second.elements.get('nav-growth').trigger('click');
  assert.equal(second.elements.get('unclassified-list').children.length, 1);
});
