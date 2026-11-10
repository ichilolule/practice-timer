(() => {
'use strict';

const { advanceClock, createRun, normalizeSteps, pauseRun, resumeRun, restoreRun, skipPhase } = globalThis.TimerCore;

const STORAGE_KEY = 'practice-timer-v1';
const $ = (id) => document.getElementById(id);
let steps = [];
let draft = [];
let run = null;
let totalWorkMs = 0;
let audioContext = null;
let lastSaved = 0;

function load() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    if (Array.isArray(saved.steps) && saved.steps.length) steps = normalizeSteps(saved.steps);
    if (Number.isFinite(saved.totalWorkMs) && saved.totalWorkMs >= 0) totalWorkMs = saved.totalWorkMs;
    run = restoreRun(saved.run);
    if (run) totalWorkMs = run.totalWorkMs;
  } catch {
    $('status').textContent = '保存データを読めませんでした。設定を確認してください。';
  }
}

function persist() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, steps, run, totalWorkMs: run?.totalWorkMs ?? totalWorkMs }));
    lastSaved = Date.now();
  } catch {
    $('status').textContent = 'ブラウザに保存できません。ストレージの設定を確認してください。';
  }
}

function timeText(ms, roundUp = false) {
  let seconds = roundUp ? Math.ceil(ms / 1000) : Math.floor(ms / 1000);
  seconds = Math.max(0, seconds);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds % 3600 / 60);
  const rest = seconds % 60;
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`
    : `${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
}

function renderFlow() {
  const list = $('flow');
  list.replaceChildren();
  const activeSteps = run?.steps ?? steps;
  for (const [index, step] of activeSteps.entries()) {
    const item = document.createElement('li');
    item.textContent = `${step.type === 'work' ? '作業' : '休憩'} ${step.minutes}分`;
    item.classList.toggle('active', Boolean(run && run.row === index));
    list.append(item);
  }
  if (!activeSteps.length) {
    const item = document.createElement('li');
    item.textContent = '手順はまだありません。設定から追加してください。';
    list.append(item);
  }
}

function renderTimer() {
  const activeSteps = run?.steps ?? steps;
  $('phase-name').textContent = run ? (run.phase === 'work' ? '作業' : '休憩')
    : activeSteps.length ? '開始できます' : '手順を設定してください';
  $('clock').textContent = run ? timeText(run.remainingMs, true) : '00:00';
  $('position').textContent = run ? `${run.looping ? '最後の作業・休憩を反復中' : `${run.row + 1} / ${run.steps.length} 行目`}・${run.status === 'paused' ? '一時停止中' : '進行中'}`
    : activeSteps.length ? '最後の作業・休憩を繰り返します' : '';
  $('main-action').textContent = run?.status === 'running' ? '一時停止' : run ? '再開' : '開始';
  $('main-action').disabled = !run && !steps.length;
  $('skip').disabled = !run;
  $('end').disabled = !run;
  $('total').textContent = `積み上げた作業時間：${timeText(run?.totalWorkMs ?? totalWorkMs)}`;
  renderFlow();
}

function typeField(value, index) {
  const wrapper = document.createElement('label');
  wrapper.textContent = '種類';
  const select = document.createElement('select');
  for (const [text, optionValue] of [['選択', ''], ['作業', 'work'], ['休憩', 'rest']]) {
    const option = document.createElement('option');
    option.textContent = text;
    option.value = optionValue;
    select.append(option);
  }
  select.value = value;
  select.addEventListener('change', () => { draft[index].type = select.value; });
  wrapper.append(select);
  return wrapper;
}

function numberField(value, index) {
  const wrapper = document.createElement('label');
  wrapper.textContent = '時間（分）';
  const input = document.createElement('input');
  input.type = 'number';
  input.min = '0.1';
  input.max = '240';
  input.step = '0.1';
  input.required = true;
  input.inputMode = 'decimal';
  input.value = value;
  input.addEventListener('input', () => { draft[index].minutes = input.value; });
  wrapper.append(input);
  return wrapper;
}

function rowButton(label, title, onClick, disabled = false) {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = label;
  button.title = title;
  button.setAttribute('aria-label', title);
  button.disabled = disabled;
  button.addEventListener('click', onClick);
  return button;
}

function moveRow(from, to) {
  if (to < 0 || to >= draft.length || from === to) return;
  const [row] = draft.splice(from, 1);
  draft.splice(to, 0, row);
  renderSettings();
}

function renderSettings() {
  const list = $('step-list');
  list.replaceChildren();
  draft.forEach((step, index) => {
    const item = document.createElement('li');
    const row = document.createElement('div');
    row.className = 'step-row';
    row.append(typeField(step.type, index), numberField(step.minutes, index));
    const controls = document.createElement('div');
    controls.className = 'step-controls';
    controls.append(
      rowButton('↑', `${index + 1}行目を上へ`, () => moveRow(index, index - 1), index === 0),
      rowButton('↓', `${index + 1}行目を下へ`, () => moveRow(index, index + 1), index === draft.length - 1),
      rowButton('削除', `${index + 1}行目を削除`, () => { draft.splice(index, 1); renderSettings(); }),
    );
    row.append(controls);
    item.append(row);
    list.append(item);
  });
}

