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
import { JobList } from './jobs.js';
import { PACING, ThrottledQueue } from './queue.js';
import { ListRenderer, RunStack, renderLog } from './render.js';
import {
  DEFAULT_FILTERS,
  applyFilters,
  countHiddenByUnknownMutuals,
  filtersActive,
  formatShownCount,
  mergeRows,
  rangeIds,
  sortRows,
  toCachedProfile,
  usesEnrichedFilters,
} from './model.js';

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Everything a job can be. The first three are what you can do to a selection of
 * requests — `approveFollow` is two writes against Instagram, not one, see
 * actOnce — and the fourth is the log's follow-back.
 *
 * All four go through the same pipeline because all four are friendship writes,
 * and the pacing that keeps the account out of an action block only holds if
 * there is one queue for the lot of them.
 */
const ACTIONS = {
  approve: { op: 'approve', label: 'Accept', busy: 'Accepting…', done: 'Accepted', gerund: 'Accepting' },
  approveFollow: { op: 'approve', label: 'Accept + follow', busy: 'Accepting…', done: 'Accepted + followed', gerund: 'Accepting' },
  ignore: { op: 'ignore', label: 'Reject', busy: 'Rejecting…', done: 'Rejected', gerund: 'Rejecting' },
  followBack: { op: 'follow', label: 'Follow back', busy: 'Following…', done: 'Followed', gerund: 'Following' },
};

/**
 * What a job calls the work it is doing.
 *
 * The panel's own kinds are in ACTIONS. A guest job — one a feature outside this
 * file queued through `guestRun` — brings its own, which is the whole of what
 * this file has to know about it.
 */
const jobSpec = (job) => job.spec || ACTIONS[job.kind];

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

  // Every row some job is holding, split by the list it belongs to, as
  // `Map<id, label>`. Derived in syncClaims from the pipeline and rewritten
  // whole; nothing mutates it in place. This is what replaced freezing the
  // lists — see syncClaims.
  claims: { requests: new Map(), log: new Map() },

  // The row being written to at this instant, if any. Held only so its claim
  // label can stand aside: actOnce already puts "Accepting…" on that row, and a
  // claim repaint must not overwrite it with what is merely coming.
  inFlightId: null,

  // Hydration's own progress, which reports to the header slot and nowhere else.
  // It carries no label because it has only one gerund, spelled in the markup so
  // CSS can drop it at narrow widths — unlike the run stack's bars, which have
  // several between them and must each say which is which.
  hydrationProgress: null,  // { done, total }
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
    // `{ [userId]: { label, date } }` from an outside feature, via the skipNotes
    // seam below. A noted row shows the note on its action chip and is left out
    // of `selectable`.
    skipNotes: {},
    selected: new Set(),
    // Where a shift-click measures from. Survives the repaints a run causes,
    // unlike anything read back off the rendered rows; falls back to a plain
    // click on its own once the row it names is no longer on screen.
    anchorId: null,
    kind: 'all',
    search: '',
  },
};

let renderer;
let runStack;

/**
 * The write pipeline. Every accept, reject and follow-back joins it; it runs them
 * one at a time, and holds a claim on the rows each one is waiting to touch.
 *
 * `onChange` is the single repaint for everything the list's shape depends on —
 * which bars exist, which rows are spoken for, whether the pause banner is still
 * telling the truth.
 */
const jobs = new JobList({
  runJob: (job) => runJob(job),
  onChange: () => {
    syncRunStack();
    syncClaims();
    // The pause banner carries the only Resume there is, so it goes when the
    // pause does — including when the pause lifts because the halted job was
    // cancelled rather than resumed.
    if (!jobs.paused && !$('banner-resume').hidden) hideBanner();
    updateBulkBar();
  },
});

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

function showBanner(text, { retry = false, paused = false, detail = '' } = {}) {
  $('banner-message').textContent = text;
  // The (i) only appears when there is something underneath worth opening. A
  // permanently visible one that sometimes says nothing teaches you not to
  // click it, which costs exactly the times it had the answer.
  $('banner-detail').hidden = !detail;
  $('banner-detail').dataset.detail = detail;
  $('banner-retry').hidden = !retry;
  $('banner-resume').hidden = !paused;
  $('banner-cancel-all').hidden = !paused;
  // A paused pipeline is the one banner that must not be dismissible: this is
  // where Resume lives, and dismissing it would leave queued work on screen with
  // nothing anywhere offering to restart it.
  $('banner-dismiss').hidden = paused;
  $('banner').hidden = false;
}

