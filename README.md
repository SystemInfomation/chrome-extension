# PalsPlan Web Protector

[![Build & Package Extension](https://github.com/SystemInfomation/cdn-hosting/actions/workflows/build-extension.yml/badge.svg)](https://github.com/SystemInfomation/cdn-hosting/actions/workflows/build-extension.yml)
[![Download Extension ZIP](https://img.shields.io/badge/Download-Extension%20ZIP-blue?style=flat&logo=googlechrome)](https://github.com/SystemInfomation/cdn-hosting/releases/latest/download/palsplan-web-protector.zip)

Chrome extension + hosted blocked page that protects users from adult content and malicious/suspicious websites. Works as a normal Chrome extension without requiring enterprise enrollment or special policies.

---

## Repository Structure

```
palsplan-web-protector/
├── extension/
│   ├── manifest.json          Chrome extension manifest (MV3)
│   └── background.js          Service worker source (ES module, webpack entry)
├── blocked-page/
│   ├── index.html
│   ├── vite.config.js
│   ├── package.json
│   └── src/
│       ├── main.jsx
│       ├── App.jsx            Reads ?blockedUrl=&reason= query params
│       ├── App.css            Dark enterprise theme
│       ├── index.css
│       └── components/
│           └── BlockedInfo.jsx
├── webpack.config.js          Bundles extension/background.js → extension/dist/
├── package.json               Extension build dependencies
└── README.md
```

---

## How It Works

| Layer | Technology | Notes |
|---|---|---|
| URL interception | `chrome.webNavigation.onBeforeNavigate` | Only main frames — never iframes |
| Adult detection | Single compiled `RegExp` over the URL | ~50 ns per check |
| Malware detection | [link-shield](https://github.com/HamzaMohammed89/link-shield) — fully offline heuristics | No external API calls |
| Result caching | In-memory `Map` (LRU-style, max 500 entries) | Zero-latency repeat navigations |
| Blocked page | React + Vite SPA at `https://blocked.palsplan.app` | Parses `?blockedUrl=` and `?reason=` |
| Distribution | Chrome Web Store or self-hosted | Works as a normal extension, can be disabled by users |

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
   This runs `npm run build` first (producing `extension/dist/background.bundle.js`) and then creates `palsplan-web-protector.zip` with `manifest.json` at the zip root, ready for upload.

   > **Tip — no local toolchain?** Click the **Build & Package Extension** badge above → open the latest run → click **Run workflow**. Once it completes, download `palsplan-web-protector` from the **Artifacts** section.
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

5. Set the custom domain to `blocked.palsplan.app` in the **Custom Domains** tab
6. Add a DNS CNAME record: `blocked.palsplan.app` → `<your-render-service>.onrender.com`

### Deploy to Vercel (alternative)

```bash
cd blocked-page
npx vercel --prod
# Follow prompts, then set custom domain in Vercel dashboard
```

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
google-chrome --pack-extension=extension/ --pack-extension-key=palsplan-webprotector.pem
# Output: extension.crx  (named after the directory)
#         palsplan-webprotector.pem  (created from the --pack-extension-key value on first run)
```

> On first run Chrome generates the `.pem` file at the path you specified with
> `--pack-extension-key`. Back it up — you need the same key for every future update
> or Chrome will treat it as a different extension.

### 2 — Host the `.crx` and update manifest

An `updates.xml` file is automatically created in `blocked-page/public/updates.xml` and will be hosted at `https://blocked.palsplan.app/updates.xml` when you deploy the blocked page.

Before deploying, edit `blocked-page/public/updates.xml` and fill in the three placeholders:

```xml
<app appid='EXTENSION_ID'>
  <updatecheck codebase='CRX_URL' version='VERSION' />
</app>
```

| Placeholder | Description | Example |
|---|---|---|
| `EXTENSION_ID` | The 32-character Chrome extension ID (uses lowercase a-p) | `abcdefghijklmnopqrstuvwxyzabcdef` |
| `CRX_URL` | Public HTTPS URL of the signed .crx package | `https://cdn.palsplan.app/palsplan-web-protector.crx` |
| `VERSION` | Current extension version matching manifest.json | `1.0.0` |

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
<EXTENSION_ID>;https://blocked.palsplan.app/updates.xml
```

See the [Chrome Enterprise documentation](https://support.google.com/chrome/a/answer/9296680) for more details on enterprise deployment.

---

## Verification

After installing the extension:

1. Open `chrome://extensions` — you should see the extension listed
2. Navigate to `http://pornhub.com` or a suspicious URL — you should be redirected to `https://blocked.palsplan.app`

---

## Security Notes

- **No external API calls:** all detection is offline — link-shield runs purely in the service worker bundle
- **No user data collected:** the extension does not log, store, or transmit browsing history
- **Blocked page:** uses `decodeURIComponent` on query params; the page only reads and displays these values, it does not execute them
