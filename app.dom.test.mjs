import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

class Element {
  constructor(tagName = 'div') {
    this.tagName = tagName;
    this.children = [];
    this.listeners = new Map();
    this.attributes = new Map();
    this.hidden = false;
    this.disabled = false;
    this.open = false;
    this.value = '';
    this.textContent = '';
    this.style = {};
    this.classList = { toggle() {} };
  }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  addEventListener(type, handler) { this.listeners.set(type, handler); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  removeAttribute(name) { this.attributes.delete(name); }
  focus() {}
  click() {}
  remove() {}
  showModal() { this.open = true; }
  close() { this.open = false; }
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

function mount(storage = new Map(), AudioContext = class { constructor() { throw new Error('audio unavailable'); } }, initialNow = 1_000_000) {
  const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
  const elements = new Map([...html.matchAll(/id="([^"]+)"/g)].map((match) => [match[1], new Element()]));
  const document = {
    getElementById: (id) => elements.get(id),
    createElement: (tag) => new Element(tag),
    body: new Element('body'),
  };
  let now = initialNow;
  let exportedBlob = null;
  const timeouts = [];
  const FakeDate = class extends Date { static now() { return now; } };
  const context = vm.createContext({
    document,
    localStorage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
    },
    window: { AudioContext },
    addEventListener() {},
    setInterval() {},
    setTimeout(callback) { timeouts.push(callback); },
    confirm: () => true,
    prompt: () => null,
    Blob,
    URL: { createObjectURL(blob) { exportedBlob = blob; return 'blob:test'; }, revokeObjectURL() {} },
    Date: FakeDate,
  });
  for (const file of ['timer-core.js', 'practice-data.js', 'app.js']) {
    vm.runInContext(readFileSync(new URL(`./${file}`, import.meta.url), 'utf8'), context);
  }
  return { elements, storage, advance(ms) { now += ms; },
    flushTimeouts() { for (const callback of timeouts.splice(0)) callback(); },
    get exportedBlob() { return exportedBlob; } };
}

function recordAudio() {
  const notes = [];
  const gains = [];
  class AudioContext {
    constructor() { this.state = 'running'; this.currentTime = 0; this.destination = {}; }
    async resume() {}
    createOscillator() {
      const note = { frequency: { value: 0 }, connect() { return this; },
        start(at) { this.startedAt = at; }, stop(at) { this.stoppedAt = at; } };
      notes.push(note);
      return note;
    }
    createGain() {
      const events = [];
      gains.push(events);
      return { connect() {}, gain: {
        setValueAtTime(value, at) { events.push({ value, at }); },
        exponentialRampToValueAtTime(value, at) { events.push({ value, at }); },
      } };
    }
  }
  return { AudioContext, notes, gains };
}

test('通知音の音量・高さを共通設定し、休憩音を1.3倍速で試聴できる', async () => {
  const audio = recordAudio();
  const app = mount(new Map(), audio.AudioContext);
  const { elements } = app;
  await elements.get('settings-toggle').trigger('click');
  elements.get('sound-volume').value = '10';
  await elements.get('sound-volume').trigger('input');
  await elements.get('sound-volume').trigger('change');
  elements.get('sound-pitch').value = '12';
  await elements.get('sound-pitch').trigger('input');
  await elements.get('sound-pitch').trigger('change');
  await elements.get('preview-work').trigger('click');
  assert.equal(audio.notes.length, 2);
  assert.deepEqual(audio.notes.map(note => note.frequency.value), [1320, 1760]);
  assert.equal(audio.gains[0][1].value, 0.08);
  assert.equal(audio.notes[1].stoppedAt, 0.48);
  assert.equal(elements.get('preview-rest').disabled, true);
  await elements.get('preview-rest').trigger('click');
  assert.equal(audio.notes.length, 2);
  app.flushTimeouts();
  await elements.get('preview-rest').trigger('click');
  assert.equal(audio.notes.length, 5);
  assert.deepEqual(audio.notes.slice(2).map(note => note.frequency.value), [1318.5, 1108.74, 880]);
  assert.ok(Math.abs(audio.notes[4].stoppedAt - 0.5769230769230769) < 1e-9);
  assert.ok(audio.notes.every(note => note.stoppedAt > note.startedAt));
  assert.ok(audio.gains.every(events => events.every(event => event.value > 0)));
  const restored = mount(app.storage).elements;
  await restored.get('settings-toggle').trigger('click');
  assert.equal(restored.get('sound-volume').value, '10');
  assert.equal(restored.get('sound-pitch').value, '12');
  app.flushTimeouts();
  elements.get('sound-volume').value = '100';
  await elements.get('sound-volume').trigger('change');
  await elements.get('preview-work').trigger('click');
  assert.equal(audio.gains[5][1].value, 0.8);
  assert.ok(audio.gains[5][1].value < 1);
  const boosted = mount(app.storage).elements;
  await boosted.get('settings-toggle').trigger('click');
  assert.equal(boosted.get('sound-volume').value, '100');
  await elements.get('export-data').trigger('click');
  const backup = JSON.parse(await app.exportedBlob.text());
  assert.deepEqual(backup.sound, { volume: 500, pitch: 12 });
  backup.sound = { volume: 35, pitch: -12 };
  elements.get('import-file').files = [{ size: 1000, text: async () => JSON.stringify(backup) }];
  await elements.get('import-file').trigger('change');
  assert.equal(elements.get('sound-volume').value, '7');
  assert.equal(elements.get('sound-pitch').value, '-12');
  assert.equal(elements.get('sound-pitch').getAttribute('aria-valuetext'), '標準より12半音低い');
  const beforeInvalid = app.storage.get('practice-timer-v1');
  backup.sound.pitch = 99;
  await elements.get('import-file').trigger('change');
  assert.match(elements.get('backup-status').textContent, /音の設定が不正/);
  assert.equal(app.storage.get('practice-timer-v1'), beforeInvalid);
  backup.sound = { volume: 501, pitch: 0 };
  await elements.get('import-file').trigger('change');
  assert.match(elements.get('backup-status').textContent, /音の設定が不正/);
  assert.equal(app.storage.get('practice-timer-v1'), beforeInvalid);
});

test('音量0は完全に消音し、音を準備できない環境でも計測を開始できる', async () => {
  const storage = new Map([['practice-timer-v1', JSON.stringify({
    steps: [{ type: 'work', minutes: 25 }, { type: 'rest', minutes: 5 }], totalWorkMs: 0,
  })]]);
  const app = mount(storage);
  const { elements } = app;
  await elements.get('settings-toggle').trigger('click');
  elements.get('sound-volume').value = '0';
  await elements.get('sound-volume').trigger('change');
  assert.equal(elements.get('preview-work').disabled, true);
  assert.equal(elements.get('sound-volume-value').textContent, '0%（消音）');
  await elements.get('nav-timer').trigger('click');
  await elements.get('main-action').trigger('click');
  await elements.get('skip').trigger('click');
  assert.equal(elements.get('status').textContent, '');
  assert.equal(elements.get('phase-name').getAttribute('aria-label'), '休憩中');
  const audio = recordAudio();
  const muted = mount(storage, audio.AudioContext);
  await muted.elements.get('settings-toggle').trigger('click');
  await muted.elements.get('preview-work').trigger('click');
  assert.equal(audio.notes.length, 0);
  muted.elements.get('sound-volume').value = '10';
  await muted.elements.get('sound-volume').trigger('change');
  await muted.elements.get('skip').trigger('click');
  assert.equal(audio.notes.length, 2);
  assert.equal(audio.gains[0][1].value, 0.08);
});

test('音の設定を含まない旧バックアップは標準音を使い、試聴できない場合はエラーを表示する', async () => {
  const storage = new Map([['practice-timer-v1', JSON.stringify({
    format: 'practice-timer-beta', version: 1, steps: [], tasks: [], groups: [], sessions: [],
    run: null, totalWorkMs: 0, selectedTaskId: null,
  })]]);
  const { elements } = mount(storage);
  await elements.get('settings-toggle').trigger('click');
  assert.equal(elements.get('sound-volume').value, '20');
  assert.equal(elements.get('sound-pitch').value, '0');
  await elements.get('preview-rest').trigger('click');
  assert.match(elements.get('sound-status').textContent, /音を再生できません/);
  assert.equal(elements.get('preview-rest').disabled, false);
});

function buttonNamed(element, label) {
  for (const child of element.children) {
    if (child.tagName === 'button' && child.textContent === label) return child;
    const found = buttonNamed(child, label);
    if (found) return found;
  }
  return null;
}

test('旧版の音量は同じ大きさで引き継ぎ、高さを変えても丸めない', async () => {
  for (const [volume, displayed] of [[300, '60'], [99, '19.8']]) {
    const storage = new Map([['practice-timer-v1', JSON.stringify({
      format: 'practice-timer-beta', version: 1, steps: [], tasks: [], groups: [], sessions: [],
      run: null, totalWorkMs: 0, selectedTaskId: null, sound: { volume, pitch: 0 },
    })]]);
    const audio = recordAudio();
    const { elements } = mount(storage, audio.AudioContext);
    await elements.get('settings-toggle').trigger('click');
    assert.equal(elements.get('sound-volume').value, displayed);
    elements.get('sound-pitch').value = '1';
    await elements.get('sound-pitch').trigger('change');
    assert.equal(JSON.parse(storage.get('practice-timer-v1')).sound.volume, volume);
    await elements.get('preview-work').trigger('click');
    assert.ok(Math.abs(audio.gains[0][1].value - 0.16 * volume / 100) < 1e-12);
  }
});

test('下部の設定から別の画面へ移動しても入力を保ち、キャンセルで元に戻せる', async () => {
  const storage = new Map([['practice-timer-v1', JSON.stringify({
    steps: [{ type: 'work', minutes: 25 }, { type: 'rest', minutes: 5 }], totalWorkMs: 0,
  })]]);
  const { elements } = mount(storage);
  await elements.get('settings-toggle').trigger('click');
  const input = elements.get('step-list').children[0].querySelector('input');
  input.value = '30';
  await input.trigger('input');
  await elements.get('nav-tasks').trigger('click');
  assert.equal(elements.get('nav-tasks').getAttribute('aria-current'), 'page');
  assert.equal(elements.get('settings-toggle').getAttribute('aria-current'), null);
  await elements.get('settings-toggle').trigger('click');
  assert.equal(elements.get('primary-nav').hidden, false);
  assert.equal(elements.get('settings-toggle').getAttribute('aria-current'), 'page');
  assert.equal(elements.get('step-list').children[0].querySelector('input').value, '30');
  await elements.get('cancel-settings').trigger('click');
  await elements.get('settings-toggle').trigger('click');
  assert.equal(elements.get('step-list').children[0].querySelector('input').value, 25);
});

test('通常の開始説明を省き、音の失敗は工程移行後も残し、再読込は停止アイコンで示す', async () => {
  const storage = new Map([['practice-timer-v1', JSON.stringify({
    steps: [{ type: 'work', minutes: 25 }, { type: 'rest', minutes: 5 }], totalWorkMs: 0,
  })]]);
  const { elements } = mount(storage);
  assert.equal(elements.get('active-task-hint').hidden, true);
  const starting = elements.get('main-action').trigger('click');
  assert.equal(elements.get('status').textContent, '');
  await starting;
  assert.match(elements.get('status').textContent, /音を準備できません/);
  await elements.get('skip').trigger('click');
  assert.equal(elements.get('phase-name').getAttribute('aria-label'), '休憩中');
  assert.match(elements.get('status').textContent, /音を準備できません/);
  const restored = mount(storage).elements;
  assert.equal(restored.get('status').textContent, '');
  assert.equal(restored.get('phase-name').getAttribute('aria-label'), '休憩・一時停止中');
  assert.equal(restored.get('phase-paused').hidden, false);
  assert.equal(restored.get('main-action').getAttribute('aria-label'), '再開');
});

test('保存失敗は音の失敗で上書きしない', async () => {
  const storage = {
    get() { return JSON.stringify({ steps: [{ type: 'work', minutes: 25 }, { type: 'rest', minutes: 5 }], totalWorkMs: 0 }); },
    set() { throw new Error('storage full'); },
  };
  const { elements } = mount(storage);
  await elements.get('main-action').trigger('click');
  assert.match(elements.get('status').textContent, /ブラウザに保存できません/);
});

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
  assert.equal(elements.get('main-action').getAttribute('aria-label'), '手順を設定');
  assert.equal(elements.get('skip').hidden, true);
  assert.equal(elements.get('end').hidden, true);
  await elements.get('main-action').trigger('click');
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
  assert.equal(elements.get('clock').textContent, '00:06');
  const startClick = elements.get('main-action').trigger('click');
  assert.equal(elements.get('phase-name').getAttribute('aria-label'), '作業中');
  assert.equal(elements.get('phase-icon').getAttribute('href'), '#icon-work');
  assert.equal(elements.get('main-action').getAttribute('aria-label'), '一時停止');
  assert.equal(elements.get('main-action-icon').getAttribute('href'), '#icon-pause');
  assert.equal(elements.get('skip').hidden, false);
  assert.equal(elements.get('skip').getAttribute('aria-label'), '休憩へ進む');
  assert.equal(elements.get('phase-paused').hidden, true);
  const pauseClick = elements.get('main-action').trigger('click');
  assert.equal(elements.get('main-action').getAttribute('aria-label'), '再開');
  assert.equal(elements.get('main-action-icon').getAttribute('href'), '#icon-play');
  assert.equal(elements.get('phase-name').getAttribute('aria-label'), '作業・一時停止中');
  assert.equal(elements.get('phase-paused').hidden, false);
  const resumeClick = elements.get('main-action').trigger('click');
  assert.equal(elements.get('main-action').getAttribute('aria-label'), '一時停止');
  await Promise.all([startClick, pauseClick, resumeClick]);
  await elements.get('skip').trigger('click');
  assert.equal(elements.get('phase-name').getAttribute('aria-label'), '休憩中');
  assert.equal(elements.get('phase-icon').getAttribute('href'), '#icon-rest');
  assert.equal(elements.get('skip').getAttribute('aria-label'), '次の作業へ');
  assert.ok(storage.has('practice-timer-v1'));
});

