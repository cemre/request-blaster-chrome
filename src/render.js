// render.js — windowed row rendering.
//
// A 1000+ row queue is too much to mount at once, so we render a window and
// extend it as the user scrolls. All user-controlled text goes in via
// textContent, never innerHTML — usernames and bios are attacker-controlled.

import { formatCount } from './model.js';
import { PLACEHOLDER, resolveAvatar } from './avatars.js';

const PAGE_SIZE = 60;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
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

    if (event.target.closest('[data-action="accept"]')) return this.handlers.onAccept(id);
    if (event.target.closest('[data-action="reject"]')) return this.handlers.onReject(id);
    if (event.target.closest('[data-action="open"]')) return this.handlers.onOpenProfile(id);
  }

  onChange(event) {
    const checkbox = event.target.closest('.row-check');
    if (!checkbox) return;
    const row = checkbox.closest('.row');
    this.handlers.onToggleSelect(row.dataset.id, checkbox.checked);
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

    let chip = node.querySelector('.row-state');
    if (!chip) {
      chip = el('div', 'row-state');
      node.querySelector('.row-actions').appendChild(chip);
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
    checkbox.setAttribute('aria-label', `Select ${row.username}`);
    node.appendChild(checkbox);

    const avatarButton = el('button', 'avatar-button');
    avatarButton.dataset.action = 'open';
    avatarButton.title = `Open @${row.username} in the main tab`;
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
    title.appendChild(el('span', 'username', `@${row.username}`));
    if (row.isVerified) title.appendChild(el('span', 'chip chip-verified', 'Verified'));
    if (row.following) title.appendChild(el('span', 'chip chip-following', 'Following'));
    if (row.isPrivate) title.appendChild(el('span', 'chip', 'Private'));
    main.appendChild(title);

    if (row.fullName) main.appendChild(el('div', 'row-name', row.fullName));

    const stats = [];
    const mutualLabel = row.enriched ? 'mutuals' : 'mutuals (est.)';
    stats.push(`${row.mutuals} ${mutualLabel}`);
    if (row.enriched) {
      stats.push(`${formatCount(row.followers)} followers`);
      stats.push(`${formatCount(row.posts)} posts`);
    }
    main.appendChild(el('div', 'row-stats', stats.join(' · ')));

    if (row.mutualNames.length > 0) {
      main.appendChild(el('div', 'row-mutuals', `with ${row.mutualNames.join(', ')}`));
    }

    if (row.enriched && row.bio.trim()) {
      main.appendChild(el('div', 'row-bio', row.bio.replace(/\s+/g, ' ').trim()));
    }

    if (!row.enriched) main.appendChild(el('div', 'row-pending-detail', 'Details not loaded'));

    node.appendChild(main);

    const actions = el('div', 'row-actions');
    const accept = el('button', 'btn btn-accept', 'Accept');
    accept.dataset.action = 'accept';
    const reject = el('button', 'btn btn-reject', 'Reject');
    reject.dataset.action = 'reject';
    actions.append(accept, reject);
    node.appendChild(actions);

    return node;
  }
}
