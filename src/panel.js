// panel.js — side panel wiring.
//
// Owns all state and both throttle queues. Being a real document, it stays
// alive as long as the panel is open, which is exactly as long as any of this
// work should be running.

import * as anon from './anon.js';
import * as api from './api.js';
import * as history from './history.js';
import * as store from './store.js';
// #region harvest — build.js deletes this region from the store package
import { mountHarvest } from './harvest/mount.js';
// #endregion harvest
import { PACING, ThrottledQueue } from './queue.js';
import { ListRenderer, renderLog } from './render.js';
import {
  DEFAULT_FILTERS,
  applyFilters,
  countHiddenByUnknownMutuals,
  filtersActive,
  formatShownCount,
  mergeRows,
  sortRows,
  toCachedProfile,
  usesEnrichedFilters,
} from './model.js';

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The three things you can do to a selection. `approveFollow` is two writes
 * against Instagram, not one — see actOnce.
 */
const ACTIONS = {
  approve: { op: 'approve', label: 'Accept', busy: 'Accepting…', done: 'Accepted', gerund: 'Accepting' },
  approveFollow: { op: 'approve', label: 'Accept + follow', busy: 'Accepting…', done: 'Accepted + followed', gerund: 'Accepting' },
  ignore: { op: 'ignore', label: 'Reject', busy: 'Rejecting…', done: 'Rejected', gerund: 'Rejecting' },
};

const BULK_BUTTONS = {
  'bulk-accept': 'approve',
  'bulk-accept-follow': 'approveFollow',
  'bulk-reject': 'ignore',
};

/** Day shards pulled per "Load older" click. */
const LOG_PAGE_DAYS = 14;

/**
 * The filters behind the Spam chip. `defaultPic` comes off the pending list
 * itself so it works on every row; the rest need hydration and match nothing
 * until details load. They share a chip, not a meaning.
 */
const SPAM_FILTER_KEYS = ['defaultPic', 'maxFollowers', 'zeroPosts', 'emptyBio', 'botRatio'];

const state = {
  settings: { ...store.DEFAULT_SETTINGS },
  pendingUsers: [],
  statuses: {},
  cache: {},
  rows: [],
  visible: [],
  selected: new Set(),
  doneIds: new Set(),
  filters: { ...DEFAULT_FILTERS },
  capped: false,
  hydrationQueue: null,
  actionQueue: null,
  // A run owned by a feature outside this file, handed in as a controller
  // through mountHarvest's options (see externalRun below). Named for what it
  // is, not for whichever feature currently happens to be the only one using
  // it, so this file never has to learn a second name the day another feature
  // wants the same seam.
  externalQueue: null,
  // What each queue is doing. Null whenever that queue is not running. All three
  // are held because they are independent and can overlap — you can start a bulk
  // accept while details are still loading, or while an external run reads in
  // the background.
  //
  // They do not all report to the same place. Hydration owns the header slot
  // outright; the action queue and an external run share the toolbar, which is
  // what activeRun arbitrates. That is also why hydration alone carries no
  // label: the toolbar's two have several gerunds between them and must say
  // which is running, while hydration has one, spelled in the markup so CSS can
  // drop it at narrow widths.
  hydrationProgress: null,  // { done, total }
  actionProgress: null,     // { label, done, total }
  externalProgress: null,   // { label, done, total }
  loading: false,

  // 'requests' | 'log'. The log is loaded lazily and only ever holds the day
  // shards actually asked for.
  mode: 'requests',
  log: {
    // Separate from `loadedDays` because an empty log loads zero shards and is
    // still loaded. Everything that asks "do we already hold the log" means
    // this; only the paging arithmetic means the count.
    loaded: false,
    index: [],
    loadedDays: 0,
    records: [],
    // Keys of the records already in `records`, so a shard re-delivered by a
    // storage change lands once. See absorbLogRecords.
    seen: new Set(),
    visible: [],
    followable: [],
    // Followable ids minus the noted ones — what select-all acts on. Derived in
    // recomputeLog rather than at each use, because two places need it and they
    // used to disagree about what "all" meant.
    selectable: [],
    // `{ [userId]: note }` from an outside feature, via the skipNotes seam
    // below. A noted row shows the note and is left out of `selectable`.
    skipNotes: {},
    selected: new Set(),
    kind: 'all',
    search: '',
  },
};

let renderer;

/** How long a finished-run message stays on screen. See setStatus. */
const STATUS_LINGER = 6000;
let statusTimer;

// ---------------------------------------------------------------- messaging

/** 'loading' | 'ready' | 'error' — CSS gates the working UI on this. */
function setState(next) {
  document.body.dataset.state = next;
}

/**
 * A run just ended and here is how it went. Clears itself: it reports an event,
 * not a state, and the moment the list has moved on it is describing something
 * that is no longer on screen. Left standing it becomes a caption over a list it
 * no longer matches — and what it says is in the log anyway.
 */
function setStatus(text) {
  clearTimeout(statusTimer);
  $('status').textContent = text || '';
  if (text) statusTimer = setTimeout(() => { $('status').textContent = ''; }, STATUS_LINGER);
}

/** Progress line inside the loading block, so it's visible before the UI is. */
function setLoadingText(text) {
  $('loading-text').textContent = text;
}

function showBanner(text, { retry = false } = {}) {
  $('banner-text').textContent = text;
  $('banner-retry').hidden = !retry;
  $('banner').hidden = false;
}

function hideBanner() {
  $('banner').hidden = true;
}

function describeError(err) {
  switch (err?.code) {
    case 'logged_out':
      return 'You are not signed in to Instagram. Sign in on the main tab, then retry.';
    case 'blocked':
      return 'Instagram is rate limiting this account. Wait a while before retrying.';
    case 'content_not_ready':
      return 'Could not reach the Instagram tab. Reload that tab, then retry.';
    default:
      return err?.message || String(err);
  }
}

function reportError(err) {
  showBanner(describeError(err), { retry: true });
}

// ------------------------------------------------------------------- render

