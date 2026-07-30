// render.js — windowed row rendering.
//
// A 1000+ row queue is too much to mount at once, so we render a window and
// extend it as the user scrolls. All user-controlled text goes in via
// textContent, never innerHTML — usernames and bios are attacker-controlled.
//
// Every name on screen goes through a `mask`, which defaults to the identity
// one. That is how screenshot mode reaches this file without it learning that
// the mode exists: there is no branch here, only a pair of functions that
// happen to be pass-throughs most of the time. See src/alias.js.

import { ACTION_LABELS, groupByDay } from './history.js';
import { formatCount, formatMutuals } from './model.js';
import { PLACEHOLDER, resolveAvatar } from './avatars.js';
import { IDENTITY_MASK } from './alias.js';

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
  constructor({ container, sentinel, handlers, mask = IDENTITY_MASK }) {
    this.container = container;
    this.sentinel = sentinel;
    this.handlers = handlers;
    this.mask = mask;
    this.rows = [];
    this.selected = new Set();
    this.rendered = 0;
    this.nodesById = new Map();
    this.inert = false;

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
   * Freeze selection while a write queue runs.
   *
   * CSS dims the rows and takes their pointer events, but that stops the mouse
   * only — Tab still reaches a checkbox and Space still ticks it. The disabled
   * attribute is the part that actually holds, so it is set here rather than
   * left to the stylesheet, and `inert` is remembered for rows the scroller
   * mounts partway through a run.
   */
  setInert(inert) {
    if (this.inert === inert) return;
    this.inert = inert;
    for (const node of this.nodesById.values()) {
      const checkbox = node.querySelector('.row-check');
      if (checkbox) checkbox.disabled = inert;
    }
  }

  /**
   * Swap the naming mask. Nothing repaints from here — the caller is already
   * following this with a `setRows`, and repainting twice would drop the
   * scroll position of a list someone is halfway down.
   */
  setMask(mask) {
    this.mask = mask || IDENTITY_MASK;
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
    node.classList.add(`is-${state}`, 'has-state');

    let chip = node.querySelector('.row-state');
    if (!chip) {
      // Rows carry no buttons, so the status column only exists once there is
      // something to say — `has-state` opens the grid track for it.
      chip = el('div', 'row-state');
      node.appendChild(chip);
    }
    chip.textContent = message;
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

    // Masked once, here, so nothing below can render one of them raw. The
    // titles and aria-labels go through it too: a tooltip is as visible in a
    // screenshot as the row it hangs off.
    const handle = this.mask.username(row.username);
    const name = this.mask.fullName(row.username, row.fullName);

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'row-check';
    checkbox.checked = this.selected.has(row.id);
    checkbox.disabled = this.inert;
    checkbox.setAttribute('aria-label', `Select ${handle}`);
    node.appendChild(checkbox);

    const openLabel = `Open @${handle} in the main tab`;

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
    title.appendChild(openTarget('button', 'username link-button', `@${handle}`, openLabel));
    if (row.isVerified) title.appendChild(el('span', 'chip chip-verified', 'Verified'));
    if (row.following) title.appendChild(el('span', 'chip chip-following', 'Following'));
    if (row.isPrivate) title.appendChild(el('span', 'chip', 'Private'));
    main.appendChild(title);

    if (name) {
      main.appendChild(openTarget('button', 'row-name link-button', name, openLabel));
    }

    const stats = [formatMutuals(row)];
    if (row.enriched) {
      stats.push(`${formatCount(row.followers)} followers`);
      stats.push(`${formatCount(row.posts)} posts`);
    }
    main.appendChild(el('div', 'row-stats', stats.join(' · ')));

    if (row.mutualNames.length > 0) {
      const mutuals = row.mutualNames.map((mutual) => this.mask.username(mutual));
      main.appendChild(el('div', 'row-mutuals', `with ${mutuals.join(', ')}`));
    }

    // No bio line. One truncated clause of someone's profile text told you very
    // little and cost a row's worth of height on every request. The bio is still
    // fetched and cached — the "Empty bio" spam filter reads it.
    node.appendChild(main);

    return node;
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
 * `inert` freezes the selection while a follow-back run is in flight. It has to
 * be passed in rather than left to CSS because a storage change can repaint this
 * list mid-run, and the rebuilt checkboxes would come back enabled.
 *
 * `skipNotes` is `{ [userId]: note }` for rows an outside feature has already
 * handled — the note is rendered under the username and the row is left out of
 * select-all. A plain string rather than anything structured, because this file
 * has no business knowing what the other feature did; it renders the sentence
 * it is handed. The checkbox stays live: the note says a row is not worth
 * ticking by default, not that it cannot be ticked.
 *
 * Every row carries its real handle in `data-username` regardless of the mask.
 * Clicking a log row opens that profile, and the panel used to read the handle
 * back off the rendered text — which is fine until the rendered text is a
 * pseudonym and the click navigates to an account that does not exist.
 */
export function renderLog(container, records, {
  now, selected, canFollow, inert = false, skipNotes = {}, mask = IDENTITY_MASK,
}) {
  container.textContent = '';
  const fragment = document.createDocumentFragment();

  for (const day of groupByDay(records, now)) {
    fragment.appendChild(el('div', 'log-day', day.label));

    for (const record of day.records) {
      const row = el('div', 'log-row');
      row.dataset.id = record.userId;
      row.dataset.at = String(record.at);
      row.dataset.username = record.username;

      const handle = mask.username(record.username);

      if (canFollow(record)) {
        row.classList.add('is-selectable');
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.className = 'row-check log-check';
        checkbox.checked = selected.has(record.userId);
        checkbox.disabled = inert;
        checkbox.setAttribute('aria-label', `Select ${handle}`);
        row.appendChild(checkbox);
        if (selected.has(record.userId)) row.classList.add('is-selected');
      } else {
        row.appendChild(el('span', 'log-check-spacer'));
      }

      row.appendChild(el('time', 'log-time', timeFormat.format(new Date(record.at))));

      const username = openTarget('button', 'log-user link-button', `@${handle}`,
        `Open @${handle} in the main tab`);
      row.appendChild(username);

      const action = el('span', `log-action log-action-${record.action}`,
        ACTION_LABELS[record.action] || record.action);
      row.appendChild(action);

      // Its own line under the username rather than a fifth column. The panel
      // is dragged to ~260px beside Instagram, where a row already spends its
      // width on the time, the username and the action chip — a note inline
      // would leave the username four characters wide.
      const note = skipNotes[record.userId];
      if (note) row.appendChild(el('span', 'log-note', note));

      fragment.appendChild(row);
    }
  }

  container.appendChild(fragment);
}
