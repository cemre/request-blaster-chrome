// model.js — pure data transforms. No chrome.*, no DOM.
//
// Everything here is directly unit-testable under `node --test`.

import { normalizeHandle } from './alias.js';

export const BOT_RATIO_MIN_FOLLOWING = 1000;
export const BOT_RATIO_THRESHOLD = 10;

// Fallback only. friendships/pending/ carries an authoritative
// `has_anonymous_profile_picture` boolean per user (verified 2026-07-28), so
// URL matching is just a backstop for when that field is absent. A miss
// returns false rather than a guess, so the filter under-matches instead of
// wrongly flagging someone.
const DEFAULT_PIC_PATTERNS = [
  /44884218_345707102882519_2446069589734326272_n\.jpg/,
  /\/static\/images\/anonymousUser\.jpg/,
];

/**
 * Approximate mutual-follower count from the `social_context` string that
 * `friendships/pending/` returns for free, e.g. "Followed by alice, bob + 3 more".
 *
 * Approximate by nature — hydration replaces it with the exact count. Returns 0
 * for anything that isn't a followed-by string, so unrelated social contexts
 * ("New to Instagram") don't get counted as a mutual.
 */
export function parseMutualCount(socialContext) {
  if (typeof socialContext !== 'string') return 0;
  const text = socialContext.trim();
  if (!/^followed by\b/i.test(text)) return 0;

  const tail = text.match(/(?:\+|\band\b)\s*([\d,]+)\s+(?:more|others?)/i);
  const extra = tail ? parseInt(tail[1].replace(/,/g, ''), 10) : 0;

  const namesPart = text
    .replace(/^followed by\s*/i, '')
    .replace(/(?:\+|\band\b)\s*[\d,]+\s+(?:more|others?)\s*$/i, '')
    .replace(/,\s*$/, '')
    .trim();

  const named = namesPart ? namesPart.split(/,|\sand\s/i).filter((part) => part.trim()).length : 0;

  return named + extra;
}

/**
 * The pending-list mutual estimate for one user: a number when Instagram gave
 * us something to count, `null` when it said nothing at all.
 *
 * The distinction is the whole point. Verified against the live queue on
 * 2026-07-28: only 73 of 200 pending users carried a `social_context` string
 * and the other 127 omitted the field entirely. Collapsing that absence to 0 —
 * which `parseMutualCount` does, correctly, as a string parser — made the panel
 * state "0 mutuals" about the majority of every queue without ever checking.
 * Two of those rows turned out to have 2 and 17 mutuals.
 *
 * Only hydration can turn a null into a real number.
 */
export function approximateMutuals(socialContext) {
  if (typeof socialContext !== 'string' || !/^\s*followed by\b/i.test(socialContext)) return null;
  return parseMutualCount(socialContext);
}

export function isDefaultPic(url) {
  if (typeof url !== 'string') return false;
  return DEFAULT_PIC_PATTERNS.some((pattern) => pattern.test(url));
}

export function isBotRatio(row) {
  if (!row.enriched) return false;
  const following = row.followingCount ?? 0;
  const followers = row.followers ?? 0;
  return following >= BOT_RATIO_MIN_FOLLOWING && following / Math.max(followers, 1) >= BOT_RATIO_THRESHOLD;
}

/**
 * Merge the three data sources into the row model the panel renders.
 *
 * @param pendingUsers    raw `users[]` from friendships/pending/, in API order
 * @param friendshipStatuses  map of user id -> status from friendships/show_many/
 * @param profileCache    map of user id -> hydrated profile, or {}
 */
