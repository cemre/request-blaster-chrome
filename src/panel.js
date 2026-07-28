// panel.js — side panel wiring.
//
// Owns all state and both throttle queues. Being a real document, it stays
// alive as long as the panel is open, which is exactly as long as any of this
// work should be running.

import * as api from './api.js';
import * as history from './history.js';
import * as store from './store.js';
import { PACING, ThrottledQueue } from './queue.js';
import { ListRenderer, renderLog } from './render.js';
import {
  DEFAULT_FILTERS,
  applyFilters,
  countHiddenByUnknownMutuals,
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
  loading: false,

  // 'requests' | 'log'. The log is loaded lazily and only ever holds the day
  // shards actually asked for.
  mode: 'requests',
  log: {
    index: [],
    loadedDays: 0,
    records: [],
    visible: [],
    followable: [],
    selected: new Set(),
    kind: 'all',
    search: '',
  },
};

let renderer;

// ---------------------------------------------------------------- messaging

/** 'loading' | 'ready' | 'error' — CSS gates the working UI on this. */
function setState(next) {
  document.body.dataset.state = next;
}

function setStatus(text) {
  $('status').textContent = text || '';
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
  state.visible = sortRows(applyFilters(live, state.filters), state.settings.sort);

  renderer.setRows(state.visible);
  renderer.setSelection(state.selected);

  $('total-count').textContent = String(live.length);
  $('shown-count').textContent =
    state.visible.length === live.length
      ? `${live.length} shown`
      : `${state.visible.length} of ${live.length} shown`;

  // Anything a filter hides for want of data rather than for failing the test
  // gets said out loud, so "no results" never quietly means "not loaded yet".
  const unenriched = live.filter((row) => !row.enriched).length;
  const unknownMutuals = countHiddenByUnknownMutuals(live, state.filters);
  const warning = $('enriched-warning');

  if (usesEnrichedFilters(state.filters) && unenriched > 0) {
    // These filters hide every un-enriched row, which already includes every
    // row with an unknown mutual count — one message covers both.
    warning.textContent = `${unenriched} request${unenriched === 1 ? '' : 's'} not yet enriched and therefore hidden by these filters.`;
    warning.hidden = false;
  } else if (unknownMutuals > 0) {
    warning.textContent = `${unknownMutuals} request${unknownMutuals === 1 ? '' : 's'} hidden: Instagram did not report a mutual count for them. Load their details to check.`;
    warning.hidden = false;
  } else {
    warning.hidden = true;
  }

  updateHydrationLabel();
  updateBulkBar();
}

function updateHydrationLabel() {
  const live = state.rows.filter((row) => !state.doneIds.has(row.id));
  const enriched = live.filter((row) => row.enriched).length;
  $('hydration-label').textContent = `${enriched} / ${live.length} details loaded`;
  $('hydration-bar').style.width = live.length ? `${(enriched / live.length) * 100}%` : '0%';

  // Hydration only ever touches what is in view, so the button has to count the
  // same set — otherwise the enriched-only filters can leave it offering work
  // that runHydrationBatch would then decline to do.
  const missingInView = state.visible.filter((row) => !row.enriched).length;
  const next = Math.min(missingInView, state.settings.batchSize);
  const button = $('load-batch');
  button.textContent = missingInView === 0 ? 'All loaded' : `Load ${next}`;
  button.disabled = state.loading || missingInView === 0 || Boolean(state.hydrationQueue);
}

function updateBulkBar() {
  const count = state.mode === 'log' ? state.log.selected.size : state.selected.size;
  const running = Boolean(state.actionQueue);

  $('bulk-bar').hidden = count === 0 || running;
  $('bulk-count').textContent = `${count} selected`;
  syncToolbar();
}

/** The floating bar exists only while it has something to show. */
function syncToolbar() {
  const visible = !$('bulk-bar').hidden || !$('action-progress').hidden;
  $('toolbar').hidden = !visible;
  document.body.classList.toggle('has-toolbar', visible);
}

function rebuildRows() {
  state.rows = mergeRows(state.pendingUsers, state.statuses, state.cache);
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
  $('select-all').checked = false;
  $('log-select-all').checked = false;
  renderer.setSelection(state.selected);

  if (mode === 'log' && state.log.loadedDays === 0) loadLogPage();
  else if (mode === 'log') recomputeLog();
  else recompute();
}

