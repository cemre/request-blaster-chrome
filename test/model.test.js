import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BOT_RATIO_MIN_FOLLOWING,
  DEFAULT_FILTERS,
  RATE_LIMIT_ASSUMED_MS,
  RATE_LIMIT_DOUBLING_CAP_MS,
  RATE_LIMIT_FLOOR_MS,
  RATE_LIMIT_SECOND_CAP_MS,
  applyFilters,
  approximateMutuals,
  countHiddenByUnknownMutuals,
  filtersActive,
  formatCount,
  formatCountdown,
  formatMutuals,
  formatShownCount,
  isBotRatio,
  isDefaultPic,
  mergeRows,
  mutualsBoundFromComparator,
  nextRateLimitWait,
  noteRateLimitBlock,
  parseMutualCount,
  parsePriorityHandles,
  rangeIds,
  retryTimeLabel,
  sortRows,
  splitByMutuals,
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
  // No social_context means Instagram told us nothing about mutuals — not that
  // there are none. Asserting 0 here is what let the panel invent a count.
  assert.equal(rows[1].mutuals, null);
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

// --------------------------------------------------- unknown vs zero mutuals
//
// Regression cover for the panel claiming "0 mutuals" about people the user
// demonstrably shared mutuals with. Measured against the live queue on
// 2026-07-28: of 200 pending requests only 73 carried a `social_context`
// string, and the other 127 omitted the field entirely. Reading that absence
// as zero made the panel assert a fact it had never checked, on the majority
// of every queue.

test('approximateMutuals separates "no data" from a real zero', () => {
  assert.equal(approximateMutuals('Followed by alice, bob + 3 more'), 5);
  assert.equal(approximateMutuals('Followed by alice'), 1);

  // Absent, empty or unrelated context is unknown — never zero.
  assert.equal(approximateMutuals(undefined), null, 'field absent on the API row');
  assert.equal(approximateMutuals(null), null);
  assert.equal(approximateMutuals(''), null);
  assert.equal(approximateMutuals('New to Instagram'), null);
  assert.equal(approximateMutuals(42), null);
});

test('mergeRows reports unknown mutuals as null, not zero', () => {
  // The two accounts from the bug report. Both arrived with no social_context
  // while their profile pages showed 2 and 17 mutuals respectively.
  const rows = mergeRows(
    [
      { pk: '90', username: 'usechede', full_name: 'Daniel Useche', is_private: true },
      { pk: '91', username: 'grnwave98', full_name: 'Toby Smith', is_private: true, social_context: null },
    ],
    {},
    {}
  );

  assert.equal(rows[0].mutuals, null);
  assert.equal(rows[1].mutuals, null);
  assert.equal(rows[0].approxMutuals, null);
});

test('mergeRows replaces an unknown count with the exact one on hydration', () => {
  const users = [{ pk: '90', username: 'usechede' }];
  assert.equal(mergeRows(users, {}, {})[0].mutuals, null);

  const cache = {
    90: { followers: 10900, following: 7985, posts: 293, bio: '', mutualCount: 2, mutualNames: ['batmaz13', 'ibinotyourhabibi'], isPrivate: true, isVerified: false, fetchedAt: Date.now() },
  };
  const hydrated = mergeRows(users, {}, cache)[0];
  assert.equal(hydrated.mutuals, 2);
  assert.equal(hydrated.enriched, true);
  assert.deepEqual(hydrated.mutualNames, ['batmaz13', 'ibinotyourhabibi']);
});

test('a hydrated zero stays a real zero', () => {
  const cache = {
    90: { followers: 5, following: 5, posts: 0, bio: '', mutualCount: 0, mutualNames: [], fetchedAt: Date.now() },
  };
  const row = mergeRows([{ pk: '90', username: 'nomutuals' }], {}, cache)[0];
  assert.equal(row.mutuals, 0, 'checked and confirmed zero, unlike an un-enriched null');
});

