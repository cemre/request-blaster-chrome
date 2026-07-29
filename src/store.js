// store.js — chrome.storage access, the hydrated-profile cache, and the
// durable action history.

import { DAY_PREFIX, LOG_INDEX_KEY, dayKey, expiredDayKeys } from './history.js';

const CACHE_KEY = 'profileCache';
const SETTINGS_KEY = 'settings';
const SNAPSHOT_KEY = 'pendingSnapshot';

// Ids accepted or rejected this session, by either the panel or the on-page
// banner. Both watch this key, which is how the two views stay consistent
// without messaging each other directly. Mirrored in banner.js — keep in sync.
export const HANDLED_KEY = 'handledIds';

export const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export const DEFAULT_SETTINGS = {
  sort: 'default',
  batchSize: 100,
};

/** Hydrated profiles, keyed by user id, with expired entries dropped. */
export async function loadProfileCache() {
  const stored = await chrome.storage.local.get(CACHE_KEY);
  const cache = stored[CACHE_KEY] || {};
  const cutoff = Date.now() - CACHE_TTL_MS;

  let expired = 0;
  for (const [id, profile] of Object.entries(cache)) {
    if (!profile?.fetchedAt || profile.fetchedAt < cutoff) {
      delete cache[id];
      expired += 1;
    }
  }
  if (expired > 0) await chrome.storage.local.set({ [CACHE_KEY]: cache });

  return cache;
}

/**
 * Merge freshly hydrated profiles into the cache.
 *
 * Callers batch their writes — the hydration queue produces one profile every
 * couple of seconds and flushing on each one would be a pointless amount of
 * disk churn.
 */
export async function saveProfiles(profilesById) {
  if (!profilesById || Object.keys(profilesById).length === 0) return;
  const stored = await chrome.storage.local.get(CACHE_KEY);
  const cache = { ...(stored[CACHE_KEY] || {}), ...profilesById };
  await chrome.storage.local.set({ [CACHE_KEY]: cache });
}

export async function clearProfileCache() {
  await chrome.storage.local.remove(CACHE_KEY);
}

export async function loadSettings() {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  return { ...DEFAULT_SETTINGS, ...(stored[SETTINGS_KEY] || {}) };
}

export async function saveSettings(settings) {
  await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
}

// Session-scoped so reopening the panel within a browser session is instant,
// but a browser restart always refetches.
export async function loadSnapshot() {
  try {
    const stored = await chrome.storage.session.get(SNAPSHOT_KEY);
    return stored[SNAPSHOT_KEY] || null;
  } catch {
    return null;
  }
}

export async function saveSnapshot(snapshot) {
  try {
    await chrome.storage.session.set({ [SNAPSHOT_KEY]: snapshot });
  } catch {
    // Snapshot is a nicety, never worth failing a load over.
  }
}

export async function clearSnapshot() {
  try {
    await chrome.storage.session.remove([SNAPSHOT_KEY, HANDLED_KEY]);
  } catch {
    /* ignore */
  }
}

export async function loadHandledIds() {
  try {
    const stored = await chrome.storage.session.get(HANDLED_KEY);
    return new Set(stored[HANDLED_KEY] || []);
  } catch {
    return new Set();
  }
}

export async function addHandledId(id) {
  try {
    const handled = await loadHandledIds();
    handled.add(id);
    await chrome.storage.session.set({ [HANDLED_KEY]: [...handled] });
  } catch {
    /* ignore */
  }
}

// ------------------------------------------------------------ action log
//
// Append-only, sharded by day. Nothing here is read at startup — the panel
// touches the log only when you open it. See src/history.js for the layout.

/**
 * Append one action. Touches two small keys: today's shard and the shard
 * index. Written per action rather than batched, because the corresponding
 * write on Instagram's side is irreversible and there must be no window where
 * closing the panel loses the record of it.
 */
export async function appendAction(record) {
  try {
    const shard = dayKey(record.at);
    const stored = await chrome.storage.local.get([shard, LOG_INDEX_KEY]);
    const index = stored[LOG_INDEX_KEY] || [];

    await chrome.storage.local.set({
      [shard]: [...(stored[shard] || []), record],
      [LOG_INDEX_KEY]: index.includes(shard) ? index : [...index, shard].sort(),
    });
    return true;
  } catch {
    // The log is a record of triage, not part of it. Never fail an action.
    return false;
  }
}

/** Day shard keys that exist, newest first. */
export async function loadLogIndex() {
  try {
    const stored = await chrome.storage.local.get(LOG_INDEX_KEY);
    return [...(stored[LOG_INDEX_KEY] || [])].sort().reverse();
  } catch {
    return [];
  }
}

/** Records from specific day shards. The log view pages through these. */
export async function loadLogDays(shardKeys) {
  if (!shardKeys || shardKeys.length === 0) return [];
  try {
    const stored = await chrome.storage.local.get(shardKeys);
    return shardKeys.flatMap((key) => stored[key] || []);
  } catch {
    return [];
  }
}

/** Drop shards past the retention window. */
export async function pruneLog(now = Date.now()) {
  try {
    const index = (await chrome.storage.local.get(LOG_INDEX_KEY))[LOG_INDEX_KEY] || [];
    const expired = expiredDayKeys(index, now);
    if (expired.length === 0) return 0;

    await chrome.storage.local.remove(expired);
    await chrome.storage.local.set({
      [LOG_INDEX_KEY]: index.filter((key) => !expired.includes(key)),
    });
    return expired.length;
  } catch {
    return 0;
  }
}

/**
 * Erase the log. The one operation that enumerates storage, because it has to
 * find every shard rather than the ones the index claims exist.
 */
export async function clearLog() {
  const everything = await chrome.storage.local.get(null);
  const keys = Object.keys(everything).filter(
    (key) => key.startsWith(DAY_PREFIX) || key === LOG_INDEX_KEY
  );
  if (keys.length > 0) await chrome.storage.local.remove(keys);
  return keys.length;
}