function hideBanner() {
  $('banner').hidden = true;
  $('banner-resume').hidden = true;
  $('banner-cancel-all').hidden = true;
  $('banner-dismiss').hidden = false;
}

/**
 * What to do about a failure, in one short sentence.
 *
 * A banner is read at a glance, at 260px, by someone who wants to get back to
 * triaging — so it says the action and stops. Everything it leaves out lives one
 * click away behind the (i), which is what that control is for: the prose is
 * free to be short precisely because nothing is lost by shortening it.
 *
 * `reason` is read before `code` because the codes are too coarse to word a
 * message from. `logged_out` was raised for any 401 and for any HTML body, so a
 * signed-in account hitting a throttled bulk endpoint was told to sign in —
 * advice that cannot work, because they already are. content.js now settles
 * that at the point of failure, cookie in hand, and `reason` is what it settled.
 */
function describeError(err) {
  switch (err?.reason) {
    case 'signed_out':
      return 'You are signed out of Instagram. Sign in on the main tab.';
    case 'session_rejected':
      return 'Instagram throttled you. Try again in a few minutes.';
    case 'checkpoint':
      return 'Instagram needs you to confirm something on the main tab.';
    case 'challenge':
      return 'Instagram wants a human check on the main tab.';
    case 'rate_limited':
      return 'Instagram is rate limiting you. Try again later.';
    case 'html_response':
      return 'Instagram did not answer properly. Reload the main tab.';
    default:
      break;
  }

  switch (err?.code) {
    case 'logged_out':
      return 'You are signed out of Instagram. Sign in on the main tab.';
    case 'blocked':
      return 'Instagram is rate limiting you. Try again later.';
    case 'content_not_ready':
      return 'Cannot reach the Instagram tab. Reload it.';
    default:
      return err?.message || String(err);
  }
}

/**
 * The raw failure, for the banner's (i). The sentence above is a paraphrase and
 * every paraphrase drops something; this is what was actually said, kept
 * verbatim so a report of it is worth reading. Takes the same shape as
 * describeError, so a halt envelope works here too.
 */
function errorDetail(err) {
  if (!err) return '';
  if (typeof err === 'string') return err;

  const fromInstagram = Boolean(err.reason || err.code);
  const lines = [];
  if (err.reason) lines.push(`Reason: ${err.reason}`);
  if (err.code) lines.push(`Code: ${err.code}`);
  if (err.status !== undefined && err.status !== null) lines.push(`HTTP status: ${err.status}`);

  // reportError also catches plain JavaScript errors from this file, and
  // attributing a TypeError of ours to Instagram would send someone looking in
  // the wrong place — the stack goes in for the same reason.
  if (err.message) lines.push(`${fromInstagram ? 'Instagram said' : 'Error'}: ${err.message}`);
  if (!fromInstagram && err.stack) lines.push('', String(err.stack));

  return lines.join('\n');
}

/**
 * Show the full text of a failure.
 *
 * `alert` is what this wants to be and is tried first, but Chrome makes no
 * promise about JavaScript dialogs in an extension side panel, and a suppressed
 * one returns instantly having shown nothing — silence being the single outcome
 * an error detail must never have. So the call is timed: a dialog a person
 * actually saw cannot come back in under a millisecond, and anything that fast
 * is taken as suppressed and redrawn as a `<dialog>`, which always renders.
 */
function showErrorDetail(text) {
  if (!text) return;

  const before = performance.now();
  try {
    window.alert(text);
    if (performance.now() - before > 1) return;
  } catch {
    // Not available at all — the fallback below covers it.
  }

  $('error-detail-text').textContent = text;
  $('error-detail').showModal();
}

function reportError(err) {
  showBanner(describeError(err), { retry: true, detail: errorDetail(err) });
}