function showSettings() {
  draft = steps.map((step) => ({ ...step }));
  $('settings-error').textContent = '';
  renderSettings();
  $('timer-view').hidden = true;
  $('settings-view').hidden = false;
  $('settings-toggle').hidden = true;
}

function showTimer() {
  $('settings-view').hidden = true;
  $('timer-view').hidden = false;
  $('settings-toggle').hidden = false;
  renderTimer();
}

async function prepareAudio() {
  try {
    audioContext ??= new (window.AudioContext || window.webkitAudioContext)();
    await audioContext.resume();
  } catch {
    $('status').textContent = '音を準備できませんでした。タイマーは続行できます。';
  }
}

function playSound(phase) {
  if (!audioContext || audioContext.state !== 'running') return;
  const start = audioContext.currentTime;
  const frequencies = phase === 'work' ? [660, 880] : [660, 520, 440];
  frequencies.forEach((frequency, index) => {
    const at = start + index * 0.27;
    const oscillator = audioContext.createOscillator();
    const gain = audioContext.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.value = frequency;
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(0.16, at + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.2);
    oscillator.connect(gain).connect(audioContext.destination);
    oscillator.start(at);
    oscillator.stop(at + 0.21);
  });
}

function notifyPhase(phase) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  try {
    new Notification(phase === 'work' ? '作業を開始' : '休憩を開始', {
      body: `${run.steps[run.row].minutes}分です。`,
    });
  } catch {
    $('status').textContent = '通知を表示できませんでした。';
  }
}

function handleEvent(event) {
  if (!event) return;
  if (event.kind === 'interrupted') {
    $('status').textContent = '長時間の中断を検出しました。続きから再開してください。';
  } else {
    $('status').textContent = event.phase === 'work' ? '作業を開始しました。' : '休憩を開始しました。';
    playSound(event.phase);
    notifyPhase(event.phase);
  }
  persist();
}

$('settings-toggle').addEventListener('click', showSettings);
$('add-step').addEventListener('click', () => {
  draft.push({ type: '', minutes: '' });
  renderSettings();
  $('step-list').lastElementChild?.querySelector('select')?.focus();
});
$('save-settings').addEventListener('click', () => {
  try {
    steps = normalizeSteps(draft);
    persist();
    $('status').textContent = run ? '設定を保存しました。次の開始から反映されます。' : '設定を保存しました。';
    showTimer();
  } catch (error) {
    $('settings-error').textContent = error.message;
  }
});
$('cancel-settings').addEventListener('click', showTimer);

$('main-action').addEventListener('click', async () => {
  if (!run) {
    await prepareAudio();
    run = createRun(steps, totalWorkMs, Date.now());
    $('status').textContent = '作業を開始しました。';
    playSound('work');
  } else if (run.status === 'running') {
    handleEvent(pauseRun(run, Date.now()));
    $('status').textContent = '一時停止しました。';
  } else {
    await prepareAudio();
    resumeRun(run, Date.now());
    $('status').textContent = '再開しました。';
  }
  persist();
  renderTimer();
});

$('skip').addEventListener('click', () => {
  if (!run) return;
  handleEvent(skipPhase(run, Date.now()));
  persist();
  renderTimer();
});

$('end').addEventListener('click', () => {
  if (!run) return;
  advanceClock(run, Date.now());
  totalWorkMs = run.totalWorkMs;
  run = null;
  $('status').textContent = '終了しました。作業時間は保存されています。';
  persist();
  renderTimer();
});

$('permission').addEventListener('click', async () => {
  if (!('Notification' in window)) {
    $('status').textContent = 'この環境では通知を利用できません。';
    return;
  }
  try {
    const permission = await Notification.requestPermission();
    $('status').textContent = permission === 'granted' ? '通知を許可しました。' : '通知は許可されていません。';
  } catch {
    $('status').textContent = '通知の許可を確認できませんでした。';
  }
});

$('sound-test').addEventListener('click', async () => {
  await prepareAudio();
  playSound('work');
  setTimeout(() => playSound('rest'), 1300);
  $('status').textContent = '作業開始音のあとに休憩開始音を鳴らします。';
});

addEventListener('beforeunload', () => {
  if (run?.status === 'running') advanceClock(run, Date.now());
  persist();
});

load();
renderTimer();
if (run) $('status').textContent = '前回の続きは一時停止しています。再開できます。';
if (!steps.length) showSettings();
setInterval(() => {
  if (!run || run.status !== 'running') return;
  handleEvent(advanceClock(run, Date.now()));
  if (Date.now() - lastSaved >= 1000) persist();
  if (!$('timer-view').hidden) renderTimer();
}, 250);
})();