export function mergeRows(pendingUsers, friendshipStatuses = {}, profileCache = {}) {
  return pendingUsers.map((user, index) => {
    const id = String(user.pk);
    const status = friendshipStatuses[id] || friendshipStatuses[user.pk] || {};
    const cached = profileCache[id];
    const approxMutuals = approximateMutuals(user.social_context);

    const row = {
      id,
      order: index,
      username: user.username,
      fullName: user.full_name || '',
      avatar: user.profile_pic_url || '',
      isPrivate: user.is_private ?? status.is_private ?? false,
      isVerified: user.is_verified ?? false,
      socialContext: user.social_context || '',
      following: status.following ?? false,
      approxMutuals,

      // Free from the pending list — no hydration needed for this one.
      defaultPic: user.has_anonymous_profile_picture ?? isDefaultPic(user.profile_pic_url),

      enriched: false,
      followers: null,
      followingCount: null,
      posts: null,
      bio: '',
      mutualNames: [],
    };

    if (cached) {
      Object.assign(row, {
        enriched: true,
        followers: cached.followers,
        followingCount: cached.following,
        posts: cached.posts,
        bio: cached.bio || '',
        mutualNames: cached.mutualNames || [],
        exactMutuals: cached.mutualCount,
        isPrivate: cached.isPrivate ?? row.isPrivate,
        isVerified: cached.isVerified ?? row.isVerified,
      });
    }

    // Exact count once hydrated, the social_context estimate before that, and
    // null when neither source has told us anything. Never a stand-in zero.
    row.mutuals = row.enriched && typeof row.exactMutuals === 'number' ? row.exactMutuals : approxMutuals;

    return row;
  });
}

// `minMutuals` and `maxMutuals` are both inclusive bounds, and the panel's
// menu speaks in exclusive ones — "> 5" arrives here as a minimum of 6, "< 5"
// as a maximum of 4. Off is 0 for the floor and null for the ceiling, because
// a ceiling of 0 is a real request ("nobody at all") rather than an absence of
// one, unlike a floor of 0.
export const DEFAULT_FILTERS = {
  onlyFollowing: false,
  minMutuals: 0,
  maxMutuals: null,
  noMutuals: false,
  maxFollowers: null,
  zeroPosts: false,
  emptyBio: false,
  defaultPic: false,
  botRatio: false,
  mutualHandles: [],
  search: '',
};

/**
 * The custom-range half of the mutuals popover, in applyFilters's own terms.
 * `=` is not a third bound type — it is just a floor and a ceiling pinned to
 * the same number, which applyFilters already knows how to intersect.
 */
export function mutualsBoundFromComparator(comparator, n) {
  switch (comparator) {
    case '>': return { minMutuals: n + 1, maxMutuals: null };
    case '>=': return { minMutuals: n, maxMutuals: null };
    case '<': return { minMutuals: 0, maxMutuals: n - 1 };
    case '<=': return { minMutuals: 0, maxMutuals: n };
    case '=': return { minMutuals: n, maxMutuals: n };
    default: return { minMutuals: 0, maxMutuals: null };
  }
}

// Filters that can only be evaluated against a hydrated row. When any of these
// is active, un-enriched rows are excluded rather than assumed innocent — the
// panel surfaces how many rows that hides.
//
// `noMutuals` is here for a sharper reason than the rest. An absent
// social_context does NOT mean zero mutuals: sampled against a live queue on
// 2026-07-28, 128 of 200 pending users had no social_context, and half of a
// random sample of those actually had mutuals (38, 9, 2, 2). Matching "0
// mutuals" on the free estimate would hand you ~128 rows to bulk reject, half
// of them wrong, irreversibly. So it only ever matches an exact count from
// web_profile_info.
//
// `defaultPic` is deliberately absent: has_anonymous_profile_picture ships
// with the pending list, so that filter works on every row for free.
//
// `mutualHandles` is here for the same reason as `noMutuals`: row.mutualNames
// is only ever populated once a row is enriched (see mergeRows), so matching
// it against an un-enriched row would just be matching against [].
const ENRICHED_ONLY_FILTERS = ['maxFollowers', 'zeroPosts', 'emptyBio', 'botRatio', 'noMutuals', 'mutualHandles'];

const hasCeiling = (filters) => filters.maxMutuals !== null && filters.maxMutuals !== undefined;

export function usesEnrichedFilters(filters) {
  return ENRICHED_ONLY_FILTERS.some((key) => {
    const value = filters[key];
    // Both are always-truthy containers regardless of whether anything is
    // actually in them — Boolean(value) alone would treat [] and '' as active.
    if (key === 'maxFollowers') return value !== null && value !== '';
    if (key === 'mutualHandles') return Array.isArray(value) && value.length > 0;
    return Boolean(value);
  });
}

/**
 * Is anything here narrowing the list?
 *
 * The question the panel actually asks is "if this list is empty, is that the
 * filters' doing or is there genuinely nothing left?" — so it counts exactly
 * what `applyFilters` can reject a row for. Sort order is not a filter, and a
 * search of nothing but whitespace is not one either, since applyFilters trims
 * it away before matching.
 */
