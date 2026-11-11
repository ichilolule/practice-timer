(() => {
'use strict';

const { advanceClock, createRun, normalizeSteps, pauseRun, resumeRun, restoreRun, skipPhase } = globalThis.TimerCore;
const { targetLabel, summarize, clearTargets, periodBounds, workInRange, periodBuckets } = globalThis.PracticeData;

const STORAGE_KEY = 'practice-timer-v1';
const BACKUP_FORMAT = 'practice-timer-beta';
const DEFAULT_SOUND = { volume: 100, pitch: 0 };
const DEFAULT_DAY_START = 5 * 60;
// 保存値の尺度は旧版のままにして、画面の1%を従来の5%分に対応させる。
const SOUND_VOLUME_SCALE = 5;
const $ = (id) => document.getElementById(id);
let steps = [];
let draft = [];
let settingsDraftActive = false;
let run = null;
let totalWorkMs = 0;
let tasks = [];
let groups = [];
let sessions = [];
let selectedTaskId = null;
let editingTaskId = null;
let taskEditorSelectAfter = false;
let taskEditorSource = null;
let taskUndo = null;
let periodKind = 'day';
let periodAnchor = Date.now();
let themePeriodKind = 'all';
let themePeriodAnchor = Date.now();
const openThemeIds = new Set();
let editingRecordId = null;
let renamingThemeItem = null;
let audioContext = null;
let soundSettings = { ...DEFAULT_SOUND };
let dayStartMinutes = DEFAULT_DAY_START;
let previewPlaying = false;
let lastSaved = 0;
const newId = () => globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;

function load() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    if (saved.format === BACKUP_FORMAT) {
      ({ steps, tasks, groups, sessions, run, totalWorkMs, selectedTaskId, sound: soundSettings, dayStartMinutes } = validateBackup(saved));
      return;
    }
    if (Array.isArray(saved.steps) && saved.steps.length) steps = normalizeSteps(saved.steps);
    if (Number.isFinite(saved.totalWorkMs) && saved.totalWorkMs >= 0) totalWorkMs = saved.totalWorkMs;
    run = restoreRun(saved.run);
    if (run) totalWorkMs = run.totalWorkMs;
    if (totalWorkMs > (run?.sessionWorkMs || 0)) {
      const id = newId();
      sessions.push({ id, recordGroupId: id, startedAt: null, endedAt: Date.now(),
        workMs: totalWorkMs - (run?.sessionWorkMs || 0),
        taskId: null, taskTitle: '以前の累計', targetId: null });
    }
  } catch {
    $('status').textContent = '保存データを読めませんでした。設定を確認してください。';
  }
}

