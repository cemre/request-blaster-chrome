// harvest/store.js — chrome.storage access for the harvest's own state:
// which ids it has already written to a batch, and the action log read in
// full as harvest input.
//
// Split out of src/store.js so the harvest feature lives entirely under
// src/harvest/ and can be added or removed without touching shared code —
// see banner.js for the same pattern.

import { loadLogDays, loadLogIndex } from '../store.js';

// Ids already written to a harvest batch. Kept apart from the action log,
// which is append-only and records what you did — not what a tool has since
// read. Ids only; everything else about the account is in the batch folder.
export const HARVESTED_KEY = 'harvestedIds';

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

export async function loadHarvestedIds() {
  try {
    const stored = await chrome.storage.local.get(HARVESTED_KEY);
    return new Set(stored[HARVESTED_KEY] || []);
  } catch {
    return new Set();
  }
}

export async function markHarvested(userId) {
  try {
    const harvested = await loadHarvestedIds();
    harvested.add(String(userId));
    await chrome.storage.local.set({ [HARVESTED_KEY]: [...harvested] });
  } catch {
    // Losing this only means a later batch re-harvests someone. Never worth
    // failing a batch over.
  }
}
