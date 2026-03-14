/**
 * PalsPlan Web Protector — background service worker (Family-Safe Mode)
 *
 * Family-safe filtering: allows all general browsing, video games, streaming,
 * social media, etc. Only blocks:
 *  1. Adult / explicit content — keyword/pattern matching on the URL
 *  2. Domains in external blocklists (RPiList porn + AdGuard Spyware filter)
 *  3. Known malicious / unsafe site patterns
 *  4. Malicious/suspicious sites — link-shield offline heuristics
 *  5. HTTP (insecure) connections
 *  6. Localhost / loopback addresses
 *  7. Screen capture — blocks getDisplayMedia / screen-sourced getUserMedia
 *     via the content script; notifications are shown here when blocked.
 *
 * External blocklists are fetched on install and refreshed every 6 hours so
 * newly-added domains are picked up quickly.
 *
 * When a URL is blocked the tab is redirected to the hosted blocked page at
 * https://blocked.palsplan.app with the original URL and block reason encoded
 * as query-string parameters.
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
 * GitHub releases URL for extension updates.
 * The extension checks this URL for new versions and notifies users.
 */
const GITHUB_RELEASES_URL = "https://api.github.com/repos/SystemInfomation/cdn-hosting/releases/latest";
const GITHUB_DOWNLOAD_URL = "https://github.com/SystemInfomation/cdn-hosting/releases/latest/download/palsplan-web-protector.zip";

/**
 * Update check interval in seconds.
 */
const UPDATE_CHECK_INTERVAL_SECONDS = 86400; // 24 hours

/**
 * External blocklist sources for the family-safe filter.
 * These are fetched periodically and merged into BLOCKLIST_DOMAINS.
 */
const BLOCKLIST_SOURCES = [
  // RPiList adult/porn domain blocklist (hosts format)
  "https://raw.githubusercontent.com/RPiList/specials/master/Blocklisten/pornblock1",
  // AdGuard Spyware-filter — specific spyware/malware domains (AdBlock syntax)
  "https://raw.githubusercontent.com/AdguardTeam/AdguardFilters/master/SpywareFilter/sections/specific.txt",
];

/**
 * How often (seconds) to re-fetch and merge external blocklists.
 * 6 hours keeps the list current for newly-added domains.
 */
const BLOCKLIST_REFRESH_INTERVAL_SECONDS = 21600; // 6 hours

/**
 * In-memory set of blocked domains populated from BLOCKLIST_SOURCES.
 * Loaded from chrome.storage.local on startup; rebuilt on each refresh.
 */
const BLOCKLIST_DOMAINS = new Set();

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
  
  // Amazon services (AWS kept for developer tools, shopping domains blocked separately)
  "amazonaws.com",
  "cloudfront.net",
  "aws.amazon.com",
  
  // Note: Social media domains removed from whitelist — they are blocked by policy
  
  // Developer platforms
  "github.com",
  "githubusercontent.com",
  "gitlab.com",
  "bitbucket.org",
  "stackoverflow.com",
  "stackexchange.com",
  "vercel.com",
  "render.com",
  
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
 * Known malicious site patterns checked against the full lower-cased URL.
 * Focused on clearly harmful content; broad keywords removed to avoid
 * false positives on legitimate family-safe sites.
 */