function persist() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ format: BACKUP_FORMAT, version: 1,
      steps, run, totalWorkMs: run?.totalWorkMs ?? totalWorkMs,
      tasks, groups, sessions, selectedTaskId, sound: soundSettings, dayStartMinutes }));
    lastSaved = Date.now();
    return true;
  } catch {
    $('status').textContent = 'ブラウザに保存できません。ストレージの設定を確認してください。';
    return false;
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

function renderTimer() {
  const activeSteps = run?.steps ?? steps;
  const phase = run?.phase ?? activeSteps[0]?.type;
  const phaseLabel = phase === 'work' ? '作業' : '休憩';
  const stateLabel = run ? (run.status === 'running' ? '中' : '・一時停止中') : 'の準備';
  labelControl($('phase-name'), phase ? phaseLabel + stateLabel : '手順未設定');
  $('phase-icon').setAttribute('href', `#icon-${phase === 'work' ? 'work' : phase ? 'rest' : 'settings'}`);
  $('phase-paused').hidden = run?.status !== 'paused';
  const remainingMs = run?.remainingMs ?? ((steps[0]?.minutes || 0) * 60_000);
  $('clock').textContent = timeText(remainingMs, true);
  $('clock').classList.toggle('has-hours', remainingMs >= 3_600_000);
  labelControl($('main-action'), run?.status === 'running' ? '一時停止' : run ? '再開' : steps.length ? '開始' : '手順を設定');
  $('main-action-icon').setAttribute('href', `#icon-${run?.status === 'running' ? 'pause' : run || steps.length ? 'play' : 'settings'}`);
  $('main-action').disabled = false;
  $('skip').hidden = !run;
  $('end').hidden = !run;
  $('skip').disabled = !run;
  $('end').disabled = !run;
  if (run) {
    const nextType = !run.looping && run.row < run.steps.length - 1
      ? run.steps[run.row + 1].type : run.phase === 'work' ? 'rest' : 'work';
    labelControl($('skip'), nextType === 'work' ? '次の作業へ' : '休憩へ進む');
  }
}

function labelControl(element, label) {
  if (element.getAttribute('aria-label') !== label) element.setAttribute('aria-label', label);
  element.title = label;
}

function appendOption(select, value, label) {
  const option = document.createElement('option');
  option.value = value;
  option.textContent = label;
  select.append(option);
}

function renderTaskChoice() {
  const task = tasks.find((item) => item.id === selectedTaskId);
  $('active-task-name').textContent = task?.title || '';
  $('active-task-name').title = task?.title || '';
  $('active-task-name').hidden = !task;
  $('active-task-hint').textContent = task?.firstStep || '';
  $('active-task-hint').title = task?.firstStep || '';
  $('active-task-hint').hidden = !task?.firstStep;
  $('choose-task').textContent = task && !run ? 'タスクを選び直す' : 'タスクを選ぶ';
  $('choose-task').disabled = Boolean(run && selectedTaskId);
  $('task-choice-actions').hidden = Boolean(run && selectedTaskId);
  $('timer-task-add').hidden = Boolean(run && selectedTaskId);
  if ($('timer-task-add').hidden) $('timer-task-add').open = false;
  renderTaskPicker();
}

function chooseTask(task) {
  if ((run && selectedTaskId) || task.completedAt != null) return;
  selectedTaskId = task.id;
  persist();
  if ($('task-picker-dialog').open) $('task-picker-dialog').close();
  switchView('timer');
}

function renderTaskPicker() {
  const list = $('task-picker-list');
  list.replaceChildren();
  const available = tasks.filter((task) => task.completedAt == null);
  if (!available.length) {
    const empty = document.createElement('li');
    empty.textContent = '未完了のタスクはありません。新しく追加できます。';
    list.append(empty);
  }
  for (const task of available) {
    const item = document.createElement('li');
    const choose = rowButton(task.title, `${task.title}をこの回に選ぶ`, () => chooseTask(task));
    choose.className = 'task-pick';
    item.append(choose);
    list.append(item);
  }
}

function switchView(name) {
  for (const view of ['timer', 'tasks', 'growth', 'themes', 'settings']) $(`${view}-view`).hidden = view !== name;
  for (const view of ['timer', 'tasks', 'growth', 'themes', 'settings']) {
    const button = view === 'settings' ? $('settings-toggle') : $(`nav-${view}`);
    if (view === name) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  }
  if (name === 'timer') { renderTimer(); renderTaskChoice(); }
  if (name === 'tasks') renderTasks();
  if (name === 'growth') renderGrowth();
  if (name === 'themes') renderThemes();
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
  if ($('task-dialog').open) $('task-dialog').close();
  editingTaskId = null;
  taskEditorSelectAfter = false;
  taskEditorSource = null;
  $('task-title').value = '';
  $('task-first-step').value = '';
  $('task-group').value = '';
  renderTaskChildren();
}

function taskTargetParts(targetId) {
  for (const group of groups) {
    if (group.id === targetId) return { groupId: group.id, childId: '' };
    if (group.children.some((child) => child.id === targetId)) return { groupId: group.id, childId: targetId };
  }
  return { groupId: '', childId: '' };
}

function renderTaskChildren(selected = '') {
  const group = groups.find((item) => item.id === $('task-group').value);
  const select = $('task-child');
  select.replaceChildren();
  appendOption(select, '', group ? 'サブテーマなし' : 'テーマを選択');
  for (const child of group?.children || []) appendOption(select, child.id, child.title);
  select.value = group?.children.some((child) => child.id === selected) ? selected : '';
  select.disabled = !group || !group.children.length;
}

function openTaskEditor(task = null, selectAfter = false, source = null) {
  resetTaskForm();
  editingTaskId = task?.id || null;
  taskEditorSelectAfter = !task && selectAfter && Boolean(run && !selectedTaskId);
  taskEditorSource = source;
  $('task-title').value = task?.title || (source ? $(source).value.trim() : '');
  $('task-first-step').value = task?.firstStep || '';
  const { groupId, childId } = taskTargetParts(task?.targetId);
  const groupSelect = $('task-group');
  groupSelect.replaceChildren();
  appendOption(groupSelect, '', '未設定');
  for (const group of groups) appendOption(groupSelect, group.id, group.title);
  groupSelect.value = groupId;
  renderTaskChildren(childId);
  $('task-dialog-title').textContent = task ? 'タスクを編集' : 'タスクを追加';
  $('task-save').textContent = task ? '変更を保存' : taskEditorSelectAfter ? '追加してこの回に選ぶ' : '追加';
  $('task-save-only').hidden = !taskEditorSelectAfter;
  $('task-dialog').showModal();
  $('task-title').focus();
}

function saveTask(selectAfter) {
  const title = $('task-title').value.trim();
  if (!title) return;
  const firstStep = $('task-first-step').value.trim();
  const groupId = $('task-group').value;
  const childId = $('task-child').value;
  const targetId = childId || groupId || null;
  if (targetId && !targetLabel(groups, targetId)) return;
  let task = tasks.find((item) => item.id === editingTaskId);
  const updating = Boolean(task);
  if (task) Object.assign(task, { title, firstStep, targetId });
  else {
    task = { id: newId(), title, firstStep, targetId, completedAt: null };
    tasks.push(task);
  }
  if (selectAfter && run && !selectedTaskId) selectedTaskId = task.id;
  if (taskEditorSource) $(taskEditorSource).value = '';
  persist();
  resetTaskForm();
  renderTasks();
  renderTaskChoice();
  const message = updating ? 'タスクを更新しました。' : selectedTaskId === task.id && selectAfter
    ? 'タスクを追加して、この回に選びました。' : 'タスクを追加しました。';
  $('task-status').textContent = message;
  if (!$('tasks-view').hidden) document.getElementById(`task-title-${task.id}`)?.focus();
  else if (!$('timer-view').hidden) $('main-action').focus();
}

function addQuickTask(title, selectAfter = false) {
  const task = { id: newId(), title, firstStep: '', targetId: null, completedAt: null };
  tasks.push(task);
  if (selectAfter && run && !selectedTaskId) selectedTaskId = task.id;
  persist();
  renderTasks();
  renderTaskChoice();
  const message = selectedTaskId === task.id
    ? 'タスクを追加して、この回に選びました。' : 'タスクを追加しました。';
  $('task-status').textContent = message;
  if (!$('timer-view').hidden && run && selectedTaskId === task.id) $('main-action').focus();
}

function setTaskCompleted(task, completed) {
  const selectedBefore = selectedTaskId;
  task.completedAt = completed ? Date.now() : null;
  if (completed && !run && selectedTaskId === task.id) selectedTaskId = null;
  taskUndo = completed ? { taskId: task.id, completedAt: task.completedAt, selectedBefore } : null;
  $('task-undo').hidden = !taskUndo;
  persist();
  renderTasks();
  renderTaskChoice();
  $('task-status').textContent = completed ? `「${task.title}」を完了にしました。` : 'タスクを未完了に戻しました。';
  if (completed) $('task-undo').focus();
  else document.getElementById(`task-title-${task.id}`)?.focus();
}

function taskRow(task, completed) {
  const item = document.createElement('li');
  item.className = 'task-row';
  const checkLabel = document.createElement('label');
  checkLabel.className = 'task-check';
  const check = document.createElement('input');
  check.type = 'checkbox';
  check.checked = completed;
  check.setAttribute('aria-label', `${task.title}を${completed ? '未完了に戻す' : '完了にする'}`);
  check.addEventListener('change', () => setTaskCompleted(task, check.checked));
  checkLabel.append(check);
  const details = document.createElement('details');
  details.className = 'task-details';
  const title = document.createElement('summary');
  title.id = `task-title-${task.id}`;
  title.textContent = task.title;
  const content = document.createElement('div');
  content.className = 'task-detail-content';
  if (task.firstStep) {
    const firstStep = document.createElement('p');
    firstStep.textContent = `最初の一手：${task.firstStep}`;
    content.append(firstStep);
  }
  const target = targetLabel(groups, task.targetId);
  if (target) {
    const category = document.createElement('p');
    category.className = 'subtle';
    category.textContent = `テーマ：${target}`;
    content.append(category);
  }
  if (completed) {
    const date = document.createElement('p');
    date.className = 'subtle';
    date.textContent = `完了：${new Date(task.completedAt).toLocaleDateString('ja-JP')}`;
    content.append(date);
  }
  const actions = document.createElement('div');
  actions.className = 'task-actions';
  if (!completed && !(run && selectedTaskId)) {
    actions.append(rowButton('このタスクを選ぶ', `${task.title}をこの回に選ぶ`, () => chooseTask(task)));
  }
  actions.append(rowButton('編集', `${task.title}を編集`, () => openTaskEditor(task)));
  const menu = document.createElement('details');
  menu.className = 'task-menu';
  const menuTitle = document.createElement('summary');
  menuTitle.textContent = 'その他の操作';
  menu.append(menuTitle, rowButton('削除', `${task.title}を削除`, () => {
    if (run && selectedTaskId === task.id) return;
    if (!confirm(`「${task.title}」を削除しますか？過去の計測記録は残ります。`)) return;
    tasks = tasks.filter((item) => item.id !== task.id);
    if (selectedTaskId === task.id) selectedTaskId = null;
    if (taskUndo?.taskId === task.id) { taskUndo = null; $('task-undo').hidden = true; }
    persist();
    renderTasks();
    renderTaskChoice();
    $('task-status').textContent = 'タスクを削除しました。';
    $('quick-task-title').focus();
  }, Boolean(run && selectedTaskId === task.id)));
  content.append(actions, menu);
  details.append(title, content);
  item.append(checkLabel, details);
  return item;
}

function renderTasks() {
  const active = tasks.filter((task) => task.completedAt == null);
  const completed = tasks.filter((task) => task.completedAt != null)
    .sort((a, b) => b.completedAt - a.completedAt);
  $('active-count').textContent = `(${active.length})`;
  $('completed-count').textContent = `(${completed.length})`;
  const activeList = $('task-list');
  const completedList = $('completed-list');
  activeList.replaceChildren();
  completedList.replaceChildren();
  for (const task of active) activeList.append(taskRow(task, false));
  for (const task of completed) completedList.append(taskRow(task, true));
  if (!active.length) {
    const empty = document.createElement('li');
    empty.textContent = '未完了のタスクはありません。上から追加できます。';
    activeList.append(empty);
  }
  if (!completed.length) {
    const empty = document.createElement('li');
    empty.textContent = '完了済みのタスクはまだありません。';
    completedList.append(empty);
  }
}

function renameItem(item, label) {
  renamingThemeItem = item;
  $('theme-name-title').textContent = `${label}の名前`;
  $('theme-name').value = item.title;
  $('theme-name-error').textContent = '';
  $('theme-name-dialog').showModal();
  $('theme-name').focus();
}

$('theme-name-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const title = $('theme-name').value.trim();
  if (!renamingThemeItem || !title || title.length > 60) {
    $('theme-name-error').textContent = '名前は1〜60文字で入力してください。';
    return;
  }
  renamingThemeItem.title = title;
  persist();
  $('theme-name-dialog').close();
  renamingThemeItem = null;
  renderGrowth();
  renderTasks();
  renderTaskChoice();
});
$('theme-name-cancel').addEventListener('click', () => $('theme-name-dialog').close());
$('theme-name-dialog').addEventListener('close', () => { renamingThemeItem = null; });

