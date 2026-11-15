(() => {
'use strict';

const MAX_MINUTES = 240;
const LATE_LIMIT_MS = 90_000;

function normalizeSteps(rows, { requireBoth = true } = {}) {
  if (!Array.isArray(rows) || !rows.length) throw new Error('Add at least one timer step.');
  const steps = rows.map((row, index) => {
    const minutes = Number(row.minutes);
    if (!['work', 'rest'].includes(row.type) || !Number.isFinite(minutes) ||
        minutes < 0.1 || minutes > MAX_MINUTES ||
        Math.abs(minutes * 10 - Math.round(minutes * 10)) > 0.000001) {
      throw new Error(`Enter a type and duration (0.1–240 minutes) for step ${index + 1}.`);
    }
    return { type: row.type, minutes: Math.round(minutes * 10) / 10 };
  });
  if (requireBoth && (!steps.some((step) => step.type === 'work') || !steps.some((step) => step.type === 'rest'))) {
    throw new Error('Add at least one work step and one break step.');
  }
  return steps;
}

function normalizeAutoStart(raw = { work: true, rest: true }) {
  if (!raw || typeof raw.work !== 'boolean' || typeof raw.rest !== 'boolean') throw new Error('Invalid auto-start settings.');
  return { work: raw.work, rest: raw.rest };
}

function createRun(rows, totalWorkMs, now, autoStart) {
  const steps = normalizeSteps(rows);
  return {
    steps,
    row: 0,
    phase: steps[0].type,
    looping: false,
    remainingMs: steps[0].minutes * 60_000,
    overtime: false,
    autoStart: normalizeAutoStart(autoStart),
    lastTick: now,
    status: 'running',
    totalWorkMs,
    sessionWorkMs: 0,
    workIntervals: [],
    legacyWorkMs: 0,
    newWorkInterval: true,
  };
}

function nextPhaseType(run) {
  return !run.looping && run.row < run.steps.length - 1
    ? run.steps[run.row + 1].type : run.phase === 'work' ? 'rest' : 'work';
}

function nextPhase(run) {
  if (!run.looping && run.row < run.steps.length - 1) {
    run.row += 1;
  } else {
    const nextType = run.phase === 'work' ? 'rest' : 'work';
    run.row = run.steps.findLastIndex((step) => step.type === nextType);
    run.looping = true;
  }
  run.phase = run.steps[run.row].type;
  run.remainingMs = run.steps[run.row].minutes * 60_000;
  run.overtime = false;
}

function advanceClock(run, now) {
  if (!run || run.status !== 'running') return null;
  const elapsed = Math.max(0, now - run.lastTick);
  const nextType = nextPhaseType(run);
  const autoStart = run.autoStart?.[nextType] ?? true;
  const late = run.overtime ? elapsed : elapsed - run.remainingMs;
  const interrupted = late > LATE_LIMIT_MS;
  const applied = interrupted ? Math.max(0, run.remainingMs)
    : run.overtime || !autoStart ? elapsed : Math.min(elapsed, run.remainingMs);
  run.remainingMs -= applied;
  if (run.phase === 'work') {
    run.totalWorkMs += applied;
    run.sessionWorkMs += applied;
    if (applied > 0) {
      const last = run.workIntervals.at(-1);
      if (!run.newWorkInterval && last?.endedAt === run.lastTick) last.endedAt += applied;
      else run.workIntervals.push({ startedAt: run.lastTick, endedAt: run.lastTick + applied });
      run.newWorkInterval = false;
    }
  }
  run.lastTick = now;
  if (run.overtime && !interrupted) return null;
  if (run.remainingMs > 0) return null;
  if (autoStart && !run.overtime) nextPhase(run);
  else run.overtime = true;
  if (interrupted) {
    run.newWorkInterval = true;
    run.status = 'paused';
    run.lastTick = null;
    return { kind: 'interrupted', phase: run.phase };
  }
  if (run.overtime) return { kind: 'overtime', phase: run.phase, nextPhase: nextType };
  run.newWorkInterval = true;
  return { kind: 'phase', phase: run.phase };
}

function pauseRun(run, now) {
  const event = advanceClock(run, now);
  if (run.status === 'running') {
    run.status = 'paused';
    run.lastTick = null;
  }
  return event;
}

function resumeRun(run, now) {
  if (run.status !== 'paused') return;
  run.status = 'running';
  run.lastTick = now;
}

function skipPhase(run, now) {
  const event = advanceClock(run, now);
  if (event && event.kind !== 'overtime') return event;
  nextPhase(run);
  run.newWorkInterval = true;
  run.status = 'running';
  run.lastTick = now;
  return { kind: 'phase', phase: run.phase };
}

function restoreRun(raw) {
  if (!raw || !Array.isArray(raw.steps)) return null;
  try {
    const steps = normalizeSteps(raw.steps);
    const row = Number(raw.row);
    const phase = raw.phase;
    const remainingMs = Number(raw.remainingMs);
    const overtime = raw.overtime ?? false;
    if (typeof overtime !== 'boolean') return null;
    const autoStart = normalizeAutoStart(raw.autoStart);
    if (!Number.isInteger(row) || row < 0 || row >= steps.length ||
        steps[row].type !== phase || !Number.isFinite(remainingMs) ||
        (overtime ? remainingMs > 0 : remainingMs <= 0 || remainingMs > steps[row].minutes * 60_000) ||
        !Number.isFinite(raw.totalWorkMs) || raw.totalWorkMs < 0 ||
        !Number.isFinite(raw.sessionWorkMs) || raw.sessionWorkMs < 0) return null;
    const intervals = raw.workIntervals == null ? [] : raw.workIntervals;
    const legacyWorkMs = raw.workIntervals == null ? raw.sessionWorkMs : raw.legacyWorkMs || 0;
    if (!Array.isArray(intervals) || !Number.isFinite(legacyWorkMs) || legacyWorkMs < 0 ||
        intervals.some((item) => !Number.isFinite(item.startedAt) || !Number.isFinite(item.endedAt) ||
          item.endedAt <= item.startedAt) ||
        Math.abs(intervals.reduce((sum, item) => sum + item.endedAt - item.startedAt, legacyWorkMs)
          - raw.sessionWorkMs) > 1) return null;
    return { steps, row, phase, looping: Boolean(raw.looping), remainingMs, overtime, autoStart, lastTick: null,
      status: 'paused', totalWorkMs: raw.totalWorkMs, sessionWorkMs: raw.sessionWorkMs,
      workIntervals: intervals, legacyWorkMs, newWorkInterval: true,
      recordGroupId: raw.recordGroupId || null };
  } catch {
    return null;
  }
}

const TimerCore = { advanceClock, createRun, normalizeSteps, normalizeAutoStart, nextPhaseType, pauseRun, resumeRun, restoreRun, skipPhase };
globalThis.TimerCore = TimerCore;
if (typeof module !== 'undefined' && module.exports) module.exports = TimerCore;
})();