const UNSAFE_REGEX = new RegExp(
  [
    // Known exploit/phishing keywords that appear only in malicious domains
    "\\bphishing\\b",
    "\\bmalware\\b",
    "\\bransomware\\b",
    "\\bkeylogger\\b",
    // Known crack/warez distribution sites
    "\\bnulled\\.to\\b",
    "\\bcracked\\.io\\b",
    // Drive-by crypto-mining scripts
    "\\bcoinhive\\.com\\b",
    "\\bcryptojacking\\b",
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
 * Returns true if hostname (or any parent domain) appears in BLOCKLIST_DOMAINS.
 * e.g. "sub.bad-site.com" matches "bad-site.com" if that's in the blocklist.
 *
 * @param {string} hostname
 * @returns {boolean}
 */
function isBlocklisted(hostname) {
  if (BLOCKLIST_DOMAINS.has(hostname)) return true;
  const parts = hostname.split(".");
  for (let i = 1; i < parts.length - 1; i++) {
    if (BLOCKLIST_DOMAINS.has(parts.slice(i).join("."))) return true;
  }
  return false;
}

/**
 * Parse a hosts-format blocklist (RPiList style).
 * Handles lines like:
 *   0.0.0.0 bad-domain.com
 *   127.0.0.1 bad-domain.com
 *   bad-domain.com          (plain domain, no IP)
 * Lines starting with '#' are comments and are ignored.
 *
 * @param {string} text
 * @returns {string[]} array of domain strings
 */
function parseHostsFormat(text) {
  const domains = [];
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    // Remove inline comments
    const noComment = line.split("#")[0].trim();
    const parts = noComment.split(/\s+/);
    let domain;
    if (parts.length >= 2) {
      // "0.0.0.0 domain" or "127.0.0.1 domain" format
      const ip = parts[0];
      if (ip === "0.0.0.0" || ip === "127.0.0.1" || ip === "::1") {
        domain = parts[1].toLowerCase();
      }
    } else if (parts.length === 1) {
      // Plain domain line
      domain = parts[0].toLowerCase();
    }
    if (domain && domain.includes(".") && !domain.startsWith(".")) {
      domains.push(domain);
    }
  }
  return domains;
}

/**
 * Parse an AdGuard/uBlock-format filter list.
 * Extracts domain-blocking rules in the form ||domain.com^ (with optional
 * option suffixes after ^).  Comment lines (! or #) are ignored.
 *
 * @param {string} text
 * @returns {string[]} array of domain strings
 */
function parseAdguardFormat(text) {
  const domains = [];
  // Matches lines like: ||domain.com^ or ||domain.com^$options
  const ruleRe = /^\|\|([a-z0-9._-]+)\^/i;
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("!") || line.startsWith("#")) continue;
    const m = ruleRe.exec(line);
    if (m) {
      domains.push(m[1].toLowerCase());
    }
  }
  return domains;
}

/**
 * Fetch a single blocklist URL, auto-detect its format, and return parsed domains.
 *
 * @param {string} url
 * @returns {Promise<string[]>}
 */
async function fetchBlocklist(url) {
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: { "User-Agent": "PalsPlan-Web-Protector" },
      cache: "no-store",
    });
    if (!response.ok) {
      console.warn(`[PalsPlan] Blocklist fetch failed for ${url}: HTTP ${response.status}`);
      return [];
    }
    const text = await response.text();
    // Detect format: AdGuard lists use ||domain^ syntax; hosts lists use IP + domain
    const isAdguard = text.includes("||") && text.includes("^");
    return isAdguard ? parseAdguardFormat(text) : parseHostsFormat(text);
  } catch (err) {
    console.warn(`[PalsPlan] Blocklist fetch error for ${url}:`, err);
    return [];
  }
}

/**
 * Fetch all BLOCKLIST_SOURCES, merge into BLOCKLIST_DOMAINS, and persist to
 * chrome.storage.local so the list survives service-worker restarts.
 */
async function refreshBlocklists() {
  console.warn("[PalsPlan] Refreshing family-safe blocklists…");
  const allDomains = [];
  for (const src of BLOCKLIST_SOURCES) {
    const domains = await fetchBlocklist(src);
    allDomains.push(...domains);
  }

  // Rebuild the in-memory Set
  BLOCKLIST_DOMAINS.clear();
  for (const d of allDomains) {
    BLOCKLIST_DOMAINS.add(d);
  }

  // Invalidate the URL decision cache so newly-blocked domains take effect
  urlDecisionCache.clear();

  const now = Date.now();
  await chrome.storage.local.set({
    blocklistDomains: allDomains,
    blocklistUpdatedAt: now,
  });

  console.warn(`[PalsPlan] Blocklist updated: ${BLOCKLIST_DOMAINS.size} domains (${new Date(now).toISOString()})`);
}

/**
 * Load the previously-cached blocklist from chrome.storage.local into memory.
 * Called once on service-worker startup so filtering is immediate.
 */
