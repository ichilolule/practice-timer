(() => {
'use strict';

const { advanceClock, createRun, normalizeSteps, pauseRun, resumeRun, restoreRun, skipPhase } = globalThis.TimerCore;
const { targetLabel, summarize, assignSession, clearTargets } = globalThis.PracticeData;

const STORAGE_KEY = 'practice-timer-v1';
const BACKUP_FORMAT = 'practice-timer-beta';
const $ = (id) => document.getElementById(id);
let steps = [];
let draft = [];
let run = null;
let totalWorkMs = 0;
let tasks = [];
let groups = [];
let sessions = [];
let selectedTaskId = null;
let editingTaskId = null;
let audioContext = null;
let lastSaved = 0;
const newId = () => globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;

function load() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    if (saved.format === BACKUP_FORMAT) {
      ({ steps, tasks, groups, sessions, run, totalWorkMs, selectedTaskId } = validateBackup(saved));
      return;
    }
    if (Array.isArray(saved.steps) && saved.steps.length) steps = normalizeSteps(saved.steps);
    if (Number.isFinite(saved.totalWorkMs) && saved.totalWorkMs >= 0) totalWorkMs = saved.totalWorkMs;
    run = restoreRun(saved.run);
    if (run) totalWorkMs = run.totalWorkMs;
    if (totalWorkMs > (run?.sessionWorkMs || 0)) {
      sessions.push({ id: newId(), endedAt: Date.now(), workMs: totalWorkMs - (run?.sessionWorkMs || 0),
        taskId: null, taskTitle: '以前の累計', targetId: null, reviewTargetId: null, note: '' });
    }
  } catch {
    $('status').textContent = '保存データを読めませんでした。設定を確認してください。';
  }
}

function persist() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ format: BACKUP_FORMAT, version: 1,
      steps, run, totalWorkMs: run?.totalWorkMs ?? totalWorkMs,
      tasks, groups, sessions, selectedTaskId }));
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
  $('active-task-panel').hidden = !run;
  renderFlow();
}

function appendOption(select, value, label) {
  const option = document.createElement('option');
  option.value = value;
  option.textContent = label;
  select.append(option);
}

function appendTargetOptions(select, selected = '', emptyLabel = '未分類') {
  select.replaceChildren();
  appendOption(select, '', emptyLabel);
  for (const group of groups) {
    appendOption(select, group.id, group.title);
    for (const child of group.children) appendOption(select, child.id, `${group.title} → ${child.title}`);
  }
  select.value = selected || '';
}

function renderTaskChoice() {
  const select = $('active-task');
  select.replaceChildren();
  appendOption(select, '', 'まだ選ばない（未分類）');
  for (const task of tasks) appendOption(select, task.id, task.title);
  select.value = selectedTaskId || '';
  select.disabled = Boolean(selectedTaskId);
  const task = tasks.find((item) => item.id === selectedTaskId);
  $('active-task-hint').textContent = task
    ? `${task.firstStep || '最初の一手は未登録'}｜別タスクへ移るときは終了して再開始します。`
    : '開始後に選んでも、選ぶ前の作業時間を含めます。';
}

