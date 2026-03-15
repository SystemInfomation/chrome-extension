/**
 * PalsPlan Web Protector — page-context screen-capture override
 *
 * This file is injected into the page's main JavaScript world by content.js
 * using a <script src="..."> element so it runs before any page code and
 * avoids inline-script CSP violations.
 *
 * It intercepts the Web Screen Capture API (getDisplayMedia and
 * screen-sourced getUserMedia) and blocks any attempt to record or share
 * the user's screen, then posts a message that content.js forwards to the
 * background service worker.
 */
(function () {
  "use strict";

  const _MSG_TYPE = "__PALSPLAN_SCREEN_CAPTURE_BLOCKED__";

  function rejectCapture(apiName) {
    window.postMessage({ type: _MSG_TYPE, api: apiName }, "*");
    return Promise.reject(
      new DOMException(
        "Screen capture is blocked by PalsPlan Web Protector.",
        "NotAllowedError"
      )
    );
  }

  if (navigator.mediaDevices) {
    // Block getDisplayMedia — the primary screen-recording/sharing API.
    if (typeof navigator.mediaDevices.getDisplayMedia === "function") {
      Object.defineProperty(navigator.mediaDevices, "getDisplayMedia", {
        configurable: false,
        enumerable: true,
        writable: false,
        value: function () {
          return rejectCapture("getDisplayMedia");
        },
      });
    }

    // Block getUserMedia when called with a screen/window/tab video source.
    if (typeof navigator.mediaDevices.getUserMedia === "function") {
      const _origGetUserMedia = navigator.mediaDevices.getUserMedia.bind(
        navigator.mediaDevices
      );
      Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
        configurable: false,
        enumerable: true,
        writable: false,
        value: function (constraints) {
          if (
            constraints &&
            constraints.video &&
            typeof constraints.video === "object" &&
            (constraints.video.mediaSource === "screen" ||
              constraints.video.mediaSource === "window" ||
              constraints.video.mediaSource === "browser" ||
              constraints.video.displaySurface !== undefined)
          ) {
            return rejectCapture("getUserMedia");
          }
          return _origGetUserMedia(constraints);
        },
      });
    }
  }
})();
