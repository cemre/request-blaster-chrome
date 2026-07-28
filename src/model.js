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
    const approxMutuals = parseMutualCount(user.social_context);

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

    // Exact count once hydrated, the social_context estimate before that.
    row.mutuals = row.enriched && typeof row.exactMutuals === 'number' ? row.exactMutuals : approxMutuals;

    return row;
  });
}

export const DEFAULT_FILTERS = {
  onlyFollowing: false,
  minMutuals: 0,
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
// `defaultPic` is deliberately absent: has_anonymous_profile_picture ships
// with the pending list, so that filter works on every row for free.
const ENRICHED_ONLY_FILTERS = ['maxFollowers', 'zeroPosts', 'emptyBio', 'botRatio'];

export function usesEnrichedFilters(filters) {
  return ENRICHED_ONLY_FILTERS.some((key) => {
    const value = filters[key];
    return key === 'maxFollowers' ? value !== null && value !== '' : Boolean(value);
  });
}

export function applyFilters(rows, filters) {
  const needle = filters.search.trim().toLowerCase();
  const enrichedActive = usesEnrichedFilters(filters);

  return rows.filter((row) => {
    if (filters.onlyFollowing && !row.following) return false;
    if (filters.minMutuals > 0 && row.mutuals < filters.minMutuals) return false;
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

    return true;
  });
}

export const SORTS = {
  // Matches the existing extension's ordering: people you already follow first,
  // then by mutual count.
  default: (a, b) => {
    if (a.following !== b.following) return Number(b.following) - Number(a.following);
    if (a.mutuals !== b.mutuals) return b.mutuals - a.mutuals;
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
