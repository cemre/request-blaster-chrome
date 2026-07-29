import test from 'node:test';
import assert from 'node:assert/strict';

import {
  accountFileStem,
  candidatesFromLogEntries,
  normalizeMediaItem,
  pickThumbnailUrl,
  planSheets,
  safeFileStem,
  selectNotFollowedBack,
  toAccountRecord,
  unionCandidates,
} from '../src/harvest/model.js';
import { acceptedNotFollowed } from '../src/harvest/log.js';

test('selectNotFollowedBack keeps only followers the viewer does not follow', () => {
  const followers = [
    { pk: '1', username: 'alice' },
    { pk: '2', username: 'bob' },
    { pk: '3', username: 'carol' },
  ];
  const statuses = {
    1: { following: true },
    2: { following: false },
    3: { following: false, is_private: true },
  };

  const { candidates, unknown } = selectNotFollowedBack(followers, statuses);

  assert.deepEqual(candidates.map((u) => u.username), ['bob', 'carol']);
  assert.deepEqual(unknown, []);
});

test('selectNotFollowedBack quarantines followers with no status rather than guessing', () => {
  const followers = [{ pk: '1', username: 'alice' }, { pk: '2', username: 'bob' }];
  const statuses = { 1: { following: false } };

  const { candidates, unknown } = selectNotFollowedBack(followers, statuses);

  // bob has no status. Including him risks re-reviewing someone already
  // followed; silently dropping him hides a data gap. He goes to `unknown`
  // so the panel can report the count.
  assert.deepEqual(candidates.map((u) => u.username), ['alice']);
  assert.deepEqual(unknown.map((u) => u.username), ['bob']);
});

test('selectNotFollowedBack coerces a numeric pk to the string key statuses actually has', () => {
  // Object keys are always strings — `{ 12345: … }` and `{ '12345': … }` are
  // the same object — so this exercises the String(pk) coercion the lookup
  // depends on, not a string-vs-number branch, since there isn't one.
  const followers = [{ pk: 12345, username: 'alice' }];
  const { candidates } = selectNotFollowedBack(followers, { 12345: { following: true } });
  assert.deepEqual(candidates, []);
});

test('unionCandidates merges both sources and de-duplicates by pk', () => {
  const backlog = [
    { pk: '1', username: 'alice', full_name: 'Alice A' },
    { pk: '2', username: 'bob', full_name: 'Bob B' },
  ];
  const accepted = [
    { userId: '2', username: 'bob', at: 100 },
    { userId: '3', username: 'carol', at: 200 },
  ];

  const result = unionCandidates(backlog, accepted, new Set());

  assert.deepEqual(result.map((c) => c.pk), ['1', '2', '3']);
  // Someone in both sources is attributed to the backlog, which is the sweep
  // that found them without the log needing to have recorded anything.
  assert.deepEqual(result.map((c) => c.source), ['backlog', 'backlog', 'accepted-log']);
  assert.equal(result[2].acceptedAt, 200);
});

test('unionCandidates skips anyone already harvested, from either source', () => {
  const result = unionCandidates(
    [{ pk: '1', username: 'alice' }],
    [{ userId: '2', username: 'bob', at: 100 }],
    new Set(['1', '2']),
  );
  assert.deepEqual(result, []);
});

test('unionCandidates drops entries with no username to fetch by', () => {
  const result = unionCandidates(
    [{ pk: '1' }],
    [{ userId: '2', at: 100 }],
    new Set(),
  );
  assert.deepEqual(result, []);
});

test('pickThumbnailUrl takes the smallest candidate that still fills a cell', () => {
  const versions = { candidates: [
    { url: 'big', width: 1080, height: 1080 },
    { url: 'mid', width: 640, height: 640 },
    { url: 'small', width: 240, height: 240 },
  ] };
  // The sheet cell is ~312px, so 640 is the cheapest one that is not upscaled.
  assert.equal(pickThumbnailUrl(versions, 320), 'mid');
});

test('pickThumbnailUrl falls back to the largest when nothing is big enough', () => {
  const versions = { candidates: [
    { url: 'small', width: 150, height: 150 },
    { url: 'smaller', width: 100, height: 100 },
  ] };
  assert.equal(pickThumbnailUrl(versions, 320), 'small');
});

