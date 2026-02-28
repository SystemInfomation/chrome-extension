/**
 * PalsPlan Web Protector — background service worker
 *
 * Intercepts main_frame navigation requests and blocks:
 *  1. HTTP (insecure) connections
 *  2. Localhost and loopback addresses
 *  3. Gaming websites (Roblox, Steam, Discord, etc.)
 *  4. Adult/explicit content — detected via keyword/pattern matching on the URL
 *  5. Malicious/suspicious sites — detected via link-shield (offline, heuristic)
 *
 * When a URL is blocked the tab is redirected to the hosted blocked page at
 * https://blocked.palsplan.app with the original URL and block reason encoded
 * as query-string parameters.
 *
 * No external API calls are made during detection — everything is offline.
 *
 * This extension works as a normal Chrome extension and does not require
 * enterprise policy or force-installation.
 */

import { detectSuspiciousLink } from "link-shield";

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────

/** Blocked-page URL (must be internet-accessible and HTTPS). */
const BLOCKED_PAGE_BASE = "https://blocked.palsplan.app";

/**
 * Minimum link-shield risk score that triggers a block.
 * 0–100; 70 = high risk and above (increased to reduce false positives).
 */
const RISK_SCORE_THRESHOLD = 70;

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
 * Comprehensive whitelist of legitimate services to prevent false positives.
 */
