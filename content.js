// content.js — stateless Instagram API proxy.
//
// The only reason this file exists: calls to Instagram's private API need to
// originate from an instagram.com page with the page's own CSRF token and app
// id. It holds no state worth preserving — every hard navigation destroys and
// recreates it, and that is fine.

const DEBUG = false;

// The well-known Instagram web app id. Only used if scraping the page fails.
const IG_APP_ID_FALLBACK = '936619743392459';

let cachedHeaders = null;

function readCookie(name) {
  const match = document.cookie.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]*)'));
  return match ? decodeURIComponent(match[1]) : null;
}

// Instagram embeds its config as JSON inside inline <script> tags. Searching
// those is far cheaper than serialising the whole DOM, which runs to megabytes.
function scrapeFromScripts(pattern) {
  for (const script of document.scripts) {
    if (script.src || !script.textContent) continue;
    const match = script.textContent.match(pattern);
    if (match) return match[1] ?? match[0];
  }
  return null;
}

function buildHeaders() {
  if (cachedHeaders) return cachedHeaders;

  const csrf = readCookie('csrftoken') || scrapeFromScripts(/"csrf_token":"(.+?)"/i);
  const appId = scrapeFromScripts(/"X-IG-App-ID":"(.+?)"/i) || IG_APP_ID_FALLBACK;
  const rolloutHash = scrapeFromScripts(/"rollout_hash":"(.+?)"/i);

  cachedHeaders = {
    'X-Requested-With': 'XMLHttpRequest',
    'X-Asbd-Id': '129477',
    'X-Ig-App-Id': appId,
    'X-Ig-Www-Claim': sessionStorage.getItem('www-claim-v2') || '0',
  };
  if (csrf) cachedHeaders['X-Csrftoken'] = csrf;
  if (rolloutHash) cachedHeaders['X-Instagram-Ajax'] = rolloutHash;

  if (DEBUG) console.log('[Request Blaster] headers', cachedHeaders);
  return cachedHeaders;
}

// Responses Instagram uses to say "you are going too fast" or "prove you're
// human". Both mean: stop the queue, do not retry in a loop.
const BLOCK_MESSAGES = new Set([
  'challenge_required',
  'feedback_required',
  'rate_limited',
  'Please wait a few minutes before you try again.',
]);

function classify(status, body) {
  const message = body && typeof body.message === 'string' ? body.message : null;

  if (status === 429 || (message && BLOCK_MESSAGES.has(message)) || body?.spam === true) {
    return { ok: false, blocked: true, status, error: message || 'rate_limited' };
  }
  if (message === 'login_required' || status === 401) {
    return { ok: false, loggedOut: true, status, error: 'login_required' };
  }
  // Instagram signals failure in the body while still returning HTTP 200. The
  // old i.instagram.com show_many calls failed exactly this way, which is why
  // nobody noticed follow status was always coming back empty.
  if (body?.status === 'fail') {
    return { ok: false, status, error: message || 'Instagram returned status: fail' };
  }
  return null;
}

async function igFetch(url, init = {}) {
  let response;
  try {
    response = await fetch(url, {
      credentials: 'include',
      mode: 'cors',
      ...init,
      headers: { ...buildHeaders(), ...(init.headers || {}) },
    });
  } catch (err) {
    return { ok: false, status: 0, error: `network: ${err.message}` };
  }

  const text = await response.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    // Instagram serves an HTML login page instead of JSON when the session dies.
    if (/<html/i.test(text)) return { ok: false, loggedOut: true, status: response.status, error: 'login_required' };
  }

  const problem = classify(response.status, body);
  if (problem) return problem;

  if (!response.ok) {
    return { ok: false, status: response.status, error: body?.message || `HTTP ${response.status}` };
  }
  return { ok: true, data: body };
}

// Everything goes through www.instagram.com. Verified 2026-07-28: the
// i.instagram.com host answers friendships/show_many/ and friendships/show/
// with HTTP 200 + {"status":"fail"}, while www answers correctly. Using www
// throughout also makes every call same-origin from this content script.
const API_ROOT = 'https://www.instagram.com/api/v1';

// One table per isolated world, not one per execution. This file is injected
// twice — by the manifest on navigation and by chrome.scripting when the panel
// meets a tab that predates the extension — and a fresh object each time would
// orphan whatever a feature content script had registered into the previous
// one, while the already-bound message listener kept answering from it. Hold
// it on the shared bridge so every execution and every registration converge
// on the same table.
window.__requestBlaster = window.__requestBlaster || {};
const OPERATIONS = window.__requestBlaster.ops || (window.__requestBlaster.ops = {});

