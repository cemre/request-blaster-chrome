# Instagram Follow Request Triage — Desktop Chrome Side Panel

Date: 2026-07-28
Status: Approved design, ready for implementation planning

## Problem

Instagram's own pending-follow-request list is unusable at volume. Clicking a
requester's profile navigates away and destroys the list, so triaging 1000+
requests means re-finding your place after every single decision. There is also
no way to see *why* you might want to accept someone — whether you already
follow them, how many mutuals you share, whether the account looks like a bot —
without opening each profile individually.

## Solution

A standalone desktop Chrome extension (Manifest V3) whose primary surface is a
**side panel**. The side panel persists across main-tab navigation, so the list
survives while you click through profiles. It shows every pending request
enriched with relationship and quality signals, lets you filter down to
meaningful subsets, and supports both single and bulk accept/reject with
rate-limited, interruptible action queues.

This is a **new, separate extension**, not a port of the existing one. It
carries no focus mode, no on-page banner, and no timer. It lives in a sibling
folder to `Safari Extension/`.

## Non-goals

- Focus mode / hiding feed, stories, reels — stays in the existing extension.
- On-page profile banner — deliberately excluded; the panel replaces it.
- Social timer.
- Mobile or Safari support.
- Any write action beyond `approve` and `ignore` on pending follow requests.

## Constraints and risk

- **Instagram's private API is undocumented and unstable.** Every endpoint here
  is reverse-engineered and already in production use in `Safari Extension/content.js`.
  Response-shape changes must degrade to a row-level error, never a crash.
- **Rapid friendship writes get accounts action-blocked.** There is no published
  limit. Pacing is deliberately conservative and every queue halts hard on the
  first `429` or `challenge_required`.
- **Rejections are not undoable.** Bulk rejection requires an explicit
  confirmation naming the exact count and the active filter.
- Data enrichment is throttled and batched at the user's request: 100 profiles
  at a time, on demand.

## Key finding that shaped this design

Two of the three signals the user wanted are already free:

- `friendships/pending/` returns a `social_context` string per user
  (`"Followed by alice, bob + 3 more"`). `Safari Extension/content.js:331`
  already parses an approximate mutual count out of it.
- `friendships/show_many/` returns follow status for 100 user ids per request.
  `Safari Extension/content.js:305` already uses it.

So "do I already follow them" and "roughly how many mutuals" cost **zero**
per-profile requests and are available for all 1000+ rows immediately. Only
exact mutual counts, follower/following/post counts, and bio require a
per-profile fetch. No profile *navigation* is needed for any of it.

## Architecture

### Where API calls run

The content script acts as an authenticated API bridge. It scrapes CSRF token,
app id, and rollout hash out of the page HTML and issues same-origin,
credentialed fetches — precisely the mechanism proven in the existing
extension.

The rejected alternative was fetching directly from the service worker using
`chrome.cookies` for CSRF and a hardcoded `X-IG-App-ID`. It would remove the
need for an open Instagram tab, but requires `declarativeNetRequest` rules to
rewrite `Origin`/`Referer`, and is unproven. Since the panel opens an Instagram
tab anyway, the tab requirement costs nothing.

### Components

**`sidepanel.html` / `sidepanel.js`** — owns all UI and both throttle queues.
The panel is a real document that stays alive as long as it is open, which
sidesteps MV3 service-worker termination entirely. Queue progress persists to
storage, so closing the panel mid-sweep pauses it and reopening resumes.

**`background.js`** — one statement: `setPanelBehavior({ openPanelOnActionClick:
true })`. The design originally routed API calls through the worker, but the
side panel is itself a privileged extension page with full `chrome.tabs`
access, so tab resolution and messaging live in `src/api.js` instead. Nothing
in the hot path depends on the worker being awake.

**`content.js`** — a stateless API proxy. Scrapes headers, performs one fetch
per request message, returns raw JSON. No UI, no cache, no state. It does not
matter that it is destroyed on every hard navigation.

Consequence of this split: *all* durable state lives in the panel and in
`chrome.storage`. Nothing important lives in the content script or the service
worker.

### Module layout

```
Request Blaster - Chrome Desktop/
├── manifest.json
├── background.js          # tab manager + message router
├── content.js             # stateless Instagram API proxy
├── sidepanel.html
├── sidepanel.css
├── src/
│   ├── api.js             # typed wrappers over the IG_API message protocol
│   ├── store.js           # chrome.storage access, profile cache, TTL
│   ├── queue.js           # generic throttled queue: pacing, jitter, stop, halt
│   ├── model.js           # pure: merge bulk+hydrated data, filters, sort, flags
│   ├── render.js          # windowed row rendering
│   └── panel.js           # wiring, event handlers, bulk bar
├── test/
│   └── model.test.js      # node:test, zero deps, covers src/model.js
└── images/                # reuse icons from Safari Extension/images/
```