async function loadBlocklistFromStorage() {
  return new Promise((resolve) => {
    chrome.storage.local.get(["blocklistDomains", "blocklistUpdatedAt"], (result) => {
      const domains = result.blocklistDomains;
      if (Array.isArray(domains) && domains.length > 0) {
        BLOCKLIST_DOMAINS.clear();
        for (const d of domains) BLOCKLIST_DOMAINS.add(d);
        console.warn(`[PalsPlan] Loaded ${BLOCKLIST_DOMAINS.size} blocklist domains from storage (last updated ${new Date(result.blocklistUpdatedAt || 0).toISOString()})`);
      }
      resolve();
    });
  });
}

/**
 * Set up the periodic blocklist refresh alarm (every 6 hours).
 */
function setupBlocklistRefresh() {
  chrome.alarms.create("blocklistRefresh", {
    delayInMinutes: 1,
    periodInMinutes: BLOCKLIST_REFRESH_INTERVAL_SECONDS / 60,
  });
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
 * Family-safe rules (in order):
 *  1. Localhost / loopback → block
 *  2. HTTP (insecure) → block
 *  3. Adult content keyword/pattern match → block
 *  4. Blocklist domain match (external RPiList/AdGuard lists) → block
 *  5. Known malicious patterns → block
 *  6. link-shield offline heuristics → block if high risk
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

  // Extract hostname for checks
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
  // 3. Adult content check (keyword/pattern match on full URL)
  else if (ADULT_REGEX.test(url)) {
    decision = { blocked: true, reason: "Adult Content" };
  }
  // 4. External blocklist domain check (RPiList porn + AdGuard spyware)
  else if (isBlocklisted(hostname)) {
    decision = { blocked: true, reason: "Blocked by Family-Safe Filter" };
  }
  // 5. Known malicious patterns
  else if (UNSAFE_REGEX.test(url)) {
    decision = { blocked: true, reason: "Malicious Content Blocked" };
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
// Statistics
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Increment the lifetime and today's blocked-navigation counters stored in
 * chrome.storage.local.  Lightweight — uses a read-modify-write pattern.
 */
function incrementBlockedCount() {
  chrome.storage.local.get(["blockedTotal", "blockedToday", "blockedTodayDate"], (result) => {
    const today = new Date().toDateString();
    const wasToday = result.blockedTodayDate === today;
    chrome.storage.local.set({
      blockedTotal: (result.blockedTotal || 0) + 1,
      blockedToday: wasToday ? (result.blockedToday || 0) + 1 : 1,
      blockedTodayDate: today,
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Popup message handler
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Responds to GET_STATS messages from the popup with current protection stats.
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "GET_STATS") {
    chrome.storage.local.get(
      ["blockedTotal", "blockedToday", "blockedTodayDate", "blocklistDomains", "blocklistUpdatedAt"],
      (result) => {
        const today = new Date().toDateString();
        sendResponse({
          blockedTotal: result.blockedTotal || 0,
          blockedToday: result.blockedTodayDate === today ? (result.blockedToday || 0) : 0,
          blocklistSize: Array.isArray(result.blocklistDomains) ? result.blocklistDomains.length : 0,
          blocklistUpdatedAt: result.blocklistUpdatedAt || null,
          version: chrome.runtime.getManifest().version,
        });
      }
    );
    return true; // keep the message channel open for async response
  }
});

/**
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
      // Track blocked-navigation statistics
      incrementBlockedCount();
      // Redirect the tab to the blocked page
      chrome.tabs.update(details.tabId, {
        url: buildBlockedUrl(url, decision.reason),
      });
    }
  },
  { url: [{ schemes: ["http", "https"] }] }
);

// ─────────────────────────────────────────────────────────────────────────────
// Auto-Update System
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Checks GitHub releases for a new version of the extension.
 * Compares the current version with the latest release version.
 * 
 * @returns {Promise<{hasUpdate: boolean, latestVersion: string, downloadUrl: string}>}
 */
async function checkForUpdates() {
  try {
    const manifest = chrome.runtime.getManifest();
    const currentVersion = manifest.version;
    
    // Fetch the latest release info from GitHub API
    const response = await fetch(GITHUB_RELEASES_URL, {
      method: "GET",
      headers: {
        "Accept": "application/vnd.github+json",
        "User-Agent": "PalsPlan-Web-Protector"
      },
      // Use cache with a reasonable max-age to avoid rate limits
      cache: "default"
    });
    
    if (!response.ok) {
      console.warn(`Update check failed: HTTP ${response.status}`);
      return { hasUpdate: false, latestVersion: currentVersion, downloadUrl: "" };
    }
    
    const releaseData = await response.json();
    const latestVersion = releaseData.tag_name || releaseData.name || currentVersion;
    
    // Remove 'v' prefix if present for comparison
    const cleanLatest = latestVersion.replace(/^v/, "");
    const cleanCurrent = currentVersion.replace(/^v/, "");
    
    // Simple version comparison (assumes semver format)
    const hasUpdate = compareVersions(cleanLatest, cleanCurrent) > 0;
    
    return {
      hasUpdate,
      latestVersion: cleanLatest,
      downloadUrl: GITHUB_DOWNLOAD_URL,
      releaseNotes: releaseData.body || "New version available"
    };
  } catch (error) {
    console.error("Error checking for updates:", error);
    return { hasUpdate: false, latestVersion: "", downloadUrl: "" };
  }
}

/**
 * Compares two semantic version strings.
 * 
 * @param {string} v1 - First version (e.g., "1.2.3")
 * @param {string} v2 - Second version (e.g., "1.2.0")
 * @returns {number} - Returns 1 if v1 > v2, -1 if v1 < v2, 0 if equal
 */
function compareVersions(v1, v2) {
  const parsePart = (p) => { const n = parseInt(p, 10); return isNaN(n) ? 0 : n; };
  const parts1 = v1.split(".").map(parsePart);
  const parts2 = v2.split(".").map(parsePart);
  
  for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
    const part1 = parts1[i] || 0;
    const part2 = parts2[i] || 0;
    
    if (part1 > part2) return 1;
    if (part1 < part2) return -1;
  }
  
  return 0;
}

/**
 * Notifies the user about available updates.
 * 
 * @param {string} version - The new version available
 * @param {string} downloadUrl - URL to download the update
 */
function notifyUpdate(version, downloadUrl) {
  chrome.notifications.create({
    type: "basic",
    title: "PalsPlan Web Protector Update Available",
    message: `Version ${version} is available. Click to download.`,
    priority: 2,
    requireInteraction: true,
    buttons: [
      { title: "Download Update" }
    ]
  }, (notificationId) => {
    // Store the download URL for later use
    chrome.storage.local.set({ 
      [`update_${notificationId}`]: downloadUrl,
      lastUpdateCheck: Date.now(),
      latestVersion: version
    });
  });
}

/**
 * Handles notification button clicks.
 */
chrome.notifications.onButtonClicked.addListener((notificationId, buttonIndex) => {
  if (buttonIndex === 0) {
    // User clicked "Download Update"
    chrome.storage.local.get([`update_${notificationId}`], (result) => {
      const downloadUrl = result[`update_${notificationId}`];
      if (downloadUrl) {
        // Open the download URL in a new tab
        chrome.tabs.create({ url: downloadUrl });
        chrome.notifications.clear(notificationId);
      }
    });
  }
});

/**
 * Handles notification clicks (clicking the notification body).
 */
chrome.notifications.onClicked.addListener((notificationId) => {
  chrome.storage.local.get([`update_${notificationId}`], (result) => {
    const downloadUrl = result[`update_${notificationId}`];
    if (downloadUrl) {
      chrome.tabs.create({ url: downloadUrl });
      chrome.notifications.clear(notificationId);
    }
  });
});

/**
 * Performs the update check and notifies the user if an update is available.
 */
async function performUpdateCheck() {
  const updateInfo = await checkForUpdates();
  
  if (updateInfo.hasUpdate) {
    notifyUpdate(updateInfo.latestVersion, updateInfo.downloadUrl);
  } else {
    // Store the last check time
    chrome.storage.local.set({ lastUpdateCheck: Date.now() });
  }
}

/**
 * Sets up the periodic update check using setInterval.
 * Uses setInterval instead of chrome.alarms to support sub-minute intervals.
 * Also creates a fallback alarm to recover checks after service worker restarts.
 */
function setupUpdateInterval() {
  // Clear any existing interval to avoid duplicates
  if (globalThis._updateIntervalId) {
    clearInterval(globalThis._updateIntervalId);
  }
  globalThis._updateIntervalId = setInterval(() => {
    performUpdateCheck();
  }, UPDATE_CHECK_INTERVAL_SECONDS * 1000);

  // Fallback alarm to restart interval after service worker wakes
  chrome.alarms.create("updateCheck", {
    delayInMinutes: 1,
    periodInMinutes: 1440 // 24 hours
  });
}

/**
 * Handles alarm events — restarts the setInterval after service worker wake.
 */
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "updateCheck") {
    // Re-establish the setInterval if it was lost during SW sleep
    if (!globalThis._updateIntervalId) {
      setupUpdateInterval();
    }
    performUpdateCheck();
  }
  if (alarm.name === "blocklistRefresh") {
    refreshBlocklists();
  }
});

