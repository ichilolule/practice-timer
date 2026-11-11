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

function clearTargets(ids, tasks, sessions) {
  const removed = new Set(ids);
  for (const task of tasks) if (removed.has(task.targetId)) task.targetId = null;
  for (const session of sessions) {
    if (removed.has(session.targetId)) session.targetId = null;
  }
}

function periodBounds(kind, anchor, dayStartMinutes = 0) {
  const start = new Date(anchor);
  start.setHours(Math.floor(dayStartMinutes / 60), dayStartMinutes % 60, 0, 0);
  if (anchor < start.getTime()) start.setDate(start.getDate() - 1);
  if (kind === 'week') start.setDate(start.getDate() - (start.getDay() + 6) % 7);
  if (kind === 'month') start.setDate(1);
  if (kind === 'year') { start.setMonth(0, 1); }
  start.setHours(Math.floor(dayStartMinutes / 60), dayStartMinutes % 60, 0, 0);
  const end = new Date(start);
  if (kind === 'week') end.setDate(end.getDate() + 7);
  else if (kind === 'month') end.setMonth(end.getMonth() + 1);
  else if (kind === 'year') end.setFullYear(end.getFullYear() + 1);
  else end.setDate(end.getDate() + 1);
  end.setHours(Math.floor(dayStartMinutes / 60), dayStartMinutes % 60, 0, 0);
  return { start: start.getTime(), end: end.getTime() };
}

function workInRange(session, start, end) {
  if (session.startedAt == null) return session.endedAt >= start && session.endedAt < end ? session.workMs : 0;
  return Math.max(0, Math.min(session.endedAt, end) - Math.max(session.startedAt, start));
}

function periodBuckets(kind, anchor, sessions, dayStartMinutes = 0) {
  const bounds = periodBounds(kind, anchor, dayStartMinutes);
  const buckets = [];
  let cursor = new Date(bounds.start);
  while (cursor.getTime() < bounds.end) {
    const start = cursor.getTime();
    if (kind === 'day') cursor = new Date(Math.min(start + 3_600_000, bounds.end));
    else if (kind === 'year') cursor.setMonth(cursor.getMonth() + 1);
    else cursor.setDate(cursor.getDate() + 1);
    if (kind !== 'day') cursor.setHours(Math.floor(dayStartMinutes / 60), dayStartMinutes % 60, 0, 0);
    const end = cursor.getTime();
    buckets.push({ start, end, workMs: sessions.reduce((sum, session) =>
      sum + (kind === 'day' && session.startedAt == null ? 0 : workInRange(session, start, end)), 0) });
  }
  return buckets;
}

const PracticeData = { targetLabel, summarize, clearTargets,
  periodBounds, workInRange, periodBuckets };
globalThis.PracticeData = PracticeData;
if (typeof module !== 'undefined' && module.exports) module.exports = PracticeData;
})();