`src/model.js` holds every pure function — `social_context` parsing, filter
predicates, sort comparators, bot-ratio flagging, row merging. It has no
`chrome.*` or DOM dependency, so it is directly unit-testable under
`node --test`. This is the only part of the system with automated tests, which
is the honest scope: the rest is browser-integration surface verified manually.

### Message protocol

Panel → content script, request/response:

```
{ type: 'RB_PING' }                → { ok: true }
{ type: 'RB_IG_API', op, args }    → { ok: true, data }
                                   | { ok: false, status, error, blocked?, loggedOut? }
```

`op` is one of `pending`, `showMany`, `profile`, `approve`, `ignore`.

`src/api.js` resolves the target tab, waits for `status === 'complete'`, and
pings the content script up to 10 times at 500ms intervals before reporting
"content script not ready" — Instagram hard-navigations create a window where
no listener exists. A `sendMessage` rejection mid-flight re-resolves the tab
once and retries, which covers the panel navigating the tab out from under an
in-flight queue.

### Instagram endpoints

All calls go to `www.instagram.com/api/v1` — see the verification findings
below for why `i.instagram.com` is not usable. This also makes every call
same-origin from the content script.

| op | Request | Yields |
|---|---|---|
| `pending` | `GET /friendships/pending/` | `users[]`: `pk` (string), `username`, `full_name`, `profile_pic_url`, `is_private`, `is_verified`, `social_context`, `has_anonymous_profile_picture`. Capped at 200, no pagination. |
| `showMany` | `POST /friendships/show_many/`, body `user_ids=a,b,c` (100 max) | `friendship_statuses{id: {following, incoming_request, is_private, is_restricted, is_bestie, outgoing_request, is_feed_favorite}}` |
| `profile` | `GET /users/web_profile_info/?username=X` | `edge_followed_by.count`, `edge_follow.count`, `edge_owner_to_timeline_media.count`, `edge_mutual_followed_by.{count, edges[].node.username}`, `biography`, `is_private`, `is_verified` |
| `approve` | `POST /web/friendships/{pk}/approve/` | — |
| `ignore` | `POST /web/friendships/{pk}/ignore/` | — |

### Verified against the live API, 2026-07-28

Read-only probes against a real logged-in session, before any panel code was
written. Four findings changed the implementation:

1. **`friendships/pending/` is capped at 200 and does not paginate.**
   `next_max_id` comes back `null`, and `?max_id=`, `?count=500` and `?page=2`
   all return the byte-identical first page. The pagination loop in the
   existing extension has therefore never fired. The panel keeps a defensive
   loop (with repeat-cursor and max-page guards) but treats 200 as the real
   ceiling and tells the user to clear the batch and Refresh for more.

2. **`show_many` is broken on `i.instagram.com` and fine on `www`.** The `i.`
   host answers `{"status":"fail","message":"We're sorry, but something went
   wrong."}` — with **HTTP 200**. `www` returns all 100 statuses correctly.
   This means the existing extension's `followed_by_viewer` has been silently
   `false` for every user. `friendships/show/{id}/` fails on `i.` the same way.

3. **HTTP 200 does not mean success.** Because of the above, the content script
   treats a `status: "fail"` body as an error regardless of HTTP status.

4. **`has_anonymous_profile_picture` ships free on the pending list.** So the
   "no profile pic" filter needs no hydration and works across all rows —
   it moved out of the enriched-only group. (`web_profile_info` does *not*
   carry this field, so URL matching remains as a fallback only.)

Also confirmed: the write route is live on both hosts (probed with user id `0`,
which returned `{"message":"No request from target user to approve"}` / HTTP
400 — no real account was touched); `pk` arrives as a string; and
`parseMutualCount` handles 100% of the 79 real `social_context` strings in the
live queue across all observed shapes, yielding counts from 1 to 187.

Headers are built once per content-script lifetime from page HTML, reusing the
scraping logic in `Safari Extension/content.js:214`: `X-Csrftoken`,
`X-Ig-App-Id`, `X-Instagram-Ajax` (rollout hash), `X-Asbd-Id`,
`X-Ig-Www-Claim` (from `sessionStorage`), `X-Requested-With`.

### Data flow on open

1. Panel opens (toolbar click, via `openPanelOnActionClick`).
2. Panel asks the service worker to ensure an `instagram.com` tab exists;
   the worker focuses an existing one or creates it.
3. Panel triggers the **bulk pass**: one `friendships/pending/` call (200 users
   max — see findings), then ids chunked through `friendships/show_many/` at
   100 per call with a ~400ms gap. In practice that is 1 GET plus 2 POSTs.
4. Panel renders all rows immediately from free data — following flag,
   approximate mutual count, private, verified, name, avatar — sorted
   following-first then mutuals-descending.
