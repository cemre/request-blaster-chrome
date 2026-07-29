// avatars.js — profile pictures, proxied through the Instagram tab.
//
// Instagram's CDN sets Cross-Origin-Resource-Policy, so putting a
// scontent-*.cdninstagram.com URL straight into an <img> from the extension
// origin fails with ERR_BLOCKED_BY_RESPONSE.NotSameOrigin. The content script
// runs on instagram.com where the same fetch is allowed, so it hands back a
// data URL instead.
//
// Cached in memory only. Roughly 6KB each, so a full 200-row queue costs about
// 1.5MB — not worth persisting, and the CDN URLs expire anyway.

import * as api from './api.js';

const MAX_CONCURRENT = 6;

const cache = new Map(); // cdn url -> data url
const inflight = new Map(); // cdn url -> Promise<string|null>
const waiting = [];
let active = 0;

/** 1x1 transparent GIF, so rows never show a broken-image glyph. */
export const PLACEHOLDER =
  'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

function pump() {
  while (active < MAX_CONCURRENT && waiting.length > 0) {
    const job = waiting.shift();
    active += 1;
    job().finally(() => {
      active -= 1;
      pump();
    });
  }
}

function schedule(task) {
  return new Promise((resolve) => {
    waiting.push(() => task().then(resolve, () => resolve(null)));
    pump();
  });
}

/**
 * @returns the data URL, or null when it could not be fetched. Callers should
 *   leave the placeholder in place on null rather than retrying in a loop.
 */
export function resolveAvatar(url) {
  if (!url) return Promise.resolve(null);
  if (cache.has(url)) return Promise.resolve(cache.get(url));
  if (inflight.has(url)) return inflight.get(url);

  const promise = schedule(async () => {
    const result = await api.call('media', { url });
    const dataUrl = result?.ok ? result.data?.dataUrl : null;
    // Cache failures as null too — a CDN URL that 403s will keep doing so, and
    // 200 rows retrying forever would be worse than a missing avatar.
    cache.set(url, dataUrl ?? null);
    return dataUrl ?? null;
  }).finally(() => inflight.delete(url));

  inflight.set(url, promise);
  return promise;
}

export function clearAvatarCache() {
  cache.clear();
}
