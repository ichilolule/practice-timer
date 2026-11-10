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

test('未分類をタスクへ後から割り当て、加算先削除では時間を未分類へ戻す', () => {
  const groups = [{ id: 'body', title: '人体', children: [{ id: 'hand', title: '手' }] }];
  const task = { id: 'task', title: '手を描く', targetId: 'hand' };
  const session = { workMs: 60000, taskId: null, taskTitle: null, targetId: null, reviewTargetId: null };
  assert.equal(data.assignSession(session, task, groups), true);
  assert.equal(session.targetId, 'hand');
  data.clearTargets(['hand'], [task], [session]);
  assert.equal(task.targetId, null);
  assert.equal(session.targetId, null);
  assert.equal(data.summarize(groups, [session]).unclassified.length, 1);
});