function switchView(name) {
  for (const view of ['timer', 'tasks', 'growth', 'settings']) $(`${view}-view`).hidden = view !== name;
  $('primary-nav').hidden = name === 'settings';
  $('settings-toggle').hidden = name !== 'timer';
  for (const view of ['timer', 'tasks', 'growth']) {
    if (view === name) $(`nav-${view}`).setAttribute('aria-current', 'page');
    else $(`nav-${view}`).removeAttribute('aria-current');
  }
  if (name === 'timer') { renderTimer(); renderTaskChoice(); }
  if (name === 'tasks') renderTasks();
  if (name === 'growth') renderGrowth();
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

function resetTaskForm() {
  editingTaskId = null;
  $('task-form').reset();
  $('task-save').textContent = '＋タスクを追加';
  $('task-cancel').hidden = true;
  appendTargetOptions($('task-target'));
}

function renderTasks() {
  const selectedTarget = $('task-target').value;
  appendTargetOptions($('task-target'), selectedTarget);
  const list = $('task-list');
  list.replaceChildren();
  if (!tasks.length) {
    const item = document.createElement('li');
    item.textContent = 'タスクはまだありません。計測はタスクなしでも開始できます。';
    list.append(item);
    return;
  }
  for (const task of tasks) {
    const item = document.createElement('li');
    const title = document.createElement('strong');
    title.textContent = task.title;
    const detail = document.createElement('p');
    detail.textContent = `最初の一手：${task.firstStep || '未登録'}｜加算先：${targetLabel(groups, task.targetId) || '未分類'}`;
    const edit = rowButton('編集', `${task.title}を編集`, () => {
      editingTaskId = task.id;
      $('task-title').value = task.title;
      $('task-first-step').value = task.firstStep;
      appendTargetOptions($('task-target'), task.targetId);
      $('task-save').textContent = '変更を保存';
      $('task-cancel').hidden = false;
      $('task-title').focus();
    });
    const remove = rowButton('削除', `${task.title}を削除`, () => {
      if (!confirm(`「${task.title}」を削除しますか？過去の計測記録は残ります。`)) return;
      tasks = tasks.filter((item) => item.id !== task.id);
      if (selectedTaskId === task.id) selectedTaskId = null;
      if (editingTaskId === task.id) resetTaskForm();
      persist();
      renderTasks();
      renderTaskChoice();
    });
    item.append(title, detail, edit, remove);
    list.append(item);
  }
}

function renameItem(item, label) {
  const next = prompt(`${label}の名前`, item.title);
  if (next === null) return;
  const title = next.trim();
  if (!title || title.length > 60) return;
  item.title = title;
  persist();
  renderGrowth();
  renderTasks();
  renderTaskChoice();
}

function removeGroup(group, child = null) {
  const label = child?.title || group.title;
  if (!confirm(`「${label}」を削除しますか？ここに積んだ時間は未分類に戻ります。`)) return;
  const removedIds = child ? [child.id] : [group.id, ...group.children.map((item) => item.id)];
  clearTargets(removedIds, tasks, sessions);
  if (child) group.children = group.children.filter((item) => item.id !== child.id);
  else groups = groups.filter((item) => item.id !== group.id);
  persist();
  renderGrowth();
  renderTasks();
  renderTaskChoice();
}

function renderGrowth() {
  const summary = summarize(groups, sessions);
  const unclassifiedMs = summary.unclassified.reduce((sum, item) => sum + item.workMs, 0);
  $('growth-total').textContent = `作業時間の累計 ${timeText(run?.totalWorkMs ?? totalWorkMs)}｜未分類 ${timeText(unclassifiedMs)}`;
  const groupList = $('group-list');
  groupList.replaceChildren();
  if (!groups.length) {
    const empty = document.createElement('p');
    empty.textContent = '育成項目はまだありません。「＋育成項目」から作れます。';
    groupList.append(empty);
  }
  for (const group of summary.groups) {
    const original = groups.find((item) => item.id === group.id);
    const card = document.createElement('article');
    card.className = 'group-card';
    const heading = document.createElement('h3');
    heading.textContent = `${group.title}　合計 ${timeText(group.totalMs)}`;
    const direct = document.createElement('p');
    direct.className = 'subtle';
    direct.textContent = `内訳なし ${timeText(group.directMs)}`;
    card.append(heading, direct,
      rowButton('名前変更', `${group.title}の名前を変更`, () => renameItem(original, '育成項目')),
      rowButton('削除', `${group.title}を削除`, () => removeGroup(original)));
    const children = document.createElement('ul');
    for (const child of group.children) {
      const item = document.createElement('li');
      const originalChild = original.children.find((entry) => entry.id === child.id);
      const label = document.createElement('span');
      label.textContent = `${child.title} ${timeText(child.totalMs)}`;
      item.append(label,
        rowButton('名前変更', `${child.title}の名前を変更`, () => renameItem(originalChild, '内訳')),
        rowButton('削除', `${child.title}を削除`, () => removeGroup(original, originalChild)));
      children.append(item);
    }
    card.append(children);
    const form = document.createElement('form');
    form.className = 'inline-form';
    const input = document.createElement('input');
    input.type = 'text';
    input.maxLength = 60;
    input.required = true;
    input.placeholder = '例：手';
    input.setAttribute('aria-label', `${group.title}の内訳名`);
    const add = document.createElement('button');
    add.type = 'submit';
    add.textContent = '＋内訳';
    form.append(input, add);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const title = input.value.trim();
      if (!title) return;
      original.children.push({ id: newId(), title });
      persist();
      renderGrowth();
    });
    card.append(form);
    groupList.append(card);
  }

  const unclassifiedList = $('unclassified-list');
  unclassifiedList.replaceChildren();
  if (!summary.unclassified.length) {
    const empty = document.createElement('p');
    empty.textContent = '未分類の記録はありません。';
    unclassifiedList.append(empty);
  }
  for (const session of summary.unclassified.slice().reverse()) {
    const row = document.createElement('div');
    row.className = 'record-row';
    const label = document.createElement('span');
    label.textContent = `${new Date(session.endedAt).toLocaleDateString('ja-JP')}｜${timeText(session.workMs)}｜${session.taskTitle || 'タスク未選択'}`;
    const select = document.createElement('select');
    select.setAttribute('aria-label', '割り当てるタスク');
    appendOption(select, '', '割り当てるタスクを選択');
    for (const task of tasks) {
      if (targetLabel(groups, task.targetId)) appendOption(select, task.id, task.title);
    }
    const assign = rowButton('割り当て', '未分類の時間をタスクへ割り当て', () => {
      const task = tasks.find((item) => item.id === select.value);
      if (!assignSession(session, task, groups)) {
        $('growth-status').textContent = '加算先があるタスクを選んでください。';
        return;
      }
      persist();
      renderGrowth();
      $('growth-status').textContent = '時間を割り当てました。';
    });
    row.append(label, select, assign);
    unclassifiedList.append(row);
  }

  const history = $('session-list');
  history.replaceChildren();
  for (const session of sessions.slice(-20).reverse()) {
    const card = document.createElement('article');
    card.className = 'record-row';
    const heading = document.createElement('strong');
    heading.textContent = `${new Date(session.endedAt).toLocaleDateString('ja-JP')}｜${timeText(session.workMs)}｜${session.taskTitle || 'タスク未選択'}`;
    const note = document.createElement('input');
    note.type = 'text';
    note.maxLength = 500;
    note.value = session.note || '';
    note.placeholder = '気になったことをひとこと（任意）';
    note.setAttribute('aria-label', '振り返りメモ');
    const tag = document.createElement('select');
    tag.setAttribute('aria-label', '気になった項目');
    appendTargetOptions(tag, session.reviewTargetId, '気になった項目（任意）');
    const save = rowButton('メモを保存', '振り返りメモを保存', () => {
      session.note = note.value.trim();
      session.reviewTargetId = tag.value || null;
      persist();
      $('growth-status').textContent = '振り返りを保存しました。';
    });
    card.append(heading, tag, note, save);
    history.append(card);
  }
  if (!sessions.length) {
    const empty = document.createElement('p');
    empty.textContent = '計測記録はまだありません。';
    history.append(empty);
  }
}

