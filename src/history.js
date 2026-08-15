// history.js — pure transforms for the local action log. No chrome.*, no DOM.
//
// The log is append-only and holds one line per action actually taken:
// when, who, what. Nothing is derived into a second copy and nothing is
// mutated after the fact, so the file on disk is always just the list of
// things that happened.
//
// Records are sharded by day. That keeps appends small, makes retention a
// matter of deleting whole keys, and means the panel reads none of this at
// startup — the log is loaded only when you open it.

export const DAY_PREFIX = 'log:';

// Not `log:`-prefixed on purpose: day shards are found by that prefix, and an
// index living inside its own namespace would be picked up as a shard.
export const LOG_INDEX_KEY = 'logIndex';

export const RETENTION_DAYS = 730;

export const ACCEPT = 'accept';
export const ACCEPT_FOLLOW = 'acceptFollow';
export const REJECT = 'reject';
// Following someone back later, from the log itself.
export const FOLLOW = 'follow';

export const ACTION_LABELS = {
  [ACCEPT]: 'Accepted',
  [ACCEPT_FOLLOW]: 'Accepted + followed',
  [REJECT]: 'Rejected',
  [FOLLOW]: 'Followed back',
};

/** Actions that put someone on your accepted list. */
const ACCEPTING = new Set([ACCEPT, ACCEPT_FOLLOW]);
/** Actions that mean you now follow them. */
const FOLLOWING = new Set([ACCEPT_FOLLOW, FOLLOW]);

const DAY_MS = 86400000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// -------------------------------------------------------------------- keys

/**
 * UTC, so a shard key never depends on where the browser happens to be.
 * Clock times are rendered in local time; only the boundary is UTC.
 */
export function dayKey(at) {
  return DAY_PREFIX + new Date(at).toISOString().slice(0, 10);
}

export function dayKeyDate(key) {
  return key.slice(DAY_PREFIX.length);
}

/** Shards past the retention window, for deletion. `index` is the stored list. */
export function expiredDayKeys(index, now, retentionDays = RETENTION_DAYS) {
  const cutoff = new Date(now - retentionDays * DAY_MS).toISOString().slice(0, 10);
  return (index || []).filter((key) => dayKeyDate(key) < cutoff);
}

// ----------------------------------------------------------------- records

/**
 * One line of the log. Only successful actions are recorded — a rejection that
 * failed did not happen, and logging it would make the log answer "what did I
 * try" when the question being asked is "what did I do".
 *
 * `guessed` marks a rejection Auto's fast mode made on no evidence — a row
 * Instagram gave no mutual count for, rejected as if that meant zero. It is
 * not part of *what happened*, which is why `recordKey` ignores it; it is how
 * the decision was reached, kept because this log is the only route back to
 * someone that mode got wrong, and "the ones decided blind" is a far better
 * place to start looking than "every rejection".
 */
export function buildRecord({ at, userId, username, action, guessed = false }) {
  const record = { at, userId: String(userId), username, action };
  // Set only when true, never as `guessed: false`. Two years of stored records
  // predate the field and read back without it, so absence has to mean the
  // same thing as false or the log would sort its own history into two kinds.
  if (guessed) record.guessed = true;
  return record;
}

/**
 * Identity of a record, for recognising one we already hold.
 *
 * A live action reaches a reader twice — once from whoever performed it, once
 * from the storage change it caused — and the two copies are equal but not the
 * same object, so identity has to come from the contents.
 *
 * Username is left out: it is what the account was called at the time, not part
 * of what happened. The other three are enough, because actions are paced
 * seconds apart and no account is acted on twice in a run, so colliding on all
 * three would mean the same record.
 */
export function recordKey(record) {
  return `${record.at}:${record.userId}:${record.action}`;
}

// ------------------------------------------------------------------- views

export function isAccept(record) {
  return ACCEPTING.has(record.action);
}

export function isReject(record) {
  return record.action === REJECT;
}

/**
 * Ids you already follow, so the accepted list can offer "Follow back" only
 * where it would actually do something. Derived on read rather than tracked as
 * state — the log already says it.
 */
export function followedIds(records) {
  const ids = new Set();
  for (const record of records) {
    if (FOLLOWING.has(record.action)) ids.add(record.userId);
  }
  return ids;
}

export const FILTERS = {
  all: () => true,
  accepted: isAccept,
  rejected: isReject,
};

export function filterRecords(records, { kind = 'all', search = '' } = {}) {
  const predicate = FILTERS[kind] || FILTERS.all;
  const term = search.trim().toLowerCase();

  return records.filter((record) => {
    if (!predicate(record)) return false;
    if (term && !record.username.toLowerCase().includes(term)) return false;
    return true;
  });
}

/** Newest first — the order you want when you are looking for a mistake. */
export function sortRecords(records) {
  return [...records].sort((a, b) => b.at - a.at);
}

/**
 * What the log's select-all button should do next, given the ids it is allowed
 * to tick and the ones already ticked.
 *
 * Derived from the selection rather than toggled, like the requests bar's own
 * button. What is new here is that the two sets can differ: a row can be
 * selected without being selectable, because rows an outside feature has
 * already handled are left out of `selectableIds` but can still be ticked by
 * hand. That is why this is a function with a test rather than an expression
 * open-coded in the two places that need it.
 *
 * `next` therefore adds rather than replaces — "select all" does not say "and
 * drop the ones you picked yourself". Clearing is what deselect is for, and it
 * clears everything, hand-picked rows included.
 */
export function selectAllPlan(selectableIds = [], selected = new Set()) {
  const missing = selectableIds.filter((id) => !selected.has(id));

  if (missing.length > 0) {
    return { mode: 'select', disabled: false, next: new Set([...selected, ...selectableIds]) };
  }
  // Nothing left to add. The button offers the only move it has left, and is
  // dead only when there is no selection to undo either.
  return { mode: 'deselect', disabled: selected.size === 0, next: new Set() };
}

/**
 * Locale-independent on purpose: a fixed format keeps the day headers stable
 * and the tests deterministic. Times are formatted at the render layer.
 */
export function dayLabel(isoDate, now) {
  const today = new Date(now).toISOString().slice(0, 10);
  const yesterday = new Date(now - DAY_MS).toISOString().slice(0, 10);
  if (isoDate === today) return 'Today';
  if (isoDate === yesterday) return 'Yesterday';

  const [year, month, day] = isoDate.split('-');
  return `${Number(day)} ${MONTHS[Number(month) - 1]} ${year}`;
}

/**
 * "12 accepted · 3 rejected" for a day's records, omitting a side that is
 * zero. Follow-backs are left out — they are not a triage outcome, they are
 * what you did afterward with one you already accepted.
 */
export function dayCountLabel(records) {
  const accepted = records.filter(isAccept).length;
  const rejected = records.filter(isReject).length;
  return [
    accepted ? `${accepted} accepted` : null,
    rejected ? `${rejected} rejected` : null,
  ].filter(Boolean).join(' · ');
}

/** Records bucketed under day headings, newest day first. */
export function groupByDay(records, now) {
  const days = new Map();

  for (const record of sortRecords(records)) {
    const date = dayKeyDate(dayKey(record.at));
    let group = days.get(date);
    if (!group) {
      group = { date, label: dayLabel(date, now), records: [] };
      days.set(date, group);
    }
    group.records.push(record);
  }

  return [...days.values()].sort((a, b) => (a.date < b.date ? 1 : -1));
}
