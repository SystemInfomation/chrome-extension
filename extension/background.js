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
 * GitHub releases URL for extension updates.
 * The extension checks this URL for new versions and notifies users.
 */
const GITHUB_RELEASES_URL = "https://api.github.com/repos/SystemInfomation/cdn-hosting/releases/latest";
const GITHUB_DOWNLOAD_URL = "https://github.com/SystemInfomation/cdn-hosting/releases/latest/download/palsplan-web-protector.zip";

/**
 * Update check interval in seconds.
 */
const UPDATE_CHECK_INTERVAL_SECONDS = 5;

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
 * Gaming websites keywords checked against the full lower-cased URL.
 * Blocks access to gaming platforms, browser games, and related sites.
 */
const GAMING_REGEX = new RegExp(
  [
    // Major gaming platforms
    "\\broblox\\.com\\b",
    "\\bminecraft\\.net\\b",
    "\\bfortnite\\.com\\b",
    "\\bsteampowered\\.com\\b",
    "\\bsteamcommunity\\.com\\b",
    "\\bepicgames\\.com\\b",
    "\\borigin\\.com\\b",
    "\\bbattle\\.net\\b",
    "\\bblizzard\\.com\\b",
    "\\btwitch\\.tv\\b",
    "\\bdiscord\\.com\\b",
    "\\bdiscord\\.gg\\b",
    "\\briotgames\\.com\\b",
    "\\bleagueoflegends\\.com\\b",
    "\\bvalorant\\.com\\b",
    "\\bubisoft\\.com\\b",
    "\\bea\\.com\\b",
    "\\bxbox\\.com\\b",
    "\\bplaystation\\.com\\b",
    "\\bnintendo\\.com\\b",
    "\\bgog\\.com\\b",
    "\\bitch\\.io\\b",
    "\\brockstargames\\.com\\b",
    "\\bactivision\\.com\\b",
    "\\bcallofduty\\.com\\b",
    "\\bpubg\\.com\\b",
    "\\bapexlegends\\.com\\b",
    // Browser and casual games
    "\\bpoki\\.com\\b",
    "\\bkizi\\.com\\b",
    "\\bfriv\\.com\\b",
    "\\bminiclip\\.com\\b",
    "\\baddictinggames\\.com\\b",
    "\\bkongregate\\.com\\b",
    "\\barmorgames\\.com\\b",
    "\\bnewgrounds\\.com\\b",
    "\\bcrazygames\\.com\\b",
    "\\bgameforge\\.com\\b",
    "\\by8\\.com\\b",
  ].join("|"),
  "i"
);

/**
 * Personal/social websites keywords checked against the full lower-cased URL.
 * Blocks access to social media, messaging, blogs, and personal sites.
 */
