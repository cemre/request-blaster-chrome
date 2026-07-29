// harvest/api.js — Instagram calls specific to the follow-back harvest.
//
// Split out of src/api.js so the harvest feature lives entirely under
// src/harvest/ and can be added or removed without touching shared code.
// `call` and `ApiError` are shared and imported below, but `raise`, `sleep`
// and the bulk pacing gap are internal to src/api.js and not exported, so
// this file keeps its own copies rather than adding harvest-only exports to
// shared code — the same spirit as banner.js deliberately duplicating shared
// storage keys instead of reaching across the boundary.

import { ApiError, call } from '../api.js';
import { MAX_PHOTOS, normalizeMediaItem } from './model.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Mirrors src/api.js's BULK_GAP_MS. Same value, kept local rather than
// imported since api.js does not export it.
const BULK_GAP_MS = 400;

function raise(result) {
  if (result?.loggedOut) throw new ApiError('logged_out', 'Not signed in to Instagram.');
  if (result?.blocked) throw new ApiError('blocked', result.error || 'Instagram is rate limiting requests.');
  throw new ApiError('api_error', result?.error || 'Instagram API request failed.');
}

// Unlike friendships/pending/, this endpoint paginates for real — verified
// 2026-07-28, see docs/follow-back/api-findings.md. It ignores ?count= and
// serves a fixed 25 users per page, so the cap is in units of 25.
const MAX_FOLLOWER_PAGES = 400; // 400 x 25 = 10000 followers

/**
 * Every follower of the signed-in user.
 * `onPage` fires per page so the panel can show progress on a long list.
 */
export async function fetchAllFollowers(onPage) {
  const users = [];
  const seenCursors = new Set();
  let maxId = '';
  let page = 0;

  do {
    const result = await call('followers', maxId ? { maxId } : {});
    if (!result?.ok) raise(result);

    const batch = result.data?.users || [];
    users.push(...batch);
    page += 1;
    if (onPage) onPage({ page, batch, total: users.length });

    const nextCursor = result.data?.next_max_id || '';
    if (!nextCursor || seenCursors.has(nextCursor) || page >= MAX_FOLLOWER_PAGES || batch.length === 0) {
      maxId = '';
    } else {
      seenCursors.add(nextCursor);
      maxId = nextCursor;
      await sleep(BULK_GAP_MS);
    }
  } while (maxId);

  return { users, capped: page >= MAX_FOLLOWER_PAGES };
}

// feed/user/ ignores ?count= and serves a fixed 12 items per page (verified
// 2026-07-28), so 50 photos needs 5 pages. 6 leaves a page of margin.
const MAX_FEED_PAGES = 6;

/**
 * Up to `limit` recent posts for one account, newest first, already normalized.
 *
 * Stops as soon as it has enough — a 50-photo target is usually two pages, so
 * this does not walk someone's entire history.
 */
export async function fetchUserMedia(pk, limit = MAX_PHOTOS) {
  const media = [];
  const seenCursors = new Set();
  let maxId = '';
  let page = 0;

  do {
    const result = await call('userFeed', maxId ? { pk, maxId } : { pk });
    if (!result?.ok) raise(result);

    const items = result.data?.items || [];
    for (const item of items) {
      const normalized = normalizeMediaItem(item);
      if (normalized) media.push(normalized);
      if (media.length >= limit) break;
    }
    page += 1;

    const nextCursor = result.data?.next_max_id || '';
    const more = result.data?.more_available !== false;
    if (media.length >= limit || !more || !nextCursor || seenCursors.has(nextCursor)
        || page >= MAX_FEED_PAGES || items.length === 0) {
      maxId = '';
    } else {
      seenCursors.add(nextCursor);
      maxId = nextCursor;
      await sleep(BULK_GAP_MS);
    }
  } while (maxId);

  return media.slice(0, limit);
}

// The mutual list is one page deep on purpose. web_profile_info's count is the
// authoritative total; this is for the names, and ~50 of them already says
// everything about whether someone sits inside the viewer's circle.
const MAX_MUTUAL_NAMES = 50;

/**
 * Usernames the viewer and this account both follow.
 *
 * Verified 2026-07-28 to return 53 users where web_profile_info's
 * `edge_mutual_followed_by` carried only 3 names. Returns [] rather than
 * throwing on failure — mutuals enrich a record, they never gate one.
 */
export async function fetchMutualFollowers(pk, limit = MAX_MUTUAL_NAMES) {
  try {
    const result = await call('mutualFollowers', { pk });
    if (!result?.ok) return [];
    return (result.data?.users || [])
      .map((user) => user?.username)
      .filter(Boolean)
      .slice(0, limit);
  } catch {
    return [];
  }
}