/**
 * Initialize the auto-update system on extension installation or update.
 */
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === "install") {
    setupUpdateInterval();
    setupBlocklistRefresh();
    // Perform an immediate check after installation
    performUpdateCheck();
    refreshBlocklists();
  } else if (details.reason === "update") {
    setupUpdateInterval();
    setupBlocklistRefresh();
    refreshBlocklists();
  }
});

// On service worker startup, load cached blocklist and ensure intervals are set
chrome.runtime.onStartup.addListener(() => {
  setupUpdateInterval();
  setupBlocklistRefresh();
  loadBlocklistFromStorage();
});

// ─────────────────────────────────────────────────────────────────────────────
// Bypass Prevention & Security Monitoring
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Tracks recently blocked URLs to prevent back button bypass attempts.
 * Maps tabId → Set of blocked URLs.
 */
const recentlyBlockedUrls = new Map();

/**
 * Maximum number of blocked URLs to track per tab.
 */
const MAX_BLOCKED_URLS_PER_TAB = 50;

/**
 * Enhanced blocking that prevents back button bypasses.
 * Tracks blocked URLs per tab and re-blocks if user tries to navigate back.
 */
chrome.webNavigation.onCommitted.addListener((details) => {
  // Only handle main frame navigation
  if (details.frameId !== 0) return;
  
  const tabId = details.tabId;
  const url = details.url;
  
  // Check if this URL was recently blocked for this tab
  const blockedSet = recentlyBlockedUrls.get(tabId);
  if (blockedSet && blockedSet.has(url)) {
    // User is trying to navigate back to a blocked URL
    // Re-evaluate and block again
    const decision = evaluate(url);
    if (decision.blocked) {
      chrome.tabs.update(tabId, {
        url: buildBlockedUrl(url, decision.reason),
      });
    }
  }
});