function recompute() {
  const live = state.rows.filter((row) => !state.doneIds.has(row.id));

  // Search matches what is on screen, not what is underneath it. Without this
  // the search box cannot be demonstrated while screenshot mode is on: you
  // would be typing a name the row is showing and getting nothing back.
  // Always written, never conditionally, so turning the mode off cannot leave
  // a stale pseudonym behind still answering searches.
  const mask = anon.mask();
  for (const row of live) {
    row.alias = mask.on ? mask.username(row.username) : '';
    row.aliasName = mask.on ? mask.fullName(row.username, row.fullName) : '';
  }

  state.visible = sortRows(applyFilters(live, state.filters), state.settings.sort);

  renderer.setRows(state.visible);
  renderer.setSelection(state.selected);

  $('shown-count').textContent = formatShownCount(state.visible.length, live.length);

  // Anything a filter hides for want of data rather than for failing the test
  // gets said out loud, so "no results" never quietly means "not loaded yet".
  const unenriched = live.filter((row) => !row.enriched).length;
  const unknownMutuals = countHiddenByUnknownMutuals(live, state.filters);
  const warning = $('enriched-warning');

  // These filters hide every un-enriched row, which already includes every row
  // with an unknown mutual count — one message covers both, so the branches
  // below are ordered widest-first.
  if (usesEnrichedFilters(state.filters) && unenriched > 0) {
    const plural = unenriched === 1 ? '' : 's';
    warning.textContent = state.filters.noMutuals
      // Spelled out because this is the filter people reach for to bulk
      // reject, and a missing "Followed by…" hint genuinely is not a zero.
      ? `Hiding ${unenriched} request${plural} without loaded details. Instagram omits the mutuals hint for most requests even when mutuals exist, so these are not known to have none — use Load details to check them.`
      : `${unenriched} request${plural} not yet enriched and therefore hidden by these filters.`;
    warning.hidden = false;
  } else if (unknownMutuals > 0) {
    // Neither bound is enriched-only — the free estimate still filters — so
    // only the rows Instagram said nothing about get held back.
    warning.textContent = `${unknownMutuals} request${unknownMutuals === 1 ? '' : 's'} hidden: Instagram did not report a mutual count for them. Load their details to check.`;
    warning.hidden = false;
  } else {
    warning.hidden = true;
  }

  updateEmptyState(live);
  syncHydration();
  updateSpamChip();
  updateBulkBar();
}

/**
 * What to say when there are no rows to show.
 *
 * The distinction that matters is whether anything is left underneath. An empty
 * queue is the end of the job; an empty *view* over a queue that still holds
 * requests is a dead end the user walked into with a control, and the notes
 * under the list are too quiet to be found from a blank screen — hence a box,
 * with the way out inside it.
 */
function updateEmptyState(live) {
  const box = $('list-empty');
  if (state.visible.length > 0) {
    box.hidden = true;
    return;
  }

  // Filters can only be blamed for an empty view when there was something for
  // them to hide. With nothing pending, "reset your filters" is a false lead.
  const blocked = live.length > 0 && filtersActive(state.filters);
  const plural = live.length === 1 ? '' : 's';

  box.hidden = false;
  box.classList.toggle('is-blocked', blocked);
  $('list-empty-text').textContent = blocked
    ? `Your filters are hiding all ${live.length} remaining request${plural}.`
    : 'No pending requests.';
  $('reset-filters').hidden = !blocked;
}

/**
 * Put every filter back to its default, controls included.
 *
 * The DOM is the source of truth for filter values — readFilters reads it — so
 * this resets the inputs and then re-reads, rather than assigning
 * DEFAULT_FILTERS and leaving the controls contradicting the list.
 */
function resetFilters() {
  $('f-following').checked = false;
  $('f-mutuals').value = 'any';
  $('f-max-followers').value = '';
  for (const id of ['f-zero-posts', 'f-empty-bio', 'f-default-pic', 'f-bot-ratio']) {
    $(id).checked = false;
  }

  // Emptied before it is closed, so setSearchOpen has nothing left to clear and
  // fires no second recompute of its own.
  $('search').value = '';
  setSearchOpen(false, { field: $('search'), button: $('search-toggle'), onClear: () => {} });

  readFilters();
}

/** Keeps the count on the closed Spam chip honest. */
function updateSpamChip() {
  const active = SPAM_FILTER_KEYS.filter((key) => {
    const value = state.filters[key];
    return key === 'maxFollowers' ? value !== null : Boolean(value);
  }).length;

  $('spam-count').textContent = String(active);
  $('spam-count').hidden = active === 0;
  $('spam-toggle').classList.toggle('is-filtering', active > 0);
}

/**
 * The hydration slot in the tab bar: the standing total, or the running batch.
 *
 * Two states in one box, and that is the whole point of the box. They are one
 * queue — every profile that lands advances the batch and the total together —
 * so reported from two places they showed the same number twice, which is what
 * a run starting from nothing loaded does literally.
 *
 * The header rather than the list because a batch takes minutes and the slot
 * must not scroll away from it, and this is the one pinned band with room to
 * spare, so being pinned here costs no pixels.
 */
function syncHydration() {
  const live = state.rows.filter((row) => !state.doneIds.has(row.id));
  const enriched = live.filter((row) => row.enriched).length;
  const progress = state.hydrationProgress;
  const run = $('hydration-run');

  $('hydration-idle').hidden = Boolean(progress);
  run.hidden = !progress;

  // One copy, unlike the toolbar's: this meter is a rule under the label rather
  // than a fill behind it, so there is no boundary for a second colour to be
  // knocked out along.
  if (progress) $('hydration-run-count').textContent = `${progress.done} / ${progress.total}`;

  // Reset when nothing is running rather than left where the last batch ended,
  // or the next one opens full and counts backwards.
  const pct = progress && progress.total > 0
    ? Math.round((progress.done / progress.total) * 100)
    : 0;
  run.style.setProperty('--run-pct', `${pct}%`);

  // Kept current even while the run covers it, so switching back to the idle
  // state never shows a number from before the batch.
  $('hydration-count').textContent = `${enriched} / ${live.length}`;

  // Hydration only ever touches what is in view, so the link has to count the
  // same set — otherwise the enriched-only filters can leave it offering work
  // that runHydrationBatch would then decline to do.
  const missingInView = state.visible.filter((row) => !row.enriched).length;
  const next = Math.min(missingInView, state.settings.batchSize);
  const link = $('load-batch');

  // Gone rather than disabled when there is nothing left to fetch: the counter
  // beside it already says so, and a greyed-out "All loaded" is not a control,
  // it is a second counter.
  link.hidden = missingInView === 0;
  link.textContent = `Load ${next}`;
  link.disabled = state.loading;

  // Nothing loaded yet is the one state where the panel has a single obvious
  // next action, so the link is allowed to say so.
  link.classList.toggle('is-suggested', enriched === 0 && !link.hidden && !link.disabled);
}

function updateBulkBar() {
  const count = state.mode === 'log' ? state.log.selected.size : state.selected.size;
  // Deliberately not `activeRun()`: hydration and an external run both only
  // read, so neither is a reason to take the bulk buttons away — only the
  // action queue's writes are. An external run already freezes the checkboxes
  // (see syncActing) so the selection itself cannot drift, but that is a
  // different concern from whether the buttons acting on it should show.
  const running = Boolean(state.actionQueue);

  $('bulk-bar').hidden = count === 0 || running;
  $('bulk-count').textContent = `${count} selected`;
  syncSelectAll();
  syncToolbar();
}