test('タスクの後選択、日別記録の割り当て、文字JSONの保存・読み込み', async () => {
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
  await elements.get('task-details-add').trigger('click');
  assert.equal(elements.get('task-dialog').open, true);
  elements.get('task-title').value = '手を描く';
  elements.get('task-first-step').value = '指を3案描く';
  elements.get('task-group').value = savedGroups[0].id;
  await elements.get('task-group').trigger('change');
  elements.get('task-child').value = handId;
  await elements.get('task-form').trigger('submit');
  const taskId = JSON.parse(storage.get('practice-timer-v1')).tasks[0].id;
  assert.equal(JSON.parse(storage.get('practice-timer-v1')).tasks[0].targetId, handId);
  assert.equal(elements.get('task-dialog').open, false);

  await elements.get('nav-timer').trigger('click');
  await elements.get('main-action').trigger('click');
  await elements.get('choose-task').trigger('click');
  assert.equal(elements.get('task-picker-dialog').open, true);
  await elements.get('task-picker-list').children[0].querySelector('button').trigger('click');
  assert.equal(elements.get('task-picker-dialog').open, false);
  assert.equal(elements.get('choose-task').disabled, true);
  assert.equal(JSON.parse(storage.get('practice-timer-v1')).selectedTaskId, taskId);
  app.advance(3000);
  await elements.get('end').trigger('click');
  let saved = JSON.parse(storage.get('practice-timer-v1'));
  assert.equal(saved.sessions[0].workMs, 3000);
  assert.equal(saved.sessions[0].targetId, handId);

  await elements.get('main-action').trigger('click');
  app.advance(2000);
  await elements.get('end').trigger('click');
  await elements.get('nav-growth').trigger('click');
  assert.equal(elements.get('record-list').children.length, 2);
  const unclassified = elements.get('record-list').children[1];
  await unclassified.children.at(-1).trigger('click');
  assert.equal(elements.get('record-dialog').open, true);
  elements.get('record-task').value = taskId;
  await elements.get('record-task').trigger('change');
  await elements.get('record-form').trigger('submit');
  saved = JSON.parse(storage.get('practice-timer-v1'));
  assert.equal(saved.sessions[1].targetId, handId);
  assert.equal(saved.sessions[1].taskId, taskId);
  assert.equal(saved.totalWorkMs, 5000);

  await elements.get('nav-timer').trigger('click');
  await elements.get('settings-toggle').trigger('click');
  await elements.get('export-data').trigger('click');
  const backup = JSON.parse(await app.exportedBlob.text());
  assert.equal(backup.format, 'practice-timer-beta');
  assert.equal(backup.sessions.length, 2);
  assert.equal('note' in backup.sessions[1], false);
  assert.equal(JSON.stringify(backup).includes('data:image'), false);
  elements.get('import-file').files = [{ size: app.exportedBlob.size, text: () => app.exportedBlob.text() }];
  await elements.get('import-file').trigger('change');
  assert.match(elements.get('backup-status').textContent, /読み込みました/);
  assert.equal(elements.get('status').textContent, '');
  const beforeInvalidImport = storage.get('practice-timer-v1');
  elements.get('import-file').files = [{ size: 20, text: async () => '{"format":"wrong"}' }];
  await elements.get('import-file').trigger('change');
  assert.match(elements.get('backup-status').textContent, /中止しました/);
  assert.equal(storage.get('practice-timer-v1'), beforeInvalidImport);
});

