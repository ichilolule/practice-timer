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