Object.assign(OPERATIONS, {
  pending({ maxId }) {
    const url = maxId
      ? `${API_ROOT}/friendships/pending/?max_id=${encodeURIComponent(maxId)}`
      : `${API_ROOT}/friendships/pending/`;
    return igFetch(url, { method: 'GET' });
  },

  showMany({ userIds }) {
    return igFetch(`${API_ROOT}/friendships/show_many/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `user_ids=${userIds.join(',')}`,
    });
  },

  profile({ username }) {
    return igFetch(`${API_ROOT}/users/web_profile_info/?username=${encodeURIComponent(username)}`, {
      method: 'GET',
    });
  },

  approve({ userId }) {
    return igFetch(`${API_ROOT}/web/friendships/${userId}/approve/`, { method: 'POST' });
  },

  ignore({ userId }) {
    return igFetch(`${API_ROOT}/web/friendships/${userId}/ignore/`, { method: 'POST' });
  },

  // Follow back. Answers { status: 'ok', result: 'following' | 'requested' } —
  // 'requested' when the account is private, which is still the case right
  // after you accept their request.
  follow({ userId }) {
    return igFetch(`${API_ROOT}/web/friendships/${userId}/follow/`, { method: 'POST' });
  },

  /**
   * Proxy a CDN image back as a data URL. Serves both profile pictures and
   * post thumbnails — nothing about the fetch is avatar-specific.
   *
   * Instagram's CDN sets Cross-Origin-Resource-Policy, so the side panel
   * cannot put these URLs in an <img> — the load fails with
   * ERR_BLOCKED_BY_RESPONSE.NotSameOrigin. From an instagram.com page the same
   * fetch succeeds, so the panel routes these through here. Avatars run about
   * 6KB each.
   */
  async media({ url }) {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return { ok: false, status: 0, error: 'invalid url' };
    }
    // Strictly Instagram's own CDNs. Without this the op is a general-purpose
    // fetch relay running with the page's credentials.
    if (parsed.protocol !== 'https:' || !/(^|\.)(cdninstagram\.com|fbcdn\.net)$/.test(parsed.hostname)) {
      return { ok: false, status: 0, error: 'host not allowed' };
    }

    let response;
    try {
      response = await fetch(parsed.href, { credentials: 'omit' });
    } catch (err) {
      return { ok: false, status: 0, error: `network: ${err.message}` };
    }
    if (!response.ok) return { ok: false, status: response.status, error: `HTTP ${response.status}` };

    const blob = await response.blob();
    if (!blob.type.startsWith('image/')) return { ok: false, status: 0, error: 'not an image' };
    if (blob.size > 2 * 1024 * 1024) return { ok: false, status: 0, error: 'image too large' };

    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });

    return { ok: true, data: { dataUrl } };
  },
});

// The panel's avatar loader predates this rename. Keeping the old name working
// means a stale content script during a reload does not break avatars.
OPERATIONS.avatar = OPERATIONS.media;

// banner.js runs in the same isolated world and needs to make the same
// authenticated calls, so the operation table is shared here rather than
// duplicated.
window.__requestBlaster.call = (op, args = {}) => {
  const operation = (window.__requestBlaster.ops || OPERATIONS)[op];
  if (!operation) return Promise.resolve({ ok: false, error: `unknown op: ${op}` });
  return operation(args).catch((err) => ({ ok: false, status: 0, error: String(err) }));
};

// Feature-specific content scripts (e.g. harvest-content.js) need the same
// authenticated fetch rather than a second copy of it, since igFetch carries
// header scraping and the classify() error contract. Exposed here rather than
// duplicated so a rate-limit response is recognised identically everywhere.
window.__requestBlaster.igFetch = igFetch;
window.__requestBlaster.API_ROOT = API_ROOT;
window.__requestBlaster.readCookie = readCookie;
// Optional feature content scripts register their operations here instead of
// being listed in OPERATIONS, so a feature can be added or removed by editing
// the manifest alone.
window.__requestBlaster.register = (ops) => Object.assign(OPERATIONS, ops);

// This file arrives two ways: the manifest's content_scripts declaration on
// navigation, and chrome.scripting.executeScript when the panel finds a tab
// that predates the extension. Both can land in the same frame, and a second
// listener would answer every message twice. The isolated world persists
// across injections, so this flag is a reliable guard.
if (!window.__requestBlasterListenerBound) {
  window.__requestBlasterListenerBound = true;
  bindMessageListener();
}

function bindMessageListener() {
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'RB_PING') {
    sendResponse({ ok: true });
    return false;
  }

  if (message?.type !== 'RB_IG_API') return false;

  // Resolve against the live table, never the one this closure captured. The
  // bind guard above survives re-injection, so a listener bound by an earlier
  // build keeps answering from whatever table it closed over — one that never
  // received a feature script's registrations. That is exactly how a real
  // batch had every built-in op work while userFeed answered "unknown op" for
  // nine accounts out of ten.
  const operation = (window.__requestBlaster?.ops || OPERATIONS)[message.op];
  if (!operation) {
    sendResponse({ ok: false, error: `unknown op: ${message.op}` });
    return false;
  }

  operation(message.args || {})
    .then(sendResponse)
    .catch((err) => sendResponse({ ok: false, status: 0, error: String(err) }));

  return true; // keep the channel open for the async response
});
}
