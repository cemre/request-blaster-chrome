// panel.js — side panel wiring.
//
// Owns all state and both throttle queues. Being a real document, it stays
// alive as long as the panel is open, which is exactly as long as any of this
// work should be running.

import * as api from './api.js';
import * as store from './store.js';
import { PACING, ThrottledQueue } from './queue.js';
import { ListRenderer } from './render.js';
import {
  DEFAULT_FILTERS,
  applyFilters,
  mergeRows,
  sortRows,
  toCachedProfile,
  usesEnrichedFilters,
} from './model.js';

const $ = (id) => document.getElementById(id);

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

  const unenriched = live.filter((row) => !row.enriched).length;
  const warning = $('enriched-warning');
  if (usesEnrichedFilters(state.filters) && unenriched > 0) {
    warning.textContent = `${unenriched} request${unenriched === 1 ? '' : 's'} not yet enriched and therefore hidden by these filters.`;
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
  $('hydration-label').textContent = `${enriched} / ${live.length} enriched`;
  $('hydration-bar').style.width = live.length ? `${(enriched / live.length) * 100}%` : '0%';
  $('load-batch').disabled = state.loading || enriched >= live.length || Boolean(state.hydrationQueue);
}

function updateBulkBar() {
  const count = state.selected.size;
  $('bulk-bar').hidden = count === 0;
  $('bulk-count').textContent = `${count} selected`;
  $('bulk-accept').textContent = `Accept ${count}`;
  $('bulk-reject').textContent = `Reject ${count}`;
}

function rebuildRows() {
  state.rows = mergeRows(state.pendingUsers, state.statuses, state.cache);
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

function markDone(id, verb) {
  state.doneIds.add(id);
  state.selected.delete(id);
  renderer.markRow(id, verb === 'approve' ? 'accepted' : 'rejected', verb === 'approve' ? 'Accepted' : 'Rejected');
  setTimeout(() => renderer.removeRow(id), 700);
}

async function actOnce(id, verb) {
  const row = state.rows.find((candidate) => candidate.id === id);
  if (!row) return { ok: false, error: 'row not found' };

  renderer.markRow(id, 'busy', verb === 'approve' ? 'Accepting…' : 'Rejecting…');
  const result = await api.call(verb, { userId: id });

  if (result?.ok) {
    markDone(id, verb);
  } else if (result?.blocked) {
    renderer.markRow(id, 'failed', 'Rate limited');
  } else {
    renderer.markRow(id, 'failed', result?.error || 'Failed');
  }
  return result || { ok: false, error: 'no response' };
}

async function runBulk(verb) {
  if (state.actionQueue) return;

  const ids = [...state.selected].filter((id) => !state.doneIds.has(id));
  if (ids.length === 0) return;

  const noun = verb === 'approve' ? 'Accept' : 'Reject';
  const confirmed = await confirmAction({
    title: `${noun} ${ids.length} request${ids.length === 1 ? '' : 's'}?`,
    body: `${noun} ${ids.length} of ${state.visible.length} shown, with the current filters applied.`,
    warn: verb === 'ignore',
  });
  if (!confirmed) return;

  hideBanner();
  $('action-progress').hidden = false;

  const queue = new ThrottledQueue({
    items: ids,
    pacing: PACING[state.settings.pacing] || PACING.moderate,
    handler: (id) => actOnce(id, verb),
    onProgress: ({ done, total }) => {
      $('action-label').textContent = `${noun}ing ${done} / ${total}…`;
    },
    onFinish: ({ halted, stopped, failures, done, total }) => {
      state.actionQueue = null;
      $('action-progress').hidden = true;

      if (halted) showBanner(`Stopped after ${done} of ${total} — Instagram returned "${halted}". Wait before retrying.`);
      else if (stopped) setStatus(`Stopped after ${done} of ${total}.`);
      else if (failures.length) setStatus(`Done, ${failures.length} failed.`);
      else setStatus(`${noun}ed ${done}.`);

      // The pending list on Instagram's side has changed; drop the snapshot so
      // the next Refresh refetches instead of resurrecting handled requests.
      store.clearSnapshot();
      recompute();
    },
  });

  state.actionQueue = queue;
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

function bind() {
  renderer = new ListRenderer({
    container: $('list'),
    sentinel: $('sentinel'),
    handlers: {
      onAccept: (id) => actOnce(id, 'approve'),
      onReject: (id) => actOnce(id, 'ignore'),
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

  $('select-all').addEventListener('change', () => {
    if ($('select-all').checked) for (const row of state.visible) state.selected.add(row.id);
    else state.selected.clear();
    renderer.setSelection(state.selected);
    updateBulkBar();
  });

  $('bulk-accept').addEventListener('click', () => runBulk('approve'));
  $('bulk-reject').addEventListener('click', () => runBulk('ignore'));
  $('bulk-clear').addEventListener('click', () => {
    state.selected.clear();
    $('select-all').checked = false;
    renderer.setSelection(state.selected);
    updateBulkBar();
  });

  $('banner-dismiss').addEventListener('click', hideBanner);

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

  await loadPending();
}

init().catch(reportError);