test('既存タスクを保ち、完了済みへ退避して戻せる', async () => {
  const storage = new Map([['practice-timer-v1', JSON.stringify({
    format: 'practice-timer-beta', version: 1, steps: [], run: null, totalWorkMs: 2000,
    tasks: [{ id: 'old-task', title: '構図を考える', firstStep: 'ラフを3案描く', targetId: null }],
    groups: [], sessions: [{ id: 'old-session', endedAt: 1000, workMs: 2000,
      taskId: 'old-task', taskTitle: '構図を考える', targetId: null, reviewTargetId: null, note: '' }],
    selectedTaskId: null,
  })]]);
  const { elements } = mount(storage);
  await elements.get('nav-tasks').trigger('click');
  assert.equal(elements.get('active-count').textContent, '(1)');
  const oldTask = elements.get('task-list').children[0];
  oldTask.querySelector('input').checked = true;
  await oldTask.querySelector('input').trigger('change');
  let saved = JSON.parse(storage.get('practice-timer-v1'));
  assert.equal(elements.get('active-count').textContent, '(0)');
  assert.equal(elements.get('completed-count').textContent, '(1)');
  assert.equal(typeof saved.tasks[0].completedAt, 'number');
  assert.equal(saved.sessions[0].taskId, 'old-task');

  const reopened = mount(storage);
  await reopened.elements.get('nav-tasks').trigger('click');
  assert.equal(reopened.elements.get('completed-count').textContent, '(1)');
  const completedCheck = reopened.elements.get('completed-list').children[0].querySelector('input');
  completedCheck.checked = false;
  await completedCheck.trigger('change');
  saved = JSON.parse(storage.get('practice-timer-v1'));
  assert.equal(saved.tasks[0].completedAt, null);
  assert.equal(reopened.elements.get('active-count').textContent, '(1)');

  reopened.elements.get('quick-task-title').value = '配色を試す';
  await reopened.elements.get('quick-task-form').trigger('submit');
  saved = JSON.parse(storage.get('practice-timer-v1'));
  assert.equal(saved.tasks[1].title, '配色を試す');
  assert.equal(saved.tasks[1].targetId, null);
  assert.equal(reopened.elements.get('quick-task-title').value, '');
});

