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
  focus() {}
  async trigger(type) { return this.listeners.get(type)?.(); }
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

test('HTMLを直接開く構成で追加・保存・開始・次へが動く', async () => {
  const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
  assert.match(html, /<script defer src="timer-core\.js"><\/script>/);
  assert.match(html, /<script defer src="app\.js"><\/script>/);
  assert.doesNotMatch(html, /type="module"/);

  const elements = new Map([...html.matchAll(/id="([^"]+)"/g)].map((match) => [match[1], new Element()]));
  const document = {
    getElementById: (id) => elements.get(id),
    createElement: (tag) => new Element(tag),
  };
  const storage = new Map();
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
    Date,
  });
  vm.runInContext(readFileSync(new URL('./timer-core.js', import.meta.url), 'utf8'), context);
  vm.runInContext(readFileSync(new URL('./app.js', import.meta.url), 'utf8'), context);

  assert.equal(elements.get('settings-view').hidden, false);
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
  await elements.get('main-action').trigger('click');
  assert.equal(elements.get('phase-name').textContent, '作業');
  assert.equal(elements.get('main-action').textContent, '一時停止');
  await elements.get('skip').trigger('click');
  assert.equal(elements.get('phase-name').textContent, '休憩');
  assert.ok(storage.has('practice-timer-v1'));
});