const PERSONAL_REGEX = new RegExp(
  [
    // Major social media platforms
    "\\bfb\\.com\\b",
    "\\bfbcdn\\b",
    "\\btwitter\\.com\\b",
    "\\btwimg\\b",
    "\\btumblr\\.com\\b",
    "\\breddit\\.com\\b",
    "\\bredd\\.it\\b",
    "\\bredditstatic\\.com\\b",
    "\\blinkedin\\.com\\b",
    "\\bweibo\\.com\\b",
    "\\bvk\\.com\\b",
    "\\bthreads\\.net\\b",
    "\\bmastodon\\.social\\b",
    "\\bmastodon\\.online\\b",
    "\\bbereal\\.com\\b",
    "\\blemon8-app\\.com\\b",
    "\\btruth social\\b",
    "\\btruthsocial\\.com\\b",
    "\\bparler\\.com\\b",
    "\\bgab\\.com\\b",
    "\\bgettr\\.com\\b",
    "\\bclubhouse\\.com\\b",
    "\\bmewe\\.com\\b",
    "\\bmyspace\\.com\\b",
    "\\bask\\.fm\\b",
    "\\bcuriouscat\\.me\\b",
    "\\bquora\\.com\\b",
    // Messaging platforms
    "\\bwhatsapp\\.com\\b",
    "\\btelegram\\.org\\b",
    "\\btelegram\\.me\\b",
    "\\bviber\\.com\\b",
    "\\bsignal\\.org\\b",
    "\\bwechat\\.com\\b",
    "\\bweixin\\.qq\\.com\\b",
    "\\bline\\.me\\b",
    "\\bkik\\.com\\b",
    "\\bwickr\\.com\\b",
    "\\belement\\.io\\b",
    "\\bslack\\.com\\b",
    // Blogging and personal website platforms
    "\\bblogger\\.com\\b",
    "\\bblogspot\\.com\\b",
    "\\bmedium\\.com\\b",
    "\\bsubstack\\.com\\b",
    "\\bwix\\.com\\b",
    "\\bsquarespace\\.com\\b",
    "\\bweebly\\.com\\b",
    "\\bwordpress\\.com\\b",
    "\\blivejournal\\.com\\b",
    "\\bdeviantart\\.com\\b",
    // Forums and communities
    "\\b4chan\\.org\\b",
    "\\b8chan\\b",
    "\\b8kun\\b",
    "\\bvoat\\b",
    "\\bimgur\\.com\\b",
    "\\b9gag\\.com\\b",
    "\\bifunny\\.co\\b",
    "\\bfunnyjunk\\.com\\b",
  ].join("|"),
  "i"
);

/**
 * Video streaming and entertainment sites.
 * Blocks access to streaming platforms that waste productivity.
 */
const STREAMING_REGEX = new RegExp(
  [
    // Video streaming
    "\\byoutube\\.com\\b",
    "\\byoutu\\.be\\b",
    "\\bvimeo\\.com\\b",
    "\\bdailymotion\\.com\\b",
    "\\bnetflix\\.com\\b",
    "\\bhulu\\.com\\b",
    "\\bdisneyplus\\.com\\b",
    "\\bhbomax\\.com\\b",
    "\\bmax\\.com\\b",
    "\\bparamountplus\\.com\\b",
    "\\bpeacocktv\\.com\\b",
    "\\bcrunchyroll\\.com\\b",
    "\\bfunimation\\.com\\b",
    "\\bpluto\\.tv\\b",
    "\\btubi\\.tv\\b",
    "\\bprimevideo\\.com\\b",
    "\\bappletv\\.com\\b",
    "\\broku\\.com\\b",
    "\\bsling\\.com\\b",
    "\\bfubo\\.tv\\b",
    "\\bphilo\\.com\\b",
    "\\bespn\\.com\\b",
    "\\bdazn\\.com\\b",
    "\\bbitchute\\.com\\b",
    "\\brumble\\.com\\b",
    "\\bodysee\\.com\\b",
    // Music streaming
    "\\bsoundcloud\\.com\\b",
    "\\bpandora\\.com\\b",
    "\\bdeezer\\.com\\b",
    "\\btidal\\.com\\b",
    "\\blast\\.fm\\b",
    "\\bbandcamp\\.com\\b",
    // Podcast platforms
    "\\bpodbean\\.com\\b",
    "\\bstitcher\\.com\\b",
    "\\bovercast\\.fm\\b",
    "\\banchor\\.fm\\b",
  ].join("|"),
  "i"
);

/**
 * Online shopping sites.
 * Blocks access to e-commerce platforms during work hours.
 */
