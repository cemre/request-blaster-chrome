// harvest/store.js — chrome.storage access for the harvest's own state:
// which ids it has already written to a batch, and the action log read in
// full as harvest input.
//
// Split out of src/store.js so the harvest feature lives entirely under
// src/harvest/ and can be added or removed without touching shared code —
// see banner.js for the same pattern.

import { loadLogDays, loadLogIndex } from '../store.js';
import { normalizeHarvested } from './model.js';

// Accounts already written to a harvest batch, as `{ [pk]: { at, batchId } }`.
// Kept apart from the action log, which is append-only and records what you did
// — not what a tool has since read.
//
// `at` is what the log row's "Harvested 28 Jul 2026" is built from. `batchId`
// is never rendered; it is the answer to "which folder holds this person's
// review", and it costs nothing to carry.
export const HARVESTED_KEY = 'harvested';

// The same set as a bare array of ids, which is all it held before the mark
// became visible in the log. Read for migration, never written.
export const LEGACY_HARVESTED_KEY = 'harvestedIds';

/**
 * Every action-log record across every day shard.
 *
 * Shard order follows loadLogIndex (newest day first), and loadLogDays does
 * not reorder within a shard, so records come back newest day first, oldest
 * record first within that day — not the oldest-first sweep the name might
 * suggest.
 */
export async function loadAllLogRecords() {
  const index = await loadLogIndex();
  if (index.length === 0) return [];
  return loadLogDays(index);
}

/** Both keys at once, so a read can migrate the old shape without a second get. */
async function readHarvested() {
  const stored = await chrome.storage.local.get([HARVESTED_KEY, LEGACY_HARVESTED_KEY]);
  return {
    harvested: normalizeHarvested(stored[HARVESTED_KEY] ?? stored[LEGACY_HARVESTED_KEY]),
    legacy: Boolean(stored[LEGACY_HARVESTED_KEY]),
  };
}

export async function loadHarvested() {
  try {
    return (await readHarvested()).harvested;
  } catch {
    return {};
  }
}

/**
 * Record that an account's files are on disk.
 *
 * @param alias a second id for the same account, marked alongside the first.
 *   web_profile_info is the authority on which account a username resolves to,
 *   so a renamed or merged account is written under an id the log has never
 *   seen — and the log row, which still holds the id from the request that
 *   created it, would show no mark at all. Marking both costs one map entry
 *   and is the difference between a redo being offered and being invisible.
 */
export async function markHarvested(userId, { batchId = null, alias = null, at = Date.now() } = {}) {
  try {
    const { harvested, legacy } = await readHarvested();

    const entry = { at, batchId };
    for (const id of [userId, alias]) {
      const key = String(id ?? '');
      if (key) harvested[key] = entry;
    }

    await chrome.storage.local.set({ [HARVESTED_KEY]: harvested });
    // Only once, and only if it was still there: the migration is complete the
    // first time the new key is written.
    if (legacy) await chrome.storage.local.remove(LEGACY_HARVESTED_KEY);
  } catch {
    // Losing this only means a later batch re-harvests someone. Never worth
    // failing a batch over.
  }
}
