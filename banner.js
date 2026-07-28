// banner.js — in-context accept/reject on profile pages.
//
// Deliberately minimal: it acts on the profile you are currently looking at
// and nothing more. Sequencing is the side panel's job. Works whether or not
// the panel is open, reading the same cached pending list.
//
// Renders inline directly beneath Instagram's own Follow/Following button,
// styled from Instagram's CSS custom properties so it tracks their light and
// dark themes for free. Falls back to a floating bar if the profile header
// markup ever stops matching.
//
// Runs in the same isolated world as content.js and uses its
// window.__requestBlaster.call() for authenticated requests.

(() => {
  // Same isolated world, possibly injected twice. Bind once.
  if (window.__requestBlasterBannerBound) return;
  window.__requestBlasterBannerBound = true;

  // Storage keys shared with src/store.js — keep in sync.
  const SNAPSHOT_KEY = 'pendingSnapshot';
  const HANDLED_KEY = 'handledIds';

  // Action log, shared with src/history.js — keep in sync. Duplicated rather
  // than imported because this is a classic content script and cannot load the
  // panel's ES modules.
  const DAY_PREFIX = 'log:';
  const LOG_INDEX_KEY = 'logIndex';

  const HOST_ID = 'request-blaster-banner';
  const TICK_MS = 600;

  const FOLLOW_LABELS = new Set(['Follow', 'Following', 'Follow back', 'Requested', 'Message']);
  const NON_PROFILE_PATHS = [
    '/stories', '/accounts', '/explore', '/direct', '/reels', '/p/',
    '/your_activity', '/notifications', '/legal', '/about', '/challenge',
  ];

  let host = null;
  let shadow = null;
  let target = null; // { user, position, total } for the current profile
  let snapshotPromise = null;

  // ------------------------------------------------------------- page state

  function profileUsernameFromPath() {
    const path = window.location.pathname;
    if (NON_PROFILE_PATHS.some((prefix) => path.startsWith(prefix))) return null;
    const match = path.match(/^\/([^/]+)\/?$/);
    return match ? match[1].toLowerCase() : null;
  }

  /**
   * The element to insert after: the direct child of <header> that holds the
   * Follow button. Keyed off semantic markup and button text rather than
   * Instagram's generated class names, which change constantly.
   */
  function findAnchor() {
    const buttons = document.querySelectorAll('header button, header div[role="button"]');
    const followButton = [...buttons].find((button) => FOLLOW_LABELS.has(button.textContent.trim()));
    if (!followButton) return null;

    const header = followButton.closest('header');
    if (!header) return null;

    let node = followButton;
    while (node.parentElement && node.parentElement !== header) node = node.parentElement;
    return node.parentElement === header ? node : null;
  }

  // ---------------------------------------------------------------- storage

  async function readSession(key) {
    try {
      const stored = await chrome.storage.session.get(key);
      return stored[key];
    } catch {
      // Access level not granted yet, or the extension context was invalidated
      // by a reload. Either way there is nothing cached to use.
      return undefined;
    }
  }

  async function writeSession(key, value) {
    try {
      await chrome.storage.session.set({ [key]: value });
    } catch {
      /* see readSession */
    }
  }

  async function getHandledIds() {
    return new Set((await readSession(HANDLED_KEY)) || []);
  }

  async function markHandled(id) {
    const handled = await getHandledIds();
    handled.add(id);
    // The panel watches this key and drops the row, so acting here keeps the
    // two views consistent without any direct messaging between them.
    await writeSession(HANDLED_KEY, [...handled]);
  }

  /**
   * Append to the same day-sharded action log the panel writes, so acting from
   * a profile page shows up in the log alongside everything else.
   */
  async function logAction(user, action) {
    try {
      const at = Date.now();
      const shard = DAY_PREFIX + new Date(at).toISOString().slice(0, 10);
      const stored = await chrome.storage.local.get([shard, LOG_INDEX_KEY]);
      const index = stored[LOG_INDEX_KEY] || [];

      await chrome.storage.local.set({
        [shard]: [...(stored[shard] || []), { at, userId: String(user.pk), username: user.username, action }],
        [LOG_INDEX_KEY]: index.includes(shard) ? index : [...index, shard].sort(),
      });
    } catch {
      // Extension context invalidated by a reload, or storage unavailable.
      // Never worth failing the action the user actually asked for.
    }
  }

  /**
   * The pending list, from cache when the panel has already loaded it,
   * otherwise fetched here so the banner works with the panel closed.
   */
  function getPendingUsers() {
    if (snapshotPromise) return snapshotPromise;

    snapshotPromise = (async () => {
      const cached = await readSession(SNAPSHOT_KEY);
      if (cached?.users) return cached.users;

      const result = await window.__requestBlaster?.call('pending', {});
      if (!result?.ok) return [];

      const users = result.data?.users || [];
      // Follow statuses are the panel's concern; store what we have without
      // clobbering a richer snapshot it may write later.
      if (users.length > 0 && !(await readSession(SNAPSHOT_KEY))) {
        await writeSession(SNAPSHOT_KEY, { users, statuses: {}, capped: users.length >= 200 });
      }
      return users;
    })();

    return snapshotPromise;
  }

  // ------------------------------------------------------------------- view

  // Instagram publishes its palette as "R, G, B" triples on :root, and custom
  // properties inherit through shadow boundaries — so this follows their theme
  // without us detecting anything. Fallbacks are the observed light values.
  const STYLES = `
    :host { all: initial; display: block; }
    /* The UA stylesheet's [hidden] { display: none } loses to any author
       display rule, and both .wrap and .status set one. Without this the
       hidden element still lays out — an empty grey bar under the buttons. */
    [hidden] { display: none !important; }
    .wrap {
      display: flex; gap: 8px; align-items: stretch;
      font-family: system-ui, -apple-system, sans-serif;
      margin: 8px 0 0;
    }
    button {
      flex: 1 1 0; min-width: 0;
      height: 44px; padding: 13px 20px;
      font-family: inherit; font-size: 14px; line-height: 18px; font-weight: 600;
      border: 0; border-radius: 12px; cursor: pointer;
      display: inline-flex; align-items: center; justify-content: center;
    }
    button:disabled { opacity: 0.5; cursor: default; }
    .accept {
      background: rgb(var(--ig-primary-button, 74, 93, 249));
      color: rgb(var(--ig-primary-button-text, 255, 255, 255));
    }
    .accept:hover:not(:disabled) { background: rgb(var(--ig-primary-button-hover, 65, 80, 247)); }
    .reject {
      background: rgb(var(--ig-secondary-button-background, 239, 239, 239));
      color: rgb(var(--ig-secondary-button, 38, 38, 38));
    }
    .reject:hover:not(:disabled) { background: rgb(var(--ig-secondary-button-hover, 219, 219, 219)); }
    .meta {
      margin: 6px 2px 0;
      font-family: system-ui, -apple-system, sans-serif;
      font-size: 12px; line-height: 16px;
      color: rgb(var(--ig-secondary-text, 106, 113, 122));
    }
    .status {
      margin: 8px 0 0; height: 44px;
      display: flex; align-items: center; justify-content: center;
      font-family: system-ui, -apple-system, sans-serif;
      font-size: 14px; font-weight: 600; border-radius: 12px;
      background: rgb(var(--ig-secondary-button-background, 239, 239, 239));
      color: rgb(var(--ig-secondary-button, 38, 38, 38));
    }
    /* Floating fallback, used only when the profile header can't be matched. */
    :host([data-mode='float']) {
      position: fixed; inset: auto 0 0 0; z-index: 2147483647;
      padding: 0 16px 16px;
    }
    :host([data-mode='float']) .wrap { max-width: 560px; margin: 0 auto; }
    :host([data-mode='float']) .meta { max-width: 560px; margin: 6px auto 0; text-align: center; }
  `;

  function buildHost() {
    const element = document.createElement('div');
    element.id = HOST_ID;
    shadow = element.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>${STYLES}</style>
      <div class="wrap">
        <button class="accept" type="button">Accept</button>
        <button class="reject" type="button">Reject</button>
      </div>
      <div class="status" hidden></div>
      <div class="meta"></div>`;
    return element;
  }

  function detach() {
    target = null;
    if (host) host.remove();
  }

  /**
   * Match the horizontal extent of Instagram's own button row.
   *
   * The banner is a sibling of the section holding Follow, but that section is
   * not always the same width as the buttons inside it — Instagram's narrow
   * layout insets them. Rather than hardcode a breakpoint, measure the buttons
   * and set our margins to match, which is right at any viewport.
   */
  function alignToButtonRow(anchor) {
    if (!host || !anchor || host.dataset.mode !== 'inline') return;
    const parent = host.parentElement;
    if (!parent) return;

    const rects = [...anchor.querySelectorAll('button, [role="button"]')]
      .map((button) => button.getBoundingClientRect())
      .filter((rect) => rect.width > 0 && rect.height > 0);
    if (rects.length === 0) return;

    const rowLeft = Math.min(...rects.map((rect) => rect.left));
    const rowRight = Math.max(...rects.map((rect) => rect.right));

    // Margins resolve against the parent's content box, not its border box.
    const parentRect = parent.getBoundingClientRect();
    const parentStyle = getComputedStyle(parent);
    const contentLeft =
      parentRect.left + parseFloat(parentStyle.paddingLeft) + parseFloat(parentStyle.borderLeftWidth);
    const contentRight =
      parentRect.right - parseFloat(parentStyle.paddingRight) - parseFloat(parentStyle.borderRightWidth);

    const left = `${Math.max(0, Math.round(rowLeft - contentLeft))}px`;
    const right = `${Math.max(0, Math.round(contentRight - rowRight))}px`;

    // Only write on change; this runs on every tick.
    if (host.style.marginLeft !== left) host.style.marginLeft = left;
    if (host.style.marginRight !== right) host.style.marginRight = right;
  }

  /** Insert (or re-insert after a React re-render) at the right place. */
  function place() {
    if (!host) {
      host = buildHost();
    }

    const anchor = findAnchor();
    if (anchor) {
      host.dataset.mode = 'inline';
      if (host.previousElementSibling !== anchor || !host.isConnected) anchor.after(host);
      alignToButtonRow(anchor);
      return true;
    }

    // Header not matched — keep the feature usable rather than vanishing.
    host.dataset.mode = 'float';
    host.style.marginLeft = '';
    host.style.marginRight = '';
    if (!host.isConnected) document.documentElement.appendChild(host);
    return true;
  }

  function render() {
    if (!target) return;
    const { user, position, total } = target;

    const wrap = shadow.querySelector('.wrap');
    const status = shadow.querySelector('.status');
    const accept = shadow.querySelector('.accept');
    const reject = shadow.querySelector('.reject');

    wrap.hidden = false;
    status.hidden = true;
    accept.disabled = false;
    reject.disabled = false;

    // Not social_context: Instagram already renders its own "Followed by …"
    // line in the header just above, and the two disagree on names and count.
    shadow.querySelector('.meta').textContent = `Pending request · ${position} of ${total}`;

    const act = (op, doneLabel, busyLabel, logged) => async () => {
      accept.disabled = true;
      reject.disabled = true;
      status.hidden = false;
      status.textContent = busyLabel;
      wrap.hidden = true;

      const result = await window.__requestBlaster.call(op, { userId: String(user.pk) });

      if (result?.ok) {
        await markHandled(String(user.pk));
        await logAction(user, logged);
        status.textContent = doneLabel;
        shadow.querySelector('.meta').textContent = '';
      } else {
        wrap.hidden = false;
        status.hidden = true;
        accept.disabled = false;
        reject.disabled = false;
        shadow.querySelector('.meta').textContent = result?.blocked
          ? 'Instagram is rate limiting — wait a while before retrying.'
          : `Failed: ${result?.error || 'unknown error'}`;
      }
    };

    accept.onclick = act('approve', 'Accepted', 'Accepting…', 'accept');
    reject.onclick = act('ignore', 'Rejected', 'Rejecting…', 'reject');
  }

  // ----------------------------------------------------------- orchestration

  async function refresh() {
    const username = profileUsernameFromPath();
    if (!username) return detach();
    if (target && target.user.username.toLowerCase() === username) return;

    detach();

    const users = await getPendingUsers();
    if (users.length === 0) return;

    // The path may have changed while we awaited.
    if (profileUsernameFromPath() !== username) return;

    const index = users.findIndex((user) => user.username.toLowerCase() === username);
    if (index === -1) return;

    const handled = await getHandledIds();
    if (handled.has(String(users[index].pk))) return;
    if (profileUsernameFromPath() !== username) return;

    target = { user: users[index], position: index + 1, total: users.length };
    place();
    render();
  }

  let lastPath = window.location.pathname;

  function tick() {
    if (window.location.pathname !== lastPath) {
      lastPath = window.location.pathname;
      refresh();
      return;
    }
    if (!target) return;
    // Instagram renders the profile header asynchronously and re-renders it on
    // its own schedule, so keep verifying our node is still where it belongs.
    if (!host || !host.isConnected || host.dataset.mode === 'float') {
      place();
      return;
    }
    // Placed correctly, but the row may have reflowed under us.
    alignToButtonRow(findAnchor());
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'session') return;
    if (changes[SNAPSHOT_KEY]) {
      // The panel refetched; our memoised list is stale.
      snapshotPromise = null;
      detach();
      refresh();
    } else if (changes[HANDLED_KEY] && target) {
      const handled = new Set(changes[HANDLED_KEY].newValue || []);
      if (handled.has(String(target.user.pk))) detach();
    }
  });

  // Instagram is a SPA: patch the history methods, listen for popstate, and
  // poll as a backstop for transitions that use neither.
  for (const method of ['pushState', 'replaceState']) {
    const original = history[method];
    history[method] = function patched(...args) {
      original.apply(this, args);
      queueMicrotask(tick);
    };
  }
  window.addEventListener('popstate', () => queueMicrotask(tick));
  // Instagram reflows its button row across breakpoints; realign immediately
  // rather than waiting up to a tick.
  window.addEventListener('resize', () => {
    if (target) alignToButtonRow(findAnchor());
  });
  setInterval(tick, TICK_MS);

  refresh();
})();
