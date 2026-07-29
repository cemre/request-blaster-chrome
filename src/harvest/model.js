// harvest/model.js — pure data transforms for the follow-back harvest. No
// chrome.*, no DOM.
//
// Split out of src/model.js so the harvest feature lives entirely under
// src/harvest/ and can be added or removed without touching shared code —
// see banner.js for the same pattern.

import { dayKey, dayKeyDate, dayLabel } from '../history.js';

/**
 * Split a followers list into those the viewer does not follow back and those
 * whose follow status is unknown.
 *
 * `show_many` should return a status for every id, so a miss means a data gap.
 * Those users go to `unknown` rather than being assumed either way — including
 * them wastes a harvest slot on someone already followed, and dropping them
 * silently hides the gap.
 */
export function selectNotFollowedBack(followers, statuses = {}) {
  const candidates = [];
  const unknown = [];

  for (const user of followers) {
    const status = statuses[String(user.pk)];
    if (!status) {
      unknown.push(user);
      continue;
    }
    if (status.following !== true) candidates.push(user);
  }

  return { candidates, unknown };
}

/**
 * Merge the two candidate sources into one de-duplicated harvest list.
 *
 * @param backlogUsers    raw follower objects from selectNotFollowedBack().candidates
 * @param acceptedEntries output of history.acceptedNotFollowed()
 * @param harvestedIds    Set of user ids already written to a previous batch
 */
export function unionCandidates(backlogUsers = [], acceptedEntries = [], harvestedIds = new Set()) {
  const byPk = new Map();

  for (const user of backlogUsers) {
    const pk = String(user.pk ?? '');
    if (!pk || !user.username || harvestedIds.has(pk)) continue;
    byPk.set(pk, {
      pk,
      username: user.username,
      fullName: user.full_name || '',
      source: 'backlog',
      acceptedAt: null,
    });
  }

  for (const entry of acceptedEntries) {
    const pk = String(entry.userId ?? '');
    if (!pk || !entry.username || harvestedIds.has(pk)) continue;
    if (byPk.has(pk)) continue; // backlog attribution wins
    byPk.set(pk, {
      pk,
      username: entry.username,
      fullName: '',
      source: 'accepted-log',
      acceptedAt: entry.at ?? null,
    });
  }

  return [...byPk.values()];
}

/**
 * Harvest candidates from log rows the user ticked in the panel.
 *
 * Deliberately does not consult `harvestedIds` or follow status the way
 * `unionCandidates` does: ticking a row is an explicit instruction, and it is
 * the only way to re-harvest someone whose grid has changed since an earlier
 * batch.
 */
export function candidatesFromLogEntries(entries = []) {
  const byPk = new Map();

  for (const entry of entries) {
    const pk = String(entry.userId ?? '');
    if (!pk || !entry.username) continue;

    // The log holds one row per action, so one person can arrive twice. Keep
    // the earliest, matching acceptedNotFollowed — a later row is the same
    // person, not a second candidate.
    const existing = byPk.get(pk);
    if (existing && (existing.acceptedAt ?? Infinity) <= (entry.at ?? Infinity)) continue;

    byPk.set(pk, {
      pk,
      username: entry.username,
      fullName: '',
      source: 'log-selection',
      acceptedAt: entry.at ?? null,
    });
  }

  return [...byPk.values()];
}

// ----------------------------------------------------------- harvested marks

/**
 * The set of accounts already written to a batch, whatever shape it is on disk.
 *
 * It began as a bare array of ids, which was enough while nothing but
 * `unionCandidates` read it. Now the log shows the mark, and a mark with no
 * date cannot answer the only question worth asking of it — is this old enough
 * to be worth redoing. So the stored shape is a record per account, and a
 * legacy array migrates to dated-nothing rather than being thrown away: those
 * accounts really were harvested, we just no longer know when. Inventing a date
 * here would stamp every one of them with whenever the migration ran.
 */
export function normalizeHarvested(stored) {
  const clean = {};

  if (Array.isArray(stored)) {
    for (const pk of stored) {
      const id = String(pk ?? '');
      if (id) clean[id] = { at: null, batchId: null };
    }
    return clean;
  }
  if (!stored || typeof stored !== 'object') return clean;

  for (const [pk, entry] of Object.entries(stored)) {
    if (!pk) continue;
    clean[pk] = {
      at: Number.isFinite(entry?.at) ? entry.at : null,
      batchId: typeof entry?.batchId === 'string' ? entry.batchId : null,
    };
  }
  return clean;
}