/**
 * A halt, in the shape describeError and errorDetail already read.
 *
 * ThrottledQueue reports a halt as loose fields rather than an error, because
 * the thing that stopped it may have been a returned envelope and never was an
 * error at all. Putting them back into one object is what stops the two message
 * builders needing a second branch for the same failure arriving differently.
 */
function haltError(message, reason, status) {
  return { message, reason, status };
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

  // No longer hidden while something runs. A live selection during a run is the
  // entire point of queueing: the rows a job is holding are inert, everything
  // else is yours, and these buttons are how the next operation gets queued.
  $('bulk-bar').hidden = count === 0;
  $('bulk-count').textContent = `${count} selected`;
  syncSelectAll();
  syncToolbar();
}

const pct = (done, total) => (total > 0 ? Math.round((done / total) * 100) : 0);

/**
 * One bar per job, in the order they will run.
 *
 * The harvest is in here like anything else now. It used to be appended after
 * the jobs as a bar of its own, because it ran alongside the pipeline rather
 * than in it; queueing it removed both the special case and the bar.
 */
function runBars() {
  return jobs.jobs.map((job) => {
    const spec = jobSpec(job);
    const done = jobs.done(job);

    // A queued job counts nothing yet, so it names the work instead — "Reject 24"
    // rather than "Rejecting 0 / 24…", which reads as a run that has stalled at
    // the gate.
    const label = job.state === 'running'
      ? `${spec.gerund} ${done} / ${job.total}…`
      : job.state === 'paused'
        ? `${spec.gerund} ${done} / ${job.total} · paused`
        : `${spec.label} ${job.total} · queued`;

    return { id: job.id, state: job.state, label, pct: pct(done, job.total) };
  });
}

/**
 * Paint the run stack from state.
 *
 * Rendered rather than pushed, because jobs start and finish under it and the
 * harvest comes and goes alongside — no one of them knows enough to update the
 * stack on its own.
 *
 * `--run-pct` is still the whole mechanism inside each running bar: the fill
 * reads it as a width, the knockout copy of the label reads it as a clip. The
 * stack drops a bar entirely when its job leaves, so nothing has to be reset to
 * 0% the way one shared meter did.
 */
function syncRunStack() {
  const bars = runBars();
  runStack.render(bars);

  $('run-stack').hidden = bars.length === 0;
  // The border and the spinners answer *whether* something is running; a fill
  // has no width to say it with at 0 / N.
  $('toolbar').classList.toggle('is-running', bars.some((bar) => bar.state === 'running'));

  syncToolbar();
}

/**
 * What a claimed row says about itself.
 *
 * Null for the row being written to right this second — actOnce has already put
 * "Accepting…" on it, and that is both more specific and more current than
 * anything this could say.
 *
 * Everything else reads as queued, including the rows of the job that is
 * running: within that job they *are* still queued, and a bare "Reject" chip on
 * a row reads like a button rather than a plan.
 */
function claimLabel(job, id) {
  if (id === state.inFlightId) return null;
  return `${job.state === 'paused' ? 'Paused' : 'Queued'} · ${jobSpec(job).label}`;
}

/**
 * Work out which rows are spoken for, and hand each list its own map.
 *
 * This is what replaced freezing the lists wholesale. The old rule dimmed
 * everything the moment a write started, on the grounds that a queue holds the
 * ids it began with and a changed selection could not reach them — true, but it
 * answered a question about *some* rows by taking away *all* of them. A claim
 * says the same thing about exactly the rows it applies to, which is what lets a
 * second selection be built and queued while the first is still running.
 */
function syncClaims() {
  const requests = new Map();
  const log = new Map();

  for (const [id, job] of jobs.claims()) {
    (job.scope === 'log' ? log : requests).set(id, claimLabel(job, id));
  }

  state.claims = { requests, log };
  renderer.setClaims(requests);
  if (state.mode === 'log') recomputeLog();
}