/**
 * Track blocked URLs when we redirect to the blocked page.
 * This listener enhances the existing blocking logic to prevent back button bypasses.
 */
chrome.webNavigation.onBeforeNavigate.addListener(
  function (details) {
    // Only intercept main frame navigations
    if (details.frameId !== 0) return;

    const url = details.url;
    const tabId = details.tabId;

    // Ignore non-http(s) schemes
    if (!url.startsWith("http://") && !url.startsWith("https://")) return;

    // Don't re-block the blocked page itself - use proper hostname check
    try {
      const urlObj = new URL(url);
      if (urlObj.hostname === new URL(BLOCKED_PAGE_BASE).hostname) return;
    } catch (_e) {
      // If URL parsing fails, continue with blocking logic
    }

    // Extract hostname for whitelist check
    let hostname;
    try {
      hostname = new URL(url).hostname.toLowerCase();
    } catch (_e) {
      return;
    }

    // Allow whitelisted domains
    if (isWhitelisted(hostname)) return;

    // Run detection
    const decision = evaluate(url);
    if (decision.blocked) {
      // Track this blocked URL for this tab
      if (!recentlyBlockedUrls.has(tabId)) {
        recentlyBlockedUrls.set(tabId, new Set());
      }
      const blockedSet = recentlyBlockedUrls.get(tabId);
      blockedSet.add(url);
      
      // Limit the size of tracked URLs
      if (blockedSet.size > MAX_BLOCKED_URLS_PER_TAB) {
        const firstUrl = blockedSet.values().next().value;
        blockedSet.delete(firstUrl);
      }
    }
  },
  { url: [{ schemes: ["http", "https"] }] }
);

/**
 * Clean up tracking data when tab is closed.
 */
chrome.tabs.onRemoved.addListener((tabId) => {
  recentlyBlockedUrls.delete(tabId);
});