test('タイマー画面でEnterからタスクを即追加し、未選択の回だけ自動で選ぶ', async () => {
  const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
  assert.match(html, /<form id="timer-quick-task-form"[\s\S]*?<button type="submit">＋追加<\/button>/);
  const storage = new Map([['practice-timer-v1', JSON.stringify({
    steps: [{ type: 'work', minutes: 0.1 }, { type: 'rest', minutes: 0.1 }], totalWorkMs: 0,
  })]]);
  const { elements } = mount(storage);
  elements.get('timer-quick-task-title').value = 'あとで描く';
  await elements.get('timer-quick-task-form').trigger('submit');
  let saved = JSON.parse(storage.get('practice-timer-v1'));
  assert.equal(saved.tasks[0].title, 'あとで描く');
  assert.equal(saved.selectedTaskId, null);
  assert.equal(elements.get('timer-quick-task-title').value, '');

  await elements.get('main-action').trigger('click');
  elements.get('timer-quick-task-title').value = '今から描く';
  await elements.get('timer-quick-task-form').trigger('submit');
  saved = JSON.parse(storage.get('practice-timer-v1'));
  assert.equal(saved.selectedTaskId, saved.tasks[1].id);
  assert.equal(elements.get('active-task-name').textContent, '今から描く');
  assert.equal(elements.get('choose-task').disabled, true);
  assert.equal(elements.get('task-choice-actions').hidden, true);
  assert.equal(elements.get('timer-task-add').hidden, true);

  elements.get('timer-quick-task-title').value = '次に描く';
  await elements.get('timer-quick-task-form').trigger('submit');
  saved = JSON.parse(storage.get('practice-timer-v1'));
  assert.equal(saved.tasks[2].title, '次に描く');
  assert.equal(saved.selectedTaskId, saved.tasks[1].id);
  assert.equal(elements.get('timer-quick-task-title').value, '');
  await elements.get('end').trigger('click');
  assert.equal(elements.get('timer-task-add').hidden, false);
  assert.equal(elements.get('skip').hidden, true);
  assert.equal(elements.get('end').hidden, true);
});