function validateBackup(raw) {
  if (!raw || raw.format !== BACKUP_FORMAT || raw.version !== 1 ||
      !Array.isArray(raw.steps) || !Array.isArray(raw.tasks) ||
      !Array.isArray(raw.groups) || !Array.isArray(raw.sessions)) {
    throw new Error('このbeta版のバックアップ形式ではありません。');
  }
  const restoredSteps = raw.steps.length ? normalizeSteps(raw.steps) : [];
  const ids = new Set();
  const takeId = (value) => {
    if (typeof value !== 'string' || !value || ids.has(value)) throw new Error('IDが重複または不正です。');
    ids.add(value);
    return value;
  };
  const title = (value, max) => {
    if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error('名前が不正です。');
    return value.trim();
  };
  const restoredGroups = raw.groups.map((group) => ({
    id: takeId(group.id), title: title(group.title, 60),
    children: (() => {
      if (!Array.isArray(group.children)) throw new Error('内訳が不正です。');
      return group.children.map((child) => ({ id: takeId(child.id), title: title(child.title, 60) }));
    })(),
  }));
  const validTarget = (id) => id == null || Boolean(targetLabel(restoredGroups, id));
  const restoredTasks = raw.tasks.map((task) => {
    if (typeof task.firstStep !== 'string' || task.firstStep.length > 500 || !validTarget(task.targetId)) {
      throw new Error('タスクが不正です。');
    }
    return { id: takeId(task.id), title: title(task.title, 100),
      firstStep: task.firstStep, targetId: task.targetId || null };
  });
  const restoredSessions = raw.sessions.map((session) => {
    if (!Number.isFinite(session.workMs) || session.workMs < 0 ||
        !Number.isFinite(session.endedAt) ||
        !validTarget(session.targetId) || !validTarget(session.reviewTargetId) ||
        typeof session.note !== 'string' || session.note.length > 500 ||
        (session.taskId != null && typeof session.taskId !== 'string') ||
        (session.taskTitle != null && typeof session.taskTitle !== 'string')) {
      throw new Error('計測記録が不正です。');
    }
    return { id: takeId(session.id), endedAt: session.endedAt, workMs: session.workMs,
      taskId: session.taskId || null, taskTitle: session.taskTitle || null,
      targetId: session.targetId || null, reviewTargetId: session.reviewTargetId || null,
      note: session.note };
  });
  const restoredRun = raw.run == null ? null : restoreRun(raw.run);
  if (raw.run != null && !restoredRun) throw new Error('計測途中のデータが不正です。');
  const restoredTotal = raw.totalWorkMs;
  const recorded = restoredSessions.reduce((sum, session) => sum + session.workMs, 0) + (restoredRun?.sessionWorkMs || 0);
  if (!Number.isFinite(restoredTotal) || restoredTotal < 0 || restoredTotal + 1 < recorded ||
      (restoredRun && Math.abs(restoredRun.totalWorkMs - restoredTotal) > 1)) {
    throw new Error('累計時間が不正です。');
  }
  const restoredSelection = restoredRun && restoredTasks.some((task) => task.id === raw.selectedTaskId)
    ? raw.selectedTaskId : null;
  return { steps: restoredSteps, tasks: restoredTasks, groups: restoredGroups,
    sessions: restoredSessions, run: restoredRun, totalWorkMs: restoredTotal,
    selectedTaskId: restoredSelection };
}

