(() => {
'use strict';

const { advanceClock, createRun, normalizeSteps, pauseRun, resumeRun, restoreRun, skipPhase } = globalThis.TimerCore;
const { targetLabel, summarize, clearTargets, periodBounds, workInRange, periodBuckets } = globalThis.PracticeData;

const STORAGE_KEY = 'practice-timer-v1';
const BACKUP_FORMAT = 'practice-timer-beta';
const { EVENTS: SOUND_EVENTS, BUILT_INS, validateSound, synthesize } = globalThis.PracticeSounds;
const DEFAULT_DAY_START = 5 * 60;
const desktop = globalThis.practiceDesktop;
// 保存値の尺度は旧版のままにして、画面の1%を従来の5%分に対応させる。
const SOUND_VOLUME_SCALE = 5;
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
let taskDrag = null;
let stepDrag = null;
let taskPickerScrollTop = 0;
let taskEditorSource = null;
let taskUndo = null;
let periodKind = 'day';
let periodAnchor = Date.now();
let themePeriodKind = 'all';
let themePeriodAnchor = Date.now();
let activeThemeId = null;
const UNASSIGNED_THEME = Symbol('unassigned');
let editingRecordId = null;
let renamingThemeItem = null;
let audioContext = null;
let soundSettings = validateSound(null);
let macSounds = [];
let macSoundsReady = Promise.resolve();
let macSoundsFailed = false;
let dayStartMinutes = DEFAULT_DAY_START;
let previewPlaying = false;
let lastSaved = 0;
let backupFiles = null;
let localDataReadable = true;
const newId = () => globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;

function load() {
  try {
    const result = desktop?.loadState();
    if (result && !result.ok) throw new Error(result.error);
    const saved = JSON.parse((desktop ? result.value : localStorage.getItem(STORAGE_KEY)) || '{}');
    if (saved.format === BACKUP_FORMAT) {
      ({ steps, tasks, groups, sessions, run, totalWorkMs, selectedTaskId, sound: soundSettings, dayStartMinutes } = validateBackup(saved));
      return;
    }
    if (Array.isArray(saved.steps) && saved.steps.length) steps = normalizeSteps(saved.steps, { requireBoth: false });
    if (Number.isFinite(saved.totalWorkMs) && saved.totalWorkMs >= 0) totalWorkMs = saved.totalWorkMs;
    run = restoreRun(saved.run);
    if (run) totalWorkMs = run.totalWorkMs;
    if (totalWorkMs > (run?.sessionWorkMs || 0)) {
      const id = newId();
      sessions.push({ id, recordGroupId: id, startedAt: null, endedAt: Date.now(),
        workMs: totalWorkMs - (run?.sessionWorkMs || 0),
        taskId: null, taskTitle: 'Previous total', targetId: null });
    }
  } catch {
    localDataReadable = false;
    $('status').textContent = 'Could not read saved data. Check Settings.';
    if (desktop) {
      $('desktop-save-status').textContent = 'Saved data could not be read. Import a JSON backup to restore it.';
      $('desktop-banner').hidden = false;
    }
  }
}

function persist() {
  backupFiles?.changed(JSON.stringify(currentBackup()));
  try {
    if (desktop && !localDataReadable) throw new Error('Saved data could not be read. Import a JSON backup to restore it.');
    const value = JSON.stringify({ format: BACKUP_FORMAT, version: 1,
      steps, run, totalWorkMs: run?.totalWorkMs ?? totalWorkMs,
      tasks, groups, sessions, selectedTaskId, sound: soundSettings, dayStartMinutes });
    if (desktop) {
      const result = desktop.saveState(value);
      if (!result.ok) throw new Error(result.error || 'Could not save on this Mac.');
      $('desktop-save-status').textContent = '';
      $('desktop-banner').hidden = true;
    } else localStorage.setItem(STORAGE_KEY, value);
    lastSaved = Date.now();
    publishDesktop();
    return true;
  } catch (error) {
    $('status').textContent = desktop ? 'Could not save on this Mac. Export a JSON backup before quitting.'
      : 'Could not save in this browser. Check your storage settings.';
    if (desktop) {
      $('desktop-save-status').textContent = error.message;
      $('desktop-banner').hidden = false;
    }
    return false;
  }
}

function publishDesktop() {
  if (!desktop) return;
  let canStart = false;
  try { normalizeSteps(steps); canStart = localDataReadable; } catch {}
  desktop.publish({ status: run?.status || 'ready', phase: run?.phase || steps[0]?.type || 'work',
    time: timeText(run?.remainingMs ?? (steps[0]?.minutes || 0) * 60_000, true),
    task: tasks.find(task => task.id === selectedTaskId)?.title || '', canStart });
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
  publishDesktop();
  const activeSteps = run?.steps ?? steps;
  const phase = run?.phase ?? activeSteps[0]?.type;
  const phaseLabel = phase === 'work' ? 'Work' : 'Break';
  const stateLabel = run ? (run.status === 'running' ? ' · running' : ' · paused') : ' · ready';
  labelControl($('phase-name'), phase ? phaseLabel + stateLabel : 'No timer sequence');
  $('phase-icon').setAttribute('href', `#icon-${phase === 'work' ? 'work' : phase ? 'rest' : 'settings'}`);
  $('phase-paused').hidden = run?.status !== 'paused';
  const remainingMs = run?.remainingMs ?? ((steps[0]?.minutes || 0) * 60_000);
  $('clock').textContent = timeText(remainingMs, true);
  $('clock').classList.toggle('has-hours', remainingMs >= 3_600_000);
  const phaseMs = (activeSteps[run?.row ?? 0]?.minutes || 0) * 60_000;
  const remaining = phaseMs ? Math.max(0, Math.min(1, remainingMs / phaseMs)) : 0;
  $('timer-ring-remaining').setAttribute('stroke-dasharray', `${remaining * 100} 100`);
  $('timer-dial').classList.toggle('is-rest', phase === 'rest');
  $('timer-logged').textContent = durationText(run?.sessionWorkMs || 0);
  labelControl($('main-action'), run?.status === 'running' ? 'Pause' : run ? 'Resume' : steps.length ? 'Start' : 'Set up timer');
  $('main-action-icon').setAttribute('href', `#icon-${run?.status === 'running' ? 'pause' : run || steps.length ? 'play' : 'settings'}`);
  $('main-action').disabled = false;
  $('skip').hidden = !run;
  $('end').hidden = !run;
  $('skip').disabled = !run;
  $('end').disabled = !run;
  if (run) {
    const nextType = !run.looping && run.row < run.steps.length - 1
      ? run.steps[run.row + 1].type : run.phase === 'work' ? 'rest' : 'work';
    labelControl($('skip'), nextType === 'work' ? 'Next work phase' : 'Skip to break');
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

function renderTaskChoice(rebuildPicker = true) {
  const task = tasks.find((item) => item.id === selectedTaskId);
  $('active-task-name').textContent = task?.title || '';
  $('active-task-name').title = task?.title || '';
  $('active-task-name').hidden = !task;
  $('active-task-hint').textContent = task?.firstStep || '';
  $('active-task-hint').title = task?.firstStep || '';
  $('active-task-hint').hidden = !task?.firstStep;
  const hideList = Boolean(run && selectedTaskId);
  $('timer-layout').setAttribute('data-running', String(hideList));
  if (!rebuildPicker && !$('active-task-panel').hidden) taskPickerScrollTop = $('task-picker-list').scrollTop;
  if (rebuildPicker) renderTaskPicker();
  else for (const row of $('task-picker-list').children) {
    const choose = row.querySelector('button');
    if (choose) {
      const selected = row.getAttribute('data-task-id') === selectedTaskId;
      choose.setAttribute('aria-pressed', String(selected));
      const task = tasks.find((item) => item.id === row.getAttribute('data-task-id'));
      choose.setAttribute('aria-label', `${selected ? 'Edit' : 'Select'} ${task.title}`);
      choose.disabled = hideList;
    }
  }
  $('active-task-panel').hidden = hideList;
  if (!hideList) $('task-picker-list').scrollTop = taskPickerScrollTop;
}

function chooseTask(task, focusTimer = true) {
  if ((run && selectedTaskId) || task.completedAt != null) return;
  selectedTaskId = task.id;
  persist();
  if ($('timer-view').hidden) switchView('timer');
  else renderTaskChoice(false);
  if (focusTimer) $('main-action').focus();
}

function renderTaskPicker() {
  cancelTaskDrag();
  const list = $('task-picker-list');
  const scrollTop = $('active-task-panel').hidden ? taskPickerScrollTop : list.scrollTop;
  taskPickerScrollTop = scrollTop;
  list.replaceChildren();
  const available = tasks.filter((task) => task.completedAt == null);
  if (!available.length) {
    const empty = document.createElement('li');
    empty.textContent = 'No tasks yet. Add something to practice.';
    list.append(empty);
  }
  for (const task of available) {
    const item = document.createElement('li');
    const choose = rowButton(task.title, `${task.id === selectedTaskId ? 'Edit' : 'Select'} ${task.title}`, () => {
      if (task.id === selectedTaskId) openTaskEditor(task);
      else chooseTask(task, false);
    });
    choose.className = 'task-pick';
    choose.setAttribute('aria-pressed', String(task.id === selectedTaskId));
    choose.disabled = Boolean(run && selectedTaskId);
    item.className = 'task-pick-row';
    item.setAttribute('data-task-id', task.id);
    choose.title = task.title;
    item.append(choose, taskDragHandle(task, item, 'task-picker-list'));
    list.append(item);
  }
  list.scrollTop = scrollTop;
}

function switchView(name) {
  cancelTaskDrag();
  cancelStepDrag();
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
  wrapper.className = 'step-type';
  const label = document.createElement('span'); label.className = 'sr-only'; label.textContent = 'Type';
  wrapper.append(label);
  const select = document.createElement('select');
  for (const [text, optionValue] of [['Type', ''], ['Work', 'work'], ['Break', 'rest']]) {
    const option = document.createElement('option');
    option.textContent = text;
    option.value = optionValue;
    select.append(option);
  }
  select.value = value;
  select.addEventListener('change', () => { draft[index].type = select.value; applyRoutine(); });
  wrapper.append(select);
  return wrapper;
}

function numberField(value, index) {
  const wrapper = document.createElement('label');
  wrapper.className = 'step-minutes';
  const label = document.createElement('span'); label.className = 'sr-only'; label.textContent = 'Minutes';
  wrapper.append(label);
  const input = document.createElement('input');
  input.type = 'number';
  input.min = '0.1';
  input.max = '240';
  input.step = '0.1';
  input.required = true;
  input.inputMode = 'decimal';
  input.value = value;
  input.addEventListener('input', () => { draft[index].minutes = input.value; applyRoutine(); });
  const unit = document.createElement('span'); unit.className = 'step-minute-unit'; unit.textContent = 'm'; unit.setAttribute('aria-hidden', 'true');
  wrapper.append(input, unit);
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

function editIconButton(title, onClick) {
  const button = rowButton('', title, (event) => {
    event.preventDefault();
    event.stopPropagation();
    onClick();
  });
  button.className = 'theme-edit';
  const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  icon.setAttribute('class', 'icon');
  icon.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', '#icon-work');
  icon.append(use); button.append(icon);
  return button;
}

function moveRow(from, to) {
  if (to < 0 || to >= draft.length || from === to) return;
  const [row] = draft.splice(from, 1);
  draft.splice(to, 0, row);
  applyRoutine();
  renderSettings();
  $('step-list').children[to]?.querySelector('button')?.focus({ preventScroll: true });
}

function cancelStepDrag() {
  const drag = stepDrag;
  if (!drag) return;
  stepDrag = null;
  globalThis.cancelAnimationFrame?.(drag.frame);
  drag.item.classList.toggle('step-dragging', false);
  drag.target?.classList.toggle('step-drop-before', false);
  drag.target?.classList.toggle('step-drop-after', false);
  if (drag.handle.hasPointerCapture?.(drag.pointerId)) drag.handle.releasePointerCapture(drag.pointerId);
}

function updateStepDrop(drag) {
  drag.target?.classList.toggle('step-drop-before', false);
  drag.target?.classList.toggle('step-drop-after', false);
  const target = document.elementFromPoint(drag.x, drag.y)?.closest('[data-step-index]');
  drag.target = target?.parentElement === $('step-list') && target !== drag.item ? target : null;
  if (!drag.target) return;
  const bounds = drag.target.getBoundingClientRect();
  drag.after = drag.y >= bounds.top + bounds.height / 2;
  drag.target.classList.toggle(drag.after ? 'step-drop-after' : 'step-drop-before', true);
}

function stepDragHandle(item, index) {
  const handle = rowButton('⠿', `Reorder step ${index + 1} (drag or use arrow keys)`, () => {});
  handle.className = 'step-drag-handle';
  handle.addEventListener('keydown', event => {
    if (event.key === 'Escape') { cancelStepDrag(); return; }
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    event.preventDefault();
    moveRow(index, index + (event.key === 'ArrowUp' ? -1 : 1));
  });
  handle.addEventListener('pointerdown', event => {
    if (event.button !== 0 || event.isPrimary === false) return;
    cancelStepDrag();
    stepDrag = { handle, item, index, pointerId: event.pointerId, active: false,
      startX: event.clientX, startY: event.clientY, x: event.clientX, y: event.clientY };
    handle.setPointerCapture(event.pointerId);
  });
  handle.addEventListener('pointermove', event => {
    const drag = stepDrag;
    if (!drag || drag.handle !== handle || event.pointerId !== drag.pointerId) return;
    drag.x = event.clientX;
    drag.y = event.clientY;
    if (!drag.active && Math.hypot(drag.x - drag.startX, drag.y - drag.startY) < 6) return;
    event.preventDefault();
    if (!drag.active) {
      drag.active = true;
      item.classList.toggle('step-dragging', true);
      const scroll = () => {
        if (stepDrag !== drag) return;
        if (drag.y < 48) window.scrollBy?.(0, -12);
        else if (drag.y > window.innerHeight - 48) window.scrollBy?.(0, 12);
        updateStepDrop(drag);
        drag.frame = globalThis.requestAnimationFrame?.(scroll);
      };
      drag.frame = globalThis.requestAnimationFrame?.(scroll);
    }
    updateStepDrop(drag);
  });
  handle.addEventListener('pointerup', event => {
    const drag = stepDrag;
    if (!drag || drag.handle !== handle || event.pointerId !== drag.pointerId) return;
    if (drag.active) { drag.x = event.clientX; drag.y = event.clientY; updateStepDrop(drag); }
    const target = drag.active ? drag.target : null;
    const targetIndex = target ? Number(target.getAttribute('data-step-index')) : index;
    const to = target ? targetIndex + Number(drag.after) - Number(targetIndex > index) : index;
    cancelStepDrag();
    moveRow(index, to);
  });
  for (const type of ['pointercancel', 'lostpointercapture']) handle.addEventListener(type, () => {
    if (stepDrag?.handle === handle) cancelStepDrag();
  });
  return handle;
}

function renderSettings() {
  cancelStepDrag();
  const list = $('step-list');
  list.replaceChildren();
  draft.forEach((step, index) => {
    const item = document.createElement('li');
    item.setAttribute('data-step-index', String(index));
    const row = document.createElement('div');
    row.className = 'step-row';
    const remove = rowButton('×', `Delete step ${index + 1}`, () => { draft.splice(index, 1); applyRoutine(); renderSettings(); });
    remove.className = 'step-delete';
    row.append(stepDragHandle(item, index), typeField(step.type, index), numberField(step.minutes, index), remove);
    item.append(row);
    list.append(item);
  });
}

function resetTaskForm() {
  if ($('task-dialog').open) $('task-dialog').close();
  editingTaskId = null;
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
  appendOption(select, '', group ? 'No subtheme' : 'Choose a theme');
  for (const child of group?.children || []) appendOption(select, child.id, child.title);
  select.value = group?.children.some((child) => child.id === selected) ? selected : '';
  select.disabled = !group || !group.children.length;
}

function openTaskEditor(task = null, source = null) {
  resetTaskForm();
  editingTaskId = task?.id || null;
  taskEditorSource = source;
  $('task-title').value = task?.title || (source ? $(source).value.trim() : '');
  $('task-first-step').value = task?.firstStep || '';
  const { groupId, childId } = taskTargetParts(task?.targetId);
  const groupSelect = $('task-group');
  groupSelect.replaceChildren();
  appendOption(groupSelect, '', 'Unassigned');
  for (const group of groups) appendOption(groupSelect, group.id, group.title);
  groupSelect.value = groupId;
  renderTaskChildren(childId);
  $('task-dialog-title').textContent = task ? 'Edit task' : 'Add task';
  $('task-save').textContent = task ? 'Save changes' : 'Add';
  $('task-delete').hidden = !task;
  $('task-delete').disabled = Boolean(task && run && selectedTaskId === task.id);
  $('task-dialog').showModal();
  $('task-title').focus();
}

function saveTask() {
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
    tasks.unshift(task);
  }
  if (taskEditorSource) $(taskEditorSource).value = '';
  persist();
  resetTaskForm();
  renderTasks();
  renderTaskChoice();
  const message = updating ? 'Task updated.' : 'Task added.';
  $('task-status').textContent = message;
  if (!$('tasks-view').hidden) document.getElementById(`task-title-${task.id}`)?.focus();
  else if (!$('timer-view').hidden) $('main-action').focus();
}

function addQuickTask(title, selectAfter = false) {
  const task = { id: newId(), title, firstStep: '', targetId: null, completedAt: null };
  tasks.unshift(task);
  if (selectAfter && !(run && selectedTaskId)) selectedTaskId = task.id;
  persist();
  renderTasks();
  renderTaskChoice();
  const message = selectedTaskId === task.id
    ? 'Task added and selected for this session.' : 'Task added.';
  $('task-status').textContent = message;
  if (!$('timer-view').hidden && selectedTaskId === task.id) $('main-action').focus();
}

function clearTaskUndo() {
  taskUndo = null;
  $('task-undo').hidden = true;
  $('task-toast').hidden = true;
}

function keepTaskScroll(action) {
  const left = window.scrollX;
  const top = window.scrollY;
  action();
  window.scrollTo?.({ left, top, behavior: 'instant' });
}

function setTaskCompleted(task, completed) {
  const activeIndex = tasks.filter((item) => item.completedAt == null).indexOf(task);
  const selectedBefore = selectedTaskId;
  task.completedAt = completed ? Date.now() : null;
  if (completed && !run && selectedTaskId === task.id) selectedTaskId = null;
  clearTaskUndo();
  if (completed) {
    const undo = { taskId: task.id, completedAt: task.completedAt, selectedBefore };
    taskUndo = undo;
    $('task-undo').hidden = false;
    $('task-toast').hidden = false;
    setTimeout(() => { if (taskUndo === undo) clearTaskUndo(); }, 5000);
  }
  persist();
  keepTaskScroll(() => {
    renderTasks();
    renderTaskChoice();
    if (completed) {
      const rows = $('task-list').children;
      rows[Math.max(0, Math.min(activeIndex, rows.length - 1))]?.querySelector('input')?.focus({ preventScroll: true });
    } else document.getElementById(`task-title-${task.id}`)?.focus({ preventScroll: true });
  });
  $('task-status').textContent = completed ? `Completed “${task.title}”.` : 'Task marked as unfinished.';
}

function taskRow(task, completed) {
  const item = document.createElement('li');
  item.className = 'task-row';
  const checkLabel = document.createElement('label');
  checkLabel.className = 'task-check';
  const check = document.createElement('input');
  check.type = 'checkbox';
  check.checked = completed;
  check.setAttribute('aria-label', `${completed ? 'Mark unfinished' : 'Mark complete'}: ${task.title}`);
  check.addEventListener('change', () => setTaskCompleted(task, check.checked));
  checkLabel.append(check);
  const title = rowButton(task.title, `Edit ${task.title}`, () => openTaskEditor(task));
  title.id = `task-title-${task.id}`;
  title.className = 'task-title-button';
  item.append(checkLabel, title);
  if (!completed) {
    item.setAttribute('data-task-id', task.id);
    item.append(taskDragHandle(task, item, 'task-list'));
  }
  return item;
}

function moveTask(id, targetId, after, listId) {
  if (id === targetId) return;
  const task = tasks.find((item) => item.id === id && item.completedAt == null);
  const target = tasks.find((item) => item.id === targetId && item.completedAt == null);
  if (!task || !target) return;
  tasks.splice(tasks.indexOf(task), 1);
  tasks.splice(tasks.indexOf(target) + Number(after), 0, task);
  persist();
  renderTasks();
  renderTaskChoice();
  const handleId = `${listId}-drag-${id}`;
  document.getElementById(handleId)?.focus({ preventScroll: true });
  $('task-status').textContent = `Reordered “${task.title}”.`;
}

function cancelTaskDrag() {
  const drag = taskDrag;
  if (!drag) return;
  taskDrag = null;
  globalThis.cancelAnimationFrame?.(drag.frame);
  drag.row.classList.toggle('task-dragging', false);
  drag.target?.classList.toggle('task-drop-before', false);
  drag.target?.classList.toggle('task-drop-after', false);
  if (drag.handle.hasPointerCapture?.(drag.pointerId)) drag.handle.releasePointerCapture(drag.pointerId);
}

function updateTaskDrop(drag) {
  drag.target?.classList.toggle('task-drop-before', false);
  drag.target?.classList.toggle('task-drop-after', false);
  const target = document.elementFromPoint(drag.x, drag.y)?.closest('[data-task-id]');
  drag.target = target?.parentElement === drag.list && target !== drag.row ? target : null;
  if (!drag.target) return;
  const bounds = drag.target.getBoundingClientRect();
  drag.after = drag.y >= bounds.top + bounds.height / 2;
  drag.target.classList.toggle(drag.after ? 'task-drop-after' : 'task-drop-before', true);
}

function taskDragHandle(task, row, listId) {
  const handle = document.createElement('button');
  handle.type = 'button';
  handle.id = `${listId}-drag-${task.id}`;
  handle.className = 'task-drag-handle';
  handle.textContent = '⠿';
  handle.setAttribute('aria-label', `Reorder ${task.title} (drag or use arrow keys)`);
  handle.title = 'Drag to reorder';
  handle.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    event.preventDefault();
    const active = tasks.filter((item) => item.completedAt == null);
    const direction = event.key === 'ArrowUp' ? -1 : 1;
    const target = active[active.indexOf(task) + direction];
    if (target) moveTask(task.id, target.id, direction > 0, listId);
  });
  handle.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || event.isPrimary === false) return;
    cancelTaskDrag();
    taskDrag = { handle, row, list: $(listId), id: task.id, pointerId: event.pointerId,
      startX: event.clientX, startY: event.clientY, x: event.clientX, y: event.clientY, active: false };
    handle.setPointerCapture(event.pointerId);
  });
  handle.addEventListener('pointermove', (event) => {
    const drag = taskDrag;
    if (!drag || drag.handle !== handle || event.pointerId !== drag.pointerId) return;
    drag.x = event.clientX;
    drag.y = event.clientY;
    if (!drag.active && Math.hypot(drag.x - drag.startX, drag.y - drag.startY) < 6) return;
    event.preventDefault();
    if (!drag.active) {
      drag.active = true;
      row.classList.toggle('task-dragging', true);
      const scroll = () => {
        if (taskDrag !== drag) return;
        const bounds = drag.list.getBoundingClientRect();
        if (drag.x >= bounds.left && drag.x <= bounds.right && drag.y >= bounds.top && drag.y <= bounds.bottom) {
          if (drag.y < bounds.top + 32) drag.list.scrollTop -= 12;
          else if (drag.y > bounds.bottom - 32) drag.list.scrollTop += 12;
        }
        updateTaskDrop(drag);
        drag.frame = globalThis.requestAnimationFrame?.(scroll);
      };
      drag.frame = globalThis.requestAnimationFrame?.(scroll);
    }
    updateTaskDrop(drag);
  });
  handle.addEventListener('pointerup', (event) => {
    const drag = taskDrag;
    if (!drag || drag.handle !== handle || event.pointerId !== drag.pointerId) return;
    if (drag.active) {
      drag.x = event.clientX;
      drag.y = event.clientY;
      updateTaskDrop(drag);
    }
    const targetId = drag.active ? drag.target?.getAttribute('data-task-id') : null;
    cancelTaskDrag();
    if (targetId) moveTask(drag.id, targetId, drag.after, listId);
  });
  for (const type of ['pointercancel', 'lostpointercapture']) handle.addEventListener(type, () => {
    if (taskDrag?.handle === handle) cancelTaskDrag();
  });
  return handle;
}

