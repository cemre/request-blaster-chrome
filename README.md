# Request Blaster — Desktop Chrome

Triage Instagram follow requests from a side panel that survives navigation.

Instagram's own pending list dies the moment you click a requester's profile.
This keeps the list in a side panel, enriches every row with relationship and
spam signals, and lets you filter and act in bulk.

## Acting

Triage is bulk-only: rows carry a checkbox and nothing else, and the three
actions live in a floating toolbar over the list.

| Action | Writes |
| --- | --- |
| **Accept** | `approve` |
| **Accept + follow** | `approve`, then `follow` — skipped when you already follow them |
| **Reject** | `ignore` |

Clicking anywhere in a row toggles its checkbox; the avatar, username and full
name open that profile in the main tab instead.

Accept + follow is two writes per person against a rate limit that punishes
writes, so it runs at roughly half the throughput of a plain accept — the
follow is spaced by half the between-person gap. If Instagram blocks on the
follow, the row still counts as accepted, because the approve already landed
and cannot be taken back.

Following a private account you have only just accepted lands as a *request*,
not a follow. The row says so.

## The log

Instagram keeps no record of what you did with a follow request — a rejection
just disappears. The **Log** tab is a local, append-only record of every accept
and reject, from the panel and the on-page banner alike, so you can go back and
find someone you rejected by mistake.

One line per action: timestamp, username, what you did. Grouped by day, newest
first, with All / Accepted / Rejected filters and a username search.

To read it outside the UI, open the side panel's devtools console:

```js
chrome.storage.local.get(null).then(all =>
  console.table(Object.entries(all)
    .filter(([k]) => k.startsWith('log:'))
    .flatMap(([, v]) => v)
    .sort((a, b) => b.at - a.at)
    .map(r => ({ when: new Date(r.at).toLocaleString(), user: r.username, action: r.action }))))
```

Under **Accepted**, anyone you have not followed back gets a checkbox, and the
toolbar offers **Follow back** — paced like any other write. Whether you already
follow someone is derived from the log rather than tracked as its own state:
an `acceptFollow` or a later `follow` line settles it. Nothing has to be kept in
sync, because there is only ever the one list of things that happened.

Only actions that actually succeeded are recorded. A rejection that failed did
not happen, and logging it would make the log answer "what did I try" when the
question is "what did I do".

### Storage layout

The log lives in `chrome.storage.local`, sharded by UTC day:

- `log:YYYY-MM-DD` — that day's records
- `logIndex` — which day shards exist

**Opening the panel reads none of it.** Triage never touches the log; the shards
load only when you open the Log tab, `LOG_PAGE_DAYS` at a time. Retention is 730
days and runs on first open, which is just deleting whole keys.

This is the one thing the extension stores about other people indefinitely:
usernames of accounts that requested to follow you. It is local, never synced,
and **Clear log** erases it.

## Details

Follower and post counts, bios and exact mutual counts each cost one request
per person, so they are not fetched up front. **Load N** in the header enriches
the next batch of rows currently in view, at ~1 request per 2s with live
progress and a Stop button. Everything else — username, name, avatar, private,
verified, whether you already follow them, whether they have a default profile
picture, and an approximate mutual count — comes free with the pending list.

Mutual counts parsed from Instagram's "Followed by …" string are marked with a
tilde (`~32 mutuals`); once loaded, the exact count replaces it.

Standalone — this is **not** a port of the `Safari Extension/` build. No focus
mode, no on-page banner, no timer.

## Install

1. `chrome://extensions` → enable **Developer mode**
2. **Load unpacked** → select this folder
3. Click the toolbar icon. The panel opens Instagram if it isn't already open.

Chrome 114+ (side panel API).

Instagram tabs that were already open when you loaded or reloaded the extension
do **not** get the content script from the manifest — Chrome only injects on
navigation. The extension injects into them explicitly on install and again on
demand when the panel can't reach a tab, so you shouldn't need to reload
anything by hand.

## On-page banner

Profile pages of pending requesters get Accept / Accept + follow / Reject
buttons injected directly beneath Instagram's own Follow button, plus a
`Pending request · N of 200` line. Deliberately minimal — it acts on the profile
in front of you and nothing else; sequencing stays in the side panel.

The three buttons sit on one row wherever Instagram's own button row is at
least ~320px, which it is on desktop, and wrap to a second row rather than
overflowing when it is narrower.

