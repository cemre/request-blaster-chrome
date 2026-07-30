// render.js — windowed row rendering.
//
// A 1000+ row queue is too much to mount at once, so we render a window and
// extend it as the user scrolls. All user-controlled text goes in via
// textContent, never innerHTML — usernames and bios are attacker-controlled.

import { ACTION_LABELS, groupByDay } from './history.js';
import { formatCount, formatMutuals } from './model.js';
import { PLACEHOLDER, resolveAvatar } from './avatars.js';

const PAGE_SIZE = 60;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** A real button, so the profile is reachable by keyboard as well as click. */
function openTarget(tag, className, text, title) {
  const node = el(tag, className, text);
  node.dataset.action = 'open';
  node.title = title;
  if (tag === 'button') node.type = 'button';
  return node;
}

export class ListRenderer {
  constructor({ container, sentinel, handlers }) {
    this.container = container;
    this.sentinel = sentinel;
    this.handlers = handlers;
    this.rows = [];
    this.selected = new Set();
    this.rendered = 0;
    this.nodesById = new Map();
    this.claims = new Map();

    this.observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) this.extend();
      },
      { root: container.parentElement, rootMargin: '400px' }
    );
    this.observer.observe(sentinel);

    container.addEventListener('click', (event) => this.onClick(event));
    container.addEventListener('change', (event) => this.onChange(event));
  }

  onClick(event) {
    const row = event.target.closest('.row');
    if (!row) return;
    const { id } = row.dataset;

    if (event.target.closest('[data-action="open"]')) return this.handlers.onOpenProfile(id);

    // The checkbox fires its own change event and the click bubbles here too;
    // toggling again below would cancel it out.
    if (event.target.closest('.row-check')) return;

    // Acting is bulk-only, so the rest of the row is a selection target.
    const checkbox = row.querySelector('.row-check');
    if (!checkbox) return;
    checkbox.checked = !checkbox.checked;
    row.classList.toggle('is-selected', checkbox.checked);
    this.handlers.onToggleSelect(id, checkbox.checked);
  }

  onChange(event) {
    const checkbox = event.target.closest('.row-check');
    if (!checkbox) return;
    const row = checkbox.closest('.row');
    row.classList.toggle('is-selected', checkbox.checked);
    this.handlers.onToggleSelect(row.dataset.id, checkbox.checked);
  }

  /**
   * The rows a queue has laid claim to, as `Map<id, label>`.
   *
   * This is what replaced freezing the whole list: only the rows some job is
   * actually holding go inert, so a second selection can be built out of the
   * rest while the first is still running.
   *
   * CSS dims a claimed row and takes its pointer events, but that stops the
   * mouse only — Tab still reaches a checkbox and Space still ticks it. The
   * disabled attribute is the part that actually holds, so it is set here rather
   * than left to the stylesheet, and the map is remembered for rows the scroller
   * mounts partway through a run.
   *
   * A null label means "claimed, but leave the chip alone". The row being
   * written to right now is claimed and already carries `Accepting…` from
   * markRow; an unrelated repaint must not paint over that.
   */
  setClaims(claims) {
    this.claims = claims;
    for (const [id, node] of this.nodesById) this.applyClaim(id, node);
  }

  /** The status column, opened on demand — rows carry no buttons to fill it. */
  stateChip(node) {
    let chip = node.querySelector('.row-state');
    if (!chip) {
      chip = el('div', 'row-state');
      node.appendChild(chip);
    }
    node.classList.add('has-state');
    return chip;
  }

  applyClaim(id, node) {
    const claimed = this.claims.has(id);
    const checkbox = node.querySelector('.row-check');
    if (checkbox) checkbox.disabled = claimed;
    node.classList.toggle('is-claimed', claimed);

    const label = claimed ? this.claims.get(id) : null;
    if (label) {
      this.stateChip(node).textContent = label;
      node.dataset.chip = 'claim';
      return;
    }

    // A claim ending without the row being actioned — a cancelled job — has to
    // take its chip with it, or the row goes back to the list still labelled
    // with something that is no longer going to happen. A chip markRow wrote is
    // left alone: that row's claim ended because it was handled, and it is on
    // its way out with "Rejected" on it.
    if (!claimed && node.dataset.chip === 'claim') {
      node.querySelector('.row-state')?.remove();
      node.classList.remove('has-state');
      delete node.dataset.chip;
    }
  }

  setSelection(selected) {
    this.selected = selected;
    for (const [id, node] of this.nodesById) {
      const checkbox = node.querySelector('.row-check');
      if (checkbox) checkbox.checked = selected.has(id);
      node.classList.toggle('is-selected', selected.has(id));
    }
  }

  /** Replace the whole list — used when the filter or sort changes. */
  setRows(rows) {
    this.rows = rows;
    this.rendered = 0;
    this.nodesById.clear();
    this.container.textContent = '';
    this.extend();
  }

  extend() {
    if (this.rendered >= this.rows.length) return;

    const next = this.rows.slice(this.rendered, this.rendered + PAGE_SIZE);
    const fragment = document.createDocumentFragment();
    for (const row of next) {
      const node = this.buildRow(row);
      this.nodesById.set(row.id, node);
      fragment.appendChild(node);
    }
    this.container.appendChild(fragment);
    this.rendered += next.length;
  }

  /** Swap one row in place, e.g. when hydration fills in its details. */
  updateRow(row) {
    const existing = this.nodesById.get(row.id);
    if (!existing) return;
    const replacement = this.buildRow(row);
    existing.replaceWith(replacement);
    this.nodesById.set(row.id, replacement);
  }

  markRow(id, state, message) {
    const node = this.nodesById.get(id);
    if (!node) return;
    node.classList.remove('is-accepted', 'is-rejected', 'is-failed', 'is-busy');
    node.classList.add(`is-${state}`);

    this.stateChip(node).textContent = message;
    // Claimed by a job and now being written to. Marked so a later claim sync
    // knows this chip is the live one and leaves it standing.
    node.dataset.chip = 'state';
  }

  removeRow(id) {
    const node = this.nodesById.get(id);
    if (node) node.remove();
    this.nodesById.delete(id);
  }

  buildRow(row) {
    const node = el('div', 'row');
    node.dataset.id = row.id;
    if (this.selected.has(row.id)) node.classList.add('is-selected');

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'row-check';
    checkbox.checked = this.selected.has(row.id);
    checkbox.setAttribute('aria-label', `Select ${row.username}`);
    node.appendChild(checkbox);

    const openLabel = `Open @${row.username} in the main tab`;

    const avatarButton = openTarget('button', 'avatar-button', undefined, openLabel);
    const avatar = document.createElement('img');
    avatar.className = 'avatar';
    // Not row.avatar directly: the CDN's CORP header blocks that from this
    // origin. Proxied through the Instagram tab, resolving asynchronously.
    avatar.src = PLACEHOLDER;
    avatar.alt = '';
    avatar.referrerPolicy = 'no-referrer';
    avatarButton.appendChild(avatar);

    resolveAvatar(row.avatar).then((dataUrl) => {
      if (dataUrl) avatar.src = dataUrl;
    });
    node.appendChild(avatarButton);

    const main = el('div', 'row-main');

    const title = el('div', 'row-title');
    title.appendChild(openTarget('button', 'username link-button', `@${row.username}`, openLabel));
    if (row.isVerified) title.appendChild(el('span', 'chip chip-verified', 'Verified'));
    if (row.following) title.appendChild(el('span', 'chip chip-following', 'Following'));
    if (row.isPrivate) title.appendChild(el('span', 'chip', 'Private'));
    main.appendChild(title);

    if (row.fullName) {
      main.appendChild(openTarget('button', 'row-name link-button', row.fullName, openLabel));
    }

    const stats = [formatMutuals(row)];
    if (row.enriched) {
      stats.push(`${formatCount(row.followers)} followers`);
      stats.push(`${formatCount(row.posts)} posts`);
    }
    main.appendChild(el('div', 'row-stats', stats.join(' · ')));

    if (row.mutualNames.length > 0) {
      main.appendChild(el('div', 'row-mutuals', `with ${row.mutualNames.join(', ')}`));
    }

    // No bio line. One truncated clause of someone's profile text told you very
    // little and cost a row's worth of height on every request. The bio is still
    // fetched and cached — the "Empty bio" spam filter reads it.
    node.appendChild(main);

    // Last, so a row the scroller mounts into a run in progress comes up already
    // inert and already labelled rather than live for a frame.
    this.applyClaim(row.id, node);

    return node;
  }
}

