import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BOT_RATIO_MIN_FOLLOWING,
  DEFAULT_FILTERS,
  applyFilters,
  formatCount,
  formatShownCount,
  isBotRatio,
  isDefaultPic,
  mergeRows,
  parseMutualCount,
  sortRows,
  toCachedProfile,
  usesEnrichedFilters,
} from '../src/model.js';

test('parseMutualCount handles the shapes Instagram actually returns', () => {
  assert.equal(parseMutualCount('Followed by alice'), 1);
  assert.equal(parseMutualCount('Followed by alice, bob'), 2);
  assert.equal(parseMutualCount('Followed by alice, bob + 3 more'), 5);
  assert.equal(parseMutualCount('Followed by alice + 12 more'), 13);
  assert.equal(parseMutualCount('Followed by alice, bob and 1,204 others'), 1206);
  assert.equal(parseMutualCount('Followed by alice and bob'), 2);
});

test('parseMutualCount refuses to count non-mutual social context', () => {
  assert.equal(parseMutualCount('New to Instagram'), 0);
  assert.equal(parseMutualCount(''), 0);
  assert.equal(parseMutualCount(null), 0);
  assert.equal(parseMutualCount(undefined), 0);
  assert.equal(parseMutualCount(42), 0);
});

test('isDefaultPic only fires on known default assets', () => {
  assert.equal(isDefaultPic('https://cdn.example/44884218_345707102882519_2446069589734326272_n.jpg'), true);
  assert.equal(isDefaultPic('https://instagram.com/static/images/anonymousUser.jpg'), true);
  assert.equal(isDefaultPic('https://cdn.example/real_photo.jpg'), false);
  assert.equal(isDefaultPic(null), false);
});

test('isBotRatio needs enrichment and both thresholds', () => {
  const base = { enriched: true, followingCount: BOT_RATIO_MIN_FOLLOWING, followers: 10 };
  assert.equal(isBotRatio(base), true);
  // High ratio but too few follows to be meaningful.
  assert.equal(isBotRatio({ enriched: true, followingCount: 500, followers: 1 }), false);
  // Plenty of follows but a healthy ratio.
  assert.equal(isBotRatio({ enriched: true, followingCount: 2000, followers: 1900 }), false);
  // Never guesses on un-enriched rows.
  assert.equal(isBotRatio({ ...base, enriched: false }), false);
});

test('isBotRatio does not divide by zero', () => {
  assert.equal(isBotRatio({ enriched: true, followingCount: 5000, followers: 0 }), true);
});

// Field names and types mirror a real friendships/pending/ response captured
// on 2026-07-28 — note pk arrives as a string.
const pendingFixture = [
  { pk: '1', username: 'sarah_k', full_name: 'Sarah Kim', profile_pic_url: 'a.jpg', social_context: 'Followed by alice, bob + 10 more', is_private: false, is_verified: true, has_anonymous_profile_picture: false },
  { pk: '2', username: 'randoacct', full_name: '', profile_pic_url: 'b.jpg', social_context: null, is_private: true, is_verified: false, has_anonymous_profile_picture: true },
  { pk: '3', username: 'mike', full_name: 'Mike', profile_pic_url: 'c.jpg', social_context: 'Followed by alice', is_private: false, is_verified: false, has_anonymous_profile_picture: false },
];

const statusFixture = { 1: { following: true }, 2: { following: false }, 3: { following: false } };

test('mergeRows combines bulk data and leaves un-enriched rows honest', () => {
  const rows = mergeRows(pendingFixture, statusFixture, {});

  assert.equal(rows.length, 3);
  assert.equal(rows[0].id, '1');
  assert.equal(rows[0].following, true);
  assert.equal(rows[0].mutuals, 12);
  assert.equal(rows[0].enriched, false);
  assert.equal(rows[0].followers, null);
  assert.equal(rows[1].mutuals, 0);
  assert.equal(rows[1].isPrivate, true);
});

test('mergeRows prefers the exact mutual count once hydrated', () => {
  const cache = {
    1: { followers: 1200, following: 300, posts: 88, bio: 'designer', mutualCount: 9, mutualNames: ['alice'], isPrivate: false, isVerified: true, isDefaultPic: false, fetchedAt: Date.now() },
  };
  const rows = mergeRows(pendingFixture, statusFixture, cache);

  assert.equal(rows[0].enriched, true);
  assert.equal(rows[0].mutuals, 9, 'exact count replaces the social_context estimate of 12');
  assert.equal(rows[0].followers, 1200);
  assert.deepEqual(rows[0].mutualNames, ['alice']);
  assert.equal(rows[1].enriched, false);
});

