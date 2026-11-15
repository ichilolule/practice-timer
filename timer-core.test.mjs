import assert from 'node:assert/strict';
import test from 'node:test';
import core from './timer-core.js';

const { advanceClock, createRun, normalizeSteps, pauseRun, resumeRun, restoreRun, skipPhase } = core;

const sequence = [
  { type: 'work', minutes: 0.1 },
  { type: 'rest', minutes: 0.1 },
  { type: 'work', minutes: 0.2 },
  { type: 'rest', minutes: 0.1 },
  { type: 'work', minutes: 0.2 },
];

test('空設定、未入力、作業か休憩の欠落は開始できない', () => {
  assert.throws(() => normalizeSteps([]));
  assert.throws(() => normalizeSteps([{ type: '', minutes: '' }]));
  assert.throws(() => normalizeSteps([{ type: 'work', minutes: 5 }]));
});

test('Routineの編集中は片方の種類だけでも保存できるが、開始・実行状態の復元には両方必要', () => {
  const rows = [{ type: 'work', minutes: 25 }];
  assert.deepEqual(normalizeSteps(rows, { requireBoth: false }), rows);
  assert.throws(() => normalizeSteps([{ type: 'work', minutes: '' }], { requireBoth: false }));
  assert.throws(() => createRun(rows, 0, 0));
  assert.equal(restoreRun({ steps: rows }), null);
});

test('設定した順番で進み、最後の作業時間と休憩時間を交互に繰り返す', () => {
  const run = createRun(sequence, 0, 0);
  assert.deepEqual(advanceClock(run, 6000), { kind: 'phase', phase: 'rest' });
  assert.equal(run.totalWorkMs, 6000);
  assert.deepEqual(advanceClock(run, 12000), { kind: 'phase', phase: 'work' });
  assert.equal(run.row, 2);
  assert.deepEqual(advanceClock(run, 24000), { kind: 'phase', phase: 'rest' });
  assert.deepEqual(advanceClock(run, 30000), { kind: 'phase', phase: 'work' });
  assert.equal(run.row, 4);
  assert.deepEqual(advanceClock(run, 42000), { kind: 'phase', phase: 'rest' });
  assert.equal(run.row, 3);
  assert.equal(run.looping, true);
  assert.equal(run.totalWorkMs, 30000);
  assert.deepEqual(advanceClock(run, 48000), { kind: 'phase', phase: 'work' });
  assert.equal(run.row, 4);
  assert.equal(run.remainingMs, 12000);
});

test('一時停止、再開、途中スキップは計測した作業分だけ加算', () => {
  const run = createRun(sequence, 0, 0);
  pauseRun(run, 5000);
  assert.equal(run.totalWorkMs, 5000);
  assert.equal(run.remainingMs, 1000);
  assert.equal(advanceClock(run, 500000), null);
  resumeRun(run, 500000);
  assert.deepEqual(skipPhase(run, 500500), { kind: 'phase', phase: 'rest' });
  assert.equal(run.totalWorkMs, 5500);
  assert.deepEqual(run.workIntervals, [
    { startedAt: 0, endedAt: 5000 },
    { startedAt: 500000, endedAt: 500500 },
  ]);
});

test('一時停止中の次へは次の工程を開始する', () => {
  const run = createRun(sequence, 0, 0);
  pauseRun(run, 5000);
  assert.deepEqual(skipPhase(run, 10000), { kind: 'phase', phase: 'rest' });
  assert.equal(run.status, 'running');
  assert.equal(run.lastTick, 10000);
  assert.equal(run.totalWorkMs, 5000);
});

test('長い中断後は次の工程で一時停止し、未実行の工程を進めない', () => {
  const run = createRun(sequence, 0, 0);
  assert.deepEqual(advanceClock(run, 180000), { kind: 'interrupted', phase: 'rest' });
  assert.equal(run.status, 'paused');
  assert.equal(run.totalWorkMs, 6000);
  assert.equal(run.remainingMs, 6000);
});

test('再読み込み時は保存された残り時間から一時停止で復元', () => {
  const run = createRun(sequence, 0, 0);
  advanceClock(run, 2000);
  const restored = restoreRun(JSON.parse(JSON.stringify(run)));
  assert.equal(restored.status, 'paused');
  assert.equal(restored.remainingMs, 4000);
  assert.equal(restored.totalWorkMs, 2000);
  assert.equal(restored.lastTick, null);
  assert.deepEqual(restored.workIntervals, [{ startedAt: 0, endedAt: 2000 }]);
});