const SHOPPING_REGEX = new RegExp(
  [
    "\\bamazon\\.com\\b",
    "\\bamazon\\.co\\b",
    "\\bebay\\.com\\b",
    "\\betsy\\.com\\b",
    "\\bwalmart\\.com\\b",
    "\\btarget\\.com\\b",
    "\\bbestbuy\\.com\\b",
    "\\baliexpress\\.com\\b",
    "\\bwish\\.com\\b",
    "\\bshein\\.com\\b",
    "\\btemu\\.com\\b",
    "\\bwayfair\\.com\\b",
    "\\boverstock\\.com\\b",
    "\\bnewegg\\.com\\b",
    "\\bdhgate\\.com\\b",
    "\\bbanggood\\.com\\b",
    "\\bgearbest\\.com\\b",
    "\\bzappos\\.com\\b",
    "\\basos\\.com\\b",
    "\\bzara\\.com\\b",
    "\\bhm\\.com\\b",
    "\\bnordstrom\\.com\\b",
    "\\bmacys\\.com\\b",
    "\\bcostco\\.com\\b",
    "\\bhomedepot\\.com\\b",
    "\\blowes\\.com\\b",
    "\\bikea\\.com\\b",
    "\\bposhmark\\.com\\b",
    "\\bmercari\\.com\\b",
    "\\bofferup\\.com\\b",
    "\\bcraigslist\\.org\\b",
    "\\bfacebookmarketplace\\b",
    "\\bgroupon\\.com\\b",
    "\\bslickdeals\\.net\\b",
    "\\bdealnews\\.com\\b",
    "\\bretailmenot\\.com\\b",
    "\\bhoney\\.com\\b",
  ].join("|"),
  "i"
);

/**
 * Gambling and betting sites.
 * Blocks access to gambling platforms, sports betting, and lottery sites.
 */
const GAMBLING_REGEX = new RegExp(
  [
    "\\bbet365\\.com\\b",
    "\\bdraftkings\\.com\\b",
    "\\bfanduel\\.com\\b",
    "\\bbetmgm\\.com\\b",
    "\\bcaesars\\.com\\b",
    "\\bpointsbet\\.com\\b",
    "\\bbovada\\.lv\\b",
    "\\bbetonline\\.ag\\b",
    "\\b888casino\\.com\\b",
    "\\b888poker\\.com\\b",
    "\\bpokerstars\\.com\\b",
    "\\bpartypoker\\.com\\b",
    "\\bwilliamhill\\.com\\b",
    "\\bbetfair\\.com\\b",
    "\\bpaddy ?power\\b",
    "\\bbwin\\.com\\b",
    "\\bunibet\\.com\\b",
    "\\bbetway\\.com\\b",
    "\\b1xbet\\.com\\b",
    "\\b22bet\\.com\\b",
    "\\bstake\\.com\\b",
    "\\bcasinoguru\\b",
    "\\bonlinecasino\\b",
    "\\bslotmachine\\b",
    "\\bjackpotcity\\.com\\b",
    "\\bspinpalace\\.com\\b",
    "\\broyal ?vegas\\b",
    "\\bcasino\\.com\\b",
    "\\bpoker\\.com\\b",
    "\\bbingo\\.com\\b",
    "\\blottery\\b",
    "\\bgambling\\b",
    "\\bsportsbook\\b",
    "\\bbetting\\b",
    "\\bfanatics\\.com\\/sportsbook\\b",
    "\\bhard ?rock ?bet\\b",
  ].join("|"),
  "i"
);

/**
 * Dating platforms.
 * Blocks access to dating and matchmaking websites.
 */
const DATING_REGEX = new RegExp(
  [
    "\\btinder\\.com\\b",
    "\\bbumble\\.com\\b",
    "\\bmatch\\.com\\b",
    "\\bokcupid\\.com\\b",
    "\\bplentyoffish\\.com\\b",
    "\\bpof\\.com\\b",
    "\\bhinge\\.co\\b",
    "\\bcoffee ?meets ?bagel\\b",
    "\\bgrindr\\.com\\b",
    "\\bher\\.com\\b",
    "\\beharmony\\.com\\b",
    "\\bzoosk\\.com\\b",
    "\\belitesingles\\.com\\b",
    "\\bsilversingles\\.com\\b",
    "\\bourtime\\.com\\b",
    "\\bchristianmingle\\.com\\b",
    "\\bjdate\\.com\\b",
    "\\bbadoo\\.com\\b",
    "\\bskout\\.com\\b",
    "\\btagged\\.com\\b",
    "\\bhappn\\.com\\b",
    "\\blovoo\\.com\\b",
    "\\bmeetic\\.com\\b",
    "\\bsugarbook\\b",
    "\\bseeking\\.com\\b",
    "\\bashleymadison\\.com\\b",
  ].join("|"),
  "i"
);