/**
 * The run the toolbar reports, and the one its Stop stops.
 *
 * Two candidates, not three. Hydration reports through the header slot and has
 * its own Stop there, so it never contends for this meter — which also settles
 * what used to be the awkward half of this decision. The old rule had hydration
 * outrank an external run so that a guest which can run for hours could not bury
 * the panel's own quick status behind its report; now it cannot bury it at all,
 * because the two are never in the same box.
 *
 * Between what is left, the action queue wins outright: it is the one making
 * irreversible writes to Instagram and the one that can get the account rate
 * limited.
 */
function activeRun() {
  if (state.actionQueue) return { queue: state.actionQueue, progress: state.actionProgress };
  if (state.externalQueue) return { queue: state.externalQueue, progress: state.externalProgress };
  return null;
}

/**
 * Paint the toolbar's progress meter from state.
 *
 * Rendered rather than pushed, because two independent queues feed it and either
 * can start or finish while the other is running — the meter has to be able to
 * hand over mid-run without either knowing about the other.
 *
 * `--run-pct` is the whole mechanism: the fill reads it as a width, the knockout
 * copy of the label reads it as a clip. Reset to 0% when nothing is running, or
 * the next run opens full and counts backwards.
 */
function syncRun() {
  const progress = activeRun()?.progress;
  const bar = $('run-progress');

  bar.hidden = !progress;
  $('toolbar').classList.toggle('is-running', Boolean(progress));

  if (progress) {
    // Both copies in one statement: they are the same line in two colours, and
    // a frame where they disagree shows as a seam at the fill's edge.
    $('run-label').textContent = progress.label;
    $('run-label-knockout').textContent = progress.label;
  }

  const pct = progress && progress.total > 0
    ? Math.round((progress.done / progress.total) * 100)
    : 0;
  bar.style.setProperty('--run-pct', `${pct}%`);

  syncToolbar();
}

/**
 * Whether a run in flight should freeze the lists.
 *
 * Hydration is excluded: it changes nothing on Instagram's side, so there is no
 * reason to stop you filtering and selecting through it.
 *
 * An external run freezes too, though it writes nothing either — its reason is
 * not hydration's. It acts on a specific set of rows the queue captured when it
 * started, so changing the selection mid-run changes nothing about what is
 * actually running; that is the action queue's argument (a queue holding ids it
 * started with), not "we only read". This is the one place the rule for an
 * external run diverges from the rule for hydration.
 *
 * One function because two readings of it drifted apart once already: this said
 * "or external", renderLog's `inert` said "action queue only", and a repaint
 * mid-harvest handed the log's checkboxes back.
 */
function isActing() {
  return Boolean(state.actionQueue) || Boolean(state.externalQueue);
}

/** Apply that freeze — dimmed, and inert but for the profile links. */
function syncActing() {
  const acting = isActing();
  document.body.classList.toggle('is-acting', acting);
  renderer.setInert(acting);
  // Follow-back is a write too, and it acts on the log — so the log freezes on
  // the same terms. Patched in place here; renderLog reapplies it on repaint.
  for (const box of document.querySelectorAll('.log-check')) box.disabled = acting;
}

/**
 * The seam an external feature drives its own run through — handed to
 * mountHarvest as `externalRun`, but named for the role rather than the
 * feature, since nothing here needs to know which feature is holding it.
 *
 * Mirrors what runBulk/runHydrationBatch do to their own state by hand:
 * `start` seeds the meter before the caller's own first tick the way both
 * queues seed themselves, `update` is a plain progress tick, and `finish`
 * clears state in the one statement that also lifts the freeze.
 */
const externalRun = {
  start(queue, progress) {
    state.externalQueue = queue;
    state.externalProgress = progress;
    syncRun();
    syncActing();
  },
  update(progress) {
    state.externalProgress = progress;
    syncRun();
  },
  finish() {
    state.externalQueue = null;
    state.externalProgress = null;
    syncRun();
    syncActing();
  },
};

/**
 * Rows another feature has already handled, as `{ [userId]: note }`.
 *
 * The counterpart to externalRun, and named for the role rather than the
 * feature for the same reason: the panel shows the note and stops select-all
 * ticking those rows, and never learns what the note means. Handed to
 * mountHarvest, which pushes the accounts it has already written to a batch.
 */
const skipNotes = {
  set(byId) {
    state.log.skipNotes = byId || {};
    if (state.mode === 'log') recomputeLog();
  },
};

/**
 * Which way each select-all button will go, derived from the selection rather
 * than toggled on click. Ticking the last row by hand has to flip the label
 * too, or the button starts describing an action it will not perform.
 *
 * Both modes are synced together: only one is on screen at a time, and the
 * hidden one costs nothing to keep honest.
 */
function syncSelectAll() {
  const shownAll = state.visible.length > 0
    && state.visible.every((row) => state.selected.has(row.id));
  $('select-all').textContent = shownAll ? 'Deselect all' : 'Select all';
  $('select-all').disabled = state.visible.length === 0;

  const plan = history.selectAllPlan(state.log.selectable, state.log.selected);
  $('log-select-all').textContent = plan.mode === 'deselect' ? 'Deselect all' : 'Select all';
  $('log-select-all').disabled = plan.disabled;
}

/** The floating bar exists only while it has something to show. */
function syncToolbar() {
  const visible = !$('bulk-bar').hidden || !$('run-progress').hidden;
  $('toolbar').hidden = !visible;
  document.body.classList.toggle('has-toolbar', visible);
}

function rebuildRows() {
  state.rows = mergeRows(state.pendingUsers, state.statuses, state.cache);
}

// ------------------------------------------------------- screenshot mode
//
// Cmd+Alt+S (Ctrl+Alt+S off Mac). Display only: it renames what is drawn and
// blurs the avatars, here and on the Instagram tab, and touches no stored data
// and no write. See src/anon.js and src/alias.js.

/**
 * Real display names for the tab to work from, as `{ handle: fullName }`.
 *
 * The tab can name anyone Instagram links, because the href carries the
 * identity — but a profile header's name sits outside any link, so it needs
 * telling. We already hold exactly this: the pending list ships `full_name`
 * for every request, and hydration adds more.
 */
function knownFullNames() {
  const names = {};
  for (const row of state.rows) {
    if (row.fullName) names[row.username.toLowerCase()] = row.fullName;
  }
  return names;
}

/**
 * Repaint everything that draws a name.
 *
 * Both lists, because either can be on screen and the other is one click away;
 * the harvest status line reads the mask itself on its next write.
 */
