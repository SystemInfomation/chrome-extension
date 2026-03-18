/**
 * PalsPlan Web Protector — background service worker (Family-Safe Mode)
 *
 * Family-safe filtering: allows all general browsing, video games, streaming,
 * social media, etc. Only blocks:
 *  1. Adult / explicit content — keyword/pattern matching on the URL
 *  2. VPN / proxy services — prevents children bypassing the filter
 *  3. Malicious TLDs — TLD registries heavily abused for phishing/malware
 *  4. Domains in the bundled blocklist (RPiList porn + AdGuard Spyware filter)
 *     — 1.1 M domains pre-compiled into blocklist.gz, loaded at startup
 *  5. Known malicious / unsafe site patterns
 *  6. Malicious/suspicious sites — link-shield offline heuristics
 *
 * The blocklist is bundled with the extension (no external network requests).
 * It was compiled from:
 *   - RPiList/specials pornblock1 (adult/explicit domains)
 *   - AdGuard SpywareFilter (spyware/malware domains)
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

// ─────────────────────────────────────────────────────────────────────────────
// Monitoring Configuration — change this to your Render.com URL after deploy
// ─────────────────────────────────────────────────────────────────────────────

/**
 * WebSocket endpoint for the parental monitoring backend.
 * Replace with your actual Render.com URL, e.g.:
 *   "wss://palsplan-monitor.onrender.com/ws"
 */
const MONITOR_WS_URL = "wss://chrome-extension-lwck.onrender.com/ws";

/** Heartbeat interval in milliseconds (keeps the WS connection alive). */
const WS_HEARTBEAT_INTERVAL_MS = 30_000;

/** Maximum reconnect backoff in milliseconds. */
const WS_MAX_BACKOFF_MS = 30_000;

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
 * In-memory set of blocked domains loaded from the bundled blocklist.gz.
 * Contains 1.1 M+ adult, spyware, and malicious domains.
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
 * Custom domains added by the parent via the monitoring dashboard.
 * Persisted in chrome.storage.local under "customFilterDomains".
 * Loaded into this in-memory Set at service-worker startup.
 */
const CUSTOM_FILTER_DOMAINS = new Set();

