/**
 * Watson Control Tower — popup script
 *
 * Fetches protection statistics from the background service worker and
 * renders them in the popup UI.
 */
(function () {
  "use strict";

  /** Milliseconds to wait before retrying after a sleeping service worker. */
  const SERVICE_WORKER_RETRY_DELAY_MS = 800;

  /**
   * Format a number with compact notation for large values
   * e.g. 1500 → "1.5k", 1200000 → "1.2M"
   *
   * @param {number} n
   * @returns {string}
   */
  function formatNumber(n) {
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
    if (n >= 1_000)     return (n / 1_000).toFixed(1).replace(/\.0$/, "") + "k";
    return String(n);
  }

  /**
   * Format a timestamp as a human-readable relative string.
   * e.g. "2 hours ago", "just now", "3 days ago"
   *
   * @param {number|null} ts  Unix timestamp in milliseconds, or null
   * @returns {string}
   */
  function timeAgo(ts) {
    if (!ts) return "Not yet fetched";
    const diff = Date.now() - ts;
    const seconds = Math.floor(diff / 1000);
    if (seconds < 60)  return "Just now";
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60)  return `${minutes} minute${minutes !== 1 ? "s" : ""} ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24)    return `${hours} hour${hours !== 1 ? "s" : ""} ago`;
    const days = Math.floor(hours / 24);
    return `${days} day${days !== 1 ? "s" : ""} ago`;
  }

  /**
   * Populate the popup with stats received from the background.
   *
   * @param {{
   *   blockedToday: number,
   *   blockedTotal: number,
   *   blocklistSize: number,
   *   blocklistUpdatedAt: number|null,
   *   version: string,
   *   monitorConnected: boolean
   * }} stats
   */
  function render(stats) {
    const statsEl = document.getElementById("stats");
    if (statsEl) statsEl.classList.remove("loading");

    const el = (id) => document.getElementById(id);

    if (el("version"))         el("version").textContent = "v" + (stats.version || "—");
    if (el("blocked-today"))   el("blocked-today").textContent   = formatNumber(stats.blockedToday || 0);
    if (el("blocked-total"))   el("blocked-total").textContent   = formatNumber(stats.blockedTotal || 0);
    if (el("blocklist-updated")) {
      el("blocklist-updated").textContent = `Updated ${timeAgo(stats.blocklistUpdatedAt)}`;
    }

    // Monitoring status indicator
    const pill = el("monitor-status");
    const dot  = el("monitor-dot");
    const txt  = el("monitor-text");
    if (pill && dot && txt) {
      if (stats.monitorConnected) {
        pill.className = "monitor-pill monitor-on";
        dot.style.background = "#16a34a";
        txt.textContent = "Active";
      } else {
        pill.className = "monitor-pill monitor-off";
        dot.style.background = "#94a3b8";
        txt.textContent = "Disconnected";
      }
    }

    // Block-all toggle state
    const toggle = el("block-toggle");
    if (toggle) {
      if (stats.internetBlocked) {
        toggle.classList.add("active");
      } else {
        toggle.classList.remove("active");
      }
    }
  }

  /**
   * Show placeholder dashes while waiting for the background response.
   */
  function renderLoading() {
    const ids = ["blocked-today", "blocked-total"];
    for (const id of ids) {
      const el = document.getElementById(id);
      if (el) el.textContent = "—";
    }
    const upd = document.getElementById("blocklist-updated");
    if (upd) upd.textContent = "Loading…";
  }

  // Request stats from the background service worker
  renderLoading();
  chrome.runtime.sendMessage({ type: "GET_STATS" }, (response) => {
    if (chrome.runtime.lastError) {
      // Service worker may be sleeping; show a graceful fallback
      console.warn("[WatsonCT popup] Could not reach background:", chrome.runtime.lastError.message);
      const upd = document.getElementById("blocklist-updated");
      if (upd) upd.textContent = "Waking up…";
      // Retry once after a short delay to let the service worker start
      setTimeout(() => {
        chrome.runtime.sendMessage({ type: "GET_STATS" }, (retryResponse) => {
          if (!chrome.runtime.lastError && retryResponse) render(retryResponse);
        });
      }, SERVICE_WORKER_RETRY_DELAY_MS);
      return;
    }
    if (response) render(response);
  });

  // ── Block All Internet toggle ──────────────────────────────────────────
  const blockToggle = document.getElementById("block-toggle");
  if (blockToggle) {
    blockToggle.addEventListener("click", () => {
      const newState = !blockToggle.classList.contains("active");
      chrome.runtime.sendMessage({ type: "SET_INTERNET_BLOCKED", blocked: newState }, (resp) => {
        if (chrome.runtime.lastError) return;
        if (resp && resp.ok) {
          blockToggle.classList.toggle("active", resp.internetBlocked);
        }
      });
    });
  }

  // ── Open Tabs display ──────────────────────────────────────────────────
  const tabsToggle = document.getElementById("tabs-toggle");
  const tabsList   = document.getElementById("tabs-list");
  const tabsCount  = document.getElementById("tabs-count");

  function loadTabs() {
    chrome.runtime.sendMessage({ type: "GET_OPEN_TABS" }, (resp) => {
      if (chrome.runtime.lastError || !resp || !resp.tabs) return;
      const tabs = resp.tabs;
      if (tabsCount) tabsCount.textContent = String(tabs.length);
      if (tabsList) {
        tabsList.innerHTML = "";
        for (const tab of tabs) {
          const div = document.createElement("div");
          div.className = "tab-item";
          const img = document.createElement("img");
          img.src = tab.favIconUrl || "icons/icon16.png";
          img.alt = "";
          img.onerror = function () { this.src = "icons/icon16.png"; };
          const span = document.createElement("span");
          span.textContent = tab.title || tab.url || "Untitled";
          span.title = tab.url || "";
          div.appendChild(img);
          div.appendChild(span);
          tabsList.appendChild(div);
        }
      }
    });
  }

  if (tabsToggle && tabsList) {
    tabsToggle.addEventListener("click", () => {
      const visible = tabsList.style.display !== "none";
      tabsList.style.display = visible ? "none" : "block";
      if (!visible) loadTabs();
    });
  }

  // ── Real-time timestamp updater (refresh blocklist "Updated X ago" every 30s) ──
  setInterval(() => {
    chrome.runtime.sendMessage({ type: "GET_STATS" }, (resp) => {
      if (chrome.runtime.lastError || !resp) return;
      const el = document.getElementById("blocklist-updated");
      if (el) el.textContent = `Updated ${timeAgo(resp.blocklistUpdatedAt)}`;
    });
  }, 30_000);
})();
