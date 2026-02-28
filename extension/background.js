/**
 * PalsPlan Web Protector — background service worker
 *
 * Intercepts main_frame navigation requests and blocks:
 *  1. Adult/explicit content  — detected via keyword/pattern matching on the URL
 *  2. Malicious/suspicious sites — detected via link-shield (offline, heuristic)
 *
 * When a URL is blocked the tab is redirected to the hosted blocked page at
 * https://blocked.palsplan.app with the original URL and block reason encoded
 * as query-string parameters.
 *
 * No external API calls are made during detection — everything is offline.
 *
 * NOTE: Blocking webRequest listeners in Manifest V3 are only available to
 * extensions that are force-installed via enterprise policy
 * (ExtensionInstallForcelist / ExtensionSettings). The blocking capability is
 * granted by the enterprise policy itself — no manifest permission declaration
 * is required (and "webRequestBlocking" is not a valid MV3 permission).
 * This extension is designed exclusively for that deployment model and cannot
 * be disabled by end users.
 */

import { detectSuspiciousLink } from "link-shield";

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────

/** Blocked-page URL (must be internet-accessible and HTTPS). */
const BLOCKED_PAGE_BASE = "https://blocked.palsplan.app";

/**
 * Minimum link-shield risk score that triggers a block.
 * 0–100; 50 = medium risk and above.
 */
const RISK_SCORE_THRESHOLD = 50;

/**
 * In-memory cache of already-evaluated URLs.
 * Maps URL string → { blocked: boolean, reason: string }
 * Prevents redundant heuristic work on repeated navigations (e.g. back/forward,
 * reload, embedded frames of the same origin).
 * Capped at MAX_CACHE_SIZE to avoid unbounded memory growth.
 */
const MAX_CACHE_SIZE = 500;
const urlDecisionCache = new Map();

/**
 * Domains/hostnames that are always allowed regardless of detection results.
 * At minimum keep palsplan.app here to avoid self-blocking the blocked page.
 */
const WHITELIST = new Set([
  "palsplan.app",
  "blocked.palsplan.app",
  // Add more trusted corporate domains as needed
]);

/**
 * Adult/explicit content keywords checked against the full lower-cased URL.
 * Using a single compiled RegExp is faster than looping multiple patterns.
 */
const ADULT_REGEX = new RegExp(
  [
    "\\bporn\\b",
    "\\bxxx\\b",
    "\\badult\\b",
    "\\bsex\\b",
    "\\bonlyfans\\b",
    "\\bnude\\b",
    "\\bnudes\\b",
    "\\bnaked\\b",
    "\\berotic\\b",
    "\\bhentai\\b",
    "\\bxxxvideo\\b",
    "\\bpornhub\\b",
    "\\bxvideos\\b",
    "\\bxhamster\\b",
    "\\bredtube\\b",
    "\\byouporn\\b",
    "\\bcamsoda\\b",
    "\\bchaturbate\\b",
    "\\bbangbros\\b",
    "\\bbrazzers\\b",
    "\\bfetish\\b",
    "\\bescort\\b",
    "\\bstripper\\b",
    "\\bcamgirl\\b",
  ].join("|"),
  "i"
);

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns true if the given hostname (or any parent domain) is in the whitelist.
 * e.g. "sub.palsplan.app" matches "palsplan.app"
 *
 * @param {string} hostname
 * @returns {boolean}
 */
function isWhitelisted(hostname) {
  if (WHITELIST.has(hostname)) return true;
  const parts = hostname.split(".");
  for (let i = 1; i < parts.length - 1; i++) {
    if (WHITELIST.has(parts.slice(i).join("."))) return true;
  }
  return false;
}

/**
 * Evict the oldest entry from urlDecisionCache when it exceeds MAX_CACHE_SIZE.
 */
function maybePruneCache() {
  if (urlDecisionCache.size >= MAX_CACHE_SIZE) {
    const firstKey = urlDecisionCache.keys().next().value;
    urlDecisionCache.delete(firstKey);
  }
}

/**
 * Evaluate a URL against all detection rules and return the block decision.
 * Results are memoised in urlDecisionCache for fast repeat lookups.
 *
 * @param {string} url
 * @returns {{ blocked: boolean, reason: string }}
 */
function evaluate(url) {
  // Fast path — return cached decision
  if (urlDecisionCache.has(url)) {
    return urlDecisionCache.get(url);
  }

  let decision;

  // 1. Adult content check (single compiled regex — very fast)
  if (ADULT_REGEX.test(url)) {
    decision = { blocked: true, reason: "Adult Content" };
  } else {
    // 2. Malicious / suspicious site check (link-shield offline heuristics)
    try {
      const result = detectSuspiciousLink(url, { threshold: RISK_SCORE_THRESHOLD });
      if (result.suspicious || result.riskScore >= RISK_SCORE_THRESHOLD) {
        const detail =
          result.reasons && result.reasons.length > 0
            ? result.reasons.join("; ")
            : "Potential Malicious / Suspicious Site";
        const reason =
          result.riskScore >= RISK_SCORE_THRESHOLD
            ? "High risk score (" + result.riskScore + "/100): " + detail
            : "Potential Malicious / Suspicious Site: " + detail;
        decision = { blocked: true, reason: reason };
      } else {
        decision = { blocked: false, reason: "" };
      }
    } catch (err) {
      // link-shield errors (e.g. malformed URL) must not block navigation
      console.warn("[PalsPlan] link-shield error for", url, err);
      decision = { blocked: false, reason: "" };
    }
  }

  // Store in cache
  maybePruneCache();
  urlDecisionCache.set(url, decision);
  return decision;
}

/**
 * Builds the redirect URL to the blocked page.
 *
 * @param {string} originalUrl
 * @param {string} reason
 * @returns {string}
 */
function buildBlockedUrl(originalUrl, reason) {
  const params = new URLSearchParams({ blockedUrl: originalUrl, reason: reason });
  return BLOCKED_PAGE_BASE + "?" + params.toString();
}

// ─────────────────────────────────────────────────────────────────────────────
// Main interception listener
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Intercepts only top-level page navigations (main_frame).
 * Returns a redirect to the blocked page when a URL should be blocked.
 *
 * Blocking webRequest listeners in MV3 are restricted to enterprise-policy
 * force-installed extensions — which is the only deployment model supported
 * by this extension.
 */
chrome.webRequest.onBeforeRequest.addListener(
  function (details) {
    const url = details.url;

    // Ignore non-http(s) schemes (chrome://, chrome-extension://, etc.)
    if (url.indexOf("http://") !== 0 && url.indexOf("https://") !== 0) {
      return {};
    }

    // Extract hostname for whitelist check
    let hostname;
    try {
      hostname = new URL(url).hostname.toLowerCase();
    } catch (_e) {
      return {};
    }

    // Allow whitelisted domains unconditionally
    if (isWhitelisted(hostname)) {
      return {};
    }

    // Run detection (cached after first evaluation)
    const decision = evaluate(url);
    if (decision.blocked) {
      return { redirectUrl: buildBlockedUrl(url, decision.reason) };
    }

    return {};
  },
  { urls: ["<all_urls>"], types: ["main_frame"] },
  ["blocking"]
);