function backupObject() {
  if (run?.status === 'running') handleEvent(advanceClock(run, Date.now()));
  return { format: BACKUP_FORMAT, version: 1, steps, tasks, groups, sessions,
    totalWorkMs: run?.totalWorkMs ?? totalWorkMs,
    run: run ? { ...run, status: 'paused', lastTick: null } : null,
    selectedTaskId };
}

function showSettings() {
  draft = steps.map((step) => ({ ...step }));
  $('settings-error').textContent = '';
  $('permission-status').textContent = 'Notification' in window
    ? `通知の許可状態：${Notification.permission}` : 'この環境では通知を利用できません。';
  renderSettings();
  $('import-file').disabled = Boolean(run);
  switchView('settings');
}

function showTimer() {
  switchView('timer');
}

async function prepareAudio() {
  try {
    audioContext ??= new (window.AudioContext || window.webkitAudioContext)();
    await audioContext.resume();
    return audioContext.state === 'running';
  } catch {
    return false;
  }
}

function playSound(phase) {
  if (!audioContext || audioContext.state !== 'running') return;
  const start = audioContext.currentTime;
  const frequencies = phase === 'work' ? [660, 880] : [659.25, 554.37, 440];
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
      silent: true,
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
for (const view of ['timer', 'tasks', 'growth']) {
  $(`nav-${view}`).addEventListener('click', () => switchView(view));
}
$('go-tasks').addEventListener('click', () => switchView('tasks'));
$('active-task').addEventListener('change', () => {
  if (!run || selectedTaskId) return;
  const task = tasks.find((item) => item.id === $('active-task').value);
  selectedTaskId = task?.id || null;
  persist();
  renderTaskChoice();
});
$('task-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const title = $('task-title').value.trim();
  if (!title) return;
  const firstStep = $('task-first-step').value.trim();
  const targetId = $('task-target').value || null;
  if (targetId && !targetLabel(groups, targetId)) return;
  const task = tasks.find((item) => item.id === editingTaskId);
  if (task) Object.assign(task, { title, firstStep, targetId });
  else tasks.push({ id: newId(), title, firstStep, targetId });
  persist();
  resetTaskForm();
  renderTasks();
  renderTaskChoice();
  $('task-status').textContent = task ? 'タスクを更新しました。' : 'タスクを追加しました。';
});
$('task-cancel').addEventListener('click', resetTaskForm);
$('group-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const title = $('group-title').value.trim();
  if (!title) return;
  groups.push({ id: newId(), title, children: [] });
  $('group-form').reset();
  persist();
  renderGrowth();
  $('growth-status').textContent = '育成項目を追加しました。';
});
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