test('移行先の自動開始がオフなら現在の工程で超過を計測し、作業だけ加算する', () => {
  const run = createRun(sequence, 0, 0, { work: false, rest: false });
  assert.deepEqual(advanceClock(run, 6250), { kind: 'overtime', phase: 'work', nextPhase: 'rest' });
  assert.equal(run.row, 0);
  assert.equal(run.remainingMs, -250);
  assert.equal(run.totalWorkMs, 6250);
  assert.equal(advanceClock(run, 10_000), null);
  assert.equal(run.remainingMs, -4000);
  assert.equal(run.totalWorkMs, 10_000);
  assert.deepEqual(skipPhase(run, 11_000), { kind: 'phase', phase: 'rest' });
  assert.equal(run.totalWorkMs, 11_000);
  assert.equal(run.overtime, false);
  assert.deepEqual(advanceClock(run, 17_000), { kind: 'overtime', phase: 'rest', nextPhase: 'work' });
  advanceClock(run, 20_000);
  assert.equal(run.remainingMs, -3000);
  assert.equal(run.totalWorkMs, 11_000);
  assert.deepEqual(skipPhase(run, 21_000), { kind: 'phase', phase: 'work' });
  assert.equal(run.row, 2);
  assert.deepEqual(run.workIntervals, [{ startedAt: 0, endedAt: 11_000 }]);
});

test('自動開始は移行先の種類ごとに適用し、手動移行は00:00同時でもすぐ次へ進む', () => {
  const run = createRun(sequence, 0, 0, { work: false, rest: true });
  assert.equal(advanceClock(run, 6000).phase, 'rest');
  assert.equal(run.overtime, false);
  assert.deepEqual(skipPhase(run, 12_000), { kind: 'phase', phase: 'work' });
  assert.equal(run.overtime, false);
  assert.equal(run.remainingMs, 12_000);
  const repeated = createRun([{ type: 'work', minutes: 0.1 }, { type: 'work', minutes: 0.2 }, { type: 'rest', minutes: 0.1 }], 0, 0, { work: false, rest: true });
  assert.deepEqual(advanceClock(repeated, 6000), { kind: 'overtime', phase: 'work', nextPhase: 'work' });
  assert.equal(skipPhase(repeated, 7000).phase, 'work');
  assert.equal(repeated.row, 1);
});

test('超過中の一時停止・再開・保存復元では超過時間と作業区間を保つ', () => {
  const run = createRun(sequence, 0, 0, { work: true, rest: false });
  advanceClock(run, 7000);
  pauseRun(run, 8000);
  assert.equal(run.remainingMs, -2000);
  assert.equal(advanceClock(run, 50_000), null);
  const restored = restoreRun(JSON.parse(JSON.stringify(run)));
  assert.equal(restored.overtime, true);
  assert.equal(restored.status, 'paused');
  assert.equal(restored.remainingMs, -2000);
  resumeRun(restored, 50_000);
  advanceClock(restored, 51_000);
  assert.equal(restored.totalWorkMs, 9000);
  assert.equal(restored.remainingMs, -3000);
  assert.deepEqual(restored.workIntervals, [{ startedAt: 0, endedAt: 8000 }, { startedAt: 50_000, endedAt: 51_000 }]);
  assert.equal(skipPhase(restored, 52_000).phase, 'rest');
  assert.equal(restored.totalWorkMs, 10_000);
});

test('長い中断は超過設定でも自動停止し、不在時間を加算しない', () => {
  const run = createRun(sequence, 0, 0, { work: false, rest: false });
  assert.deepEqual(advanceClock(run, 180_000), { kind: 'interrupted', phase: 'work' });
  assert.equal(run.totalWorkMs, 6000);
  assert.equal(run.remainingMs, 0);
  assert.equal(run.overtime, true);
  resumeRun(run, 180_000);
  advanceClock(run, 181_000);
  assert.equal(run.totalWorkMs, 7000);
  assert.deepEqual(advanceClock(run, 400_000), { kind: 'interrupted', phase: 'work' });
  assert.equal(run.totalWorkMs, 7000);
  assert.equal(run.remainingMs, -1000);
});

test('不正な自動開始・超過状態を拒否し、旧タイマーは自動開始オンで復元する', () => {
  const run = createRun(sequence, 0, 0);
  for (const autoStart of [null, {}, { work: 1, rest: true }]) {
    assert.throws(() => createRun(sequence, 0, 0, autoStart));
    assert.equal(restoreRun({ ...run, autoStart }), null);
  }
  for (const patch of [{ overtime: 'yes' }, { overtime: true, remainingMs: 1 }, { overtime: false, remainingMs: 0 }]) assert.equal(restoreRun({ ...run, ...patch }), null);
  delete run.autoStart; delete run.overtime;
  assert.deepEqual(restoreRun(run).autoStart, { work: true, rest: true });
});
