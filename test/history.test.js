import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ACCEPT,
  ACCEPT_FOLLOW,
  FOLLOW,
  REJECT,
  buildRecord,
  dayKey,
  dayLabel,
  expiredDayKeys,
  filterRecords,
  followedIds,
  groupByDay,
  recordKey,
  selectAllPlan,
  sortRecords,
} from '../src/history.js';

const DAY = 86400000;
const NOW = Date.UTC(2026, 6, 28, 12, 0, 0); // 2026-07-28

const rec = (over = {}) =>
  buildRecord({ at: NOW, userId: '1', username: 'ava', action: ACCEPT, ...over });

test('day shards are UTC, so the key does not depend on the machine', () => {
  assert.equal(dayKey(Date.UTC(2026, 6, 28, 23, 59)), 'log:2026-07-28');
  assert.equal(dayKey(Date.UTC(2026, 6, 29, 0, 1)), 'log:2026-07-29');
});

test('expiredDayKeys drops only shards past the retention window', () => {
  const index = ['log:2024-01-01', 'log:2026-07-01', 'log:2026-07-28'];
  assert.deepEqual(expiredDayKeys(index, NOW, 30), ['log:2024-01-01']);
  assert.deepEqual(expiredDayKeys(index, NOW, 10000), []);
  assert.deepEqual(expiredDayKeys(undefined, NOW), []);
});

test('a record is exactly when, who and what', () => {
  assert.deepEqual(rec({ at: 123, userId: 9, username: 'bo', action: REJECT }), {
    at: 123,
    userId: '9',
    username: 'bo',
    action: REJECT,
  });
});

test('numeric ids normalise to strings so lookups match', () => {
  assert.equal(rec({ userId: 100011 }).userId, '100011');
});

test('recordKey matches the same action arriving twice', () => {
  const written = rec({ at: 1000, userId: '7', action: REJECT });
  const readBack = JSON.parse(JSON.stringify(written));
  assert.equal(recordKey(readBack), recordKey(written));
});

test('recordKey separates records that differ in when, who or what', () => {
  const base = rec({ at: 1000, userId: '7', action: ACCEPT });
  for (const other of [
    rec({ at: 1001, userId: '7', action: ACCEPT }),
    rec({ at: 1000, userId: '8', action: ACCEPT }),
    rec({ at: 1000, userId: '7', action: ACCEPT_FOLLOW }),
  ]) {
    assert.notEqual(recordKey(other), recordKey(base));
  }
});

test('recordKey ignores the username, which is only what they were called then', () => {
  const before = rec({ at: 1000, userId: '7', username: 'ava', action: ACCEPT });
  const renamed = rec({ at: 1000, userId: '7', username: 'ava_2', action: ACCEPT });
  assert.equal(recordKey(renamed), recordKey(before));
});

test('recordKey does not confuse a numeric id with a string one', () => {
  assert.equal(recordKey(rec({ userId: 7 })), recordKey(rec({ userId: '7' })));
});

test('followedIds covers both ways of ending up following someone', () => {
  const ids = followedIds([
    rec({ userId: '1', action: ACCEPT }),
    rec({ userId: '2', action: ACCEPT_FOLLOW }),
    rec({ userId: '3', action: FOLLOW }),
    rec({ userId: '4', action: REJECT }),
  ]);
  assert.deepEqual([...ids].sort(), ['2', '3']);
});

test('following back later clears the row that a plain accept left open', () => {
  const records = [
    rec({ at: NOW - DAY, userId: '1', action: ACCEPT }),
    rec({ at: NOW, userId: '1', action: FOLLOW }),
  ];
  assert.equal(followedIds(records).has('1'), true);
});

test('filterRecords splits accepted from rejected', () => {
  const records = [
    rec({ userId: '1', action: ACCEPT }),
    rec({ userId: '2', action: ACCEPT_FOLLOW }),
    rec({ userId: '3', action: REJECT }),
    rec({ userId: '4', action: FOLLOW }),
  ];
  assert.equal(filterRecords(records, { kind: 'all' }).length, 4);
  assert.deepEqual(filterRecords(records, { kind: 'accepted' }).map((r) => r.userId), ['1', '2']);
  assert.deepEqual(filterRecords(records, { kind: 'rejected' }).map((r) => r.userId), ['3']);
});

test('filterRecords searches usernames case-insensitively', () => {
  const records = [rec({ username: 'Ava_Lindqvist' }), rec({ username: 'fx8823' })];
  assert.equal(filterRecords(records, { search: 'LINDQ' }).length, 1);
  assert.equal(filterRecords(records, { search: '  ' }).length, 2);
  assert.equal(filterRecords(records, {}).length, 2);
});

test('sortRecords puts the newest first and does not mutate its input', () => {
  const records = [rec({ at: 1 }), rec({ at: 3 }), rec({ at: 2 })];
  assert.deepEqual(sortRecords(records).map((r) => r.at), [3, 2, 1]);
  assert.deepEqual(records.map((r) => r.at), [1, 3, 2]);
});

test('dayLabel reads relatively for recent days and absolutely beyond', () => {
  assert.equal(dayLabel('2026-07-28', NOW), 'Today');
  assert.equal(dayLabel('2026-07-27', NOW), 'Yesterday');
  assert.equal(dayLabel('2026-07-04', NOW), '4 Jul 2026');
  assert.equal(dayLabel('2025-12-25', NOW), '25 Dec 2025');
});

test('groupByDay buckets under headings, newest day first', () => {
  const groups = groupByDay(
    [
      rec({ at: NOW - 2 * DAY, userId: '1' }),
      rec({ at: NOW, userId: '2' }),
      rec({ at: NOW - 3600000, userId: '3' }),
    ],
    NOW
  );

  assert.deepEqual(groups.map((g) => g.label), ['Today', '26 Jul 2026']);
  assert.deepEqual(groups[0].records.map((r) => r.userId), ['2', '3'], 'newest first within a day');
});

// -------------------------------------------------------------- select all

test('selectAllPlan offers to select while anything selectable is unticked', () => {
  const plan = selectAllPlan(['1', '2', '3'], new Set(['1']));
  assert.equal(plan.mode, 'select');
  assert.equal(plan.disabled, false);
  assert.deepEqual([...plan.next].sort(), ['1', '2', '3']);
});

test('selectAllPlan flips to deselect once everything selectable is ticked', () => {
  const plan = selectAllPlan(['1', '2'], new Set(['1', '2']));
  assert.equal(plan.mode, 'deselect');
  assert.equal(plan.disabled, false);
  assert.deepEqual([...plan.next], []);
});

test('selectAllPlan keeps ids that are selected but not selectable', () => {
  // A harvested row ticked by hand for a redo. Select-all adds; it does not
  // get to drop a choice made deliberately.
  const plan = selectAllPlan(['1', '2'], new Set(['9']));
  assert.deepEqual([...plan.next].sort(), ['1', '2', '9']);
});

test('selectAllPlan can still clear when nothing is selectable', () => {
  // Every followable row already harvested, one ticked by hand: there is
  // nothing to add, but the button must still be able to undo that tick.
  const plan = selectAllPlan([], new Set(['9']));
  assert.equal(plan.mode, 'deselect');
  assert.equal(plan.disabled, false);
  assert.deepEqual([...plan.next], []);
});

test('selectAllPlan is dead only with nothing to add and nothing to clear', () => {
  const plan = selectAllPlan([], new Set());
  assert.equal(plan.disabled, true);
  assert.deepEqual([...selectAllPlan().next], []);
});