/**
 * How one harvested account reads on its log row.
 *
 * Dated through the log's own dayLabel rather than a second format invented for
 * one chip, so a row reading "Harvested yesterday" sits under a "Yesterday"
 * heading that agrees with it. Lower-cased, because it is a phrase here and a
 * heading there.
 */
export function harvestNote(entry, now = Date.now()) {
  if (!entry) return null;
  if (!Number.isFinite(entry.at)) return 'Harvested';

  const day = dayLabel(dayKeyDate(dayKey(entry.at)), now);
  const relative = day === 'Today' || day === 'Yesterday';
  return `Harvested ${relative ? day.toLowerCase() : day}`;
}

/** Every harvested account as `{ [pk]: note }`, ready for the panel's rows. */
export function harvestNotes(harvested = {}, now = Date.now()) {
  const notes = {};
  for (const [pk, entry] of Object.entries(harvested || {})) {
    const note = harvestNote(entry, now);
    if (note) notes[pk] = note;
  }
  return notes;
}

// How many recent posts a review looks at. Defined here rather than with the
// sheet geometry in Task 5 because fetchUserMedia needs it first.
export const MAX_PHOTOS = 50;

// The contact-sheet cell is ~312px at the densest layout, so anything wider
// than this is bytes spent on detail the composite throws away.
export const MIN_THUMB_WIDTH = 320;

/** Smallest candidate at least `minWidth` wide, else the largest available. */
export function pickThumbnailUrl(imageVersions, minWidth = MIN_THUMB_WIDTH) {
  const candidates = (imageVersions?.candidates || [])
    .filter((candidate) => candidate?.url && candidate.width > 0);
  if (candidates.length === 0) return null;

  // A tie resolves to array order: the response actually contains two
  // descending runs (two crops of the same photo), and drawCover center-crops
  // either to the same square, so it makes no difference which one wins.
  const ascending = [...candidates].sort((a, b) => a.width - b.width);
  const fit = ascending.find((candidate) => candidate.width >= minWidth);
  return (fit || ascending[ascending.length - 1]).url;
}

const MEDIA_KIND = { 1: 'image', 2: 'video', 8: 'carousel' };

/**
 * One feed item reduced to what a contact sheet and a review need.
 *
 * Returns null when there is no usable image, so callers filter rather than
 * render a hole: a video with no cover frame and a carousel with no slides
 * both hit this.
 */
export function normalizeMediaItem(item) {
  if (!item) return null;

  const type = MEDIA_KIND[item.media_type] || 'image';
  const source = type === 'carousel' ? (item.carousel_media?.[0] ?? null) : item;
  const url = pickThumbnailUrl(source?.image_versions2);
  if (!url) return null;

  return {
    id: String(item.id ?? item.pk ?? ''),
    takenAt: item.taken_at ? new Date(item.taken_at * 1000).toISOString() : null,
    type,
    caption: item.caption?.text ?? '',
    url,
  };
}

export const PHOTOS_PER_SHEET = 25;

// The header strip (HEADER_PX in sheet.js, 64px) pushes a full 5x5 sheet's
// long edge to 1624px, over Claude's ~1568px resize budget below. Left as is
// on purpose: the post-downsample cell this produces (~301px) is still larger
// than trimming the edge to fit under budget would give (1496px -> 299px
// cells), so shrinking SHEET_EDGE_PX to "fix" the overage is net negative.
export const SHEET_EDGE_PX = 1560;

// Claude's vision resizes an image to a ~1568px long edge, so detail per photo
// is a function of grid density, not source resolution. Capping the cell keeps
// a 1-photo sheet from becoming a pointless 1560px JPEG.
export const MAX_CELL_PX = 520;

/**
 * How to lay a feed out across contact sheets.
 *
 * @returns one entry per sheet: which slice of the media list it covers, its
 *   grid dimensions, and its pixel size. Empty when there is nothing to draw.
 */
export function planSheets(mediaCount, {
  perSheet = PHOTOS_PER_SHEET,
  maxPhotos = MAX_PHOTOS,
  edge = SHEET_EDGE_PX,
  maxCell = MAX_CELL_PX,
} = {}) {
  const total = Math.min(Math.max(mediaCount, 0), maxPhotos);
  if (total === 0) return [];

  const sheets = [];
  for (let start = 0; start < total; start += perSheet) {
    const count = Math.min(perSheet, total - start);
    const cols = Math.ceil(Math.sqrt(count));
    const rows = Math.ceil(count / cols);
    const cell = Math.min(Math.floor(edge / cols), maxCell);

    sheets.push({
      index: sheets.length,
      start,
      count,
      cols,
      rows,
      cell,
      width: cell * cols,
      height: cell * rows,
    });
  }

  return sheets;
}