test('pickThumbnailUrl returns null rather than a broken url', () => {
  assert.equal(pickThumbnailUrl({ candidates: [] }, 320), null);
  assert.equal(pickThumbnailUrl(null, 320), null);
  assert.equal(pickThumbnailUrl({ candidates: [{ width: 0, url: 'x' }] }, 320), null);
});

test('pickThumbnailUrl handles the two-descending-run candidate list Instagram actually returns', () => {
  // Widths verified live against a real feed/user/ response, see
  // docs/follow-back/api-findings.md: the candidates array is two descending
  // runs (two crops of the same photo), not one globally sorted list.
  const widths = [1533, 1080, 720, 640, 480, 320, 240, 1080, 750, 640, 480, 320, 240, 150];
  const versions = { candidates: widths.map((width, i) => ({ url: `c${i}-${width}`, width, height: width })) };

  // The smallest candidate at least 320 wide is 320 itself, and it appears
  // twice (once per run) — the first one, from the first run, should win.
  assert.equal(pickThumbnailUrl(versions, 320), 'c5-320');
});

test('normalizeMediaItem maps a plain photo', () => {
  const item = {
    id: '111', taken_at: 1700000000, media_type: 1,
    caption: { text: 'tomatoes finally came in' },
    image_versions2: { candidates: [{ url: 'u', width: 640, height: 640 }] },
  };
  assert.deepEqual(normalizeMediaItem(item), {
    id: '111',
    takenAt: '2023-11-14T22:13:20.000Z',
    type: 'image',
    caption: 'tomatoes finally came in',
    url: 'u',
  });
});

test('normalizeMediaItem uses the cover frame for a video and badges it', () => {
  const item = {
    id: '222', taken_at: 1700000000, media_type: 2, caption: null,
    image_versions2: { candidates: [{ url: 'cover', width: 640, height: 800 }] },
  };
  const result = normalizeMediaItem(item);
  assert.equal(result.type, 'video');
  assert.equal(result.url, 'cover');
  assert.equal(result.caption, '');
});

test('normalizeMediaItem reaches into the first slide of a carousel', () => {
  const item = {
    id: '333', taken_at: 1700000000, media_type: 8,
    caption: { text: 'trip' },
    carousel_media: [
      { media_type: 1, image_versions2: { candidates: [{ url: 'slide1', width: 640, height: 640 }] } },
      { media_type: 1, image_versions2: { candidates: [{ url: 'slide2', width: 640, height: 640 }] } },
    ],
  };
  const result = normalizeMediaItem(item);
  assert.equal(result.type, 'carousel');
  assert.equal(result.url, 'slide1');
});

test('normalizeMediaItem returns null for an item with no usable image', () => {
  assert.equal(normalizeMediaItem({ id: '1', media_type: 1 }), null);
  assert.equal(normalizeMediaItem(null), null);
});

test('planSheets lays 50 photos out as two 5x5 sheets', () => {
  const sheets = planSheets(50);
  assert.equal(sheets.length, 2);
  assert.deepEqual(
    sheets.map((s) => [s.count, s.cols, s.rows, s.cell]),
    [[25, 5, 5, 312], [25, 5, 5, 312]],
  );
  // 312px per photo is the density where facial detail and photographic
  // quality stay legible after Claude downsamples to a 1568px long edge.
  assert.equal(sheets[0].width, 1560);
  assert.equal(sheets[0].height, 1560);
  assert.equal(sheets[1].start, 25);
});

test('planSheets shrinks the grid so a short feed keeps large cells', () => {
  const [sheet] = planSheets(9);
  assert.deepEqual([sheet.cols, sheet.rows, sheet.cell], [3, 3, 520]);
});

test('planSheets does not blow one leftover photo up to full width', () => {
  const sheets = planSheets(26);
  assert.equal(sheets.length, 2);
  assert.deepEqual([sheets[1].count, sheets[1].cols, sheets[1].cell], [1, 1, 520]);
});

test('planSheets caps at 50 photos even when more were fetched', () => {
  const sheets = planSheets(200);
  assert.equal(sheets.length, 2);
  assert.equal(sheets.reduce((sum, s) => sum + s.count, 0), 50);
});

test('planSheets returns nothing for an empty or negative feed', () => {
  assert.deepEqual(planSheets(0), []);
  assert.deepEqual(planSheets(-3), []);
});

test('planSheets leaves at most one partial row of holes', () => {
  const [sheet] = planSheets(7);
  assert.deepEqual([sheet.cols, sheet.rows], [3, 3]);
  assert.ok(sheet.cols * sheet.rows - sheet.count < sheet.cols);
});

