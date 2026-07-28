// background.js — service worker.
//
// Deliberately almost empty. The side panel is a real document with full
// chrome.* access, so it owns tab resolution, messaging and both throttle
// queues itself. Keeping the hot path out of the service worker means nothing
// breaks when Chrome tears the worker down after 30s of idle.

chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((err) => console.error('[Request Blaster] setPanelBehavior failed:', err));
