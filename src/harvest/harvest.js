// harvest.js — turns a candidate list into a batch folder on disk.

import { call, fetchFollowStatuses } from '../api.js';
import { toCachedProfile } from '../model.js';
import { ThrottledQueue, PACING } from '../queue.js';
import { fetchAllFollowers, fetchMutualFollowers, fetchUserMedia } from './api.js';
import { newBatchId, suppressDownloadUi, writeBlob, writeJson } from './batch.js';
import { acceptedNotFollowed } from './log.js';
import {
  MAX_PHOTOS, accountFileStem, planSheets, selectNotFollowedBack,
  toAccountRecord, unionCandidates,
} from './model.js';
import { fetchImageBlob, renderSheets } from './sheet.js';
import { loadAllLogRecords, loadHarvested, markHarvested } from './store.js';

/**
 * Both candidate sources, unioned and de-duplicated.
 *
 * **Nothing calls this.** It backed an "All followers" toggle in the harvest
 * row, which has been removed: sweeping every follower and harvesting the lot is
 * not a realistic unit of work. It costs a full follower sweep plus a
 * `show_many` pass before the user has confirmed anything, it hits
 * `fetchAllFollowers`'s page cap on exactly the accounts big enough to want it,
 * and what it then plans is a run of thousands behind a single confirm. The
 * replacement is batches of ~50, which is a different shape — paged rather than
 * exhaustive — so this is kept as the statement of what the two sources are and
 * how they combine, not as code to switch back on unchanged.
 *
 * Its parts are all still live and still tested: `selectNotFollowedBack`,
 * `unionCandidates` and `acceptedNotFollowed`.
 *
 * @returns candidates and unknown as before, plus `capped`: true when the
 *   follower sweep hit fetchAllFollowers's page cap, meaning the backlog is
 *   truncated rather than complete — the caller has to say so rather than
 *   quietly harvesting a partial list.
 */
export async function collectCandidates(onProgress = () => {}) {
  onProgress({ phase: 'followers', message: 'Loading followers…' });
  const { users, capped } = await fetchAllFollowers(({ total }) =>
    onProgress({ phase: 'followers', message: `Loaded ${total} followers…` }));

  onProgress({ phase: 'statuses', message: `Checking follow status for ${users.length}…` });
  const statuses = await fetchFollowStatuses(users.map((user) => String(user.pk)), ({ done, total }) =>
    onProgress({ phase: 'statuses', message: `Checked ${done} / ${total}…` }));

  const { candidates: backlog, unknown } = selectNotFollowedBack(users, statuses);
  const [records, harvested] = await Promise.all([loadAllLogRecords(), loadHarvested()]);
  const candidates = unionCandidates(
    backlog, acceptedNotFollowed(records), new Set(Object.keys(harvested))
  );

  onProgress({ phase: 'ready', message: `${candidates.length} to harvest.` });
  return { candidates, unknown, capped };
}

/**
 * One account: profile, feed, sheets, files. Returns the queue-handler envelope
 * so a rate-limit response halts the whole run.
 *
 * Every branch returns the same shape: `{ ok, pk, files, reviewable,
 * unreviewableReason, error }` (plus `sheets` on a full success), so the
 * caller can build the index row from the result alone rather than
 * re-deriving what happened. `pk` is always the id the filename was actually
 * built from — candidate.pk until a profile resolves, the resolved id after —
 * so nothing downstream has to guess which one a given file stem used.
 */