export function filtersActive(filters) {
  if (filters.onlyFollowing || filters.defaultPic) return true;
  if (filters.minMutuals > 0 || hasCeiling(filters)) return true;
  if (filters.search.trim() !== '') return true;
  return usesEnrichedFilters(filters);
}

export function applyFilters(rows, filters) {
  const needle = filters.search.trim().toLowerCase();
  const enrichedActive = usesEnrichedFilters(filters);

  return rows.filter((row) => {
    if (filters.onlyFollowing && !row.following) return false;
    // An unknown count cannot clear a threshold — `null < n` would quietly say
    // it can. Hidden rather than assumed innocent, and the panel says how many
    // went that way so the answer is "hydrate them", not "never see them".
    if (filters.minMutuals > 0 && (row.mutuals === null || row.mutuals < filters.minMutuals)) return false;
    // Same rule under a ceiling, where the unfiltered null is worse: it reads
    // as "hardly any mutuals", which is what this end of the menu is for
    // rejecting on. Only a count we actually have may answer for a row.
    if (hasCeiling(filters) && (row.mutuals === null || row.mutuals > filters.maxMutuals)) return false;
    if (filters.defaultPic && !row.defaultPic) return false;

    // `alias`/`aliasName` are only set while screenshot mode is on (see
    // panel.js recompute), and searching them as well as the real values is
    // what keeps the search box usable when the list is showing pseudonyms.
    if (needle) {
      const haystack =
        `${row.username} ${row.fullName} ${row.alias || ''} ${row.aliasName || ''}`.toLowerCase();
      if (!haystack.includes(needle)) return false;
    }

    if (!enrichedActive) return true;
    if (!row.enriched) return false;

    if (filters.maxFollowers !== null && filters.maxFollowers !== '') {
      if ((row.followers ?? 0) >= Number(filters.maxFollowers)) return false;
    }
    if (filters.zeroPosts && (row.posts ?? 0) !== 0) return false;
    if (filters.emptyBio && row.bio.trim() !== '') return false;
    if (filters.botRatio && !isBotRatio(row)) return false;
    // row.mutuals is the exact count here — the enriched gate above guarantees it.
    if (filters.noMutuals && row.mutuals !== 0) return false;
    if (
      filters.mutualHandles?.length > 0
      && !row.mutualNames?.some((name) => filters.mutualHandles.includes(normalizeHandle(name)))
    ) return false;

    return true;
  });
}

/**
 * How many rows a mutuals bound hid purely because their count is unknown.
 *
 * Counted against the set that clears every *other* active filter, so the
 * number the panel shows is the number that would come back by hydrating —
 * not a tally of rows something else had already removed.
 */
export function countHiddenByUnknownMutuals(rows, filters) {
  if (!(filters.minMutuals > 0) && !hasCeiling(filters)) return 0;
  return applyFilters(rows, { ...filters, minMutuals: 0, maxMutuals: null })
    .filter((row) => row.mutuals === null).length;
}

/**
 * The user's "always accept if mutual with" list, as free text. Split on
 * commas rather than requiring a strict format, run each piece through the
 * same normalizeHandle the rest of the app already compares handles with,
 * and drop anything that normalizes to nothing.
 */
export function parsePriorityHandles(text) {
  if (typeof text !== 'string') return [];
  return [...new Set(text.split(',').map(normalizeHandle).filter(Boolean))];
}

/**
 * Auto-triage's rule, applied once: accept at or above the threshold, reject
 * strictly below it, and leave alone whatever mutuals could not be pinned
 * down. Rejecting on a guess is the one mistake here that cannot be undone,
 * so a row this cannot place goes to neither pile.
 *
 * A below-threshold row still gets accepted if one of its mutual names is on
 * priorityHandles — Instagram only ever surfaces ~3 mutual names per row
 * (see toCachedProfile), so this is matching against a sample, not the row's
 * full mutual list.
 */
export function splitByMutuals(rows, minMutuals, priorityHandles = new Set()) {
  const accept = [];
  const reject = [];
  const unknown = [];

  for (const row of rows) {
    if (typeof row.mutuals !== 'number') {
      unknown.push(row);
    } else if (row.mutuals >= minMutuals) {
      accept.push(row);
    } else if (row.mutualNames?.some((name) => priorityHandles.has(normalizeHandle(name)))) {
      accept.push(row);
    } else {
      reject.push(row);
    }
  }

  return { accept, reject, unknown };
}