It works with the panel closed: `banner.js` reads the same cached pending list
and fetches one itself if there isn't one. Acting in either view updates the
other, via a `handledIds` list in session storage that both watch — no direct
messaging between them. It writes to the same action log, so accepting from a
profile page shows up in the Log tab alongside everything else.

Styling comes from Instagram's own CSS custom properties (`--ig-primary-button`
and friends, published on `:root` as `R, G, B` triples). Custom properties
inherit through shadow boundaries, so the buttons match Instagram's light and
dark themes with no theme detection. Verified pixel-identical to the real
Follow button: `rgb(74, 93, 249)`, 44px tall, 12px radius, 14px/600.

The insertion point is found via semantic markup — the direct child of
`<header>` containing a button labelled Follow/Following/Message — never
Instagram's generated class names. If that ever stops matching, the banner
falls back to a floating bar rather than disappearing.

Width is measured, not assumed. That section is not always as wide as the
buttons inside it — Instagram's narrow layout insets them — so the banner
measures the bounding box of the real buttons and sets its own margins to
match, realigning on resize and on every tick. No breakpoints to keep in sync
with Instagram's.

## How it works

- **`content.js`** — stateless proxy. Scrapes the CSRF token from
  `document.cookie` and the app id from the page's inline scripts, then makes
  same-origin authenticated calls. Holds no state; every navigation destroys it.
- **`src/api.js`** — resolves the Instagram tab, pings for content-script
  readiness, retries once across a navigation.
- **`sidepanel.html` + `src/panel.js`** — all UI and both throttle queues. The
  panel is a real document, so nothing depends on the service worker staying
  alive. `background.js` is a single `setPanelBehavior` call.
- **`src/model.js`** — pure transforms (merge, filter, sort, parse). No
  `chrome.*`, no DOM, fully unit-tested.
- **`src/history.js`** — the action log's shape and every transform over it,
  same rules as `model.js`. `src/store.js` holds the thin `chrome.storage`
  shell around it.

## Rate limiting

Instagram action-blocks accounts for rapid friendship writes and there is no
published limit, so both queues are sequential and jittered, show live
progress, have a Stop button, and **halt entirely** on the first `429` or
`challenge_required` rather than retrying into a block.

- Profile enrichment: ~1 request per 2s, 100 at a time on demand.
- Accept/reject: pace selector in the panel (conservative / moderate / fast),
  defaulting to moderate at ~1 action per 1.5–3s.
- Accept + follow: the same per-person pace, plus a half-gap between the
  approve and the follow.

Every bulk action asks for confirmation naming the exact count; rejection is
additionally flagged as not undoable.

## The 200 cap

`friendships/pending/` returns at most **200** requests and offers no working
cursor — `next_max_id` is always `null` and every pagination variant returns the
same page. If you have more than 200 pending, clear these and hit **Refresh** to
pull the next batch. The panel says so when it detects a full page.

## Tests

```bash
npm test
```

Covers `src/model.js` and `src/history.js` — the rest is browser-integration
surface. Zero dependencies; `package.json` exists purely so Node loads the
modules as ESM and is not used by the extension at runtime.

## Instagram API notes

Everything goes through `www.instagram.com/api/v1`. Verified 2026-07-28:

- `i.instagram.com` answers `friendships/show_many/` and `friendships/show/`
  with **HTTP 200** and `{"status":"fail"}`. `www` works correctly. The content
  script therefore treats a `status: "fail"` body as an error regardless of
  HTTP status.
- `has_anonymous_profile_picture` ships free on the pending list, so the
  "no profile pic" filter needs no enrichment.
- `pk` arrives as a string.
- `web/friendships/{id}/follow/` answers `{ result: "following" | "requested" }`.
  Accepting a request does not make that account public to you, so following a
  private requester back comes back as `requested`.
- Profile pictures **cannot** be loaded into an `<img>` from the extension
  origin: `scontent-*.cdninstagram.com` sets Cross-Origin-Resource-Policy and
  the load dies with `ERR_BLOCKED_BY_RESPONSE.NotSameOrigin`. The same fetch
  from an instagram.com page succeeds, so `src/avatars.js` routes them through
  the content script's `avatar` op as data URLs — about 6KB each, ~1.1MB for a
  full 200-row queue, memory-cached, six concurrent. That op is restricted to
  `cdninstagram.com` / `fbcdn.net` over HTTPS so it can't be used as a general
  fetch relay.

Full design and findings: [`docs/superpowers/specs/2026-07-28-instagram-request-triage-sidepanel-design.md`](../docs/superpowers/specs/2026-07-28-instagram-request-triage-sidepanel-design.md)
