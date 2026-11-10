import assert from 'node:assert/strict';
import test from 'node:test';
import data from './practice-data.js';

test('内訳への20分は親に一度だけ集計する', () => {
  const groups = [{ id: 'body', title: '人体', children: [{ id: 'hand', title: '手' }] }];
  const sessions = [
    { id: 'a', workMs: 20 * 60000, targetId: 'hand' },
    { id: 'b', workMs: 10 * 60000, targetId: 'body' },
    { id: 'c', workMs: 5 * 60000, targetId: null },
  ];
  const summary = data.summarize(groups, sessions);
  assert.equal(summary.groups[0].totalMs, 30 * 60000);
  assert.equal(summary.groups[0].directMs, 10 * 60000);
  assert.equal(summary.groups[0].children[0].totalMs, 20 * 60000);
  assert.deepEqual(summary.unclassified.map((item) => item.id), ['c']);
});

test('加算先削除では記録を未分類へ戻す', () => {
  const groups = [{ id: 'body', title: '人体', children: [{ id: 'hand', title: '手' }] }];
  const task = { id: 'task', title: '手を描く', targetId: 'hand' };
  const session = { workMs: 60000, taskId: 'task', taskTitle: '手を描く', targetId: 'hand' };
  data.clearTargets(['hand'], [task], [session]);
  assert.equal(task.targetId, null);
  assert.equal(session.targetId, null);
  assert.equal(data.summarize(groups, [session]).unclassified.length, 1);
});

test('週は月曜始まり、月と年は暦どおりに集計する', () => {
  const monday = new Date(2026, 10, 9).getTime();
  const sunday = new Date(2026, 10, 15).getTime();
  const week = data.periodBounds('week', sunday);
  assert.equal(week.start, monday);
  assert.equal(week.end, new Date(2026, 10, 16).getTime());
  const month = data.periodBounds('month', sunday);
  assert.equal(month.start, new Date(2026, 10, 1).getTime());
  assert.equal(month.end, new Date(2026, 11, 1).getTime());
  assert.equal(data.periodBuckets('month', sunday, []).length, 30);
  assert.equal(data.periodBuckets('year', sunday, []).length, 12);
});

test('日付をまたぐ作業は各日に分け、旧記録は終了日に置く', () => {
  const beforeMidnight = new Date(2026, 10, 10, 23, 50).getTime();
  const afterMidnight = new Date(2026, 10, 11, 0, 10).getTime();
  const records = [
    { startedAt: beforeMidnight, endedAt: afterMidnight, workMs: 20 * 60000 },
    { startedAt: null, endedAt: afterMidnight, workMs: 5 * 60000 },
  ];
  const first = data.periodBounds('day', beforeMidnight);
  const second = data.periodBounds('day', afterMidnight);
  assert.equal(records.reduce((sum, record) => sum + data.workInRange(record, first.start, first.end), 0), 10 * 60000);
  assert.equal(records.reduce((sum, record) => sum + data.workInRange(record, second.start, second.end), 0), 15 * 60000);
});
