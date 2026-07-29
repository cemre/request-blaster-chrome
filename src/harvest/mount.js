// mount.js — the harvest feature's one seam into the side panel.
//
// Self-contained like banner.js: injects its own markup and styles, owns its
// own state and listeners, and is referenced by nothing else in the panel
// beyond the mountHarvest() call. Deleting that call plus this directory
// removes the feature entirely.

import { suppressDownloadUi } from './batch.js';
import { collectCandidates, runHarvest } from './harvest.js';
import { candidatesFromLogEntries, harvestNotes } from './model.js';
import { loadHarvested } from './store.js';

const IDLE_STATUS = 'Harvest profiles for follow-back review';

// This feature runs for hours against a private API and writes to disk, so
// every step says what it did. A harvest that goes quiet is the failure mode
// worth optimising for — twice now a silent one has been mistaken for a
// working one.
const log = (...args) => console.log('[Harvest]', ...args);
const logError = (...args) => console.error('[Harvest]', ...args);

const $ = (id) => document.getElementById(id);

const STYLE_ID = 'harvest-styles';

const STYLES = `
  .harvest {
    padding: 7px var(--gap);
    border-bottom: 1px solid var(--border);
  }

  .harvest-line {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12px;
    color: var(--text-secondary);
  }

  .harvest-line span { flex: 1; font-variant-numeric: tabular-nums; }

  body[data-mode='requests'] .harvest { display: none !important; }

  /* sidepanel.css lights up the row a bulk action is currently writing to
     (body.is-acting .row.is-busy) against its dimmed neighbours; the log has
     no equivalent, and this run acts on the log. Kept here rather than added
     to that shared rule so it leaves with the feature. */
  body.is-acting #log-list .log-row.is-busy { opacity: 1; }
`;

// Module-level rather than closed over some caller's state object: the
// beforeunload guard below needs to see an in-flight harvest, and this is the
// only place that still tracks one.
let activeHarvest = null;