// An unknown count sits between a confirmed zero and a confirmed one: someone
// who might share mutuals is a better thing to look at than someone proven not
// to. Sorting null as 0 buried the majority of the queue behind the rows
// Instagram happened to describe.
const mutualRank = (value) => (value === null || value === undefined ? 0.5 : value);

export const SORTS = {
  // Matches the existing extension's ordering: people you already follow first,
  // then by mutual count.
  default: (a, b) => {
    if (a.following !== b.following) return Number(b.following) - Number(a.following);
    const left = mutualRank(a.mutuals);
    const right = mutualRank(b.mutuals);
    if (left !== right) return right - left;
    return a.username.localeCompare(b.username);
  },
  // friendships/pending/ returns newest first, so API order is recency order.
  newest: (a, b) => a.order - b.order,
  followers: (a, b) => {
    const left = a.followers;
    const right = b.followers;
    if (left === null && right === null) return a.order - b.order;
    if (left === null) return 1; // un-enriched rows sink to the bottom
    if (right === null) return -1;
    return right - left;
  },
};

export function sortRows(rows, sortKey) {
  const comparator = SORTS[sortKey] || SORTS.default;
  return [...rows].sort(comparator);
}

/** Shape a web_profile_info response into what the cache stores. */
export function toCachedProfile(webProfileInfo) {
  const user = webProfileInfo?.data?.user;
  if (!user) return null;

  return {
    username: user.username,
    followers: user.edge_followed_by?.count ?? 0,
    following: user.edge_follow?.count ?? 0,
    posts: user.edge_owner_to_timeline_media?.count ?? 0,
    bio: user.biography || '',
    mutualCount: user.edge_mutual_followed_by?.count ?? 0,
    mutualNames: (user.edge_mutual_followed_by?.edges || [])
      .map((edge) => edge?.node?.username)
      .filter(Boolean),
    isPrivate: user.is_private ?? false,
    isVerified: user.is_verified ?? false,
    fetchedAt: Date.now(),
  };
}

/**
 * The mutual-count stat as a row shows it. Pure, so the three states stay
 * under test — this rule previously lived inline in the renderer, where a
 * comment asserting "a count of zero is exact either way" went unchallenged
 * and printed "0 mutuals" for every row Instagram had said nothing about.
 *
 *   null  → "? mutuals"   unknown; needs hydration to answer
 *   ~n    → "~3 mutuals"  estimated from the social_context string
 *   n     → "3 mutuals"   exact, straight off the profile
 */
export function formatMutuals(row) {
  if (row.mutuals === null || row.mutuals === undefined) return '? mutuals';
  const noun = row.mutuals === 1 ? 'mutual' : 'mutuals';
  return `${row.enriched ? '' : '~'}${row.mutuals} ${noun}`;
}

/**
 * A failed hydration as the row itself should show it: a two-word chip and the
 * evidence behind it.
 *
 * Hydration used to be the one queue that swallowed this. A profile fetch that
 * 404'd or came back in an unexpected shape had its "Loading…" chip taken back
 * off and the un-enriched row rebuilt underneath — leaving a row that had been
 * tried and failed looking exactly like one that had never been reached, both
 * of them still reading "? mutuals". Accepts and rejects have always marked
 * their own failures (see actOnce); this is hydration doing the same.
 *
 * `reason` is content.js's own reading of the response and is taken first where
 * it exists — a queue-wide halt always carries one. Anything without a reason
 * is a failure about this one profile rather than about the session, so the
 * status and the message decide.
 */
export function describeHydrationFailure(result) {
  const label = (() => {
    switch (result?.reason) {
      case 'signed_out': return 'Signed out';
      case 'session_rejected':
      case 'rate_limited': return 'Rate limited';
      case 'checkpoint':
      case 'challenge': return 'Check Instagram';
      case 'html_response': return 'Bad response';
      default: break;
    }

    // status 0 is igFetch's own marker for a fetch that never got an answer.
    if (result?.status === 0) return 'Network error';
    // The account was renamed, deactivated or deleted between the pending list
    // being served and this row's turn coming up. Retrying will not fix it.
    if (result?.status === 404) return 'No profile';
    if (result?.error === 'unexpected profile shape') return 'Bad response';
    return 'Failed';
  })();

  const parts = [];
  if (result?.reason) parts.push(result.reason);
  if (result?.error) parts.push(result.error);
  else if (typeof result?.status === 'number' && result.status > 0) parts.push(`HTTP ${result.status}`);

  return { label, detail: parts.join(' · ') || 'Instagram did not answer.' };
}