function removeGroup(group, child = null) {
  const label = child?.title || group.title;
  if (!confirm(`「${label}」を削除しますか？記録のテーマは未設定になります。`)) return;
  const removedIds = child ? [child.id] : [group.id, ...group.children.map((item) => item.id)];
  clearTargets(removedIds, tasks, sessions);
  if (child) group.children = group.children.filter((item) => item.id !== child.id);
  else groups = groups.filter((item) => item.id !== group.id);
  persist();
  renderGrowth();
  renderTasks();
  renderTaskChoice();
}

function durationText(ms) {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}

function themeScale(ms) {
  const step = ms <= 3_600_000 ? 900_000 : ms <= 36_000_000 ? 3_600_000 : 36_000_000;
  return Math.max(step, Math.ceil(ms / step) * step);
}

function themeBar(title, ms, scale) {
  const row = document.createElement('div');
  row.className = 'theme-chart-row';
  const line = growthLine(title, ms);
  const track = document.createElement('div');
  track.className = 'theme-bar-track';
  track.setAttribute('aria-hidden', 'true');
  const fill = document.createElement('span');
  fill.className = 'theme-bar-fill';
  fill.style.width = `${ms / scale * 100}%`;
  track.append(fill);
  row.append(line, track);
  return row;
}

function recordTimeLabel(timestamp, bounds) {
  const date = new Date(timestamp);
  const time = date.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit', hour12: false });
  if (timestamp >= bounds.start && timestamp < bounds.end) return time;
  const day = date.toLocaleDateString('ja-JP', {
    ...(date.getFullYear() !== new Date(bounds.start).getFullYear() ? { year: 'numeric' } : {}),
    month: 'numeric', day: 'numeric',
  });
  return `${day} ${time}`;
}

function growthLine(title, ms, tag = 'div') {
  const row = document.createElement(tag);
  row.className = 'growth-line';
  const name = document.createElement('span');
  name.textContent = title;
  const amount = document.createElement('span');
  amount.className = 'growth-duration';
  amount.textContent = durationText(ms);
  row.append(name, amount);
  return row;
}

function dateInputValue(timestamp) {
  const date = new Date(timestamp);
  return new Date(timestamp - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 19);
}

function periodLabel(bounds, kind = periodKind) {
  const start = new Date(bounds.start);
  const end = new Date(bounds.end);
  end.setDate(end.getDate() - 1);
  if (kind === 'year') return `${start.getFullYear()}年`;
  if (kind === 'month') return `${start.getFullYear()}年${start.getMonth() + 1}月`;
  if (kind === 'week') return `${start.toLocaleDateString('ja-JP')} ～ ${end.toLocaleDateString('ja-JP')}`;
  return start.toLocaleDateString('ja-JP', { year: 'numeric', month: 'numeric', day: 'numeric', weekday: 'short' });
}

function movePeriod(direction) {
  const next = new Date(periodBounds(periodKind, periodAnchor, dayStartMinutes).start);
  if (periodKind === 'year') { next.setMonth(0, 1); next.setFullYear(next.getFullYear() + direction); }
  else if (periodKind === 'month') { next.setDate(1); next.setMonth(next.getMonth() + direction); }
  else next.setDate(next.getDate() + direction * (periodKind === 'week' ? 7 : 1));
  periodAnchor = next.getTime();
  renderGrowth();
}

function recalculateTotal() {
  const recorded = sessions.reduce((sum, session) => sum + session.workMs, 0);
  totalWorkMs = recorded + (run?.sessionWorkMs || 0);
  if (run) run.totalWorkMs = totalWorkMs;
}