function injectStyles() {
  if ($(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = STYLES;
  document.head.appendChild(style);
}

// Idle-state row only: Stop now lives on the shared meter, which is reachable
// from anywhere in the panel rather than only from this row in the Log tab.
function buildMarkup() {
  const el = document.createElement('div');
  el.id = 'harvest';
  el.className = 'harvest';
  el.innerHTML = `
    <div class="harvest-line">
      <span id="harvest-status">${IDLE_STATUS}</span>
      <label class="toggle-chip" title="Sweep every follower you don't follow back, instead of only the rows ticked below">
        <input type="checkbox" id="harvest-all">
        <span>All followers</span>
      </label>
      <button id="harvest-start" class="btn btn-small" title="Fetch profile data and contact sheets into your Downloads folder">Harvest</button>
    </div>`;
  return el;
}

/**
 * Every follower the viewer does not follow back, plus everyone they accepted
 * and never followed. Costs a full follower sweep plus a show_many pass.
 *
 * Returns null when there is nothing to do, having already said why.
 */
async function planAllFollowers(setStatus) {
  const { candidates, unknown, capped } = await collectCandidates(({ message }) => setStatus(message));

  if (candidates.length === 0) {
    setStatus('Nothing new to harvest.');
    return null;
  }

  const unknownNote = unknown.length
    ? ` ${unknown.length} had no follow status and were skipped.`
    : '';
  // Mirrors how the pending list's own cap is surfaced (cap-note, above):
  // a standing fact about the data the user has to know before starting,
  // not something to discover after a truncated batch.
  const cappedNote = capped
    ? ' Your followers list is large enough that Instagram\'s page cap was hit — this batch will miss some followers.'
    : '';
  return { candidates, note: unknownNote + cappedNote };
}

/**
 * Only the log rows the user ticked.
 *
 * Costs no API calls at all to plan: a log row already carries the id and
 * username a harvest needs, so this skips the follower sweep entirely.
 *
 * Already-harvested rows are left out of select-all but can still be ticked by
 * hand — that is the only way to redo one — so this is the path a redo arrives
 * on, and the confirm has to name how many of them there are. A stray tick on a
 * row already marked is otherwise invisible until the batch has paid for it.
 */
async function planSelection(setStatus, selectedLogEntries) {
  const entries = selectedLogEntries();
  const candidates = candidatesFromLogEntries(entries);
  log(`selection: ${entries.length} ticked row(s) -> ${candidates.length} account(s)`, candidates);

  if (candidates.length === 0) {
    setStatus('Tick rows below to harvest them, or turn on All followers.');
    return null;
  }

  const harvested = await loadHarvested();
  const redos = candidates.filter((candidate) => harvested[candidate.pk]).length;
  const note = redos
    ? ` ${redos} of these ${redos === 1 ? 'was' : 'were'} harvested before and will be fetched again.`
    : '';

  return { candidates, note };
}

/**
 * Highlight every log row for the account currently being harvested, and only
 * that account. One person can carry two rows — accepted, then followed back
 * later — so every match gets the class, not just the first; and the previous
 * mark is cleared first rather than trusted to still be the only one, because
 * the log repaints mid-run (a follow-back or a fresh accept lands in it),
 * which rebuilds every row and drops whatever class this applied to it. Hence
 * re-applying on every tick rather than assuming last tick's mark survived.
 */
function markActiveLogRow(pk) {
  for (const node of document.querySelectorAll('#log-list .log-row.is-busy')) {
    node.classList.remove('is-busy');
  }
  for (const node of document.querySelectorAll(`#log-list .log-row[data-id="${CSS.escape(String(pk))}"]`)) {
    node.classList.add('is-busy');
  }
}

function clearActiveLogRow() {
  for (const node of document.querySelectorAll('#log-list .log-row.is-busy')) {
    node.classList.remove('is-busy');
  }
}

/** Whether any of these ids currently has a row in the log. */
function hasLogRow(ids) {
  return ids.some((id) => id !== null && id !== undefined && id !== ''
    && document.querySelector(`#log-list .log-row[data-id="${CSS.escape(String(id))}"]`));
}

/**
 * Repaint the log's "Harvested" notes after an account lands.
 *
 * Read back from storage rather than assembled from what just finished:
 * harvestOne marks an account only on the paths that actually wrote files, and
 * a second copy of that decision here is how the two drift apart.
 *
 * Skipped unless the account has a log row, because every push repaints the
 * whole list and a backlog sweep is a thousand-odd followers who were never in
 * the log — that would be a full repaint every two seconds, for nothing.
 */
async function refreshNotes(skipNotes, ids) {
  if (!hasLogRow(ids)) return;
  try {
    skipNotes.set(harvestNotes(await loadHarvested()));
    // The repaint above rebuilt every row and dropped the mark on the one being
    // worked. Re-applied here rather than left to the next tick, which is a
    // pacing delay away.
    markActiveLogRow(ids[0]);
  } catch (err) {
    logError('could not refresh the harvested marks:', err);
  }
}

function bindControls(selectedLogEntries, confirmAction, externalRun, skipNotes) {
  function setHarvestStatus(message) {
    $('harvest-status').textContent = message;
  }

  // The buttons are bound FIRST, before anything optional. A previous revision
  // ran the label updater above this and a throw in it left the button on
  // screen but wired to nothing — indistinguishable from a broken feature.
  $('harvest-start').addEventListener('click', async () => {
    log('clicked. all-followers =', $('harvest-all')?.checked);
    $('harvest-start').disabled = true;
    try {
      const plan = $('harvest-all').checked
        ? await planAllFollowers(setHarvestStatus)
        : await planSelection(setHarvestStatus, selectedLogEntries);

      if (!plan) {
        log('nothing to harvest — stopping before the confirm');
        $('harvest-start').disabled = false;
        return;
      }
      const { candidates, note } = plan;
      log(`planned ${candidates.length} account(s); asking to confirm`);

      // The panel's own dialog, not window.confirm: Chrome suppresses native
      // JS dialogs in a side panel, so confirm() returns false immediately
      // without ever showing anything. That read as a harvest button that
      // planned the work and then quietly did nothing.
      //
      // Most of a real backlog is private accounts, which produce a JSON row
      // and no sheets. Saying so up front stops the result reading as failure.
      const confirmed = await confirmAction({
        title: `Harvest ${candidates.length} account${candidates.length === 1 ? '' : 's'}?`,
        body: 'Fetches each profile and up to 50 recent posts, and writes contact'
              + ' sheets to your Downloads folder. Private accounts are recorded'
              + ` but produce no photos.${note}`,
      });
      if (!confirmed) {
        log('cancelled at the confirm');
        setHarvestStatus(IDLE_STATUS);
        $('harvest-start').disabled = false;
        return;
      }

      setHarvestStatus('Starting…');
      log('starting; writing index.json first to prove the download path works');
      activeHarvest = await runHarvest({
        candidates,
        onProgress: ({ done, total, item, result }) => {
          // The status line keeps naming the account — the meter's label, below,
          // has no room for a username once the counter is in it.
          setHarvestStatus(`${done} / ${total} — @${item.username}`);
          // Phrased like the action and hydration queues' own labels
          // ("Rejecting 4 / 10…", "Enriching 40 / 100…") so the meter reads as
          // one running thing regardless of which queue is behind it.
          externalRun.update({ label: `Harvesting ${done} / ${total}…`, done, total });
          markActiveLogRow(item.pk);

          // Both ids: web_profile_info can resolve a username to a different
          // account than the followers list gave, and the log row holds the
          // one from the request that created it. Not awaited — this is a
          // repaint, and the queue's pacing is not waiting on it.
          refreshNotes(skipNotes, [item.pk, result?.pk]);
        },
        onFinish: ({ done, total, halted, stopped, failures, batchId, reviewableCounts }) => {
          $('harvest-start').disabled = false;
          activeHarvest = null;
          // Cleared in the same statement that restores the rest of the idle
          // UI: the meter reports an in-flight run, and there no longer is one.
          externalRun.finish();
          clearActiveLogRow();

          // Once at the end regardless of what the per-account refresh above
          // decided to skip: a backlog sweep marks a thousand accounts that had
          // no log row at the time, and some of them will have one by the time
          // the log is next opened.
          loadHarvested()
            .then((harvested) => skipNotes.set(harvestNotes(harvested)))
            .catch((err) => logError('could not refresh the harvested marks:', err));

          // A count of failures, always — reporting a bare "Done" while every
          // account silently failed is how a broken run passes for a good one.
          const failed = failures?.length ?? 0;
          const failedNote = failed ? ` ${failed} failed.` : '';

          // Most of a real backlog has no grid to fetch, so say what came back
          // rather than only how many rows ran — "7 profile-only" is a result,
          // and without naming it the batch reads as mostly-nothing.
          const grid = reviewableCounts?.grid ?? 0;
          const profileOnly = reviewableCounts?.['profile-only'] ?? 0;
          const mix = grid || profileOnly
            ? ` ${grid} with photos, ${profileOnly} profile-only.`
            : '';

          log('finished', { done, total, failed, batchId, reviewableCounts });
          // The meter reported the in-flight run and just cleared; this line
          // is what is left once it is gone, so it has to state the outcome
          // in full rather than trail off the way the meter's own label could.
          if (halted) setHarvestStatus(`Halted by Instagram after ${done}: ${halted}`);
          else if (stopped) setHarvestStatus(`Stopped at ${done} / ${total}.${mix}${failedNote}`);
          else setHarvestStatus(`Done — batch ${batchId}.${mix}${failedNote}`);
        },
      });
      // Registered so the meter's own Stop — now the only Stop this feature
      // has — can reach this run; seeded at 0/total for the same reason the
      // action and hydration queues seed themselves before their first tick,
      // rather than leaving the meter closed for the whole of a slow first item.
      externalRun.start(activeHarvest.queue, {
        label: `Harvesting 0 / ${candidates.length}…`,
        done: 0,
        total: candidates.length,
      });
      log('running. batch', activeHarvest?.batchId);
    } catch (err) {
      logError('failed:', err);
      setHarvestStatus(`Failed: ${err.message}`);
      $('harvest-start').disabled = false;
    }
  });

  // Everything below is a nicety. It runs after the buttons are already live,
  // and swallows its own failures, so a bug here can never disable them again.
  function updateSelectionLabel() {
    const button = $('harvest-start');
    if (!button) return;

    if ($('harvest-all')?.checked) {
      button.textContent = 'Harvest all';
      return;
    }
    const count = candidatesFromLogEntries(selectedLogEntries()).length;
    button.textContent = count ? `Harvest ${count}` : 'Harvest';
  }

  // Selection lives in the panel's state. Rather than subscribe to it — which
  // would widen this feature's single seam — recompute after anything that
  // could have changed it. `click` as well as `change`, because a log row
  // toggles its own checkbox programmatically and that fires no change event.
  let pending = false;
  const scheduleLabelUpdate = () => {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      try {
        updateSelectionLabel();
      } catch (err) {
        logError('could not update the button label:', err);
      }
    });
  };
  document.addEventListener('click', scheduleLabelUpdate);
  document.addEventListener('change', scheduleLabelUpdate);
  scheduleLabelUpdate();
}