async function harvestOne(candidate, batchId) {
  const profileResult = await call('profile', { username: candidate.username });

  // Instagram pushing back has to halt the whole run, not just this account, so
  // it goes back unchanged for ThrottledQueue's halt check to see.
  if (profileResult?.blocked || profileResult?.loggedOut) return profileResult;

  // web_profile_info fails on its own sometimes — a real batch hit "Asset
  // asset://laser.provider/... has been deleted" on one account. That costs the
  // bio, counts, mutuals and avatar, but it must not cost the photos: feed/user
  // needs only a pk, and the followers list already supplied one. So carry on
  // with whatever came back rather than writing the account off.
  const profileOk = Boolean(profileResult?.ok);
  const profileError = profileOk ? null : (profileResult?.error || 'profile fetch failed');
  const profile = profileOk ? toCachedProfile(profileResult.data) : null;

  // toCachedProfile shapes rows for the profileCache and carries neither the
  // user id nor an avatar url. Read those off the raw response rather than
  // widening a schema the panel already depends on. web_profile_info is the
  // authority on which account a username actually resolves to, so its id wins
  // over the one the followers list supplied — and every write below (file
  // stem, record, markHarvested) uses this resolved `pk`, never candidate.pk,
  // so a renamed or merged account cannot end up with a filename and an index
  // row that disagree on which id they belong to.
  const igUser = profileOk ? (profileResult.data?.data?.user || {}) : {};
  const pk = igUser.id || candidate.pk;
  const avatarUrl = igUser.profile_pic_url_hd || igUser.profile_pic_url || '';
  const stem = accountFileStem(candidate.username, pk);

  // Everyone gets their profile picture written as its own file. For a grid
  // account it anchors "what does this person look like" when the posts are
  // all landscapes; for a private one it is the only photograph that exists.
  // Full size, not the 48px the sheet header shrinks it to.
  const profileExtras = {
    category: igUser.category_name || null,
    externalUrl: igUser.external_url || null,
    defaultAvatar: Boolean(igUser.has_anonymous_profile_picture),
  };
  let avatarFile = null;
  if (avatarUrl && !profileExtras.defaultAvatar) {
    const avatarBlob = await fetchImageBlob(avatarUrl);
    if (avatarBlob) {
      avatarFile = `${stem}-avatar.jpg`;
      await writeBlob({ batchId, name: avatarFile, blob: avatarBlob });
    }
  }

  /**
   * Everything an account with no grid still offers: avatar, bio, counts and
   * the full mutual list. Two paths reach this — no grid to fetch, and a feed
   * that came back empty — and they differ only in what to say when even this
   * yields nothing.
   */
  const writeProfileOnly = async (emptyReason) => {
    const mutualNames = await fetchMutualFollowers(pk);
    const name = `${stem}.json`;
    await writeJson({
      batchId, name,
      value: toAccountRecord({ candidate, pk, profile, avatarFile, mutualNames, ...profileExtras }),
    });
    await markHarvested(pk, { batchId, alias: candidate.pk });

    const files = avatarFile ? [name, avatarFile] : [name];
    // Nothing to look at at all: no photo and no words.
    const reviewable = (avatarFile || profile?.bio) ? 'profile-only' : 'none';
    return {
      ok: !profileError, pk, files, reviewable,
      unreviewableReason: reviewable === 'none' ? emptyReason : null,
      error: profileError,
    };
  };

  // No grid to be had — private, or public with nothing posted. Previously
  // written off as "insufficient", which lumped two thirds of a real backlog in
  // with deleted accounts. There is plenty to judge on: an avatar, a bio
  // (private bios are often the richest interest signal available), counts, and
  // the full mutual list, which is worth its extra request precisely because
  // these accounts have so little else.
  //
  // Both facts come only from a profile, so a failed one establishes neither and
  // must not be read as "no posts". Without a profile the shortcut is skipped
  // and the feed decides, at the cost of one request.
  const noGrid = profile?.isPrivate ? 'private'
    : (profileOk && (profile?.posts ?? 0) === 0) ? 'no posts'
    : null;
  if (noGrid) return writeProfileOnly(`${noGrid}, no avatar or bio`);

  const media = await fetchUserMedia(pk, MAX_PHOTOS);
  if (media.length === 0) return writeProfileOnly(profileError || 'no media returned');

  const plan = planSheets(media.length);
  const { blobs, failedIds } = await renderSheets({
    media, plan,
    header: { username: candidate.username, avatarUrl },
  });

  const sheetNames = blobs.map((_, index) => `${stem}-${index + 1}.jpg`);
  for (let index = 0; index < blobs.length; index += 1) {
    await writeBlob({ batchId, name: sheetNames[index], blob: blobs[index] });
  }
  const jsonName = `${stem}.json`;
  await writeJson({
    batchId, name: jsonName,
    value: toAccountRecord({
      candidate, pk, profile, media, plan, sheetNames, failedIds, avatarFile, ...profileExtras,
    }),
  });
  await markHarvested(pk, { batchId, alias: candidate.pk });

  return {
    ok: true, pk, files: [jsonName, ...sheetNames, ...(avatarFile ? [avatarFile] : [])],
    reviewable: 'grid', unreviewableReason: null,
    // Non-null when the photos landed but the metadata did not. The record's
    // empty bio and null counts show it too, but the index should say so
    // without needing every per-account file opened.
    error: profileError,
    sheets: sheetNames.length,
  };
}

