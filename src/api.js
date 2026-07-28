// api.js — talks to the Instagram tab's content script.
//
// The panel resolves and holds the tab itself. The service worker is not in
// this path, so nothing here depends on the worker being awake.

const IG_TAB_PATTERN = '*://*.instagram.com/*';
const IG_HOME = 'https://www.instagram.com/';

const PING_ATTEMPTS = 10;
const PING_INTERVAL_MS = 500;

// Spacing for the bulk pass. Not a rate-limit concern the way writes are, but
// ~20 back-to-back calls on a 1000+ queue is worth not firing flat out.
const BULK_GAP_MS = 400;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class ApiError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code;
  }
}

let tabId = null;

async function isInstagramTab(id) {
  if (id === null || id === undefined) return false;
  try {
    const tab = await chrome.tabs.get(id);
    return Boolean(tab?.url && /^https?:\/\/([a-z0-9-]+\.)*instagram\.com\//i.test(tab.url));
  } catch {
    return false;
  }
}

async function waitForTabComplete(id) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const tab = await chrome.tabs.get(id);
      if (tab.status === 'complete') return true;
    } catch {
      return false;
    }
    await sleep(250);
  }
  return false;
}

async function pingOnce(id) {
  try {
    const response = await chrome.tabs.sendMessage(id, { type: 'RB_PING' });
    return Boolean(response?.ok);
  } catch {
    // No listener — either the page is mid-navigation, or the content script
    // was never injected into this tab at all.
    return false;
  }
}

async function waitForContentScript(id) {
  for (let attempt = 0; attempt < PING_ATTEMPTS; attempt += 1) {
    if (await pingOnce(id)) return true;

    // A few failed pings means this is probably not a mid-navigation blip but
    // a tab that predates the extension being loaded — `content_scripts` does
    // not retroactively inject into those. Inject explicitly and re-ping.
    // content.js guards against running twice.
    if (attempt === 2) {
      try {
        await chrome.scripting.executeScript({ target: { tabId: id }, files: ['content.js'] });
        if (await pingOnce(id)) return true;
      } catch {
        // Restricted page, or the scripting permission was declined.
      }
    }

    await sleep(PING_INTERVAL_MS);
  }
  return false;
}

/** Find an Instagram tab, or open one. Prefers the current window. */
export async function ensureTab() {
  if (await isInstagramTab(tabId)) return tabId;

  let tabs = [];
  try {
    tabs = await chrome.tabs.query({ url: [IG_TAB_PATTERN], currentWindow: true });
  } catch {
    /* fall through to an all-windows query */
  }
  if (tabs.length === 0) {
    tabs = await chrome.tabs.query({ url: [IG_TAB_PATTERN] });
  }

  if (tabs.length > 0) {
    tabId = tabs[0].id;
  } else {
    const created = await chrome.tabs.create({ url: IG_HOME, active: true });
    tabId = created.id;
  }

  await waitForTabComplete(tabId);
  if (!(await waitForContentScript(tabId))) {
    throw new ApiError('content_not_ready', 'Instagram tab is not responding yet.');
  }
  return tabId;
}

/** Point the main tab at a profile. The panel stays put — that's the point. */
export async function navigateToProfile(username) {
  const id = await ensureTab();
  await chrome.tabs.update(id, { url: `https://www.instagram.com/${username}/`, active: true });
}

/**
 * One API call. Returns the content script's envelope:
 *   { ok: true, data } | { ok: false, error, status, blocked?, loggedOut? }
 */
export async function call(op, args = {}) {
  const id = await ensureTab();
  try {
    return await chrome.tabs.sendMessage(id, { type: 'RB_IG_API', op, args });
  } catch {
    // The content script died under us, almost always because the user or the
    // panel navigated the tab. Re-resolve once and retry.
    tabId = null;
    const retryId = await ensureTab();
    return await chrome.tabs.sendMessage(retryId, { type: 'RB_IG_API', op, args });
  }
}

function raise(result) {
  if (result?.loggedOut) throw new ApiError('logged_out', 'Not signed in to Instagram.');
  if (result?.blocked) throw new ApiError('blocked', result.error || 'Instagram is rate limiting requests.');
  throw new ApiError('api_error', result?.error || 'Instagram API request failed.');
}

// Verified 2026-07-28: friendships/pending/ serves at most 200 users and
// returns next_max_id: null, and every cursor variant (?max_id=, ?count=,
// ?page=) returns the identical first page. So in practice this loop runs
// exactly once. The pagination is kept because it costs nothing and Instagram
// has shipped it before, but the guards below stop a resurrected-but-broken
// cursor from spinning forever.
export const SERVER_PAGE_CAP = 200;
const MAX_PAGES = 10;

/**
 * Page through friendships/pending/ as far as Instagram allows.
 * `onPage` fires per page so the panel can render progressively.
 *
 * @returns {{ users: Array, capped: boolean }} `capped` means Instagram
 *   handed back a full page with no way to ask for more — there are almost
 *   certainly further requests that only become visible once these are cleared.
 */
export async function fetchAllPending(onPage) {
  const users = [];
  const seenCursors = new Set();
  let maxId = '';
  let page = 0;

  do {
    const result = await call('pending', maxId ? { maxId } : {});
    if (!result?.ok) raise(result);

    const batch = result.data?.users || [];
    users.push(...batch);
    page += 1;
    if (onPage) onPage({ page, batch, total: users.length });

    const nextCursor = result.data?.next_max_id || '';
    // A repeated cursor means the server is repeating itself, not paginating.
    if (!nextCursor || seenCursors.has(nextCursor) || page >= MAX_PAGES) {
      maxId = '';
    } else {
      seenCursors.add(nextCursor);
      maxId = nextCursor;
      await sleep(BULK_GAP_MS);
    }
  } while (maxId);

  return { users, capped: users.length >= SERVER_PAGE_CAP };
}

/** Follow status for every id, 100 per request. */
export async function fetchFollowStatuses(userIds, onChunk) {
  const statuses = {};
  const CHUNK = 100;

  for (let index = 0; index < userIds.length; index += CHUNK) {
    const chunk = userIds.slice(index, index + CHUNK);
    const result = await call('showMany', { userIds: chunk });
    if (!result?.ok) raise(result);

    Object.assign(statuses, result.data?.friendship_statuses || {});
    if (onChunk) onChunk({ done: Math.min(index + CHUNK, userIds.length), total: userIds.length });

    if (index + CHUNK < userIds.length) await sleep(BULK_GAP_MS);
  }

  return statuses;
}
