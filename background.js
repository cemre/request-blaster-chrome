// background.js — service worker.
//
// Almost empty by design. The side panel is a real document with full chrome.*
// access, so it owns tab resolution, messaging and both throttle queues
// itself. Keeping the hot path out of the service worker means nothing breaks
// when Chrome tears the worker down after 30s of idle.

const IG_MATCH = '*://*.instagram.com/*';

chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((err) => console.error('[Request Blaster] setPanelBehavior failed:', err));

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
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
    } catch {
      // Discarded tabs and error pages can't be scripted. The panel retries
      // injection on demand anyway, so this is not worth surfacing.
    }
  }
}

chrome.runtime.onInstalled.addListener(injectIntoOpenTabs);
chrome.runtime.onStartup.addListener(injectIntoOpenTabs);
