(() => {
'use strict';

const MAX_MINUTES = 240;
const LATE_LIMIT_MS = 90_000;

function normalizeSteps(rows) {
  if (!Array.isArray(rows) || !rows.length) throw new Error('手順を1件以上追加してください。');
  const steps = rows.map((row, index) => {
    const minutes = Number(row.minutes);
    if (!['work', 'rest'].includes(row.type) || !Number.isFinite(minutes) ||
        minutes < 0.1 || minutes > MAX_MINUTES ||
        Math.abs(minutes * 10 - Math.round(minutes * 10)) > 0.000001) {
      throw new Error(`${index + 1}行目の種類と時間（0.1〜240分）を入力してください。`);
    }
    return { type: row.type, minutes: Math.round(minutes * 10) / 10 };
  });
  if (!steps.some((step) => step.type === 'work') || !steps.some((step) => step.type === 'rest')) {
    throw new Error('作業と休憩をそれぞれ1件以上追加してください。');
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
  }
  run.lastTick = now;
  if (run.remainingMs > 0) return null;
  const late = elapsed - applied;
  nextPhase(run);
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
    return { steps, row, phase, looping: Boolean(raw.looping), remainingMs, lastTick: null,
      status: 'paused', totalWorkMs: raw.totalWorkMs,
      sessionWorkMs: raw.sessionWorkMs };
  } catch {
    return null;
  }
}

const TimerCore = { advanceClock, createRun, normalizeSteps, pauseRun, resumeRun, restoreRun, skipPhase };
globalThis.TimerCore = TimerCore;
if (typeof module !== 'undefined' && module.exports) module.exports = TimerCore;
})();
