(() => {
'use strict';

const { advanceClock, createRun, normalizeSteps, pauseRun, resumeRun, restoreRun, skipPhase } = globalThis.TimerCore;
const { targetLabel, summarize, clearTargets, periodBounds, workInRange, periodBuckets } = globalThis.PracticeData;

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
let taskEditorSelectAfter = false;
let periodKind = 'day';
let periodAnchor = Date.now();
let editingRecordId = null;
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

function renderTimer() {
  const activeSteps = run?.steps ?? steps;
  $('phase-name').textContent = run ? (run.phase === 'work' ? '作業' : '休憩')
    : activeSteps.length ? '開始できます' : '手順を設定してください';
  $('clock').textContent = run ? timeText(run.remainingMs, true) : '00:00';
  $('main-action').textContent = run?.status === 'running' ? '一時停止' : run ? '再開' : '開始';
  $('main-action').disabled = !run && !steps.length;
  $('skip').disabled = !run;
  $('end').disabled = !run;
}

function appendOption(select, value, label) {
  const option = document.createElement('option');
  option.value = value;
  option.textContent = label;
  select.append(option);
}

function renderTaskChoice() {
  const task = tasks.find((item) => item.id === selectedTaskId);
  $('active-task-name').textContent = task?.title || '未選択';
  $('active-task-hint').textContent = task
    ? `${task.firstStep || '最初の一手は未登録'}｜${run ? '別タスクへ移るときは終了して再開始します。' : '開始前なら選び直せます。'}`
    : run ? '選ぶ前の作業時間も、選んだタスクに加算します。' : '開始前にも、開始後にもタスクを選べます。';
  $('choose-task').textContent = task && !run ? 'タスクを選び直す' : 'タスクを選ぶ';
  $('choose-task').disabled = Boolean(run && selectedTaskId);
  renderTaskPicker();
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
    const title = document.createElement('strong');
    title.textContent = task.title;
    const detail = document.createElement('p');
    detail.textContent = task.firstStep || '最初の一手は未登録';
    const choose = rowButton('この回に選ぶ', `${task.title}をこの回に選ぶ`, () => {
      if ((run && selectedTaskId) || task.completedAt != null) return;
      selectedTaskId = task.id;
      persist();
      $('task-picker-dialog').close();
      renderTaskChoice();
    });
    item.append(title, detail, choose);
    list.append(item);
  }
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
  if ($('task-dialog').open) $('task-dialog').close();
  editingTaskId = null;
  taskEditorSelectAfter = false;
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
  appendOption(select, '', group ? '小分類なし（大分類へ加算）' : '大分類を先に選択');
  for (const child of group?.children || []) appendOption(select, child.id, child.title);
  select.value = group?.children.some((child) => child.id === selected) ? selected : '';
  select.disabled = !group || !group.children.length;
}

function openTaskEditor(task = null, selectAfter = false) {
  resetTaskForm();
  editingTaskId = task?.id || null;
  taskEditorSelectAfter = !task && selectAfter && Boolean(run && !selectedTaskId);
  $('task-title').value = task?.title || '';
  $('task-first-step').value = task?.firstStep || '';
  const { groupId, childId } = taskTargetParts(task?.targetId);
  const groupSelect = $('task-group');
  groupSelect.replaceChildren();
  appendOption(groupSelect, '', '未分類');
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
  persist();
  resetTaskForm();
  renderTasks();
  renderTaskChoice();
  const message = updating ? 'タスクを更新しました。' : selectedTaskId === task.id && selectAfter
    ? 'タスクを追加して、この回に選びました。' : 'タスクを追加しました。';
  $('task-status').textContent = message;
  if (!$('timer-view').hidden) $('status').textContent = message;
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
  if (!$('timer-view').hidden) $('status').textContent = message;
}

function taskRow(task, completed) {
  const item = document.createElement('li');
  const title = document.createElement('strong');
  title.textContent = task.title;
  const detail = document.createElement('p');
  detail.textContent = `最初の一手：${task.firstStep || '未登録'}｜加算先：${targetLabel(groups, task.targetId) || '未分類'}`;
  item.append(title, detail);
  if (completed) {
    const date = document.createElement('p');
    date.className = 'subtle';
    date.textContent = `完了：${new Date(task.completedAt).toLocaleDateString('ja-JP')}`;
    item.append(date);
  }
  const actions = document.createElement('div');
  actions.className = 'task-actions';
  actions.append(rowButton('編集', `${task.title}を編集`, () => openTaskEditor(task)));
  actions.append(completed
    ? rowButton('戻す', `${task.title}を未完了に戻す`, () => {
      task.completedAt = null;
      persist();
      renderTasks();
      renderTaskChoice();
      $('task-status').textContent = 'タスクを未完了に戻しました。';
    })
    : rowButton('完了', `${task.title}を完了にする`, () => {
      task.completedAt = Date.now();
      if (!run && selectedTaskId === task.id) selectedTaskId = null;
      persist();
      renderTasks();
      renderTaskChoice();
      $('task-status').textContent = '完了済みに移しました。';
    }));
  actions.append(rowButton('削除', `${task.title}を削除`, () => {
    if (!confirm(`「${task.title}」を削除しますか？過去の計測記録は残ります。`)) return;
    tasks = tasks.filter((item) => item.id !== task.id);
    if (selectedTaskId === task.id) selectedTaskId = null;
    persist();
    renderTasks();
    renderTaskChoice();
    $('task-status').textContent = 'タスクを削除しました。';
  }, Boolean(run && selectedTaskId === task.id)));
  item.append(actions);
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

function dateLabel(timestamp) {
  return new Date(timestamp).toLocaleString('ja-JP', {
    year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

function dateInputValue(timestamp) {
  const date = new Date(timestamp);
  return new Date(timestamp - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 19);
}

function periodLabel(bounds) {
  const start = new Date(bounds.start);
  const end = new Date(bounds.end - 1);
  if (periodKind === 'year') return `${start.getFullYear()}年`;
  if (periodKind === 'month') return `${start.getFullYear()}年${start.getMonth() + 1}月`;
  if (periodKind === 'week') return `${start.toLocaleDateString('ja-JP')} ～ ${end.toLocaleDateString('ja-JP')}`;
  return start.toLocaleDateString('ja-JP', { year: 'numeric', month: 'numeric', day: 'numeric', weekday: 'short' });
}

function movePeriod(direction) {
  const next = new Date(periodAnchor);
  next.setHours(12, 0, 0, 0);
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
  const bounds = periodBounds(periodKind, periodAnchor);
  const periodSessions = sessions.map((session) => ({ ...session,
    workMs: workInRange(session, bounds.start, bounds.end) })).filter((session) => session.workMs > 0);
  const periodMs = periodSessions.reduce((sum, session) => sum + session.workMs, 0);
  $('period-label').textContent = periodLabel(bounds);
  for (const kind of ['day', 'week', 'month', 'year']) {
    $('period-' + kind).setAttribute('aria-pressed', String(kind === periodKind));
  }
  $('growth-total').textContent = `この期間 ${timeText(periodMs)}｜全期間 ${timeText(run?.totalWorkMs ?? totalWorkMs)}`;
  const chart = $('period-chart');
  chart.replaceChildren();
  const buckets = periodBuckets(periodKind, periodAnchor, sessions);
  chart.hidden = !buckets.some((bucket) => bucket.workMs > 0);
  const largest = Math.max(1, ...buckets.map((bucket) => bucket.workMs));
  for (const bucket of buckets) {
    const date = new Date(bucket.start);
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'period-bar';
    const fill = document.createElement('div');
    fill.className = 'period-bar-fill';
    fill.style.height = `${bucket.workMs / largest * 100}%`;
    const label = document.createElement('small');
    label.textContent = periodKind === 'year' ? `${date.getMonth() + 1}月`
      : periodKind === 'week' ? `${date.getMonth() + 1}/${date.getDate()}` : String(date.getDate());
    item.setAttribute('aria-label', `${label.textContent} ${timeText(bucket.workMs)}`);
    item.title = `${label.textContent} ${timeText(bucket.workMs)}`;
    item.addEventListener('click', () => {
      date.setHours(12, 0, 0, 0);
      periodAnchor = date.getTime();
      periodKind = periodKind === 'year' ? 'month' : 'day';
      renderGrowth();
    });
    item.append(fill, label);
    chart.append(item);
  }
  const periodSummary = summarize(groups, periodSessions);
  const breakdown = $('period-group-list');
  breakdown.replaceChildren();
  const unclassifiedMs = periodSummary.unclassified.reduce((sum, item) => sum + item.workMs, 0);
  for (const group of periodSummary.groups.filter((item) => item.totalMs > 0)) {
    const row = document.createElement('p');
    const children = group.children.filter((item) => item.totalMs > 0)
      .map((item) => `${item.title} ${timeText(item.totalMs)}`).join('、');
    row.textContent = `${group.title} ${timeText(group.totalMs)}${children ? `（${children}）` : ''}`;
    breakdown.append(row);
  }
  if (unclassifiedMs > 0) {
    const row = document.createElement('p');
    row.textContent = `加算先なし ${timeText(unclassifiedMs)}`;
    breakdown.append(row);
  }
  if (!breakdown.children.length) {
    const empty = document.createElement('p');
    empty.textContent = 'この期間の記録はありません。';
    breakdown.append(empty);
  }
  $('day-records').hidden = periodKind !== 'day';
  if (periodKind === 'day') renderDayRecords(bounds);

  const summary = summarize(groups, sessions);
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
    const heading = document.createElement('strong');
    const workMs = workInRange(session, bounds.start, bounds.end);
    heading.textContent = `${session.startedAt == null ? '開始時刻なし' : dateLabel(session.startedAt)} ～ ${dateLabel(session.endedAt)}｜${timeText(workMs)}${workMs < session.workMs ? '（この日）' : ''}`;
    const detail = document.createElement('p');
    detail.textContent = `${session.taskTitle || 'タスク未選択'}｜${targetLabel(groups, session.targetId) || '加算先なし'}`;
    row.append(heading, detail,
      rowButton('修正・削除', `${session.taskTitle || 'タスク未選択'}の記録を修正または削除`, () => openRecordEditor(session)));
    list.append(row);
  }
  if (!records.length) {
    const empty = document.createElement('p');
    empty.textContent = unclassifiedOnly ? '加算先のない記録はありません。' : 'この日の記録はありません。';
    list.append(empty);
  }
}

function renderRecordChildren(selected = '') {
  const group = groups.find((item) => item.id === $('record-group').value);
  const select = $('record-child');
  select.replaceChildren();
  appendOption(select, '', group ? '小分類なし（大分類へ加算）' : '大分類を先に選択');
  for (const child of group?.children || []) appendOption(select, child.id, child.title);
  select.value = group?.children.some((child) => child.id === selected) ? selected : '';
  select.disabled = !group || !group.children.length;
}

function setRecordTarget(targetId) {
  const { groupId, childId } = taskTargetParts(targetId);
  $('record-group').replaceChildren();
  appendOption($('record-group'), '', '未分類');
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
$('timer-task-details-add').addEventListener('click', () => openTaskEditor(null, true));
$('task-picker-add').addEventListener('click', () => {
  $('task-picker-dialog').close();
  openTaskEditor(null, true);
});
$('task-picker-close').addEventListener('click', () => $('task-picker-dialog').close());
$('task-details-add').addEventListener('click', () => openTaskEditor());
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
  $('growth-status').textContent = '育成項目を追加しました。';
});
for (const kind of ['day', 'week', 'month', 'year']) {
  $('period-' + kind).addEventListener('click', () => {
    periodKind = kind;
    renderGrowth();
  });
}
$('period-prev').addEventListener('click', () => movePeriod(-1));
$('period-next').addEventListener('click', () => movePeriod(1));
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
    run.recordGroupId = newId();
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
