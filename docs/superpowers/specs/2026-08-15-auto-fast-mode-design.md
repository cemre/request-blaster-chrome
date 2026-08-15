# Auto — Fast mode

Date: 2026-08-15
Status: Approved design, ready for implementation planning

## Problem

Auto's first phase hydrates every un-enriched row before it can decide anything
(`startAutoTriage`, the `missing` / `runHydrationBatch` block). `web_profile_info`
is one request per user at `PACING.moderate`, and on a live queue roughly 128 of
200 requests carry no `social_context`, so a full run spends most of its
wall-clock loading details for people who will be rejected anyway.

The ask is a **fast option**: decide on the approximate counts the pending list
gives away for free, treat a missing hint as 0 mutuals, and skip hydration
entirely.

## The trade this accepts, stated plainly

**A missing `social_context` does not mean zero mutuals.** Sampled against a live
queue on 2026-07-28 and recorded in `model.js` and `test/model.test.js`: 128 of
200 pending users had no `social_context`, and half of a random sample of those
did have mutuals — 38, 9, 2, 2. This is why `noMutuals` sits in
`ENRICHED_ONLY_FILTERS` and only ever matches an exact count.

Fast mode therefore rejects some people you would have accepted, and Instagram
rejections cannot be undone. That is the point of the feature, not an oversight:
speed bought with precision, on the operator's own account, chosen deliberately.

Everything in this design that isn't the rule itself exists to keep that trade
**chosen** rather than **discovered** — §4's count in the confirm dialog, §5's
mark in the log, and §3's repair of the safety valve.

## Non-goals

- Changing what normal (non-fast) Auto does. Its hydrate-then-decide behaviour
  and its `unknown` bucket are untouched.
- Making fast mode the default. It is off unless ticked.
- Guessing at mutuals from any signal other than `social_context`.
- Any new Instagram request. Fast mode strictly removes requests; it adds none.

## Design

### 1. The rule

`splitByMutuals` grows one option:

```js
splitByMutuals(rows, minMutuals, priorityHandles = new Set(), { unknownIsZero = false } = {})
```

With `unknownIsZero`, a row whose `mutuals` is not a number is sorted by 0
rather than pushed to `unknown`, so the `unknown` bucket comes back empty and
nothing is left undecided.

Fast mode does **not** ignore enrichment — it only declines to perform it.
`mergeRows` already prefers an exact count over the estimate for any row with a
cached profile, so rows enriched by an earlier `Load details` still decide on
their real numbers. That information is already paid for.

### 2. Skipping the fetch

`startAutoTriage(minMutuals, priorityHandles, { fast = false })` skips the
`missing` / `runHydrationBatch` block when `fast`.

Untouched: pacing, the run stack and its bars, the rate-limit backoff ladder,
`waitOutRateLimit`, refresh-and-repeat, Stop, and claims. The only visible
difference is that the "Loading details…" phase never appears — which is the
entire speedup.

### 3. The priority-handle safety valve must keep working

`mergeRows` sets `mutualNames: []` on every un-enriched row and only fills it
from a cached profile. In fast mode nothing is enriched, so **"Also accept if
mutual with: @x" would silently never fire** — the operator would believe those
people were protected while they were being rejected. A safety valve that fails
without saying so is worse than no valve.

Fix: `mergeRows` populates `mutualNames` for un-enriched rows from
`social_context`, using the names `parseMutualCount` already parses out of the
same string.

```
"Followed by alice, bob + 3 more"  ->  ['alice', 'bob']
```

The "+ 3 more" are unnamed in the string and unrecoverable without hydration —
so the valve is partial in fast mode, covering only named mutuals. That is a
real limit and belongs in the spec rather than in a surprise.

This helps normal mode too: nothing reads those names before enrichment today.
A hydrated row keeps overwriting them with the exact list, so the enriched path
is unchanged.

**Open, low-risk:** whether live `social_context` names are usernames or display
names. Test fixtures use handle-shaped names (`alice`, `bob`, `x`) and the
operator believes they are usernames, but this has not been checked against a
live queue. `splitByMutuals` already runs both sides through `normalizeHandle`,
so if they turn out to be display names the match simply doesn't fire — the same
behaviour as today, no regression. **Verify against a live queue during
implementation** and record the answer here.

### 4. Name the damage before doing it

The number of rows about to be rejected on no evidence is computable from the
loaded queue before the run starts:

```js
live().filter((row) => typeof row.mutuals !== 'number').length
```

In fast mode `confirmAction` carries it:

> **Accept 10+ mutuals, reject the rest — fast.**
> 128 of 200 requests have no mutual hint from Instagram and will be rejected.
> This can't be undone.

Costs one line and no requests. Without it the operator meets the trade only in
the log, after it is permanent.

### 5. Mark the guesses in the log

`buildRecord({ at, userId, username, action })` gains an optional `guessed: true`,
set only on a fast-mode rejection of a row with no mutual count.

The log already keeps usernames for two years and exists so a mistaken rejection
can be found again; this narrows the search from "every rejection" to "the ones
decided without evidence", which is the set actually worth reviewing after a
fast run. Backward compatible — existing records simply lack the field, and
`recordKey` is unchanged, so identity and de-duplication are unaffected.

Rendering: `renderLog` marks a `guessed` record with the same visual treatment
as a `skipNotes` note, so the log keeps one vocabulary of row marks. It is not
the same *mechanism* and must not be folded into one: `skipNotes` is
`{ [userId]: { label, date } }` handed in from an outside feature, while
`guessed` is a field of the record itself and travels with it through storage.

### 6. UI

In the Auto popover, under the mutuals threshold:

- Checkbox: **Fast (skip loading details)**
- Helper line: *Counts a missing hint as 0 mutuals*

Persisted as `state.settings.autoFast` alongside `autoPriorityHandlesText`, saved
on change like the priority list. Must hold one line at 260px per the panel's
width rule.

## Testing

`test/model.test.js`:

- `splitByMutuals` with `unknownIsZero` sorts a null count into `reject`, returns
  an empty `unknown`, and still honours `minMutuals` and priority handles.
- Without the option, the existing `unknown` behaviour is unchanged (guards the
  normal path against this change).
- A cached/enriched row decides on its exact count even in fast mode.
- `mergeRows` fills `mutualNames` from `social_context` for an un-enriched row,
  leaves it `[]` when there is no hint, and lets a hydrated profile overwrite it.
- A priority handle named in `social_context` alone routes an un-enriched row to
  `accept`.

Panel-level behaviour (fast run skips hydration, confirm text carries the count)
follows the existing DOM-shim approach used for the hydration-failure marks.

## Risks

- **Irreversible by design.** Mitigated, not removed, by §4 and §5. Fast mode
  stays off by default and behind the existing `warn: true` confirm.
- **`social_context` name format unverified** — §3, degrades to today's
  behaviour.
- **Fast mode's speed makes a mistake bigger.** Removing the hydration phase
  means a wrong threshold burns through the queue faster than a slow run would
  have. The confirm dialog is the only checkpoint; keep it.