test('開始前に選んだタスクを選び直せて、再読み込みと開始後も保持する', async () => {
  const storage = new Map([['practice-timer-v1', JSON.stringify({
    steps: [{ type: 'work', minutes: 0.1 }, { type: 'rest', minutes: 0.1 }], totalWorkMs: 0,
  })]]);
  const first = mount(storage);
  for (const title of ['構図を考える', '線を練習する']) {
    first.elements.get('timer-quick-task-title').value = title;
    await first.elements.get('timer-quick-task-form').trigger('submit');
  }
  assert.equal(first.elements.get('choose-task').disabled, false);
  await first.elements.get('choose-task').trigger('click');
  assert.equal(first.elements.get('task-picker-dialog').open, true);
  await first.elements.get('task-picker-list').children[0].querySelector('button').trigger('click');
  assert.equal(first.elements.get('active-task-name').textContent, '構図を考える');

  const second = mount(storage);
  const { elements } = second;
  assert.equal(elements.get('active-task-name').textContent, '構図を考える');
  assert.equal(elements.get('choose-task').textContent, 'タスクを選び直す');
  await elements.get('choose-task').trigger('click');
  await elements.get('task-picker-list').children[1].querySelector('button').trigger('click');
  const taskId = JSON.parse(storage.get('practice-timer-v1')).selectedTaskId;
  assert.equal(elements.get('active-task-name').textContent, '線を練習する');
  await elements.get('main-action').trigger('click');
  assert.equal(JSON.parse(storage.get('practice-timer-v1')).selectedTaskId, taskId);
  assert.equal(elements.get('choose-task').disabled, true);
  second.advance(2000);
  await elements.get('end').trigger('click');
  const saved = JSON.parse(storage.get('practice-timer-v1'));
  assert.equal(saved.sessions[0].taskId, taskId);
  assert.equal(saved.selectedTaskId, null);
  assert.equal(elements.get('choose-task').disabled, false);

  await elements.get('choose-task').trigger('click');
  await elements.get('task-picker-list').children[0].querySelector('button').trigger('click');
  await elements.get('nav-tasks').trigger('click');
  const check = elements.get('task-list').children[0].querySelector('input');
  check.checked = true;
  await check.trigger('change');
  assert.equal(JSON.parse(storage.get('practice-timer-v1')).selectedTaskId, null);
  assert.equal(elements.get('task-undo').hidden, false);
  await elements.get('task-undo').trigger('click');
  const undone = JSON.parse(storage.get('practice-timer-v1'));
  assert.equal(undone.selectedTaskId, undone.tasks[0].id);
  assert.equal(undone.tasks[0].completedAt, null);
  assert.equal(elements.get('task-undo').hidden, true);
});

