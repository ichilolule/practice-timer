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

test('5時より前は前日として日・週・月・年の境界を揃える', () => {
  const boundary = 300;
  const early = +new Date(2027, 0, 1, 4, 59);
  for (const [kind, expectedStart, expectedEnd] of [
    ['day', new Date(2026, 11, 31, 5), new Date(2027, 0, 1, 5)],
    ['week', new Date(2026, 11, 28, 5), new Date(2027, 0, 4, 5)],
    ['month', new Date(2026, 11, 1, 5), new Date(2027, 0, 1, 5)],
    ['year', new Date(2026, 0, 1, 5), new Date(2027, 0, 1, 5)],
  ]) {
    assert.deepEqual(data.periodBounds(kind, early, boundary), { start: +expectedStart, end: +expectedEnd });
  }
  assert.equal(data.periodBounds('year', +new Date(2027, 0, 1, 5), boundary).start,
    +new Date(2027, 0, 1, 5));
  assert.equal(data.periodBounds('week', +new Date(2026, 10, 16, 4), boundary).start,
    +new Date(2026, 10, 9, 5));
});

test('24時間の棒は実際の区間で分割し、開始時刻のない記録を時間帯へ割り当てない', () => {
  const anchor = +new Date(2026, 10, 12, 12);
  const sessions = [
    { startedAt: +new Date(2026, 10, 12, 4, 50), endedAt: +new Date(2026, 10, 12, 5, 10), workMs: 1_200_000 },
    { startedAt: +new Date(2026, 10, 12, 5, 45), endedAt: +new Date(2026, 10, 12, 6, 15), workMs: 1_800_000 },
    { startedAt: +new Date(2026, 10, 13, 4, 50), endedAt: +new Date(2026, 10, 13, 5, 10), workMs: 1_200_000 },
    { startedAt: null, endedAt: +new Date(2026, 10, 12, 8), workMs: 900_000 },
  ];
  const buckets = data.periodBuckets('day', anchor, sessions, 300);
  assert.equal(buckets.length, 24);
  assert.equal(buckets[0].start, +new Date(2026, 10, 12, 5));
  assert.equal(buckets[23].end, +new Date(2026, 10, 13, 5));
  assert.equal(buckets[0].workMs, 25 * 60_000);
  assert.equal(buckets[1].workMs, 15 * 60_000);
  assert.equal(buckets[23].workMs, 10 * 60_000);
  assert.equal(buckets.reduce((sum, bucket) => sum + bucket.workMs, 0), 50 * 60_000);
  for (const kind of ['week', 'month', 'year']) {
    const bounds = data.periodBounds(kind, anchor, 300);
    assert.equal(data.periodBuckets(kind, anchor, sessions, 300).reduce((sum, bucket) => sum + bucket.workMs, 0),
      sessions.reduce((sum, record) => sum + data.workInRange(record, bounds.start, bounds.end), 0));
  }
  const late = data.periodBuckets('day', anchor, [], 23 * 60 + 30);
  assert.equal(late.length, 24);
  assert.equal(late[0].start, +new Date(2026, 10, 11, 23, 30));
  assert.equal(late[23].end, +new Date(2026, 10, 12, 23, 30));
});