function applyAnonMode() {
  document.body.classList.toggle('is-anon', anon.isOn());
  renderer.setMask(anon.mask());
  recompute();
  if (state.log.loaded) recomputeLog();
}

async function toggleAnonMode() {
  // Applied first, and unconditionally: anon.toggle sets its own state before
  // it goes anywhere near the tab, so the panel repaints whether or not the
  // push lands. A throw below means the tab is out of step, not that this half
  // failed — and the banner is what says so.
  try {
    await anon.toggle(knownFullNames());
  } finally {
    applyAnonMode();
  }
}

// -------------------------------------------------------------- action log

function setMode(mode) {
  state.mode = mode;
  document.body.dataset.mode = mode;
  for (const id of ['mode-requests', 'mode-log']) {
    $(id).classList.toggle('is-active', $(id).dataset.mode === mode);
  }

  // The two modes act on different things; carrying a selection across would
  // mean the toolbar's buttons no longer match what is ticked.
  state.selected.clear();
  state.log.selected.clear();
  renderer.setSelection(state.selected);

  if (mode === 'log' && !state.log.loaded) loadLogPage();
  else if (mode === 'log') recomputeLog();
  else recompute();
}

/**
 * Add records we do not already hold. Every path into `state.log.records` goes
 * through here, because a live action reaches the panel twice — once from
 * whoever performed it, once from the storage change it caused.
 *
 * @returns how many were actually new
 */
function absorbLogRecords(records) {
  let added = 0;
  for (const record of records) {
    const key = history.recordKey(record);
    if (state.log.seen.has(key)) continue;
    state.log.seen.add(key);
    state.log.records.push(record);
    added += 1;
  }
  return added;
}

/** Pull the next page of day shards. The log is never loaded whole. */
async function loadLogPage() {
  if (!state.log.loaded) {
    // Retention runs here rather than at startup, so opening the panel touches
    // the log not at all. A two-year window has no urgency.
    await store.pruneLog();
    state.log.index = await store.loadLogIndex();
    state.log.loaded = true;
  }

  const next = state.log.index.slice(state.log.loadedDays, state.log.loadedDays + LOG_PAGE_DAYS);
  if (next.length > 0) {
    absorbLogRecords(await store.loadLogDays(next));
    state.log.loadedDays += next.length;
  }
  recomputeLog();
}

/**
 * A shard changed under us — an accept or reject from the on-page banner, or
 * one of our own writes coming back around. Both arrive here, which is what
 * keeps the log current while a run is in progress.
 *
 * Ignored until the log has been loaded once: opening it reads every shard
 * fresh anyway, and absorbing beforehand would leave `index` and `loadedDays`
 * describing a load that never happened.
 */
function onLogShardChanged(changes) {
  if (!state.log.loaded) return;

  let touched = false;
  for (const [key, change] of Object.entries(changes)) {
    if (!key.startsWith(history.DAY_PREFIX)) continue;
    // A removal — retention pruning or a cleared log. Nothing to take from it,
    // and the state reset that follows a clear handles the rest.
    if (!change.newValue) continue;

    let day = state.log.index.indexOf(key);
    const isNewDay = day === -1;
    if (isNewDay) {
      // A day we have not seen: today's shard on its first write, or the first
      // write after the date rolls over mid-session. Placed by date rather than
      // assumed to be the newest, since the index is what the paging slice
      // reads and a wrong position there quietly skips a day.
      day = state.log.index.findIndex((known) => known < key);
      if (day === -1) day = state.log.index.length;
      state.log.index.splice(day, 0, key);
      touched = true;
    }

    // `index[0..loadedDays)` is what we hold. A shard landing inside that range
    // — or right at its edge — extends it, and the boundary moves out by one.
    // One older than that stays where the user left it, behind Load older,
    // rather than jumping the queue.
    if (day > state.log.loadedDays) continue;
    if (isNewDay) state.log.loadedDays += 1;

    touched = absorbLogRecords(change.newValue) > 0 || touched;
  }

  // Repainting the whole list is fine here: the view holds a bounded number of
  // days, and writes arrive no faster than the queue's pace.
  if (touched && state.mode === 'log') recomputeLog();
}

/**
 * Accounts you accepted and do not yet follow. Derived from the loaded records
 * rather than tracked as state — the log already says it.
 */
function followBackTargets() {
  const followed = history.followedIds(state.log.records);
  return (record) => history.isAccept(record) && !followed.has(record.userId);
}

function recomputeLog() {
  const canFollow = followBackTargets();
  state.log.visible = history.sortRecords(
    history.filterRecords(state.log.records, { kind: state.log.kind, search: state.log.search })
  );

  renderLog($('log-list'), state.log.visible, {
    now: Date.now(),
    selected: state.log.selected,
    canFollow,
    // A run repaints this list from under itself — a follow-back's own writes
    // land in the log, and a harvest pushes a note per account — so the freeze
    // has to be reapplied on every render, not just when it starts. Through
    // isActing() rather than a second reading of the same rule: syncActing
    // disables these checkboxes for an external run too, and this used to read
    // only the action queue, so a repaint mid-harvest handed them back.
    inert: isActing(),
    skipNotes: state.log.skipNotes,
    mask: anon.mask(),
  });

  for (const tab of document.querySelectorAll('.log-tab')) {
    tab.classList.toggle('is-active', tab.dataset.kind === state.log.kind);
  }

  const remaining = state.log.index.length - state.log.loadedDays;
  $('log-older').hidden = remaining <= 0;
  $('log-older').textContent = `Load older (${remaining} more day${remaining === 1 ? '' : 's'})`;

  const shown = state.log.visible.length;
  $('log-count').textContent = `${shown} action${shown === 1 ? '' : 's'}`;

  const empty = $('log-empty');
  empty.hidden = shown > 0;
  if (shown === 0) {
    empty.textContent = state.log.records.length === 0
      ? 'Nothing logged yet. Accepting or rejecting a request records it here.'
      : 'Nothing matches these filters.';
  }

  // Only rows offering a follow-back can be selected, so "select all" has to
  // count the same set rather than everything on screen.
  state.log.followable = state.log.visible.filter(canFollow);

  // By account, not by row: the same person can hold two followable rows, and
  // the selection is keyed on who they are. Noted rows come out — select-all
  // is the bulk gesture, and a row already handled elsewhere is exactly what
  // you do not mean by "all". Ticking one by hand still works.
  state.log.selectable = [...new Set(state.log.followable.map((record) => record.userId))]
    .filter((id) => !state.log.skipNotes[id]);

  updateBulkBar();
}

