(() => {
'use strict';

const MAX_MINUTES = 240;
const LATE_LIMIT_MS = 90_000;

function normalizeSteps(rows) {
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
  if (!steps.some((step) => step.type === 'work') || !steps.some((step) => step.type === 'rest')) {
    throw new Error('Add at least one work step and one break step.');
  }
  return steps;
}

function createRun(rows, totalWorkMs, now) {
  const steps = normalizeSteps(rows);
  return {
    steps,
    row: 0,
    phase: steps[0].type,
    looping: false,
    remainingMs: steps[0].minutes * 60_000,
    lastTick: now,
    status: 'running',
    totalWorkMs,
    sessionWorkMs: 0,
    workIntervals: [],
    legacyWorkMs: 0,
    newWorkInterval: true,
  };
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
}

function advanceClock(run, now) {
  if (!run || run.status !== 'running') return null;
  const elapsed = Math.max(0, now - run.lastTick);
  const applied = Math.min(elapsed, run.remainingMs);
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
  if (run.remainingMs > 0) return null;
  const late = elapsed - applied;
  nextPhase(run);
  run.newWorkInterval = true;
  if (late > LATE_LIMIT_MS) {
    run.status = 'paused';
    run.lastTick = null;
    return { kind: 'interrupted', phase: run.phase };
  }
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
  if (event) return event;
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
    if (!Number.isInteger(row) || row < 0 || row >= steps.length ||
        steps[row].type !== phase || !Number.isFinite(remainingMs) ||
        remainingMs <= 0 || remainingMs > steps[row].minutes * 60_000 ||
        !Number.isFinite(raw.totalWorkMs) || raw.totalWorkMs < 0 ||
        !Number.isFinite(raw.sessionWorkMs) || raw.sessionWorkMs < 0) return null;
    const intervals = raw.workIntervals == null ? [] : raw.workIntervals;
    const legacyWorkMs = raw.workIntervals == null ? raw.sessionWorkMs : raw.legacyWorkMs || 0;
    if (!Array.isArray(intervals) || !Number.isFinite(legacyWorkMs) || legacyWorkMs < 0 ||
        intervals.some((item) => !Number.isFinite(item.startedAt) || !Number.isFinite(item.endedAt) ||
          item.endedAt <= item.startedAt) ||
        Math.abs(intervals.reduce((sum, item) => sum + item.endedAt - item.startedAt, legacyWorkMs)
          - raw.sessionWorkMs) > 1) return null;
    return { steps, row, phase, looping: Boolean(raw.looping), remainingMs, lastTick: null,
      status: 'paused', totalWorkMs: raw.totalWorkMs, sessionWorkMs: raw.sessionWorkMs,
      workIntervals: intervals, legacyWorkMs, newWorkInterval: true,
      recordGroupId: raw.recordGroupId || null };
  } catch {
    return null;
  }
}

const TimerCore = { advanceClock, createRun, normalizeSteps, pauseRun, resumeRun, restoreRun, skipPhase };
globalThis.TimerCore = TimerCore;
if (typeof module !== 'undefined' && module.exports) module.exports = TimerCore;
})();