test('タイマー画面から二段階の加算先で追加し、この回に選べる', async () => {
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
  const group = JSON.parse(storage.get('practice-timer-v1')).groups[0];

  await elements.get('nav-timer').trigger('click');
  await elements.get('main-action').trigger('click');
  await elements.get('timer-task-details-add').trigger('click');
  assert.equal(elements.get('task-dialog').open, true);
  elements.get('task-title').value = '手の練習';
  elements.get('task-first-step').value = '指を1本描く';
  elements.get('task-group').value = group.id;
  await elements.get('task-group').trigger('change');
  elements.get('task-child').value = group.children[0].id;
  await elements.get('task-form').trigger('submit');
  let saved = JSON.parse(storage.get('practice-timer-v1'));
  assert.equal(saved.tasks[0].targetId, group.children[0].id);
  assert.equal(saved.selectedTaskId, saved.tasks[0].id);
  assert.equal(elements.get('choose-task').disabled, true);
  assert.equal(elements.get('active-task-name').textContent, '手の練習');

  await elements.get('timer-task-details-add').trigger('click');
  elements.get('task-title').value = '人体全体の練習';
  elements.get('task-group').value = group.id;
  await elements.get('task-group').trigger('change');
  assert.equal(elements.get('task-child').value, '');
  await elements.get('task-form').trigger('submit');
  saved = JSON.parse(storage.get('practice-timer-v1'));
  assert.equal(saved.tasks[1].targetId, group.id);
  assert.equal(saved.selectedTaskId, saved.tasks[0].id);

  await elements.get('nav-tasks').trigger('click');
  const selectedRow = elements.get('task-list').children[0];
  assert.equal(buttonNamed(selectedRow, '削除').disabled, true);
  assert.equal(buttonNamed(selectedRow, 'このタスクを選ぶ'), null);
  selectedRow.querySelector('input').checked = true;
  await selectedRow.querySelector('input').trigger('change');
  assert.equal(elements.get('completed-count').textContent, '(1)');
  await elements.get('nav-timer').trigger('click');
  assert.equal(elements.get('active-task-name').textContent, '手の練習');
  app.advance(3000);
  await elements.get('end').trigger('click');
  saved = JSON.parse(storage.get('practice-timer-v1'));
  assert.equal(saved.sessions[0].targetId, group.children[0].id);
  assert.equal(saved.sessions[0].workMs, 3000);
  assert.equal(saved.tasks[0].completedAt, 1000000);

  await elements.get('main-action').trigger('click');
  await elements.get('choose-task').trigger('click');
  assert.equal(elements.get('task-picker-list').children.length, 1);
  assert.equal(elements.get('task-picker-list').children[0].children[0].textContent, '人体全体の練習');
  await elements.get('task-picker-close').trigger('click');
  await elements.get('end').trigger('click');
});

test('タイトル中心の詳細からタスクを選び、入力中のタイトルを保って詳細追加できる', async () => {
  const { elements, storage } = mount();
  await elements.get('nav-tasks').trigger('click');
  elements.get('quick-task-title').value = '構図を考える';
  await elements.get('task-details-add').trigger('click');
  assert.equal(elements.get('task-title').value, '構図を考える');
  await elements.get('task-cancel').trigger('click');
  assert.equal(elements.get('quick-task-title').value, '構図を考える');
  await elements.get('task-details-add').trigger('click');
  elements.get('task-first-step').value = 'ラフを3案描く';
  await elements.get('task-form').trigger('submit');
  assert.equal(elements.get('quick-task-title').value, '');
  const row = elements.get('task-list').children[0];
  assert.equal(row.querySelector('summary').textContent, '構図を考える');
  assert.equal(row.children[1].tagName, 'details');
  assert.equal(row.children[1].open, false);
  await buttonNamed(row, 'このタスクを選ぶ').trigger('click');
  assert.equal(elements.get('timer-view').hidden, false);
  assert.equal(elements.get('active-task-name').textContent, '構図を考える');
  assert.equal(elements.get('active-task-hint').textContent, 'ラフを3案描く');
  assert.equal(JSON.parse(storage.get('practice-timer-v1')).selectedTaskId,
    JSON.parse(storage.get('practice-timer-v1')).tasks[0].id);
});

test('既存タイマーの累計は未分類記録として一度だけ引き継ぐ', async () => {
  const storage = new Map([['practice-timer-v1', JSON.stringify({
    steps: [{ type: 'work', minutes: 5 }, { type: 'rest', minutes: 3 }], totalWorkMs: 120000,
  })]]);
  const first = mount(storage);
  await first.elements.get('nav-growth').trigger('click');
  assert.equal(first.elements.get('record-list').children.length, 1);
  first.elements.get('group-title').value = '練習';
  await first.elements.get('group-form').trigger('submit');
  assert.equal(JSON.parse(storage.get('practice-timer-v1')).sessions.length, 1);
  const second = mount(storage);
  await second.elements.get('nav-growth').trigger('click');
  assert.equal(second.elements.get('record-list').children.length, 1);
});

test('積み上げは時間と分で表示し、親子の内訳を分けて秒の精度を保持する', async () => {
  const start = new Date(1_000_000);
  start.setHours(10, 0, 0, 0);
  const sessions = [
    { id: 'hand-record', startedAt: +start, endedAt: +start + 1_559_000, workMs: 1_559_000,
      taskTitle: '手を描く', targetId: 'hand' },
    { id: 'direct-record', startedAt: +start + 1_559_000, endedAt: +start + 3_601_000,
      workMs: 2_042_000, targetId: 'body' },
    { id: 'short-record', startedAt: +start + 3_601_000, endedAt: +start + 3_646_000,
      workMs: 45_000, targetId: null },
    { id: 'other-day', startedAt: null, endedAt: +start + 86_400_000,
      workMs: 451_800_000, targetId: null },
  ];
  const original = JSON.stringify({ format: 'practice-timer-beta', version: 1,
    steps: [], tasks: [], groups: [{ id: 'body', title: '人体', children: [{ id: 'hand', title: '手' }] }],
    sessions, totalWorkMs: 455_446_000, run: null,
  });
  const { elements, storage } = mount(new Map([['practice-timer-v1', original]]), undefined, +start);
  await elements.get('nav-growth').trigger('click');
  assert.equal(elements.get('growth-total').textContent, '01:00');
  assert.equal(elements.get('growth-all-total').textContent, '全期間 126:30');
  const group = elements.get('period-group-list').children[0];
  assert.deepEqual(group.children[0].children.map((item) => item.textContent), ['人体', '01:00']);
  assert.deepEqual(group.children[1].children.map((row) => row.children.map((item) => item.textContent)),
    [['手', '00:25'], ['内訳なし', '00:34']]);
  const records = elements.get('record-list').children;
  assert.deepEqual(records[0].children[0].children.map((item) => item.textContent), ['手を描く', '00:25']);
  assert.equal(records[0].children[1].children[0].textContent, '10:00 ～ 10:25');
  assert.equal(records[0].children[1].children[1].textContent, '人体 → 手');
  assert.equal(records[2].children[0].children[1].textContent, '00:00');
  await elements.get('period-next').trigger('click');
  assert.equal(elements.get('growth-total').textContent, '125:30');
  const legacy = elements.get('record-list').children[0];
  assert.equal(legacy.children[1].children[0].textContent, '開始時刻なし ～ 10:00');
  assert.equal(storage.get('practice-timer-v1'), original);
});