/** Follow back everyone selected in the log. */
async function runFollowBack() {
  if (state.actionQueue) return;

  const targets = state.log.followable.filter((record) => state.log.selected.has(record.userId));
  // One row per account: the same person can appear twice if they were
  // accepted, unfollowed and accepted again.
  const unique = [...new Map(targets.map((record) => [record.userId, record])).values()];
  if (unique.length === 0) return;

  const plural = unique.length === 1 ? '' : 's';
  const confirmed = await confirmAction({
    title: `Follow back ${unique.length} account${plural}?`,
    body: `Follows ${unique.length} account${plural} you previously accepted. Private accounts become a follow request.`,
  });
  if (!confirmed) return;

  hideBanner();

  const queue = new ThrottledQueue({
    items: unique,
    pacing: PACING.moderate,
    handler: async (record) => {
      const result = await api.call('follow', { userId: record.userId });
      if (!result?.ok) return result || { ok: false, error: 'no response' };

      // Taken in hand rather than left to the storage change, so the row stops
      // offering a follow-back even if the write to the log fails. They were
      // followed either way, and the log failing is not their problem.
      absorbLogRecords([logAction({ id: record.userId, username: record.username }, history.FOLLOW)]);
      state.log.selected.delete(record.userId);
      return result;
    },
    onProgress: ({ done, total }) => {
      state.actionProgress = { label: `Following ${done} / ${total}…`, done, total };
      syncRun();
    },
    onFinish: ({ halted, stopped, failures, done, total }) => {
      state.actionQueue = null;
      state.actionProgress = null;
      syncRun();
      syncActing();

      if (halted) showBanner(`Stopped after ${done} of ${total} — Instagram returned "${halted}". Wait before retrying.`);
      else if (stopped) setStatus(`Stopped after ${done} of ${total}.`);
      else if (failures.length) setStatus(`Done, ${failures.length} failed.`);
      // Nothing on a clean run: the rows below stop offering a follow-back,
      // which is the same news said where it happened.
      else setStatus('');

      recomputeLog();
    },
  });

  state.actionQueue = queue;
  // Seeded before the first item rather than left to the first onProgress: at up
  // to 3s per write, the meter would otherwise sit closed through the whole of
  // the first one.
  state.actionProgress = { label: `Following 0 / ${unique.length}…`, done: 0, total: unique.length };
  syncRun();
  syncActing();
  updateBulkBar();

  await queue.run();
}

// --------------------------------------------------------------- bulk pass

/** Follow status for a set of pending users, 100 ids per request. */
function checkFollowStatuses(users) {
  setLoadingText(`Checking follow status for ${users.length}…`);
  return api.fetchFollowStatuses(
    users.map((user) => String(user.pk)),
    ({ done, total }) => setLoadingText(`Checking follow status ${done} / ${total}…`)
  );
}

async function loadPending({ useSnapshot = true } = {}) {
  if (state.loading) return;
  state.loading = true;
  hideBanner();
  setState('loading');
  setLoadingText('Loading pending requests…');
  setStatus('');

  try {
    let snapshot = useSnapshot ? await store.loadSnapshot() : null;

    if (!snapshot) {
      const { users, capped } = await api.fetchAllPending(({ total }) =>
        setLoadingText(`Fetched ${total} requests…`)
      );
      snapshot = { users, capped, statuses: await checkFollowStatuses(users) };
      await store.saveSnapshot(snapshot);
    } else {
      // The pending list keeps for a browser session. The follow flags do not,
      // and they are not the panel's to know: you follow people on
      // instagram.com itself, and nothing tells the panel you did. A cached
      // `statuses` is therefore only as true as the moment it was taken, and
      // "Already follow" is the one filter that answers *wrong* rather than
      // incomplete when it drifts — a stale `false` is indistinguishable from a
      // real one, so the row simply is not there and nothing says why.
      // Re-asking costs two reads against a list we already hold.
      try {
        snapshot = { ...snapshot, statuses: await checkFollowStatuses(snapshot.users) };
        await store.saveSnapshot(snapshot);
      } catch (err) {
        // Better to open with flags we know may be stale than not to open —
        // but not quietly, since that is exactly the failure above.
        showBanner(
          `Could not re-check follow status (${describeError(err)}). "Already follow" may be out of date until you Refresh.`
        );
      }
    }

    state.pendingUsers = snapshot.users;
    state.statuses = snapshot.statuses;
    state.capped = snapshot.capped;
    rebuildRows();

    // Instagram serves at most 200 pending requests and offers no cursor past
    // them. More only become visible once these are cleared. A standing fact
    // about the data, so it gets its own element below the list rather than
    // the status line, where the next action result would overwrite it.
    $('cap-count').textContent = String(api.SERVER_PAGE_CAP);
    $('cap-note').hidden = !state.capped;
    setState('ready');
    // Before recompute, not just in the finally: syncHydration reads this flag,
    // and leaving it set here left "Load details" disabled forever.
    state.loading = false;
    recompute();
  } catch (err) {
    reportError(err);
    setStatus('');
    setState('error');
  } finally {
    state.loading = false;
  }
}

// ---------------------------------------------------------------- hydration

async function runHydrationBatch() {
  if (state.hydrationQueue) return;

  const targets = state.visible.filter((row) => !row.enriched).slice(0, state.settings.batchSize);
  if (targets.length === 0) {
    setStatus('Everything in view is already enriched.');
    return;
  }

  hideBanner();
  // The row is about to become the only progress indicator, so clear whatever
  // the last run left behind rather than let it read as news about this one.
  setStatus('');
  const fresh = {};
  let flushed = 0;

  const queue = new ThrottledQueue({
    items: targets,
    pacing: PACING.hydration,
    handler: async (row) => {
      const result = await api.call('profile', { username: row.username });
      if (!result?.ok) return result || { ok: false, error: 'no response' };

      const profile = toCachedProfile(result.data);
      if (!profile) return { ok: false, error: 'unexpected profile shape' };

      state.cache[row.id] = profile;
      fresh[row.id] = profile;

      // Patch the row in place rather than recomputing the list — a filter or
      // sort re-run here would yank the list around under the user's cursor.
      const merged = mergeRows([state.pendingUsers.find((u) => String(u.pk) === row.id)], state.statuses, state.cache)[0];
      if (merged) {
        const index = state.rows.findIndex((candidate) => candidate.id === row.id);
        if (index !== -1) state.rows[index] = merged;
        renderer.updateRow(merged);
      }
      return { ok: true };
    },
    // No setStatus here: the meter is already saying this, and the status line
    // is for what happens *after* a run, not during it.
    onProgress: async ({ done, total }) => {
      state.hydrationProgress = { done, total };
      syncHydration();
      // Batch the disk writes; one flush per profile would be pointless churn.
      if (Object.keys(fresh).length - flushed >= 10) {
        flushed = Object.keys(fresh).length;
        await store.saveProfiles(fresh);
      }
    },
    onFinish: async ({ halted, stopped, failures }) => {
      await store.saveProfiles(fresh);
      state.hydrationQueue = null;
      state.hydrationProgress = null;
      syncHydration();

      if (halted) showBanner(`Enrichment stopped — Instagram returned "${halted}". Wait a while before retrying.`);
      else if (stopped) setStatus('Enrichment stopped.');
      else if (failures.length) setStatus(`Enriched with ${failures.length} failure${failures.length === 1 ? '' : 's'}.`);
      else setStatus('');

      recompute();
    },
  });

  state.hydrationQueue = queue;
  // Seeded before the first item rather than left to the first onProgress: the
  // queue only reports once an item resolves, and at ~2s per item that would
  // leave the meter closed for the whole of the first request.
  state.hydrationProgress = { done: 0, total: targets.length };
  syncHydration();
  await queue.run();
}