export function formatCount(value) {
  if (value === null || value === undefined) return '—';
  if (value < 1000) return String(value);
  if (value < 1000000) {
    const thousands = value / 1000;
    return `${thousands < 10 ? thousands.toFixed(1).replace(/\.0$/, '') : Math.round(thousands)}k`;
  }
  const millions = value / 1000000;
  return `${millions < 10 ? millions.toFixed(1).replace(/\.0$/, '') : Math.round(millions)}m`;
}

/**
 * The single count line under the filters. Says what it is counting when the
 * list is whole, and both numbers when a filter is narrowing it — the panel has
 * no heading left to explain a bare number.
 */
export function formatShownCount(visible, total) {
  if (visible !== total) return `${visible} of ${total}`;
  return `${total} request${total === 1 ? '' : 's'}`;
}

/**
 * The ids a shift-click covers: everything from the anchor to the clicked row,
 * inclusive.
 *
 * `ordered` is the selectable ids in the order they appear on screen, so which
 * of the two came first is a fact about that list rather than about the clicks
 * — hence no assumption that the anchor precedes the click. Dragging a range
 * upwards is the same gesture as dragging it down.
 *
 * Returns just the clicked id when there is no usable anchor: a first click, or
 * one whose anchor a repaint has since taken off screen. That is the same
 * outcome as a plain click, which is what the caller should then treat it as.
 *
 * Both lists share this because both got range select at once, and the rule is
 * arithmetic over an ordered list rather than anything either list knows.
 */
export function rangeIds(ordered = [], anchorId, clickedId) {
  const to = ordered.indexOf(clickedId);
  if (to === -1) return [];

  const from = ordered.indexOf(anchorId);
  if (from === -1) return [clickedId];

  return ordered.slice(Math.min(from, to), Math.max(from, to) + 1);
}

// ------------------------------------------------------------ rate limits

/** The first wait, when a block has no history yet — most blocks are brief. */
export const RATE_LIMIT_FLOOR_MS = 5 * 60 * 1000;
/** Where plain doubling stops: 5, 10, 20, 40 min, then this. */
export const RATE_LIMIT_DOUBLING_CAP_MS = 60 * 60 * 1000;
/** One more step past the doubling cap before giving up on short waits
 * entirely — a block still there after an hour gets one more hour's benefit
 * of the doubt before the time-projection below takes over. */
export const RATE_LIMIT_SECOND_CAP_MS = 2 * 60 * 60 * 1000;
/** Instagram's longest observed lockout. Once the second cap is used and a
 * block is still there, later waits aim at this many ms from the *original*
 * block instead of continuing to poll every two hours. */
export const RATE_LIMIT_ASSUMED_MS = 24 * 60 * 60 * 1000;
/** An episode this old is not "the same lockout, resumed" by any reading —
 * treated as a fresh one instead of projecting off a block from days ago. */
const RATE_LIMIT_STALE_AFTER_MS = 2 * RATE_LIMIT_ASSUMED_MS;

/**
 * How long Auto should wait out a rate-limit block, and the epoch to persist
 * for next time.
 *
 * `epoch` is meant to live in chrome.storage.local rather than memory, so
 * restarting the browser or computer — the thing people reach for when a
 * wait feels stuck — resumes the backoff already in progress instead of
 * quietly resetting it to the floor and retrying a 24-hour lockout every five
 * minutes forever. `epoch.cooldownMs` is the wait that was just used, not the
 * next one — nextRateLimitWait derives the next step from it fresh each call.
 *
 * The ladder: 5, 10, 20, 40 min, 1h, 2h — that covers a block that clears
 * within a couple of hours, which is most of them. Once the 2h step has been
 * used and Instagram is *still* blocking, that is itself evidence of a longer
 * lockout, so later waits stop polling every two hours and instead aim at
 * RATE_LIMIT_ASSUMED_MS timed from the original block — how close the
 * *original* block is to that assumed window, not the block that just
 * happened. If that guess turns out wrong (still blocked once the assumed
 * window has passed), the window restarts from now rather than growing
 * without bound.
 */
