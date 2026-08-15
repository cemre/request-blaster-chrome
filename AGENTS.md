# Request Blaster — Chrome side panel

Triage Instagram follow requests from a Chrome side panel that survives navigation:
a filterable queue of pending requests with bulk accept/reject, an action log, an
on-page accept/reject banner, a follow-back harvest, and a screenshot mode.

`README.md` is the reference for install, storage layout, rate limiting, the 200-request
cap, and the Instagram API findings. **Don't duplicate it here** — this file is the map
and the design rules.

```
.
├── manifest.json          MV3, sidePanel API, Chrome 114+, Instagram-only
├── build.js               store package — ships without the harvest, see below
├── background.js          one line: setPanelBehavior
├── content.js             stateless Instagram API proxy (the OPERATIONS table)
├── harvest-content.js     harvest-only ops, registered into that table
├── banner.js              in-page accept/reject under Instagram's Follow button;
│                          independent of the panel, works whether or not it's open
├── anon-content.js        screenshot mode on the Instagram tab: renames accounts,
│                          blurs avatars, restores on toggle-off
├── sidepanel.html/.css    panel UI
├── src/                   panel logic — see below
├── scripts/               merge-to-main.sh — see below
└── test/                  node --test, zero deps
```

From the repo root:

```
npm test
```

The store build drops the follow-back harvest, because the harvest is the only thing needing
the `downloads` permission and a permission increase disables the extension for every existing
user until they re-consent:

```
npm run build
```

## Merging a worktree back

**Use `scripts/merge-to-main.sh`. Don't hand-roll the sequence.** From the worktree:

```
scripts/merge-to-main.sh check                 # then read it, decide
scripts/merge-to-main.sh merge -m "Subject" \  # commit, merge --no-ff, re-test,
                         -b "Body"             # build, push
scripts/merge-to-main.sh cleanup               # after you've tested it by hand
```

`.claude/skills/merge/` wraps this as a skill — `/merge`, or just "merge this back" / "ship
it" — so the script gets used without anyone having read this file first. `-m` is the
one-line subject and also names the merge commit; `-b` is the body paragraph, whose last
line is the `Co-Authored-By` trailer.

Three merges were measured before this existed: 64s, 117s and 356s, of which **87–90% was
model round trips** — eight to nineteen separate `git` calls, each one a ~12s turn. The git
work itself totalled about 1.4 seconds. Nothing about this repo is slow; asking about it one
question at a time is. So each mode above answers everything at once and prints a report you
can act on without a follow-up call. `check` alone covers status, the diff, whether main has
moved, a conflict prediction (`merge-tree`, which resolves in memory and touches no worktree),
the build allowlist, tests, and the main worktree's own state.

Two repo-specific traps it handles, both of which have cost a merge before:

- **`build.js` ships an explicit allowlist**, so a new top-level file in the extension is
  invisible to the store build until it's added there. `check` diffs new files against it.
- **`npm run build` calls `commitVersion()`**, which writes the bumped version back into
  `manifest.json` on purpose. A merge-time verification build isn't a release, so `merge`
  reverts that bump — otherwise every merge silently burns a version number.

`merge` pushes last, once main is green and builds — everything before that step is local and
revertible, so the one action that leaves the machine happens only after the verification it
depends on. A rejected push means origin moved; integrate it, never force.

`merge` still leaves the worktree in place, because the habit here is to test by hand before
closing it. `cleanup` refuses on an unmerged branch or an uncommitted change, and `-d` (never
`-D`) does the branch delete, so a branch that never landed can't be thrown away by a typo.

## Where to look

**Anchors here are symbol names, not line numbers** — grep finds them in one call and they
survive edits. Line numbers were tried and went stale within ten commits; don't add them back.