// ------------------------------------------------------------------ actions

function markDone(id, outcome, message) {
  state.doneIds.add(id);
  state.selected.delete(id);
  // Shared with the on-page banner so it stops offering this profile.
  store.addHandledId(id);
  renderer.markRow(id, outcome, message);
  setTimeout(() => renderer.removeRow(id), 700);
}

/** Rows the banner handled while the panel was open. */
function absorbHandledIds(ids) {
  let changed = false;
  for (const id of ids) {
    if (state.doneIds.has(id)) continue;
    state.doneIds.add(id);
    state.selected.delete(id);
    renderer.removeRow(id);
    changed = true;
  }
  if (changed) recompute();
}

/** Half the between-item gap, so the follow rides the same pace as the accept. */
function followGap() {
  const { min, max } = PACING.moderate;
  return (min + Math.random() * (max - min)) / 2;
}

/**
 * Append to the action log. Deliberately not awaited: the log records triage,
 * it is not part of it, and a storage hiccup must never stall a paced queue.
 */
function logAction({ id, username }, action) {
  const record = history.buildRecord({ at: Date.now(), userId: id, username, action });
  store.appendAction(record);
  return record;
}

async function actOnce(id, action) {
  const row = state.rows.find((candidate) => candidate.id === id);
  if (!row) return { ok: false, error: 'row not found' };

  const spec = ACTIONS[action];
  renderer.markRow(id, 'busy', spec.busy);
  const result = await api.call(spec.op, { userId: id });

  if (!result?.ok) {
    renderer.markRow(id, 'failed', result?.blocked ? 'Rate limited' : result?.error || 'Failed');
    return result || { ok: false, error: 'no response' };
  }

  if (action !== 'approveFollow') {
    const logged = action === 'ignore' ? history.REJECT : history.ACCEPT;
    logAction(row, logged);
    markDone(id, action === 'ignore' ? 'rejected' : 'accepted', spec.done);
    return result;
  }

  if (row.following) {
    logAction(row, history.ACCEPT_FOLLOW);
    markDone(id, 'accepted', 'Accepted · already following');
    return result;
  }

  renderer.markRow(id, 'busy', 'Following…');
  await sleep(followGap());
  const follow = await api.call('follow', { userId: id });

  if (follow?.ok) {
    // Accepting a request does not make that account public to you, so the
    // follow lands as a request when they are private.
    const requested = follow.data?.result === 'requested';
    logAction(row, history.ACCEPT_FOLLOW);
    markDone(id, 'accepted', requested ? 'Accepted · follow requested' : 'Accepted + followed');
    return follow;
  }

  // The approve already went through and cannot be taken back, so the row is
  // done either way — but a block here still has to stop the queue. Logged as
  // a plain accept, which is exactly what happened, and which leaves them in
  // the log's accepted view still offering to follow back.
  logAction(row, history.ACCEPT);
  markDone(id, 'accepted', follow?.blocked ? 'Accepted · follow blocked' : 'Accepted · follow failed');
  return {
    ok: false,
    blocked: Boolean(follow?.blocked),
    error: `follow failed: ${follow?.error || 'no response'}`,
  };
}

async function runBulk(action) {
  if (state.actionQueue) return;

  const ids = [...state.selected].filter((id) => !state.doneIds.has(id));
  if (ids.length === 0) return;

  const spec = ACTIONS[action];
  const plural = ids.length === 1 ? '' : 's';
  const confirmed = await confirmAction({
    title: `${spec.label} ${ids.length} request${plural}?`,
    body:
      action === 'approveFollow'
        ? `Accept ${ids.length} request${plural} and follow each one back. Two writes per person, so it takes roughly twice as long as a plain accept.`
        : `${spec.label} ${ids.length} of ${state.visible.length} shown, with the current filters applied.`,
    warn: action === 'ignore',
  });
  if (!confirmed) return;

  hideBanner();

  const queue = new ThrottledQueue({
    items: ids,
    pacing: PACING.moderate,
    handler: (id) => actOnce(id, action),
    onProgress: ({ done, total }) => {
      state.actionProgress = { label: `${spec.gerund} ${done} / ${total}…`, done, total };
      syncRun();
    },
    onFinish: ({ halted, stopped, failures, done, total }) => {
      state.actionQueue = null;
      state.actionProgress = null;
      syncRun();
      syncActing();

      if (halted) showBanner(`Stopped after ${done} of ${total} — Instagram returned "${halted}". Wait before retrying.`);
      else if (stopped) setStatus(`Stopped after ${done} of ${total}.`);
      else if (failures.length) setStatus(`Done, ${failures.length} failed.`);
      // A clean run says nothing: every row it touched marked itself and left
      // the list, and the log holds the tally for as long as anyone wants it.
      else setStatus('');

      // The pending list on Instagram's side has changed; drop the snapshot so
      // the next Refresh refetches instead of resurrecting handled requests.
      store.clearSnapshot();
      recompute();
    },
  });

  state.actionQueue = queue;
  // Seeded before the first item, as in runFollowBack — at up to 3s per write
  // the meter would otherwise stay closed through the whole of the first one.
  state.actionProgress = { label: `${spec.gerund} 0 / ${ids.length}…`, done: 0, total: ids.length };
  syncRun();
  syncActing();
  updateBulkBar();

  await queue.run();
}

function confirmAction({ title, body, warn }) {
  const dialog = $('confirm');
  $('confirm-title').textContent = title;
  $('confirm-body').textContent = body;
  $('confirm-warn').hidden = !warn;

  return new Promise((resolve) => {
    dialog.addEventListener('close', () => resolve(dialog.returnValue === 'go'), { once: true });
    dialog.showModal();
  });
}

