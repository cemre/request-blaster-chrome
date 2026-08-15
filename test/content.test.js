import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const SOURCE = readFileSync(new URL('../content.js', import.meta.url), 'utf8');

/**
 * content.js is a classic content script: no exports, so nothing can import it.
 * Running the real file in a vm with the handful of page globals it touches
 * tests the classification that actually ships rather than a copy of it, and
 * `igFetch` is already on the bridge for harvest-content.js to use.
 */
function loadContentScript({ cookie = '', response } = {}) {
  const window = {};
  const calls = [];
  const context = {
    window,
    document: { cookie, scripts: [] },
    sessionStorage: { getItem: () => null },
    chrome: { runtime: { onMessage: { addListener: () => {} } } },
    console,
    URL,
    // `response` is one response for every call, or a function of the call
    // index for the tests that need each attempt answered differently — the
    // shape fallback only means anything across more than one request.
    fetch: async (url, init) => {
      calls.push({ url, init });
      return typeof response === 'function' ? response(calls.length - 1, url, init) : response;
    },
  };
  vm.runInNewContext(SOURCE, context);
  return { bridge: window.__requestBlaster, calls };
}

/** A signed-in browser: `sessionid` is HttpOnly, `ds_user_id` is not. */
const SIGNED_IN = 'ds_user_id=1783; csrftoken=abc';

const jsonResponse = (status, body, url = 'https://www.instagram.com/api/v1/friendships/show_many/') => ({
  ok: status >= 200 && status < 300,
  status,
  url,
  text: async () => JSON.stringify(body),
});

const pageResponse = (status, url) => ({
  ok: status >= 200 && status < 300,
  status,
  url,
  text: async () => '<!doctype html><html><body>Instagram</body></html>',
});

const call = (options) =>
  loadContentScript(options).bridge.igFetch('https://www.instagram.com/api/v1/friendships/show_many/', { method: 'POST' });

/** Run a named operation and hand back the request it made. */
async function requestFor(op, args) {
  const { bridge, calls } = loadContentScript({
    cookie: SIGNED_IN,
    response: jsonResponse(200, { friendship_statuses: {} }),
  });
  await bridge.call(op, args);
  return calls[0];
}