function renderGrowth() {
  const bounds = periodBounds(periodKind, periodAnchor, dayStartMinutes);
  const periodSessions = sessions.map((session) => ({ ...session,
    workMs: workInRange(session, bounds.start, bounds.end) })).filter((session) => session.workMs > 0);
  const periodMs = periodSessions.reduce((sum, session) => sum + session.workMs, 0);
  $('period-label').textContent = periodLabel(bounds);
  for (const kind of ['day', 'week', 'month', 'year']) {
    $('period-' + kind).setAttribute('aria-pressed', String(kind === periodKind));
  }
  $('growth-total').textContent = durationText(periodMs);
  $('growth-all-total').textContent = `全期間 ${durationText(run?.totalWorkMs ?? totalWorkMs)}`;
  const chart = $('period-chart');
  chart.replaceChildren();
  const buckets = periodBuckets(periodKind, periodAnchor, sessions, dayStartMinutes);
  chart.hidden = periodKind !== 'day' && !buckets.some((bucket) => bucket.workMs > 0);
  $('period-chart-layout').hidden = chart.hidden;
  const largest = Math.max(3_600_000, Math.ceil(Math.max(0, ...buckets.map((bucket) => bucket.workMs)) / 3_600_000) * 3_600_000);
  $('period-chart-max').textContent = durationText(largest);
  for (const [index, bucket] of buckets.entries()) {
    const date = new Date(bucket.start);
    const item = document.createElement(periodKind === 'day' ? 'div' : 'button');
    if (periodKind === 'day') item.setAttribute('role', 'img');
    else item.type = 'button';
    item.className = 'period-bar';
    const track = document.createElement('div');
    track.className = 'period-bar-track';
    const fill = document.createElement('div');
    fill.className = 'period-bar-fill';
    fill.style.height = `${bucket.workMs / largest * 100}%`;
    const label = document.createElement('small');
    const hour = date.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit', hour12: false });
    const bucketLabel = periodKind === 'day' ? `${hour} ～ ${new Date(bucket.end).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit', hour12: false })}`
      : periodKind === 'year' ? `${date.getMonth() + 1}月`
      : `${date.getMonth() + 1}/${date.getDate()}`;
    label.textContent = periodKind === 'day' ? (index % 3 === 0 ? (date.getMinutes() ? hour : `${date.getHours()}時`) : '\u00a0')
      : periodKind === 'year' ? bucketLabel
      : periodKind === 'week' ? bucketLabel : (date.getDate() === 1 || date.getDate() % 5 === 0 ? String(date.getDate()) : '\u00a0');
    item.setAttribute('aria-label', `${bucketLabel} ${durationText(bucket.workMs)}`);
    item.title = `${bucketLabel} ${durationText(bucket.workMs)}`;
    if (periodKind !== 'day') item.addEventListener('click', () => {
      periodAnchor = bucket.start;
      periodKind = periodKind === 'year' ? 'month' : 'day';
      renderGrowth();
    });
    track.append(fill);
    item.append(track, label);
    chart.append(item);
  }
  const untimedMs = periodSessions.filter((session) => session.startedAt == null)
    .reduce((sum, session) => sum + session.workMs, 0);
  $('day-untimed').hidden = periodKind !== 'day' || untimedMs === 0;
  $('day-untimed').textContent = `開始時刻なし ${durationText(untimedMs)}`;
  $('day-records').hidden = periodKind !== 'day';
  if (periodKind === 'day') renderDayRecords(bounds);
  renderThemes();
}

function renderSubthemeChart(group) {
  const section = document.createElement('section');
  section.className = 'subtheme-section';
  const heading = document.createElement('h3');
  heading.textContent = 'サブテーマ';
  section.append(heading);
  const referenceMs = Math.max(0, ...group.children.map((child) => child.totalMs));
  const scale = themeScale(referenceMs);
  if (referenceMs > 0) {
    const reference = document.createElement('p');
    reference.className = 'subtheme-reference-label subtle';
    reference.textContent = `目安 ${durationText(referenceMs)}`;
    section.append(reference);
  }
  const table = document.createElement('table');
  table.className = 'subtheme-table';
  table.setAttribute('aria-label', `${group.title}のサブテーマ別作業時間`);
  const head = document.createElement('thead');
  const headRow = document.createElement('tr');
  const nameHead = document.createElement('th');
  nameHead.setAttribute('scope', 'col');
  nameHead.setAttribute('aria-label', 'サブテーマ');
  const scaleHead = document.createElement('th');
  scaleHead.setAttribute('scope', 'col');
  const axis = document.createElement('div');
  axis.className = 'theme-scale';
  const zero = document.createElement('span');
  zero.textContent = '0h 00m';
  const maximum = document.createElement('span');
  maximum.textContent = durationText(scale);
  axis.append(zero, maximum);
  scaleHead.append(axis);
  const valueHead = document.createElement('th');
  valueHead.setAttribute('scope', 'col');
  valueHead.setAttribute('aria-label', '作業時間');
  headRow.append(nameHead, scaleHead, valueHead);
  head.append(headRow);
  const body = document.createElement('tbody');
  for (const child of group.children) {
    const row = document.createElement('tr');
    const name = document.createElement('th');
    name.setAttribute('scope', 'row');
    name.textContent = child.title;
    const cell = document.createElement('td');
    cell.className = 'theme-track-cell';
    cell.setAttribute('aria-hidden', 'true');
    const track = document.createElement('div');
    track.className = 'theme-bar-track';
    const fill = document.createElement('span');
    fill.className = 'theme-bar-fill';
    fill.style.width = `${child.totalMs / scale * 100}%`;
    track.append(fill);
    cell.append(track);
    if (referenceMs > 0) {
      const marker = document.createElement('span');
      marker.className = 'subtheme-reference';
      marker.style.left = `${referenceMs / scale * 100}%`;
      cell.append(marker);
    }
    const amount = document.createElement('td');
    amount.className = 'theme-amount';
    amount.textContent = durationText(child.totalMs);
    row.append(name, cell, amount);
    body.append(row);
  }
  table.append(head, body);
  section.append(table);
  return section;
}