/** Pull the next page of day shards. The log is never loaded whole. */
async function loadLogPage() {
  if (state.log.loadedDays === 0) {
    // Retention runs here rather than at startup, so opening the panel touches
    // the log not at all. A two-year window has no urgency.
    await store.pruneLog();
    state.log.index = await store.loadLogIndex();
  }

  const next = state.log.index.slice(state.log.loadedDays, state.log.loadedDays + LOG_PAGE_DAYS);
  if (next.length > 0) {
    state.log.records.push(...(await store.loadLogDays(next)));
    state.log.loadedDays += next.length;
  }
  recomputeLog();
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
    pacing: PACING[state.settings.pacing] || PACING.moderate,
    handler: async (record) => {
      const result = await api.call('follow', { userId: record.userId });
      if (!result?.ok) return result || { ok: false, error: 'no response' };

      // Push the same record into the in-memory copy so the row stops
      // offering a follow-back without needing to re-read the shard.
      state.log.records.push(logAction({ id: record.userId, username: record.username }, history.FOLLOW));
      state.log.selected.delete(record.userId);
      return result;
    },
    onProgress: ({ done, total }) => {
      $('action-label').textContent = `Following ${done} / ${total}…`;
    },
    onFinish: ({ halted, stopped, failures, done, total }) => {
      state.actionQueue = null;
      $('action-progress').hidden = true;

      if (halted) showBanner(`Stopped after ${done} of ${total} — Instagram returned "${halted}". Wait before retrying.`);
      else if (stopped) setStatus(`Stopped after ${done} of ${total}.`);
      else if (failures.length) setStatus(`Done, ${failures.length} failed.`);
      else setStatus(`Followed back ${done}.`);

      $('log-select-all').checked = false;
      recomputeLog();
    },
  });

  state.actionQueue = queue;
  $('action-label').textContent = `Following 0 / ${unique.length}…`;
  $('action-progress').hidden = false;
  updateBulkBar();

  await queue.run();
}

// --------------------------------------------------------------- bulk pass

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
      setLoadingText(`Checking follow status for ${users.length}…`);
      const statuses = await api.fetchFollowStatuses(
        users.map((user) => String(user.pk)),
        ({ done, total }) => setLoadingText(`Checking follow status ${done} / ${total}…`)
      );
      snapshot = { users, statuses, capped };
      await store.saveSnapshot(snapshot);
    }

    state.pendingUsers = snapshot.users;
    state.statuses = snapshot.statuses;
    state.capped = snapshot.capped;
    rebuildRows();

    // Instagram serves at most 200 pending requests and offers no cursor past
    // them. More only become visible once these are cleared.
    setStatus(
      state.capped
        ? `Instagram only exposes ${api.SERVER_PAGE_CAP} at a time — clear these, then Refresh for the next batch.`
        : ''
    );
    setState('ready');
    // Before recompute, not just in the finally: updateHydrationLabel reads
    // this flag, and leaving it set here left "Load details" disabled forever.
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
  $('stop-hydration').hidden = false;
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
    onProgress: async ({ done, total }) => {
      setStatus(`Enriching ${done} / ${total}…`);
      updateHydrationLabel();
      // Batch the disk writes; one flush per profile would be pointless churn.
      if (Object.keys(fresh).length - flushed >= 10) {
        flushed = Object.keys(fresh).length;
        await store.saveProfiles(fresh);
      }
    },
    onFinish: async ({ halted, stopped, failures }) => {
      await store.saveProfiles(fresh);
      state.hydrationQueue = null;
      $('stop-hydration').hidden = true;

      if (halted) showBanner(`Enrichment stopped — Instagram returned "${halted}". Wait a while before retrying.`);
      else if (stopped) setStatus('Enrichment stopped.');
      else if (failures.length) setStatus(`Enriched with ${failures.length} failure${failures.length === 1 ? '' : 's'}.`);
      else setStatus('');

      recompute();
    },
  });

  state.hydrationQueue = queue;
  updateHydrationLabel();
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

/** Half the between-item gap, so the follow rides the same pacing setting. */
function followGap() {
  const pacing = PACING[state.settings.pacing] || PACING.moderate;
  return (pacing.min + Math.random() * (pacing.max - pacing.min)) / 2;
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
    pacing: PACING[state.settings.pacing] || PACING.moderate,
    handler: (id) => actOnce(id, action),
    onProgress: ({ done, total }) => {
      $('action-label').textContent = `${spec.gerund} ${done} / ${total}…`;
    },
    onFinish: ({ halted, stopped, failures, done, total }) => {
      state.actionQueue = null;
      $('action-progress').hidden = true;

      if (halted) showBanner(`Stopped after ${done} of ${total} — Instagram returned "${halted}". Wait before retrying.`);
      else if (stopped) setStatus(`Stopped after ${done} of ${total}.`);
      else if (failures.length) setStatus(`Done, ${failures.length} failed.`);
      else setStatus(`${spec.done} ${done}.`);

      // The pending list on Instagram's side has changed; drop the snapshot so
      // the next Refresh refetches instead of resurrecting handled requests.
      store.clearSnapshot();
      recompute();
    },
  });

  state.actionQueue = queue;
  $('action-label').textContent = `${spec.gerund} 0 / ${ids.length}…`;
  $('action-progress').hidden = false;
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

