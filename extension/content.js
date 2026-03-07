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
 * <script> element causes the override code to execute inside the page's own
 * JavaScript context, giving it the access it needs.
 */
(function () {
  "use strict";

  // ─── Inject override into the page's JavaScript context ──────────────────

  const pageScript = document.createElement("script");
  pageScript.textContent = `(function () {
  'use strict';
  var _MSG_TYPE = '__PALSPLAN_SCREEN_CAPTURE_BLOCKED__';

  function rejectCapture(apiName) {
    window.postMessage({ type: _MSG_TYPE, api: apiName }, '*');
    return Promise.reject(
      new DOMException(
        'Screen capture is blocked by PalsPlan Web Protector.',
        'NotAllowedError'
      )
    );
  }

  if (navigator.mediaDevices) {
    // Block getDisplayMedia — the primary screen-recording/sharing API.
    // Use Object.defineProperty to prevent the page from re-overriding it.
    if (typeof navigator.mediaDevices.getDisplayMedia === 'function') {
      Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia', {
        configurable: false,
        enumerable: true,
        writable: false,
        value: function () {
          return rejectCapture('getDisplayMedia');
        },
      });
    }

    // Block getUserMedia when called with a screen/window/tab video source.
    if (typeof navigator.mediaDevices.getUserMedia === 'function') {
      var _origGetUserMedia = navigator.mediaDevices.getUserMedia.bind(
        navigator.mediaDevices
      );
      Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
        configurable: false,
        enumerable: true,
        writable: false,
        value: function (constraints) {
          if (
            constraints &&
            constraints.video &&
            typeof constraints.video === 'object' &&
            (constraints.video.mediaSource === 'screen' ||
              constraints.video.mediaSource === 'window' ||
              constraints.video.mediaSource === 'browser' ||
              constraints.video.displaySurface !== undefined)
          ) {
            return rejectCapture('getUserMedia');
          }
          return _origGetUserMedia(constraints);
        },
      });
    }
  }
})();`;

  // Append before any page scripts run so the override is in place first.
  (document.head || document.documentElement).appendChild(pageScript);
  pageScript.remove();

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