test('applyFilters: a mutuals threshold hides unknown counts rather than passing them off as zero', () => {
  const rows = mergeRows(
    [
      { pk: '1', username: 'known', social_context: 'Followed by x + 16 more' },
      { pk: '2', username: 'unknown' },
    ],
    {},
    {}
  );

  // The estimate still filters for free — that was the point of reading
  // social_context at all.
  assert.deepEqual(applyFilters(rows, { ...DEFAULT_FILTERS, minMutuals: 10 }).map((r) => r.id), ['1']);
  assert.deepEqual(applyFilters(rows, { ...DEFAULT_FILTERS, minMutuals: 1 }).map((r) => r.id), ['1']);
  // …and with no threshold set, nothing is hidden.
  assert.equal(applyFilters(rows, DEFAULT_FILTERS).length, 2);
});

test('countHiddenByUnknownMutuals reports only what the threshold actually hid', () => {
  const rows = mergeRows(
    [
      { pk: '1', username: 'known', social_context: 'Followed by x + 16 more' },
      { pk: '2', username: 'unknown' },
      { pk: '3', username: 'alsounknown' },
    ],
    {},
    {}
  );

  assert.equal(countHiddenByUnknownMutuals(rows, DEFAULT_FILTERS), 0, 'no threshold, nothing hidden');
  assert.equal(countHiddenByUnknownMutuals(rows, { ...DEFAULT_FILTERS, minMutuals: 1 }), 2);

  // Rows another filter already removed must not be double-counted here.
  assert.equal(
    countHiddenByUnknownMutuals(rows, { ...DEFAULT_FILTERS, minMutuals: 1, search: 'alsounknown' }),
    1
  );
});

test('splitByMutuals accepts at the threshold, rejects below it, leaves unknown alone', () => {
  const rows = mergeRows(
    [
      { pk: '1', username: 'atFloor', social_context: 'Followed by x + 4 more' }, // 5
      { pk: '2', username: 'overFloor', social_context: 'Followed by x + 9 more' }, // 10
      { pk: '3', username: 'underFloor', social_context: 'Followed by x' }, // 1
      { pk: '4', username: 'noHint' }, // null
    ],
    {},
    {}
  );

  const { accept, reject, unknown } = splitByMutuals(rows, 5);
  assert.deepEqual(accept.map((r) => r.username).sort(), ['atFloor', 'overFloor']);
  assert.deepEqual(reject.map((r) => r.username), ['underFloor']);
  assert.deepEqual(unknown.map((r) => r.username), ['noHint']);
});

test('parsePriorityHandles normalizes and dedupes free-typed handles', () => {
  assert.deepEqual(
    parsePriorityHandles('@Alice, bob/, alice,  , Carol'),
    ['alice', 'bob', 'carol']
  );
  assert.deepEqual(parsePriorityHandles(''), []);
  assert.deepEqual(parsePriorityHandles(null), []);
});

test('splitByMutuals accepts a below-threshold row that shares a priority mutual', () => {
  const rows = mergeRows(
    [
      { pk: '1', username: 'matched' },
      { pk: '2', username: 'unmatched' },
      { pk: '3', username: 'alreadyOver' },
      { pk: '4', username: 'noHint' },
    ],
    {},
    {
      1: { mutualCount: 2, mutualNames: ['dave', 'priorityfriend'] },
      2: { mutualCount: 2, mutualNames: ['dave', 'eve'] },
      3: { mutualCount: 10, mutualNames: ['dave'] },
    }
  );

  const priorityHandles = new Set(['priorityfriend']);
  const { accept, reject, unknown } = splitByMutuals(rows, 5, priorityHandles);

  assert.deepEqual(accept.map((r) => r.username).sort(), ['alreadyOver', 'matched']);
  assert.deepEqual(reject.map((r) => r.username), ['unmatched']);
  // An unenriched row has no mutual names to match against regardless of the
  // priority list, so it still lands in unknown rather than being rescued.
  assert.deepEqual(unknown.map((r) => r.username), ['noHint']);
});

test('formatMutuals keeps unknown, estimated and exact visibly apart', () => {
  assert.equal(formatMutuals({ mutuals: null, enriched: false }), '? mutuals');
  assert.equal(formatMutuals({ mutuals: undefined, enriched: false }), '? mutuals');
  assert.equal(formatMutuals({ mutuals: 17, enriched: false }), '~17 mutuals');
  assert.equal(formatMutuals({ mutuals: 1, enriched: false }), '~1 mutual');
  assert.equal(formatMutuals({ mutuals: 17, enriched: true }), '17 mutuals');
  assert.equal(formatMutuals({ mutuals: 1, enriched: true }), '1 mutual');
  // The only way to earn a bare zero is to have actually looked.
  assert.equal(formatMutuals({ mutuals: 0, enriched: true }), '0 mutuals');
});