test('日付をまたぐ記録は選択日以外の日付と当日分の時間を表示する', async () => {
  const start = new Date(1_000_000);
  start.setHours(23, 30, 0, 0);
  const original = JSON.stringify({ format: 'practice-timer-beta', version: 1,
    steps: [], tasks: [], groups: [], totalWorkMs: 5_400_000, run: null, dayStartMinutes: 0,
    sessions: [{ id: 'overnight', startedAt: +start, endedAt: +start + 5_400_000,
      workMs: 5_400_000, taskTitle: '夜の練習', targetId: null }],
  });
  const { elements, storage } = mount(new Map([['practice-timer-v1', original]]));
  await elements.get('nav-growth').trigger('click');
  let row = elements.get('record-list').children[0];
  assert.equal(row.children[0].children[1].textContent, '00:30');
  assert.equal(row.children[0].children[1].children[0].textContent, 'この日');
  assert.equal(row.children[1].children[0].textContent, '23:30 ～ 1/2 01:00');
  await elements.get('period-next').trigger('click');
  row = elements.get('record-list').children[0];
  assert.equal(row.children[0].children[1].textContent, '01:00');
  assert.equal(row.children[1].children[0].textContent, '1/1 23:30 ～ 01:00');
  await row.children.at(-1).trigger('click');
  assert.equal(elements.get('record-dialog').open, true);
  assert.equal(new Date(elements.get('record-start').value).getTime(), +start);
  assert.equal(new Date(elements.get('record-end').value).getTime(), +start + 5_400_000);
  assert.equal(storage.get('practice-timer-v1'), original);
});