/**
 * The seam a feature outside this file takes a turn in the pipeline through —
 * handed to mountHarvest, but named for the role rather than the feature, since
 * nothing here needs to know which feature is holding it.
 *
 * It used to be `externalRun`, a parallel path with its own bar, its own claim
 * list and its own progress ticks, because the harvest only reads and so was let
 * run alongside the writes. That was the wrong reading of why the pipeline is
 * serial. The rate limit is not a rule about writes; it is a rule about how fast
 * this extension talks to Instagram at all, and a harvest is thousands of
 * requests. Running one over the top of an accept run doubled exactly the rate
 * PACING was chosen to stay under.
 *
 * So a guest is a job. Everything the parallel path reimplemented — the bar, the
 * counter, the claims, Stop, the halt — it now gets by being in the list, and
 * `state.external` is gone.
 *
 * @param ids   what this run will act on; they become the job's claims and its
 *              denominator, so the guest reports progress just by handling them
 * @param spec  `{ label, gerund }`, since a guest has no entry in ACTIONS
 * @param run   `async ({ handled, setStop }) => outcome`, called when its turn
 *              comes. `handled(id)` advances the count and frees that row;
 *              `setStop(fn)` is how the bar's Stop reaches it. The outcome is
 *              the queue's own envelope — `{ halted, stopped, failures }`.
 * @param onDrop called instead of `run` if the job is cancelled while still
 *              waiting. Without it a guest that disabled a button on the way in
 *              would never get the news that its turn is not coming.
 */
const guestRun = {
  enqueue({ ids, spec, run, onDrop }) {
    // Out of the selection and onto the job, exactly as enqueueBulk and
    // enqueueFollowBack do it. Queueing *is* that move: the bulk bar empties,
    // select-all stops counting rows that are now somebody else's, and the next
    // selection can be built straight away. Left in, the rows would stay ticked
    // and disabled — uncountable and un-untickable — and pressing Harvest again
    // after the batch finished would silently redo the same accounts.
    //
    // Ids that were never log rows, which is most of an all-followers sweep,
    // simply are not in the set.
    for (const id of ids) state.log.selected.delete(String(id));
    if (state.mode === 'log') recomputeLog();

    return jobs.enqueue({
      kind: 'guest',
      // The harvest's ids are log rows. A guest that acted on the requests list
      // would pass its own scope; there is no such guest yet, so rather than
      // invent a parameter for it this stays where the one caller needs it.
      scope: 'log',
      ids: ids.map(String),
      spec,
      run: (job) => run({
        handled: (id) => {
          jobs.handled(job, String(id));
          syncRunStack();
          syncClaims();
        },
        setStop: (fn) => { job.stop = fn; },
      }),
      onDrop,
    });
  },
};

/**
 * Rows another feature has already handled, as `{ [userId]: { label, date } }`.
 *
 * The counterpart to guestRun, and named for the role rather than the
 * feature for the same reason: the panel prints the label on the row's action
 * chip and the date in its tooltip, stops select-all ticking those rows, and
 * never learns what either value means. Handed to mountHarvest, which pushes
 * the accounts it has already written to a batch.
 */
const skipNotes = {
  set(byId) {
    state.log.skipNotes = byId || {};
    if (state.mode === 'log') recomputeLog();
  },
};

/** Rows in view that select-all may actually tick — everything not spoken for. */
function selectableRows() {
  return state.visible.filter((row) => !state.claims.requests.has(row.id));
}

/**
 * Which way each select-all button will go, derived from the selection rather
 * than toggled on click. Ticking the last row by hand has to flip the label
 * too, or the button starts describing an action it will not perform.
 *
 * Both modes are synced together: only one is on screen at a time, and the
 * hidden one costs nothing to keep honest.
 */
function syncSelectAll() {
  // Claimed rows come out of both readings. Left in, "all" would mean rows this
  // button cannot tick, so it would never flip to Deselect once a job was
  // holding one of them.
  const selectable = selectableRows();
  const shownAll = selectable.length > 0
    && selectable.every((row) => state.selected.has(row.id));
  $('select-all').textContent = shownAll ? 'Deselect all' : 'Select all';
  $('select-all').disabled = selectable.length === 0;

  const plan = history.selectAllPlan(state.log.selectable, state.log.selected);
  $('log-select-all').textContent = plan.mode === 'deselect' ? 'Deselect all' : 'Select all';
  $('log-select-all').disabled = plan.disabled;
}