/**
 * VPN/proxy/circumvention tools.
 * Blocks access to services designed to bypass content filters.
 */
const VPNPROXY_REGEX = new RegExp(
  [
    // VPN providers
    "\\bnordvpn\\.com\\b",
    "\\bexpressvpn\\.com\\b",
    "\\bsurfshark\\.com\\b",
    "\\bcyberghostvpn\\.com\\b",
    "\\bprivateinternetaccess\\.com\\b",
    "\\bprotonvpn\\.com\\b",
    "\\bipvanish\\.com\\b",
    "\\bwindscribe\\.com\\b",
    "\\bmullvad\\.net\\b",
    "\\bhotspotshield\\.com\\b",
    "\\btunnelbear\\.com\\b",
    "\\bhide\\.me\\b",
    "\\bpurevpn\\.com\\b",
    "\\bvypr vpn\\b",
    "\\bvyprvpn\\.com\\b",
    "\\batlasvpn\\.com\\b",
    "\\bzenmate\\.com\\b",
    // Proxy and anonymization services
    "\\bhidemyass\\.com\\b",
    "\\bkproxy\\.com\\b",
    "\\bproxysite\\.com\\b",
    "\\bunblocksite\\b",
    "\\bfreeproxy\\b",
    "\\bwebproxy\\b",
    "\\banonymouse\\.org\\b",
    "\\bhideipvpn\\.com\\b",
    "\\btorproject\\.org\\b",
    "\\btorbrowser\\b",
    "\\bpsiphon\\b",
    "\\blantern\\.io\\b",
    "\\bultrasurf\\b",
    "\\bfreegate\\b",
    "\\bhotspot ?shield\\b",
    // DNS bypass tools
    "\\bnextdns\\.io\\b",
    "\\bcloudflare-dns\\.com\\b",
    "\\bdns-over-https\\b",
  ].join("|"),
  "i"
);

/**
 * Known malicious, phishing, and unsafe sites by pattern.
 * Also blocks URL shorteners (often used to disguise malicious links) and
 * risky file-sharing services.
 */
const UNSAFE_REGEX = new RegExp(
  [
    // URL shorteners (commonly used to hide malicious links)
    "\\bbit\\.ly\\b",
    "\\btinyurl\\.com\\b",
    "\\bgoo\\.gl\\b",
    "\\bt\\.co\\b",
    "\\brebrand\\.ly\\b",
    "\\bshorturl\\.at\\b",
    "\\bow\\.ly\\b",
    "\\bis\\.gd\\b",
    "\\bv\\.gd\\b",
    "\\bcutt\\.ly\\b",
    "\\badf\\.ly\\b",
    "\\bbit\\.do\\b",
    "\\bclck\\.ru\\b",
    // Risky file-sharing / piracy / warez
    "\\bthepiratebay\\b",
    "\\b1337x\\.to\\b",
    "\\brarbg\\b",
    "\\bkickass ?torrent\\b",
    "\\byts\\.mx\\b",
    "\\bnyaa\\.si\\b",
    "\\blimetorrent\\b",
    "\\btorrentz2\\b",
    "\\bzippyshare\\.com\\b",
    "\\bmediafire\\.com\\b",
    "\\bmega\\.nz\\b",
    "\\banonfiles\\.com\\b",
    "\\bgofile\\.io\\b",
    "\\bfiledropper\\.com\\b",
    "\\buploadhaven\\.com\\b",
    "\\brapidgator\\.net\\b",
    "\\bnitroflare\\.com\\b",
    "\\bturbobit\\.net\\b",
    "\\buploaded\\.net\\b",
    // Known phishing/scam patterns
    "\\bphish\\b",
    "\\bscam\\b",
    "\\bfraud\\b",
    "\\bmalware\\b",
    "\\bransomware\\b",
    "\\bkeylogger\\b",
    "\\btrojan\\b",
    "\\bspyware\\b",
    // Hacking tools and forums
    "\\bhack ?forum\\b",
    "\\bcrack\\b",
    "\\bkeygen\\b",
    "\\bwarez\\b",
    "\\bnulled\\.to\\b",
    "\\bcracked\\.io\\b",
    "\\bleaked\\b",
    // Crypto mining / scam tokens
    "\\bcoinhive\\b",
    "\\bcryptojacking\\b",
    "\\bminingpool\\b",
  ].join("|"),
  "i"
);

