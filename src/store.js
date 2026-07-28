// store.js — chrome.storage access and the hydrated-profile cache.

const CACHE_KEY = 'profileCache';
const SETTINGS_KEY = 'settings';
const SNAPSHOT_KEY = 'pendingSnapshot';

// Ids accepted or rejected this session, by either the panel or the on-page
// banner. Both watch this key, which is how the two views stay consistent
// without messaging each other directly. Mirrored in banner.js — keep in sync.
export const HANDLED_KEY = 'handledIds';

export const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export const DEFAULT_SETTINGS = {
  pacing: 'moderate',
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