/** The floating bar exists only while it has something to show. */
function syncToolbar() {
  const visible = !$('bulk-bar').hidden || !$('run-stack').hidden;
  $('toolbar').hidden = !visible;
  document.body.classList.toggle('has-toolbar', visible);

  // The scroller's bottom padding used to be a constant, because the toolbar was
  // one of two fixed heights. A stack of bars is neither, so the measurement is
  // published and the padding is computed from it — the last row still has to be
  // scrollable clear of the bar however many operations are queued.
  document.body.style.setProperty(
    '--toolbar-h', visible ? `${$('toolbar').offsetHeight}px` : '0px'
  );
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
  clearLogSelection();
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
    // land in the log, and a harvest pushes a note per account — so the claims
    // have to be reapplied on every render, not just when they change. One map,
    // read here and in `selectable` below: the two used to be separate readings
    // of the same rule and drifted, and a repaint mid-harvest silently handed
    // the checkboxes back.
    claimed: state.claims.log,
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
  // Hidden by mountHarvest when the harvest takes this slot, so this write is a
  // no-op in the full build and the count only surfaces in the store one.
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
  // you do not mean by "all". Ticking one by hand still works. Claimed rows come
  // out too, and unlike a note that is not a preference: a job is holding them
  // and they cannot be ticked at all.
  state.log.selectable = [...new Set(state.log.followable.map((record) => record.userId))]
    .filter((id) => !state.log.skipNotes[id] && !state.claims.log.has(id));

  updateBulkBar();
}

/** Queue a follow-back for everyone selected in the log. */
async function enqueueFollowBack() {
  const targets = state.log.followable.filter((record) => state.log.selected.has(record.userId));
  // One row per account: the same person can appear twice if they were
  // accepted, unfollowed and accepted again.
  const unique = [...new Map(targets.map((record) => [record.userId, record])).values()]
    .filter((record) => !state.claims.log.has(record.userId));
  if (unique.length === 0) return;

  const plural = unique.length === 1 ? '' : 's';
  const waiting = jobs.jobs.length;
  const confirmed = await confirmAction({
    title: `Follow back ${unique.length} account${plural}?`,
    body: `Follows ${unique.length} account${plural} you previously accepted. Private accounts become a follow request.`
      + queuedBehind(waiting),
  });
  if (!confirmed) return;

  // Out of the selection and onto the job, so the log's own select-all and the
  // bulk bar both stop counting rows that are now somebody else's.
  for (const record of unique) state.log.selected.delete(record.userId);

  jobs.enqueue({
    kind: 'followBack',
    scope: 'log',
    ids: unique.map((record) => record.userId),
    // Carried on the job rather than looked up when it runs. A job can sit
    // queued for minutes behind others, and in that time the log can be cleared,
    // filtered or paged out from under the rows it is holding.
    names: new Map(unique.map((record) => [record.userId, record.username])),
  });
  recomputeLog();
}

