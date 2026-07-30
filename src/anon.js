// anon.js — screenshot mode: the on/off flag, and pushing it to the tab.
//
// Display only. Nothing here touches stored data, the action log, or a single
// write — every write is keyed on a user id, which this feature never renames.
// Toggling off restores the real names in place.
//
// Session-scoped rather than local: it has to survive Instagram tab
// navigations (a hard navigation re-injects the content script) and the panel
// being closed and reopened mid-shoot, but it should not survive a browser
// restart. There is no badge saying the mode is on — a pill reading "ANON" is
// the one thing guaranteed to be in every screenshot — so the only thing that
// says so is the fake names, and those go away with the browser.

import { IDENTITY_MASK, createMask } from './alias.js';
import * as api from './api.js';

const KEY = 'anonMode';
const IG_TAB_PATTERN = '*://*.instagram.com/*';

/**
 * Real display names the tab could not work out for itself, handed over as
 * `{ handle: fullName }`. The tab learns names from link text, but a profile
 * header's name sits outside any link, so without a seed it stays real until
 * you happen to scroll past that person somewhere they are linked. Bounded
 * because it crosses a message boundary; the pending list caps at 200 anyway.
 */
const MAX_SEEDED_NAMES = 400;

let enabled = false;
let currentMask = IDENTITY_MASK;

function apply(next) {
  enabled = next;
  currentMask = next ? createMask() : IDENTITY_MASK;
}

/** Read the flag back at panel start. Never throws — the mode is a nicety. */
export async function load() {
  try {
    const stored = await chrome.storage.session.get(KEY);
    apply(Boolean(stored[KEY]?.on));
  } catch {
    // Access level not granted, or no session storage. Off is the safe answer.
    apply(false);
  }
  return enabled;
}

export function isOn() {
  return enabled;
}

/** The mask renderers should be holding right now. */
export function mask() {
  return currentMask;
}

function trimNames(names) {
  const entries = Object.entries(names || {})
    .filter(([handle, name]) => handle && typeof name === 'string' && name.trim())
    .slice(0, MAX_SEEDED_NAMES);
  return Object.fromEntries(entries);
}

/**
 * Tell the Instagram tab, if there is one.
 *
 * Deliberately not `api.ensureTab()`: that opens Instagram when no tab is
 * open, and a keyboard shortcut that silently opens a tab is not what anyone
 * means by it. When there is no tab the session flag is enough — the content
 * script reads it on load and starts already masked.
 */
async function pushToTab(on, names) {
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({ url: [IG_TAB_PATTERN] });
  } catch {
    return;
  }
  if (tabs.length === 0) return;

  // A failure here has to be loud. The panel's own half has already applied,
  // so the shot looks masked — while the Instagram tab beside it is still
  // showing real names and real faces, which is the one outcome this feature
  // exists to prevent. Better a dismissible banner in one screenshot than a
  // real handle in all of them.
  let result;
  try {
    result = await api.call('anonMode', { on, names });
  } catch (err) {
    throw new Error(`Screenshot mode did not reach the Instagram tab: ${err.message}`);
  }
  if (!result?.ok) {
    throw new Error(
      `Screenshot mode did not reach the Instagram tab: ${result?.error || 'no response'}`
    );
  }
}

/**
 * @param names `{ handle: realFullName }` to seed the tab with. Only read
 *   when turning the mode on.
 */
export async function setOn(next, names) {
  apply(next);
  const seeded = next ? trimNames(names) : {};

  try {
    if (next) await chrome.storage.session.set({ [KEY]: { on: true, names: seeded } });
    else await chrome.storage.session.remove(KEY);
  } catch {
    // In-memory only for this panel, then. The tab push below still lands.
  }

  await pushToTab(next, seeded);
  return enabled;
}

export function toggle(names) {
  return setOn(!enabled, names);
}
