# Request Blaster — Desktop Chrome

Triage Instagram follow requests from a side panel that survives navigation.

Instagram's own pending list dies the moment you click a requester's profile.
This keeps the list in a side panel, enriches every row with relationship and
spam signals, and lets you filter and act in bulk.

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

Profile pages of pending requesters get Accept/Reject buttons injected directly
beneath Instagram's own Follow button, plus a `Pending request · N of 200`
line. Deliberately minimal — it acts on the profile in front of you and nothing
else; sequencing stays in the side panel.

It works with the panel closed: `banner.js` reads the same cached pending list
and fetches one itself if there isn't one. Acting in either view updates the
other, via a `handledIds` list in session storage that both watch — no direct
messaging between them.

Styling comes from Instagram's own CSS custom properties (`--ig-primary-button`
and friends, published on `:root` as `R, G, B` triples). Custom properties
inherit through shadow boundaries, so the buttons match Instagram's light and
dark themes with no theme detection. Verified pixel-identical to the real
Follow button: `rgb(74, 93, 249)`, 44px tall, 12px radius, 14px/600.

The insertion point is found via semantic markup — the direct child of
`<header>` containing a button labelled Follow/Following/Message — never
Instagram's generated class names. If that ever stops matching, the banner
falls back to a floating bar rather than disappearing.

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

## Rate limiting

Instagram action-blocks accounts for rapid friendship writes and there is no
published limit, so both queues are sequential and jittered, show live
progress, have a Stop button, and **halt entirely** on the first `429` or
`challenge_required` rather than retrying into a block.

- Profile enrichment: ~1 request per 2s, 100 at a time on demand.
- Accept/reject: pace selector in the panel (conservative / moderate / fast),
  defaulting to moderate at ~1 action per 1.5–3s.

Bulk rejection asks for confirmation naming the exact count and active filter.
Rejections are not undoable.

## The 200 cap

`friendships/pending/` returns at most **200** requests and offers no working
cursor — `next_max_id` is always `null` and every pagination variant returns the
same page. If you have more than 200 pending, clear these and hit **Refresh** to
pull the next batch. The panel says so when it detects a full page.

## Tests

```bash
npm test
```

Covers `src/model.js` only — the rest is browser-integration surface. Zero
dependencies; `package.json` exists purely so Node loads the module as ESM and
is not used by the extension at runtime.

## Instagram API notes

Everything goes through `www.instagram.com/api/v1`. Verified 2026-07-28:

- `i.instagram.com` answers `friendships/show_many/` and `friendships/show/`
  with **HTTP 200** and `{"status":"fail"}`. `www` works correctly. The content
  script therefore treats a `status: "fail"` body as an error regardless of
  HTTP status.
- `has_anonymous_profile_picture` ships free on the pending list, so the
  "no profile pic" filter needs no enrichment.
- `pk` arrives as a string.

Full design and findings: [`docs/superpowers/specs/2026-07-28-instagram-request-triage-sidepanel-design.md`](../docs/superpowers/specs/2026-07-28-instagram-request-triage-sidepanel-design.md)
