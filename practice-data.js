(() => {
'use strict';

function targetLabel(groups, id) {
  for (const group of groups) {
    if (group.id === id) return group.title;
    const child = group.children.find((item) => item.id === id);
    if (child) return `${group.title} → ${child.title}`;
  }
  return '';
}

function summarize(groups, sessions) {
  const result = groups.map((group) => ({
    ...group, directMs: 0, totalMs: 0,
    children: group.children.map((child) => ({ ...child, totalMs: 0 })),
  }));
  const unclassified = [];
  for (const session of sessions) {
    let matched = false;
    for (const group of result) {
      if (session.targetId === group.id) {
        group.directMs += session.workMs;
        group.totalMs += session.workMs;
        matched = true;
        break;
      }
      const child = group.children.find((item) => item.id === session.targetId);
      if (child) {
        child.totalMs += session.workMs;
        group.totalMs += session.workMs;
        matched = true;
        break;
      }
    }
    if (!matched) unclassified.push(session);
  }
  return { groups: result, unclassified };
}

function assignSession(session, task, groups) {
  if (!task || !targetLabel(groups, task.targetId)) return false;
  session.taskId = task.id;
  session.taskTitle = task.title;
  session.targetId = task.targetId;
  return true;
}

function clearTargets(ids, tasks, sessions) {
  const removed = new Set(ids);
  for (const task of tasks) if (removed.has(task.targetId)) task.targetId = null;
  for (const session of sessions) {
    if (removed.has(session.targetId)) session.targetId = null;
    if (removed.has(session.reviewTargetId)) session.reviewTargetId = null;
  }
}

const PracticeData = { targetLabel, summarize, assignSession, clearTargets };
globalThis.PracticeData = PracticeData;
if (typeof module !== 'undefined' && module.exports) module.exports = PracticeData;
})();
