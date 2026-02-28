# PalsPlan Web Protector

[![Build & Package Extension](https://github.com/SystemInfomation/cdn-hosting/actions/workflows/build-extension.yml/badge.svg)](https://github.com/SystemInfomation/cdn-hosting/actions/workflows/build-extension.yml)
[![Download Extension ZIP](https://img.shields.io/badge/Download-Extension%20ZIP-blue?style=flat&logo=googlechrome)](https://github.com/SystemInfomation/cdn-hosting/releases/latest/download/palsplan-web-protector.zip)

Enterprise Chrome extension + hosted blocked page that protects employees from adult content and malicious/suspicious websites — with **zero user-facing UI** and **zero ability to disable**.

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
| URL interception | `chrome.webRequest.onBeforeRequest` (blocking) | Only `main_frame` — never images/CSS/scripts |
| Adult detection | Single compiled `RegExp` over the URL | ~50 ns per check |
| Malware detection | [link-shield](https://github.com/HamzaMohammed89/link-shield) — fully offline heuristics | No external API calls |
| Result caching | In-memory `Map` (LRU-style, max 500 entries) | Zero-latency repeat navigations |
| Blocked page | React + Vite SPA at `https://blocked.palsplan.app` | Parses `?blockedUrl=` and `?reason=` |
| Enterprise enforcement | `ExtensionInstallForcelist` / `ExtensionSettings` policy | Users **cannot** disable or remove the extension |

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
4. Set **Visibility** to **Private** (for internal enterprise use)
5. Complete the listing and submit for review
6. Once approved, copy the **Extension ID** shown in the dashboard — you need it for policy deployment

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

Chrome's enterprise policy accepts two formats for every entry in
`ExtensionInstallForcelist` / `ExtensionSettings`:

| Format | When to use |
|---|---|
| `<ID>` only | Only valid inside the Google Admin Console "Add from Chrome Web Store" flow — Chrome fetches the update URL automatically |
| `<ID>;<UPDATE_URL>` | **Required** when the extension is hosted outside the Chrome Web Store |

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

Upload two files to a publicly accessible HTTPS server (e.g. your CDN):

| File | Example URL |
|---|---|
| `extension.crx` | `https://cdn.palsplan.app/palsplan-web-protector.crx` |
| `extension/updates.xml` | `https://cdn.palsplan.app/updates.xml` |

Edit `extension/updates.xml` and fill in the three placeholders:

```xml
<app appid='abcdefghijklmnopqrstuvwxyzabcdef'>
  <updatecheck codebase='https://cdn.palsplan.app/palsplan-web-protector.crx'
               version='1.0.0' />
</app>
```

> Update the `version` attribute every time you release a new `.crx` so that Chrome
> detects and applies the update on managed devices.

### 3 — Use the update manifest URL in enterprise policy

Wherever the deployment options below reference an update URL, use:
```
https://cdn.palsplan.app/updates.xml
```
instead of `https://clients2.google.com/service/update2/crx`.

---

## Part 3 — Enterprise Force-Install (Users Cannot Disable)

> **Why users cannot turn this off:** When an extension is deployed via `ExtensionInstallForcelist` or `ExtensionSettings` with `"installation_mode": "force_installed"`, Chrome prevents users from disabling, removing, or modifying it. The extension does not appear in the normal extensions management UI in a way that allows removal.
>
> In addition, `webRequestBlocking` in Manifest V3 is **only** granted to policy-force-installed extensions — so the blocking capability itself is tied to enterprise enforcement.

---

### Option A — Google Workspace Admin Console (Recommended for G Suite / ChromeOS)

1. Sign in to [admin.google.com](https://admin.google.com) as a super-admin
2. Navigate to:
   **Devices → Chrome → Apps & extensions → Users & browsers**
3. Select the **Organizational Unit (OU)** you want to target (or the root for everyone)
4. Choose the appropriate add method:

   **From the Chrome Web Store (extension is published to the Web Store):**
   - Click the **+** (Add) button → **Add from Chrome Web Store**
   - Enter the **Extension ID** from your Chrome Web Store listing

   **By extension ID (self-hosted or not yet on the Web Store):**
   - Click the **+** (Add) button → **Add by extension ID**
   - Enter the **Extension ID**
   - In the **Installation URL** field, enter the URL of your hosted `updates.xml` manifest
     (e.g. `https://cdn.palsplan.app/updates.xml`)
   > **Note:** If the extension is hosted outside the Chrome Web Store you **must** supply
   > the installation URL — Chrome uses it to fetch and update the `.crx` package.

5. In the **Installation policy** column, set it to **Force install**
6. Click **Save**

Chrome devices and managed Chrome browsers in that OU will install the extension automatically within ~15 minutes. Users see no install prompt and cannot remove it.

**Additional hardening** — lock the extension's policy via a JSON override:

```json
{
  "ExtensionSettings": {
    "<YOUR_EXTENSION_ID>": {
      "installation_mode": "force_installed",
      "update_url": "https://clients2.google.com/service/update2/crx",
      "blocked_permissions": [],
      "toolbar_pin": "force_pinned"
    }
  }
}
```

> **Self-hosted extension:** replace the `update_url` value with the URL of your hosted
> `updates.xml` manifest (e.g. `"update_url": "https://cdn.palsplan.app/updates.xml"`).

Paste this in:
**Devices → Chrome → Settings → Users & browsers → Additional Chrome policies (JSON)**

---

### Option B — Windows Group Policy (GPO)

> Requires the [Chrome ADMX templates](https://chromeenterprise.google/browser/download/#admin-bundle) installed on your domain controller.

1. Download and install the Chrome ADMX policy templates
2. Open **Group Policy Management Editor** (`gpmc.msc`)
3. Create or edit a GPO linked to the relevant OU
4. Navigate to:
   `Computer Configuration → Administrative Templates → Google → Google Chrome → Extensions`
5. Open **Configure the list of force-installed apps and extensions**
6. Enable it and add an entry in the format `<EXTENSION_ID>;<UPDATE_URL>`:
   - **Chrome Web Store:** `<EXTENSION_ID>;https://clients2.google.com/service/update2/crx`
   - **Self-hosted:** `<EXTENSION_ID>;https://cdn.palsplan.app/updates.xml`
   > The part after the semicolon is the update URL. For extensions hosted outside the
   > Chrome Web Store you must supply the URL of your hosted `updates.xml` manifest.
7. Apply and run `gpupdate /force` on client machines

**To also block users from accessing chrome://extensions:**

Navigate to:
`Computer Configuration → Administrative Templates → Google → Google Chrome`

Enable: **Prevent users from accessing the chrome://extensions page**

---

### Option C — Microsoft Intune / MDM (Windows & macOS)

#### Windows (Intune Custom OMA-URI)

1. In the [Microsoft Intune admin center](https://intune.microsoft.com), go to:
   **Devices → Windows → Configuration profiles → Create profile**
2. Platform: **Windows 10 and later**, Profile type: **Settings catalog**
3. Search for **Chrome** and add:
   - `ExtensionInstallForcelist` — Value uses the format `<EXTENSION_ID>;<UPDATE_URL>`:
     - **Chrome Web Store:** `<EXTENSION_ID>;https://clients2.google.com/service/update2/crx`
     - **Self-hosted:** `<EXTENSION_ID>;https://cdn.palsplan.app/updates.xml`
     > For extensions hosted outside the Chrome Web Store, the update URL must point to
     > your hosted `updates.xml` manifest.
4. Assign the profile to the device/user group and save

#### macOS (Intune or Jamf)

Create a `.mobileconfig` or Jamf policy with the following Chrome preference:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>PayloadContent</key>
  <array>
    <dict>
      <key>PayloadType</key>
      <string>com.google.Chrome</string>
      <key>PayloadVersion</key>
      <integer>1</integer>
      <key>PayloadIdentifier</key>
      <string>com.palsplan.chrome.webprotector</string>
      <key>PayloadUUID</key>
      <string>A1B2C3D4-E5F6-7890-ABCD-EF1234567890</string>
      <key>PayloadDisplayName</key>
      <string>PalsPlan Web Protector Policy</string>
      <key>ExtensionInstallForcelist</key>
      <array>
        <string><EXTENSION_ID>;https://clients2.google.com/service/update2/crx</string>
      </array>
    </dict>
  </array>
  <key>PayloadDisplayName</key>
  <string>PalsPlan Web Protector</string>
  <key>PayloadIdentifier</key>
  <string>com.palsplan.webprotector</string>
  <key>PayloadType</key>
  <string>Configuration</string>
  <key>PayloadUUID</key>
  <string>B2C3D4E5-F6A7-8901-BCDE-F12345678901</string>
  <key>PayloadVersion</key>
  <integer>1</integer>
</dict>
</plist>
```

Replace `<EXTENSION_ID>` with your actual extension ID, and the update URL with
`https://cdn.palsplan.app/updates.xml` if the extension is self-hosted (outside the
Chrome Web Store). Upload this profile to Jamf Pro → Computers → Configuration Profiles,
or Intune → macOS → Configuration profiles.

---

### Option D — Registry (Windows, without GPO)

For machines not joined to a domain, you can set the policy directly via the registry.
The value format is `<EXTENSION_ID>;<UPDATE_URL>` — use the Chrome Web Store URL for
Web Store extensions, or your hosted `updates.xml` URL for self-hosted extensions:

```
Key:   HKEY_LOCAL_MACHINE\SOFTWARE\Policies\Google\Chrome\ExtensionInstallForcelist
Name:  1  (increment for each extension)
Type:  REG_SZ
Value: <EXTENSION_ID>;https://clients2.google.com/service/update2/crx
```

For a self-hosted extension substitute the update URL:
```
Value: <EXTENSION_ID>;https://cdn.palsplan.app/updates.xml
```

Can be deployed via a PowerShell script:

```powershell
$regPath = "HKLM:\SOFTWARE\Policies\Google\Chrome\ExtensionInstallForcelist"
if (-not (Test-Path $regPath)) {
    New-Item -Path $regPath -Force | Out-Null
}
Set-ItemProperty -Path $regPath -Name "1" -Value "<EXTENSION_ID>;https://clients2.google.com/service/update2/crx"
# For a self-hosted extension:
# Set-ItemProperty -Path $regPath -Name "1" -Value "<EXTENSION_ID>;https://cdn.palsplan.app/updates.xml"
```

---

## Verification

After deployment, on any managed Chrome browser:

1. Open `chrome://policy` — you should see `ExtensionInstallForcelist` listed with your extension ID
2. Open `chrome://extensions` — the extension should appear with the label **"Installed by your administrator"** and no Remove button
3. Navigate to `http://pornhub.com` or `http://g00gle-phishing.xyz/login` — you should be redirected to `https://blocked.palsplan.app`

---

## Security Notes

- **No external API calls:** all detection is offline — link-shield runs purely in the service worker bundle
- **No user data collected:** the extension does not log, store, or transmit browsing history
- **webRequestBlocking in MV3:** Google restricts this permission to policy-force-installed extensions specifically to prevent abuse — our deployment model is the intended enterprise use case
- **Blocked page:** uses `decodeURIComponent` on query params; the page only reads and displays these values, it does not execute them
