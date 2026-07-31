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
  const context = {
    window,
    document: { cookie, scripts: [] },
    sessionStorage: { getItem: () => null },
    chrome: { runtime: { onMessage: { addListener: () => {} } } },
    console,
    URL,
    fetch: async () => response,
  };
  vm.runInNewContext(SOURCE, context);
  return window.__requestBlaster;
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
  loadContentScript(options).igFetch('https://www.instagram.com/api/v1/friendships/show_many/', { method: 'POST' });

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
