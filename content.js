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

const OPERATIONS = {
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
};

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'RB_PING') {
    sendResponse({ ok: true });
    return false;
  }

  if (message?.type !== 'RB_IG_API') return false;

  const operation = OPERATIONS[message.op];
  if (!operation) {
    sendResponse({ ok: false, error: `unknown op: ${message.op}` });
    return false;
  }

  operation(message.args || {})
    .then(sendResponse)
    .catch((err) => sendResponse({ ok: false, status: 0, error: String(err) }));

  return true; // keep the channel open for the async response
});