const WHITELIST = new Set([
  // Own domains
  "palsplan.app",
  "blocked.palsplan.app",
  
  // Google services
  "google.com",
  "googleapis.com",
  "googleusercontent.com",
  "gstatic.com",
  "gmail.com",
  "youtube.com",
  "googlevideo.com",
  "ytimg.com",
  "google-analytics.com",
  "googletagmanager.com",
  "googlesyndication.com",
  "doubleclick.net",
  "googleadservices.com",
  
  // Microsoft services
  "microsoft.com",
  "live.com",
  "outlook.com",
  "office.com",
  "windows.com",
  "microsoftonline.com",
  "azure.com",
  "bing.com",
  
  // Apple services
  "apple.com",
  "icloud.com",
  "apple-cloudkit.com",
  "cdn-apple.com",
  
  // Amazon services
  "amazon.com",
  "amazonaws.com",
  "cloudfront.net",
  "aws.amazon.com",
  
  // Social media
  "facebook.com",
  "fbcdn.net",
  "instagram.com",
  "twitter.com",
  "twimg.com",
  "x.com",
  "linkedin.com",
  "reddit.com",
  "redd.it",
  "redditstatic.com",
  
  // Developer platforms
  "github.com",
  "githubusercontent.com",
  "gitlab.com",
  "bitbucket.org",
  "stackoverflow.com",
  "stackexchange.com",
  
  // CDNs and cloud services
  "cloudflare.com",
  "akamai.com",
  "fastly.net",
  "cloudinary.com",
  
  // Payment processors
  "paypal.com",
  "stripe.com",
  "square.com",
  
  // Popular websites
  "wikipedia.org",
  "mozilla.org",
  "w3.org",
  "npmjs.com",
  "jquery.com",
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

/**
 * Gaming websites keywords checked against the full lower-cased URL.
 * Blocks access to gaming platforms, browser games, and related sites.
 */
const GAMING_REGEX = new RegExp(
  [
    // Major gaming platforms
    "\\broblox\\b",
    "\\bminecraft\\b",
    "\\bfortnite\\b",
    "\\bsteam\\b",
    "\\bsteampowered\\b",
    "\\bsteamcommunity\\b",
    "\\bepicgames\\b",
    "\\borigin\\b",
    "\\bbattle\\.net\\b",
    "\\bblizzard\\b",
    "\\btwitch\\b",
    "\\bdiscord\\b",
    "\\briotgames\\b",
    "\\bleagueoflegends\\b",
    "\\bvalorant\\b",
    "\\bubisoft\\b",
    "\\bea\\.com\\b",
    "\\bxbox\\b",
    "\\bplaystation\\b",
    "\\bnintendo\\b",
    "\\bgog\\.com\\b",
    "\\bitch\\.io\\b",
    "\\bgamepass\\b",
    "\\brockstargames\\b",
    "\\bactivision\\b",
    "\\bcallofduty\\b",
    "\\bpubg\\b",
    "\\bapexlegends\\b",
    "\\boverwatch\\b",
    "\\bcounters?strike\\b",
    "\\bcsgo\\b",
    "\\bdota\\b",
    "\\bworldofwarcraft\\b",
    "\\bwarcraft\\b",
    "\\bstarcraft\\b",
    // Browser and casual games
    "\\bpoki\\b",
    "\\bkizi\\b",
    "\\bfriv\\b",
    "\\bminiclip\\b",
    "\\baddictinggames\\b",
    "\\bkongregate\\b",
    "\\barmorgames\\b",
    "\\bnewgrounds\\b",
    "\\bflashgames\\b",
    "\\bcrazygames\\b",
    "\\bgameforge\\b",
    "\\by8\\.com\\b",
    "\\bmmo\\b",
    "\\bgaming\\b",
    "\\bplaygame\\b",
    "\\bonlinegame\\b",
    "\\bgames\\.com\\b",
    "\\bgame\\.com\\b",
  ].join("|"),
  "i"
);

/**
 * Personal/social websites keywords checked against the full lower-cased URL.
 * Blocks access to social media, blogs, video sharing, and personal sites.
 */
const PERSONAL_REGEX = new RegExp(
  [
    // Social media platforms
    "\\bfacebook\\b",
    "\\bfb\\.com\\b",
    "\\bfbcdn\\b",
    "\\binstagram\\b",
    "\\btwitter\\b",
    "\\bx\\.com\\b",
    "\\btwimg\\b",
    "\\btiktok\\b",
    "\\bsnapchat\\b",
    "\\bpinterest\\b",
    "\\btumblr\\b",
    "\\bwhatsapp\\b",
    "\\btelegram\\b",
    "\\bviber\\b",
    "\\bweibo\\b",
    "\\bvk\\.com\\b",
    // Video and streaming
    "\\byoutube\\b",
    "\\byoutu\\.be\\b",
    "\\bvimeo\\b",
    "\\bdailymotion\\b",
    "\\bstreaming\\b",
    // Blogging platforms
    "\\bwordpress\\b",
    "\\bblogger\\b",
    "\\bblogspot\\b",
    "\\bmedium\\.com\\b",
    "\\bsubstack\\b",
    "\\bwix\\.com\\b",
    "\\bsquarespace\\b",
    "\\bweebly\\b",
    "\\btumblr\\b",
    "\\bghostcms\\b",
    // Personal sites indicators
    "\\bblog\\b",
    "\\bpersonal\\b",
    "\\bportfolio\\b",
    "\\bmyblog\\b",
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

  // Extract hostname for localhost check
  let hostname;
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch (_e) {
    hostname = "";
  }

  // 1. Block localhost and loopback addresses
  if (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname.startsWith("127.") ||
    hostname.endsWith(".localhost")
  ) {
    decision = { blocked: true, reason: "Localhost Access Blocked" };
  }
  // 2. Block all HTTP (insecure) connections
  else if (url.startsWith("http://")) {
    decision = { blocked: true, reason: "Insecure Connection (HTTP)" };
  }
  // 3. Gaming websites check
  else if (GAMING_REGEX.test(url)) {
    decision = { blocked: true, reason: "Gaming Website Blocked" };
  }
  // 4. Personal/social websites check
  else if (PERSONAL_REGEX.test(url)) {
    decision = { blocked: true, reason: "Personal/Social Website Blocked" };
  }
  // 5. Adult content check (single compiled regex — very fast)
  else if (ADULT_REGEX.test(url)) {
    decision = { blocked: true, reason: "Adult Content" };
  } else {
    // 6. Malicious / suspicious site check (link-shield offline heuristics)
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
 * Intercepts top-level page navigations using webNavigation API.
 * When a URL should be blocked, redirects the tab to the blocked page.
 *
 * This approach works for normal Chrome extensions without requiring
 * enterprise policy or force-installation.
 */
chrome.webNavigation.onBeforeNavigate.addListener(
  function (details) {
    // Only intercept main frame navigations (not iframes)
    if (details.frameId !== 0) {
      return;
    }

    const url = details.url;

    // Ignore non-http(s) schemes (chrome://, chrome-extension://, etc.)
    if (!url.startsWith("http://") && !url.startsWith("https://")) {
      return;
    }

    // Extract hostname for whitelist check
    let hostname;
    try {
      hostname = new URL(url).hostname.toLowerCase();
    } catch (_e) {
      return;
    }

    // Allow whitelisted domains unconditionally
    if (isWhitelisted(hostname)) {
      return;
    }

    // Run detection (cached after first evaluation)
    const decision = evaluate(url);
    if (decision.blocked) {
      // Redirect the tab to the blocked page
      chrome.tabs.update(details.tabId, {
        url: buildBlockedUrl(url, decision.reason),
      });
    }
  },
  { url: [{ schemes: ["http", "https"] }] }
);