test('safeFileStem refuses path traversal and stays recognizable', () => {
  assert.equal(safeFileStem('normal.user_1'), 'normal.user_1');
  assert.equal(safeFileStem('../../etc/passwd'), 'etc_passwd');
  assert.equal(safeFileStem('.hidden'), 'hidden');
  assert.equal(safeFileStem(''), 'unknown');
  assert.equal(safeFileStem(null), 'unknown');
});

test('accountFileStem keeps colliding usernames distinct once pks differ', () => {
  // shop, _shop, shop_ and .shop all sanitize to the same safeFileStem, but
  // they are four different real accounts.
  const stems = new Set([
    accountFileStem('shop', '1'),
    accountFileStem('_shop', '2'),
    accountFileStem('shop_', '3'),
    accountFileStem('.shop', '4'),
  ]);
  assert.equal(stems.size, 4);
});

test('accountFileStem keeps double-underscore collisions distinct too', () => {
  assert.notEqual(
    accountFileStem('user_name', '111'),
    accountFileStem('user__name', '222'),
  );
});

test('accountFileStem suffixes the sanitized username with the sanitized pk', () => {
  assert.equal(accountFileStem('shop', '17841400000000000'), 'shop-17841400000000000');
});

test('accountFileStem sanitizes a junk or missing pk into a usable filename', () => {
  assert.equal(accountFileStem('shop', '../../etc/passwd'), 'shop-etc_passwd');
  assert.equal(accountFileStem('shop', null), 'shop-unknown');
  assert.equal(accountFileStem('shop', undefined), 'shop-unknown');
  assert.equal(accountFileStem('shop', ''), 'shop-unknown');
});

test('toAccountRecord assembles what a review needs', () => {
  const record = toAccountRecord({
    candidate: { pk: '1', username: 'alice', fullName: 'Alice A', source: 'backlog', acceptedAt: null },
    profile: {
      username: 'alice', followers: 400, following: 300, posts: 60,
      bio: 'garden', mutualCount: 4, mutualNames: ['bob'],
      isPrivate: false, isVerified: false,
    },
    media: [
      { id: 'm1', takenAt: 't1', type: 'image', caption: 'tomatoes', url: 'u1' },
      { id: 'm2', takenAt: 't2', type: 'video', caption: '', url: 'u2' },
    ],
    plan: [{ index: 0, start: 0, count: 2, cols: 2, rows: 1, cell: 520, width: 1040, height: 520 }],
    sheetNames: ['alice-1.jpg'],
  });

  assert.equal(record.username, 'alice');
  assert.equal(record.source, 'backlog');
  assert.equal(record.followers, 400);
  assert.equal(record.reviewable, 'grid');
  assert.deepEqual(record.sheets, ['alice-1.jpg']);
  // Each caption is pinned to its tile so a review can say which photo it means.
  assert.deepEqual(
    record.media.map((m) => [m.caption, m.sheet, m.cell]),
    [['tomatoes', 1, 0], ['', 1, 1]],
  );
  // The CDN url is deliberately dropped — it expires, and the pixels are in
  // the sheet already.
  assert.equal('url' in record.media[0], false);
});

test('toAccountRecord treats a private account as reviewable on its profile alone', () => {
  // Roughly two thirds of a real backlog is private. There is no grid to be
  // had, but an avatar, a bio, counts and a full mutual list are plenty to
  // decide on — so this is a first-class outcome, not a failure.
  const record = toAccountRecord({
    candidate: { pk: '2', username: 'bob', fullName: '', source: 'accepted-log', acceptedAt: 5 },
    profile: {
      username: 'bob', followers: 3458, following: 5490, posts: 833,
      bio: '📍Minnesota\n📚 Book Nerd', mutualCount: 58, mutualNames: ['x', 'y', 'z'],
      isPrivate: true, isVerified: false,
    },
    sheetNames: [],
    avatarFile: 'bob-2-avatar.jpg',
    mutualNames: ['alice', 'carol', 'dave', 'erin'],
    category: 'Musician',
    externalUrl: 'https://example.com',
  });

  assert.equal(record.reviewable, 'profile-only');
  assert.equal(record.unreviewableReason, null);
  assert.equal(record.avatar, 'bob-2-avatar.jpg');
  assert.equal(record.bio, '📍Minnesota\n📚 Book Nerd');
  assert.equal(record.mutualCount, 58);
  // The fuller mutual_followers list wins over the three names
  // web_profile_info happens to carry.
  assert.deepEqual(record.mutualNames, ['alice', 'carol', 'dave', 'erin']);
  assert.equal(record.category, 'Musician');
  assert.deepEqual(record.sheets, []);
  assert.deepEqual(record.media, []);
});