function renderThemes() {
  const all = themePeriodKind === 'all';
  const bounds = all ? null : periodBounds(themePeriodKind, themePeriodAnchor, dayStartMinutes);
  const selected = all ? sessions : sessions.map((session) => ({ ...session,
    workMs: workInRange(session, bounds.start, bounds.end) })).filter((session) => session.workMs > 0);
  const summary = summarize(groups, selected);
  $('theme-period-label').textContent = all ? '全期間' : periodLabel(bounds, themePeriodKind);
  for (const kind of ['day', 'week', 'month', 'year', 'all']) {
    $('theme-period-' + kind).setAttribute('aria-pressed', String(kind === themePeriodKind));
  }
  $('theme-period-prev').disabled = all;
  $('theme-period-next').disabled = all;
  $('theme-period-prev').hidden = all;
  $('theme-period-next').hidden = all;
  const unsetMs = summary.unclassified.reduce((sum, item) => sum + item.workMs, 0);
  const scale = themeScale(Math.max(unsetMs, ...summary.groups.map((group) => group.totalMs), 0));
  $('theme-scale').hidden = !groups.length && unsetMs === 0;
  $('theme-scale-max').textContent = durationText(scale);
  const groupList = $('group-list');
  groupList.replaceChildren();
  if (!groups.length) {
    const empty = document.createElement('p');
    empty.textContent = 'テーマはまだありません。下の入力欄から追加できます。';
    groupList.append(empty);
  }
  for (const group of summary.groups) {
    const original = groups.find((item) => item.id === group.id);
    const card = document.createElement('details');
    card.className = 'group-card theme-card';
    card.setAttribute('data-theme-id', group.id);
    card.open = openThemeIds.has(group.id);
    card.addEventListener('toggle', () => {
      if (card.isConnected === false) return;
      if (card.open) openThemeIds.add(group.id);
      else openThemeIds.delete(group.id);
    });
    const title = document.createElement('summary');
    title.className = 'theme-summary';
    title.append(themeBar(group.title, group.totalMs, scale));
    const chevron = document.createElement('span');
    chevron.className = 'theme-chevron';
    chevron.textContent = '›';
    chevron.setAttribute('aria-hidden', 'true');
    title.append(chevron);
    const detail = document.createElement('div');
    detail.className = 'theme-detail-content';
    if (group.children.length) detail.append(renderSubthemeChart(group));
    const direct = document.createElement('p');
    direct.className = 'subtle';
    direct.textContent = `サブテーマなし ${durationText(group.directMs)}`;
    if (group.directMs > 0) detail.append(direct);
    const menu = document.createElement('details');
    menu.className = 'theme-edit-menu';
    const menuTitle = document.createElement('summary');
    menuTitle.textContent = '編集';
    menu.append(menuTitle,
      rowButton('名前変更', `${group.title}の名前を変更`, () => renameItem(original, 'テーマ')),
      rowButton('削除', `${group.title}を削除`, () => removeGroup(original)));
    const children = document.createElement('ul');
    for (const child of group.children) {
      const item = document.createElement('li');
      const originalChild = original.children.find((entry) => entry.id === child.id);
      const label = document.createElement('span');
      label.textContent = child.title;
      item.append(label,
        rowButton('名前変更', `${child.title}の名前を変更`, () => renameItem(originalChild, 'サブテーマ')),
        rowButton('削除', `${child.title}を削除`, () => removeGroup(original, originalChild)));
      children.append(item);
    }
    menu.append(children);
    const form = document.createElement('form');
    form.className = 'inline-form';
    const input = document.createElement('input');
    input.type = 'text';
    input.maxLength = 60;
    input.required = true;
    input.placeholder = 'サブテーマを追加';
    input.setAttribute('aria-label', `${group.title}のサブテーマ名`);
    const add = document.createElement('button');
    add.type = 'submit';
    add.textContent = '＋サブテーマ';
    form.append(input, add);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const title = input.value.trim();
      if (!title) return;
      original.children.push({ id: newId(), title });
      persist();
      openThemeIds.add(group.id);
      renderGrowth();
    });
    detail.append(form, menu);
    card.append(title, detail);
    groupList.append(card);
  }
  $('theme-unset').replaceChildren();
  if (unsetMs > 0) $('theme-unset').append(themeBar('未設定', unsetMs, scale));
}

function renderDayRecords(bounds) {
  const list = $('record-list');
  list.replaceChildren();
  const unclassifiedOnly = $('unclassified-filter').checked;
  const records = sessions.filter((session) => workInRange(session, bounds.start, bounds.end) > 0 &&
    (!unclassifiedOnly || !targetLabel(groups, session.targetId)))
    .sort((a, b) => (a.startedAt ?? a.endedAt) - (b.startedAt ?? b.endedAt));
  $('day-record-count').textContent = `(${records.length})`;
  for (const session of records) {
    const row = document.createElement('article');
    row.className = 'record-row';
    const workMs = workInRange(session, bounds.start, bounds.end);
    const heading = growthLine(session.taskTitle || 'タスク未選択', workMs);
    heading.className += ' record-main';
    if (workMs < session.workMs) {
      const marker = document.createElement('small');
      marker.className = 'record-day-marker';
      marker.textContent = 'この日';
      heading.lastElementChild.append(marker);
    }
    const detail = document.createElement('p');
    detail.className = 'record-meta subtle';
    const range = document.createElement('span');
    range.className = 'record-range';
    range.textContent = `${session.startedAt == null ? '開始時刻なし' : recordTimeLabel(session.startedAt, bounds)} ～ ${recordTimeLabel(session.endedAt, bounds)}`;
    const target = document.createElement('span');
    target.textContent = targetLabel(groups, session.targetId) || '未設定';
    detail.append(range, target);
    row.append(heading, detail,
      rowButton('修正・削除', `${session.taskTitle || 'タスク未選択'}の記録を修正または削除`, () => openRecordEditor(session)));
    list.append(row);
  }
  if (!records.length) {
    const empty = document.createElement('p');
    empty.textContent = unclassifiedOnly ? 'テーマが未設定の記録はありません。' : 'この日の記録はありません。';
    list.append(empty);
  }
}

function renderRecordChildren(selected = '') {
  const group = groups.find((item) => item.id === $('record-group').value);
  const select = $('record-child');
  select.replaceChildren();
  appendOption(select, '', group ? 'サブテーマなし' : 'テーマを選択');
  for (const child of group?.children || []) appendOption(select, child.id, child.title);
  select.value = group?.children.some((child) => child.id === selected) ? selected : '';
  select.disabled = !group || !group.children.length;
}

function setRecordTarget(targetId) {
  const { groupId, childId } = taskTargetParts(targetId);
  $('record-group').replaceChildren();
  appendOption($('record-group'), '', '未設定');
  for (const group of groups) appendOption($('record-group'), group.id, group.title);
  $('record-group').value = groupId;
  renderRecordChildren(childId);
}