$('main-action').addEventListener('click', () => {
  if (!run) {
    const audioReady = prepareAudio();
    run = createRun(steps, totalWorkMs, Date.now());
    selectedTaskId = null;
    const startedRun = run;
    $('status').textContent = run.phase === 'work' ? '作業を開始しました。' : '休憩を開始しました。';
    audioReady.then((ready) => {
      if (run !== startedRun || run.status !== 'running' || run.row !== 0 || run.looping) return;
      if (ready) playSound(startedRun.phase);
      else $('status').textContent = '音を準備できませんでした。タイマーは続行中です。';
    });
  } else if (run.status === 'running') {
    handleEvent(pauseRun(run, Date.now()));
    $('status').textContent = '一時停止しました。';
  } else {
    void prepareAudio();
    resumeRun(run, Date.now());
    $('status').textContent = '再開しました。';
  }
  persist();
  renderTimer();
  renderTaskChoice();
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
  const gainedMs = run.sessionWorkMs;
  if (gainedMs > 0) {
    const task = tasks.find((item) => item.id === selectedTaskId);
    sessions.push({ id: newId(), endedAt: Date.now(), workMs: gainedMs,
      taskId: task?.id || null, taskTitle: task?.title || null,
      targetId: task && targetLabel(groups, task.targetId) ? task.targetId : null,
      reviewTargetId: null, note: '' });
  }
  run = null;
  selectedTaskId = null;
  $('status').textContent = `終了しました。今回 ${timeText(gainedMs)}｜累計 ${timeText(totalWorkMs)}`;
  persist();
  renderTimer();
  renderTaskChoice();
});

$('permission').addEventListener('click', async () => {
  if (!('Notification' in window)) {
    $('permission-status').textContent = 'この環境では通知を利用できません。';
    return;
  }
  try {
    const permission = await Notification.requestPermission();
    $('permission-status').textContent = permission === 'granted' ? '通知を許可しました。' : '通知は許可されていません。';
  } catch {
    $('permission-status').textContent = '通知の許可を確認できませんでした。';
  }
});

$('export-data').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(backupObject(), null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'practice-timer.json';
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  $('backup-status').textContent = 'JSONを保存しました。';
});

$('import-file').addEventListener('change', async () => {
  const input = $('import-file');
  const file = input.files?.[0];
  if (!file) return;
  try {
    if (run) throw new Error('計測中は読み込めません。終了してから読み込んでください。');
    if (file.size > 5_000_000) throw new Error('5MBを超えるJSONは読み込めません。');
    const next = validateBackup(JSON.parse(await file.text()));
    if (!confirm('現在のデータをJSONの内容で置き換えますか？')) return;
    ({ steps, tasks, groups, sessions, run, totalWorkMs, selectedTaskId } = next);
    persist();
    resetTaskForm();
    renderTimer();
    renderTaskChoice();
    $('status').textContent = 'JSONを読み込みました。';
    $('backup-status').textContent = 'JSONを読み込みました。';
    if (!steps.length) showSettings();
  } catch (error) {
    $('backup-status').textContent = `読み込みを中止しました：${error.message}`;
  } finally {
    input.value = '';
  }
});

addEventListener('beforeunload', () => {
  if (run?.status === 'running') advanceClock(run, Date.now());
  persist();
});

load();
switchView('timer');
if (run) $('status').textContent = '前回の続きは一時停止しています。再開できます。';
setInterval(() => {
  if (!run || run.status !== 'running') return;
  handleEvent(advanceClock(run, Date.now()));
  if (Date.now() - lastSaved >= 1000) persist();
  if (!$('timer-view').hidden) renderTimer();
}, 250);
})();
