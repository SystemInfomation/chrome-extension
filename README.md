# Watson Control Tower

[![Build & Package Extension](https://github.com/SystemInfomation/cdn-hosting/actions/workflows/build-extension.yml/badge.svg)](https://github.com/SystemInfomation/cdn-hosting/actions/workflows/build-extension.yml)
[![Download Extension ZIP](https://img.shields.io/badge/Download-Extension%20ZIP-blue?style=flat&logo=googlechrome)](https://github.com/SystemInfomation/cdn-hosting/releases/latest/download/watson-control-tower.zip)

Chrome extension + hosted blocked page that protects users from insecure connections, adult content, gaming websites, personal/social media, and malicious/suspicious websites. Works as a normal Chrome extension without requiring enterprise enrollment or special policies.

---

## Repository Structure

```
watson-control-tower/
├── extension/
│   ├── manifest.json          Chrome extension manifest (MV3)
│   ├── background.js          Service worker source — filtering + WS monitoring
│   ├── popup.html             Extension popup UI
│   └── popup.js               Popup script (stats + monitoring status)
├── blocked-page/
│   ├── index.html
│   ├── vite.config.js
│   ├── package.json
│   └── src/
│       ├── main.jsx
│       ├── App.jsx            Reads ?blockedUrl=&reason= query params
│       ├── App.css            Light theme
│       ├── index.css
│       └── components/
│           └── BlockedInfo.jsx
├── backend/                   Parental monitoring backend (Node.js + ws)
│   ├── server.js              Express + WebSocket server
│   ├── package.json
│   ├── render.yaml            Render.com deployment config
│   └── .env.example
├── dashboard/                 Parent monitoring dashboard (React + Next.js)
│   ├── next.config.mjs
│   ├── vercel.json
│   ├── package.json
│   └── src/
│       ├── app/               Next.js App Router pages
│       │   ├── layout.jsx     Root layout with sidebar
│       │   ├── page.jsx       Live View
│       │   ├── activity/      Activity Log
│       │   ├── alerts/        Blocked site alerts
│       │   └── settings/      Configuration
│       ├── components/
│       │   └── Sidebar.jsx
│       └── context/
│           └── MonitorContext.jsx  WebSocket state provider
├── webpack.config.js          Bundles extension/background.js → extension/dist/
├── package.json               Extension build dependencies
└── README.md
```

---

## How It Works

| Layer | Technology | Notes |
|---|---|---|
| URL interception | `chrome.webNavigation.onBeforeNavigate` | Only main frames — never iframes |
| HTTP blocking | Protocol check | Blocks all insecure HTTP connections |
| Localhost blocking | Hostname check | Blocks localhost, 127.0.0.1, ::1, and loopback addresses |
| Gaming detection | Single compiled `RegExp` over the URL | Blocks Roblox, Minecraft, Steam, Discord, Twitch, and 50+ gaming sites |
| Personal/Social detection | Single compiled `RegExp` over the URL | Blocks Facebook, Instagram, Twitter, YouTube, TikTok, blogs, and social media |
| Adult detection | Single compiled `RegExp` over the URL | ~50 ns per check |
| Malware detection | [link-shield](https://github.com/HamzaMohammed89/link-shield) — fully offline heuristics | No external API calls |
| Result caching | In-memory `Map` (LRU-style, max 500 entries) | Zero-latency repeat navigations |
| Blocked page | React + Vite SPA at `https://blocked.Watsons.app` | Parses `?blockedUrl=` and `?reason=` |
| Auto-updates | GitHub Releases API + chrome.alarms | Checks daily for new versions |
| Bypass prevention | Multiple security layers | Back button protection, history tracking, incognito support |
| Distribution | Chrome Web Store or self-hosted | Works as a normal extension |

---

## Security Features

### Bypass Prevention

The extension includes multiple layers of protection to prevent users from bypassing the web filtering:

1. **Back Button Protection** — Tracks recently blocked URLs per tab and re-blocks attempts to navigate back to them
2. **History Manipulation Detection** — Monitors navigation patterns to detect bypass attempts
3. **Rapid Navigation Prevention** — Enforces a cooldown period (2 seconds) after blocking to prevent quick bypass attempts
4. **Incognito Mode Support** — Extension runs in "spanning" mode, protecting both normal and incognito sessions
5. **Extension State Monitoring** — Detects when extension is disabled and alerts the user
6. **Integrity Checks** — Hourly verification that all security components are functioning properly
7. **Tab Cleanup** — Automatically cleans up tracking data when tabs are closed to prevent memory leaks

### Blocked Page Security

The blocked page at `https://blocked.Watsons.app` includes enterprise-grade security:

1. **Content Security Policy (CSP)** — Strict CSP headers prevent XSS attacks and unauthorized script execution
2. **Input Sanitization** — All URL parameters are sanitized to prevent XSS and injection attacks
3. **Security Headers** — Comprehensive HTTP security headers including:
   - `X-Frame-Options: DENY` — Prevents clickjacking
   - `X-Content-Type-Options: nosniff` — Prevents MIME sniffing
   - `Referrer-Policy: no-referrer` — Blocks referrer leakage
   - `Strict-Transport-Security` — Enforces HTTPS
   - `Permissions-Policy` — Disables unnecessary browser features
4. **URL Validation** — Only HTTP/HTTPS URLs are accepted, preventing javascript: and data: URL attacks
5. **Length Limits** — Input is truncated to 2048 characters to prevent DoS attacks
6. **No External Resources** — All assets are self-hosted to prevent supply chain attacks

### Auto-Update System

The extension automatically checks for updates to ensure users have the latest security patches:

1. **Daily Update Checks** — Uses `chrome.alarms` API to check GitHub Releases every 24 hours
2. **Semantic Version Comparison** — Properly compares version numbers (e.g., 1.2.3 vs 1.2.0)
3. **User Notifications** — Displays a Chrome notification when a new version is available
4. **One-Click Updates** — Clicking the notification opens the download page
5. **Secure Downloads** — Only downloads from official GitHub releases via HTTPS
6. **Background Processing** — All update checks happen in the background without interrupting browsing

---

## Part 1 — Building the Chrome Extension

### Prerequisites

- Node.js ≥ 18
- npm ≥ 9

### Install & build

```bash
# From the repository root
npm install
npm run build
```

The webpack bundle is written to `extension/dist/background.bundle.js` (~9 KB minified).

### Load unpacked for testing

1. Open Chrome and navigate to `chrome://extensions`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked**
4. Select the `extension/` folder
5. Visit any blocked URL — e.g. `http://pornhub.com` or `http://g00gle-login.xyz/verify`

> **Note:** For local testing the blocked page redirect will fail (no live server). Either:
> - Deploy the blocked page first (see Part 2), or
> - Temporarily change `BLOCKED_PAGE_BASE` in `extension/background.js` to a local Vite dev server URL and rebuild.

### Publishing to the Chrome Web Store

1. Build and package the extension with a single command:
   ```bash
   npm run pack
   ```
   This runs `npm run build` first (producing `extension/dist/background.bundle.js`) and then creates `watson-control-tower.zip` with `manifest.json` at the zip root, ready for upload.

   > **Tip — no local toolchain?** Click the **Build & Package Extension** badge above → open the latest run → click **Run workflow**. Once it completes, download `watson-control-tower` from the **Artifacts** section.
2. Go to the [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole)
3. Click **Add new item** → upload the `.zip`
4. Set **Visibility** to **Public** or **Unlisted** depending on your needs
5. Complete the listing and submit for review
6. Once approved, users can install the extension from the Chrome Web Store

---

## Part 2 — Deploying the Blocked Page

### Local preview

```bash
cd blocked-page
npm install
npm run dev        # http://localhost:5173
# Preview with params:
# http://localhost:5173?blockedUrl=https%3A%2F%2Fpornhub.com&reason=Adult%20Content
```

### Build for production

```bash
cd blocked-page
npm run build      # outputs to blocked-page/dist/
```

### Deploy to Render (recommended)

1. Push this repository to GitHub
2. Go to [render.com](https://render.com) → **New → Static Site**
3. Connect the GitHub repository
4. Set the following:

   | Setting | Value |
   |---|---|
   | **Root Directory** | `blocked-page` |
   | **Build Command** | `npm install && npm run build` |
   | **Publish Directory** | `dist` |

5. Set the custom domain to `blocked.Watsons.app` in the **Custom Domains** tab
6. Add a DNS CNAME record: `blocked.Watsons.app` → `<your-render-service>.onrender.com`

### Deploy to Vercel (alternative)

```bash
cd blocked-page
npx vercel --prod
# Follow prompts, then set custom domain in Vercel dashboard
```

---

## Part 3 — Real-Time Parental Monitoring

The extension includes an optional real-time monitoring system. When enabled, every navigation event (allowed and blocked) is streamed live to a parent dashboard — no third-party service required.

### Architecture

```
Child's Browser (extension)
        │  WebSocket (wss://)
        ▼
backend/ — Node.js + Express + ws  (hosted on Render.com)
        │  WebSocket broadcast
        ▼
dashboard/ — React + Next.js        (hosted on Vercel)
```

### Step 1 — Deploy the Backend to Render.com

1. Go to [render.com](https://render.com) → **New → Web Service**
2. Connect this GitHub repository
3. Set:

   | Setting          | Value                     |
   |------------------|---------------------------|
   | **Root Directory** | `backend`               |
   | **Build Command** | `npm install`            |
   | **Start Command** | `npm start`              |
   | **Environment**  | Node                      |

4. Set the custom domain to `backend.watsons.app` in the **Custom Domains** tab for the backend service.

> Render.com free tier spins down after 15 minutes of inactivity. The extension sends a heartbeat every 30 seconds to keep the service alive.

### Step 2 — Extension Backend URL

The extension and dashboard are pre-configured to connect to `https://backend.watsons.app`. No changes needed after deploy.

### Step 3 — Deploy the Dashboard to Vercel

```bash
cd dashboard
npx vercel --prod
```

Or connect the repo to Vercel:
1. Go to [vercel.com](https://vercel.com) → **New Project**
2. Import this repository, set **Root Directory** to `dashboard`
3. Framework preset: **Next.js** (auto-detected)
4. Deploy

### Dashboard Pages

| Page | Description |
|------|-------------|
| **Live View** | Real-time scrolling feed of every site visited (green = allowed, red = blocked) |
| **Activity Log** | Searchable/filterable history of all browsing events |
| **Alerts** | Blocked site attempts, color-coded by severity |
| **Settings** | Configure backend URL, manage custom blocked domains |

### Custom Blocked Domains

From the dashboard **Settings** page, add domains to block. These are pushed to the extension in real-time via WebSocket — no extension reinstall needed.

---

## Part 2b — Self-Hosting the Extension (Outside the Chrome Web Store)

> Skip this section if you distribute the extension through the Chrome Web Store.  
> Use it when the extension is not (or not yet) published to the Web Store, or when
> you need full control over distribution.

### 1 — Package the extension as a `.crx` file

A self-hosted extension must be distributed as a **signed `.crx`** package (not a
plain `.zip`).

```bash
# Build the bundle first
npm run build

# Use Chrome's built-in packer (headless):
google-chrome --pack-extension=extension/ --pack-extension-key=watson-control-tower.pem
# Output: extension.crx  (named after the directory)
#         watson-control-tower.pem  (created from the --pack-extension-key value on first run)
```

> On first run Chrome generates the `.pem` file at the path you specified with
> `--pack-extension-key`. Back it up — you need the same key for every future update
> or Chrome will treat it as a different extension.

### 2 — Host the `.crx` and update manifest

The `updates.xml` manifest and the `.crx` file are both served directly by the Watson Control Tower backend:

- **Update manifest:** `https://backend.watsons.app/updates.xml`
- **CRX download:** `https://backend.watsons.app/extension.crx`

To publish a new release, copy your built `.crx` to `backend/public/extension.crx` and bump `version` in `extension/manifest.json`. The backend reads the version from `manifest.json` at runtime, so `updates.xml` updates automatically on the next deploy.

> Update the `version` attribute every time you release a new `.crx` so that Chrome
> detects and applies the update automatically.

### 3 — Load the extension in Chrome

**For normal users:**
1. Download the `.crx` file
2. Open Chrome and navigate to `chrome://extensions`
3. Enable **Developer mode** (top-right toggle)
4. Drag and drop the `.crx` file onto the extensions page

**For enterprise deployment (optional):**
If you want to force-install the extension on managed devices, you can use Chrome enterprise policies with the update URL:
```
lmaaddldfngeapalhdhgbeeipbjalioe;https://backend.watsons.app/updates.xml
```

See the [Chrome Enterprise documentation](https://support.google.com/chrome/a/answer/9296680) for more details on enterprise deployment.

---

## Verification

After installing the extension:

1. Open `chrome://extensions` — you should see the extension listed
2. Navigate to `http://pornhub.com` or a suspicious URL — you should be redirected to `https://blocked.Watsons.app`

---

## Security Notes

### Privacy & Data Protection
- **No external API calls:** All detection is offline — link-shield runs purely in the service worker bundle
- **No user data collected:** The extension does not log, store, or transmit browsing history
- **No telemetry:** No analytics, tracking, or user behavior monitoring

### Content Filtering
- **Comprehensive whitelist:** Legitimate services (Google, Microsoft, Apple, Amazon, GitHub, etc.) are whitelisted to prevent false positives
- **Adjusted risk threshold:** Link-shield risk score threshold increased to 70/100 (high risk) to reduce false positives while maintaining security
- **Cached results:** URLs are cached in-memory (max 500 entries) for performance, automatically cleaned up

### Blocked Page Security
- **Input sanitization:** All URL parameters are sanitized to prevent XSS attacks — HTML tags and dangerous characters are removed
- **URL validation:** Only HTTP/HTTPS protocols are accepted; javascript:, data:, and other dangerous protocols are rejected
- **Length limits:** Input is truncated to 2048 characters to prevent DoS attacks
- **Enhanced CSP:** Strict Content Security Policy prevents unauthorized script execution, clickjacking, and XSS
- **Security headers:** Comprehensive HTTP headers including HSTS, X-Frame-Options, X-Content-Type-Options, and more

### Extension Security
- **Manifest V3:** Uses the latest Chrome extension manifest version with improved security
- **Content Security Policy:** Strict CSP for extension pages prevents inline scripts and unauthorized code execution
- **Required permissions:** Extension only requests necessary permissions:
  - `webNavigation` — Intercept navigation events to block harmful URLs
  - `tabs` — Redirect blocked pages and manage tab state
  - `storage` — Store update check timestamps and user preferences
  - `alarms` — Schedule periodic update checks and integrity monitoring
  - `notifications` — Alert users about available updates
  - `declarativeNetRequest` — Fast, efficient URL blocking
  - `management` — Monitor extension state to detect tampering

### Bypass Prevention
- **Incognito mode protection:** Extension runs in both normal and incognito sessions (spanning mode)
- **Back button protection:** Tracks blocked URLs per tab and re-blocks navigation attempts
- **History manipulation detection:** Monitors navigation patterns to detect bypass attempts
- **Rapid navigation prevention:** Enforces cooldown periods after blocking
- **Extension state monitoring:** Detects and alerts when extension is disabled
- **Integrity checks:** Hourly verification of security components
- **Memory management:** Automatic cleanup of tracking data when tabs close

### Update Security
- **HTTPS-only downloads:** Updates are only downloaded from official GitHub releases via HTTPS
- **Version verification:** Semantic version comparison ensures legitimate updates
- **User control:** Updates require user confirmation — no automatic installation
- **Daily checks:** Background update checks every 24 hours without interrupting browsing