function openRecordEditor(session) {
  editingRecordId = session.id;
  $('record-start').value = session.startedAt == null ? '' : dateInputValue(session.startedAt);
  $('record-end').value = dateInputValue(session.endedAt);
  $('record-duration').value = String(session.workMs / 60_000);
  $('record-duration-label').hidden = session.startedAt != null;
  const taskSelect = $('record-task');
  taskSelect.replaceChildren();
  appendOption(taskSelect, '', 'タスク未選択');
  for (const task of tasks) appendOption(taskSelect, task.id, task.title);
  if (session.taskId && !tasks.some((task) => task.id === session.taskId)) {
    appendOption(taskSelect, session.taskId, `${session.taskTitle || '削除済みタスク'}（削除済み）`);
  }
  taskSelect.value = session.taskId || '';
  setRecordTarget(session.targetId);
  $('record-delete-group').hidden = sessions.filter((item) => item.recordGroupId === session.recordGroupId).length < 2;
  $('record-error').textContent = '';
  $('record-dialog').showModal();
}

function closeRecordEditor() {
  $('record-dialog').close();
  editingRecordId = null;
}

function saveRecord(event) {
  event.preventDefault();
  const session = sessions.find((item) => item.id === editingRecordId);
  if (!session) return;
  const startedAt = $('record-start').value ? new Date($('record-start').value).getTime() : null;
  const endedAt = new Date($('record-end').value).getTime();
  const workMs = startedAt == null ? Number($('record-duration').value) * 60_000 : endedAt - startedAt;
  const targetId = $('record-child').value || $('record-group').value || null;
  if (!Number.isFinite(endedAt) || (startedAt != null && !Number.isFinite(startedAt)) ||
      !Number.isFinite(workMs) || workMs <= 0 ||
      (startedAt != null && startedAt >= endedAt) ||
      (targetId && !targetLabel(groups, targetId))) {
    $('record-error').textContent = '日時と作業時間を確認してください。';
    return;
  }
  const taskId = $('record-task').value || null;
  const task = tasks.find((item) => item.id === taskId);
  Object.assign(session, { startedAt, endedAt, workMs, taskId,
    taskTitle: task?.title || (taskId ? session.taskTitle : null), targetId });
  recalculateTotal();
  persist();
  closeRecordEditor();
  renderGrowth();
  $('growth-status').textContent = '記録を修正しました。';
}

function deleteRecord(group) {
  const session = sessions.find((item) => item.id === editingRecordId);
  if (!session) return;
  const targets = group ? sessions.filter((item) => item.recordGroupId === session.recordGroupId) : [session];
  if (!confirm(`${targets.length}件の記録を削除しますか？`)) return;
  const removed = new Set(targets.map((item) => item.id));
  sessions = sessions.filter((item) => !removed.has(item.id));
  recalculateTotal();
  persist();
  closeRecordEditor();
  renderGrowth();
  $('growth-status').textContent = `${targets.length}件の記録を削除しました。`;
}

function validateSound(raw) {
  if (raw == null) return { ...DEFAULT_SOUND };
  if (!Number.isInteger(raw.volume) || raw.volume < 0 || raw.volume > 500 ||
      !Number.isInteger(raw.pitch) || raw.pitch < -12 || raw.pitch > 12) {
    throw new Error('音の設定が不正です。');
  }
  return { volume: raw.volume, pitch: raw.pitch };
}

function validateDayStart(value) {
  if (value === undefined) return DEFAULT_DAY_START;
  if (!Number.isInteger(value) || value < 0 || value >= 24 * 60) {
    throw new Error('1日の区切りの設定が不正です。');
  }
  return value;
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
      if (!Array.isArray(group.children)) throw new Error('サブテーマが不正です。');
      return group.children.map((child) => ({ id: takeId(child.id), title: title(child.title, 60) }));
    })(),
  }));
  const validTarget = (id) => id == null || Boolean(targetLabel(restoredGroups, id));
  const restoredTasks = raw.tasks.map((task) => {
    if (typeof task.firstStep !== 'string' || task.firstStep.length > 500 || !validTarget(task.targetId) ||
        (task.completedAt != null && (!Number.isFinite(task.completedAt) || task.completedAt < 0))) {
      throw new Error('タスクが不正です。');
    }
    return { id: takeId(task.id), title: title(task.title, 100),
      firstStep: task.firstStep, targetId: task.targetId || null, completedAt: task.completedAt ?? null };
  });
  const restoredSessions = raw.sessions.map((session) => {
    if (!Number.isFinite(session.workMs) || session.workMs < 0 ||
        !Number.isFinite(session.endedAt) || session.endedAt < 0 ||
        (session.startedAt != null && (!Number.isFinite(session.startedAt) ||
          session.startedAt < 0 || session.startedAt >= session.endedAt ||
          Math.abs(session.endedAt - session.startedAt - session.workMs) > 1)) ||
        !validTarget(session.targetId) ||
        (session.taskId != null && typeof session.taskId !== 'string') ||
        (session.taskTitle != null && typeof session.taskTitle !== 'string') ||
        (session.recordGroupId != null &&
          (typeof session.recordGroupId !== 'string' || !session.recordGroupId))) {
      throw new Error('計測記録が不正です。');
    }
    const id = takeId(session.id);
    return { id, recordGroupId: session.recordGroupId || id,
      startedAt: session.startedAt ?? null, endedAt: session.endedAt, workMs: session.workMs,
      taskId: session.taskId || null, taskTitle: session.taskTitle || null,
      targetId: session.targetId || null };
  });
  const restoredRun = raw.run == null ? null : restoreRun(raw.run);
  if (raw.run != null && !restoredRun) throw new Error('計測途中のデータが不正です。');
  const restoredTotal = raw.totalWorkMs;
  const recorded = restoredSessions.reduce((sum, session) => sum + session.workMs, 0) + (restoredRun?.sessionWorkMs || 0);
  if (!Number.isFinite(restoredTotal) || restoredTotal < 0 || restoredTotal + 1 < recorded ||
      (restoredRun && Math.abs(restoredRun.totalWorkMs - restoredTotal) > 1)) {
    throw new Error('累計時間が不正です。');
  }
  const restoredSelection = restoredTasks.some((task) => task.id === raw.selectedTaskId &&
    (restoredRun || task.completedAt == null))
    ? raw.selectedTaskId : null;
  return { steps: restoredSteps, tasks: restoredTasks, groups: restoredGroups,
    sessions: restoredSessions, run: restoredRun, totalWorkMs: restoredTotal,
    selectedTaskId: restoredSelection, sound: validateSound(raw.sound),
    dayStartMinutes: validateDayStart(raw.dayStartMinutes) };
}