test('the reported rows no longer claim a count Instagram never gave', () => {
  const rows = mergeRows(
    [
      { pk: '90', username: 'usechede', full_name: 'Daniel Useche', is_private: true },
      { pk: '91', username: 'grnwave98', full_name: 'Toby Smith', is_private: true, social_context: null },
    ],
    {},
    {}
  );

  assert.equal(formatMutuals(rows[0]), '? mutuals', 'was "0 mutuals" while the profile showed 2');
  assert.equal(formatMutuals(rows[1]), '? mutuals', 'was "0 mutuals" while the profile showed 17');
});

test('sortRows ranks an unknown count below known ones but above a confirmed zero', () => {
  const rows = mergeRows(
    [
      { pk: '1', username: 'unknown' },
      { pk: '2', username: 'confirmedzero' },
      { pk: '3', username: 'three', social_context: 'Followed by a, b, c' },
    ],
    {},
    { 2: { followers: 5, following: 5, posts: 0, bio: '', mutualCount: 0, mutualNames: [], fetchedAt: Date.now() } }
  );

  assert.deepEqual(sortRows(rows, 'default').map((r) => r.username), ['three', 'unknown', 'confirmedzero']);
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

test('applyFilters: an upper bound is the mirror of a lower one', () => {
  const rows = mergeRows(
    [
      { pk: '10', username: 'a', social_context: 'Followed by x + 186 more' },
      { pk: '11', username: 'b', social_context: 'Followed by x, y, z' },
      { pk: '12', username: 'c', social_context: 'Followed by x, y' },
      { pk: '13', username: 'unknown' },
    ],
    {},
    {}
  );
  assert.deepEqual(rows.map((r) => r.mutuals), [187, 3, 2, null]);

  // Inclusive, like minMutuals: the panel's "< 5" arrives here as 4.
  assert.deepEqual(applyFilters(rows, { ...DEFAULT_FILTERS, maxMutuals: 4 }).map((r) => r.id), ['11', '12']);
  assert.deepEqual(applyFilters(rows, { ...DEFAULT_FILTERS, maxMutuals: 2 }).map((r) => r.id), ['12']);

  // A ceiling of 0 is not "off" — the whole list is off by null alone.
  assert.deepEqual(applyFilters(rows, { ...DEFAULT_FILTERS, maxMutuals: 0 }).map((r) => r.id), []);
  assert.equal(applyFilters(rows, { ...DEFAULT_FILTERS, maxMutuals: null }).length, 4);
});

test('applyFilters: an unknown count cannot clear a ceiling either', () => {
  // Symmetric to the minimum: `null > n` is false, so an unfiltered null would
  // slide under every ceiling and read as "few mutuals" — the exact claim the
  // absent social_context does not support.
  const rows = mergeRows([{ pk: '1', username: 'unknown' }], {}, {});
  assert.equal(rows[0].mutuals, null);
  assert.equal(applyFilters(rows, { ...DEFAULT_FILTERS, maxMutuals: 4 }).length, 0);
});

test('a ceiling counts as a filter, and gets its unknowns reported', () => {
  const rows = mergeRows(
    [
      { pk: '1', username: 'known', social_context: 'Followed by x, y' },
      { pk: '2', username: 'unknown' },
    ],
    {},
    {}
  );

  assert.equal(filtersActive({ ...DEFAULT_FILTERS, maxMutuals: 4 }), true);
  assert.equal(filtersActive({ ...DEFAULT_FILTERS, maxMutuals: 0 }), true);
  assert.equal(filtersActive({ ...DEFAULT_FILTERS, maxMutuals: null }), false);

  // The estimate answers a ceiling for free, so this stays out of the
  // enriched-only group alongside minMutuals.
  assert.equal(usesEnrichedFilters({ ...DEFAULT_FILTERS, maxMutuals: 4 }), false);

  assert.equal(countHiddenByUnknownMutuals(rows, { ...DEFAULT_FILTERS, maxMutuals: 4 }), 1);
  assert.equal(countHiddenByUnknownMutuals(rows, DEFAULT_FILTERS), 0);
});

test('applyFilters: noMutuals only trusts an exact count', () => {
  // The hazard this filter is designed around: sampled against a live queue,
  // 128 of 200 pending users had no social_context and half of those actually
  // had mutuals. An absent hint is not a zero, and this filter feeds bulk
  // rejection, which cannot be undone.
  const users = [
    { pk: '1', username: 'genuinely_zero', social_context: null },
    { pk: '2', username: 'hint_missing_but_has_38', social_context: null },
    { pk: '3', username: 'hint_present', social_context: 'Followed by alice, bob' },
  ];
  const cache = {
    1: { followers: 5, following: 5, posts: 1, bio: '', mutualCount: 0, mutualNames: [], fetchedAt: Date.now() },
    3: { followers: 5, following: 5, posts: 1, bio: '', mutualCount: 2, mutualNames: [], fetchedAt: Date.now() },
  };
  const rows = mergeRows(users, {}, cache);

  // Row 2 is un-enriched with no hint at all. Its count now reads unknown
  // rather than 0 — the false zero this filter was built to defend against no
  // longer exists in the model. The gate below is the second line of defence.
  assert.equal(rows[1].mutuals, null);
  assert.equal(rows[1].enriched, false);

  const matched = applyFilters(rows, { ...DEFAULT_FILTERS, noMutuals: true });
  assert.deepEqual(matched.map((r) => r.username), ['genuinely_zero'],
    'an unknown count must not be selectable for rejection');
});

test('noMutuals is gated as an enriched-only filter', () => {
  assert.equal(usesEnrichedFilters({ ...DEFAULT_FILTERS, noMutuals: true }), true);
  assert.equal(usesEnrichedFilters({ ...DEFAULT_FILTERS, minMutuals: 5 }), false);
});

test('noMutuals and minMutuals stay independent', () => {
  const rows = mergeRows(pendingFixture, statusFixture, {});
  // Default minMutuals of 0 means "any" and must not imply "exactly zero".
  assert.equal(applyFilters(rows, { ...DEFAULT_FILTERS, minMutuals: 0 }).length, 3);
});

test('filtersActive answers "is the list short because of me?"', () => {
  assert.equal(filtersActive(DEFAULT_FILTERS), false);

  // Every key applyFilters can reject a row for, including the ones that only
  // bite once details are loaded — an empty view is still the filters' doing.
  assert.equal(filtersActive({ ...DEFAULT_FILTERS, onlyFollowing: true }), true);
  assert.equal(filtersActive({ ...DEFAULT_FILTERS, minMutuals: 5 }), true);
  assert.equal(filtersActive({ ...DEFAULT_FILTERS, noMutuals: true }), true);
  assert.equal(filtersActive({ ...DEFAULT_FILTERS, defaultPic: true }), true);
  assert.equal(filtersActive({ ...DEFAULT_FILTERS, maxFollowers: 0 }), true);
  assert.equal(filtersActive({ ...DEFAULT_FILTERS, zeroPosts: true }), true);
  assert.equal(filtersActive({ ...DEFAULT_FILTERS, emptyBio: true }), true);
  assert.equal(filtersActive({ ...DEFAULT_FILTERS, botRatio: true }), true);
  assert.equal(filtersActive({ ...DEFAULT_FILTERS, search: 'sarah' }), true);
});

test('filtersActive ignores what does not actually filter', () => {
  // minMutuals 0 is "any", and applyFilters trims a whitespace search away
  // before matching — offering to reset either would explain nothing.
  assert.equal(filtersActive({ ...DEFAULT_FILTERS, minMutuals: 0 }), false);
  assert.equal(filtersActive({ ...DEFAULT_FILTERS, search: '   ' }), false);
  assert.equal(filtersActive({ ...DEFAULT_FILTERS, maxFollowers: null }), false);
});

test('applyFilters: search covers username and full name, case-insensitively', () => {
  const rows = mergeRows(pendingFixture, statusFixture, {});
  assert.deepEqual(applyFilters(rows, { ...DEFAULT_FILTERS, search: 'SARAH' }).map((r) => r.id), ['1']);
  assert.deepEqual(applyFilters(rows, { ...DEFAULT_FILTERS, search: 'Mike' }).map((r) => r.id), ['3']);
  assert.deepEqual(applyFilters(rows, { ...DEFAULT_FILTERS, search: '  ' }).length, 3);
});

test('mutualsBoundFromComparator maps each comparator to applyFilters\'s own bound pair', () => {
  assert.deepEqual(mutualsBoundFromComparator('>', 5), { minMutuals: 6, maxMutuals: null });
  assert.deepEqual(mutualsBoundFromComparator('>=', 5), { minMutuals: 5, maxMutuals: null });
  assert.deepEqual(mutualsBoundFromComparator('<', 5), { minMutuals: 0, maxMutuals: 4 });
  assert.deepEqual(mutualsBoundFromComparator('<=', 5), { minMutuals: 0, maxMutuals: 5 });
  assert.deepEqual(mutualsBoundFromComparator('=', 5), { minMutuals: 5, maxMutuals: 5 });
});

test('applyFilters: mutualHandles matches a row sharing a mutual with a named handle', () => {
  const cache = {
    1: { followers: 1, following: 1, posts: 1, bio: '', mutualCount: 2, mutualNames: ['dave', 'priorityfriend'], fetchedAt: Date.now() },
    2: { followers: 1, following: 1, posts: 1, bio: '', mutualCount: 2, mutualNames: ['dave', 'eve'], fetchedAt: Date.now() },
  };
  const rows = mergeRows(pendingFixture, statusFixture, cache);
  // User 3 in pendingFixture never gets a cache entry, so it stays un-enriched.

  const filters = { ...DEFAULT_FILTERS, mutualHandles: ['priorityfriend'] };
  assert.deepEqual(applyFilters(rows, filters).map((r) => r.id), ['1']);
});

test('mutualHandles is an enriched-only filter, same as noMutuals', () => {
  assert.equal(usesEnrichedFilters({ ...DEFAULT_FILTERS, mutualHandles: [] }), false);
  assert.equal(usesEnrichedFilters({ ...DEFAULT_FILTERS, mutualHandles: ['alice'] }), true);
  assert.equal(filtersActive({ ...DEFAULT_FILTERS, mutualHandles: ['alice'] }), true);
  assert.equal(filtersActive({ ...DEFAULT_FILTERS, mutualHandles: [] }), false);
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

// ------------------------------------------------------------ range select

const ROWS = ['a', 'b', 'c', 'd', 'e'];

test('rangeIds covers the anchor, the clicked row, and everything between', () => {
  assert.deepEqual(rangeIds(ROWS, 'b', 'd'), ['b', 'c', 'd']);
});

test('rangeIds does not care which of the two came first on screen', () => {
  // Dragging a range upwards is the same gesture as dragging it down, so the
  // order is a fact about the list rather than about the two clicks.
  assert.deepEqual(rangeIds(ROWS, 'd', 'b'), ['b', 'c', 'd']);
});

test('rangeIds degrades to the clicked row alone when the anchor is unusable', () => {
  // A first click has no anchor; a repaint can take an existing one off screen.
  // Both are a plain click, which is what the caller then performs.
  assert.deepEqual(rangeIds(ROWS, null, 'c'), ['c']);
  assert.deepEqual(rangeIds(ROWS, 'gone', 'c'), ['c']);
});

test('rangeIds covers one row when the anchor is the row clicked', () => {
  assert.deepEqual(rangeIds(ROWS, 'c', 'c'), ['c']);
});

test('rangeIds covers nothing when the clicked row is not in the list', () => {
  // Not the anchor's fallback: there is no row to act on at all here, and
  // returning the id anyway would tick something the list does not contain.
  assert.deepEqual(rangeIds(ROWS, 'a', 'gone'), []);
  assert.deepEqual(rangeIds([], 'a', 'b'), []);
  assert.deepEqual(rangeIds(undefined, 'a', 'b'), []);
});

// ------------------------------------------------------------ rate limits

test('nextRateLimitWait starts a fresh episode at the floor', () => {
  const { wait, epoch } = nextRateLimitWait(null, 1_000_000);
  assert.equal(wait, RATE_LIMIT_FLOOR_MS);
  assert.deepEqual(epoch, {
    firstBlockedAt: 1_000_000,
    lastBlockedAt: 1_000_000,
    cooldownMs: RATE_LIMIT_FLOOR_MS,
  });
});

test('nextRateLimitWait climbs the ladder — 5, 10, 20, 40 min, 1h, 2h — before it ever projects toward 24h', () => {
  const t0 = 1_000_000;
  let epoch = null;
  const waits = [];
  let now = t0;
  for (let i = 0; i < 6; i += 1) {
    const result = nextRateLimitWait(epoch, now);
    waits.push(result.wait);
    epoch = result.epoch;
    now += result.wait; // pretend the wait actually elapsed before the next block
  }
  assert.deepEqual(waits, [
    RATE_LIMIT_FLOOR_MS,
    RATE_LIMIT_FLOOR_MS * 2,
    RATE_LIMIT_FLOOR_MS * 4,
    RATE_LIMIT_FLOOR_MS * 8,
    RATE_LIMIT_DOUBLING_CAP_MS,
    RATE_LIMIT_SECOND_CAP_MS,
  ]);
});

test('nextRateLimitWait survives a "restart" — a fresh call with the persisted epoch continues the ladder instead of resetting to the floor', () => {
  const t0 = 1_000_000;
  const afterFirstBlock = nextRateLimitWait(null, t0);
  // Simulate losing every in-memory variable except what got persisted, then
  // calling again as if this were a brand new runAutoTriage after a restart.
  const afterRestart = nextRateLimitWait(afterFirstBlock.epoch, t0 + afterFirstBlock.wait);
  assert.equal(afterRestart.wait, RATE_LIMIT_FLOOR_MS * 2);
  assert.notEqual(afterRestart.wait, RATE_LIMIT_FLOOR_MS);
});

test('nextRateLimitWait stays at the second cap once — the step the doubling cap alone used to skip — before projecting', () => {
  const t0 = 1_000_000;
  const epoch = {
    firstBlockedAt: t0,
    lastBlockedAt: t0 + 55 * 60 * 1000,
    cooldownMs: RATE_LIMIT_DOUBLING_CAP_MS,
  };
  const { wait, epoch: next } = nextRateLimitWait(epoch, t0 + 60 * 60 * 1000);
  assert.equal(wait, RATE_LIMIT_SECOND_CAP_MS);
  assert.equal(next.firstBlockedAt, t0);
});

test('nextRateLimitWait switches to time-projection once the second cap has been used and a block is still there', () => {
  const t0 = 1_000_000;
  const epoch = {
    firstBlockedAt: t0,
    lastBlockedAt: t0 + 4 * 60 * 60 * 1000,
    cooldownMs: RATE_LIMIT_SECOND_CAP_MS,
  };
  const now = t0 + 4.25 * 60 * 60 * 1000;
  const { wait, epoch: next } = nextRateLimitWait(epoch, now);
  // Aims at 24h from the *original* block, not another two hours from now.
  assert.equal(wait, RATE_LIMIT_ASSUMED_MS - (now - t0));
  assert.equal(next.firstBlockedAt, t0);
});

test('nextRateLimitWait never lets time-projection undercut the second cap', () => {
  const t0 = 1_000_000;
  const epoch = { firstBlockedAt: t0, lastBlockedAt: t0, cooldownMs: RATE_LIMIT_SECOND_CAP_MS };
  // Nearly 24h in already — projecting the remainder alone would be a wait
  // shorter than the cap, which would mean going *faster* than the ladder
  // just because the guess is about to run out.
  const now = t0 + RATE_LIMIT_ASSUMED_MS - 1000;
  const { wait } = nextRateLimitWait(epoch, now);
  assert.equal(wait, RATE_LIMIT_SECOND_CAP_MS);
});

test('nextRateLimitWait restarts the window from now once the 24h guess has elapsed and it is still blocked', () => {
  const t0 = 1_000_000;
  const epoch = { firstBlockedAt: t0, lastBlockedAt: t0, cooldownMs: RATE_LIMIT_SECOND_CAP_MS };
  const now = t0 + RATE_LIMIT_ASSUMED_MS + 60_000;
  const { wait, epoch: next } = nextRateLimitWait(epoch, now);
  assert.equal(wait, RATE_LIMIT_ASSUMED_MS);
  assert.equal(next.firstBlockedAt, now);
});

test('nextRateLimitWait treats a days-old epoch as unrelated rather than resuming it', () => {
  const t0 = 1_000_000;
  const epoch = { firstBlockedAt: t0, lastBlockedAt: t0, cooldownMs: RATE_LIMIT_ASSUMED_MS };
  const now = t0 + 3 * RATE_LIMIT_ASSUMED_MS; // days later — a separate block, not this episode
  const { wait, epoch: next } = nextRateLimitWait(epoch, now);
  assert.equal(wait, RATE_LIMIT_FLOOR_MS);
  assert.equal(next.firstBlockedAt, now);
});

test('formatCountdown reads as a stopwatch — M:SS under an hour, H:MM:SS past it', () => {
  assert.equal(formatCountdown(5 * 60 * 1000 + 9000), '5:09');
  assert.equal(formatCountdown(0), '0:00');
  assert.equal(formatCountdown(23 * 3600 * 1000 + 5 * 60 * 1000 + 9000), '23:05:09');
});

// A stand-in for the panel's Intl instance, so these assert the labelling and
// not en-US's punctuation.
const clock = (at) => new Date(at).toTimeString().slice(0, 5);

test('retryTimeLabel names a time within today with the clock alone', () => {
  const at = new Date(2026, 7, 9, 13, 5).getTime();
  const now = new Date(2026, 7, 9, 10, 31).getTime();
  assert.equal(retryTimeLabel(at, clock, now), '13:05');
});

test('retryTimeLabel says "tomorrow" once a wait crosses midnight — a bare clock time a day out names an hour that already went past', () => {
  const at = new Date(2026, 7, 10, 9, 20).getTime();
  const now = new Date(2026, 7, 9, 23, 40).getTime();
  assert.equal(retryTimeLabel(at, clock, now), 'tomorrow at 09:20');
});

test('retryTimeLabel goes by the calendar day, not by hours elapsed', () => {
  // Twenty minutes apart, but on either side of midnight: "00:05" alone would
  // read as five past midnight this morning, which is already behind us.
  const at = new Date(2026, 7, 10, 0, 5).getTime();
  const now = new Date(2026, 7, 9, 23, 45).getTime();
  assert.equal(retryTimeLabel(at, clock, now), 'tomorrow at 00:05');

  // And nearly a full day apart while still being the same date — the longest
  // wait the ladder allows, started just after midnight, still lands today.
  const sameDay = new Date(2026, 7, 9, 23, 55).getTime();
  assert.equal(retryTimeLabel(sameDay, clock, new Date(2026, 7, 9, 0, 5).getTime()), '23:55');
});

test('retryTimeLabel spans a month and a year boundary, where the date rolls but the day number drops', () => {
  const newYear = new Date(2027, 0, 1, 0, 30).getTime();
  assert.equal(
    retryTimeLabel(newYear, clock, new Date(2026, 11, 31, 23, 50).getTime()),
    'tomorrow at 00:30'
  );
});

test('noteRateLimitBlock records the episode start without stepping the ladder', () => {
  const t0 = 1_000_000;
  const { firstBlockedAt, epoch } = noteRateLimitBlock(null, t0);
  assert.equal(firstBlockedAt, t0);
  assert.deepEqual(epoch, { firstBlockedAt: t0, lastBlockedAt: t0, cooldownMs: RATE_LIMIT_FLOOR_MS });
});

test('noteRateLimitBlock leaves an in-progress ladder untouched, unlike nextRateLimitWait', () => {
  const t0 = 1_000_000;
  const epoch = { firstBlockedAt: t0, lastBlockedAt: t0, cooldownMs: RATE_LIMIT_SECOND_CAP_MS };
  const now = t0 + 10 * 60 * 1000;
  const result = noteRateLimitBlock(epoch, now);
  assert.equal(result.firstBlockedAt, t0);
  assert.equal(result.epoch.cooldownMs, RATE_LIMIT_SECOND_CAP_MS);
  assert.equal(result.epoch.lastBlockedAt, now);
});

test('noteRateLimitBlock treats a days-old epoch as unrelated, same as nextRateLimitWait', () => {
  const t0 = 1_000_000;
  const epoch = { firstBlockedAt: t0, lastBlockedAt: t0, cooldownMs: RATE_LIMIT_ASSUMED_MS };
  const now = t0 + 3 * RATE_LIMIT_ASSUMED_MS;
  const { firstBlockedAt, epoch: next } = noteRateLimitBlock(epoch, now);
  assert.equal(firstBlockedAt, now);
  assert.equal(next.cooldownMs, RATE_LIMIT_FLOOR_MS);
});
