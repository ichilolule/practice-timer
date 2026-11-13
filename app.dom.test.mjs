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
  append(...children) { for (const child of children) child.parentElement = this; this.children.push(...children); }
  replaceChildren(...children) { this.children = []; this.append(...children); }
  addEventListener(type, handler) { this.listeners.set(type, handler); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  removeAttribute(name) { this.attributes.delete(name); }
  focus(options) { this.focusOptions = options; this.onFocus?.(options); }
  click() {}
  remove() {}
  showModal() { this.open = true; }
  close() { this.open = false; this.listeners.get('close')?.(); }
  reset() { for (const child of this.children) { child.value = ''; child.reset(); } }
  async trigger(type, event = {}) { return this.listeners.get(type)?.({ preventDefault() {}, stopPropagation() {}, ...event }); }
  setPointerCapture() {}
  hasPointerCapture() { return false; }
  getBoundingClientRect() { return this.bounds || { top: 0, bottom: 400, left: 0, right: 300, height: 400 }; }
  closest(selector) {
    const attribute = selector === '[data-step-index]' ? 'data-step-index' : 'data-task-id';
    return this.getAttribute(attribute) != null ? this : this.parentElement?.closest(selector);
  }
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

function mount(storage = new Map(), AudioContext = class { constructor() { throw new Error('audio unavailable'); } }, initialNow = 1_000_000, configureBackup) {
  const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
  const elements = new Map([...html.matchAll(/id="([^"]+)"/g)].map((match) => [match[1], new Element()]));
  const document = {
    getElementById: (id) => elements.get(id),
    createElement: (tag) => new Element(tag),
    createElementNS: (_namespace, tag) => new Element(tag),
    body: new Element('body'),
    elementFromPoint: () => hitElement,
  };
  let hitElement = null;
  let now = initialNow;
  let exportedBlob = null;
  const timeouts = [];
  const viewport = { AudioContext, scrollX: 0, scrollY: 0, scrollTo({ left, top }) { this.scrollX = left; this.scrollY = top; } };
  const FakeDate = class extends Date { static now() { return now; } };
  const context = vm.createContext({
    document,
    localStorage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
    },
    window: viewport,
    addEventListener() {},
    setInterval() {},
    setTimeout(callback, delay = 0) { timeouts.push({ callback, at: now + delay }); },
    confirm: () => true,
    prompt: () => null,
    Blob,
    URL: { createObjectURL(blob) { exportedBlob = blob; return 'blob:test'; }, revokeObjectURL() {} },
    Date: FakeDate,
  });
  for (const file of ['timer-core.js', 'practice-data.js', 'backup-files.js', 'app.js']) {
    if (file === 'app.js') configureBackup?.(context);
    vm.runInContext(readFileSync(new URL(`./${file}`, import.meta.url), 'utf8'), context);
  }
  return { elements, storage, viewport, hit(element) { hitElement = element; }, advance(ms) { now += ms; },
    flushTimeouts() { for (const timer of timeouts.splice(0)) timer.callback(); },
    flushDueTimeouts() { for (const timer of timeouts.filter((timer) => timer.at <= now)) { timeouts.splice(timeouts.indexOf(timer), 1); timer.callback(); } },
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

test('自動保存へタスク・設定変更を伝え、計測途中のJSONも既存形式で復元できる', async () => {
  let options;
  const changes = [];
  const storage = new Map([['practice-timer-v1', JSON.stringify({
    steps: [{ type: 'work', minutes: 25 }, { type: 'rest', minutes: 5 }], totalWorkMs: 0,
  })]]);
  const app = mount(storage, undefined, 1_000_000, context => {
    context.PracticeBackupFiles = { mount(value) { options = value; context.document.getElementById('backup-save').addEventListener('click', value.download); return { changed: next => changes.push(JSON.parse(next)) }; } };
  });
  app.elements.get('timer-quick-task-title').value = '人体の練習';
  await app.elements.get('timer-quick-task-form').trigger('submit');
  assert.equal(changes.at(-1).tasks[0].title, '人体の練習');
  app.elements.get('day-start').value = '04:00';
  await app.elements.get('day-start').trigger('change');
  assert.equal(changes.at(-1).dayStartMinutes, 240);
  await app.elements.get('main-action').trigger('click');
  app.advance(3500);
  const automatic = JSON.parse(JSON.stringify(options.snapshot()));
  assert.equal(automatic.run.status, 'paused');
  assert.equal(automatic.run.sessionWorkMs, 3500);
  assert.equal(automatic.totalWorkMs, 3500);
  assert.equal(automatic.run.lastTick, null);
  assert.equal(app.elements.get('main-action').getAttribute('aria-label'), 'Pause');
  const restored = mount(new Map([['practice-timer-v1', JSON.stringify(automatic)]]));
  assert.equal(restored.elements.get('main-action').getAttribute('aria-label'), 'Resume');
  await app.elements.get('end').trigger('click');
  assert.equal(changes.at(-1).run, null);
  assert.equal(changes.at(-1).sessions[0].workMs, 3500);
  await app.elements.get('backup-save').trigger('click');
  const ended = JSON.parse(await app.exportedBlob.text());
  ended.tasks[0].title = 'JSONから復元したタスク';
  app.elements.get('import-file').files = [{ size: 1000, text: async () => JSON.stringify(ended) }];
  await app.elements.get('import-file').trigger('change');
  assert.equal(changes.at(-1).tasks[0].title, 'JSONから復元したタスク');
});

test('下部の入力欄が折り返しても末尾用の余白を追従させ、非表示時の高さは採用しない', () => {
  let resize;
  const measured = new Map();
  const observed = [];
  const storage = new Map();
  const app = mount(storage, undefined, 1_000_000, context => {
    context.document.documentElement = { style: { setProperty: (key, value) => measured.set(key, value) } };
    context.window.ResizeObserver = class {
      constructor(callback) { resize = callback; }
      observe(element) { observed.push(element); }
    };
  });
  assert.deepEqual(observed, [app.elements.get('quick-task-form'), app.elements.get('theme-add'), app.elements.get('primary-nav')]);
  const entry = (id, height) => ({ target: { id, getBoundingClientRect: () => ({ height }) } });
  resize([entry('quick-task-form', 69), entry('theme-add', 69), entry('primary-nav', 69)]);
  assert.equal(measured.get('--theme-entry-height'), '69px');
  assert.equal(measured.get('--task-entry-height'), '69px');
  resize([entry('quick-task-form', 113), entry('theme-add', 100)]);
  assert.equal(measured.get('--task-entry-height'), '113px');
  assert.equal(measured.get('--theme-entry-height'), '100px');
  resize([entry('quick-task-form', 0), entry('theme-add', 0), entry('primary-nav', 90)]);
  assert.equal(measured.get('--task-entry-height'), '113px');
  assert.equal(measured.get('--theme-entry-height'), '100px');
  assert.equal(measured.get('--primary-nav-height'), '90px');
  assert.equal(storage.size, 0);
});

test('ローカルデータが壊れている間は直接保存を止め、有効なJSONを読み込むと解除する', async () => {
  let options;
  const app = mount(new Map([['practice-timer-v1', '{broken']]), undefined, 1_000_000, context => {
    context.PracticeBackupFiles = { mount(value) { options = value; return { changed() {} }; } };
  });
  assert.equal(options.canWrite(), false);
  const recovered = { format: 'practice-timer-beta', version: 1, steps: [], tasks: [], groups: [], sessions: [], totalWorkMs: 0, run: null };
  app.elements.get('import-file').files = [{ size: 1000, text: async () => JSON.stringify(recovered) }];
  await app.elements.get('import-file').trigger('change');
  assert.equal(options.canWrite(), true);
  assert.match(app.elements.get('backup-status').textContent, /JSON imported/);
});

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
  await elements.get('backup-save').trigger('click');
  const backup = JSON.parse(await app.exportedBlob.text());
  assert.deepEqual(backup.sound, { volume: 500, pitch: 12 });
  backup.sound = { volume: 35, pitch: -12 };
  elements.get('import-file').files = [{ size: 1000, text: async () => JSON.stringify(backup) }];
  await elements.get('import-file').trigger('change');
  assert.equal(elements.get('sound-volume').value, '7');
  assert.equal(elements.get('sound-pitch').value, '-12');
  assert.equal(elements.get('sound-pitch').getAttribute('aria-valuetext'), '12 semitones lower than default');
  const beforeInvalid = app.storage.get('practice-timer-v1');
  backup.sound.pitch = 99;
  await elements.get('import-file').trigger('change');
  assert.match(elements.get('backup-status').textContent, /Invalid sound settings/);
  assert.equal(app.storage.get('practice-timer-v1'), beforeInvalid);
  backup.sound = { volume: 501, pitch: 0 };
  await elements.get('import-file').trigger('change');
  assert.match(elements.get('backup-status').textContent, /Invalid sound settings/);
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
  assert.equal(elements.get('sound-volume-value').textContent, '0% (muted)');
  await elements.get('nav-timer').trigger('click');
  await elements.get('main-action').trigger('click');
  await elements.get('skip').trigger('click');
  assert.equal(elements.get('status').textContent, '');
  assert.equal(elements.get('phase-name').getAttribute('aria-label'), 'Break · running');
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
  assert.match(elements.get('sound-status').textContent, /Could not play sound/);
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

test('Routineは編集中の値を保ってドラッグ・上下キーで並べ替え、保存後の工程順とJSONへ反映する', async () => {
  const original = [{ type: 'work', minutes: 25 }, { type: 'rest', minutes: 5 }, { type: 'work', minutes: 10 }];
  const storage = new Map([['practice-timer-v1', JSON.stringify({ steps: original, totalWorkMs: 0 })]]);
  const app = mount(storage);
  const { elements } = app;
  await elements.get('settings-toggle').trigger('click');
  const list = elements.get('step-list');
  const values = () => list.children.map(row => [row.querySelector('select').value, Number(row.querySelector('input').value)]);
  const input = list.children[0].querySelector('input');
  input.value = '35';
  await input.trigger('input');
  const handle = list.children[0].querySelector('button');
  const target = list.children[2];
  target.bounds = { top: 120, height: 48 };
  const pointer = { button: 0, isPrimary: true, pointerId: 1, clientX: 20, clientY: 10 };
  await handle.trigger('pointerdown', pointer);
  app.hit(target.querySelector('input'));
  await handle.trigger('pointermove', { ...pointer, clientY: 160 });
  await handle.trigger('pointerup', { ...pointer, clientY: 160 });
  assert.deepEqual(values(), [['rest', 5], ['work', 10], ['work', 35]]);
  assert.deepEqual(JSON.parse(storage.get('practice-timer-v1')).steps, original);
  assert.equal(list.children[2].querySelector('button').focusOptions.preventScroll, true);
  await list.children[1].querySelector('button').trigger('keydown', { key: 'ArrowUp' });
  assert.deepEqual(values(), [['work', 10], ['rest', 5], ['work', 35]]);
  await elements.get('nav-tasks').trigger('click');
  await elements.get('settings-toggle').trigger('click');
  assert.deepEqual(values(), [['work', 10], ['rest', 5], ['work', 35]]);
  await elements.get('save-settings').trigger('click');
  assert.deepEqual(JSON.parse(storage.get('practice-timer-v1')).steps,
    [{ type: 'work', minutes: 10 }, { type: 'rest', minutes: 5 }, { type: 'work', minutes: 35 }]);
  await elements.get('main-action').trigger('click');
  assert.equal(elements.get('clock').textContent, '10:00');
  await elements.get('skip').trigger('click');
  assert.equal(elements.get('clock').textContent, '05:00');
  await elements.get('skip').trigger('click');
  assert.equal(elements.get('clock').textContent, '35:00');
  const restored = mount(storage);
  await restored.elements.get('backup-save').trigger('click');
  const backup = JSON.parse(await restored.exportedBlob.text());
  assert.deepEqual(backup.steps, JSON.parse(storage.get('practice-timer-v1')).steps);
});

test('Routineのドラッグ中止・微小移動・タブ移動では順序を変えず、Cancelで保存済みの順序へ戻せる', async () => {
  const original = [{ type: 'work', minutes: 25 }, { type: 'rest', minutes: 5 }];
  const storage = new Map([['practice-timer-v1', JSON.stringify({ steps: original, totalWorkMs: 0 })]]);
  const app = mount(storage);
  const { elements } = app;
  await elements.get('settings-toggle').trigger('click');
  const list = elements.get('step-list');
  const handle = list.children[0].querySelector('button');
  const target = list.children[1];
  target.bounds = { top: 60, height: 48 };
  const pointer = { button: 0, pointerId: 1, clientX: 20, clientY: 10 };
  app.hit(target);
  for (const cancel of ['pointercancel', 'lostpointercapture', 'Escape', 'tab']) {
    await handle.trigger('pointerdown', pointer);
    await handle.trigger('pointermove', { ...pointer, clientY: 100 });
    if (cancel === 'Escape') await handle.trigger('keydown', { key: 'Escape' });
    else if (cancel === 'tab') await elements.get('nav-tasks').trigger('click');
    else await handle.trigger(cancel, pointer);
    await handle.trigger('pointerup', { ...pointer, clientY: 100 });
    assert.equal(list.children[0].querySelector('input').value, 25);
  }
  await handle.trigger('pointerdown', pointer);
  await handle.trigger('pointermove', { ...pointer, clientY: 12 });
  await handle.trigger('pointerup', { ...pointer, clientY: 12 });
  assert.equal(list.children[0].querySelector('input').value, 25);
  await elements.get('settings-toggle').trigger('click');
  await list.children[0].querySelector('button').trigger('keydown', { key: 'ArrowDown' });
  assert.equal(list.children[0].querySelector('input').value, 5);
  await elements.get('cancel-settings').trigger('click');
  await elements.get('settings-toggle').trigger('click');
  assert.equal(list.children[0].querySelector('input').value, 25);
  assert.deepEqual(JSON.parse(storage.get('practice-timer-v1')).steps, original);
  const remove = buttonNamed(list.children[0], '×');
  assert.equal(remove.getAttribute('aria-label'), 'Delete step 1');
  await remove.trigger('click');
  assert.equal(list.children.length, 1);
  assert.equal(list.children[0].querySelector('input').value, 5);
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
  assert.match(elements.get('status').textContent, /Sound is unavailable/);
  await elements.get('skip').trigger('click');
  assert.equal(elements.get('phase-name').getAttribute('aria-label'), 'Break · running');
  assert.match(elements.get('status').textContent, /Sound is unavailable/);
  const restored = mount(storage).elements;
  assert.equal(restored.get('status').textContent, '');
  assert.equal(restored.get('phase-name').getAttribute('aria-label'), 'Break · paused');
  assert.equal(restored.get('phase-paused').hidden, false);
  assert.equal(restored.get('main-action').getAttribute('aria-label'), 'Resume');
});

test('保存失敗は音の失敗で上書きしない', async () => {
  const storage = {
    get() { return JSON.stringify({ steps: [{ type: 'work', minutes: 25 }, { type: 'rest', minutes: 5 }], totalWorkMs: 0 }); },
    set() { throw new Error('storage full'); },
  };
  const { elements } = mount(storage);
  await elements.get('main-action').trigger('click');
  assert.match(elements.get('status').textContent, /Could not save in this browser/);
});

test('HTMLを直接開く構成で追加・保存・開始・次へが動く', async () => {
  const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
  assert.match(html, /<script defer src="timer-core\.js"><\/script>/);
  assert.match(html, /<script defer src="practice-data\.js\?rev=[a-f0-9]+"><\/script>/);
  assert.match(html, /<script defer src="app\.js\?rev=[a-f0-9]+"><\/script>/);
  assert.doesNotMatch(html, /type="module"/);
  assert.match(html, /class="beta">beta<\/span>/);
  assert.doesNotMatch(html, /id="sound-test"/);

  const { elements, storage } = mount();

  assert.equal(elements.get('timer-view').hidden, false);
  assert.equal(elements.get('main-action').getAttribute('aria-label'), 'Set up timer');
  assert.equal(elements.get('skip').hidden, true);
  assert.equal(elements.get('end').hidden, true);
  await elements.get('main-action').trigger('click');
  assert.equal(elements.get('settings-view').hidden, false);
  assert.equal(elements.get('permission').hidden, true);
  assert.equal(elements.get('notification-state').textContent, 'Unavailable');
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
  assert.equal(elements.get('phase-name').getAttribute('aria-label'), 'Work · running');
  assert.equal(elements.get('phase-icon').getAttribute('href'), '#icon-work');
  assert.equal(elements.get('main-action').getAttribute('aria-label'), 'Pause');
  assert.equal(elements.get('main-action-icon').getAttribute('href'), '#icon-pause');
  assert.equal(elements.get('skip').hidden, false);
  assert.equal(elements.get('skip').getAttribute('aria-label'), 'Skip to break');
  assert.equal(elements.get('phase-paused').hidden, true);
  const pauseClick = elements.get('main-action').trigger('click');
  assert.equal(elements.get('main-action').getAttribute('aria-label'), 'Resume');
  assert.equal(elements.get('main-action-icon').getAttribute('href'), '#icon-play');
  assert.equal(elements.get('phase-name').getAttribute('aria-label'), 'Work · paused');
  assert.equal(elements.get('phase-paused').hidden, false);
  const resumeClick = elements.get('main-action').trigger('click');
  assert.equal(elements.get('main-action').getAttribute('aria-label'), 'Pause');
  await Promise.all([startClick, pauseClick, resumeClick]);
  await elements.get('skip').trigger('click');
  assert.equal(elements.get('phase-name').getAttribute('aria-label'), 'Break · running');
  assert.equal(elements.get('phase-icon').getAttribute('href'), '#icon-rest');
  assert.equal(elements.get('skip').getAttribute('aria-label'), 'Next work phase');
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
  await elements.get('group-list').children[0].trigger('click');
  const childForm = elements.get('theme-details-content').querySelector('form');
  childForm.querySelector('input').value = '手';
  await childForm.trigger('submit');
  await elements.get('theme-details-close').trigger('click');
  const savedGroups = JSON.parse(storage.get('practice-timer-v1')).groups;
  const handId = savedGroups[0].children[0].id;

  await elements.get('nav-tasks').trigger('click');
  await elements.get('quick-task-form').trigger('submit');
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
  await elements.get('task-picker-list').children[0].querySelector('button').trigger('click');
  assert.equal(elements.get('task-picker-list').children[0].querySelector('button').disabled, true);
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
  await elements.get('backup-save').trigger('click');
  const backup = JSON.parse(await app.exportedBlob.text());
  assert.equal(backup.format, 'practice-timer-beta');
  assert.equal(backup.sessions.length, 2);
  assert.equal('note' in backup.sessions[1], false);
  assert.equal(JSON.stringify(backup).includes('data:image'), false);
  elements.get('import-file').files = [{ size: app.exportedBlob.size, text: () => app.exportedBlob.text() }];
  await elements.get('import-file').trigger('change');
  assert.match(elements.get('backup-status').textContent, /JSON imported/);
  assert.equal(elements.get('status').textContent, '');
  const beforeInvalidImport = storage.get('practice-timer-v1');
  elements.get('import-file').files = [{ size: 20, text: async () => '{"format":"wrong"}' }];
  await elements.get('import-file').trigger('change');
  assert.match(elements.get('backup-status').textContent, /Import cancelled/);
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
  assert.equal(elements.get('task-list').children.filter((row) => row.querySelector('input')).length, 1);
  const oldTask = elements.get('task-list').children[0];
  oldTask.querySelector('input').checked = true;
  await oldTask.querySelector('input').trigger('change');
  let saved = JSON.parse(storage.get('practice-timer-v1'));
  assert.equal(elements.get('task-list').children.filter((row) => row.querySelector('input')).length, 0);
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
  assert.equal(reopened.elements.get('task-list').children.filter((row) => row.querySelector('input')).length, 1);

  reopened.elements.get('quick-task-title').value = '配色を試す';
  await reopened.elements.get('quick-task-form').trigger('submit');
  saved = JSON.parse(storage.get('practice-timer-v1'));
  assert.equal(saved.tasks[0].title, '配色を試す');
  assert.equal(saved.tasks[0].targetId, null);
  assert.equal(reopened.elements.get('quick-task-title').value, '');
});

test('常時表示の入力欄から追加して選択し、計測開始で一覧を隠す', async () => {
  const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
  assert.match(html, /<form id="timer-quick-task-form"[\s\S]*?<button type="submit"[^>]*>＋<\/button>/);
  assert.doesNotMatch(html, /id="timer-task-add"|id="timer-task-details-add"/);
  const storage = new Map([['practice-timer-v1', JSON.stringify({
    steps: [{ type: 'work', minutes: 0.1 }, { type: 'rest', minutes: 0.1 }], totalWorkMs: 0,
  })]]);
  const { elements } = mount(storage);
  elements.get('timer-quick-task-title').value = 'あとで描く';
  await elements.get('timer-quick-task-form').trigger('submit');
  let saved = JSON.parse(storage.get('practice-timer-v1'));
  assert.equal(saved.tasks[0].title, 'あとで描く');
  assert.equal(saved.selectedTaskId, saved.tasks[0].id);
  assert.equal(elements.get('timer-quick-task-title').value, '');
  assert.equal(elements.get('active-task-panel').hidden, false);

  elements.get('timer-quick-task-title').value = '今から描く';
  await elements.get('timer-quick-task-form').trigger('submit');
  saved = JSON.parse(storage.get('practice-timer-v1'));
  assert.equal(saved.selectedTaskId, saved.tasks[0].id);
  assert.equal(elements.get('active-task-name').textContent, '今から描く');
  await elements.get('main-action').trigger('click');
  assert.equal(elements.get('active-task-panel').hidden, true);
  assert.equal(elements.get('task-picker-list').children[0].querySelector('button').disabled, true);

  elements.get('timer-quick-task-title').value = '次に描く';
  await elements.get('timer-quick-task-form').trigger('submit');
  saved = JSON.parse(storage.get('practice-timer-v1'));
  assert.equal(saved.tasks[0].title, '次に描く');
  assert.equal(saved.selectedTaskId, saved.tasks[1].id);
  assert.equal(elements.get('timer-quick-task-title').value, '');
  await elements.get('end').trigger('click');
  assert.equal(elements.get('active-task-panel').hidden, false);
  assert.equal(elements.get('skip').hidden, true);
  assert.equal(elements.get('end').hidden, true);
});

test('一覧から選び直し、計測・一時停止中は一覧を隠して選択とスクロール位置を保つ', async () => {
  const storage = new Map([['practice-timer-v1', JSON.stringify({
    steps: [{ type: 'work', minutes: 0.1 }, { type: 'rest', minutes: 0.1 }], totalWorkMs: 0,
  })]]);
  const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
  assert.match(html, /<div id="active-task-panel">[\s\S]*?<ul id="task-picker-list"/);
  assert.doesNotMatch(html, /id="task-picker-dialog"/);
  const first = mount(storage);
  for (const title of ['線を練習する', '構図を考える']) {
    first.elements.get('timer-quick-task-title').value = title;
    await first.elements.get('timer-quick-task-form').trigger('submit');
  }
  assert.equal(first.elements.get('task-picker-list').children[0].querySelector('button').disabled, false);
  await first.elements.get('task-picker-list').children[0].querySelector('button').trigger('click');
  assert.equal(first.elements.get('active-task-name').textContent, '構図を考える');
  assert.equal(first.elements.get('task-picker-list').children[0].querySelector('button').getAttribute('aria-pressed'), 'true');

  const second = mount(storage);
  const { elements } = second;
  assert.equal(elements.get('active-task-name').textContent, '構図を考える');
  await elements.get('task-picker-list').children[1].querySelector('button').trigger('click');
  const taskId = JSON.parse(storage.get('practice-timer-v1')).selectedTaskId;
  assert.equal(elements.get('active-task-name').textContent, '線を練習する');
  const list = elements.get('task-picker-list');
  list.scrollTop = 120;
  await elements.get('main-action').trigger('click');
  assert.equal(JSON.parse(storage.get('practice-timer-v1')).selectedTaskId, taskId);
  assert.equal(list.children.length, 2);
  assert.equal(elements.get('active-task-panel').hidden, true);
  assert.equal(list.children[0].querySelector('button').disabled, true);
  assert.equal(list.children[1].querySelector('button').getAttribute('aria-pressed'), 'true');
  assert.equal(list.scrollTop, 120);
  await list.children[0].querySelector('button').trigger('click');
  assert.equal(JSON.parse(storage.get('practice-timer-v1')).selectedTaskId, taskId);
  await elements.get('main-action').trigger('click');
  assert.equal(list.children[0].querySelector('button').disabled, true);
  assert.equal(elements.get('active-task-panel').hidden, true);
  await list.children[0].querySelector('button').trigger('click');
  assert.equal(JSON.parse(storage.get('practice-timer-v1')).selectedTaskId, taskId);
  assert.equal(list.scrollTop, 120);
  await elements.get('main-action').trigger('click');
  second.advance(2000);
  await elements.get('end').trigger('click');
  const saved = JSON.parse(storage.get('practice-timer-v1'));
  assert.equal(saved.sessions[0].taskId, taskId);
  assert.equal(saved.selectedTaskId, null);
  assert.equal(elements.get('task-picker-list').children[0].querySelector('button').disabled, false);

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

test('タスク画面でメモとテーマを後から編集し、タイマー側へ表示して計測できる', async () => {
  const storage = new Map([['practice-timer-v1', JSON.stringify({
    steps: [{ type: 'work', minutes: 0.1 }, { type: 'rest', minutes: 0.1 }], totalWorkMs: 0,
  })]]);
  const app = mount(storage);
  const { elements } = app;
  elements.get('group-title').value = '語学';
  await elements.get('group-form').trigger('submit');
  const group = JSON.parse(storage.get('practice-timer-v1')).groups[0];
  elements.get('timer-quick-task-title').value = '単語を覚える';
  await elements.get('timer-quick-task-form').trigger('submit');
  await elements.get('nav-tasks').trigger('click');
  await elements.get('task-list').children[0].querySelector('button').trigger('click');
  elements.get('task-first-step').value = '復習も含む\n例文を声に出す';
  elements.get('task-group').value = group.id;
  await elements.get('task-group').trigger('change');
  await elements.get('task-form').trigger('submit');
  await elements.get('task-list').children[0].querySelector('button').trigger('click');
  assert.equal(elements.get('task-first-step').value, '復習も含む\n例文を声に出す');
  await elements.get('task-cancel').trigger('click');
  await elements.get('nav-timer').trigger('click');
  assert.equal(elements.get('active-task-name').textContent, '単語を覚える');
  assert.equal(elements.get('active-task-hint').textContent, '復習も含む\n例文を声に出す');
  await elements.get('main-action').trigger('click');
  assert.equal(elements.get('active-task-panel').hidden, true);
  await elements.get('nav-tasks').trigger('click');
  const selectedRow = elements.get('task-list').children[0];
  await selectedRow.querySelector('button').trigger('click');
  assert.equal(elements.get('task-delete').disabled, true);
  await elements.get('task-delete').trigger('click');
  assert.equal(JSON.parse(storage.get('practice-timer-v1')).tasks.length, 1);
  await elements.get('task-cancel').trigger('click');
  assert.equal(buttonNamed(selectedRow, 'Use this task'), null);
  selectedRow.querySelector('input').checked = true;
  await selectedRow.querySelector('input').trigger('change');
  await elements.get('nav-timer').trigger('click');
  assert.equal(elements.get('active-task-name').textContent, '単語を覚える');
  assert.equal(elements.get('active-task-hint').textContent, '復習も含む\n例文を声に出す');
  app.advance(3000);
  await elements.get('end').trigger('click');
  const saved = JSON.parse(storage.get('practice-timer-v1'));
  assert.equal(saved.sessions[0].workMs, 3000);
  assert.equal(saved.sessions[0].targetId, group.id);
  assert.equal(saved.tasks[0].firstStep, '復習も含む\n例文を声に出す');
  assert.equal(elements.get('active-task-panel').hidden, false);
  const restored = mount(storage);
  await restored.elements.get('nav-tasks').trigger('click');
  const check = restored.elements.get('completed-list').children[0].querySelector('input');
  check.checked = false;
  await check.trigger('change');
  await restored.elements.get('nav-timer').trigger('click');
  await restored.elements.get('task-picker-list').children[0].querySelector('button').trigger('click');
  assert.equal(restored.elements.get('active-task-hint').textContent, saved.tasks[0].firstStep);
});

test('未選択で開始したときはタイマーで後選択でき、選択後は中央表示と固定を保つ', async () => {
  const storage = new Map([['practice-timer-v1', JSON.stringify({
    steps: [{ type: 'work', minutes: 1 }, { type: 'rest', minutes: 1 }], totalWorkMs: 0,
  })]]);
  const { elements } = mount(storage);
  await elements.get('main-action').trigger('click');
  assert.equal(elements.get('active-task-panel').hidden, false);
  assert.equal(elements.get('timer-layout').getAttribute('data-running'), 'false');
  await elements.get('nav-tasks').trigger('click');
  elements.get('quick-task-title').value = '読む';
  await elements.get('quick-task-form').trigger('submit');
  assert.equal(buttonNamed(elements.get('task-list').children[0], 'Use this task'), null);
  await elements.get('nav-timer').trigger('click');
  await elements.get('task-picker-list').children[0].querySelector('button').trigger('click');
  assert.equal(elements.get('active-task-panel').hidden, true);
  assert.equal(elements.get('active-task-name').textContent, '読む');
  const restored = mount(storage);
  assert.equal(restored.elements.get('active-task-panel').hidden, true);
  assert.equal(restored.elements.get('timer-layout').getAttribute('data-running'), 'true');
  assert.equal(restored.elements.get('active-task-name').textContent, '読む');
});

test('ドラッグで共有順序を保存し、上下キー・中止・再読み込み・JSONでもタスクと記録を保つ', async () => {
  const tasks = [
    { id: 'a', title: '読む', firstStep: '10ページ', targetId: null, completedAt: null },
    { id: 'b', title: '書く', firstStep: '自由なメモ', targetId: null, completedAt: null },
    { id: 'done', title: '済み', firstStep: '', targetId: null, completedAt: 900_000 },
    { id: 'c', title: '聞く', firstStep: '', targetId: null, completedAt: null },
  ];
  const storage = new Map([['practice-timer-v1', JSON.stringify({
    format: 'practice-timer-beta', version: 1, groups: [], tasks,
    steps: [{ type: 'work', minutes: 1 }, { type: 'rest', minutes: 1 }],
    sessions: [{ id: 'record', endedAt: 900_000, workMs: 5000, taskId: 'a', taskTitle: '読む' }],
    run: null, selectedTaskId: 'b', totalWorkMs: 5000,
  })]]);
  const app = mount(storage);
  const { elements } = app;
  const picker = elements.get('task-picker-list');
  const handle = picker.children[0].children.at(-1);
  const target = picker.children[2];
  target.bounds = { top: 120, height: 56 };
  const pointer = { button: 0, pointerId: 1, clientX: 200, clientY: 10 };
  await handle.trigger('pointerdown', pointer);
  app.hit(target);
  await handle.trigger('pointermove', { ...pointer, clientY: 170 });
  await handle.trigger('pointerup', { ...pointer, clientY: 170 });
  let saved = JSON.parse(storage.get('practice-timer-v1'));
  assert.deepEqual(saved.tasks.filter((task) => task.completedAt == null).map((task) => task.id), ['b', 'c', 'a']);
  assert.equal(saved.selectedTaskId, 'b');
  assert.deepEqual(saved.tasks.find((task) => task.id === 'b'), tasks[1]);
  assert.deepEqual(saved.tasks.find((task) => task.id === 'done'), tasks[2]);
  assert.equal(saved.sessions[0].taskId, 'a');
  assert.equal(saved.totalWorkMs, 5000);

  await elements.get('main-action').trigger('click');
  await elements.get('nav-tasks').trigger('click');
  await elements.get('task-list').children[0].children.at(-1).trigger('keydown', { key: 'ArrowDown' });
  saved = JSON.parse(storage.get('practice-timer-v1'));
  assert.deepEqual(saved.tasks.filter((task) => task.completedAt == null).map((task) => task.id), ['c', 'b', 'a']);
  assert.equal(saved.selectedTaskId, 'b');
  assert.deepEqual(picker.children.map((row) => row.children[0].textContent), ['聞く', '書く', '読む']);
  const beforeCancel = storage.get('practice-timer-v1');
  const cancelHandle = elements.get('task-list').children[0].children.at(-1);
  await cancelHandle.trigger('pointerdown', pointer);
  const cancelTarget = elements.get('task-list').children[2];
  cancelTarget.bounds = { top: 120, height: 56 };
  app.hit(cancelTarget);
  await cancelHandle.trigger('pointermove', { ...pointer, clientY: 170 });
  await cancelHandle.trigger('pointercancel', pointer);
  await cancelHandle.trigger('pointerup', { ...pointer, clientY: 170 });
  assert.equal(storage.get('practice-timer-v1'), beforeCancel);
  const restored = mount(storage);
  assert.deepEqual(restored.elements.get('task-picker-list').children.map((row) => row.children[0].textContent), ['聞く', '書く', '読む']);
  assert.equal(restored.elements.get('active-task-hint').textContent, '自由なメモ');
  assert.equal(restored.elements.get('active-task-panel').hidden, true);
  await restored.elements.get('backup-save').trigger('click');
  const backup = JSON.parse(await restored.exportedBlob.text());
  assert.deepEqual(backup.tasks.map((task) => task.id), saved.tasks.map((task) => task.id));
});

test('空欄の+Addは詳細入力を開き、タイトル入力済みなら即追加し、タスク名から直接編集できる', async () => {
  const { elements, storage } = mount();
  const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
  assert.doesNotMatch(html, /id="task-details-add"/);
  assert.doesNotMatch(html.match(/<form id="quick-task-form"[\s\S]*?<\/form>/)[0], /required/);
  await elements.get('nav-tasks').trigger('click');
  elements.get('quick-task-title').value = '  ';
  await elements.get('quick-task-form').trigger('submit');
  assert.equal(elements.get('task-dialog').open, true);
  assert.equal(elements.get('task-title').value, '');
  assert.equal(elements.get('task-delete').hidden, true);
  await elements.get('task-cancel').trigger('click');
  assert.equal(storage.has('practice-timer-v1'), false);
  elements.get('quick-task-title').value = '構図を考える';
  await elements.get('quick-task-form').trigger('submit');
  assert.equal(elements.get('task-dialog').open, false);
  assert.equal(elements.get('quick-task-title').value, '');
  const taskId = JSON.parse(storage.get('practice-timer-v1')).tasks[0].id;
  const row = elements.get('task-list').children[0];
  assert.equal(row.querySelector('summary'), null);
  assert.equal(row.querySelector('details'), null);
  assert.equal(buttonNamed(row, 'Use this task'), null);
  await row.querySelector('button').trigger('click');
  assert.equal(elements.get('task-dialog').open, true);
  assert.equal(elements.get('task-dialog-title').textContent, 'Edit task');
  assert.equal(elements.get('task-title').value, '構図を考える');
  assert.equal(elements.get('task-save').textContent, 'Save changes');
  assert.equal(elements.get('task-delete').hidden, false);
  assert.equal(elements.get('task-delete').disabled, false);
  elements.get('task-first-step').value = 'ラフを3案描く';
  await elements.get('task-form').trigger('submit');
  assert.equal(JSON.parse(storage.get('practice-timer-v1')).tasks[0].firstStep, 'ラフを3案描く');
  assert.equal(JSON.parse(storage.get('practice-timer-v1')).selectedTaskId, null);
  await elements.get('nav-timer').trigger('click');
  await elements.get('task-picker-list').children[0].querySelector('button').trigger('click');
  assert.equal(elements.get('active-task-hint').textContent, 'ラフを3案描く');
  assert.equal(JSON.parse(storage.get('practice-timer-v1')).selectedTaskId, taskId);
});

test('編集のCancelと削除確認の取り消しで内容を保ち、Deleteしても過去の記録は残す', async () => {
  let approve = false;
  const original = {
    format: 'practice-timer-beta', version: 1, steps: [], run: null, totalWorkMs: 2000,
    tasks: [
      { id: 'task', title: '構図を考える', firstStep: 'ラフを3案', targetId: null, completedAt: null },
      { id: 'done', title: '済み', firstStep: '', targetId: null, completedAt: 800 },
    ],
    groups: [], sessions: [{ id: 'record', endedAt: 1000, workMs: 2000, taskId: 'task', taskTitle: '構図を考える' }],
    selectedTaskId: 'task',
  };
  const storage = new Map([['practice-timer-v1', JSON.stringify(original)]]);
  const { elements } = mount(storage, undefined, 1_000_000, context => { context.confirm = () => approve; });
  await elements.get('nav-tasks').trigger('click');
  await elements.get('task-list').children[0].querySelector('button').trigger('click');
  elements.get('task-title').value = '未保存の変更';
  await elements.get('task-cancel').trigger('click');
  assert.equal(JSON.parse(storage.get('practice-timer-v1')).tasks[0].title, '構図を考える');
  await elements.get('task-list').children[0].querySelector('button').trigger('click');
  await elements.get('task-delete').trigger('click');
  assert.equal(elements.get('task-dialog').open, true);
  assert.equal(JSON.parse(storage.get('practice-timer-v1')).tasks.length, 2);
  approve = true;
  await elements.get('task-delete').trigger('click');
  const saved = JSON.parse(storage.get('practice-timer-v1'));
  assert.deepEqual(saved.tasks.map(task => task.id), ['done']);
  assert.equal(saved.selectedTaskId, null);
  assert.equal(saved.totalWorkMs, 2000);
  assert.equal(saved.sessions[0].taskTitle, '構図を考える');
  assert.equal(saved.sessions[0].taskId, 'task');
  assert.equal(elements.get('task-dialog').open, false);
  await elements.get('completed-list').children[0].querySelector('button').trigger('click');
  assert.equal(elements.get('task-title').value, '済み');
  assert.equal(elements.get('task-delete').hidden, false);
  await elements.get('task-delete').trigger('click');
  assert.equal(JSON.parse(storage.get('practice-timer-v1')).tasks.length, 0);
  assert.equal(JSON.parse(storage.get('practice-timer-v1')).sessions.length, 1);
});

test('先頭へ追加し、未選択タスクは選択、選択済みタスクは再クリックで詳細を編集できる', async () => {
  const { elements, storage } = mount();
  for (const title of ['古いタスク', '新しいタスク']) {
    elements.get('timer-quick-task-title').value = title;
    await elements.get('timer-quick-task-form').trigger('submit');
  }
  const list = elements.get('task-picker-list');
  assert.deepEqual(list.children.map((row) => row.children[0].textContent), ['新しいタスク', '古いタスク']);
  const button = list.children[1].children[0];
  list.scrollTop = 120;
  await button.trigger('click');
  assert.equal(list.scrollTop, 120);
  assert.equal(list.children[1].children[0], button);
  assert.equal(elements.get('task-dialog').open, false);
  assert.equal(button.getAttribute('aria-pressed'), 'true');
  await button.trigger('click');
  assert.equal(elements.get('task-dialog').open, true);
  assert.equal(elements.get('task-title').value, '古いタスク');
  elements.get('task-first-step').value = '詳細を保存';
  await elements.get('task-form').trigger('submit');
  assert.equal(JSON.parse(storage.get('practice-timer-v1')).tasks[1].firstStep, '詳細を保存');
  await elements.get('nav-tasks').trigger('click');
  await elements.get('quick-task-form').trigger('submit');
  elements.get('task-title').value = '詳細付きの新規';
  await elements.get('task-form').trigger('submit');
  assert.equal(JSON.parse(storage.get('practice-timer-v1')).tasks[0].title, '詳細付きの新規');
});

test('計測中は中央表示し、上部タイトルのポップアップから編集して記録に反映できる', async () => {
  const app = mount(new Map([['practice-timer-v1', JSON.stringify({
    format: 'practice-timer-beta', version: 1,
    steps: [{ type: 'work', minutes: 1 }, { type: 'rest', minutes: 1 }],
    groups: [{ id: 'g', title: '語学', children: [{ id: 'c', title: '発音' }] }],
    tasks: [{ id: 'task', title: '練習', firstStep: '', targetId: null, completedAt: null }],
    sessions: [], totalWorkMs: 0, run: null, selectedTaskId: 'task',
  })]]));
  const { elements } = app;
  assert.equal(elements.get('timer-layout').getAttribute('data-running'), 'false');
  await elements.get('main-action').trigger('click');
  assert.equal(elements.get('active-task-panel').hidden, true);
  assert.equal(elements.get('timer-layout').getAttribute('data-running'), 'true');
  assert.equal(elements.has('timer-task-details'), false);
  await elements.get('main-action').trigger('click');
  assert.equal(elements.get('timer-layout').getAttribute('data-running'), 'true');
  await elements.get('active-task-name').trigger('click');
  assert.equal(elements.get('task-dialog').open, true);
  assert.equal(elements.get('task-title').value, '練習');
  elements.get('task-title').value = '  ';
  await elements.get('task-form').trigger('submit');
  assert.equal(JSON.parse(app.storage.get('practice-timer-v1')).tasks[0].title, '練習');
  elements.get('task-title').value = '発音を練習';
  elements.get('task-first-step').value = '今の気づき\n次に試すこと';
  elements.get('task-group').value = 'g';
  await elements.get('task-group').trigger('change');
  assert.equal(elements.get('task-child').disabled, false);
  elements.get('task-child').value = 'c';
  await elements.get('task-form').trigger('submit');
  assert.equal(elements.get('task-dialog').open, false);
  assert.equal(elements.get('active-task-name').textContent, '発音を練習');
  const restored = mount(app.storage);
  assert.equal(restored.elements.get('active-task-name').textContent, '発音を練習');
  assert.equal(restored.elements.get('active-task-hint').textContent, '今の気づき\n次に試すこと');
  await elements.get('main-action').trigger('click');
  app.advance(3000);
  await elements.get('end').trigger('click');
  assert.equal(elements.get('active-task-panel').hidden, false);
  assert.equal(elements.get('timer-layout').getAttribute('data-running'), 'false');
  assert.equal(elements.get('status').textContent, '');
  const saved = JSON.parse(app.storage.get('practice-timer-v1'));
  assert.equal(saved.tasks[0].firstStep, '今の気づき\n次に試すこと');
  assert.equal(saved.sessions[0].targetId, 'c');
  assert.equal(saved.sessions[0].taskTitle, '発音を練習');
  assert.equal(saved.sessions[0].workMs, 3000);
});

test('完了と取り消しでスクロールを保ち、通知は最後の完了から5秒で消える', async () => {
  const app = mount(new Map([['practice-timer-v1', JSON.stringify({
    format: 'practice-timer-beta', version: 1, steps: [], groups: [], sessions: [], run: null, totalWorkMs: 0,
    tasks: ['a', 'b', 'c'].map((id) => ({ id, title: id, firstStep: '', targetId: null, completedAt: null })),
  })]]));
  const { elements, viewport } = app;
  await elements.get('nav-tasks').trigger('click');
  viewport.scrollY = 600;
  elements.get('task-undo').onFocus = () => { viewport.scrollY = 0; };
  const completeFirst = async () => {
    const check = elements.get('task-list').children[0].querySelector('input');
    check.checked = true;
    await check.trigger('change');
  };
  await completeFirst();
  assert.equal(viewport.scrollY, 600);
  assert.equal(elements.get('task-list').children[0].querySelector('input').focusOptions.preventScroll, true);
  assert.equal(elements.get('task-toast').hidden, false);
  await elements.get('task-undo').trigger('click');
  assert.equal(viewport.scrollY, 600);
  assert.equal(elements.get('task-toast').hidden, true);
  assert.equal(JSON.parse(app.storage.get('practice-timer-v1')).tasks[0].completedAt, null);
  await completeFirst();
  app.advance(3000);
  await completeFirst();
  app.advance(2000);
  app.flushDueTimeouts();
  assert.equal(elements.get('task-toast').hidden, false);
  assert.equal(elements.get('task-undo').hidden, false);
  assert.match(elements.get('task-status').textContent, /b/);
  app.advance(2999);
  app.flushDueTimeouts();
  assert.equal(elements.get('task-toast').hidden, false);
  app.advance(1);
  app.flushDueTimeouts();
  assert.equal(elements.get('task-toast').hidden, true);
  const saved = app.storage.get('practice-timer-v1');
  await elements.get('task-undo').trigger('click');
  assert.equal(app.storage.get('practice-timer-v1'), saved);
});

test('既存タイマーの累計はテーマ未設定の記録として一度だけ引き継ぐ', async () => {
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

test('作業時間をh・m表記に統一し、秒の精度と開始・終了時刻を保持する', async () => {
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
  assert.equal(elements.get('growth-total').textContent, '1h 00m');
  assert.equal(elements.get('growth-all-total').textContent, 'All time 126h 30m');
  await elements.get('nav-themes').trigger('click');
  await elements.get('theme-period-day').trigger('click');
  const group = elements.get('group-list').children[0];
  assert.equal(group.children[0].textContent, '人体');
  assert.equal(group.children[1].children[0].children[1].textContent, '1h 00m');
  await group.trigger('click');
  assert.equal(elements.get('theme-details-dialog').open, true);
  const detail = elements.get('theme-details-content');
  const child = detail.querySelector('tbody').children[0];
  assert.equal(child.children[0].textContent, '手');
  assert.equal(child.children[2].textContent, '0h 25m');
  assert.equal(detail.children[2].textContent, 'No subtheme 0h 34m');
  await elements.get('theme-details-close').trigger('click');
  await elements.get('nav-growth').trigger('click');
  const records = elements.get('record-list').children;
  assert.deepEqual(records[0].children[0].children.map((item) => item.textContent), ['手を描く', '0h 25m']);
  assert.equal(records[0].children[1].children[0].textContent, '10:00 – 10:25');
  assert.equal(records[0].children[1].children.length, 1);
  const edit = records[0].children[2];
  assert.equal(edit.textContent, '');
  assert.equal(edit.getAttribute('aria-label'), 'Edit or delete record: 手を描く');
  assert.equal(edit.children[0].children[0].getAttribute('href'), '#icon-work');
  assert.equal(records[2].children[0].children[1].textContent, '0h 00m');
  await elements.get('period-next').trigger('click');
  assert.equal(elements.get('growth-total').textContent, '125h 30m');
  const legacy = elements.get('record-list').children[0];
  assert.equal(legacy.children[1].children[0].textContent, 'No start time – 10:00');
  assert.equal(storage.get('practice-timer-v1'), original);
});

test('テーマの横棒は共通目盛りで0時間も示し、サブテーマの最長時間を目安にする', async () => {
  const now = +new Date(2026, 10, 12, 12);
  const groups = [
    { id: 'practice', title: '実践練習', children: [] },
    { id: 'color', title: '配色', children: [
      { id: 'light', title: '明暗' }, { id: 'hue', title: '色相' }, { id: 'contrast', title: '対比' },
    ] },
    { id: 'composition', title: '構図', children: [] },
  ];
  const sessions = [
    { id: 'practice-record', startedAt: null, endedAt: now, workMs: 360_000_000, targetId: 'practice' },
    { id: 'light-record', startedAt: null, endedAt: now, workMs: 9_000_000, targetId: 'light' },
    { id: 'hue-record', startedAt: null, endedAt: now - 86_400_000, workMs: 10_800_000, targetId: 'hue' },
  ];
  const original = JSON.stringify({ format: 'practice-timer-beta', version: 1,
    steps: [], tasks: [], groups, sessions, totalWorkMs: 379_800_000, run: null });
  const { elements, storage } = mount(new Map([['practice-timer-v1', original]]), undefined, now);
  await elements.get('nav-themes').trigger('click');
  assert.equal(elements.get('themes-view').hidden, false);
  assert.equal(elements.get('growth-view').hidden, true);
  assert.equal(elements.get('nav-themes').getAttribute('aria-current'), 'page');
  assert.equal(elements.get('theme-period-all').getAttribute('aria-pressed'), 'true');
  assert.equal(elements.get('theme-scale-max').textContent, '100h 00m');
  const cards = elements.get('group-list').children;
  assert.equal(cards.length, 3);
  const practiceBar = cards[0].children[1];
  const colorBar = cards[1].children[1];
  const compositionBar = cards[2].children[1];
  assert.equal(practiceBar.children[0].children[1].textContent, '100h 00m');
  assert.equal(practiceBar.children[1].children[0].style.width, '100%');
  assert.equal(colorBar.children[0].children[1].textContent, '5h 30m');
  assert.equal(colorBar.children[1].children[0].style.width, '5.5%');
  assert.equal(compositionBar.children[0].children[1].textContent, '0h 00m');
  assert.equal(compositionBar.children[1].children[0].style.width, '0%');
  await cards[1].trigger('click');
  assert.equal(elements.get('theme-details-dialog').open, true);
  assert.equal(elements.get('theme-details-content').children[1].children[1].textContent, 'Reference 3h 00m');
  const subRows = elements.get('theme-details-content').querySelector('tbody').children;
  assert.deepEqual(subRows.map((row) => row.children[2].textContent), ['2h 30m', '3h 00m', '0h 00m']);
  assert.equal(subRows[0].children[1].children[0].children[0].style.width, `${2.5 / 3 * 100}%`);
  assert.equal(subRows[2].children[1].children[0].children[0].style.width, '0%');
  assert.ok(subRows.every((row) => row.children[1].children[1].style.left === '100%'));
  await elements.get('theme-details-close').trigger('click');
  assert.equal(elements.get('theme-details-dialog').open, false);
  await elements.get('theme-period-day').trigger('click');
  const todayColor = elements.get('group-list').children[1];
  await todayColor.trigger('click');
  assert.equal(elements.get('theme-details-content').children[1].children[1].textContent, 'Reference 2h 30m');
  assert.deepEqual(elements.get('theme-details-content').querySelector('tbody').children.map((row) => row.children[2].textContent),
    ['2h 30m', '0h 00m', '0h 00m']);
  await elements.get('theme-details-close').trigger('click');
  await elements.get('theme-period-prev').trigger('click');
  assert.match(elements.get('theme-period-label').textContent, /2026\/11\/11/);
  await elements.get('nav-timer').trigger('click');
  await elements.get('nav-themes').trigger('click');
  assert.equal(elements.get('theme-details-dialog').open, false);
  assert.equal(elements.get('theme-period-day').getAttribute('aria-pressed'), 'true');
  assert.equal(storage.get('practice-timer-v1'), original);
});

test('テーマとサブテーマの名前はアプリ内で変更でき、記録と時間を保つ', async () => {
  const original = JSON.stringify({ format: 'practice-timer-beta', version: 1,
    steps: [], tasks: [], run: null, totalWorkMs: 600_000,
    groups: [{ id: 'theme', title: '人体', children: [{ id: 'subtheme', title: '手' }] }],
    sessions: [{ id: 'record', startedAt: null, endedAt: 1_000_000, workMs: 600_000, targetId: 'subtheme' }],
  });
  const { elements, storage } = mount(new Map([['practice-timer-v1', original]]));
  await elements.get('nav-themes').trigger('click');
  const findRename = (card, name) => {
    const visit = (node) => node.getAttribute('aria-label') === name ? node
      : node.children.map(visit).find(Boolean);
    return visit(card);
  };
  await elements.get('group-list').children[0].trigger('click');
  await findRename(elements.get('theme-details-title'), 'Rename 人体').trigger('click');
  assert.equal(elements.get('theme-name-dialog').open, true);
  assert.equal(elements.get('theme-name-title').textContent, 'Theme name');
  elements.get('theme-name').value = '  ';
  await elements.get('theme-name-form').trigger('submit');
  assert.match(elements.get('theme-name-error').textContent, /1 and 60 characters/);
  assert.equal(storage.get('practice-timer-v1'), original);
  elements.get('theme-name').value = '人体練習';
  await elements.get('theme-name-form').trigger('submit');
  assert.equal(elements.get('theme-name-dialog').open, false);
  await findRename(elements.get('theme-details-content'), 'Rename 手').trigger('click');
  assert.equal(elements.get('theme-name-title').textContent, 'Subtheme name');
  elements.get('theme-name').value = '手の形';
  await elements.get('theme-name-form').trigger('submit');
  const saved = JSON.parse(storage.get('practice-timer-v1'));
  assert.equal(saved.groups[0].title, '人体練習');
  assert.equal(saved.groups[0].children[0].title, '手の形');
  assert.equal(saved.sessions[0].targetId, 'subtheme');
  assert.equal(saved.totalWorkMs, 600_000);
});

test('名前横のペンから削除でき、確認の取り消しと記録・時間の保持ができる', async () => {
  const original = JSON.stringify({ format: 'practice-timer-beta', version: 1,
    steps: [], run: null, totalWorkMs: 900_000,
    tasks: [{ id: 'task', title: '手を描く', firstStep: '', targetId: 'hand', completedAt: null }],
    groups: [{ id: 'body', title: '人体', children: [{ id: 'hand', title: '手' }, { id: 'foot', title: '足' }] }],
    sessions: [
      { id: 'record', startedAt: null, endedAt: 1_000_000, workMs: 600_000, targetId: 'hand' },
      { id: 'direct', startedAt: null, endedAt: 1_000_000, workMs: 300_000, targetId: 'body' },
    ],
  });
  let accept = false;
  const { elements, storage } = mount(new Map([['practice-timer-v1', original]]), undefined, 1_000_000,
    context => { context.confirm = () => accept; });
  const find = (node, label) => node.getAttribute('aria-label') === label ? node : node.children.map(child => find(child, label)).find(Boolean);
  await elements.get('nav-themes').trigger('click');
  let card = elements.get('group-list').children[0];
  await card.trigger('click');
  let prevented = false, stopped = false;
  await find(elements.get('theme-details-title'), 'Rename 人体').trigger('click', {
    preventDefault() { prevented = true; }, stopPropagation() { stopped = true; },
  });
  assert.equal(prevented, true);
  assert.equal(stopped, true);
  assert.equal(elements.get('theme-name-delete').textContent, 'Delete theme');
  await elements.get('theme-name-delete').trigger('click');
  assert.equal(elements.get('theme-name-dialog').open, true);
  assert.equal(storage.get('practice-timer-v1'), original);
  await elements.get('theme-name-cancel').trigger('click');
  const childCell = elements.get('theme-details-content').querySelector('tbody').children[0].children[0];
  await find(childCell, 'Rename 手').trigger('click');
  assert.equal(elements.get('theme-name-delete').textContent, 'Delete subtheme');
  elements.get('theme-name').value = '';
  accept = true;
  await elements.get('theme-name-delete').trigger('click');
  assert.equal(elements.get('theme-name-dialog').open, false);
  let saved = JSON.parse(storage.get('practice-timer-v1'));
  assert.deepEqual(saved.groups[0].children.map(child => child.id), ['foot']);
  assert.equal(saved.tasks[0].targetId, null);
  assert.equal(saved.sessions[0].targetId, null);
  assert.equal(saved.sessions[1].targetId, 'body');
  assert.equal(saved.totalWorkMs, 900_000);
  card = elements.get('group-list').children[0];
  assert.equal(elements.get('theme-details-dialog').open, true);
  await find(elements.get('theme-details-title'), 'Rename 人体').trigger('click');
  await elements.get('theme-name-delete').trigger('click');
  saved = JSON.parse(storage.get('practice-timer-v1'));
  assert.equal(saved.groups.length, 0);
  assert.equal(saved.sessions.length, 2);
  assert.equal(saved.tasks.length, 1);
  assert.equal(saved.sessions[1].targetId, null);
  assert.equal(saved.totalWorkMs, 900_000);
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
  assert.equal(row.children[0].children[1].textContent, '0h 30m');
  assert.equal(row.children[0].children[1].children[0].textContent, 'This day');
  assert.equal(row.children[1].children[0].textContent, '23:30 – 1/2 01:00');
  await elements.get('period-next').trigger('click');
  row = elements.get('record-list').children[0];
  assert.equal(row.children[0].children[1].textContent, '1h 00m');
  assert.equal(row.children[1].children[0].textContent, '1/1 23:30 – 01:00');
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
  assert.equal(elements.get('growth-total').textContent, '0h 40m');
  const bars = elements.get('period-chart').children;
  assert.equal(bars.length, 24);
  assert.equal(bars[0].getAttribute('aria-label'), '05:00 – 06:00 0h 00m');
  assert.equal(bars[23].getAttribute('aria-label'), '04:00 – 05:00 0h 10m');
  assert.equal(elements.get('period-chart-max').textContent, '1h 00m');
  assert.equal(elements.get('day-untimed').hidden, false);
  assert.equal(elements.get('day-untimed').textContent, 'No start time 0h 10m');
  await elements.get('period-week').trigger('click');
  assert.equal(elements.get('period-label').textContent, '2026/11/9 – 2026/11/15');
  await elements.get('period-day').trigger('click');
  await elements.get('period-next').trigger('click');
  assert.equal(elements.get('growth-total').textContent, '0h 10m');
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
  assert.equal(elements.get('period-chart').children[0].getAttribute('aria-label'), '23:30 – 00:30 0h 20m');
  await elements.get('period-next').trigger('click');
  assert.match(elements.get('period-label').textContent, /2026\/11\/12/);
  await elements.get('period-prev').trigger('click');
  assert.match(elements.get('period-label').textContent, /2026\/11\/11/);
  await elements.get('period-month').trigger('click');
  await elements.get('period-chart').children[0].trigger('click');
  assert.match(elements.get('period-label').textContent, /2026\/11\/1 \(Sun\)/);
  assert.equal(elements.get('period-chart').children.length, 24);
  await elements.get('settings-toggle').trigger('click');
  await elements.get('backup-save').trigger('click');
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
    assert.match(elements.get('backup-status').textContent, /Invalid day boundary setting/);
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

test('円の残り割合とLoggedは一時停止・休憩を除外し、計測中の設定変更でも元の工程に従う', async () => {
  const app = mount(new Map([['practice-timer-v1', JSON.stringify({
    steps: [{ type: 'work', minutes: 4 }, { type: 'rest', minutes: 2 }], totalWorkMs: 0,
  })]]));
  const { elements } = app;
  const ring = () => elements.get('timer-ring-remaining').getAttribute('stroke-dasharray');
  assert.equal(ring(), '100 100');
  assert.equal(elements.get('timer-logged').textContent, '0h 00m');
  await elements.get('main-action').trigger('click');
  app.advance(60_000);
  await elements.get('main-action').trigger('click');
  assert.equal(ring(), '75 100');
  assert.equal(elements.get('timer-logged').textContent, '0h 01m');
  app.advance(120_000);
  await elements.get('main-action').trigger('click');
  assert.equal(ring(), '75 100');
  assert.equal(elements.get('timer-logged').textContent, '0h 01m');
  app.advance(60_000);
  await elements.get('skip').trigger('click');
  assert.equal(ring(), '100 100');
  assert.equal(elements.get('phase-icon').getAttribute('href'), '#icon-rest');
  assert.equal(elements.get('timer-logged').textContent, '0h 02m');
  app.advance(30_000);
  await elements.get('main-action').trigger('click');
  assert.equal(ring(), '75 100');
  assert.equal(elements.get('timer-logged').textContent, '0h 02m');
  await elements.get('settings-toggle').trigger('click');
  for (const row of elements.get('step-list').children) {
    row.querySelector('input').value = '1';
    await row.querySelector('input').trigger('input');
  }
  await elements.get('save-settings').trigger('click');
  assert.equal(ring(), '75 100');
  await elements.get('end').trigger('click');
  assert.equal(elements.get('clock').textContent, '01:00');
  assert.equal(ring(), '100 100');
  assert.equal(elements.get('timer-logged').textContent, '0h 00m');
  const saved = JSON.parse(app.storage.get('practice-timer-v1'));
  assert.equal(saved.totalWorkMs, 120_000);
  assert.equal(saved.sessions.reduce((sum, record) => sum + record.workMs, 0), 120_000);
});

test('ReviewのAllから年・月・日に移動でき、全期間合計を変えない', async () => {
  const now = +new Date(2026, 10, 13, 12);
  const sessions = [2024, 2026].map((year, index) => ({ id: `record-${year}`, startedAt: null,
    endedAt: +new Date(year, 10, 12, 12), workMs: (index + 1) * 3_600_000, targetId: null }));
  const original = JSON.stringify({ format: 'practice-timer-beta', version: 1, steps: [], tasks: [], groups: [],
    sessions, totalWorkMs: 10_800_000, run: null });
  const { elements, storage } = mount(new Map([['practice-timer-v1', original]]), undefined, now);
  await elements.get('nav-growth').trigger('click');
  await elements.get('period-all').trigger('click');
  assert.equal(elements.get('growth-total').textContent, '3h 00m');
  assert.equal(elements.get('period-label').textContent, 'All time');
  assert.equal(elements.get('period-prev').hidden, true);
  assert.equal(elements.get('day-records').hidden, true);
  const years = elements.get('period-chart').children;
  assert.deepEqual(years.map(bar => bar.children[1].textContent), ['2024', '2025', '2026']);
  assert.equal(years[1].children[0].children[0].style.height, '0%');
  await years[2].trigger('click');
  assert.equal(elements.get('period-year').getAttribute('aria-pressed'), 'true');
  assert.equal(elements.get('growth-total').textContent, '2h 00m');
  assert.equal(elements.get('period-prev').hidden, false);
  await elements.get('period-chart').children[10].trigger('click');
  assert.equal(elements.get('period-month').getAttribute('aria-pressed'), 'true');
  assert.equal(elements.get('period-chart').children.length, 30);
  await elements.get('period-chart').children[11].trigger('click');
  assert.equal(elements.get('period-day').getAttribute('aria-pressed'), 'true');
  assert.equal(elements.get('record-list').children.length, 1);
  assert.equal(storage.get('practice-timer-v1'), original);
});

test('通知状態はブラウザの実際の許可を示し、未許可のときだけ許可を求める', async () => {
  for (const [permission, label, hidden] of [['granted', 'On', true], ['denied', 'Blocked', true], ['default', 'Off', false]]) {
    let requested = 0;
    const notification = { permission, async requestPermission() { requested++; this.permission = 'granted'; return 'granted'; } };
    const app = mount(new Map(), undefined, 1_000_000, context => { context.window.Notification = notification; });
    await app.elements.get('settings-toggle').trigger('click');
    assert.equal(app.elements.get('notification-state').textContent, label);
    assert.equal(app.elements.get('permission').hidden, hidden);
    assert.equal(requested, 0);
    await app.elements.get('permission').trigger('click');
    assert.equal(requested, permission === 'default' ? 1 : 0);
    assert.equal(app.elements.get('notification-state').textContent, permission === 'denied' ? 'Blocked' : 'On');
    notification.permission = 'denied';
    await app.elements.get('nav-timer').trigger('click');
    await app.elements.get('settings-toggle').trigger('click');
    assert.equal(app.elements.get('notification-state').textContent, 'Blocked');
  }
});