// ------------------------------------------------------------------ binding

/**
 * The mutuals menu, in the model's terms.
 *
 * Its values carry the comparison each option is labelled with, in the two
 * forms the menu uses: "<5" and ">10" are strict and step in by one to reach
 * the inclusive bounds applyFilters works in, while "1+" already is one. "0"
 * is not a bound at all but its own predicate, and an enriched-only one: an
 * absent social_context is not evidence of zero.
 */
function readMutualsFilter(value) {
  const strict = /^([<>])(\d+)$/.exec(value);
  const atLeast = /^(\d+)\+$/.exec(value);

  let minMutuals = 0;
  let maxMutuals = null;
  if (atLeast) minMutuals = Number(atLeast[1]);
  else if (strict?.[1] === '>') minMutuals = Number(strict[2]) + 1;
  else if (strict?.[1] === '<') maxMutuals = Number(strict[2]) - 1;

  return { minMutuals, maxMutuals, noMutuals: value === '0' };
}

function readFilters() {
  const rawMax = $('f-max-followers').value;
  state.filters = {
    onlyFollowing: $('f-following').checked,
    ...readMutualsFilter($('f-mutuals').value),
    maxFollowers: rawMax === '' ? null : Number(rawMax),
    zeroPosts: $('f-zero-posts').checked,
    emptyBio: $('f-empty-bio').checked,
    defaultPic: $('f-default-pic').checked,
    botRatio: $('f-bot-ratio').checked,
    search: $('search').value,
  };
  recompute();
}

function bindLog() {
  for (const id of ['mode-requests', 'mode-log']) {
    $(id).addEventListener('click', () => setMode($(id).dataset.mode));
  }

  for (const tab of document.querySelectorAll('.log-tab')) {
    tab.addEventListener('click', () => {
      state.log.kind = tab.dataset.kind;
      state.log.selected.clear();
      recomputeLog();
    });
  }

  let logSearchTimer;
  $('log-search').addEventListener('input', () => {
    clearTimeout(logSearchTimer);
    logSearchTimer = setTimeout(() => {
      state.log.search = $('log-search').value;
      recomputeLog();
    }, 150);
  });

  const logSearchToggle = () => setSearchOpen($('log-search').hidden, {
    field: $('log-search'),
    button: $('log-search-toggle'),
    onClear: () => {
      state.log.search = '';
      recomputeLog();
    },
  });

  $('log-search-toggle').addEventListener('click', logSearchToggle);

  $('log-search').addEventListener('keydown', (event) => {
    if (event.key === 'Escape') logSearchToggle();
  });

  $('log-older').addEventListener('click', () => loadLogPage());

  const list = $('log-list');

  list.addEventListener('change', (event) => {
    const checkbox = event.target.closest('.log-check');
    if (!checkbox) return;
    const row = checkbox.closest('.log-row');
    toggleLogSelection(row.dataset.id, checkbox.checked);
  });

  list.addEventListener('click', (event) => {
    const row = event.target.closest('.log-row');
    if (!row) return;

    if (event.target.closest('[data-action="open"]')) {
      const username = rowUsername(row);
      if (!username) return undefined;
      return api.navigateToProfile(username).catch(reportError);
    }
    if (event.target.closest('.log-check') || !row.classList.contains('is-selectable')) return;

    const checkbox = row.querySelector('.log-check');
    checkbox.checked = !checkbox.checked;
    toggleLogSelection(row.dataset.id, checkbox.checked);
  });

  $('log-select-all').addEventListener('click', () => {
    const { next } = history.selectAllPlan(state.log.selectable, state.log.selected);

    // Mutated in place rather than reassigned: renderLog was handed this Set
    // and the harvest reads it through a closure, so swapping the object would
    // leave both holding the previous selection.
    state.log.selected.clear();
    for (const id of next) state.log.selected.add(id);
    recomputeLog();
  });

  $('bulk-follow-back').addEventListener('click', () => runFollowBack());

  $('log-clear').addEventListener('click', async () => {
    const confirmed = await confirmAction({
      title: 'Clear the action log?',
      body: 'Deletes every recorded accept, reject and follow-back. This does not change anything on Instagram.',
      warn: true,
    });
    if (!confirmed) return;

    await store.clearLog();
    // Still loaded, now empty — anything written from here on is live again
    // rather than waiting for a reload that will not happen.
    state.log.index = [];
    state.log.loadedDays = 0;
    state.log.records = [];
    state.log.seen.clear();
    state.log.selected.clear();
    recomputeLog();
    setStatus('Log cleared.');
  });
}

/**
 * The real username a log row stands for.
 *
 * Off `data-username`, not off the rendered text: what is rendered is whatever
 * the naming mask produced, and under screenshot mode that is a pseudonym.
 * Navigating to it would open an account that does not exist.
 */
function rowUsername(row) {
  return row.dataset.username || '';
}

function toggleLogSelection(userId, checked) {
  if (checked) state.log.selected.add(userId);
  else state.log.selected.delete(userId);

  // The same account can occupy more than one row; keep them consistent.
  for (const node of document.querySelectorAll(`.log-row[data-id="${CSS.escape(userId)}"]`)) {
    const box = node.querySelector('.log-check');
    if (box) box.checked = checked;
    node.classList.toggle('is-selected', checked);
  }
  updateBulkBar();
}

/**
 * Show or hide a search field behind its toggle.
 *
 * Closing always clears the query. A hidden field that is still filtering
 * leaves the list silently short with nothing on screen to explain it, so the
 * toggle must never be able to conceal an active filter.
 */
function setSearchOpen(open, { field, button, onClear }) {
  field.hidden = !open;
  button.setAttribute('aria-expanded', String(open));
  button.classList.toggle('is-active', open);

  if (open) {
    field.focus();
    return;
  }
  if (field.value !== '') {
    field.value = '';
    onClear();
  }
}

/** Breathing room between a popover and the panel edge. */
const POPOVER_MARGIN = 8;

/**
 * Slide an open popover back inside the panel.
 *
 * It is positioned against the chip that opens it, and the filter bar wraps, so
 * that chip can be anywhere along either line. In a panel dragged narrow, a
 * popover left where CSS put it hangs off one edge or the other — and the
 * overflow is unreachable, since the panel is the whole viewport and does not
 * scroll sideways.
 */
function clampPopover(panel) {
  panel.style.left = '0px';

  const rect = panel.getBoundingClientRect();
  const overflowRight = rect.right - (window.innerWidth - POPOVER_MARGIN);
  if (overflowRight <= 0) return;

  // Never past the left edge: a popover pinned to the right is recoverable,
  // one whose first checkbox sits at x = -40 is not.
  panel.style.left = `${-Math.min(overflowRight, rect.left - POPOVER_MARGIN)}px`;
}