function bindLifecycle() {
  // An in-flight harvest can be hours from done; make closing the panel
  // mid-run a deliberate act rather than an accident.
  window.addEventListener('beforeunload', (event) => {
    if (activeHarvest) event.preventDefault();
  });

  // The harvest queue itself dies with the page — nothing to stop here — but
  // suppressDownloadUi(true) is a standing chrome.downloads setting that
  // outlives this document unless something turns it back off. Closing the
  // panel mid-harvest is the expected way this runs, not a crash, so it has
  // to be the normal unwind path too, not just onFinish.
  window.addEventListener('pagehide', () => { suppressDownloadUi(false); });
}

/**
 * Safe to call once at panel start-up; a no-op if the anchor is missing.
 *
 * @param selectedLogEntries returns the log records currently ticked in the
 *   panel, as `{ userId, username, at }`. Passed in rather than read from the
 *   panel's state so this stays the feature's only seam — the panel does not
 *   import anything from here beyond mountHarvest itself.
 * @param confirmAction the panel's in-document dialog. Passed in for the same
 *   reason, and required: window.confirm is silently suppressed in a side
 *   panel, so there is no usable fallback to default to.
 * @param externalRun `{ start(queue, progress), update(progress), finish() }`
 *   folding this run into the panel's shared toolbar meter. Optional and
 *   defaulted to a no-op below, so this feature still mounts — with its own
 *   status line and no shared meter or Stop — if a caller does not supply one.
 * @param skipNotes `{ set(byId) }`, where `byId` is `{ [userId]: note }`. What
 *   this feature tells the log about accounts it has already written to a
 *   batch: the row shows the note and select-all leaves it alone. Optional and
 *   defaulted like externalRun — without it the marks are simply invisible,
 *   and the "All followers" sweep still skips them, since that has always been
 *   decided from storage rather than from the panel.
 */
