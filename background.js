// background.js — service worker.
//
// Almost empty by design. The side panel is a real document with full chrome.*
// access, so it owns tab resolution, messaging and both throttle queues
// itself. Keeping the hot path out of the service worker means nothing breaks
// when Chrome tears the worker down after 30s of idle.

const IG_MATCH = '*://*.instagram.com/*';

// Read from the manifest rather than listed here, the same way api.js does it.
// Hardcoded, this list had already fallen a script behind: harvest-content.js
// was in the manifest and not here, so a tab that predated the extension got a
// partial injection and one feature's ops answered "unknown op" forever.
const CONTENT_FILES =
  chrome.runtime.getManifest().content_scripts?.[0]?.js || ['content.js', 'banner.js'];

chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((err) => console.error('[Request Blaster] setPanelBehavior failed:', err));

// session storage defaults to TRUSTED_CONTEXTS, which excludes content
// scripts. The profile banner reads the same cached pending list and handled
// ids as the panel, so it needs in.
chrome.storage.session
  .setAccessLevel({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' })
  .catch((err) => console.error('[Request Blaster] setAccessLevel failed:', err));

/**
 * A `content_scripts` declaration only injects on navigation. Tabs that were
 * already open when the extension was installed, reloaded, or updated never
 * get it — which is every Instagram tab you had open while developing. Inject
 * into them explicitly so the panel works without a manual tab reload.
 */
async function injectIntoOpenTabs() {
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({ url: [IG_MATCH] });
  } catch (err) {
    console.error('[Request Blaster] tab query failed:', err);
    return;
  }

  for (const tab of tabs) {
    if (tab.id === undefined) continue;
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: CONTENT_FILES });
    } catch {
      // Discarded tabs and error pages can't be scripted. The panel retries
      // injection on demand anyway, so this is not worth surfacing.
    }
  }
}

chrome.runtime.onInstalled.addListener(injectIntoOpenTabs);
chrome.runtime.onStartup.addListener(injectIntoOpenTabs);