function renderTasks() {
  cancelTaskDrag();
  const active = tasks.filter((task) => task.completedAt == null);
  const completed = tasks.filter((task) => task.completedAt != null)
    .sort((a, b) => b.completedAt - a.completedAt);
  $('completed-count').textContent = `(${completed.length})`;
  const activeList = $('task-list');
  const completedList = $('completed-list');
  activeList.replaceChildren();
  completedList.replaceChildren();
  for (const task of active) activeList.append(taskRow(task, false));
  for (const task of completed) completedList.append(taskRow(task, true));
  if (!active.length) {
    const empty = document.createElement('li');
    empty.textContent = 'No unfinished tasks. Add one below.';
    activeList.append(empty);
  }
  if (!completed.length) {
    const empty = document.createElement('li');
    empty.textContent = 'No completed tasks yet.';
    completedList.append(empty);
  }
}

function renameItem(item, label) {
  renamingThemeItem = item;
  $('theme-name-title').textContent = `${label} name`;
  $('theme-name').value = item.title;
  $('theme-name-error').textContent = '';
  $('theme-name-delete').textContent = `Delete ${label.toLowerCase()}`;
  $('theme-name-dialog').showModal();
  $('theme-name').focus();
}

$('theme-name-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const title = $('theme-name').value.trim();
  if (!renamingThemeItem || !title || title.length > 60) {
    $('theme-name-error').textContent = 'Enter a name between 1 and 60 characters.';
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
$('theme-name-delete').addEventListener('click', () => {
  if (!renamingThemeItem) return;
  const group = groups.find(item => item === renamingThemeItem || item.children.includes(renamingThemeItem));
  if (!group) return;
  if (removeGroup(group, group === renamingThemeItem ? null : renamingThemeItem)) {
    $('theme-name-dialog').close();
    renamingThemeItem = null;
  }
});

function removeGroup(group, child = null) {
  const label = child?.title || group.title;
  if (!confirm(`Delete “${label}”? Its assignments will be cleared from records.`)) return false;
  const removedIds = child ? [child.id] : [group.id, ...group.children.map((item) => item.id)];
  clearTargets(removedIds, tasks, sessions);
  if (child) group.children = group.children.filter((item) => item.id !== child.id);
  else groups = groups.filter((item) => item.id !== group.id);
  persist();
  renderGrowth();
  renderTasks();
  renderTaskChoice();
  return true;
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
  if (kind === 'year') return String(start.getFullYear());
  if (kind === 'month') return start.toLocaleDateString('en-US', { year: 'numeric', month: 'long' });
  if (kind === 'week') return `${start.toLocaleDateString('ja-JP')} – ${end.toLocaleDateString('ja-JP')}`;
  return `${start.toLocaleDateString('ja-JP')} (${start.toLocaleDateString('en-US', { weekday: 'short' })})`;
}

function movePeriod(direction) {
  if (periodKind === 'all') return;
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
  const all = periodKind === 'all';
  const bounds = all ? null : periodBounds(periodKind, periodAnchor, dayStartMinutes);
  const periodSessions = all ? sessions : sessions.map((session) => ({ ...session,
    workMs: workInRange(session, bounds.start, bounds.end) })).filter((session) => session.workMs > 0);
  const periodMs = periodSessions.reduce((sum, session) => sum + session.workMs, 0);
  $('period-label').textContent = all ? 'All time' : periodLabel(bounds);
  $('period-prev').hidden = $('period-next').hidden = all;
  $('period-prev').disabled = $('period-next').disabled = all;
  for (const kind of ['day', 'week', 'month', 'year', 'all']) {
    $('period-' + kind).setAttribute('aria-pressed', String(kind === periodKind));
  }
  $('growth-total').textContent = durationText(periodMs);
  $('growth-all-total').textContent = `All time ${durationText(run?.totalWorkMs ?? totalWorkMs)}`;
  const chart = $('period-chart');
  chart.replaceChildren();
  chart.setAttribute('data-period', periodKind);
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
    const bucketLabel = all ? String(date.getFullYear()) : periodKind === 'day' ? `${hour} – ${new Date(bucket.end).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit', hour12: false })}`
      : periodKind === 'year' ? date.toLocaleDateString('en-US', { month: 'short' })
      : `${date.getMonth() + 1}/${date.getDate()}`;
    label.textContent = all ? bucketLabel : periodKind === 'day' ? (index % 3 === 0 ? (date.getMinutes() ? hour : String(date.getHours())) : '\u00a0')
      : periodKind === 'year' ? bucketLabel
      : periodKind === 'week' ? bucketLabel : (date.getDate() === 1 || date.getDate() % 5 === 0 ? String(date.getDate()) : '\u00a0');
    item.setAttribute('aria-label', `${bucketLabel} ${durationText(bucket.workMs)}`);
    item.title = `${bucketLabel} ${durationText(bucket.workMs)}`;
    if (periodKind !== 'day') item.addEventListener('click', () => {
      periodAnchor = bucket.start;
      periodKind = all ? 'year' : periodKind === 'year' ? 'month' : 'day';
      renderGrowth();
    });
    track.append(fill);
    item.append(track, label);
    chart.append(item);
  }
  const untimedMs = periodSessions.filter((session) => session.startedAt == null)
    .reduce((sum, session) => sum + session.workMs, 0);
  $('day-untimed').hidden = periodKind !== 'day' || untimedMs === 0;
  $('day-untimed').textContent = `No start time ${durationText(untimedMs)}`;
  $('day-records').hidden = periodKind !== 'day';
  if (periodKind === 'day') renderDayRecords(bounds);
  renderThemes();
}

function renderSubthemeChart(group, original) {
  const section = document.createElement('section');
  section.className = 'subtheme-section';
  const heading = document.createElement('h3');
  heading.textContent = 'Subtheme';
  section.append(heading);
  const referenceMs = Math.max(0, ...group.children.map((child) => child.totalMs));
  const scale = themeScale(referenceMs);
  if (referenceMs > 0) {
    const reference = document.createElement('p');
    reference.className = 'subtheme-reference-label subtle';
    reference.textContent = `Reference ${durationText(referenceMs)}`;
    section.append(reference);
  }
  const table = document.createElement('table');
  table.className = 'subtheme-table';
  table.setAttribute('aria-label', `Work duration by subtheme for ${group.title}`);
  const head = document.createElement('thead');
  const headRow = document.createElement('tr');
  const nameHead = document.createElement('th');
  nameHead.setAttribute('scope', 'col');
  nameHead.setAttribute('aria-label', 'Subtheme');
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
  valueHead.setAttribute('aria-label', 'Work duration');
  headRow.append(nameHead, scaleHead, valueHead);
  head.append(headRow);
  const body = document.createElement('tbody');
  for (const child of group.children) {
    const row = document.createElement('tr');
    const name = document.createElement('th');
    name.setAttribute('scope', 'row');
    name.textContent = child.title;
    name.className = 'subtheme-name';
    const originalChild = original.children.find(item => item.id === child.id);
    name.append(editIconButton(`Rename ${child.title}`, () => renameItem(originalChild, 'Subtheme')));
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

function themeSelection() {
  const bounds = themePeriodKind === 'all' ? null : periodBounds(themePeriodKind, themePeriodAnchor, dayStartMinutes);
  const selected = bounds ? sessions.map((session) => ({ ...session,
    workMs: workInRange(session, bounds.start, bounds.end) })).filter((session) => session.workMs > 0) : sessions;
  return { summary: summarize(groups, selected), bounds };
}

function themeCardId(id) {
  return id === UNASSIGNED_THEME ? 'theme-unassigned-card' : `theme-card-${id}`;
}

function themeCard(id, title, ms, scale) {
  const card = document.createElement('button');
  card.type = 'button';
  card.id = themeCardId(id);
  card.className = 'theme-card';
  card.setAttribute('data-theme-id', id === UNASSIGNED_THEME ? '' : id);
  card.setAttribute('aria-haspopup', 'dialog');
  card.setAttribute('aria-label', `Open ${title}: ${durationText(ms)}`);
  const name = document.createElement('span');
  name.className = 'theme-card-title';
  name.textContent = title;
  const chevron = document.createElement('span');
  chevron.className = 'theme-chevron';
  chevron.textContent = '›';
  chevron.setAttribute('aria-hidden', 'true');
  name.append(chevron);
  const chart = themeBar('', ms, scale);
  chart.className += ' theme-card-chart';
  // カードの見出しと重複する空の名前は表示しない。
  chart.children[0].children[0].hidden = true;
  card.append(name, chart);
  card.addEventListener('click', () => {
    activeThemeId = id;
    renderThemeDetails();
    $('theme-details-dialog').showModal();
  });
  return card;
}

function renderThemes() {
  const all = themePeriodKind === 'all';
  const { summary, bounds } = themeSelection();
  $('theme-period-label').textContent = all ? 'All time' : periodLabel(bounds, themePeriodKind);
  for (const kind of ['day', 'week', 'month', 'year', 'all']) {
    $('theme-period-' + kind).setAttribute('aria-pressed', String(kind === themePeriodKind));
  }
  $('theme-period-prev').disabled = $('theme-period-next').disabled = all;
  $('theme-period-prev').hidden = $('theme-period-next').hidden = all;
  const unsetMs = summary.unclassified.reduce((sum, item) => sum + item.workMs, 0);
  const scale = themeScale(Math.max(unsetMs, ...summary.groups.map((group) => group.totalMs), 0));
  $('theme-scale').hidden = !groups.length && unsetMs === 0;
  $('theme-scale-max').textContent = durationText(scale);
  const groupList = $('group-list');
  groupList.replaceChildren();
  for (const group of summary.groups) groupList.append(themeCard(group.id, group.title, group.totalMs, scale));
  $('theme-unset').replaceChildren(themeCard(UNASSIGNED_THEME, 'Unassigned', unsetMs, scale));
  if (activeThemeId != null) renderThemeDetails();
}

function renderThemeDetails() {
  const { summary } = themeSelection();
  const content = $('theme-details-content');
  content.replaceChildren();
  $('theme-details-period').textContent = $('theme-period-label').textContent;
  if (activeThemeId === UNASSIGNED_THEME) {
    $('theme-details-title').textContent = 'Unassigned';
    $('theme-details-dialog').setAttribute('aria-label', 'Unassigned');
    const total = summary.unclassified.reduce((sum, record) => sum + record.workMs, 0);
    content.append(growthLine('Logged', total));
    const byTask = new Map();
    for (const record of summary.unclassified) {
      const title = record.taskTitle || 'No task selected';
      byTask.set(title, (byTask.get(title) || 0) + record.workMs);
    }
    for (const [title, ms] of byTask) content.append(growthLine(title, ms, 'p'));
    return;
  }
  const original = groups.find(group => group.id === activeThemeId);
  const group = summary.groups.find(group => group.id === activeThemeId);
  if (!group || !original) { $('theme-details-dialog').close(); activeThemeId = null; return; }
  $('theme-details-title').textContent = group.title;
  $('theme-details-dialog').setAttribute('aria-label', group.title);
  $('theme-details-title').append(editIconButton(`Rename ${group.title}`, () => renameItem(original, 'Theme')));
  const total = growthLine('Logged', group.totalMs);
  total.className += ' theme-dialog-total';
  content.append(total);
  if (group.children.length) content.append(renderSubthemeChart(group, original));
  const direct = document.createElement('p');
  direct.className = 'subtle';
  direct.textContent = `No subtheme ${durationText(group.directMs)}`;
  content.append(direct);
  const form = document.createElement('form');
  form.className = 'inline-form';
  const input = document.createElement('input');
  input.type = 'text'; input.maxLength = 60; input.required = true;
  input.placeholder = 'Add subtheme';
  input.setAttribute('aria-label', `Subtheme name for ${group.title}`);
  const add = document.createElement('button');
  add.type = 'submit'; add.textContent = '+ Subtheme';
  form.append(input, add);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const title = input.value.trim();
    if (!title || title.length > 60) return;
    original.children.push({ id: newId(), title });
    persist(); renderGrowth();
    $('theme-details-content').querySelector('input')?.focus();
  });
  content.append(form);
}

$('theme-details-close').addEventListener('click', () => $('theme-details-dialog').close());
$('theme-details-dialog').addEventListener('close', () => {
  const previous = activeThemeId;
  activeThemeId = null;
  document.getElementById(themeCardId(previous))?.focus();
});

function renderDayRecords(bounds) {
  const list = $('record-list');
  list.replaceChildren();
  const records = sessions.filter((session) => workInRange(session, bounds.start, bounds.end) > 0)
    .sort((a, b) => (a.startedAt ?? a.endedAt) - (b.startedAt ?? b.endedAt));
  $('day-record-count').textContent = `(${records.length})`;
  for (const session of records) {
    const row = document.createElement('article');
    row.className = 'record-row';
    const workMs = workInRange(session, bounds.start, bounds.end);
    const heading = growthLine(session.taskTitle || 'No task selected', workMs);
    heading.className += ' record-main';
    heading.children[0].title = session.taskTitle || 'No task selected';
    if (workMs < session.workMs) {
      const marker = document.createElement('small');
      marker.className = 'record-day-marker';
      marker.textContent = 'This day';
      heading.lastElementChild.append(marker);
    }
    const detail = document.createElement('p');
    detail.className = 'record-meta subtle';
    const range = document.createElement('span');
    range.className = 'record-range';
    range.textContent = `${session.startedAt == null ? 'No start time' : recordTimeLabel(session.startedAt, bounds)} – ${recordTimeLabel(session.endedAt, bounds)}`;
    detail.append(range);
    const edit = editIconButton(`Edit or delete record: ${session.taskTitle || 'No task selected'}`, () => openRecordEditor(session));
    edit.className = 'record-edit';
    row.append(heading, detail, edit);
    list.append(row);
  }
  if (!records.length) {
    const empty = document.createElement('p');
    empty.textContent = 'No records for this day.';
    list.append(empty);
  }
}

function renderRecordChildren(selected = '') {
  const group = groups.find((item) => item.id === $('record-group').value);
  const select = $('record-child');
  select.replaceChildren();
  appendOption(select, '', group ? 'No subtheme' : 'Choose a theme');
  for (const child of group?.children || []) appendOption(select, child.id, child.title);
  select.value = group?.children.some((child) => child.id === selected) ? selected : '';
  select.disabled = !group || !group.children.length;
}

function setRecordTarget(targetId) {
  const { groupId, childId } = taskTargetParts(targetId);
  $('record-group').replaceChildren();
  appendOption($('record-group'), '', 'Unassigned');
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
  appendOption(taskSelect, '', 'No task selected');
  for (const task of tasks) appendOption(taskSelect, task.id, task.title);
  if (session.taskId && !tasks.some((task) => task.id === session.taskId)) {
    appendOption(taskSelect, session.taskId, `${session.taskTitle || 'Deleted task'} (deleted)`);
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
    $('record-error').textContent = 'Check the dates and work duration.';
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
  $('growth-status').textContent = 'Record updated.';
}

function deleteRecord(group) {
  const session = sessions.find((item) => item.id === editingRecordId);
  if (!session) return;
  const targets = group ? sessions.filter((item) => item.recordGroupId === session.recordGroupId) : [session];
  if (!confirm(`Delete ${targets.length} records?`)) return;
  const removed = new Set(targets.map((item) => item.id));
  sessions = sessions.filter((item) => !removed.has(item.id));
  recalculateTotal();
  persist();
  closeRecordEditor();
  renderGrowth();
  $('growth-status').textContent = `Deleted ${targets.length} records.`;
}

function validateDayStart(value) {
  if (value === undefined) return DEFAULT_DAY_START;
  if (!Number.isInteger(value) || value < 0 || value >= 24 * 60) {
    throw new Error('Invalid day boundary setting.');
  }
  return value;
}

function validateBackup(raw) {
  if (!raw || raw.format !== BACKUP_FORMAT || raw.version !== 1 ||
      !Array.isArray(raw.steps) || !Array.isArray(raw.tasks) ||
      !Array.isArray(raw.groups) || !Array.isArray(raw.sessions)) {
    throw new Error('This is not a supported Practice timer backup.');
  }
  const restoredSteps = raw.steps.length ? normalizeSteps(raw.steps, { requireBoth: false }) : [];
  const ids = new Set();
  const takeId = (value) => {
    if (typeof value !== 'string' || !value || ids.has(value)) throw new Error('Invalid or duplicate ID.');
    ids.add(value);
    return value;
  };
  const title = (value, max) => {
    if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error('Invalid name.');
    return value.trim();
  };
  const restoredGroups = raw.groups.map((group) => ({
    id: takeId(group.id), title: title(group.title, 60),
    children: (() => {
      if (!Array.isArray(group.children)) throw new Error('Invalid subtheme.');
      return group.children.map((child) => ({ id: takeId(child.id), title: title(child.title, 60) }));
    })(),
  }));
  const validTarget = (id) => id == null || Boolean(targetLabel(restoredGroups, id));
  const restoredTasks = raw.tasks.map((task) => {
    if (typeof task.firstStep !== 'string' || task.firstStep.length > 500 || !validTarget(task.targetId) ||
        (task.completedAt != null && (!Number.isFinite(task.completedAt) || task.completedAt < 0))) {
      throw new Error('Invalid task.');
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
      throw new Error('Invalid record.');
    }
    const id = takeId(session.id);
    return { id, recordGroupId: session.recordGroupId || id,
      startedAt: session.startedAt ?? null, endedAt: session.endedAt, workMs: session.workMs,
      taskId: session.taskId || null, taskTitle: session.taskTitle || null,
      targetId: session.targetId || null };
  });
  const restoredRun = raw.run == null ? null : restoreRun(raw.run);
  if (raw.run != null && !restoredRun) throw new Error('Invalid active session.');
  const restoredTotal = raw.totalWorkMs;
  const recorded = restoredSessions.reduce((sum, session) => sum + session.workMs, 0) + (restoredRun?.sessionWorkMs || 0);
  if (!Number.isFinite(restoredTotal) || restoredTotal < 0 || restoredTotal + 1 < recorded ||
      (restoredRun && Math.abs(restoredRun.totalWorkMs - restoredTotal) > 1)) {
    throw new Error('Invalid total duration.');
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
  return currentBackup();
}

function currentBackup() {
  return { format: BACKUP_FORMAT, version: 1, steps, tasks, groups, sessions,
    totalWorkMs: run?.totalWorkMs ?? totalWorkMs,
    run: run ? { ...run, status: 'paused', lastTick: null } : null,
    selectedTaskId, sound: soundSettings, dayStartMinutes };
}

function renderNotificationPermission() {
  if (desktop) {
    $('notification-state').textContent = 'macOS';
    $('notification-state').setAttribute('data-state', 'system');
    $('notification-state').setAttribute('aria-label', 'Notifications managed by macOS');
    $('permission').hidden = true;
    $('permission-status').textContent = 'Manage notifications in macOS System Settings.';
    return;
  }
  const permission = window.Notification?.permission || 'unsupported';
  const labels = { granted: 'On', default: 'Off', denied: 'Blocked', unsupported: 'Unavailable' };
  const state = $('notification-state');
  state.textContent = labels[permission] || 'Off';
  state.setAttribute('data-state', permission);
  state.setAttribute('aria-label', `Notifications: ${state.textContent} (browser permission)`);
  $('permission').hidden = permission !== 'default';
  $('permission-status').textContent = permission === 'denied' ? 'Allow notifications in your browser’s site settings.'
    : permission === 'unsupported' ? 'Notifications are not available in this browser.' : '';
}

addEventListener('focus', renderNotificationPermission);

function routineError() {
  if (!draft.length) return '';
  try { normalizeSteps(draft); return ''; }
  catch (error) { return error.message; }
}

function applyRoutine() {
  try {
    // A single work/break row can be saved while building a routine; starting still requires both.
    const next = draft.length ? normalizeSteps(draft, { requireBoth: false }) : [];
    steps = next;
    persist();
    renderTimer();
    if (run && !$('status').textContent) $('status').textContent = 'Changes apply to the next session.';
  } catch (error) {
    $('settings-error').textContent = error.message;
    return;
  }
  $('settings-error').textContent = routineError();
}

function showSettings() {
  $('settings-error').textContent = routineError();
  renderNotificationPermission();
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
    $('day-start-error').textContent = 'Choose a day boundary time.';
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
  $('day-start-error').textContent = persist() ? '' : 'Could not save the day boundary.';
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

async function playSound(event, isCurrent = () => true) {
  const volume = soundSettings.volume;
  const id = soundSettings.assignments[event];
  if (!volume || id === 'none') return 0;
  if (id.startsWith('mac:') && desktop) {
    await macSoundsReady;
    if (!isCurrent()) return 0;
    if (macSounds.some(sound => sound.id === id)) {
      await desktop.playSound(id, volume / SOUND_VOLUME_SCALE);
      return 0;
    }
  }
  if (audioContext?.state !== 'running' && !await prepareAudio()) throw new Error('Could not play sound.');
  if (!isCurrent()) return 0;
  return synthesize(audioContext, id.startsWith('mac:') ? `electronic-${event}` : id, volume);
}

function queueSound(event, isCurrent) {
  return playSound(event, isCurrent).catch(() => {
    $('sound-status').textContent = 'Could not play sound.';
    if (!$('status').textContent) $('status').textContent = run?.status === 'running'
      ? 'Sound is unavailable. The timer is still running.' : 'Sound is unavailable. Your timer data was saved.';
  });
}

function renderSoundSettings() {
  const percent = soundSettings.volume / SOUND_VOLUME_SCALE;
  $('sound-volume').value = String(percent);
  $('sound-volume').style.backgroundImage = `linear-gradient(to right, var(--color-primary) ${percent}%, var(--color-track) ${percent}%)`;
  $('sound-volume-value').textContent = soundSettings.volume === 0 ? '0% (muted)' : `${percent}%`;
  $('sound-volume').setAttribute('aria-valuetext', $('sound-volume-value').textContent);
  let unavailable = false;
  for (const event of SOUND_EVENTS) {
    const select = $(`sound-${event}`);
    select.replaceChildren();
    const builtIn = document.createElement('optgroup');
    builtIn.label = 'App sounds';
    for (const [id, label] of Object.entries(BUILT_INS)) appendOption(builtIn, id, label);
    select.append(builtIn);
    if (macSounds.length) {
      const native = document.createElement('optgroup');
      native.label = 'Mac sounds';
      for (const { id, label } of macSounds) appendOption(native, id, label);
      select.append(native);
    }
    const id = soundSettings.assignments[event];
    if (id.startsWith('mac:') && !macSounds.some(sound => sound.id === id)) {
      appendOption(select, id, `Mac: ${id.slice(4).replace(/\.[^.]+$/, '')} (unavailable)`);
      unavailable = true;
    }
    select.value = id;
    $(`preview-${event}`).disabled = previewPlaying || soundSettings.volume === 0 || id === 'none';
  }
  $('sound-availability').textContent = unavailable ? 'A selected Mac sound is unavailable here. An electronic sound will play instead.'
    : macSoundsFailed ? 'Could not load Mac sounds. App sounds are available.' : '';
}

function updateSoundSettings(save = false) {
  soundSettings = validateSound({ ...soundSettings, volume: Math.round(Number($('sound-volume').value) * SOUND_VOLUME_SCALE) });
  renderSoundSettings();
  if (save) $('sound-status').textContent = persist() ? '' : 'Could not save sound settings.';
}

async function previewSound(event) {
  if (previewPlaying || soundSettings.volume === 0 || soundSettings.assignments[event] === 'none') return;
  previewPlaying = true;
  $('sound-status').textContent = '';
  renderSoundSettings();
  try {
    const duration = await playSound(event);
    setTimeout(() => { previewPlaying = false; renderSoundSettings(); }, Math.ceil(duration * 1000) + 50);
  } catch {
    previewPlaying = false;
    renderSoundSettings();
    $('sound-status').textContent = 'Could not play sound.';
  }
}

function notifyPhase(phase) {
  if (desktop) { desktop.notify(phase, run.steps[run.row].minutes); return; }
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  try {
    new Notification(phase === 'work' ? 'Work started' : 'Break started', {
      body: `${run.steps[run.row].minutes} minutes.`,
      silent: true,
    });
  } catch {
    $('status').textContent = 'Could not show a notification.';
  }
}

function handleEvent(event) {
  if (!event) return;
  if (event.kind === 'interrupted') {
    $('status').textContent = 'Paused after a long interruption.';
  } else {
    notifyPhase(event.phase);
  }
  persist();
}

$('settings-toggle').addEventListener('click', showSettings);
$('sound-volume').addEventListener('input', () => updateSoundSettings());
$('sound-volume').addEventListener('change', () => updateSoundSettings(true));
for (const event of SOUND_EVENTS) {
  $(`preview-${event}`).addEventListener('click', () => previewSound(event));
  $(`sound-${event}`).addEventListener('change', () => {
    soundSettings = validateSound({ ...soundSettings,
      assignments: { ...soundSettings.assignments, [event]: $(`sound-${event}`).value } });
    $('sound-status').textContent = persist() ? '' : 'Could not save sound settings.';
    renderSoundSettings();
  });
}
for (const view of ['timer', 'tasks', 'growth', 'themes']) {
  $(`nav-${view}`).addEventListener('click', () => switchView(view));
}
$('active-task-name').addEventListener('click', () => {
  const task = tasks.find((item) => item.id === selectedTaskId);
  if (task) openTaskEditor(task);
});
$('timer-quick-task-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const input = $('timer-quick-task-title');
  const title = input.value.trim();
  if (!title) return;
  addQuickTask(title, true);
  input.value = '';
});
$('task-undo').addEventListener('click', () => {
  const task = tasks.find((item) => item.id === taskUndo?.taskId);
  if (!task || task.completedAt !== taskUndo.completedAt) return;
  task.completedAt = null;
  if (!run && !selectedTaskId && taskUndo.selectedBefore === task.id) selectedTaskId = task.id;
  clearTaskUndo();
  persist();
  keepTaskScroll(() => {
    renderTasks();
    renderTaskChoice();
    document.getElementById(`task-title-${task.id}`)?.focus({ preventScroll: true });
  });
  $('task-status').textContent = 'Task marked as unfinished.';
});
$('task-group').addEventListener('change', () => renderTaskChildren());
$('quick-task-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const input = $('quick-task-title');
  const title = input.value.trim();
  if (!title) { openTaskEditor(null, 'quick-task-title'); return; }
  addQuickTask(title);
  input.value = '';
});
$('task-form').addEventListener('submit', (event) => {
  event.preventDefault();
  saveTask();
});
$('task-cancel').addEventListener('click', resetTaskForm);
$('task-delete').addEventListener('click', () => {
  const task = tasks.find(item => item.id === editingTaskId);
  if (!task || (run && selectedTaskId === task.id)) return;
  if (!confirm(`Delete “${task.title}”? Existing time records will be kept.`)) return;
  tasks = tasks.filter(item => item.id !== task.id);
  if (selectedTaskId === task.id) selectedTaskId = null;
  if (taskUndo?.taskId === task.id) clearTaskUndo();
  persist();
  resetTaskForm();
  renderTasks();
  renderTaskChoice();
  $('task-status').textContent = 'Task deleted.';
  if (!$('tasks-view').hidden) $('quick-task-title').focus();
  else $('main-action').focus();
});

$('group-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const title = $('group-title').value.trim();
  if (!title) return;
  groups.push({ id: newId(), title, children: [] });
  $('group-form').reset();
  persist();
  renderGrowth();
  $('growth-status').textContent = 'Theme added.';
});
for (const kind of ['day', 'week', 'month', 'year', 'all']) {
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
  const type = draft.at(-1)?.type === 'work' ? 'rest' : 'work';
  const minutes = steps.findLast(step => step.type === type)?.minutes ?? (type === 'work' ? 25 : 5);
  draft.push({ type, minutes });
  applyRoutine();
  renderSettings();
  $('step-list').lastElementChild?.querySelector('select')?.focus();
});
function toggleTimer() {
  if (desktop && !localDataReadable) { showSettings(); return; }
  if (!run && !steps.length) { showSettings(); return; }
  let soundEvent;
  let isCurrent;
  if (!run) {
    try { normalizeSteps(steps); }
    catch { showSettings(); return; }
    run = createRun(steps, totalWorkMs, Date.now());
    run.recordGroupId = newId();
    const startedRun = run;
    $('status').textContent = '';
    soundEvent = 'start';
    isCurrent = () => run === startedRun && run.status === 'running' && run.row === 0 && !run.looping;
  } else if (run.status === 'running') {
    handleEvent(pauseRun(run, Date.now()));
    soundEvent = 'pause';
  } else {
    resumeRun(run, Date.now());
    soundEvent = 'resume';
  }
  const saved = persist();
  renderTimer();
  renderTaskChoice();
  if (saved && soundEvent) return queueSound(soundEvent, isCurrent);
}
$('main-action').addEventListener('click', toggleTimer);