// --------------------------------------------------------------- run stack

/** One trailing control per bar, so a bar never has to be read for which is which. */
function barButton(text) {
  const node = el('button', 'btn btn-small btn-quiet meter-stop', text);
  node.type = 'button';
  node.dataset.jobButton = '';
  return node;
}

/**
 * A running or paused job: the full meter, unchanged from when the toolbar could
 * only hold one. That is deliberate — a single running job is still the common
 * case and it should look exactly as it always has.
 */
function buildMeterBar(bar) {
  const node = el('div', 'run-progress');
  node.dataset.job = String(bar.id);
  node.dataset.kind = 'meter';

  node.appendChild(el('div', 'run-fill'));

  // The line twice: once in --text over the card, once in --primary-text clipped
  // to the fill. Only the first is exposed; the second is the same words in
  // another colour, and both are written in one statement below so they cannot
  // drift and show a seam at the fill's edge.
  for (const knockout of [false, true]) {
    const line = el('div', knockout ? 'run-line run-line-knockout' : 'run-line');
    if (knockout) line.setAttribute('aria-hidden', 'true');
    line.appendChild(el('span', 'spinner spinner-inline'));
    line.appendChild(el('span', 'run-label run-text'));
    node.appendChild(line);
  }

  node.appendChild(barButton('Stop'));
  return node;
}