test('a 401 with the session cookie still set is a refusal, not a sign-out', async () => {
  const result = await call({
    cookie: SIGNED_IN,
    response: jsonResponse(401, { message: 'login_required', status: 'fail' }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.loggedOut, undefined);
  assert.equal(result.reason, 'session_rejected');
  assert.equal(result.status, 401);
});

test('a 401 with no session cookie is a sign-out', async () => {
  const result = await call({
    cookie: '',
    response: jsonResponse(401, { message: 'login_required', status: 'fail' }),
  });

  assert.equal(result.loggedOut, true);
  assert.equal(result.reason, 'signed_out');
});

test('login_required at HTTP 200 is judged on the cookie too', async () => {
  const signedIn = await call({
    cookie: SIGNED_IN,
    response: jsonResponse(200, { message: 'login_required', status: 'fail' }),
  });
  assert.equal(signedIn.reason, 'session_rejected');

  const signedOut = await call({
    cookie: '',
    response: jsonResponse(200, { message: 'login_required', status: 'fail' }),
  });
  assert.equal(signedOut.reason, 'signed_out');
});

test('an HTML body from an API URL is not read as a sign-out while signed in', async () => {
  const result = await call({
    cookie: SIGNED_IN,
    response: pageResponse(500, 'https://www.instagram.com/api/v1/friendships/show_many/'),
  });

  assert.equal(result.ok, false);
  assert.equal(result.loggedOut, undefined);
  assert.equal(result.reason, 'html_response');
  assert.equal(result.status, 500);
});

test('an HTML body served from the login page is a sign-out, cookie or not', async () => {
  const result = await call({
    cookie: SIGNED_IN,
    response: pageResponse(200, 'https://www.instagram.com/accounts/login/?next=/api/v1/'),
  });

  assert.equal(result.loggedOut, true);
  assert.equal(result.reason, 'signed_out');
});

test('an HTML body with no session cookie is a sign-out', async () => {
  const result = await call({
    cookie: '',
    response: pageResponse(200, 'https://www.instagram.com/api/v1/friendships/show_many/'),
  });

  assert.equal(result.loggedOut, true);
  assert.equal(result.reason, 'signed_out');
});

test('checkpoint_required says the account needs clearing, not that it is signed out', async () => {
  const result = await call({
    cookie: SIGNED_IN,
    response: jsonResponse(400, { message: 'checkpoint_required', status: 'fail' }),
  });

  assert.equal(result.blocked, true);
  assert.equal(result.loggedOut, undefined);
  assert.equal(result.reason, 'checkpoint');
});

test('challenge_required is a block with its own reason', async () => {
  const result = await call({
    cookie: SIGNED_IN,
    response: jsonResponse(400, { message: 'challenge_required', status: 'fail' }),
  });

  assert.equal(result.blocked, true);
  assert.equal(result.reason, 'challenge');
});

test('a 429 is a rate limit', async () => {
  const result = await call({
    cookie: SIGNED_IN,
    response: jsonResponse(429, { message: 'rate_limited' }),
  });

  assert.equal(result.blocked, true);
  assert.equal(result.reason, 'rate_limited');
});

test('a status: fail body stays a plain failure and halts nothing', async () => {
  const result = await call({
    cookie: SIGNED_IN,
    response: jsonResponse(200, { status: 'fail', message: 'Something went wrong' }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.blocked, undefined);
  assert.equal(result.loggedOut, undefined);
  assert.equal(result.error, 'Something went wrong');
});

// Instagram has flipped which shape this one endpoint routes three times in
// three weeks (POST form → GET query 2026-07-30 → POST form 2026-08-08 → GET
// query 2026-08-15), each flip costing a release. These tests pin the
// *fallback*, not a shape: which one is asked first is a preference, and being
// wrong about it must cost one request rather than a broken panel.
const SHOW_MANY = 'https://www.instagram.com/api/v1/friendships/show_many/';

const statuses = (status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  url: SHOW_MANY,
  text: async () => JSON.stringify({ friendship_statuses: { 1: { following: false } } }),
});

/** Run showMany against a per-attempt responder and hand back every request. */
async function showMany(response, userIds = ['1', '2', '3']) {
  const { bridge, calls } = loadContentScript({ cookie: SIGNED_IN, response });
  const result = await bridge.call('showMany', { userIds });
  return { result, calls };
}

test('showMany asks by query string first', async () => {
  const { calls } = await showMany(() => statuses());

  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[0].url, `${SHOW_MANY}?user_ids=1,2,3`);
});

test('a web page in answer to one shape is retried as the other, not surfaced', async () => {
  const { result, calls } = await showMany((index) =>
    index === 0 ? pageResponse(200, SHOW_MANY) : statuses());

  assert.equal(result.ok, true, 'the fallback shape answered, so the call succeeded');
  assert.equal(calls.length, 2);
  assert.equal(calls[1].init.method, 'POST');
  assert.equal(calls[1].url, SHOW_MANY);
  assert.equal(calls[1].init.body, 'user_ids=1,2,3');
  assert.equal(calls[1].init.headers['Content-Type'], 'application/x-www-form-urlencoded');
});

test('a 405 falls back too — the other flip answered exactly that way', async () => {
  const { result, calls } = await showMany((index) =>
    index === 0 ? jsonResponse(405, { message: 'Method not allowed' }, SHOW_MANY) : statuses());

  assert.equal(result.ok, true);
  assert.equal(calls.length, 2);
});

// The whole extension is serialised to hold one request rate Instagram doesn't
// publish. Retrying a throttle in a second shape doubles the rate at the exact
// moment it is already too high, so only a shape *refusal* may cost a request.
test('a rate limit is never retried in the other shape', async () => {
  const { result, calls } = await showMany(() => jsonResponse(429, { message: 'rate_limited' }, SHOW_MANY));

  assert.equal(calls.length, 1, 'a throttle must cost one request, not two');
  assert.equal(result.blocked, true);
  assert.equal(result.reason, 'rate_limited');
});

test('a sign-out is never retried in the other shape either', async () => {
  const { bridge, calls } = loadContentScript({
    cookie: '',
    response: jsonResponse(401, { message: 'login_required' }, SHOW_MANY),
  });
  const result = await bridge.call('showMany', { userIds: ['1'] });

  assert.equal(calls.length, 1);
  assert.equal(result.reason, 'signed_out');
});

test('the shape that answered is remembered, so a flip costs one request per page', async () => {
  const { bridge, calls } = loadContentScript({
    cookie: SIGNED_IN,
    response: (index) => (index === 0 ? pageResponse(200, SHOW_MANY) : statuses()),
  });

  await bridge.call('showMany', { userIds: ['1'] });
  await bridge.call('showMany', { userIds: ['2'] });
  await bridge.call('showMany', { userIds: ['3'] });

  assert.equal(calls.length, 4, 'one probe, then the learned shape for every call after');
  for (const request of calls.slice(1)) assert.equal(request.init.method, 'POST');
});

test('both shapes refused reports the failure, and halts as it always did', async () => {
  const { result, calls } = await showMany(() => pageResponse(200, SHOW_MANY));

  assert.equal(calls.length, 2, 'two shapes, two requests, then stop');
  assert.equal(result.ok, false);
  assert.equal(result.blocked, true);
  assert.equal(result.reason, 'html_response');
  assert.equal(result.bodyLength > 0, true, 'the (i) still has the response to show');
});

test('the write endpoints stay POSTs under /web/', async () => {
  for (const [op, path] of [['approve', 'approve'], ['ignore', 'ignore'], ['follow', 'follow']]) {
    const request = await requestFor(op, { userId: '42' });
    assert.equal(request.init.method, 'POST', `${op} must stay a POST`);
    assert.equal(request.url, `https://www.instagram.com/api/v1/web/friendships/42/${path}/`);
  }
});

test('a failure carries the response verbatim, with the URL it came from', async () => {
  const result = await call({
    cookie: SIGNED_IN,
    response: pageResponse(200, 'https://www.instagram.com/api/v1/friendships/show_many/'),
  });

  const served = '<!doctype html><html><body>Instagram</body></html>';
  assert.equal(result.body, served);
  assert.equal(result.bodyLength, served.length);
  assert.equal(result.url, 'https://www.instagram.com/api/v1/friendships/show_many/');
});

test('a JSON failure carries its body too, not just the message', async () => {
  const result = await call({
    cookie: SIGNED_IN,
    response: jsonResponse(400, { status: 'fail', message: 'Something went wrong', extra: 'kept' }),
  });

  assert.equal(JSON.parse(result.body).extra, 'kept');
});

test('an oversized body is sampled, and says so by reporting the full length', async () => {
  const huge = '<html>' + 'x'.repeat(20000);
  const result = await call({
    cookie: SIGNED_IN,
    response: {
      ok: true,
      status: 200,
      url: 'https://www.instagram.com/api/v1/friendships/show_many/',
      text: async () => huge,
    },
  });

  assert.equal(result.body.length, 8000);
  assert.equal(result.bodyLength, huge.length);
});

test('a good response carries no body sample — nothing to diagnose', async () => {
  const result = await call({
    cookie: SIGNED_IN,
    response: jsonResponse(200, { friendship_statuses: {} }),
  });

  assert.equal(result.body, undefined);
});

test('a good response comes back with its data', async () => {
  const result = await call({
    cookie: SIGNED_IN,
    response: jsonResponse(200, { friendship_statuses: { 1: { following: true } } }),
  });

  assert.equal(result.ok, true);
  // Compared through JSON: the body was parsed inside the vm, so its objects
  // carry that realm's prototypes and deepEqual would fail on identity alone.
  assert.equal(JSON.stringify(result.data.friendship_statuses), '{"1":{"following":true}}');
});
