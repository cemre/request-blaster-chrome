# Request Blaster

Triage Instagram follow requests from a Chrome side panel.

Instagram's own pending list dies the moment you click a requester's profile.
This keeps the list in a side panel that survives navigation, shows you who
each person actually is, and lets you act on a hundred of them at once.

## What it does

**Bulk triage.** Check off rows and use the toolbar: **Accept**, **Accept +
follow**, or **Reject**. Click a row to select it, shift-click to take a range,
click the name or avatar to open that profile in the main tab.

**Signals on every row.** Username, name, avatar, private, verified, whether
you already follow them, whether they still have the default profile picture,
and roughly how many mutuals you share — all free with the pending list. **Load
details** fills in exact mutual counts, follower and post counts, and bios for
the rows in view.

**Filters.** Narrow by mutual count — presets, your own threshold, or "mutual
with these specific people" — by whether you already follow them, and by the
spam tells: no profile picture, barely any followers, no posts, empty bio, a
lopsided following-to-followers ratio. Plus a name search and a sort.

**Auto.** One rule, run once: accept everyone with at least N mutuals, reject
the rest, with a list of handles that always get accepted regardless.

**A log of what you did.** Instagram keeps no record of a rejection — it just
disappears. The **Log** tab is a local record of every accept and reject, kept
for two years, grouped by day and searchable, so you can find someone you
rejected by mistake. Under **Accepted**, anyone who hasn't been followed back gets a
**Follow back** button.

**Buttons on the profile page.** Open a pending requester's profile and Accept
/ Accept + follow / Reject appear under Instagram's own Follow button, styled
to match. Works with the panel closed, and shows up in the same log.

**Paced to stay under the limit.** Instagram blocks accounts that accept or
follow too fast. Everything runs one at a time with a gap between actions
(there's a conservative / moderate / fast selector), shows live progress, has a
Stop button, and halts entirely the moment Instagram pushes back. Every bulk
action confirms first and names the exact count.

## Install

1. `chrome://extensions` → enable **Developer mode**
2. **Load unpacked** → select this folder
3. Click the toolbar icon. The panel opens Instagram if it isn't already open.

Chrome 114+.

## Notes

- Instagram returns at most **200** pending requests at a time. Clear those and
  hit **Refresh** for the next batch.
- Everything stays on your machine. Nothing is synced or sent anywhere. **Clear
  log** erases the one thing kept long-term: the usernames of people who
  requested to follow you.

## Development

`npm test` runs the unit tests. Design notes and API findings live in
[`docs/superpowers/specs/`](docs/superpowers/specs/).
