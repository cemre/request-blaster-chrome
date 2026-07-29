// harvest/log.js — the harvest's second candidate source, read off the
// action log. No chrome.*, no DOM.
//
// Split out of src/history.js so the harvest feature lives entirely under
// src/harvest/ and can be added or removed without touching shared code —
// see banner.js for the same pattern.

import { followedIds, isAccept } from '../history.js';

/**
 * Everyone you accepted and have not followed, oldest accept first.
 *
 * The harvest's second candidate source. Derived on read like followedIds() —
 * the log already says all of this, and a second copy would drift from it.
 */
export function acceptedNotFollowed(records) {
  const followed = followedIds(records);

  // Whether someone belongs on this list depends on their most recent
  // decision, not just whether an accept exists anywhere in their history —
  // a later reject should retract an earlier accept.
  const latestById = new Map();
  for (const record of records) {
    const existing = latestById.get(record.userId);
    if (!existing || record.at > existing.at) latestById.set(record.userId, record);
  }

  const byId = new Map();
  for (const record of records) {
    if (!isAccept(record) || followed.has(record.userId)) continue;
    if (!isAccept(latestById.get(record.userId))) continue;
    const existing = byId.get(record.userId);
    // Keep the earliest accept — re-accepting after a later reject should not
    // make someone look newly accepted.
    if (!existing || record.at < existing.at) {
      byId.set(record.userId, { userId: record.userId, username: record.username, at: record.at });
    }
  }

  return [...byId.values()].sort((a, b) => a.at - b.at);
}
