// anon-content.js — screenshot mode on the Instagram tab.
//
// The panel renames its own rows; this renames the page beside it, so a shot
// of both shows one consistent set of people. Display only — it rewrites text
// nodes in place and keeps every original, so turning the mode off puts the
// real page back without a reload.
//
// Identity comes off hrefs. Instagram links every account as `/handle/`, so a
// link tells us *who* a piece of text refers to without us having to guess
// whether it is a name; the handle then goes through the same pure persona
// function the panel uses, which is what keeps the two sides agreeing. That
// function is imported dynamically from src/alias.js rather than copied here —
// a second copy of the name pools would be a second copy of the mapping, and
// the whole feature is the mapping.
//
// Runs in the same isolated world as content.js and registers its op through
// window.__requestBlaster.register.

(() => {
  // Same isolated world, possibly injected twice. Bind once.
  if (window.__requestBlasterAnonBound) return;
  window.__requestBlasterAnonBound = true;

  // Shared with src/anon.js — keep in sync.
  const SESSION_KEY = 'anonMode';

  const STYLE_ID = 'request-blaster-anon-style';
  const BLUR_CLASS = 'rb-anon-blurred';

  // Instagram repaints constantly; a sweep per mutation would be a sweep per
  // keystroke. One coalesced pass per frame, floored so a busy feed cannot
  // starve the page.
  const SWEEP_FLOOR_MS = 120;

  // Link text that is a control rather than a person. Instagram puts these
  // inside profile links often enough to matter.
  const UI_WORDS = new Set([
    'follow', 'following', 'follow back', 'requested', 'message', 'remove',
    'confirm', 'delete', 'view profile', 'see all', 'view all', 'more',
    'edit profile', 'share', 'block', 'report', 'unfollow', 'switch',
  ]);

  let alias = null; // the src/alias.js module
  let aliasPromise = null;
  let enabled = false;
  let observer = null;
  let sweepTimer = null;
  let lastSweep = 0;

  // What we have already rewritten, so a second sweep leaves it alone.
  //
  // This is load-bearing, not bookkeeping. Instagram re-renders constantly, so
  // every node gets swept many times — and a node holding `jordan.reeves` no
  // longer equals the handle its link points at, so the second pass would take
  // it for a display name and overwrite it with "Jordan Reeves". Handles
  // decaying into full names one repaint later is the bug this prevents.
  //
  // `original` is only ever written once, so it survives Instagram changing
  // the text under us; `written` is what we last put there, and a node whose
  // value still matches it is ours and already done.
  const touchedText = new WeakMap(); // Text -> { node, original, written }
  const touchedAlt = new WeakMap(); // Element -> { image, original, written }
  // The WeakMaps answer "is this ours"; these answer "what did we touch",
  // which is what turning the mode off needs.
  const textEntries = [];
  const altEntries = [];

  /** Real full name (lowercased) -> the handle it belongs to. */
  const namesToHandle = new Map();
  /** Handles we have seen, so they can be replaced outside a link too. */
  const knownHandles = new Set();

  let handlePattern = null;
  let namePattern = null;

  // ------------------------------------------------------------ alias module

  /**
   * The persona engine, imported rather than copied.
   *
   * A dynamic import of a web_accessible_resource — the one way a classic
   * content script can reach an ES module. If it ever fails (a CSP change on
   * Instagram's side, a missing manifest entry) the mode has no mapping and
   * cannot do anything at all, so it says so loudly rather than appearing to
   * work: names not changing is exactly what this feature looks like when it
   * is off.
   */
  function loadAlias() {
    if (!aliasPromise) {
      aliasPromise = import(chrome.runtime.getURL('src/alias.js')).then(
        (module) => {
          alias = module;
          return module;
        },
        (err) => {
          console.error('[Request Blaster] screenshot mode could not load src/alias.js:', err);
          aliasPromise = null; // let a later toggle retry
          throw err;
        }
      );
    }
    return aliasPromise;
  }

  // ------------------------------------------------------------- known names

  const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  function learnHandle(handle) {
    if (!handle || knownHandles.has(handle)) return;
    knownHandles.add(handle);
    handlePattern = null;
  }

  function learnName(handle, name) {
    const key = name.trim().toLowerCase();
    // One word is not a full name worth matching globally — "photography" or
    // "Berlin" as someone's display name would rewrite the word wherever it
    // appears on the page.
    if (key.length < 4 || !key.includes(' ')) return;
    if (namesToHandle.has(key)) return;
    namesToHandle.set(key, handle);
    namePattern = null;
  }

  function seedNames(names) {
    for (const [handle, name] of Object.entries(names || {})) {
      const normalized = alias.normalizeHandle(handle);
      if (!normalized || typeof name !== 'string') continue;
      learnHandle(normalized);
      learnName(normalized, name);
    }
  }

  /**
   * Longest-first so `alice_jones` is matched before `alice`, and fenced by
   * the characters a handle can contain rather than \b — `\balice\b` would
   * fire inside `alice_jones`, which is a different account.
   */
  function handleRegex() {
    if (handlePattern !== null) return handlePattern;
    if (knownHandles.size === 0) return (handlePattern = false);

    const alternatives = [...knownHandles]
      .sort((left, right) => right.length - left.length)
      .map(escapeRe)
      .join('|');
    handlePattern = new RegExp(`(?<![A-Za-z0-9._])(${alternatives})(?![A-Za-z0-9._])`, 'gi');
    return handlePattern;
  }

  function nameRegex() {
    if (namePattern !== null) return namePattern;
    if (namesToHandle.size === 0) return (namePattern = false);

    const alternatives = [...namesToHandle.keys()]
      .sort((left, right) => right.length - left.length)
      .map(escapeRe)
      .join('|');
    namePattern = new RegExp(`(?<![A-Za-z0-9])(${alternatives})(?![A-Za-z0-9])`, 'gi');
    return namePattern;
  }

  // ---------------------------------------------------------------- the page

  function handleFromHref(href) {
    if (!href) return null;
    let path;
    try {
      path = new URL(href, window.location.origin).pathname;
    } catch {
      return null;
    }
    return alias.handleFromPath(path);
  }

  /** The handle of the profile currently being viewed, if any. */
  function handleFromLocation() {
    return alias.handleFromPath(window.location.pathname);
  }

  function isNameLike(text) {
    if (!text || text.length > 60) return false;
    if (UI_WORDS.has(text.toLowerCase())) return false;
    // Counts, timestamps, separators — "1,204", "2d", "·".
    if (!/[A-Za-z]/.test(text)) return false;
    if (/^\d[\d,.\s]*[a-z]?$/i.test(text)) return false;
    return true;
  }

  function replaceKnown(text) {
    let next = text;

    const handles = handleRegex();
    if (handles) {
      next = next.replace(handles, (match) => alias.personaFor(match)?.username ?? match);
    }

    const names = nameRegex();
    if (names) {
      next = next.replace(names, (match) => {
        const handle = namesToHandle.get(match.toLowerCase());
        return alias.personaFor(handle)?.fullName ?? match;
      });
    }

    return next;
  }

  function rewriteTextNode(node) {
    const text = node.nodeValue;
    const trimmed = text.trim();
    if (!trimmed) return;

    // Already ours and untouched since. See touchedText.
    const previous = touchedText.get(node);
    if (previous && previous.written === text) return;

    let next = text;

    // 1. The enclosing profile link, if there is one, says whose text this is.
    //    That is the reliable path: no guessing, and it resolves a display name
    //    and a handle to the same persona.
    const link = node.parentElement?.closest?.('a[href]');
    const linkHandle = link ? handleFromHref(link.getAttribute('href')) : null;

    if (linkHandle) {
      learnHandle(linkHandle);
      const persona = alias.personaFor(linkHandle);

      if (trimmed.toLowerCase() === linkHandle) {
        next = text.replace(trimmed, persona.username);
      } else if (isNameLike(trimmed)) {
        learnName(linkHandle, trimmed);
        next = text.replace(trimmed, persona.fullName);
      }
    }

    // 2. Anything outside a link — the profile header's handle and name, a DM
    //    thread title — against what we already know. Skipped when the link
    //    above already answered, so an alias cannot be rewritten twice.
    if (next === text) next = replaceKnown(text);

    if (next === text) return;

    if (previous) {
      previous.written = next;
    } else {
      const entry = { node, original: text, written: next };
      touchedText.set(node, entry);
      textEntries.push(entry);
    }
    node.nodeValue = next;
  }

  function sweepText(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        const parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        const tag = parent.tagName;
        if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'TITLE') {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });

    // Collected first: rewriting mid-walk mutates what the walker is standing on.
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    for (const node of nodes) rewriteTextNode(node);
  }

  /**
   * Profile pictures.
   *
   * Two ways in, because Instagram is not consistent: the alt text ("alice's
   * profile picture") covers most of them and is handled by the stylesheet,
   * and any image inside a profile link is caught here for the rest. The alt
   * itself is rewritten too — it is not on screen until the image fails to
   * load, and then it is the real handle in plain text.
   */
  function sweepAvatars(root) {
    for (const image of root.querySelectorAll('img')) {
      const alt = image.getAttribute('alt');
      const inProfileLink = Boolean(image.closest?.('a[href]')
        && handleFromHref(image.closest('a[href]').getAttribute('href')));

      if (inProfileLink || (alt && /profile picture/i.test(alt))) {
        image.classList.add(BLUR_CLASS);
      }

      if (!alt || !alt.trim()) continue;

      const previous = touchedAlt.get(image);
      if (previous && previous.written === alt) continue;

      const next = replaceKnown(alt);
      if (next === alt) continue;

      if (previous) {
        previous.written = next;
      } else {
        const entry = { image, original: alt, written: next };
        touchedAlt.set(image, entry);
        altEntries.push(entry);
      }
      image.setAttribute('alt', next);
    }
  }

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    // clip-path after filter, same reasoning as the panel's own rule: a blur
    // spreads past the element box and border-radius is applied too early to
    // contain it, leaving a square halo around every round avatar.
    style.textContent = `
      img[alt*="profile picture" i], .${BLUR_CLASS} {
        filter: blur(8px) !important;
        clip-path: circle(50%) !important;
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  // ----------------------------------------------------------------- driving

  function sweep() {
    if (!enabled || !alias || !document.body) return;

    // Our own writes are mutations too. Without this the observer re-arms on
    // every rewrite and the page sweeps itself forever.
    observer?.disconnect();
    try {
      learnHandle(handleFromLocation());
      sweepText(document.body);
      sweepAvatars(document.body);
    } finally {
      if (enabled) observe();
    }
    lastSweep = Date.now();
  }

  function scheduleSweep() {
    if (!enabled || sweepTimer) return;
    const wait = Math.max(0, SWEEP_FLOOR_MS - (Date.now() - lastSweep));
    sweepTimer = setTimeout(() => {
      sweepTimer = null;
      requestAnimationFrame(sweep);
    }, wait);
  }

  function observe() {
    if (!observer) observer = new MutationObserver(scheduleSweep);
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  }

  function enable() {
    if (enabled) return;
    enabled = true;
    injectStyle();
    // sweep() re-arms the observer itself, so there is no observe() call here.
    sweep();
  }

  function disable() {
    enabled = false;
    observer?.disconnect();
    clearTimeout(sweepTimer);
    sweepTimer = null;

    // One entry per node, holding what the page said before we ever touched
    // it, so order does not matter here. Nodes Instagram has since detached
    // are written to harmlessly.
    //
    // Dropped from the WeakMap as well as the list: a node left in there is
    // one that a later enable() would treat as already recorded and never add
    // back to the list, so the mode after next would have nothing to restore.
    for (const entry of textEntries) {
      entry.node.nodeValue = entry.original;
      touchedText.delete(entry.node);
    }
    textEntries.length = 0;

    for (const entry of altEntries) {
      entry.image.setAttribute('alt', entry.original);
      touchedAlt.delete(entry.image);
    }
    altEntries.length = 0;

    for (const node of document.querySelectorAll(`.${BLUR_CLASS}`)) {
      node.classList.remove(BLUR_CLASS);
    }
    document.getElementById(STYLE_ID)?.remove();
  }

  // -------------------------------------------------------------------- wiring

  window.__requestBlaster = window.__requestBlaster || {};

  const ops = {
    /**
     * @param on     turn the mode on or off
     * @param names  `{ handle: realFullName }` the panel already holds. A
     *   profile header's name sits outside any link, so without this it stays
     *   real until that person happens to be linked somewhere on the page.
     */
    async anonMode({ on, names }) {
      await loadAlias();
      if (on) {
        seedNames(names);
        enable();
      } else {
        disable();
      }
      return { ok: true, data: { on: enabled } };
    },
  };

  // Called as a method, not through a saved reference: content.js's register
  // happens to be an arrow function today, but a detached call to anything
  // that reads `this` would throw here — at the top level of this IIFE, taking
  // the session-storage self-start below down with it. Registering into the
  // shared table directly is the fallback for a stale content.js that predates
  // the register seam.
  if (typeof window.__requestBlaster.register === 'function') {
    window.__requestBlaster.register(ops);
  } else {
    window.__requestBlaster.ops = window.__requestBlaster.ops || {};
    Object.assign(window.__requestBlaster.ops, ops);
  }

  // A hard navigation destroys this world and rebuilds it, and the panel is
  // not watching for that — so the flag is read back here rather than pushed.
  // background.js grants content scripts session access via setAccessLevel.
  chrome.storage.session
    .get(SESSION_KEY)
    .then(async (stored) => {
      const saved = stored?.[SESSION_KEY];
      if (!saved?.on) return;
      await loadAlias();
      seedNames(saved.names);
      enable();
    })
    .catch(() => {
      // No session access, or the extension context was invalidated by a
      // reload. Either way the mode is simply off for this page.
    });
})();
