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

// Instagram wants the account to clear something in the UI before it will act
// again. Signed in, and nothing here can fix it — the tab has to.
const INTERSTITIAL_REASONS = new Map([
  ['challenge_required', 'challenge'],
  ['checkpoint_required', 'checkpoint'],
]);

/**
 * Does this browser hold an Instagram session at all?
 *
 * `sessionid` is HttpOnly and invisible from here, so it can never be the test.
 * `ds_user_id` is set beside it at sign-in and is readable — harvest-content.js
 * already reads it to learn who the viewer is, so it is the same evidence the
 * harvest has trusted all along.
 *
 * Read live rather than cached: a session can end mid-run, which is exactly the
 * case this is here to catch.
 */
function hasSession() {
  return Boolean(readCookie('ds_user_id'));
}

// Where the fetch actually ended up. Instagram bounces an unauthenticated API
// call to the login page, and a response that finished there says signed-out on
// its own evidence rather than on a guess about what HTML means.
const LOGIN_URL = /\/accounts\/(login|signup|suspended|disabled)/i;

/**
 * Instagram refused to treat the call as authenticated. Whether that means
 * *you* are signed out is a separate question, and the cookie answers it.
 *
 * These two used to be one branch, which is how a signed-in account got told to
 * sign in: the bulk endpoints answer a soft throttle with 401 `login_required`
 * while the session cookie is still sitting right there, and "sign in, then
 * retry" is advice nobody in that state can act on.
 */
function unauthenticated(status, message) {
  return hasSession()
    ? { ok: false, blocked: true, status, reason: 'session_rejected', error: message || `HTTP ${status}` }
    : { ok: false, loggedOut: true, status, reason: 'signed_out', error: message || 'login_required' };
}

function classify(status, body) {
  const message = body && typeof body.message === 'string' ? body.message : null;
  const interstitial = message ? INTERSTITIAL_REASONS.get(message) : null;

  if (interstitial) {
    return { ok: false, blocked: true, status, reason: interstitial, error: message };
  }
  if (status === 429 || (message && BLOCK_MESSAGES.has(message)) || body?.spam === true) {
    return { ok: false, blocked: true, status, reason: 'rate_limited', error: message || 'rate_limited' };
  }
  if (message === 'login_required' || status === 401) {
    return unauthenticated(status, message);
  }
  // Instagram signals failure in the body while still returning HTTP 200. The
  // old i.instagram.com show_many calls failed exactly this way, which is why
  // nobody noticed follow status was always coming back empty.
  if (body?.status === 'fail') {
    return { ok: false, status, error: message || 'Instagram returned status: fail' };
  }
  return null;
}

/**
 * An HTML body where JSON was expected. Three different things arrive this way
 * and they do not mean the same thing: the login page when the session really
 * is gone, an interstitial when the account has something to clear, and a plain
 * error page when something upstream fell over. Only the first is a sign-out,
 * so the URL and the cookie decide before anything claims to know.
 *
 * The rest still halt the queue — `blocked` rather than a plain failure —
 * because an endpoint answering with a web page is not answering, and running
 * two hundred more requests into it only turns one failure into two hundred.
 */
function htmlResponse(response) {
  const status = response.status;
  if (LOGIN_URL.test(response.url || '') || !hasSession()) {
    return { ok: false, loggedOut: true, status, reason: 'signed_out', error: 'login_required' };
  }
  return {
    ok: false,
    blocked: true,
    status,
    reason: 'html_response',
    error: `Instagram served a web page instead of data (HTTP ${status})`,
  };
}

// How much of a failing response to carry back to the panel. Instagram's HTML
// runs to megabytes and none of it needs to cross the message boundary to be
// useful — what identifies a page sits at the top of it. `bodyLength` rides
// along so a truncated sample can never be read as a short response.
const BODY_SAMPLE = 8000;

/**
 * Attach what actually came back to a failure on its way out.
 *
 * Every classification above is an interpretation, and an interpretation that
 * throws away its evidence cannot be checked. This is what the banner's (i)
 * shows: the resolved URL — which is not always the one asked for — and the
 * response verbatim.
 */