// Load custom filters from storage on SW startup
chrome.storage.local.get(["customFilterDomains"], (result) => {
  const domains = result.customFilterDomains;
  if (Array.isArray(domains)) {
    for (const d of domains) CUSTOM_FILTER_DOMAINS.add(d);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Monitoring WebSocket
// ─────────────────────────────────────────────────────────────────────────────

let monitorWs          = null;
let wsReconnectTimer   = null;
let wsHeartbeatTimer   = null;
let wsBackoff          = 1000;

// ── Screen stream ──────────────────────────────────────────────────────────
/** Interval (ms) between screenshot captures when screen streaming is active. */
const SCREEN_STREAM_INTERVAL_MS = 2000;

/** Timer reference for periodic screenshot capture. */
let screenStreamTimer = null;

/** True while a screenshot send is in progress — prevents frame pile-up. */
let screenSendInFlight = false;

/**
 * Capture the active tab and send the screenshot to the monitoring backend.
 * Silently ignores errors (e.g. when the active tab is a chrome:// page).
 * Skips the frame if the previous send is still in flight (backpressure).
 */
async function captureAndSendScreenshot() {
  if (screenSendInFlight) return; // skip frame — previous still in transit
  screenSendInFlight = true;
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab || !tab.id) return;
    // Skip extension pages and internal Chrome pages that cannot be captured
    if (!tab.url || tab.url.startsWith("chrome://") || tab.url.startsWith("chrome-extension://")) return;
    const dataUrl = await chrome.tabs.captureVisibleTab(null, { format: "jpeg", quality: 60 });
    wsSend({ type: "screenshot", data: dataUrl, timestamp: Date.now(), url: tab.url, title: tab.title || "" });
  } catch (_e) {
    // Capture may fail if no window is focused or the tab is in an unrenderable state
  } finally {
    screenSendInFlight = false;
  }
}

/** Start periodic screenshot capture and streaming. */
function startScreenStream() {
  if (screenStreamTimer) return; // already running
  captureAndSendScreenshot(); // immediate first frame
  screenStreamTimer = setInterval(captureAndSendScreenshot, SCREEN_STREAM_INTERVAL_MS);
}

/** Stop screenshot capture and streaming. */
function stopScreenStream() {
  clearInterval(screenStreamTimer);
  screenStreamTimer = null;
}

/**
 * Connect to the monitoring backend WebSocket.
 * Auto-reconnects with exponential backoff (capped at WS_MAX_BACKOFF_MS).
 * No-ops if MONITOR_WS_URL still contains the placeholder text.
 */
function connectMonitorWs() {
  if (!MONITOR_WS_URL || MONITOR_WS_URL.trim() === "") {
    console.warn("[PalsPlan] Monitoring disabled: MONITOR_WS_URL is not set.");
    return;
  }

  clearTimeout(wsReconnectTimer);
  clearInterval(wsHeartbeatTimer);

  try {
    monitorWs = new WebSocket(MONITOR_WS_URL + "?role=extension");
  } catch (_e) {
    scheduleWsReconnect();
    return;
  }

  monitorWs.onopen = () => {
    wsBackoff   = 1000; // reset backoff on success
    // Announce the extension is online
    wsSend({ type: "status", status: "online" });
    // Send current custom filters to backend for syncing
    if (CUSTOM_FILTER_DOMAINS.size > 0) {
      wsSend({ type: "filters_sync", filters: Array.from(CUSTOM_FILTER_DOMAINS) });
    }
    // Heartbeat every 30 s to keep connection alive through Render's idle timeout
    wsHeartbeatTimer = setInterval(() => {
      wsSend({ type: "status", status: "online" });
    }, WS_HEARTBEAT_INTERVAL_MS);
    // Update popup connection indicator
    chrome.storage.local.set({ monitorConnected: true });
  };

  monitorWs.onmessage = (event) => {
    let msg;
    try { msg = JSON.parse(event.data); } catch (_e) { return; }

    if (msg.type === "add_filter" && msg.domain) {
      addCustomFilter(msg.domain);
    } else if (msg.type === "remove_filter" && msg.domain) {
      removeCustomFilter(msg.domain);
    } else if (msg.type === "filters_sync" && Array.isArray(msg.filters)) {
      // Full replace from backend (sent on first connect)
      CUSTOM_FILTER_DOMAINS.clear();
      for (const d of msg.filters) CUSTOM_FILTER_DOMAINS.add(d);
      persistCustomFilters();
      urlDecisionCache.clear();
    } else if (msg.type === "start_screen_stream") {
      startScreenStream();
    } else if (msg.type === "stop_screen_stream") {
      stopScreenStream();
    }
  };

  monitorWs.onclose = () => {
    clearInterval(wsHeartbeatTimer);
    stopScreenStream(); // stop sending screenshots when disconnected
    chrome.storage.local.set({ monitorConnected: false });
    scheduleWsReconnect();
  };

  monitorWs.onerror = () => {
    monitorWs.close();
  };
}

function scheduleWsReconnect() {
  const delay  = Math.min(wsBackoff, WS_MAX_BACKOFF_MS);
  wsBackoff    = Math.min(wsBackoff * 2, WS_MAX_BACKOFF_MS);
  wsReconnectTimer = setTimeout(connectMonitorWs, delay);
}

/**
 * Send a JSON payload over the monitoring WebSocket (fire-and-forget).
 * @param {object} payload
 */
function wsSend(payload) {
  if (monitorWs && monitorWs.readyState === WebSocket.OPEN) {
    try { monitorWs.send(JSON.stringify(payload)); } catch (_e) { /* ignore */ }
  }
}

/**
 * Report a navigation event (visit or block) to the monitoring backend.
 *
 * @param {string}           url
 * @param {string}           title
 * @param {"visit"|"blocked"} action
 * @param {string|null}      reason
 */
function reportActivity(url, title, action, reason) {
  wsSend({
    type:      "activity",
    url,
    title:     title || "",
    action,
    reason:    reason || null,
    timestamp: Date.now(),
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Custom Filter Management
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Add a domain to the runtime custom blocklist and persist it.
 * @param {string} domain
 */
function addCustomFilter(domain) {
  const d = domain.trim().toLowerCase().replace(/^www\./, "");
  if (!d) return;
  CUSTOM_FILTER_DOMAINS.add(d);
  persistCustomFilters();
  urlDecisionCache.clear(); // invalidate cache so new rules take effect
}

/**
 * Remove a domain from the runtime custom blocklist and persist it.
 * @param {string} domain
 */
function removeCustomFilter(domain) {
  const d = domain.trim().toLowerCase().replace(/^www\./, "");
  CUSTOM_FILTER_DOMAINS.delete(d);
  persistCustomFilters();
  urlDecisionCache.clear();
}

/**
 * Write CUSTOM_FILTER_DOMAINS to chrome.storage.local so they survive SW restarts.
 */
function persistCustomFilters() {
  chrome.storage.local.set({ customFilterDomains: Array.from(CUSTOM_FILTER_DOMAINS) });
}

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
    "\\bnsfw\\b",
    "\\bmilf\\b",
    "\\bpussy\\b",
    "\\bjizz\\b",
    "\\bxnxx\\b",
    "\\bspankbang\\b",
    "\\bbeeg\\b",
  ].join("|"),
  "i"
);

/**
 * Known VPN and web-proxy service domains.
 * Checked against the request hostname (with parent-domain matching) to
 * prevent children from downloading or signing up to bypass tools.
 */
const VPN_PROXY_DOMAINS = new Set([
  // ── Major VPN providers ──────────────────────────────────────────────────
  "nordvpn.com",
  "expressvpn.com",
  "purevpn.com",
  "surfshark.com",
  "protonvpn.com",
  "hidemyass.com",
  "privateinternetaccess.com",
  "cyberghostvpn.com",
  "ipvanish.com",
  "mullvad.net",
  "torguard.net",
  "vyprvpn.com",
  "hotspotshield.com",
  "windscribe.com",
  "tunnelbear.com",
  "zenmate.com",
  "hide.me",
  "astrill.com",
  "ivpn.net",
  "airvpn.org",
  "ovpn.com",
  "azirevpn.com",
  "vpnsecure.me",
  "safervpn.com",
  "goosevpn.com",
  "perfect-privacy.com",
  "bolehvpn.net",
  "cryptostorm.is",
  "pia.com",
  "ultrasurf.us",
  "psiphon.ca",
  "getlantern.org",
  // ── Web proxy services ───────────────────────────────────────────────────
  "croxyproxy.com",
  "kproxy.com",
  "proxysite.com",
  "4everproxy.com",
  "hidester.com",
  "whoer.net",
  "anonymouse.org",
  "filterbypass.me",
  "unblockasites.com",
  "freeproxyserver.net",
  "webproxy.to",
  "hidemy.name",
  "proxyium.com",
  "youtubeunblocked.live",
  "unblockyt.net",
]);

/**
 * Returns true if the hostname (or any parent) is a known VPN/proxy service.
 *
 * @param {string} hostname
 * @returns {boolean}
 */
function isVpnProxy(hostname) {
  if (VPN_PROXY_DOMAINS.has(hostname)) return true;
  const parts = hostname.split(".");
  for (let i = 1; i < parts.length - 1; i++) {
    if (VPN_PROXY_DOMAINS.has(parts.slice(i).join("."))) return true;
  }
  return false;
}

/**
 * Top-level domains heavily abused for phishing, malware, and spam.
 * These TLDs have extremely high abuse rates and virtually no legitimate
 * consumer use, making them safe to block in a parental-control context.
 */
const MALICIOUS_TLDS = new Set([
  "tk",   // Tokelau — #1 most-abused free TLD
  "ml",   // Mali — free TLD, very high abuse
  "ga",   // Gabon — free TLD, very high abuse
  "cf",   // Central African Republic — free TLD, very high abuse
  "gq",   // Equatorial Guinea — free TLD, very high abuse
  "buzz", // Extremely high phishing/spam rate
  "icu",  // Extremely high phishing/spam rate
  "cyou", // Very high abuse rate
  "cfd",  // Very high phishing rate
  "bond", // Very high abuse rate
  "sbs",  // High phishing rate
  "hair", // Very high abuse rate
  "autos",// Very high abuse rate
  "boats",// Very high abuse rate
]);

/**
 * Returns true if the hostname's TLD is on the malicious-TLD denylist.
 *
 * @param {string} hostname
 * @returns {boolean}
 */
function hasMaliciousTld(hostname) {
  const parts = hostname.split(".");
  if (parts.length < 2) return false;
  const tld = parts[parts.length - 1].toLowerCase();
  return MALICIOUS_TLDS.has(tld);
}

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
 * Returns true if hostname (or any parent domain) is in the parent-defined
 * custom filter list (CUSTOM_FILTER_DOMAINS).
 *
 * @param {string} hostname
 * @returns {boolean}
 */
function isCustomBlocked(hostname) {
  if (CUSTOM_FILTER_DOMAINS.has(hostname)) return true;
  const parts = hostname.split(".");
  for (let i = 1; i < parts.length - 1; i++) {
    if (CUSTOM_FILTER_DOMAINS.has(parts.slice(i).join("."))) return true;
  }
  return false;
}

/**
 * Load the bundled blocklist.gz into BLOCKLIST_DOMAINS.
 *
 * The file is a gzip-compressed newline-separated list of domains compiled at
 * build time from:
 *   - RPiList/specials pornblock1 (~1.1 M adult domains)
 *   - AdGuard SpywareFilter specific section (~181 spyware domains)
 *
 * Uses the Compression Streams API (Chrome 80+) to decompress in a streaming
 * fashion so we never hold the full 29 MB plaintext in memory as one string.
 */
async function loadLocalBlocklist() {
  try {
    const response = await fetch(chrome.runtime.getURL("blocklist.gz"));
    if (!response.ok || !response.body) {
      console.error("[PalsPlan] Could not fetch bundled blocklist:", response.status);
      return;
    }

    const ds = new DecompressionStream("gzip");
    const reader = response.body.pipeThrough(ds).getReader();
    const decoder = new TextDecoder("utf-8");
    let remainder = "";

    BLOCKLIST_DOMAINS.clear();

    while (true) {
      const { done, value } = await reader.read();
      const chunk = done ? "" : decoder.decode(value, { stream: true });
      const text = remainder + chunk;
      const lines = text.split("\n");

      // Hold back the last (possibly incomplete) line for the next iteration
      remainder = done ? "" : (lines.pop() ?? "");

      for (const line of lines) {
        const d = line.trim();
        if (d && d.includes(".")) BLOCKLIST_DOMAINS.add(d);
      }

      if (done) {
        if (remainder) {
          const d = remainder.trim();
          if (d && d.includes(".")) BLOCKLIST_DOMAINS.add(d);
        }
        break;
      }
    }

    urlDecisionCache.clear();
    const size = BLOCKLIST_DOMAINS.size;
    console.warn(`[PalsPlan] Bundled blocklist loaded: ${size.toLocaleString()} domains`);

    // Store metadata so the popup can display blocklist size and load time
    await chrome.storage.local.set({
      blocklistSize: size,
      blocklistUpdatedAt: Date.now(),
    });
  } catch (err) {
    console.error("[PalsPlan] Failed to load bundled blocklist:", err);
  }
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
 *  2. Custom parent-defined filter → block
 *  3. Adult content keyword/pattern match → block
 *  4. VPN / proxy service domain → block
 *  5. Malicious TLD → block
 *  6. Bundled blocklist domain match → block
 *  7. Known malicious patterns → block
 *  8. link-shield offline heuristics → block if high risk
 *
 * HTTP connections are allowed (not blocked).
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
  // 2. Custom parent-defined domain filter
  else if (isCustomBlocked(hostname)) {
    decision = { blocked: true, reason: "Blocked by Parent Filter" };
  }
  // 3. Adult content check (keyword/pattern match on full URL)
  else if (ADULT_REGEX.test(url)) {
    decision = { blocked: true, reason: "Adult Content" };
  }
  // 4. VPN / proxy service check (hostname match)
  else if (isVpnProxy(hostname)) {
    decision = { blocked: true, reason: "VPN/Proxy Service Blocked" };
  }
  // 5. Malicious TLD check
  else if (hasMaliciousTld(hostname)) {
    decision = { blocked: true, reason: "Malicious Domain Blocked" };
  }
  // 6. External blocklist domain check (RPiList porn + AdGuard spyware)
  else if (isBlocklisted(hostname)) {
    decision = { blocked: true, reason: "Blocked by Family-Safe Filter" };
  }
  // 7. Known malicious patterns
  else if (UNSAFE_REGEX.test(url)) {
    decision = { blocked: true, reason: "Malicious Content Blocked" };
  } else {
    // 8. Malicious / suspicious site check (link-shield offline heuristics)
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
      ["blockedTotal", "blockedToday", "blockedTodayDate", "blocklistSize", "blocklistUpdatedAt", "monitorConnected"],
      (result) => {
        const today = new Date().toDateString();
        sendResponse({
          blockedTotal: result.blockedTotal || 0,
          blockedToday: result.blockedTodayDate === today ? (result.blockedToday || 0) : 0,
          blocklistSize: result.blocklistSize || BLOCKLIST_DOMAINS.size || 0,
          blocklistUpdatedAt: result.blocklistUpdatedAt || null,
          version: chrome.runtime.getManifest().version,
          monitorConnected: result.monitorConnected === true,
        });
      }
    );
    return true; // keep the message channel open for async response
  }
});

