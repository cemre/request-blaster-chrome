# Auto: always-accept by mutual handle list

## Problem

Auto (`src/panel.js` `runAutoTriage`) accepts or rejects each pending follow
request purely by comparing its mutual-follower count to a single threshold
(`splitByMutuals` in `src/model.js`). There's no way to say "always accept
this person if they're connected to someone specific I care about, even if
their mutual count is below my usual bar."

## Goal

Let the user supply a comma-separated list of Instagram handles in the Auto
popover. During an Auto run, any pending row whose mutual-follower names
include one of those handles is accepted, even if its mutual count is below
the threshold. The list is saved so it persists across panel sessions.

## Non-goals

- Does not change the manual filter chips, the regular list view, or any
  action outside of an Auto run.
- Does not add an extra network call to widen the mutual-name match. It
  matches against whatever mutual names are already fetched as part of
  Auto's existing per-row enrichment step.
- Does not surface *why* a given row was accepted (threshold vs. priority
  match) in the UI or log — it's still just "accepted."

## UI

In the `#auto-panel` popover (`sidepanel.html`), below the existing
"Accept ≥ [N] mutuals, reject the rest" row, add:

- A text input, labeled "Also accept if mutual with:", placeholder
  "comma-separated handles".
- A small muted hint line beneath it: "Matches only the ~3 mutual names
  Instagram shows per row, not your full mutual list." Purely informational.

The input is populated from saved settings when the panel loads, and its
value is persisted on change (blur) and again when Run is clicked (belt and
suspenders — Run should never fire with an unsaved edit).

## Storage

Add `autoPriorityHandlesText: ''` to `DEFAULT_SETTINGS` in `src/store.js`,
alongside the existing `sort` key. Stored as the raw text the user typed
(not pre-parsed), so reopening the popover shows exactly what they entered,
including spacing/casing they may still be editing. Persisted via the
existing `loadSettings`/`saveSettings` (`chrome.storage.local`).

## Matching logic

`src/model.js`:

- New helper `parsePriorityHandles(text)`: splits on commas, trims, runs
  each piece through `normalizeHandle` (imported from `alias.js`, already
  used elsewhere for handle comparison — strips leading `@`, trailing `/`,
  lowercases), drops empties, and returns a deduped list.
- `splitByMutuals(rows, minMutuals, priorityHandles = new Set())` gains a
  third parameter: a `Set` of normalized handles. For each row with a known
  (numeric) mutual count below `minMutuals`, check whether any name in
  `row.mutualNames` (normalized) is in `priorityHandles`; if so, the row
  goes to `accept` instead of `reject`. Rows already at/above the threshold,
  and rows with an unknown mutual count, are unaffected.

`row.mutualNames` only ever has entries once a row is enriched (see
`mergeRows` in `src/model.js`), and Auto always enriches a row before
splitting it (`runAutoTriage`'s hydration step runs first each pass), so by
the time `splitByMutuals` runs during an Auto run, matching has real data to
work with wherever it's going to.

## Wiring

- `src/panel.js`: `startAutoTriage(minMutuals)` becomes
  `startAutoTriage(minMutuals, priorityHandles)`, threaded through to
  `runAutoTriage`, threaded through to the `splitByMutuals(live(), minMutuals, priorityHandles)`
  call.
- The `auto-run` click handler reads and normalizes the new input's text via
  `parsePriorityHandles`, persists the raw text to settings, and passes the
  resulting `Set` into `startAutoTriage`.
- On panel init, the new input's value is set from
  `state.settings.autoPriorityHandlesText`.

## Known limitation

Instagram's per-row profile fetch (`edge_mutual_followed_by`) surfaces at
most ~3 mutual names even when the true mutual count is much higher
(observed: 53 actual mutuals, 3 names returned). A real overlap with the
priority list that isn't among those ~3 names won't be caught. Fetching the
full mutual list would need one extra API call per pending row, slowing
every Auto run and adding rate-limit exposure — rejected in favor of using
data Auto already has for free. The popover's hint line makes this explicit
to the user.

## Testing

Add unit tests in `test/model.test.js`:

- `parsePriorityHandles`: comma splitting, whitespace, `@`/casing/slash
  normalization, empty/duplicate handling.
- `splitByMutuals` with a priority set: a below-threshold row with a
  matching mutual name moves to `accept`; a below-threshold row with no
  match stays in `reject`; an at/above-threshold row is unaffected either
  way; an unknown-mutuals row stays in `unknown` regardless of
  `mutualNames` content.