/**
 * Start a harvest. Returns immediately with the queue so the caller can stop it.
 *
 * Paced like hydration rather than like writes: these are reads, but a few
 * hundred of them back to back is still worth spacing out.
 */
export async function runHarvest({ candidates, onProgress = () => {}, onFinish = () => {} }) {
  const batchId = newBatchId();
  const index = { batchId, generatedAt: new Date().toISOString(), accounts: [] };

  // A real run is ~1200 accounts at hydration pacing plus up to 50 sequential
  // image fetches each — hours, not minutes. Closing the panel mid-run is the
  // expected path, so index.json has to exist for whatever is on disk at any
  // point, not just at a clean finish.
  const writeIndex = (extra = {}) => writeJson({
    batchId, name: 'index.json',
    value: { ...index, done: index.accounts.length, total: candidates.length, ...extra },
  });

  const queue = new ThrottledQueue({
    items: candidates,
    pacing: PACING.hydration,
    handler: async (candidate) => {
      // `finally` rather than pushing after a plain await: a throw out of
      // harvestOne (a blocked feed, writeBlob's 30s timeout, a canvas
      // failure) must not make the account vanish from the index — sheets
      // may already be on disk for it, and the index is supposed to be a
      // truthful record of exactly what made it to disk. The throw itself
      // still propagates after this runs, so ThrottledQueue's halt check
      // still sees it.
      let result;
      let caught = null;
      try {
        result = await harvestOne(candidate, batchId);
        return result;
      } catch (err) {
        caught = err;
        throw err;
      } finally {
        index.accounts.push({
          pk: result?.pk ?? candidate.pk,
          username: candidate.username,
          source: candidate.source,
          files: result?.files ?? [],
          reviewable: result?.reviewable ?? 'none',
          unreviewableReason: result?.unreviewableReason ?? null,
          // Not gated on `ok`: an account can succeed at photos and still carry
          // a profile-fetch error worth recording.
          error: result?.error ?? (result?.ok ? null : (caught ? String(caught) : 'failed')),
        });
        if (index.accounts.length % 10 === 0) await writeIndex();
      }
    },
    onProgress,
    onFinish: async (summary) => {
      const tally = (key) => index.accounts.reduce((counts, row) => {
        counts[row[key]] = (counts[row[key]] || 0) + 1;
        return counts;
      }, {});
      const sourceCounts = tally('source');
      // How much there is to look at, not just how many rows there are. Most
      // of a real backlog comes back profile-only, and that has to read as a
      // result rather than as a wall of failures.
      const reviewableCounts = tally('reviewable');
      // Written last so a stopped or halted run still leaves a final,
      // complete-as-of-the-halt record — the periodic writes above cover
      // everything before that.
      await writeIndex({
        halted: summary.halted, stopped: summary.stopped, sourceCounts, reviewableCounts,
      });
      await suppressDownloadUi(false);
      onFinish({ ...summary, batchId, reviewableCounts });
    },
  });

  await suppressDownloadUi(true);

  // Write the index before a single account runs. Every account writes files,
  // so a writer that cannot write is a precondition failure, not a per-account
  // one — and letting it surface here is the difference between "this failed
  // immediately, here is why" and a run that grinds through a thousand
  // accounts, fails every one silently, and reports success having written
  // nothing. Failing to restore the download UI on the way out would leave it
  // suppressed browser-wide.
  try {
    await writeIndex();
  } catch (err) {
    await suppressDownloadUi(false);
    throw new Error(`Cannot write to the Downloads folder: ${err.message}`);
  }

  queue.run();
  return { queue, batchId };
}