test('日のグラフは初期5時から24区間で表示し、区切りの変更・保存・復元ができる', async () => {
  const now = new Date(2026, 10, 12, 4, 30).getTime();
  const sessions = [
    { id: 'midnight', startedAt: +new Date(2026, 10, 11, 23, 50),
      endedAt: +new Date(2026, 10, 12, 0, 10), workMs: 1_200_000 },
    { id: 'boundary', startedAt: +new Date(2026, 10, 12, 4, 50),
      endedAt: +new Date(2026, 10, 12, 5, 10), workMs: 1_200_000 },
    { id: 'legacy', startedAt: null, endedAt: +new Date(2026, 10, 11, 10), workMs: 600_000 },
  ];
  const original = JSON.stringify({ format: 'practice-timer-beta', version: 1,
    steps: [], tasks: [], groups: [], sessions, totalWorkMs: 3_000_000, run: null });
  const app = mount(new Map([['practice-timer-v1', original]]), undefined, now);
  const { elements, storage } = app;
  await elements.get('nav-growth').trigger('click');
  assert.match(elements.get('period-label').textContent, /2026\/11\/11/);
  assert.equal(elements.get('growth-total').textContent, '00:40');
  const bars = elements.get('period-chart').children;
  assert.equal(bars.length, 24);
  assert.equal(bars[0].getAttribute('aria-label'), '05:00 ～ 06:00 00:00');
  assert.equal(bars[23].getAttribute('aria-label'), '04:00 ～ 05:00 00:10');
  assert.equal(elements.get('period-chart-max').textContent, '01:00');
  assert.equal(elements.get('day-untimed').hidden, false);
  assert.equal(elements.get('day-untimed').textContent, '開始時刻なし 00:10');
  await elements.get('period-week').trigger('click');
  assert.equal(elements.get('period-label').textContent, '2026/11/9 ～ 2026/11/15');
  await elements.get('period-day').trigger('click');
  await elements.get('period-next').trigger('click');
  assert.equal(elements.get('growth-total').textContent, '00:10');
  await elements.get('period-prev').trigger('click');
  await elements.get('settings-toggle').trigger('click');
  assert.equal(elements.get('day-start').value, '05:00');
  elements.get('day-start').value = '00:00';
  await elements.get('day-start').trigger('change');
  assert.equal(JSON.parse(storage.get('practice-timer-v1')).dayStartMinutes, 0);
  const restored = mount(storage, undefined, now);
  await restored.elements.get('settings-toggle').trigger('click');
  assert.equal(restored.elements.get('day-start').value, '00:00');
  // 昼より遅い区切りでも前後移動とグラフからの移動で日付がずれない。
  elements.get('day-start').value = '23:30';
  await elements.get('day-start').trigger('change');
  await elements.get('nav-growth').trigger('click');
  assert.equal(elements.get('period-chart').children[0].getAttribute('aria-label'), '23:30 ～ 00:30 00:20');
  await elements.get('period-next').trigger('click');
  assert.match(elements.get('period-label').textContent, /2026\/11\/12/);
  await elements.get('period-prev').trigger('click');
  assert.match(elements.get('period-label').textContent, /2026\/11\/11/);
  await elements.get('period-month').trigger('click');
  await elements.get('period-chart').children[0].trigger('click');
  assert.match(elements.get('period-label').textContent, /2026\/11\/1\(/);
  assert.equal(elements.get('period-chart').children.length, 24);
  await elements.get('settings-toggle').trigger('click');
  await elements.get('export-data').trigger('click');
  const backup = JSON.parse(await app.exportedBlob.text());
  assert.equal(backup.dayStartMinutes, 1410);
  assert.deepEqual(backup.sessions.map((record) => [record.startedAt, record.endedAt, record.workMs]),
    sessions.map((record) => [record.startedAt, record.endedAt, record.workMs]));
  backup.dayStartMinutes = 0;
  elements.get('import-file').files = [{ size: 1000, text: async () => JSON.stringify(backup) }];
  await elements.get('import-file').trigger('change');
  assert.equal(elements.get('day-start').value, '00:00');
  for (const invalid of [-1, 1440, 5.5, '05:00', null]) {
    const before = storage.get('practice-timer-v1');
    backup.dayStartMinutes = invalid;
    await elements.get('import-file').trigger('change');
    assert.match(elements.get('backup-status').textContent, /区切りの設定が不正/);
    assert.equal(storage.get('practice-timer-v1'), before);
  }
  delete backup.dayStartMinutes;
  await elements.get('import-file').trigger('change');
  assert.equal(elements.get('day-start').value, '05:00');
});

test('繰り返し計測の一件削除と起動分削除で累計を再計算する', async () => {
  const storage = new Map([['practice-timer-v1', JSON.stringify({
    steps: [{ type: 'work', minutes: 0.1 }, { type: 'rest', minutes: 0.1 },
      { type: 'work', minutes: 0.1 }], totalWorkMs: 0,
  })]]);
  const app = mount(storage);
  const { elements } = app;
  await elements.get('main-action').trigger('click');
  app.advance(3000);
  await elements.get('skip').trigger('click');
  app.advance(2000);
  await elements.get('skip').trigger('click');
  app.advance(4000);
  await elements.get('end').trigger('click');
  const original = storage.get('practice-timer-v1');
  let saved = JSON.parse(original);
  assert.deepEqual(saved.sessions.map((item) => item.workMs), [3000, 4000]);
  assert.equal(saved.sessions[0].recordGroupId, saved.sessions[1].recordGroupId);
  await elements.get('nav-growth').trigger('click');
  assert.equal(elements.get('record-list').children.length, 2);

  await elements.get('record-list').children[0].children.at(-1).trigger('click');
  assert.equal(elements.get('record-delete-group').hidden, false);
  await elements.get('record-delete').trigger('click');
  saved = JSON.parse(storage.get('practice-timer-v1'));
  assert.equal(saved.sessions.length, 1);
  assert.equal(saved.totalWorkMs, 4000);

  await elements.get('record-list').children[0].children.at(-1).trigger('click');
  const end = new Date(elements.get('record-end').value);
  const corrected = new Date(end.getTime() - 2000);
  elements.get('record-end').value = new Date(corrected.getTime() - corrected.getTimezoneOffset() * 60000)
    .toISOString().slice(0, 19);
  await elements.get('record-form').trigger('submit');
  saved = JSON.parse(storage.get('practice-timer-v1'));
  assert.equal(saved.sessions[0].workMs, 2000);
  assert.equal(saved.totalWorkMs, 2000);

  for (const [kind, count] of [['week', 7], ['month', 31], ['year', 12]]) {
    await elements.get('period-' + kind).trigger('click');
    assert.equal(elements.get('period-chart').children.length, count);
  }
  await elements.get('period-chart').children[0].trigger('click');
  assert.equal(elements.get('period-chart').children.length, 31);
  await elements.get('period-chart').children[0].trigger('click');
  assert.equal(elements.get('day-records').hidden, false);

  const all = mount(new Map([['practice-timer-v1', original]]));
  await all.elements.get('nav-growth').trigger('click');
  await all.elements.get('record-list').children[0].children.at(-1).trigger('click');
  await all.elements.get('record-delete-group').trigger('click');
  const afterAll = JSON.parse(all.storage.get('practice-timer-v1'));
  assert.equal(afterAll.sessions.length, 0);
  assert.equal(afterAll.totalWorkMs, 0);
  await all.elements.get('period-week').trigger('click');
  assert.equal(all.elements.get('period-chart').hidden, true);
});