function withResponse(problem, response, text) {
  return {
    ...problem,
    url: response.url || '',
    body: text.length > BODY_SAMPLE ? text.slice(0, BODY_SAMPLE) : text,
    bodyLength: text.length,
  };
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
    return { ok: false, status: 0, error: `network: ${err.message}`, url };
  }

  const text = await response.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    // Instagram serves HTML instead of JSON in several situations, only one of
    // which is a dead session. See htmlResponse.
    if (/<html/i.test(text)) return withResponse(htmlResponse(response), response, text);
  }

  const problem = classify(response.status, body);
  if (problem) return withResponse(problem, response, text);

  if (!response.ok) {
    const failure = { ok: false, status: response.status, error: body?.message || `HTTP ${response.status}` };
    return withResponse(failure, response, text);
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

// The two shapes `friendships/show_many/` has been observed to route, and the
// only place either is written down. First here is asked first — keep the one
// most recently seen working in front, so the common case costs one request.
const SHOW_MANY_SHAPES = [
  ['query', (userIds) => [
    `${API_ROOT}/friendships/show_many/?user_ids=${userIds.join(',')}`,
    { method: 'GET' },
  ]],
  ['form', (userIds) => [
    `${API_ROOT}/friendships/show_many/`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `user_ids=${userIds.join(',')}`,
    },
  ]],
];

/**
 * The shape that last answered, in front. Held on the bridge rather than in a
 * module variable for the same reason the operation table is — this file is
 * injected twice and both executions should learn from one probe.
 *
 * Nothing clears it: it is only ever set from a success, and a learned shape
 * that later stops routing simply falls through to the other one and is
 * replaced. That is what makes a flip mid-session cost one request too, not
 * just a flip between sessions.
 */
function orderedShapes() {
  const learned = window.__requestBlaster.showManyShape;
  return [
    ...SHOW_MANY_SHAPES.filter(([name]) => name === learned),
    ...SHOW_MANY_SHAPES.filter(([name]) => name !== learned),
  ];
}

/**
 * Instagram declining to route the *shape*, as opposed to answering the call.
 *
 * Both flips presented as exactly one of these two: HTTP 405, or an HTTP 200
 * carrying ~600KB of the logged-in web app shell — which `htmlResponse` has
 * already told apart from a real sign-out, on the cookie, before this sees it.
 *
 * This predicate is the one thing keeping the fallback honest. Everything else
 * — a throttle, a challenge, a dead session — is an answer, and retrying an
 * answer in a second shape would double the request rate at the exact moment
 * Instagram is saying it is already too high.
 */
function wrongShape(result) {
  return result.status === 405 || result.reason === 'html_response';
}

Object.assign(OPERATIONS, {
  pending({ maxId }) {
    const url = maxId
      ? `${API_ROOT}/friendships/pending/?max_id=${encodeURIComponent(maxId)}`
      : `${API_ROOT}/friendships/pending/`;
    return igFetch(url, { method: 'GET' });
  },

  /**
   * Ask in whichever shape answers, rather than in the one that answered last
   * time. `show_many` is the only endpoint here whose accepted request shape
   * Instagram keeps changing — POST + form body until 2026-07-30, GET + query
   * string until 2026-08-08, POST again until 2026-08-15 — and each flip broke
   * follow status for everyone until a release went out. Three releases in three
   * weeks spent pinning a shape is what this replaces: the endpoint's shape is
   * not a fact about Instagram to be looked up, it is a property of whatever
   * server answered, so it gets discovered per session instead of encoded.
   *
   * The order in SHOW_MANY_SHAPES is a preference, not a pin. Being wrong about
   * it costs one request, once per page, and never a broken panel.
   */
  async showMany({ userIds }) {
    let result;
    for (const [name, build] of orderedShapes()) {
      result = await igFetch(...build(userIds));
      if (result.ok) {
        window.__requestBlaster.showManyShape = name;
        return result;
      }
      // An answer, not a refusal to route. Stop: asking again in another shape
      // would spend a second request to be told the same thing.
      if (!wrongShape(result)) return result;
    }
    return result;
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