/**
 * When a URL should be blocked, redirects the tab to the blocked page.
 *
 * Single consolidated listener replaces three separate listeners that
 * previously ran redundant blocking/tracking/cooldown logic independently.
 */
chrome.webNavigation.onBeforeNavigate.addListener(
  function (details) {
    // Only intercept main frame navigations (not iframes)
    if (details.frameId !== 0) return;

    const url = details.url;
    const tabId = details.tabId;

    // Ignore non-http(s) schemes (chrome://, chrome-extension://, etc.)
    if (!url.startsWith("http://") && !url.startsWith("https://")) return;

    // Extract hostname
    let hostname;
    try {
      hostname = new URL(url).hostname.toLowerCase();
    } catch (_e) {
      return;
    }

    // Never re-process the blocked page itself
    if (hostname === new URL(BLOCKED_PAGE_BASE).hostname) return;

    // Allow whitelisted domains unconditionally
    if (isWhitelisted(hostname)) return;

    // Run detection (result is cached after first evaluation)
    const decision = evaluate(url);
    if (decision.blocked) {
      // Track this URL so the onCommitted listener can catch back-button bypasses
      if (!recentlyBlockedUrls.has(tabId)) {
        recentlyBlockedUrls.set(tabId, new Set());
      }
      const blockedSet = recentlyBlockedUrls.get(tabId);
      blockedSet.add(url);
      if (blockedSet.size > MAX_BLOCKED_URLS_PER_TAB) {
        blockedSet.delete(blockedSet.values().next().value);
      }

      // Report blocked navigation to monitoring backend
      reportActivity(url, "", "blocked", decision.reason);

      // Track statistics and redirect
      incrementBlockedCount();
      chrome.tabs.update(tabId, { url: buildBlockedUrl(url, decision.reason) });
    } else {
      // Report allowed navigation to monitoring backend
      reportActivity(url, "", "visit", null);
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
});

/**
 * Initialize the auto-update system on extension installation or update.
 */
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === "install") {
    setupUpdateInterval();
    performUpdateCheck();
    loadLocalBlocklist();
    connectMonitorWs();
  } else if (details.reason === "update") {
    setupUpdateInterval();
    loadLocalBlocklist();
    connectMonitorWs();
  }
});

// On service worker startup, load the bundled blocklist, restore intervals, and connect monitor
chrome.runtime.onStartup.addListener(() => {
  setupUpdateInterval();
  loadLocalBlocklist();
  connectMonitorWs();
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
// Service-worker cold-start: load blocklist and connect monitor on every SW start.
// This handles mid-session SW restarts where onInstalled/onStartup don't fire.
// ─────────────────────────────────────────────────────────────────────────────
loadLocalBlocklist();
connectMonitorWs();
