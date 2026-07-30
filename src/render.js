// render.js — windowed row rendering.
//
// A 1000+ row queue is too much to mount at once, so we render a window and
// extend it as the user scrolls. All user-controlled text goes in via
// textContent, never innerHTML — usernames and bios are attacker-controlled.

import { ACTION_LABELS, groupByDay } from './history.js';
import { formatCount, formatMutuals, rangeIds } from './model.js';
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
    this.inert = false;
    // Where a shift-click measures from. Tracked here rather than read back off
    // the document because the shift-click suppresses focus, and cleared by
    // setRows below — an anchor in a list that has been replaced points at a
    // row the user never picked.
    this.anchorId = null;

    this.observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) this.extend();
      },
      { root: container.parentElement, rootMargin: '400px' }
    );
    this.observer.observe(sentinel);

    container.addEventListener('click', (event) => this.onClick(event));
    container.addEventListener('change', (event) => this.onChange(event));
    // Shift-clicking a list is also how the browser is told to drag a text
    // selection across it, and it does that on mousedown. Suppressed before it
    // starts rather than cleared afterwards, which leaves a frame of blue.
    container.addEventListener('mousedown', (event) => {
      if (event.shiftKey && event.target.closest('.row')) event.preventDefault();
    });
  }

  onClick(event) {
    const row = event.target.closest('.row');
    if (!row) return;
    const { id } = row.dataset;

    if (event.target.closest('[data-action="open"]')) return this.handlers.onOpenProfile(id);

    const checkbox = row.querySelector('.row-check');
    if (!checkbox) return;

    // A click on the checkbox has already toggled it by the time this runs; a
    // click anywhere else in the row is the toggle, since acting is bulk-only
    // and the rest of the row is therefore a selection target.
    const onCheckbox = Boolean(event.target.closest('.row-check'));
    const checked = onCheckbox ? checkbox.checked : !checkbox.checked;

    if (event.shiftKey) return this.selectRange(id, checked);

    // Its own change event follows and does the work; toggling here as well
    // would cancel it out.
    if (onCheckbox) {
      this.anchorId = id;
      return;
    }

    checkbox.checked = checked;
    row.classList.toggle('is-selected', checked);
    this.anchorId = id;
    this.handlers.onToggleSelect(id, checked);
  }

  onChange(event) {
    const checkbox = event.target.closest('.row-check');
    if (!checkbox) return;
    const row = checkbox.closest('.row');
    row.classList.toggle('is-selected', checkbox.checked);
    this.handlers.onToggleSelect(row.dataset.id, checkbox.checked);
  }

  /**
   * Give every row between the anchor and `id` the state the clicked one just
   * took — Gmail's rule, and the one the gesture is borrowed from.
   *
   * Measured over the rows actually mounted rather than over `this.rows`: the
   * scroller renders a window, and a range can only run between two rows the
   * user was able to click. With no usable anchor rangeIds returns the clicked
   * row alone, which is a plain click, which is the right thing to fall back to.
   *
   * The clicked row is included, so when the click was on a checkbox the change
   * event that follows re-reports a state this already set. That is a no-op, not
   * a second toggle.
   */
  selectRange(id, checked) {
    for (const rowId of rangeIds([...this.nodesById.keys()], this.anchorId, id)) {
      const node = this.nodesById.get(rowId);
      const checkbox = node?.querySelector('.row-check');
      if (!checkbox || checkbox.disabled) continue;
      checkbox.checked = checked;
      node.classList.toggle('is-selected', checked);
      this.handlers.onToggleSelect(rowId, checked);
    }
    this.anchorId = id;
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
    // A filter change reorders what is on screen, so the last row clicked is no
    // longer a point anything can be measured from. Dropped rather than left to
    // rangeIds, which would only catch the case where it also left the list.
    this.anchorId = null;
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

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'row-check';
    checkbox.checked = this.selected.has(row.id);
    checkbox.disabled = this.inert;
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
 * `skipNotes` is `{ [userId]: { label, date } }` for rows an outside feature has
 * already handled — the label takes the action chip and the date goes into the
 * row's tooltip. Values this file prints rather than interprets: it has no
 * business knowing what the other feature did. The checkbox stays live, because
 * a note says a row is not worth ticking by default, not that it cannot be.
 *
 * The label takes the chip rather than a line of its own. A second line doubles
 * the height of every marked row, and at the width this panel is used at a log
 * of harvested accounts is then a log at half density — while the chip it would
 * sit beneath says "Accepted", which the Accepted tab above already established.
 */
export function renderLog(container, records, {
  now, selected, canFollow, inert = false, skipNotes = {},
}) {
  container.textContent = '';
  const fragment = document.createDocumentFragment();

  for (const day of groupByDay(records, now)) {
    fragment.appendChild(el('div', 'log-day', day.label));

    for (const record of day.records) {
      const row = el('div', 'log-row');
      row.dataset.id = record.userId;
      row.dataset.at = String(record.at);

      if (canFollow(record)) {
        row.classList.add('is-selectable');
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.className = 'row-check log-check';
        checkbox.checked = selected.has(record.userId);
        checkbox.disabled = inert;
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

      const label = ACTION_LABELS[record.action] || record.action;
      const note = skipNotes[record.userId];

      // The note takes the chip's text but not its colour: a rejection that was
      // harvested anyway is still the one row on screen worth noticing, and
      // dropping it to the default grey would hide that behind the mark.
      const action = el('span', `log-action log-action-${record.action}`,
        note ? note.label : label);
      if (note) {
        action.classList.add('is-noted');
        // What the chip gave up to make room. The date in full rather than the
        // chip's MM/DD, and the action name the mark is standing in front of.
        action.title = note.date ? `${label} · harvested ${note.date}` : label;
      }
      row.appendChild(action);

      fragment.appendChild(row);
    }
  }

  container.appendChild(fragment);
}