test('mergeRows tolerates numeric and string status keys', () => {
  const rows = mergeRows(pendingFixture, { '1': { following: true } }, {});
  assert.equal(rows[0].following, true);
});

test('applyFilters: relationship filters work on un-enriched rows', () => {
  const rows = mergeRows(pendingFixture, statusFixture, {});

  assert.deepEqual(
    applyFilters(rows, { ...DEFAULT_FILTERS, onlyFollowing: true }).map((r) => r.username),
    ['sarah_k']
  );
  assert.deepEqual(
    applyFilters(rows, { ...DEFAULT_FILTERS, minMutuals: 5 }).map((r) => r.username),
    ['sarah_k']
  );
  assert.deepEqual(
    applyFilters(rows, { ...DEFAULT_FILTERS, minMutuals: 1 }).map((r) => r.username),
    ['sarah_k', 'mike']
  );
});

test('applyFilters: high mutual thresholds', () => {
  // Real social_context counts run into the hundreds, hence the 50+/100+ steps.
  const busy = [
    { pk: '10', username: 'a', social_context: 'Followed by x + 186 more' },
    { pk: '11', username: 'b', social_context: 'Followed by x + 59 more' },
    { pk: '12', username: 'c', social_context: 'Followed by x, y' },
  ];
  const rows = mergeRows(busy, {}, {});
  assert.deepEqual(rows.map((r) => r.mutuals), [187, 60, 2]);

  assert.deepEqual(applyFilters(rows, { ...DEFAULT_FILTERS, minMutuals: 50 }).map((r) => r.id), ['10', '11']);
  assert.deepEqual(applyFilters(rows, { ...DEFAULT_FILTERS, minMutuals: 100 }).map((r) => r.id), ['10']);
});

test('applyFilters: search covers username and full name, case-insensitively', () => {
  const rows = mergeRows(pendingFixture, statusFixture, {});
  assert.deepEqual(applyFilters(rows, { ...DEFAULT_FILTERS, search: 'SARAH' }).map((r) => r.id), ['1']);
  assert.deepEqual(applyFilters(rows, { ...DEFAULT_FILTERS, search: 'Mike' }).map((r) => r.id), ['3']);
  assert.deepEqual(applyFilters(rows, { ...DEFAULT_FILTERS, search: '  ' }).length, 3);
});

test('applyFilters: spam filters exclude un-enriched rows rather than assuming', () => {
  const cache = {
    2: { followers: 3, following: 4000, posts: 0, bio: '', mutualCount: 0, mutualNames: [], fetchedAt: Date.now() },
  };
  const rows = mergeRows(pendingFixture, statusFixture, cache);

  // Only user 2 is enriched, so only user 2 can possibly match.
  assert.deepEqual(applyFilters(rows, { ...DEFAULT_FILTERS, maxFollowers: 10 }).map((r) => r.id), ['2']);
  assert.deepEqual(applyFilters(rows, { ...DEFAULT_FILTERS, zeroPosts: true }).map((r) => r.id), ['2']);
  assert.deepEqual(applyFilters(rows, { ...DEFAULT_FILTERS, emptyBio: true }).map((r) => r.id), ['2']);
  assert.deepEqual(applyFilters(rows, { ...DEFAULT_FILTERS, botRatio: true }).map((r) => r.id), ['2']);
});

test('defaultPic comes free from the pending list, no hydration required', () => {
  const rows = mergeRows(pendingFixture, statusFixture, {});

  assert.equal(rows[1].defaultPic, true);
  assert.equal(rows[0].defaultPic, false);
  assert.equal(rows[1].enriched, false, 'and it works while un-enriched');

  // So it must not drag un-enriched rows through the enriched-only gate.
  assert.equal(usesEnrichedFilters({ ...DEFAULT_FILTERS, defaultPic: true }), false);
  assert.deepEqual(applyFilters(rows, { ...DEFAULT_FILTERS, defaultPic: true }).map((r) => r.id), ['2']);
});

test('defaultPic falls back to URL matching when the field is absent', () => {
  const rows = mergeRows(
    [{ pk: '9', username: 'x', profile_pic_url: 'https://cdn/static/images/anonymousUser.jpg' }],
    {},
    {}
  );
  assert.equal(rows[0].defaultPic, true);
});