function readFilters() {
  const rawMax = $('f-max-followers').value;
  state.filters = {
    onlyFollowing: $('f-following').checked,
    minMutuals: Number($('f-mutuals').value),
    maxFollowers: rawMax === '' ? null : Number(rawMax),
    zeroPosts: $('f-zero-posts').checked,
    emptyBio: $('f-empty-bio').checked,
    defaultPic: $('f-default-pic').checked,
    botRatio: $('f-bot-ratio').checked,
    search: $('search').value,
  };
  $('select-all').checked = false;
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
      $('log-select-all').checked = false;
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
      return api.navigateToProfile(rowUsername(row)).catch(reportError);
    }
    if (event.target.closest('.log-check') || !row.classList.contains('is-selectable')) return;

    const checkbox = row.querySelector('.log-check');
    checkbox.checked = !checkbox.checked;
    toggleLogSelection(row.dataset.id, checkbox.checked);
  });

  $('log-select-all').addEventListener('change', () => {
    const checked = $('log-select-all').checked;
    state.log.selected.clear();
    if (checked) for (const record of state.log.followable) state.log.selected.add(record.userId);
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
    state.log.index = [];
    state.log.loadedDays = 0;
    state.log.records = [];
    state.log.selected.clear();
    $('log-select-all').checked = false;
    recomputeLog();
    setStatus('Log cleared.');
  });
}

/** The username shown on a log row, read back off the rendered node. */
function rowUsername(row) {
  return row.querySelector('.log-user').textContent.replace(/^@/, '');
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

function bind() {
  renderer = new ListRenderer({
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

  $('sort').addEventListener('change', async () => {
    state.settings.sort = $('sort').value;
    await store.saveSettings(state.settings);
    recompute();
  });

  $('pacing').addEventListener('change', async () => {
    state.settings.pacing = $('pacing').value;
    await store.saveSettings(state.settings);
  });

  const reload = async () => {
    await store.clearSnapshot();
    state.doneIds.clear();
    state.selected.clear();
    await loadPending({ useSnapshot: false });
  };

  $('refresh').addEventListener('click', reload);
  $('banner-retry').addEventListener('click', reload);

  $('load-batch').addEventListener('click', () => runHydrationBatch());
  $('stop-hydration').addEventListener('click', () => state.hydrationQueue?.stop());
  $('action-stop').addEventListener('click', () => state.actionQueue?.stop());

  bindLog();

  $('select-all').addEventListener('change', () => {
    if ($('select-all').checked) for (const row of state.visible) state.selected.add(row.id);
    else state.selected.clear();
    renderer.setSelection(state.selected);
    updateBulkBar();
  });

  for (const [buttonId, action] of Object.entries(BULK_BUTTONS)) {
    $(buttonId).addEventListener('click', () => runBulk(action));
  }

  $('bulk-clear').addEventListener('click', () => {
    if (state.mode === 'log') {
      state.log.selected.clear();
      $('log-select-all').checked = false;
      return recomputeLog();
    }
    state.selected.clear();
    $('select-all').checked = false;
    renderer.setSelection(state.selected);
    updateBulkBar();
  });

  $('banner-dismiss').addEventListener('click', hideBanner);

  // The on-page banner writes handled ids to session storage; mirror them so
  // a profile accepted on the page disappears from the list here too.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'session' || !changes[store.HANDLED_KEY]) return;
    absorbHandledIds(changes[store.HANDLED_KEY].newValue || []);
  });

  // An in-flight action queue is doing irreversible writes; make closing the
  // panel mid-run a deliberate act rather than an accident.
  window.addEventListener('beforeunload', (event) => {
    if (state.actionQueue) event.preventDefault();
  });
}

async function init() {
  state.settings = await store.loadSettings();
  state.cache = await store.loadProfileCache();

  bind();
  $('sort').value = state.settings.sort;
  $('pacing').value = state.settings.pacing;
  setMode('requests');

  await loadPending();
}

init().catch(reportError);