function backupObject() {
  if (run?.status === 'running') handleEvent(advanceClock(run, Date.now()));
  return { format: BACKUP_FORMAT, version: 1, steps, tasks, groups, sessions,
    totalWorkMs: run?.totalWorkMs ?? totalWorkMs,
    run: run ? { ...run, status: 'paused', lastTick: null } : null,
    selectedTaskId, sound: soundSettings, dayStartMinutes };
}

function showSettings() {
  if (!settingsDraftActive) draft = steps.map((step) => ({ ...step }));
  settingsDraftActive = true;
  $('settings-error').textContent = '';
  $('permission-status').textContent = 'Notification' in window
    ? `通知の許可状態：${Notification.permission}` : 'この環境では通知を利用できません。';
  renderSettings();
  renderSoundSettings();
  renderDayStart();
  $('import-file').disabled = Boolean(run);
  switchView('settings');
}

function showTimer() {
  switchView('timer');
}

function renderDayStart() {
  $('day-start').value = `${String(Math.floor(dayStartMinutes / 60)).padStart(2, '0')}:${String(dayStartMinutes % 60).padStart(2, '0')}`;
}

$('day-start').addEventListener('change', () => {
  const value = $('day-start').value;
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) {
    $('day-start-error').textContent = '1日の区切りを設定してください。';
    renderDayStart();
    return;
  }
  const [hours, minutes] = value.split(':').map(Number);
  const selectedDay = new Date(periodBounds('day', periodAnchor, dayStartMinutes).start);
  selectedDay.setHours(hours, minutes, 0, 0);
  periodAnchor = selectedDay.getTime();
  const selectedThemeDay = new Date(periodBounds('day', themePeriodAnchor, dayStartMinutes).start);
  selectedThemeDay.setHours(hours, minutes, 0, 0);
  themePeriodAnchor = selectedThemeDay.getTime();
  dayStartMinutes = hours * 60 + minutes;
  $('day-start-error').textContent = persist() ? '' : '1日の区切りを保存できませんでした。';
  renderGrowth();
});

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
  if (!soundSettings.volume || !audioContext || audioContext.state !== 'running') return 0;
  const start = audioContext.currentTime;
  const frequencies = phase === 'work' ? [660, 880] : [659.25, 554.37, 440];
  const speed = phase === 'rest' ? 1.3 : 1;
  const pitchRatio = 2 ** (soundSettings.pitch / 12);
  const peakGain = 0.16 * soundSettings.volume / 100;
  frequencies.forEach((frequency, index) => {
    const at = start + index * 0.27 / speed;
    const oscillator = audioContext.createOscillator();
    const gain = audioContext.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.value = frequency * pitchRatio;
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(peakGain, at + 0.02 / speed);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.2 / speed);
    oscillator.connect(gain).connect(audioContext.destination);
    oscillator.start(at);
    oscillator.stop(at + 0.21 / speed);
  });
  return ((frequencies.length - 1) * 0.27 + 0.21) / speed;
}

function renderSoundSettings() {
  const displayedVolume = soundSettings.volume / SOUND_VOLUME_SCALE;
  $('sound-volume').value = String(displayedVolume);
  $('sound-pitch').value = String(soundSettings.pitch);
  $('sound-volume-value').textContent = soundSettings.volume === 0 ? '0%（消音）' : `${displayedVolume}%`;
  $('sound-pitch-value').textContent = soundSettings.pitch === 0 ? '標準'
    : `${soundSettings.pitch > 0 ? '＋' : '−'}${Math.abs(soundSettings.pitch)}半音`;
  $('sound-volume').setAttribute('aria-valuetext', $('sound-volume-value').textContent);
  $('sound-pitch').setAttribute('aria-valuetext', soundSettings.pitch === 0 ? '標準'
    : `標準より${Math.abs(soundSettings.pitch)}半音${soundSettings.pitch > 0 ? '高い' : '低い'}`);
  $('preview-work').disabled = $('preview-rest').disabled = previewPlaying || soundSettings.volume === 0;
}

function updateSoundSettings(id, save = false) {
  soundSettings = validateSound({ ...soundSettings,
    ...(id === 'sound-volume' ? { volume: Math.round(Number($('sound-volume').value) * SOUND_VOLUME_SCALE) }
      : { pitch: Number($('sound-pitch').value) }),
  });
  renderSoundSettings();
  if (save) $('sound-status').textContent = persist() ? '' : '音の設定を保存できませんでした。';
  if (save && run && soundSettings.volume) {
    void prepareAudio().then((ready) => {
      if (!ready && !$('sound-status').textContent) $('sound-status').textContent = '音を再生できませんでした。';
    });
  }
}

async function previewSound(phase) {
  if (previewPlaying || soundSettings.volume === 0) return;
  previewPlaying = true;
  $('sound-status').textContent = '';
  renderSoundSettings();
  try {
    if (!await prepareAudio()) throw new Error('音を再生できませんでした。');
    const duration = playSound(phase);
    setTimeout(() => { previewPlaying = false; renderSoundSettings(); }, Math.ceil(duration * 1000) + 50);
  } catch {
    previewPlaying = false;
    renderSoundSettings();
    $('sound-status').textContent = '音を再生できませんでした。';
  }
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
    $('status').textContent = '長時間の中断を検出したため一時停止しました。';
  } else {
    playSound(event.phase);
    notifyPhase(event.phase);
  }
  persist();
}