/**
 * News and gossip entertainment sites.
 * Blocks major news aggregation and gossip sites for workplace productivity.
 */
const NEWS_GOSSIP_REGEX = new RegExp(
  [
    "\\bbuzzfeed\\.com\\b",
    "\\btmz\\.com\\b",
    "\\bboredpanda\\.com\\b",
    "\\bdistractify\\.com\\b",
    "\\bthechive\\.com\\b",
    "\\bcracked\\.com\\b",
    "\\btheonion\\.com\\b",
    "\\bbabylon ?bee\\b",
    "\\bviralnova\\.com\\b",
    "\\bupworthy\\.com\\b",
    "\\bladbible\\.com\\b",
    "\\bunilab\\.com\\b",
    "\\bjunkee\\.com\\b",
    "\\bperezhilton\\.com\\b",
    "\\bpopsugar\\.com\\b",
    "\\bcosmopolitan\\.com\\b",
    "\\belleonline\\.com\\b",
    "\\benews\\.com\\b",
    "\\buscweekly\\.com\\b",
    "\\bpeoplemagazine\\b",
    "\\btabloid\\b",
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
  }
  // 6. Video streaming and entertainment
  else if (STREAMING_REGEX.test(url)) {
    decision = { blocked: true, reason: "Streaming/Entertainment Blocked" };
  }
  // 7. Online shopping
  else if (SHOPPING_REGEX.test(url)) {
    decision = { blocked: true, reason: "Online Shopping Blocked" };
  }
  // 8. Gambling and betting
  else if (GAMBLING_REGEX.test(url)) {
    decision = { blocked: true, reason: "Gambling/Betting Blocked" };
  }
  // 9. Dating platforms
  else if (DATING_REGEX.test(url)) {
    decision = { blocked: true, reason: "Dating Platform Blocked" };
  }
  // 10. VPN/proxy circumvention tools
  else if (VPNPROXY_REGEX.test(url)) {
    decision = { blocked: true, reason: "VPN/Proxy Circumvention Blocked" };
  }
  // 11. Known unsafe/malicious patterns
  else if (UNSAFE_REGEX.test(url)) {
    decision = { blocked: true, reason: "Unsafe/Malicious Content Blocked" };
  }
  // 12. News and gossip entertainment
  else if (NEWS_GOSSIP_REGEX.test(url)) {
    decision = { blocked: true, reason: "News/Gossip Entertainment Blocked" };
  } else {
    // 13. Malicious / suspicious site check (link-shield offline heuristics)
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
  const parts1 = v1.split(".").map(Number);
  const parts2 = v2.split(".").map(Number);
  
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

  // Fallback alarm (minimum 1 min) to restart interval after service worker wakes
  chrome.alarms.create("updateCheck", {
    delayInMinutes: 1,
    periodInMinutes: 1
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
    // Perform an immediate check after installation
    performUpdateCheck();
  } else if (details.reason === "update") {
    setupUpdateInterval();
  }
});

// On service worker startup, ensure the interval is set
chrome.runtime.onStartup.addListener(() => {
  setupUpdateInterval();
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