/**
 * A job still waiting its turn: one quiet line and a Cancel.
 *
 * No fill and no spinner, because 0% and "not moving" is all either could ever
 * say until it starts — and at 260px three empty meters is most of the panel.
 */
function buildQueuedBar(bar) {
  const node = el('div', 'run-queued');
  node.dataset.job = String(bar.id);
  node.dataset.kind = 'queued';
  node.appendChild(el('span', 'run-label run-text'));
  node.appendChild(barButton('Cancel'));
  return node;
}

function updateBar(node, bar) {
  for (const label of node.querySelectorAll('.run-label')) label.textContent = bar.label;
  node.classList.toggle('is-paused', bar.state === 'paused');
  node.style.setProperty('--run-pct', `${bar.pct}%`);

  const button = node.querySelector('[data-job-button]');
  if (button) button.textContent = bar.state === 'queued' ? 'Cancel' : 'Stop';
}

/**
 * The toolbar's stack of bars — one per queued, running or paused operation.
 *
 * Reconciled rather than rebuilt, keyed on job id. Rebuilding on every tick would
 * restart each spinner and kill the fill's width transition, which between ticks
 * is the entire difference between a bar that looks alive and one that looks hung.
 */
export class RunStack {
  /** @param onButton (jobId) => void — Stop on a running bar, Cancel on a queued one. */
  constructor({ container, onButton }) {
    this.container = container;
    this.nodes = new Map();

    container.addEventListener('click', (event) => {
      const button = event.target.closest('[data-job-button]');
      if (!button) return;
      onButton(Number(button.closest('[data-job]').dataset.job));
    });
  }