/** One follow, plus the log record that stops the row offering it again. */
async function followOnce(job, userId) {
  const result = await api.call('follow', { userId });
  if (!result?.ok) return result || { ok: false, error: 'no response' };

  // Taken in hand rather than left to the storage change, so the row stops
  // offering a follow-back even if the write to the log fails. They were
  // followed either way, and the log failing is not their problem.
  const username = job.names?.get(userId) || '';
  absorbLogRecords([logAction({ id: userId, username }, history.FOLLOW)]);
  state.log.selected.delete(userId);
  return result;
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
          `"Already follow" may be out of date. ${describeError(err)}`,
          { detail: errorDetail(err) }
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
    onFinish: async ({ halted, haltReason, haltStatus, stopped, failures }) => {
      await store.saveProfiles(fresh);
      state.hydrationQueue = null;
      state.hydrationProgress = null;
      syncHydration();

      if (halted) {
        const halt = haltError(halted, haltReason, haltStatus);
        showBanner(`Enrichment stopped. ${describeError(halt)}`, { detail: errorDetail(halt) });
      } else if (stopped) setStatus('Enrichment stopped.');
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

/** The one clause a confirm gains when the press will not act immediately. */
function queuedBehind(count) {
  return count === 0 ? '' : ` Queued behind ${count} operation${count === 1 ? '' : 's'}.`;
}

async function enqueueBulk(action) {
  const ids = [...state.selected]
    .filter((id) => !state.doneIds.has(id) && !state.claims.requests.has(id));
  if (ids.length === 0) return;

  const spec = ACTIONS[action];
  const plural = ids.length === 1 ? '' : 's';
  const waiting = jobs.jobs.length;
  const confirmed = await confirmAction({
    title: `${spec.label} ${ids.length} request${plural}?`,
    body:
      (action === 'approveFollow'
        ? `Accept ${ids.length} request${plural} and follow each one back. Two writes per person, so it takes roughly twice as long as a plain accept.`
        : `${spec.label} ${ids.length} of ${state.visible.length} shown, with the current filters applied.`)
      + queuedBehind(waiting),
    warn: action === 'ignore',
  });
  if (!confirmed) return;

  // Out of the selection and onto the job. This one move is what queueing
  // actually consists of: the bulk bar empties, those rows go inert under the
  // job's claim, and every other row is free to be picked for the next one.
  for (const id of ids) state.selected.delete(id);
  renderer.setSelection(state.selected);

  jobs.enqueue({ kind: action, scope: 'requests', ids });
  updateBulkBar();
}

/**
 * Perform one job. Handed to the JobList, which decides when — never more than
 * one of these is in flight, whatever is queued behind it.
 */
function runJob(job) {
  // Whatever the last run left standing is not about this one — and if it was a
  // pause, this run only exists because it was resumed.
  hideBanner();

  // A guest brought its own way of doing the work; this file's part was getting
  // it to the front of the list. It reports through the same outcome envelope,
  // so a guest that gets rate limited pauses the pipeline like any other job.
  if (job.run) {
    return Promise.resolve(job.run(job)).then((outcome) => {
      job.stop = null;
      reportOutcome(job, outcome || {});
      return outcome || {};
    });
  }

  return new Promise((resolve) => {
    const queue = new ThrottledQueue({
      // A resumed job starts from what it still holds, not from what it was
      // handed: the items it already got through are gone from `remaining`, and
      // the one a block refused is still in it.
      items: [...job.remaining],
      pacing: PACING.moderate,
      handler: async (id) => {
        state.inFlightId = id;
        syncClaims();

        const result = job.scope === 'log'
          ? await followOnce(job, id)
          : await actOnce(id, job.kind);

        state.inFlightId = null;
        // Attempted counts as handled, plain failures included — that is what
        // the queue's own `failures` list has always meant. A block is the one
        // outcome that leaves the id in, so a resumed job still holds the
        // request Instagram would not take.
        if (!result?.blocked && !result?.loggedOut) jobs.handled(job, id);
        return result;
      },
      onProgress: () => {
        syncRunStack();
        syncClaims();
      },
      onFinish: (outcome) => {
        job.stop = null;
        state.inFlightId = null;
        reportOutcome(job, outcome);
        resolve(outcome);
      },
    });

    job.stop = () => queue.stop();
    syncRunStack();
    syncClaims();
    queue.run();
  });
}

/** What is left to say once a job's bar has gone. */
function reportOutcome(job, { halted, haltReason, haltStatus, stopped, failures = [] }) {
  const done = jobs.done(job);

  if (halted) {
    // Paused rather than stopped, and the wording has to carry that: the rows
    // this job never reached are still held, and everything queued behind it is
    // still queued. The banner is where the way back out lives.
    const halt = haltError(halted, haltReason, haltStatus);
    showBanner(
      `Paused after ${done} of ${job.total}. ${describeError(halt)}`,
      { paused: true, detail: errorDetail(halt) }
    );
  } else if (job.run) {
    // Every other branch below writes to the panel's status line, and a guest
    // has already written its own — a fuller one, since it knows what its work
    // produced and this only knows how many items went by. The halt above is
    // the exception it does not own: pausing the pipeline is this file's to
    // report, because what it stops is every job behind it too.
    recomputeLog();
    return;
  } else if (stopped) {
    setStatus(`Stopped after ${done} of ${job.total}.`);
  } else if (failures.length) {
    setStatus(`Done, ${failures.length} failed.`);
  } else {
    // A clean run says nothing: every row it touched marked itself and left the
    // list, and the log holds the tally for as long as anyone wants it.
    setStatus('');
  }

  if (job.scope === 'log') {
    recomputeLog();
    return;
  }

  // The pending list on Instagram's side has changed; drop the snapshot so the
  // next Refresh refetches instead of resurrecting handled requests.
  store.clearSnapshot();
  recompute();
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
 * forms the menu uses: "<10" is strict and steps in by one to reach the
 * inclusive bounds applyFilters works in, while "10+" already is one. "0" is
 * not a bound at all but its own predicate, and an enriched-only one: an
 * absent social_context is not evidence of zero.
 */
function readMutualsFilter(value) {
  const under = /^<(\d+)$/.exec(value);
  const atLeast = /^(\d+)\+$/.exec(value);

  let minMutuals = 0;
  let maxMutuals = null;
  if (atLeast) minMutuals = Number(atLeast[1]);
  else if (under) maxMutuals = Number(under[1]) - 1;

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
      clearLogSelection();
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

  // Shift-clicking a list is also how the browser is told to drag a text
  // selection across it, and it does that on mousedown. Suppressed before it
  // starts rather than cleared afterwards, which leaves a frame of blue.
  list.addEventListener('mousedown', (event) => {
    if (event.shiftKey && event.target.closest('.log-row')) event.preventDefault();
  });

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
    if (!row.classList.contains('is-selectable')) return;

    const checkbox = row.querySelector('.log-check');
    if (checkbox.disabled) return;

    // A click on the checkbox has already toggled it by the time this runs; a
    // click anywhere else in the row is the toggle.
    const onCheckbox = Boolean(event.target.closest('.log-check'));
    const checked = onCheckbox ? checkbox.checked : !checkbox.checked;

    if (event.shiftKey) return selectLogRange(row.dataset.id, checked);

    state.log.anchorId = row.dataset.id;
    // Its own change event follows and does the work; toggling here as well
    // would cancel it out.
    if (onCheckbox) return;

    checkbox.checked = checked;
    toggleLogSelection(row.dataset.id, checked);
  });

  $('log-select-all').addEventListener('click', () => {
    const { next } = history.selectAllPlan(state.log.selectable, state.log.selected);

    // A wholesale replacement, so the anchor goes with it — see
    // clearLogSelection, which is also where the mutate-in-place rule lives.
    clearLogSelection();
    for (const id of next) state.log.selected.add(id);
    recomputeLog();
  });

  $('bulk-follow-back').addEventListener('click', () => enqueueFollowBack());

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
    clearLogSelection();
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

/**
 * Drop the log's selection and the point a shift-click measures from.
 *
 * The two go together: an anchor is the last row you picked, and it means
 * nothing once the picks it belonged to are gone. Cleared in place rather than
 * reassigned — renderLog was handed this Set and the harvest reads it through a
 * closure, so swapping the object would leave both holding the old selection.
 */
function clearLogSelection() {
  state.log.selected.clear();
  state.log.anchorId = null;
}

function applyLogSelection(userId, checked) {
  if (checked) state.log.selected.add(userId);
  else state.log.selected.delete(userId);

  // The same account can occupy more than one row; keep them consistent.
  for (const node of document.querySelectorAll(`.log-row[data-id="${CSS.escape(userId)}"]`)) {
    const box = node.querySelector('.log-check');
    if (box) box.checked = checked;
    node.classList.toggle('is-selected', checked);
  }
}

function toggleLogSelection(userId, checked) {
  applyLogSelection(userId, checked);
  updateBulkBar();
}

/**
 * Give every row between the anchor and `userId` the state the clicked one just
 * took — Gmail's rule, and the one the gesture is borrowed from.
 *
 * Measured over the rows on screen, deduplicated: one account can hold two rows
 * — accepted, then followed back later — and a range is over accounts, not over
 * rows, because that is what the selection is. Rows with nothing to follow back
 * carry no checkbox and are simply not in the list; a range that refused to
 * cross one would be a range that stops for no visible reason.
 *
 * Already-harvested rows are in it. They are left out of `Select all` because
 * they are not worth ticking by default, and picking one out by hand has always
 * been allowed — which is exactly what this is.
 *
 * The bulk bar is updated once at the end rather than per row: a range can be
 * the whole page, and each update walks the visible list.
 */
function selectLogRange(userId, checked) {
  const rows = $('log-list').querySelectorAll('.log-row.is-selectable');
  const ordered = [...new Set([...rows].map((node) => node.dataset.id))];

  for (const id of rangeIds(ordered, state.log.anchorId, userId)) {
    applyLogSelection(id, checked);
  }
  state.log.anchorId = userId;
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
  runStack = new RunStack({
    container: $('run-stack'),
    // One button per bar, and which one it is follows from that bar's state —
    // Stop on the running or paused job, Cancel on one still waiting. Both mean
    // the same thing to the list: drop it and let its rows go. Every bar is a
    // job now, including the harvest's, so there is no longer a second case.
    onButton: (id) => jobs.drop(id),
  });

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

  // A Stop per meter, each stopping the queue its own label is counting — there
  // is never a shared one that would have to guess. Hydration's is unambiguous
  // because nothing else reports beside it; the stack's live on the bars, one
  // each, so they cannot mean anything but the line they sit on.
  $('stop-hydration').addEventListener('click', () => state.hydrationQueue?.stop());

  $('banner-resume').addEventListener('click', () => jobs.resume());
  $('banner-cancel-all').addEventListener('click', () => jobs.cancelAll());

  bindLog();

  $('select-all').addEventListener('click', () => {
    // Deselect clears the whole selection, not just what is shown: rows picked
    // under an earlier filter are still selected and still counted by the
    // toolbar, so leaving them behind would contradict the word "all".
    const selectable = selectableRows();
    const shownAll = selectable.length > 0
      && selectable.every((row) => state.selected.has(row.id));
    if (shownAll) state.selected.clear();
    else for (const row of selectable) state.selected.add(row.id);

    renderer.setSelection(state.selected);
    updateBulkBar();
  });

  for (const [buttonId, action] of Object.entries(BULK_BUTTONS)) {
    $(buttonId).addEventListener('click', () => enqueueBulk(action));
  }

  $('bulk-clear').addEventListener('click', () => {
    if (state.mode === 'log') {
      clearLogSelection();
      return recomputeLog();
    }
    state.selected.clear();
    renderer.setSelection(state.selected);
    updateBulkBar();
  });

  $('banner-dismiss').addEventListener('click', hideBanner);
  $('banner-detail').addEventListener('click', () => showErrorDetail($('banner-detail').dataset.detail));

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

  // The pipeline is doing irreversible writes; make closing the panel mid-run a
  // deliberate act rather than an accident. Anything queued counts, not just
  // what is running — closing on a queue of three loses all three, and a paused
  // one is the easiest of the lot to forget about.
  window.addEventListener('beforeunload', (event) => {
    if (jobs.busy) event.preventDefault();
  });

  // #region harvest — build.js deletes this region from the store package
  // Deleting this call plus src/harvest/ removes the harvest feature entirely.
  // It reads the log selection through a closure and takes its turn in the
  // pipeline through guestRun rather than importing panel state, so nothing here
  // depends on the feature existing — mountHarvest defaults guestRun to running
  // straight away if a future caller omits it, so this call is not load-bearing
  // either.
  //
  // That removal is what the store build does: `npm run build` strips both
  // #region harvest blocks in this file, so the published package can ship
  // without asking for the `downloads` permission the harvest needs.
  mountHarvest({
    selectedLogEntries: () =>
      state.log.visible.filter((record) => state.log.selected.has(record.userId)),
    confirmAction,
    queueRun: (options) => guestRun.enqueue(options),
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
  // Ids the on-page banner (or a previous instance of this panel) already
  // handled. Without this, a row it purged while this document wasn't open
  // to catch the storage event comes right back until the next Refresh.
  state.doneIds = await store.loadHandledIds();
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