/**
 * A username reduced to something safe to put in a download path.
 *
 * chrome.downloads rejects absolute paths and `..` segments outright, but a
 * rejected download is a lost account, so this normalizes rather than relying
 * on that.
 */
export function safeFileStem(username) {
  if (typeof username !== 'string') return 'unknown';
  const cleaned = username
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^[._]+/, '')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
  return cleaned || 'unknown';
}

/**
 * The download-path stem for one account: sanitized username plus its
 * Instagram id.
 *
 * safeFileStem is lossy by design (it folds punctuation into `_`), so
 * distinct real usernames — `shop`, `_shop`, `shop_`, `.shop` — can sanitize
 * to the same string. Downloads overwrite same-named files, so a collision
 * here is not a cosmetic clash, it is one account's data silently replacing
 * another's. The pk is unique per account and never collides, so suffixing
 * it turns that into a non-issue regardless of how usernames sanitize. The
 * pk itself comes from the API and isn't guaranteed to be digits, so it goes
 * through safeFileStem too.
 */
export function accountFileStem(username, pk) {
  return `${safeFileStem(username)}-${safeFileStem(String(pk ?? ''))}`;
}

/**
 * The per-account JSON written beside the contact sheets.
 *
 * Media entries carry their sheet and cell index so a review can tie a caption
 * to a specific tile. The CDN url is dropped: it expires within days and the
 * pixels are already in the sheet.
 *
 * @param pk resolved account id — defaults to candidate.pk, but callers that
 *   have resolved a possibly-different id via web_profile_info (a renamed or
 *   merged account) must pass it, since it is what the filename is built from.
 * @param failedIds media item ids whose thumbnail fetch failed — drawn as a
 *   blank tile, so the record has to say so rather than silently pairing a
 *   caption with a hole.
 */
export function toAccountRecord({
  candidate,
  pk = candidate.pk,
  profile,
  media = [],
  plan = [],
  sheetNames = [],
  avatarFile = null,
  mutualNames = null,
  category = null,
  externalUrl = null,
  defaultAvatar = false,
  failedIds = [],
  unreviewableReason = null,
}) {
  const failed = new Set(failedIds);
  const placed = media.map((item, index) => {
    const sheet = plan.find((s) => index >= s.start && index < s.start + s.count);
    return {
      id: item.id,
      takenAt: item.takenAt,
      type: item.type,
      caption: item.caption,
      sheet: sheet ? sheet.index + 1 : null,
      cell: sheet ? index - sheet.start : null,
      thumbnailFailed: failed.has(item.id),
    };
  });

  return {
    pk: String(pk),
    username: candidate.username,
    fullName: candidate.fullName || '',
    source: candidate.source,
    acceptedAt: candidate.acceptedAt ?? null,

    isPrivate: profile?.isPrivate ?? false,
    isVerified: profile?.isVerified ?? false,
    followers: profile?.followers ?? null,
    following: profile?.following ?? null,
    posts: profile?.posts ?? null,
    bio: profile?.bio ?? '',
    category,
    externalUrl,
    defaultAvatar,
    mutualCount: profile?.mutualCount ?? null,
    // The fuller list from friendships/{pk}/mutual_followers/ when the caller
    // fetched it, otherwise the three names web_profile_info happens to carry.
    mutualNames: mutualNames ?? profile?.mutualNames ?? [],

    media: placed,
    sheets: sheetNames,
    avatar: avatarFile,

    // What a reviewer can actually go on, rather than a bare "insufficient"
    // that lumps a private account together with a deleted one:
    //   grid          — contact sheets of their posts
    //   profile-only  — no grid, but an avatar, a bio, counts and mutuals.
    //                   Roughly two thirds of a real backlog lands here, so it
    //                   is a first-class outcome, not a failure.
    //   none          — nothing worth looking at; unreviewableReason says why.
    reviewable: unreviewableReason ? 'none' : (sheetNames.length ? 'grid' : 'profile-only'),
    unreviewableReason,
    harvestedAt: new Date().toISOString(),
  };
}