function skipTimer() {
  if (!run) return;
  const event = skipPhase(run, Date.now());
  handleEvent(event);
  const saved = persist();
  renderTimer();
  if (saved && event?.kind === 'phase') return queueSound('skip');
}
$('skip').addEventListener('click', skipTimer);

function endTimer() {
  if (!run) return;
  advanceClock(run, Date.now());
  totalWorkMs = run.totalWorkMs;
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
  $('status').textContent = '';
  const saved = persist();
  renderTimer();
  renderTaskChoice();
  $('main-action').focus();
  if (saved) return queueSound('end');
}
$('end').addEventListener('click', endTimer);

$('permission').addEventListener('click', async () => {
  if (!window.Notification || window.Notification.permission !== 'default') { renderNotificationPermission(); return; }
  try {
    await window.Notification.requestPermission();
    renderNotificationPermission();
  } catch {
    $('permission-status').textContent = 'Could not check notification permission.';
  }
});

async function downloadBackup() {
  if (desktop) {
    try {
      const saved = await desktop.exportJSON(JSON.stringify(backupObject(), null, 2));
      $('backup-status').textContent = saved ? 'JSON saved.' : 'Export cancelled.';
    } catch (error) { $('backup-status').textContent = `Could not export JSON: ${error.message}`; }
    return;
  }
  const blob = new Blob([JSON.stringify(backupObject(), null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'practice-timer.json';
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  $('backup-status').textContent = 'JSON downloaded.';
}

$('import-file').addEventListener('change', async () => {
  const input = $('import-file');
  const file = input.files?.[0];
  if (!file) return;
  try {
    if (run) throw new Error('End the current session before importing.');
    if (file.size > 5_000_000) throw new Error('JSON files must be 5 MB or smaller.');
    const next = validateBackup(JSON.parse(await file.text()));
    if (!confirm('Replace all current data with this JSON backup?')) return;
    ({ steps, tasks, groups, sessions, run, totalWorkMs, selectedTaskId, sound: soundSettings, dayStartMinutes } = next);
    localDataReadable = true;
    draft = steps.map(step => ({ ...step }));
    renderSettings();
    $('settings-error').textContent = routineError();
    clearTaskUndo();
    activeThemeId = null;
    $('theme-details-dialog').close();
    $('status').textContent = '';
    persist();
    resetTaskForm();
    renderTimer();
    renderTaskChoice();
    renderSoundSettings();
    renderDayStart();
    $('backup-status').textContent = 'JSON imported.';
    if (!steps.length) showSettings();
  } catch (error) {
    $('backup-status').textContent = `Import cancelled: ${error.message}`;
  } finally {
    input.value = '';
  }
});

addEventListener('beforeunload', () => {
  if (run?.status === 'running') advanceClock(run, Date.now());
  persist();
});

load();
if (desktop) {
  document.title = 'Practice Timer';
  macSoundsReady = desktop.sounds().then(value => { macSounds = value; })
    .catch(() => { macSoundsFailed = true; })
    .finally(() => renderSoundSettings());
  $('desktop-settings').hidden = false;
  let desktopSettings;
  const shortcutInputs = { toggle: $('desktop-shortcut-toggle'), skip: $('desktop-shortcut-skip'), end: $('desktop-shortcut-end') };
  const labels = { Space: 'Space', Enter: 'Return', Period: '.', Comma: ',', Right: '→', Left: '←', Up: '↑', Down: '↓' };
  function showDesktopSettings(value) {
    desktopSettings = value;
    for (const [key, input] of Object.entries(shortcutInputs)) {
      input.value = value.shortcuts[key].split('+').map(part => ({ Command: '⌘', Control: '⌃', Alt: '⌥', Shift: '⇧' }[part] || labels[part] || part)).join(' ');
    }
    $('desktop-shortcut-status').textContent = Object.values(value.registration).some(registered => !registered)
      ? 'A shortcut is unavailable. Choose a different combination.' : '';
  }
  async function updateShortcuts(next) {
    try {
      const result = await desktop.setShortcuts(next);
      showDesktopSettings(result);
      $('desktop-shortcut-status').textContent = result.ok ? 'Shortcuts saved.' : result.error;
    } catch { $('desktop-shortcut-status').textContent = 'Could not save shortcuts.'; }
  }
  desktop.settings().then(showDesktopSettings).catch(() => { $('desktop-shortcut-status').textContent = 'Could not read shortcuts.'; });
  for (const [key, input] of Object.entries(shortcutInputs)) input.addEventListener('keydown', event => {
    if (event.key === 'Tab') return;
    event.preventDefault();
    if (!desktopSettings || event.repeat || event.isComposing || ['Meta', 'Control', 'Alt', 'Shift'].includes(event.key)) return;
    const modifiers = [event.metaKey && 'Command', event.ctrlKey && 'Control', event.altKey && 'Alt', event.shiftKey && 'Shift'].filter(Boolean);
    const code = event.code || '';
    const keyName = /^(Key[A-Z]|Digit[0-9])$/.test(code) ? code.replace(/^(Key|Digit)/, '')
      : /^Arrow(Right|Left|Up|Down)$/.test(code) ? code.slice(5)
      : ['Space', 'Enter', 'Period', 'Comma'].includes(code) || /^F([1-9]|1[0-2])$/.test(code) ? code : null;
    if (!modifiers.some(part => part !== 'Shift') || !keyName) {
      $('desktop-shortcut-status').textContent = 'Use Command, Control or Option together with a letter, number, Space, Return, arrow or function key.';
      return;
    }
    void updateShortcuts({ ...desktopSettings.shortcuts, [key]: [...modifiers, keyName].join('+') });
  });
  for (const input of Object.values(shortcutInputs)) {
    input.addEventListener('focus', () => desktop.recordShortcut(true));
    input.addEventListener('blur', () => desktop.recordShortcut(false));
  }
  $('desktop-shortcut-reset').addEventListener('click', () => { if (desktopSettings) void updateShortcuts(desktopSettings.defaults); });
  desktop.onCommand(command => {
    if (command.type === 'toggle') void toggleTimer();
    else if (command.type === 'end') void endTimer();
    else if (command.type === 'skip') void skipTimer();
    else if (command.type === 'settings') showSettings();
    else if (command.type === 'export') void downloadBackup();
    else if (command.type === 'suspend') {
      if (run?.status === 'running') {
        handleEvent(pauseRun(run, Math.max(run.lastTick, Math.min(Date.now(), command.at))));
        persist(); renderTimer();
      }
    } else if (command.type === 'quit') {
      if (run?.status === 'running') handleEvent(pauseRun(run, Date.now()));
      const saved = !localDataReadable || persist(); renderTimer(); desktop.finishQuit(saved);
    }
  });
}
draft = steps.map(step => ({ ...step }));
// 折り返し・文字サイズ・端末の安全領域に合わせ、末尾のタスクと取り消し通知の重なりを防ぐ。
if (window.ResizeObserver) {
  const heightProperties = {
    'quick-task-form': '--task-entry-height',
    'theme-add': '--theme-entry-height',
    'primary-nav': '--primary-nav-height',
  };
  const measuredHeights = new Map();
  const fixedControls = new window.ResizeObserver(entries => {
    // Use the observer's completed measurements, and finish all fallback reads before writes.
    const updates = entries.map(entry => ({
      property: heightProperties[entry.target.id],
      height: entry.borderBoxSize?.[0]?.blockSize ?? entry.borderBoxSize?.blockSize ?? entry.target.getBoundingClientRect().height,
    }));
    for (const { property, height } of updates) {
      if (height > 0 && height !== measuredHeights.get(property)) {
        measuredHeights.set(property, height);
        document.documentElement.style.setProperty(property, `${height}px`);
      }
    }
  });
  fixedControls.observe($('quick-task-form'), { box: 'border-box' });
  fixedControls.observe($('theme-add'), { box: 'border-box' });
  fixedControls.observe($('primary-nav'), { box: 'border-box' });
}
backupFiles = globalThis.PracticeBackupFiles.mount({
  snapshot: backupObject,
  download: downloadBackup,
  content: () => JSON.stringify(currentBackup()),
  canWrite: () => localDataReadable,
});
switchView('timer');
setInterval(() => {
  if (!run || run.status !== 'running') return;
  handleEvent(advanceClock(run, Date.now()));
  if (Date.now() - lastSaved >= 1000) persist();
  publishDesktop();
  if (!$('timer-view').hidden) renderTimer();
}, 250);
})();