test('applyFilters: maxFollowers of 0 is a real filter, not "unset"', () => {
  const cache = {
    2: { followers: 0, following: 1, posts: 0, bio: '', mutualCount: 0, mutualNames: [], fetchedAt: Date.now() },
    3: { followers: 5, following: 1, posts: 1, bio: 'x', mutualCount: 1, mutualNames: [], fetchedAt: Date.now() },
  };
  const rows = mergeRows(pendingFixture, statusFixture, cache);
  assert.deepEqual(applyFilters(rows, { ...DEFAULT_FILTERS, maxFollowers: 0 }).map((r) => r.id), []);
  assert.deepEqual(applyFilters(rows, { ...DEFAULT_FILTERS, maxFollowers: 1 }).map((r) => r.id), ['2']);
});

test('usesEnrichedFilters distinguishes unset from zero', () => {
  assert.equal(usesEnrichedFilters(DEFAULT_FILTERS), false);
  assert.equal(usesEnrichedFilters({ ...DEFAULT_FILTERS, onlyFollowing: true, minMutuals: 5 }), false);
  assert.equal(usesEnrichedFilters({ ...DEFAULT_FILTERS, maxFollowers: 0 }), true);
  assert.equal(usesEnrichedFilters({ ...DEFAULT_FILTERS, maxFollowers: '' }), false);
  assert.equal(usesEnrichedFilters({ ...DEFAULT_FILTERS, botRatio: true }), true);
});

test('sortRows default: following first, then mutuals', () => {
  const rows = mergeRows(pendingFixture, statusFixture, {});
  assert.deepEqual(sortRows(rows, 'default').map((r) => r.username), ['sarah_k', 'mike', 'randoacct']);
});

test('sortRows newest preserves API order', () => {
  const rows = mergeRows(pendingFixture, statusFixture, {});
  assert.deepEqual(sortRows(rows, 'newest').map((r) => r.id), ['1', '2', '3']);
});

test('sortRows followers sinks un-enriched rows to the bottom', () => {
  const cache = {
    2: { followers: 50, following: 1, posts: 1, bio: '', mutualCount: 0, mutualNames: [], fetchedAt: Date.now() },
    3: { followers: 900, following: 1, posts: 1, bio: '', mutualCount: 0, mutualNames: [], fetchedAt: Date.now() },
  };
  const rows = mergeRows(pendingFixture, statusFixture, cache);
  assert.deepEqual(sortRows(rows, 'followers').map((r) => r.id), ['3', '2', '1']);
});

test('sortRows does not mutate its input', () => {
  const rows = mergeRows(pendingFixture, statusFixture, {});
  const before = rows.map((r) => r.id);
  sortRows(rows, 'default');
  assert.deepEqual(rows.map((r) => r.id), before);
});

test('toCachedProfile maps the web_profile_info shape', () => {
  const profile = toCachedProfile({
    data: {
      user: {
        username: 'mike',
        biography: 'nyc / film',
        edge_followed_by: { count: 1204 },
        edge_follow: { count: 300 },
        edge_owner_to_timeline_media: { count: 88 },
        edge_mutual_followed_by: { count: 4, edges: [{ node: { username: 'alice' } }, { node: { username: 'bob' } }] },
        is_private: false,
        is_verified: false,
        profile_pic_url: 'https://cdn.example/pic.jpg',
      },
    },
  });

  assert.equal(profile.followers, 1204);
  assert.equal(profile.following, 300);
  assert.equal(profile.posts, 88);
  assert.equal(profile.mutualCount, 4);
  assert.deepEqual(profile.mutualNames, ['alice', 'bob']);
  assert.equal(typeof profile.fetchedAt, 'number');
});

test('toCachedProfile survives a changed API shape', () => {
  assert.equal(toCachedProfile(null), null);
  assert.equal(toCachedProfile({}), null);
  assert.equal(toCachedProfile({ data: {} }), null);

  const sparse = toCachedProfile({ data: { user: { username: 'x' } } });
  assert.equal(sparse.followers, 0);
  assert.equal(sparse.mutualCount, 0);
  assert.deepEqual(sparse.mutualNames, []);
});

test('formatCount abbreviates the way a profile page does', () => {
  assert.equal(formatCount(0), '0');
  assert.equal(formatCount(999), '999');
  assert.equal(formatCount(1000), '1k');
  assert.equal(formatCount(1204), '1.2k');
  assert.equal(formatCount(12040), '12k');
  assert.equal(formatCount(1500000), '1.5m');
  assert.equal(formatCount(null), '—');
});

test('formatShownCount names the unit when the list is whole', () => {
  assert.equal(formatShownCount(199, 199), '199 requests');
  assert.equal(formatShownCount(1, 1), '1 request');
  assert.equal(formatShownCount(0, 0), '0 requests');
});

test('formatShownCount reports both numbers when a filter is narrowing the list', () => {
  assert.equal(formatShownCount(5, 199), '5 of 199');
  assert.equal(formatShownCount(0, 199), '0 of 199');
});