/**
 * Monitor for extension being disabled and warn the user.
 * This helps detect if someone tries to disable the extension.
 */
chrome.management.onEnabled.addListener((info) => {
  if (info.id === chrome.runtime.id) {
    // Extension was re-enabled - set up monitoring again
    setupUpdateInterval();
  }
});

chrome.management.onDisabled.addListener((info) => {
  if (info.id === chrome.runtime.id) {
    // Extension is being disabled - attempt to warn
    // Note: Service worker will be terminated, so this may not always work
    chrome.notifications.create({
      type: "basic",
      title: "PalsPlan Web Protector Disabled",
      message: "Warning: Web protection has been disabled. Your browsing is no longer protected.",
      priority: 2,
      requireInteraction: true
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Screen Capture Protection
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Handles screen-capture-blocked events relayed by the content script.
 * Shows a Chrome notification whenever a page attempts to use the
 * Screen Capture API (getDisplayMedia / getUserMedia with a screen source).
 */
chrome.runtime.onMessage.addListener((message, sender) => {
  if (message.type !== "SCREEN_CAPTURE_BLOCKED") return;

  // Only handle messages that originate from our own extension's content scripts.
  if (!sender || sender.id !== chrome.runtime.id) return;

  let hostname = message.url || "unknown page";
  try {
    hostname = new URL(message.url).hostname;
  } catch (_e) {
    // fall back to the raw URL string
  }

  chrome.notifications.create({
    type: "basic",
    title: "Screen Capture Blocked",
    message: `PalsPlan Web Protector blocked a screen recording attempt on ${hostname}.`,
    priority: 2,
  });
});

/**
 * Detect and prevent attempts to navigate away from the blocked page too quickly.
 * This prevents users from quickly hitting back/forward to bypass the block.
 */
const blockTimestamps = new Map();
/**
 * Minimum time (in milliseconds) that must pass between blocking events.
 * Prevents users from rapidly navigating away from blocked pages to bypass protection.
 */
const RAPID_NAVIGATION_COOLDOWN_MS = 2000; // 2 seconds

chrome.webNavigation.onBeforeNavigate.addListener(
  function (details) {
    if (details.frameId !== 0) return;
    
    const url = details.url;
    const tabId = details.tabId;
    
    // Check if we're navigating to the blocked page - use proper hostname check
    try {
      const urlObj = new URL(url);
      const blockedPageHost = new URL(BLOCKED_PAGE_BASE).hostname;
      if (urlObj.hostname === blockedPageHost) {
        blockTimestamps.set(tabId, Date.now());
        return;
      }
    } catch (_e) {
      // If URL parsing fails, continue
    }
    
    // If user navigates away from blocked page within cooldown period
    const lastBlockTime = blockTimestamps.get(tabId);
    if (lastBlockTime && Date.now() - lastBlockTime < RAPID_NAVIGATION_COOLDOWN_MS) {
      // Re-evaluate the URL they're trying to visit
      let hostname;
      try {
        hostname = new URL(url).hostname.toLowerCase();
      } catch (_e) {
        return;
      }
      
      if (!isWhitelisted(hostname)) {
        const decision = evaluate(url);
        if (decision.blocked) {
          // Block again and reset the timestamp
          chrome.tabs.update(tabId, {
            url: buildBlockedUrl(url, decision.reason),
          });
          blockTimestamps.set(tabId, Date.now());
        }
      }
    }
  },
  { url: [{ schemes: ["http", "https"] }] }
);

/**
 * Periodic integrity check to ensure the extension is functioning properly.
 * Runs every hour to verify critical components are active.
 */
chrome.alarms.create("integrityCheck", {
  periodInMinutes: 60
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "integrityCheck") {
    // Verify extension is enabled
    chrome.management.getSelf((info) => {
      if (!info.enabled) {
        console.warn("Extension is disabled - protection not active");
      }
    });
    
    // Verify listeners are still active
    const hasNavigationListeners = chrome.webNavigation.onBeforeNavigate.hasListeners();
    if (!hasNavigationListeners) {
      console.error("Critical: Navigation listeners are not active!");
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Service-worker cold-start: load cached blocklist into memory immediately
// ─────────────────────────────────────────────────────────────────────────────
loadBlocklistFromStorage();