$('settings-toggle').addEventListener('click', showSettings);
for (const id of ['sound-volume', 'sound-pitch']) {
  $(id).addEventListener('input', () => updateSoundSettings(id));
  $(id).addEventListener('change', () => updateSoundSettings(id, true));
}
$('preview-work').addEventListener('click', () => previewSound('work'));
$('preview-rest').addEventListener('click', () => previewSound('rest'));
for (const view of ['timer', 'tasks', 'growth', 'themes']) {
  $(`nav-${view}`).addEventListener('click', () => switchView(view));
}
$('choose-task').addEventListener('click', () => {
  if (run && selectedTaskId) return;
  renderTaskPicker();
  $('task-picker-dialog').showModal();
});
$('timer-quick-task-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const input = $('timer-quick-task-title');
  const title = input.value.trim();
  if (!title) return;
  addQuickTask(title, true);
  input.value = '';
});
$('timer-task-details-add').addEventListener('click', () => openTaskEditor(null, true, 'timer-quick-task-title'));
$('task-picker-add').addEventListener('click', () => {
  $('task-picker-dialog').close();
  openTaskEditor(null, true);
});
$('task-picker-close').addEventListener('click', () => $('task-picker-dialog').close());
$('task-details-add').addEventListener('click', () => openTaskEditor(null, false, 'quick-task-title'));
$('task-undo').addEventListener('click', () => {
  const task = tasks.find((item) => item.id === taskUndo?.taskId);
  if (!task || task.completedAt !== taskUndo.completedAt) return;
  task.completedAt = null;
  if (!run && !selectedTaskId && taskUndo.selectedBefore === task.id) selectedTaskId = task.id;
  taskUndo = null;
  $('task-undo').hidden = true;
  persist();
  renderTasks();
  renderTaskChoice();
  $('task-status').textContent = 'タスクを未完了に戻しました。';
  document.getElementById(`task-title-${task.id}`)?.focus();
});
$('task-group').addEventListener('change', () => renderTaskChildren());
$('quick-task-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const input = $('quick-task-title');
  const title = input.value.trim();
  if (!title) return;
  addQuickTask(title);
  input.value = '';
});
$('task-form').addEventListener('submit', (event) => {
  event.preventDefault();
  saveTask(taskEditorSelectAfter);
});
$('task-save-only').addEventListener('click', () => saveTask(false));
$('task-cancel').addEventListener('click', resetTaskForm);
$('group-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const title = $('group-title').value.trim();
  if (!title) return;
  groups.push({ id: newId(), title, children: [] });
  $('group-form').reset();
  persist();
  renderGrowth();
  $('growth-status').textContent = 'テーマを追加しました。';
});
for (const kind of ['day', 'week', 'month', 'year']) {
  $('period-' + kind).addEventListener('click', () => {
    periodKind = kind;
    renderGrowth();
  });
}
$('period-prev').addEventListener('click', () => movePeriod(-1));
$('period-next').addEventListener('click', () => movePeriod(1));
for (const kind of ['day', 'week', 'month', 'year', 'all']) {
  $('theme-period-' + kind).addEventListener('click', () => {
    themePeriodKind = kind;
    renderThemes();
  });
}
for (const [id, direction] of [['theme-period-prev', -1], ['theme-period-next', 1]]) {
  $(id).addEventListener('click', () => {
    if (themePeriodKind === 'all') return;
    const next = new Date(periodBounds(themePeriodKind, themePeriodAnchor, dayStartMinutes).start);
    if (themePeriodKind === 'year') next.setFullYear(next.getFullYear() + direction);
    else if (themePeriodKind === 'month') next.setMonth(next.getMonth() + direction);
    else next.setDate(next.getDate() + direction * (themePeriodKind === 'week' ? 7 : 1));
    themePeriodAnchor = next.getTime();
    renderThemes();
  });
}
$('unclassified-filter').addEventListener('change', renderGrowth);
$('record-group').addEventListener('change', () => renderRecordChildren());
$('record-task').addEventListener('change', () => {
  const task = tasks.find((item) => item.id === $('record-task').value);
  if (task) setRecordTarget(task.targetId);
});
$('record-start').addEventListener('change', () => {
  $('record-duration-label').hidden = Boolean($('record-start').value);
});
$('record-form').addEventListener('submit', saveRecord);
$('record-cancel').addEventListener('click', closeRecordEditor);
$('record-delete').addEventListener('click', () => deleteRecord(false));
$('record-delete-group').addEventListener('click', () => deleteRecord(true));
$('add-step').addEventListener('click', () => {
  draft.push({ type: '', minutes: '' });
  renderSettings();
  $('step-list').lastElementChild?.querySelector('select')?.focus();
});
$('save-settings').addEventListener('click', () => {
  try {
    steps = normalizeSteps(draft);
    settingsDraftActive = false;
    if (run) $('status').textContent = '設定変更は次の開始から反映します。';
    persist();
    showTimer();
  } catch (error) {
    $('settings-error').textContent = error.message;
  }
});
$('cancel-settings').addEventListener('click', () => { settingsDraftActive = false; showTimer(); });

$('main-action').addEventListener('click', () => {
  if (!run && !steps.length) { showSettings(); return; }
  if (!run) {
    const audioReady = soundSettings.volume ? prepareAudio() : Promise.resolve(true);
    run = createRun(steps, totalWorkMs, Date.now());
    run.recordGroupId = newId();
    const startedRun = run;
    $('status').textContent = '';
    audioReady.then((ready) => {
      if (run !== startedRun || run.status !== 'running' || run.row !== 0 || run.looping) return;
      if (ready) playSound(startedRun.phase);
      else if (!$('status').textContent) $('status').textContent = '音を準備できませんでした。タイマーは続行中です。';
    });
  } else if (run.status === 'running') {
    handleEvent(pauseRun(run, Date.now()));
  } else {
    if (soundSettings.volume) void prepareAudio();
    resumeRun(run, Date.now());
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
  const task = tasks.find((item) => item.id === selectedTaskId);
  const recordGroupId = run.recordGroupId || newId();
  const taskFields = { taskId: task?.id || null, taskTitle: task?.title || null,
    targetId: task && targetLabel(groups, task.targetId) ? task.targetId : null };
  if (run.legacyWorkMs > 0) sessions.push({ id: newId(), recordGroupId,
    startedAt: null, endedAt: Date.now(), workMs: run.legacyWorkMs, ...taskFields });
  for (const interval of run.workIntervals) {
    sessions.push({ id: newId(), recordGroupId, startedAt: interval.startedAt,
      endedAt: interval.endedAt, workMs: interval.endedAt - interval.startedAt, ...taskFields });
  }
  run = null;
  selectedTaskId = null;
  $('status').textContent = `記録 ${durationText(gainedMs)}`;
  persist();
  renderTimer();
  renderTaskChoice();
  $('main-action').focus();
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
    ({ steps, tasks, groups, sessions, run, totalWorkMs, selectedTaskId, sound: soundSettings, dayStartMinutes } = next);
    settingsDraftActive = false;
    taskUndo = null;
    openThemeIds.clear();
    $('task-undo').hidden = true;
    $('status').textContent = '';
    persist();
    resetTaskForm();
    renderTimer();
    renderTaskChoice();
    renderSoundSettings();
    renderDayStart();
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
setInterval(() => {
  if (!run || run.status !== 'running') return;
  handleEvent(advanceClock(run, Date.now()));
  if (Date.now() - lastSaved >= 1000) persist();
  if (!$('timer-view').hidden) renderTimer();
}, 250);
})();
