# PalsPlan Web Protector

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

1. Zip the `extension/` folder **after** running `npm run build`:
   ```bash
   cd extension && zip -r ../palsplan-web-protector.zip . && cd ..
   ```
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
4. Click the **+** (Add) button → **Add from Chrome Web Store**
5. Enter the **Extension ID** from your Chrome Web Store listing
6. In the **Installation policy** column, set it to **Force install**
7. Click **Save**

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
6. Enable it and add the following entry:
   ```
   <EXTENSION_ID>;https://clients2.google.com/service/update2/crx
   ```
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
   - `ExtensionInstallForcelist` — Value:
     ```
     <EXTENSION_ID>;https://clients2.google.com/service/update2/crx
     ```
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

Replace `<EXTENSION_ID>` with your actual extension ID. Upload this profile to Jamf Pro → Computers → Configuration Profiles, or Intune → macOS → Configuration profiles.

---

### Option D — Registry (Windows, without GPO)

For machines not joined to a domain, you can set the policy directly via the registry:

```
Key:   HKEY_LOCAL_MACHINE\SOFTWARE\Policies\Google\Chrome\ExtensionInstallForcelist
Name:  1  (increment for each extension)
Type:  REG_SZ
Value: <EXTENSION_ID>;https://clients2.google.com/service/update2/crx
```

Can be deployed via a PowerShell script:

```powershell
$regPath = "HKLM:\SOFTWARE\Policies\Google\Chrome\ExtensionInstallForcelist"
if (-not (Test-Path $regPath)) {
    New-Item -Path $regPath -Force | Out-Null
}
Set-ItemProperty -Path $regPath -Name "1" -Value "<EXTENSION_ID>;https://clients2.google.com/service/update2/crx"
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
