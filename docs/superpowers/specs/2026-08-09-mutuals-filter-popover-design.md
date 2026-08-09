# Mutuals filter: popover with custom range + "mutual with" match

## Problem

The Mutuals filter chip (`sidepanel.html`, `#f-mutuals`) is a plain
`<select>` with nine fixed presets (any, 0, <5, <10, 1+, 5+, 10+, 50+, 100+).
There's no way to set an arbitrary bound (e.g. "exactly 7", "> 23"), and no
way to filter the list down to rows that share a mutual with a specific
person — the equivalent of Auto's new priority list, but for browsing
instead of auto-accepting.

## Goal

Replace the select with a popover (same pattern as the existing Spam/Auto
popovers) that offers:

1. The nine existing presets, plus a tenth "custom" option, as a single
   mutually-exclusive radio group.
2. When "custom" is selected, a comparator dropdown (`<`, `<=`, `=`, `>`,
   `>=`) and a number field that together define the bound.
3. A checkbox, "mutuals with [handles]", that ANDs against whichever radio
   is selected — a row must satisfy the mutuals range *and* have one of the
   named handles among its mutuals to pass.

## Non-goals

- No persistence across sessions. Every other filter chip (search, spam
  checkboxes, the mutuals select itself today) resets on reopening the
  panel; this stays consistent with that rather than special-casing itself
  the way Auto's priority list did (which the user asked to have retained).
- Does not change Auto's own priority-handle feature or its storage.
- Does not widen mutual-name matching beyond what's already fetched during
  normal enrichment (same ~3-name-per-row limitation as Auto, see below).

## UI

`sidepanel.html`: replace the `<label class="select-chip mutuals-chip">`
block with a popover-host, matching Spam's structure:

- `#mutuals-toggle` button, labeled "Mutuals", with a `#mutuals-count`
  chip-count badge (hidden at 0) showing how many of the two dimensions
  (range ≠ "any", handle checkbox checked) are active — same pattern as
  `updateSpamChip()`.
- `#mutuals-panel` popover containing:
  - A radio group `name="mutuals-preset"`: `any` (default, checked), `0`,
    `<5`, `<10`, `1+`, `5+`, `10+`, `50+`, `100+`, `custom` — same option
    values the select uses today, so the existing value strings keep
    meaning what they already mean.
  - Next to the `custom` radio: a `<select id="mutuals-comparator">` with
    `<`, `<=`, `=`, `>`, `>=`, and a `<input id="mutuals-custom-n" type="number">`.
    Both are only meaningful when `custom` is the selected radio; their
    values are ignored otherwise (no need to disable them — `readFilters`
    simply doesn't read them unless `custom` is checked).
  - A divider, then a checkbox `#f-mutual-handles-on` labeled "mutuals
    with", followed by a text input `#f-mutual-handles` (placeholder
    "comma-separated handles"), and the same style of muted hint line Auto
    uses: "Matches only the ~3 mutual names Instagram shows per row, not
    your full mutual list."

## Model (`src/model.js`)

- New pure helper:

  ```js
  export function mutualsBoundFromComparator(comparator, n) {
    switch (comparator) {
      case '>': return { minMutuals: n + 1, maxMutuals: null };
      case '>=': return { minMutuals: n, maxMutuals: null };
      case '<': return { minMutuals: 0, maxMutuals: n - 1 };
      case '<=': return { minMutuals: 0, maxMutuals: n };
      case '=': return { minMutuals: n, maxMutuals: n };
      default: return { minMutuals: 0, maxMutuals: null };
    }
  }
  ```

  Reuses the exact `minMutuals`/`maxMutuals` pair `applyFilters` already
  understands — no new bound representation.

- `DEFAULT_FILTERS` gains `mutualHandles: []`.
- `ENRICHED_ONLY_FILTERS` gains `'mutualHandles'`. `usesEnrichedFilters`
  needs a length check for it (arrays are always truthy, same reason
  `maxFollowers` is already special-cased there).
- `applyFilters`, inside the existing enriched-gated block: reject a row if
  `filters.mutualHandles.length > 0` and none of `row.mutualNames`
  (normalized) is in the set. Reuses `normalizeHandle` and the same
  matching shape `splitByMutuals` uses for Auto's priority list.

## Wiring (`src/panel.js`)

- `readMutualsFilter(presetValue, comparator, n)`: if `presetValue ===
  'custom'`, delegate to `mutualsBoundFromComparator`; otherwise, same
  parsing as today (`<N`, `N+`, `0`, `any`).
- `readFilters()`: reads the checked radio, and if it's `custom`, also
  reads the comparator select and number field. Reads the new checkbox and
  text field into `filters.mutualHandles` via `parsePriorityHandles`
  (already exported from `model.js` for Auto — reused here rather than
  duplicated).
- `resetFilters()`: check the `any` radio, clear the comparator/number
  fields, uncheck the handles checkbox, clear its text field.
- New `updateMutualsChip()` mirroring `updateSpamChip()`: counts (range
  active ? 1 : 0) + (handles checkbox checked with non-empty text ? 1 : 0).
- The popover open/close/Escape/outside-click wiring is copy-shaped from
  the existing Spam and Auto popover handlers already in `bind()`.
- `filterInputs` (the array of ids wired to `change` -> `readFilters`)
  gains the new radio group, comparator select, number field, checkbox,
  and handles text field.

## Testing

`test/model.test.js`:

- `mutualsBoundFromComparator`: one case per comparator, including the `=`
  case producing equal min/max.
- `applyFilters` with `mutualHandles` set: a row whose `mutualNames`
  contains a listed handle passes; one that doesn't is excluded; an
  un-enriched row is excluded regardless (same as the existing
  enriched-only filter tests already in the file).
- `usesEnrichedFilters`/`filtersActive` recognize a non-empty
  `mutualHandles` as active, and an empty array as not.