export function mountHarvest({
  selectedLogEntries = () => [],
  confirmAction = async () => {
    logError('no confirmAction was provided — refusing to start a harvest that cannot be confirmed');
    return false;
  },
  externalRun = { start() {}, update() {}, finish() {} },
  skipNotes = { set() {} },
} = {}) {
  const anchor = document.querySelector('.log-controls');
  if (!anchor) {
    logError('not mounted: no .log-controls element to anchor to');
    return;
  }
  if ($('harvest')) {
    logError('not mounted: already mounted once');
    return;
  }

  injectStyles();
  anchor.insertAdjacentElement('afterend', buildMarkup());

  // A previous session that crashed or was force-closed mid-harvest can leave
  // this off for every download in the browser, not just that batch's — never
  // start a session assuming it was left in a good state.
  suppressDownloadUi(false);

  // Whatever earlier batches wrote, before the log is first opened. Not
  // awaited: mounting must not wait on storage, and the log is lazily loaded
  // anyway — this lands long before there is a row to put a note on.
  loadHarvested()
    .then((harvested) => skipNotes.set(harvestNotes(harvested)))
    .catch((err) => logError('could not load the harvested marks:', err));

  try {
    bindControls(selectedLogEntries, confirmAction, externalRun, skipNotes);
    bindLifecycle();
  } catch (err) {
    // A throw here leaves a button on screen wired to nothing, which is the
    // hardest kind of failure to recognise. Say so loudly.
    logError('mounted but FAILED TO BIND — the button will do nothing:', err);
    return;
  }

  log('mounted. Buttons:', Boolean($('harvest-start')),
      '| all-followers toggle:', Boolean($('harvest-all')));
}