5. The **hydration queue** starts on the first 100 un-cached rows **in the
   currently displayed sort order**, so re-sorting or filtering before clicking
   "Load next 100" changes which 100 get enriched next. This is intentional: it
   lets the user aim enrichment at the subset they care about.

### Storage schema

`chrome.storage.local`:

- `profileCache: { [pk]: { username, followers, following, posts, bio,
  mutualCount, mutualNames[], isPrivate, isVerified, isDefaultPic, fetchedAt } }`
  — 30-day TTL, never re-fetched while fresh. ~1000 entries ≈ 500KB, well
  inside the 10MB quota.
- `hydrationProgress: { hydratedIds[], lastBatchEndedAt }`
- `settings: { pacing, sort, lastFilters }`

`chrome.storage.session`:

- `pendingSnapshot` — the bulk pass result, so reopening the panel within a
  browser session is instant.

### The two queues

Both are instances of the same generic throttled queue in `src/queue.js`:
sequential, jittered delay, live progress reporting, a Stop button, and a hard
halt on HTTP `429` or a `challenge_required` response body.

**Hydration queue** — `web_profile_info`, ~1 request per 2s ± jitter. Runs 100
items then stops and waits for an explicit "Load next 100" click. Results go
straight into `profileCache`.

**Action queue** — `approve` / `ignore` at ~1 per 1.5–3s ± jitter (the
"moderate" pacing the user chose). Rows grey out and drop from the list on
success; failures stay in place with an error chip and are not retried
automatically.

Closing the panel stops an in-flight action queue. This is intended: the
alternative is background writes to the user's account with no visible progress
and no stop control. Remaining items are not queued for later — the user
re-selects and re-runs.

## Panel UX

**Header** — total pending count, refresh button, hydration progress
(`312 / 1043 enriched`) and "Load next 100".

**Filter bar.** Relationship and search filters operate on free bulk data, so
they are exact across all 1000+ rows. Spam filters depend on hydration and are
visibly labelled as covering enriched rows only, so a count is never misleading.

- Relationship: `I already follow them` toggle; mutuals `0 / 1+ / 5+ / 10+`;
  `no profile pic` (free — see finding 4)
- Spam signals *(enriched only)*: followers `< N`, `0 posts`, `empty bio`,
  `following:follower ratio` flag
- Text search across username and full name, filtering as you type
- Sort: following-first-then-mutuals (default, matches existing behavior),
  newest request first, most followers

**Rows** carry avatar, username, full name, a Following badge, exact mutual
count with a couple of mutual names, follower and post counts, a bio snippet,
private/verified chips, per-row accept/reject buttons, and a checkbox. Clicking
the avatar navigates the main tab to that profile; the panel stays and
highlights the row.

With 1000+ rows, `src/render.js` renders a window of ~60 rows and extends on
scroll rather than mounting the full list.

**Bulk bar** appears when any checkbox is set: `Accept N` / `Reject N`, plus
"select all shown" in the header — so a filter narrows the list, one click
selects it all, and you uncheck exceptions before acting. Confirmation names
the exact count and the active filter before the queue starts.

### Derived flags

Thresholds live as named constants in `src/model.js`:

- **Bot ratio** — flagged when `following >= 1000` and
  `following / max(followers, 1) >= 10`.
- **Default profile pic** — best-effort, matched against Instagram's known
  default-avatar asset. When the check is inconclusive the flag is left unset
  rather than guessed, and the filter simply does not match that row.

## Error handling

| Condition | Behavior |
|---|---|
| Not logged in to Instagram | Panel shows a logged-out state with a link to log in |
| No Instagram tab | Service worker opens one |
| Content script not ready | Retry ping N times, then a retryable error in the panel |
| Unexpected API response shape | Row-level failure with an error chip; the list keeps working |
| `429` / `challenge_required` | Both queues halt immediately, visible banner explaining the action block |
| Single action failure | Row keeps its error chip; no automatic retry |

## Verification

- `node --test` over `src/model.js` — filters, sort, `social_context` parsing,
  bot-ratio flagging, row merging.
- Endpoint and response-shape verification against a real logged-in Instagram
  session before panel code is written, using **read-only** operations only
  (`pending`, `show_many`, `web_profile_info`). `approve` and `ignore` are never
  fired against the real account during development; the user exercises those
  manually.
- Manual checklist after load-unpacked: panel opens Instagram when absent, bulk
  pass completes on a 1000+ queue, hydration batches at 100, filter counts are
  correct, profile navigation preserves the panel, bulk confirm shows the right
  count, Stop interrupts mid-queue, halt-on-429 works.
- Installation is manual: `chrome://extensions` → Developer mode → Load
  unpacked. Not automatable from this environment.
