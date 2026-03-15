/**
 * PalsPlan Web Protector — Screen Capture Blocker content script
 *
 * Injects a page-context script that intercepts the Web Screen Capture API
 * (navigator.mediaDevices.getDisplayMedia and screen-sourced getUserMedia) and
 * blocks any attempt to record or share the user's screen. When an attempt is
 * detected it:
 *   1. Rejects the API call so the page never receives screen access.
 *   2. Posts a message that this content script relays to the background
 *      service worker, which then shows a Chrome notification to the user.
 *
 * Why the script-injection pattern?
 * Content scripts run in an isolated JavaScript world and cannot override
 * properties on the *page's* navigator.mediaDevices object. Injecting a
 * <script src="..."> element (loaded from the extension's own origin) causes
 * the override code to execute inside the page's own JavaScript context
 * without triggering inline-script CSP violations.
 */
(function () {
  "use strict";

  // ─── Inject override into the page's JavaScript context ──────────────────
  // Load from the extension's origin via src (avoids inline-script CSP issues).

  const pageScript = document.createElement("script");
  pageScript.src = chrome.runtime.getURL("page-inject.js");
  pageScript.onload = function () { this.remove(); };

  // Append before any page scripts run so the override is in place first.
  (document.head || document.documentElement).appendChild(pageScript);

  // ─── Relay blocked-capture events to the background service worker ────────

  window.addEventListener("message", function (event) {
    if (
      event.source === window &&
      event.data &&
      event.data.type === "__PALSPLAN_SCREEN_CAPTURE_BLOCKED__"
    ) {
      chrome.runtime.sendMessage({
        type: "SCREEN_CAPTURE_BLOCKED",
        api: event.data.api,
        url: window.location.href,
      });
    }
  });
})();
