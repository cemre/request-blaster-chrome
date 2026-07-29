// model.js — pure data transforms. No chrome.*, no DOM.
//
// Everything here is directly unit-testable under `node --test`.

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

export const DEFAULT_FILTERS = {
  onlyFollowing: false,
  minMutuals: 0,
  noMutuals: false,
  maxFollowers: null,
  zeroPosts: false,
  emptyBio: false,
  defaultPic: false,
  botRatio: false,
  search: '',
};

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
const ENRICHED_ONLY_FILTERS = ['maxFollowers', 'zeroPosts', 'emptyBio', 'botRatio', 'noMutuals'];

export function usesEnrichedFilters(filters) {
  return ENRICHED_ONLY_FILTERS.some((key) => {
    const value = filters[key];
    return key === 'maxFollowers' ? value !== null && value !== '' : Boolean(value);
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
  if (filters.minMutuals > 0) return true;
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
    if (filters.defaultPic && !row.defaultPic) return false;

    if (needle) {
      const haystack = `${row.username} ${row.fullName}`.toLowerCase();
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

    return true;
  });
}

/**
 * How many rows a mutuals threshold hid purely because their count is unknown.
 *
 * Counted against the set that clears every *other* active filter, so the
 * number the panel shows is the number that would come back by hydrating —
 * not a tally of rows something else had already removed.
 */
export function countHiddenByUnknownMutuals(rows, filters) {
  if (!(filters.minMutuals > 0)) return 0;
  return applyFilters(rows, { ...filters, minMutuals: 0 }).filter((row) => row.mutuals === null).length;
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