  render(bars) {
    const seen = new Set();
    let previous = null;

    for (const bar of bars) {
      seen.add(bar.id);
      const kind = bar.state === 'queued' ? 'queued' : 'meter';
      let node = this.nodes.get(bar.id);

      // A job promoted from queued to running changes shape, so its node is
      // replaced rather than restyled — the meter's fill and knockout layers
      // have no counterpart in the one-line form.
      if (!node || node.dataset.kind !== kind) {
        const replacement = kind === 'queued' ? buildQueuedBar(bar) : buildMeterBar(bar);
        if (node) node.replaceWith(replacement);
        else this.container.appendChild(replacement);
        node = replacement;
        this.nodes.set(bar.id, node);
      }

      updateBar(node, bar);

      // Order moves under us — the head finishes and the next takes its place —
      // so each bar is walked into position rather than assumed to be in it.
      const expected = previous ? previous.nextSibling : this.container.firstChild;
      if (node !== expected) this.container.insertBefore(node, expected);
      previous = node;
    }

    for (const [id, node] of this.nodes) {
      if (seen.has(id)) continue;
      node.remove();
      this.nodes.delete(id);
    }
  }
}

// --------------------------------------------------------------- action log

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });

/**
 * Render the log into `container`, grouped under day headings.
 *
 * Unwindowed on purpose: the view loads a bounded number of day shards at a
 * time, so the row count is already bounded by what was asked for rather than
 * by how long the extension has been in use.
 *
 * `canFollow(record)` decides which rows get a checkbox — the accepted ones you
 * do not already follow, since following back is the only thing you can do
 * from here.
 *
 * `claimed` is `Map<userId, label>` for the rows some job is holding — a queued
 * or running follow-back, or a harvest. Those rows go inert and say what is
 * coming; the rest of the log stays live, so the next selection can be built
 * while this one runs. It has to be passed in rather than left to CSS because a
 * storage change can repaint this list mid-run — a follow-back's own writes land
 * in the log — and the rebuilt checkboxes would come back enabled.
 *
 * `skipNotes` is `{ [userId]: note }` for rows an outside feature has already
 * handled — the note is rendered under the username and the row is left out of
 * select-all. A plain string rather than anything structured, because this file
 * has no business knowing what the other feature did; it renders the sentence
 * it is handed. The checkbox stays live: the note says a row is not worth
 * ticking by default, not that it cannot be ticked.
 */
export function renderLog(container, records, {
  now, selected, canFollow, claimed = new Map(), skipNotes = {},
}) {
  container.textContent = '';
  const fragment = document.createDocumentFragment();

  for (const day of groupByDay(records, now)) {
    fragment.appendChild(el('div', 'log-day', day.label));

    for (const record of day.records) {
      const row = el('div', 'log-row');
      row.dataset.id = record.userId;
      row.dataset.at = String(record.at);

      const claim = claimed.get(record.userId);
      const isClaimed = claimed.has(record.userId);
      if (isClaimed) row.classList.add('is-claimed');

      if (canFollow(record)) {
        row.classList.add('is-selectable');
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.className = 'row-check log-check';
        checkbox.checked = selected.has(record.userId);
        checkbox.disabled = isClaimed;
        checkbox.setAttribute('aria-label', `Select ${record.username}`);
        row.appendChild(checkbox);
        if (selected.has(record.userId)) row.classList.add('is-selected');
      } else {
        row.appendChild(el('span', 'log-check-spacer'));
      }

      row.appendChild(el('time', 'log-time', timeFormat.format(new Date(record.at))));

      const username = openTarget('button', 'log-user link-button', `@${record.username}`,
        `Open @${record.username} in the main tab`);
      row.appendChild(username);

      const action = el('span', `log-action log-action-${record.action}`,
        ACTION_LABELS[record.action] || record.action);
      row.appendChild(action);

      // Its own line under the username rather than a fifth column. The panel
      // is dragged to ~260px beside Instagram, where a row already spends its
      // width on the time, the username and the action chip — a note inline
      // would leave the username four characters wide. The claim goes first
      // when there is one: it is the live state, and the note is history.
      if (claim) row.appendChild(el('span', 'log-note log-claim', claim));

      const note = skipNotes[record.userId];
      if (note) row.appendChild(el('span', 'log-note', note));

      fragment.appendChild(row);
    }
  }

  container.appendChild(fragment);
}