| File | Owns |
|---|---|
| `src/panel.js` (1650) | All panel wiring: state, filter/log recompute, the queues, DOM binding. The hot file — use the table below before opening it. |
| `src/render.js` | `ListRenderer` (windowed rows, `setClaims`, `setMask`), `RunStack` (the toolbar's bars) and `renderLog()`. Nothing else touches row markup. |
| `src/jobs.js` | `JobList` — the write pipeline: enqueue, the pump, `claims()`, pause/resume/drop. No DOM, no API client, so it is tested directly. |
| `src/model.js` | Pure functions over rows: `mergeRows`, `applyFilters`, `sortRows`/`SORTS`, `DEFAULT_FILTERS`, spam predicates, `format*`. No DOM, no storage. |
| `src/history.js` | The log's vocabulary: `buildRecord`, day sharding (`dayKey`, `expiredDayKeys`), `FILTERS`, `selectAllPlan`. |
| `src/store.js` | Every `chrome.storage` read/write — profile cache, settings, snapshot, handled ids, log shards. The function you want already exists here. |
| `src/api.js` | Talking to the content script: `ensureTab`, `call(op, args)`, `fetchAllPending`, `fetchFollowStatuses`, `SERVER_PAGE_CAP`. |
| `src/alias.js` | Screenshot-mode personas. Pure — no `chrome.*`, no DOM, loaded by the panel, the tab and `node --test` alike. `personaFor`, `handleFromPath`, `createMask`, `IDENTITY_MASK`. |
| `src/anon.js` | Screenshot-mode state: `load`, `isOn`, `mask`, `setOn`, `toggle`. |
| `src/queue.js` | `ThrottledQueue` + `PACING`. |
| `src/avatars.js` | Avatar fetch concurrency limiter. |
| `src/harvest/` | Follow-back harvest, self-contained: `harvest.js` (the run), `model.js` (selection + sheet planning), `mount.js` (its UI), `sheet.js` (canvas), `batch.js` (downloads), `store.js`, `api.js`. **Part of it is parked** — see below. |

**Parked, not dead.** A harvest runs on ticked log rows only. `harvest.js`
`collectCandidates` is unreachable — it backed the removed "All followers" toggle — but kept,
and its own header comment is the authority on why: the replacement is paged batches of ~50
rather than an exhaustive sweep, so it stays as the statement of what the two candidate sources
are and how they union, **not as code to switch back on unchanged**. Its parts
(`selectNotFollowedBack`, `unionCandidates`, `acceptedNotFollowed`) are all still live and
tested. Don't read it as live code; don't delete it as dead.

| Changing... | Go to |
|---|---|
| A filter chip | `panel.js` `readFilters`, `resetFilters` · predicates in `model.js` `applyFilters` · `#f-*` in the HTML · CSS §filters |
| The spam popover | `panel.js` `updateSpamChip`, `clampPopover` · CSS §spam signals popover |
| The hydration slot | `panel.js` `syncHydration` + §hydration · `#hydration-*` · CSS §header |
| The progress meter | `panel.js` `syncRunStack`, `runBars` · `render.js` `RunStack` · `--run-pct` in CSS §progress meter · `.run-label` |
| Queued operations | `jobs.js` `JobList` · `panel.js` `enqueueBulk`, `runJob`, `reportOutcome` · `test/jobs.test.js` |
| Which rows are inert | `panel.js` `syncClaims`, `claimLabel`, `selectableRows` · `render.js` `ListRenderer.setClaims` · `.is-claimed` |
| Select-all / bulk bar | `panel.js` `syncSelectAll`, `updateBulkBar`, `syncToolbar` · log's copy is `history.js` `selectAllPlan` |
| The action log | `panel.js` `setMode`, `recomputeLog`, `onLogShardChanged` · `history.js` · `render.js` `renderLog` · CSS §action log |
| Row markup / the list | `render.js` `ListRenderer` only · CSS §list |
| Sort | `model.js` `SORTS`/`sortRows` · `#sort` · `.select-chip` in CSS §filters |
| Search | `panel.js` `setSearchOpen` · `#search`, `#log-search` |
| Accept / reject / follow | `panel.js` `logAction`, `markDone`, `confirmAction` |
| An error message | `panel.js` `describeError` (the sentence), `errorDetail` (the (i)) · classification in `content.js` `classify` · `test/content.test.js` |
| An Instagram endpoint | `content.js` `OPERATIONS` · `show_many` alone is shape-agnostic — read the design rule before touching `SHOW_MANY_SHAPES` or `wrongShape` |
| Screenshot mode | `panel.js` §screenshot mode + `applyAnonMode` · `anon.js` · `alias.js` · `anon-content.js` · `body.is-anon` in CSS |
| The harvest | `harvest/mount.js` `bindControls` for UI · `harvest/harvest.js` `runHarvest` for the run |
| Colours / tokens | token table at the top of `sidepanel.css` |
| Narrow-width behaviour | CSS §narrow and `.label-wide` |

## Design rules

Each of these was arrived at by trying the other thing. Check the ones your change touches.

**Colour.** The token table at the top of `sidepanel.css` is built from Instagram's palette,
not from WCAG ratios — `--text-tertiary` is ~2.4:1 on white deliberately. Don't "fix" it
without asking. The panel is two surfaces: pinned controls sit on `--bg-chrome`, the list on
`--bg`, chips lift with `--bg-elevated`. `--bg-chrome` equals `--secondary-bg` in light mode,
so anything reading as *on* or *hovered* while on the band needs `--secondary-bg-hover` or
`--bg-elevated` — `--secondary-bg` there is invisible. This catches plain `.btn`s too, not
just states: `.btn`'s resting background *is* `--secondary-bg`, so moving one onto a control
band makes it vanish in light mode. `#harvest-start` is the worked example — it overrides to
`--bg-elevated` plus a border because it sits on the result bar rather than on the list.

**Layout.** Tab bar, filter bar, result bar, list, cap notice. Hydration reports from the tab
bar, which is pinned by construction, so it costs no pixels and can't scroll away mid-batch.
Search is hidden by default and clears its query on close — a hidden field must never leave
the list silently filtered. `setStatus()` is for transient messages only and stays empty
during a run, since a meter is already reporting.

**The Log tab's result bar is select-all and Harvest.** The row count and the button want the
same slot and the bar won't hold both at 260px, so `mountHarvest` hides `#log-count` when it
takes it: the log is a record rather than a worklist, and its length is worth less than the one
action that acts on it. The count stays in the markup and is hidden rather than removed, so the
store build — which strips `src/harvest/` entirely — keeps a count there instead of a bar with
one control, and `renderLog`'s write to it needs no guard in either build. The
harvest's own line (`#harvest-note`, injected by `harvest/mount.js`) heads the log list inside
the scroller and is **hidden unless it has something the toolbar isn't already saying** — the
outcome once the bar has gone, why a click did nothing, or mid-run the account being worked,
which no bar has room for beside the count. It never repeats the count or the word "queued":
both have a line in the run stack already, and this one scrolls away.

**Hydration.** `syncHydration()` owns both states in one box: idle is `N / M details` + `Load
N`, running is the meter, spinner, `Enriching D / T` and Stop. Never add a second hydration
counter — split across two places they showed the same number twice. `Load` is hidden rather
than disabled when there's nothing left to fetch, because a greyed control in that slot is
just a second counter. In Log mode only `#hydration-idle` hides: a batch in flight must
survive a tab switch or its only Stop goes with it.

**Operations queue; they don't block.** Every accept, reject, follow-back **and harvest**
becomes a job in `jobs.js` and joins one list that runs them **one at a time**. Serialisation
is the safety property, not a simplification: `PACING.moderate` sits under a limit Instagram
doesn't publish, and two queues at once would double the rate it was picked for — so however
many jobs are stacked up, Instagram sees the rate it saw when the panel could only hold one.
The harvest is in that list for exactly this reason and not because it writes: it doesn't, but
it is thousands of requests, and the limit is about how fast this extension talks to Instagram
at all. **Don't let it run alongside the pipeline again.**
**Don't make jobs concurrent.** A job holds `remaining` as a Set of what's left rather than a
cursor, because three things read it: the claim map, the counter (`done = total -
remaining.size`), and a resumed run. An item is `handled()` once attempted, plain failures
included — a block is the one outcome that leaves the id in, so a resumed job still holds the
request Instagram refused. Leaving the list *is* the release, since `claims()` walks it, so
don't clear `remaining` on the way out: that once made a run stopped at 2 of 4 report
"Stopped after 4 of 4".

**A halt pauses the pipeline; it doesn't empty it.** A rate limit or logged-out response holds
everything behind it and nothing writes again until Resume. The banner carries the reason and
is the only place Resume lives, which is why `#banner-dismiss` hides while it's up — a
dismissible pause strands queued work with nothing offering to restart it. Cancelling the
halted job is the other way out and lifts the pause with it.

**Rows are claimed, not frozen.** `syncClaims()` derives `Map<id, label>` per list, and only
those rows dim, lose pointer events and get a genuinely `disabled` checkbox — `pointer-events`
stops the mouse but Tab still reaches them. **Everything else stays live**, which is the
point: a second selection can be built and queued while the first runs. This replaced
`body.is-acting`, which answered a question about the rows a queue held by taking away all of
them. Select-all reads the same map or it never flips to Deselect once a job holds a shown
row. A claim label is **null for the in-flight row**, which already carries `Accepting…` from
`markRow`; `dataset.chip` tells the two apart so a cancel clears a claim chip and leaves a
live one standing. Profile links stay clickable on purpose: checking who you're about to
reject is worth doing mid-run. The log claims on the same terms and `renderLog()` takes the
map, since a follow-back's writes repaint that list mid-run and rebuilt checkboxes would come
back enabled. Hydration claims nothing. The harvest claims like anything else, because it is a
job — a **guest** job, queued through `guestRun.enqueue({ ids, spec, run, onDrop })`, which is
how a feature outside `panel.js` takes a turn without the pipeline learning what the feature
is. A guest carries its own `spec` (`{ label, gerund }`, having no ACTIONS entry) and its own
`run`; `jobSpec()` picks whichever applies. `onDrop` exists because a job cancelled while still
queued never runs, so a guest that disabled a button on the way in would otherwise never hear
that its turn isn't coming.

**The progress meter.** `--run-pct` has two hosts that render it differently on purpose. A
running bar in the toolbar's `#run-stack` fills — `.run-fill` reads it as a width and the
duplicated `.run-line-knockout` reads it as a `clip-path` inset, which is why the label is
rendered twice (second copy `aria-hidden`) and written in one statement: text and fill resolve
against the same box and can't drift. Don't swap that for `mix-blend-mode`; it doesn't survive
both colour schemes. The header slot instead grows a 3px rule along its bottom edge, level
with the active tab's underline — a painted block that size reads as an alert. Don't give it a
fill back, and keep it scoped to the slot. A **queued** bar is one line and a Cancel: no fill,
no spinner, since 0% is all either could say before its turn, and at 260px three empty meters
is most of the panel. A **paused** bar freezes its fill and drops the spinner. `RunStack`
**reconciles by job id rather than rebuilding** — a rebuild per tick restarts every spinner
and kills the width transition, which between ticks is the whole difference between looking
alive and looking hung. Nothing resets `--run-pct` any more: a bar leaves with its job. Past
~3 bars the stack scrolls internally, so `syncToolbar()` measures the toolbar into
`--toolbar-h` and the scroller's padding is computed from it rather than hardcoded.

**Each Stop stops the queue its own label counts.** Hydration's is unambiguous because nothing
reports beside it; the stack's live on the bars, one each, so there's no shared Stop left to
guess and no precedence rule to get wrong. Stop on a running bar and Cancel on a queued one
are the same operation (`jobs.drop`); rows are released either way and deliberately **not**
put back into the selection, since a cancel is often the prelude to building a different one.

**Result bar controls are actions, not state.** Select-all is a button whose label is derived
from the selection (`syncSelectAll()`), not a checkbox. The log's copy runs through
`selectAllPlan()`, where "all" isn't "everything shown" — rows carrying a `skipNotes` note are
excluded, so log select-all *adds* rather than replaces (hand-ticking a noted row is the only
way to redo it). The Sort chip names the control and not its value: the native `<select>` is
kept but laid over the chip at `opacity: 0`, so the popup stays native. Hiding the value is
intentional — don't add an indicator.

**260px.** The panel is dragged narrow, beside Instagram rather than in a window. Both control
bars must stay one line each down to 260px; if a change wraps one, take the width back rather
than accept the row. Nothing may clip — bars wrap as a fallback, chip labels are `nowrap` so
they wrap whole, long text ellipsises. What buys the width: `.label-wide` drops the control's
name below 380px, so each `<select>` needs its own `aria-label` (the hidden span was its
accessible name); `<select>` option labels stay short, since a select reserves its longest
option's width whether or not it's chosen (hence Mutuals `none`, not `none (loaded rows)`);
and row bios aren't rendered, which was a line on every row. The bio is still fetched and
cached — the `Empty bio` filter reads it.

**Screenshot mode is keyed on the username, and that is the whole design.** `Cmd+Alt+S`
renames every account in the panel *and* on the Instagram tab beside it and blurs the avatars,
so a store screenshot shows the real product without real people. `alias.js` maps a handle to
a persona as a **pure function** of it, because the two sides share no state: the panel knows
user ids and handles, the tab only ever learns handles, off `href="/handle/"`. Keyed on
anything else the two halves would name the same person differently inside one screenshot.
The pool collides at ~3% across twenty visible rows — a fact to know, not a bug to fix.
Renderers take a `mask` defaulting to `IDENTITY_MASK`, so `render.js` has no branch and no
idea the mode exists. **Display only**: every write is keyed on a user id, which this never
renames, and the flag lives in `chrome.storage.session`, surviving navigation and panel
reopen but not a restart. There is deliberately **no badge** — a pill reading "ANON" would be
in every screenshot, the one place it must not be.

- **`anon-content.js`'s WeakMap is load-bearing.** Instagram re-renders constantly, so nodes
  are swept many times — and a node already holding `jordan.reeves` no longer equals the
  handle its link points at, so the next pass takes it for a display name and overwrites it
  with "Jordan Reeves". The map is what stops handles decaying into full names one repaint
  later. It holds `original` from the *first* write only, so restoring survives Instagram
  changing the text underneath, and `disable()` drops each node as it restores — a node left
  in the map would be read as already-recorded by the next enable and never restored again.
- **The tab imports `alias.js`, it does not copy it.** A classic content script can't
  `import`, so it dynamic-imports the module as a `web_accessible_resource`. A second copy of
  the pools would be a second copy of the mapping, and the mapping is the entire feature. If
  that import fails it logs loudly rather than going quiet — names not changing is exactly
  what this feature looks like switched off.
- **A failed push to the tab raises a banner.** The panel's half applies before the tab is
  reached, so a silent failure means a screenshot that looks masked while Instagram beside it
  still shows real names and faces.
- Display names outside a link are renamed only once known — seeded from the `full_name`s the
  pending list carries, or learned from seeing that person linked. A bare name for an account
  you've never had a request from stays real; covering it would mean guessing which arbitrary
  text is a person's name.

**An error banner says what to do; the (i) says what happened.** One short sentence, an
action, and stop — it is read at a glance at 260px by someone who wants to get back to
triaging. Everything it leaves out is one click away in `errorDetail`, which is what makes
the prose safe to keep short. Don't grow the sentence; grow the detail. And **don't word a
message from `code` alone** — the codes are too coarse, which is the bug this replaced: any
`401` and any HTML body raised `logged_out`, so a signed-in account was told to sign in.
`content.js` settles that at the point of failure with the cookie in front of it, and
`reason` is what it settled. The detail view is a `<dialog>` behind `window.alert` because
Chrome makes no promise about JavaScript dialogs in a side panel and a suppressed alert
shows nothing at all.

**`show_many`'s request shape is discovered, not pinned.** Instagram routes either
`GET ?user_ids=` or `POST` with the same string as a form body, and which one has flipped
three times in three weeks (POST → GET 07-30 → POST 08-08 → GET 08-15), each flip breaking
follow status for every user until a release went out. Three releases spent editing one line
back and forth is what `SHOW_MANY_SHAPES` replaces: `showMany` asks in the first shape, falls
back to the second, and remembers the winner on the bridge, so a flip costs one request per
page instead of a broken panel. **Don't "fix" this back to whichever shape works today** —
the endpoint's shape is a property of the server that answered, not a fact to look up.

The fallback is only safe because `wrongShape()` is narrow: HTTP 405 and `html_response`,
the two ways a refusal to route has ever presented. Everything else — a throttle, a
challenge, a dead session — is an *answer* and returns as-is. Widening it to "any failure"
would retry a rate limit in a second shape, doubling the request rate at the exact moment
Instagram is saying it's already too high, which is the one thing the serialised pipeline
above exists to prevent. And `html_response` only reaches it because `htmlResponse()` has
already separated a served web page from a real sign-out on the cookie — so the two
mechanisms are coupled: don't collapse that branch back into one.

**Misc.** The follow filter's checkbox is visually hidden (clipped, still focusable) and the
pill carries the state, filled `--primary` when on; its focus ring is `--text`, since a
`--primary` ring around a `--primary` fill reads as a glow. Write pacing is fixed at
`PACING.moderate` and the Pace picker was removed — Instagram action-blocks accounts that
write too fast and publishes no limit, so don't lower it. `content.js` and `banner.js` patch
`history.pushState`/`replaceState`, listen for `popstate`, and poll as a fallback to catch
Instagram's SPA navigation.