test('toAccountRecord marks an account with nothing to look at', () => {
  const record = toAccountRecord({
    candidate: { pk: '3', username: 'gone', fullName: '', source: 'backlog', acceptedAt: null },
    profile: null,
    unreviewableReason: 'profile fetch failed',
  });

  assert.equal(record.reviewable, 'none');
  assert.equal(record.unreviewableReason, 'profile fetch failed');
  assert.equal(record.avatar, null);
  assert.deepEqual(record.sheets, []);
});

test('acceptedNotFollowed keeps accepts that never led to a follow', () => {
  const records = [
    { at: 100, userId: '1', username: 'alice', action: 'accept' },
    { at: 200, userId: '2', username: 'bob', action: 'acceptFollow' },
    { at: 300, userId: '3', username: 'carol', action: 'reject' },
    { at: 400, userId: '4', username: 'dave', action: 'accept' },
  ];

  // bob was followed as part of the accept, carol was never accepted.
  assert.deepEqual(
    acceptedNotFollowed(records).map((entry) => entry.username),
    ['alice', 'dave'],
  );
});

test('acceptedNotFollowed drops someone followed back later', () => {
  const records = [
    { at: 100, userId: '1', username: 'alice', action: 'accept' },
    { at: 500, userId: '1', username: 'alice', action: 'follow' },
  ];
  assert.deepEqual(acceptedNotFollowed(records), []);
});

test('acceptedNotFollowed reports one entry per person, at their first accept', () => {
  const records = [
    { at: 100, userId: '1', username: 'alice', action: 'accept' },
    { at: 300, userId: '1', username: 'alice', action: 'accept' },
  ];
  const result = acceptedNotFollowed(records);
  assert.equal(result.length, 1);
  assert.equal(result[0].at, 100);
});

test('acceptedNotFollowed excludes someone whose most recent decision was a reject', () => {
  const records = [
    { at: 100, userId: '1', username: 'alice', action: 'accept' },
    { at: 200, userId: '1', username: 'alice', action: 'reject' },
  ];
  assert.deepEqual(acceptedNotFollowed(records), []);
});

test('acceptedNotFollowed re-includes someone re-accepted after a reject, at the earliest accept', () => {
  const records = [
    { at: 100, userId: '1', username: 'alice', action: 'accept' },
    { at: 200, userId: '1', username: 'alice', action: 'reject' },
    { at: 300, userId: '1', username: 'alice', action: 'accept' },
  ];
  const result = acceptedNotFollowed(records);
  assert.equal(result.length, 1);
  assert.equal(result[0].username, 'alice');
  assert.equal(result[0].at, 100);
});

test('candidatesFromLogEntries turns ticked log rows into harvest candidates', () => {
  const entries = [
    { userId: '1', username: 'alice', at: 100, action: 'accept' },
    { userId: '2', username: 'bob', at: 200, action: 'acceptFollow' },
  ];

  assert.deepEqual(candidatesFromLogEntries(entries), [
    { pk: '1', username: 'alice', fullName: '', source: 'log-selection', acceptedAt: 100 },
    { pk: '2', username: 'bob', fullName: '', source: 'log-selection', acceptedAt: 200 },
  ]);
});

test('candidatesFromLogEntries collapses repeat actions on one person', () => {
  // The log holds one row per action, so ticking someone who was accepted and
  // later followed selects two rows for one account.
  const entries = [
    { userId: '1', username: 'alice', at: 300, action: 'follow' },
    { userId: '1', username: 'alice', at: 100, action: 'accept' },
  ];

  const result = candidatesFromLogEntries(entries);
  assert.equal(result.length, 1);
  assert.equal(result[0].acceptedAt, 100);
});

test('candidatesFromLogEntries drops rows with nothing to fetch by', () => {
  assert.deepEqual(candidatesFromLogEntries([{ userId: '1' }, { username: 'bob' }, {}]), []);
  assert.deepEqual(candidatesFromLogEntries(), []);
});
