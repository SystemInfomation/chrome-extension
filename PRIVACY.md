# Privacy Policy — PalsPlan Web Protector

**Last updated: 2026-03-19**

## Summary

PalsPlan Web Protector is a family-safety Chrome extension that filters websites locally on your device. **No browsing data is collected, stored remotely, or transmitted to any third party.**

---

## What data the extension accesses

The extension intercepts browser navigation events (URLs) solely to decide whether to allow or block a page. This check happens entirely in-memory within the extension's service worker. The URL is:

- Compared against locally bundled heuristic patterns (adult content, malicious TLDs, unsafe patterns).
- Checked against a bundled, offline domain blocklist (`blocklist.gz`, compiled at build time from public blocklists).
- Optionally evaluated by the [link-shield](https://github.com/palsplan/link-shield) offline risk-scoring library.

**URLs are never written to disk (beyond Chrome's own session history), logged, or sent anywhere.**

---

## Data storage

The extension stores the following data in `chrome.storage.local` (on-device only):

| Key | Purpose |
|-----|---------|
| `blockedToday` | Count of sites blocked today (resets at midnight) |
| `blockedTotal` | Cumulative count of blocked sites |
| `blocklistSize` | Number of domains in the loaded blocklist |
| `blocklistUpdatedAt` | Timestamp of when the blocklist was last loaded |
| `customFilterDomains` | Parent-defined custom block list (array of domain strings) |
| `monitorConnected` | Boolean — whether the optional monitoring WebSocket is active |

No data is synced to `chrome.storage.sync` or transmitted off-device by default.

---

## Optional monitoring feature

If a user or administrator explicitly configures a monitoring WebSocket URL (by setting `MONITOR_WS_URL` in the extension's source before building), the extension can send the following events to that server:

- **Blocked navigations**: the URL that was blocked and the reason (e.g., "adult content", "blocklist").
- **Custom filter changes**: additions/removals to the parent-configured block list.
- **Connection heartbeats**: periodic "online" status pings.

**This feature is disabled by default** (`MONITOR_WS_URL = ""`). No data is sent unless you explicitly enable it. The monitoring server is user-controlled and self-hosted; PalsPlan does not operate a monitoring server.

The extension **does not** send:
- Allowed (non-blocked) URLs.
- Screenshots or screen recordings.
- Browser history.
- Any personally identifiable information.

---

## Permissions justification

| Permission | Why it is needed |
|-----------|-----------------|
| `webNavigation` | Intercept navigation events to evaluate URLs before they load |
| `tabs` | Read the active tab URL during navigation checks |
| `storage` | Store block counts and custom filter domains locally |
| `alarms` | Schedule periodic integrity checks |
| `notifications` | Alert the user when a site is blocked (optional) |
| `declarativeNetRequest` | Declarative blocking rules (reserved for future use) |
| `*://*/*` (host permission) | Required to intercept HTTP and HTTPS navigation events across all websites |

---

## Third-party services

The extension does **not** make any outbound network requests in its default configuration. The bundled blocklist is compiled at build time and shipped with the extension package — no external fetching occurs at runtime.

---

## Contact

If you have questions about this privacy policy, please open an issue on the [GitHub repository](https://github.com/SystemInfomation/chrome-extension).