export function nextRateLimitWait(epoch, now = Date.now()) {
  const lastSeen = epoch?.lastBlockedAt ?? epoch?.firstBlockedAt ?? -Infinity;
  const fresh = !epoch || now - lastSeen > RATE_LIMIT_STALE_AFTER_MS;

  let firstBlockedAt = fresh ? now : epoch.firstBlockedAt;
  const prevWait = fresh ? null : epoch.cooldownMs;

  let wait;
  if (prevWait === null) {
    wait = RATE_LIMIT_FLOOR_MS;
  } else if (prevWait < RATE_LIMIT_DOUBLING_CAP_MS) {
    wait = Math.min(prevWait * 2, RATE_LIMIT_DOUBLING_CAP_MS);
  } else if (prevWait < RATE_LIMIT_SECOND_CAP_MS) {
    wait = RATE_LIMIT_SECOND_CAP_MS;
  } else {
    const elapsed = now - firstBlockedAt;
    if (elapsed >= RATE_LIMIT_ASSUMED_MS) {
      firstBlockedAt = now;
      wait = RATE_LIMIT_ASSUMED_MS;
    } else {
      wait = Math.max(RATE_LIMIT_SECOND_CAP_MS, RATE_LIMIT_ASSUMED_MS - elapsed);
    }
  }

  return { wait, epoch: { firstBlockedAt, lastBlockedAt: now, cooldownMs: wait } };
}

/**
 * Record that a block just happened, without stepping the backoff ladder.
 *
 * For a halt outside Auto's own retry loop — a manual pause does not wait
 * anything out itself, so advancing cooldownMs on its behalf would misrepresent
 * how long Auto actually waited once it picks the episode back up. This only
 * keeps the episode's original time straight (and its staleness clock
 * ticking), which is what a banner elsewhere needs to say when the rate limit
 * now being reported first started.
 */
export function noteRateLimitBlock(epoch, now = Date.now()) {
  const lastSeen = epoch?.lastBlockedAt ?? epoch?.firstBlockedAt ?? -Infinity;
  const fresh = !epoch || now - lastSeen > RATE_LIMIT_STALE_AFTER_MS;
  const firstBlockedAt = fresh ? now : epoch.firstBlockedAt;
  const cooldownMs = fresh ? RATE_LIMIT_FLOOR_MS : epoch.cooldownMs;
  return { firstBlockedAt, epoch: { firstBlockedAt, lastBlockedAt: now, cooldownMs } };
}

/** "23:05:09" once past an hour, "5:09" under — the countdown reads as a
 * stopwatch either way instead of triple-digit minutes. */
export function formatCountdown(ms) {
  const totalSecs = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSecs / 3600);
  const mins = Math.floor((totalSecs % 3600) / 60);
  const secs = totalSecs % 60;
  const mm = String(mins).padStart(2, '0');
  const ss = String(secs).padStart(2, '0');
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mins}:${ss}`;
}

const sameLocalDay = (a, b) => {
  const x = new Date(a);
  const y = new Date(b);
  return x.getFullYear() === y.getFullYear()
    && x.getMonth() === y.getMonth()
    && x.getDate() === y.getDate();
};

/**
 * When a wait ends, named as a time rather than a length: "1:05 PM", or
 * "tomorrow at 9:20 AM" once the wait crosses midnight.
 *
 * A length is only true in the second it is written — "waiting 1 hour" still
 * says an hour forty minutes later — where a time stays true for the whole
 * wait and needs no redrawing. formatCountdown covers how much is left, at
 * stopwatch precision, for the meter that ticks alongside it.
 *
 * The day matters because a bare clock time a day out names an hour that
 * already went past today. Waits are capped at RATE_LIMIT_ASSUMED_MS, so
 * tomorrow is the furthest one can reach and no further label is needed.
 *
 * Takes the clock formatter rather than owning one: the locale-aware
 * Intl instance belongs with the rest of the panel's formatting.
 */
export function retryTimeLabel(at, formatTime, now = Date.now()) {
  const time = formatTime(at);
  return sameLocalDay(at, now) ? time : `tomorrow at ${time}`;
}