function bind() {
  renderer = new ListRenderer({
    mask: anon.mask(),
    container: $('list'),
    sentinel: $('sentinel'),
    handlers: {
      onToggleSelect: (id, checked) => {
        if (checked) state.selected.add(id);
        else state.selected.delete(id);
        updateBulkBar();
      },
      onOpenProfile: (id) => {
        const row = state.rows.find((candidate) => candidate.id === id);
        if (row) api.navigateToProfile(row.username).catch(reportError);
      },
    },
  });

  const filterInputs = [
    'f-following', 'f-mutuals', 'f-max-followers',
    'f-zero-posts', 'f-empty-bio', 'f-default-pic', 'f-bot-ratio',
  ];
  for (const id of filterInputs) $(id).addEventListener('change', readFilters);

  let searchTimer;
  $('search').addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(readFilters, 150);
  });

  const searchToggle = () => setSearchOpen($('search').hidden, {
    field: $('search'),
    button: $('search-toggle'),
    onClear: readFilters,
  });

  $('search-toggle').addEventListener('click', searchToggle);

  $('search').addEventListener('keydown', (event) => {
    if (event.key === 'Escape') searchToggle();
  });

  const setSpamOpen = (open) => {
    $('spam-panel').hidden = !open;
    $('spam-toggle').setAttribute('aria-expanded', String(open));
    if (open) clampPopover($('spam-panel'));
  };

  $('spam-toggle').addEventListener('click', (event) => {
    event.stopPropagation();
    setSpamOpen($('spam-panel').hidden);
  });

  // Dragging the side panel's edge is how this UI gets narrow in the first
  // place, and it does not dismiss an open popover the way a click would.
  window.addEventListener('resize', () => {
    if (!$('spam-panel').hidden) clampPopover($('spam-panel'));
  });

  // Clicks inside the panel belong to its own controls; anywhere else dismisses.
  $('spam-panel').addEventListener('click', (event) => event.stopPropagation());
  document.addEventListener('click', () => setSpamOpen(false));

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || $('spam-panel').hidden) return;
    setSpamOpen(false);
    $('spam-toggle').focus();
  });

  // Screenshot mode. Matched on event.code because Option+S on macOS types
  // "ß" — event.key would never be "s" for the combination that fires this.
  // The panel has to hold focus for it, which is the trade for not spending a
  // manifest command and a global binding on a mode only used while shooting.
  document.addEventListener('keydown', (event) => {
    if (event.code !== 'KeyS' || !event.altKey) return;
    if (!event.metaKey && !event.ctrlKey) return;
    event.preventDefault();
    toggleAnonMode().catch(reportError);
  });

  $('sort').addEventListener('change', async () => {
    state.settings.sort = $('sort').value;
    await store.saveSettings(state.settings);
    recompute();
  });

  const reload = async () => {
    await store.clearSnapshot();
    state.doneIds.clear();
    state.selected.clear();
    await loadPending({ useSnapshot: false });
  };

  $('refresh').addEventListener('click', reload);
  $('banner-retry').addEventListener('click', reload);

  $('reset-filters').addEventListener('click', resetFilters);

  $('load-batch').addEventListener('click', () => runHydrationBatch());

  // A Stop per meter, each stopping the queue its own label is counting — all
  // three can run at once, so one shared Stop would have to guess. Hydration's
  // is unambiguous because nothing else reports beside it; the toolbar's follows
  // the same precedence its label does, so it always means what is written next
  // to it.
  $('stop-hydration').addEventListener('click', () => state.hydrationQueue?.stop());
  $('run-stop').addEventListener('click', () => activeRun()?.queue.stop());

  bindLog();

  $('select-all').addEventListener('click', () => {
    // Deselect clears the whole selection, not just what is shown: rows picked
    // under an earlier filter are still selected and still counted by the
    // toolbar, so leaving them behind would contradict the word "all".
    const shownAll = state.visible.length > 0
      && state.visible.every((row) => state.selected.has(row.id));
    if (shownAll) state.selected.clear();
    else for (const row of state.visible) state.selected.add(row.id);

    renderer.setSelection(state.selected);
    updateBulkBar();
  });

  for (const [buttonId, action] of Object.entries(BULK_BUTTONS)) {
    $(buttonId).addEventListener('click', () => runBulk(action));
  }

  $('bulk-clear').addEventListener('click', () => {
    if (state.mode === 'log') {
      state.log.selected.clear();
      return recomputeLog();
    }
    state.selected.clear();
    renderer.setSelection(state.selected);
    updateBulkBar();
  });

  $('banner-dismiss').addEventListener('click', hideBanner);

  // Both views write to storage and neither messages the other, so this is
  // where they meet: handled ids in session, log shards in local.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'session') {
      // The on-page banner writes handled ids; mirror them so a profile
      // accepted on the page disappears from the list here too.
      if (changes[store.HANDLED_KEY]) absorbHandledIds(changes[store.HANDLED_KEY].newValue || []);
      return;
    }
    if (area === 'local') onLogShardChanged(changes);
  });

  // An in-flight action queue is doing irreversible writes; make closing the
  // panel mid-run a deliberate act rather than an accident.
  window.addEventListener('beforeunload', (event) => {
    if (state.actionQueue) event.preventDefault();
  });

  // #region harvest — build.js deletes this region from the store package
  // Deleting this call plus src/harvest/ removes the harvest feature entirely.
  // It reads the log selection through a closure and drives the meter through
  // externalRun rather than importing panel state, so nothing here depends on
  // the feature existing — mountHarvest defaults externalRun to a no-op if a
  // future caller omits it, so this call is not load-bearing either.
  //
  // That removal is what the store build does: `npm run build` strips both
  // #region harvest blocks in this file, so the published package can ship
  // without asking for the `downloads` permission the harvest needs.
  mountHarvest({
    selectedLogEntries: () =>
      state.log.visible.filter((record) => state.log.selected.has(record.userId)),
    confirmAction,
    externalRun,
    skipNotes,
    // A getter, not the mask itself: the status line is written during a run,
    // and the mode can be toggled while one is in flight.
    mask: anon.mask,
  });
  // #endregion harvest
}

async function init() {
  state.settings = await store.loadSettings();
  state.cache = await store.loadProfileCache();
  // Before bind(), so the renderer is constructed with the right mask rather
  // than painting the real names once and correcting itself.
  await anon.load();

  bind();
  document.body.classList.toggle('is-anon', anon.isOn());
  $('sort').value = state.settings.sort;
  setMode('requests');

  await loadPending();
}

init().catch(reportError);
