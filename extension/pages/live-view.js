/**
 * Live View Page — InternetWize
 *
 * Displays a real-time stream of the child's active tab via periodic
 * screenshot capture (using chrome.tabs.captureVisibleTab in the background).
 *
 * Secured with a parent PIN stored in chrome.storage.local.
 * The PIN is hashed with SHA-256 before storage for basic security.
 */

/* eslint-env browser */
/* global chrome */

(function () {
  "use strict";

  // ── DOM references ─────────────────────────────────────────────────────────

  const authOverlay = document.getElementById("authOverlay");
  const mainContent = document.getElementById("mainContent");
  const pinInput = document.getElementById("pinInput");
  const pinSubmit = document.getElementById("pinSubmit");
  const authError = document.getElementById("authError");
  const pinSetupHint = document.getElementById("pinSetupHint");
  const streamStatus = document.getElementById("streamStatus");
  const streamLabel = document.getElementById("streamLabel");
  const activeTabInfo = document.getElementById("activeTabInfo");
  const liveImg = document.getElementById("liveImg");
  const liveEmpty = document.getElementById("liveEmpty");
  const tabList = document.getElementById("tabList");

  let authenticated = false;
  let refreshTimer = null;

  // ── PIN hashing (SHA-256) ──────────────────────────────────────────────────

  async function hashPin(pin) {
    const encoder = new TextEncoder();
    const data = encoder.encode(pin);
    const hash = await crypto.subtle.digest("SHA-256", data);
    return Array.from(new Uint8Array(hash))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }

  // ── Auth flow ──────────────────────────────────────────────────────────────

  function initAuth() {
    chrome.storage.local.get(["parentPinHash"], (result) => {
      if (!result.parentPinHash) {
        // No PIN set — prompt to create one
        pinSetupHint.style.display = "block";
      }
    });
  }

  async function handlePinSubmit() {
    const pin = pinInput.value.trim();
    if (pin.length < 4 || pin.length > 6) {
      showAuthError("PIN must be 4–6 digits.");
      return;
    }
    if (!/^\d+$/.test(pin)) {
      showAuthError("PIN must be numbers only.");
      return;
    }

    const pinHash = await hashPin(pin);

    chrome.storage.local.get(["parentPinHash"], (result) => {
      if (!result.parentPinHash) {
        // First time — save the PIN
        chrome.storage.local.set({ parentPinHash: pinHash }, () => {
          unlock();
        });
      } else if (result.parentPinHash === pinHash) {
        // Correct PIN
        unlock();
      } else {
        showAuthError("Incorrect PIN. Try again.");
        pinInput.value = "";
        pinInput.focus();
      }
    });
  }

  function showAuthError(msg) {
    authError.textContent = msg;
    authError.style.display = "block";
  }

  function unlock() {
    authenticated = true;
    authOverlay.style.display = "none";
    mainContent.style.display = "block";
    startLiveFeed();
  }

  // ── Live feed ──────────────────────────────────────────────────────────────

  function startLiveFeed() {
    streamStatus.style.background = "var(--color-success)";
    streamLabel.textContent = "Live — streaming";

    // Request screenshots from the background service worker
    requestScreenshot();
    refreshTimer = setInterval(requestScreenshot, 1000);

    // Also load open tabs
    loadOpenTabs();
    setInterval(loadOpenTabs, 5000);
  }

  function requestScreenshot() {
    if (!authenticated) return;

    chrome.runtime.sendMessage({ type: "CAPTURE_SCREENSHOT" }, (response) => {
      if (chrome.runtime.lastError || !response) {
        streamStatus.style.background = "var(--color-warning)";
        streamLabel.textContent = "Waiting for capture…";
        return;
      }

      if (response.dataUrl) {
        liveImg.src = response.dataUrl;
        liveImg.style.display = "block";
        liveEmpty.style.display = "none";
        streamStatus.style.background = "var(--color-success)";
        streamLabel.textContent = "Live — streaming";

        if (response.url || response.title) {
          activeTabInfo.textContent =
            (response.title || "Untitled") + " — " + (response.url || "");
        }
      }
    });
  }

  function loadOpenTabs() {
    if (!authenticated) return;

    chrome.runtime.sendMessage({ type: "GET_OPEN_TABS" }, (response) => {
      if (chrome.runtime.lastError || !response || !response.tabs) return;

      tabList.innerHTML = "";
      for (const tab of response.tabs) {
        const tr = document.createElement("tr");
        const statusBadge = tab.active
          ? '<span class="badge badge-success">Active</span>'
          : '<span class="badge badge-info">Background</span>';

        tr.innerHTML = `
          <td>${escapeHtml(tab.title || "Untitled")}</td>
          <td class="text-truncate text-sm" title="${escapeHtml(tab.url || "")}">${escapeHtml(tab.url || "")}</td>
          <td>${statusBadge}</td>
        `;
        tabList.appendChild(tr);
      }
    });
  }

  // ── Utilities ──────────────────────────────────────────────────────────────

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  // ── Event listeners ────────────────────────────────────────────────────────

  pinSubmit.addEventListener("click", handlePinSubmit);
  pinInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") handlePinSubmit();
  });

  // ── Init ───────────────────────────────────────────────────────────────────

  initAuth();
})();
