/**
 * SafeSearch Enforcement Content Script
 *
 * Injected on Google, Bing, YouTube, and DuckDuckGo pages to enforce
 * SafeSearch / Restricted Mode and prevent manual disabling.
 *
 * This is a secondary enforcement layer — the primary enforcement is done
 * via declarativeNetRequest redirect rules in the background service worker.
 */

/* eslint-env browser */
/* global chrome */

(function () {
  "use strict";

  const host = location.hostname.toLowerCase();

  /**
   * Check if the current hostname matches a target domain (exact or subdomain match).
   * Uses endsWith check with dot prefix to avoid substring false positives.
   * @param {string} target  e.g. "bing.com"
   * @returns {boolean}
   */
  function hostMatches(target) {
    return host === target || host.endsWith("." + target);
  }

  // ── Google SafeSearch ──────────────────────────────────────────────────────

  if (hostMatches("google.com") || hostMatches("google.co.uk") || hostMatches("google.ca") || hostMatches("google.com.au")) {
    const url = new URL(location.href);
    // Enforce safe=active on search result pages
    if (url.pathname === "/search" || url.searchParams.has("q")) {
      if (url.searchParams.get("safe") !== "active") {
        url.searchParams.set("safe", "active");
        location.replace(url.toString());
        return;
      }
    }

    // Observe the SafeSearch settings page and block disabling
    const observer = new MutationObserver(() => {
      // Look for SafeSearch toggle elements and ensure they stay enabled
      const safesearchToggles = document.querySelectorAll(
        '[data-safesearch], [aria-label*="SafeSearch"], [id*="safesearch"]'
      );
      safesearchToggles.forEach((el) => {
        if (el.getAttribute("aria-checked") === "false") {
          // Notify the background about the bypass attempt
          chrome.runtime.sendMessage({
            type: "SAFESEARCH_BYPASS_ATTEMPT",
            engine: "google",
            url: location.href,
          });
        }
      });
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  // ── Bing SafeSearch ────────────────────────────────────────────────────────

  if (hostMatches("bing.com")) {
    const url = new URL(location.href);
    if (url.pathname === "/search" || url.searchParams.has("q")) {
      if (url.searchParams.get("adlt") !== "strict") {
        url.searchParams.set("adlt", "strict");
        location.replace(url.toString());
        return;
      }
    }
  }

  // ── DuckDuckGo SafeSearch ──────────────────────────────────────────────────

  if (hostMatches("duckduckgo.com")) {
    const url = new URL(location.href);
    // kp=1 enables strict safe search on DuckDuckGo
    if (url.searchParams.has("q") && url.searchParams.get("kp") !== "1") {
      url.searchParams.set("kp", "1");
      location.replace(url.toString());
      return;
    }
  }

  // ── YouTube Restricted Mode ────────────────────────────────────────────────

  if (hostMatches("youtube.com")) {
    // Set the PREF cookie to enable Restricted Mode (f2=8000000)
    // This cookie tells YouTube to use Restricted Mode
    function enforceYouTubeRestricted() {
      const prefCookie = document.cookie
        .split(";")
        .find((c) => c.trim().startsWith("PREF="));
      const currentPref = prefCookie ? prefCookie.split("=").slice(1).join("=") : "";

      // Check if restricted mode flag is already set
      if (!currentPref.includes("f2=8000000")) {
        // Add restricted mode flag to existing PREF cookie
        const newPref = currentPref
          ? currentPref + "&f2=8000000"
          : "f2=8000000";
        document.cookie =
          "PREF=" + newPref + ";domain=.youtube.com;path=/;max-age=31536000;SameSite=Lax";
      }
    }

    enforceYouTubeRestricted();

    // Monitor for attempts to disable Restricted Mode via the settings UI
    const ytObserver = new MutationObserver(() => {
      // Look for the Restricted Mode toggle in YouTube's settings menu
      const restrictedToggle = document.querySelector(
        '[aria-label*="Restricted Mode"], #restricted-mode, [data-restricted-mode]'
      );
      if (restrictedToggle) {
        const isOff =
          restrictedToggle.getAttribute("aria-checked") === "false" ||
          restrictedToggle.getAttribute("aria-pressed") === "false";
        if (isOff) {
          chrome.runtime.sendMessage({
            type: "SAFESEARCH_BYPASS_ATTEMPT",
            engine: "youtube",
            url: location.href,
          });
          // Re-enforce restricted mode
          enforceYouTubeRestricted();
        }
      }
    });
    ytObserver.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
  }
})();
