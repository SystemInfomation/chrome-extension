/**
 * WebRTC Leak Prevention Content Script
 *
 * Prevents WebRTC from leaking the real IP address, which could be used
 * to bypass VPN detection or reveal the user's actual location.
 *
 * This script overrides RTCPeerConnection to monitor and block connections
 * to known VPN/proxy STUN/TURN servers and logs any bypass attempts.
 */

/* eslint-env browser */
/* global chrome */

(function () {
  "use strict";

  // Store the original RTCPeerConnection constructor
  const OriginalRTCPeerConnection =
    window.RTCPeerConnection ||
    window.webkitRTCPeerConnection ||
    window.mozRTCPeerConnection;

  if (!OriginalRTCPeerConnection) return;

  // Known VPN/proxy STUN/TURN server patterns
  const BLOCKED_STUN_PATTERNS = [
    /vpn/i,
    /proxy/i,
    /tunnel/i,
    /anonymi/i,
    /bypass/i,
    /hide[\-_.]?my/i,
    /unblock/i,
  ];

  /**
   * Check if an ICE server URL matches a known VPN/proxy pattern.
   * @param {string} url
   * @returns {boolean}
   */
  function isBlockedIceServer(url) {
    return BLOCKED_STUN_PATTERNS.some((pattern) => pattern.test(url));
  }

  /**
   * Wrapped RTCPeerConnection that monitors ICE server configuration
   * and blocks connections to suspicious STUN/TURN servers.
   */
  function WrappedRTCPeerConnection(config, constraints) {
    // Inspect ICE servers for suspicious entries
    if (config && config.iceServers) {
      const filtered = [];
      for (const server of config.iceServers) {
        const urls = Array.isArray(server.urls)
          ? server.urls
          : server.url
            ? [server.url]
            : server.urls
              ? [server.urls]
              : [];

        const hasBlocked = urls.some((u) => isBlockedIceServer(u));
        if (hasBlocked) {
          // Report the VPN bypass attempt to the background
          try {
            chrome.runtime.sendMessage({
              type: "VPN_BYPASS_ATTEMPT",
              method: "webrtc",
              detail: "Blocked suspicious ICE server: " + urls.join(", "),
              url: location.href,
            });
          } catch (_e) {
            /* extension context may not be available */
          }
          // Skip this server
          continue;
        }
        filtered.push(server);
      }
      config.iceServers = filtered;
    }

    // Create the real RTCPeerConnection with filtered config
    return new OriginalRTCPeerConnection(config, constraints);
  }

  // Copy static properties and prototype
  WrappedRTCPeerConnection.prototype = OriginalRTCPeerConnection.prototype;
  Object.keys(OriginalRTCPeerConnection).forEach((key) => {
    try {
      WrappedRTCPeerConnection[key] = OriginalRTCPeerConnection[key];
    } catch (_e) {
      /* some properties may be non-configurable */
    }
  });

  // Override the global RTCPeerConnection
  Object.defineProperty(window, "RTCPeerConnection", {
    value: WrappedRTCPeerConnection,
    writable: false,
    configurable: false,
  });

  if (window.webkitRTCPeerConnection) {
    Object.defineProperty(window, "webkitRTCPeerConnection", {
      value: WrappedRTCPeerConnection,
      writable: false,
      configurable: false,
    });
  }
})();
