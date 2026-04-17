/**
 * Activity Reports Page — InternetWize
 *
 * Displays browsing activity logs stored in chrome.storage.local.
 * Supports filtering, searching, pagination, and CSV/JSON export.
 */

/* eslint-env browser */
/* global chrome */

(function () {
  "use strict";

  const LOGS_PER_PAGE = 50;
  let currentPage = 1;
  let allLogs = [];
  let filteredLogs = [];

  // ── DOM references ─────────────────────────────────────────────────────────

  const searchInput = document.getElementById("searchInput");
  const filterAction = document.getElementById("filterAction");
  const filterDateFrom = document.getElementById("filterDateFrom");
  const filterDateTo = document.getElementById("filterDateTo");
  const logsBody = document.getElementById("logsBody");
  const emptyState = document.getElementById("emptyState");
  const logsTable = document.getElementById("logsTable");
  const pagination = document.getElementById("pagination");

  // Stats
  const statTotalVisits = document.getElementById("statTotalVisits");
  const statTotalBlocked = document.getElementById("statTotalBlocked");
  const statTodayVisits = document.getElementById("statTodayVisits");
  const statTodayBlocked = document.getElementById("statTodayBlocked");

  // ── Load logs from storage ─────────────────────────────────────────────────

  function loadLogs() {
    chrome.storage.local.get(["activityLogs"], (result) => {
      allLogs = result.activityLogs || [];
      // Sort newest first
      allLogs.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
      updateStats();
      applyFilters();
    });
  }

  // ── Stats computation ──────────────────────────────────────────────────────

  function updateStats() {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayMs = todayStart.getTime();

    let totalVisits = 0;
    let totalBlocked = 0;
    let todayVisits = 0;
    let todayBlocked = 0;

    for (const log of allLogs) {
      if (log.action === "visit") {
        totalVisits++;
        if (log.timestamp >= todayMs) todayVisits++;
      } else if (log.action === "blocked") {
        totalBlocked++;
        if (log.timestamp >= todayMs) todayBlocked++;
      }
    }

    statTotalVisits.textContent = totalVisits.toLocaleString();
    statTotalBlocked.textContent = totalBlocked.toLocaleString();
    statTodayVisits.textContent = todayVisits.toLocaleString();
    statTodayBlocked.textContent = todayBlocked.toLocaleString();
  }

  // ── Filtering ──────────────────────────────────────────────────────────────

  function applyFilters() {
    const query = (searchInput.value || "").toLowerCase().trim();
    const actionFilter = filterAction.value;
    const dateFrom = filterDateFrom.value
      ? new Date(filterDateFrom.value).getTime()
      : 0;
    const dateTo = filterDateTo.value
      ? new Date(filterDateTo.value).getTime() + 86400000
      : Infinity;

    filteredLogs = allLogs.filter((log) => {
      // Action filter
      if (actionFilter !== "all" && log.action !== actionFilter) return false;

      // Date range filter
      const ts = log.timestamp || 0;
      if (ts < dateFrom || ts > dateTo) return false;

      // Search query
      if (query) {
        const haystack = [log.url, log.title, log.reason, log.action]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        if (!haystack.includes(query)) return false;
      }

      return true;
    });

    currentPage = 1;
    renderLogs();
  }

  // ── Rendering ──────────────────────────────────────────────────────────────

  function renderLogs() {
    const start = (currentPage - 1) * LOGS_PER_PAGE;
    const end = start + LOGS_PER_PAGE;
    const page = filteredLogs.slice(start, end);

    if (filteredLogs.length === 0) {
      logsTable.style.display = "none";
      emptyState.style.display = "block";
      pagination.innerHTML = "";
      return;
    }

    logsTable.style.display = "table";
    emptyState.style.display = "none";

    logsBody.innerHTML = "";
    for (const log of page) {
      const tr = document.createElement("tr");
      const date = new Date(log.timestamp || 0);
      const timeStr = date.toLocaleDateString() + " " + date.toLocaleTimeString();

      const badgeClass =
        log.action === "blocked" ? "badge-danger" : "badge-success";
      const badgeLabel =
        log.action === "blocked" ? "Blocked" : "Visit";

      tr.innerHTML = `
        <td class="text-sm text-muted" style="white-space:nowrap">${escapeHtml(timeStr)}</td>
        <td><span class="badge ${badgeClass}">${badgeLabel}</span></td>
        <td class="text-truncate" title="${escapeHtml(log.url || "")}">${escapeHtml(log.url || "")}</td>
        <td class="text-truncate" title="${escapeHtml(log.title || "")}">${escapeHtml(log.title || "—")}</td>
        <td class="text-sm">${escapeHtml(log.reason || "—")}</td>
      `;
      logsBody.appendChild(tr);
    }

    renderPagination();
  }

  function renderPagination() {
    const totalPages = Math.ceil(filteredLogs.length / LOGS_PER_PAGE);
    if (totalPages <= 1) {
      pagination.innerHTML = "";
      return;
    }

    let html =
      '<button class="btn btn-outline btn-sm" id="prevPage" ' +
      (currentPage <= 1 ? "disabled" : "") +
      ">← Prev</button>";
    html +=
      '<span class="text-muted text-sm"> Page ' +
      currentPage +
      " of " +
      totalPages +
      " (" +
      filteredLogs.length.toLocaleString() +
      " entries) </span>";
    html +=
      '<button class="btn btn-outline btn-sm" id="nextPage" ' +
      (currentPage >= totalPages ? "disabled" : "") +
      ">Next →</button>";

    pagination.innerHTML = html;

    const prevBtn = document.getElementById("prevPage");
    const nextBtn = document.getElementById("nextPage");
    if (prevBtn) prevBtn.addEventListener("click", () => { currentPage--; renderLogs(); });
    if (nextBtn) nextBtn.addEventListener("click", () => { currentPage++; renderLogs(); });
  }

  // ── Export ──────────────────────────────────────────────────────────────────

  function exportCSV() {
    const header = "Timestamp,Action,URL,Title,Reason\n";
    const rows = filteredLogs.map((log) => {
      const date = new Date(log.timestamp || 0).toISOString();
      return [
        date,
        log.action || "",
        '"' + (log.url || "").replace(/"/g, '""') + '"',
        '"' + (log.title || "").replace(/"/g, '""') + '"',
        '"' + (log.reason || "").replace(/"/g, '""') + '"',
      ].join(",");
    });
    downloadFile("activity-report.csv", header + rows.join("\n"), "text/csv");
  }

  function exportJSON() {
    const data = JSON.stringify(filteredLogs, null, 2);
    downloadFile("activity-report.json", data, "application/json");
  }

  function downloadFile(filename, content, mimeType) {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  // ── Clear logs ─────────────────────────────────────────────────────────────

  function clearLogs() {
    if (!confirm("Clear all activity logs? This cannot be undone.")) return;
    chrome.storage.local.set({ activityLogs: [] }, () => {
      allLogs = [];
      filteredLogs = [];
      updateStats();
      renderLogs();
    });
  }

  // ── Utilities ──────────────────────────────────────────────────────────────

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  // ── Event listeners ────────────────────────────────────────────────────────

  searchInput.addEventListener("input", applyFilters);
  filterAction.addEventListener("change", applyFilters);
  filterDateFrom.addEventListener("change", applyFilters);
  filterDateTo.addEventListener("change", applyFilters);
  document.getElementById("btnExportCSV").addEventListener("click", exportCSV);
  document.getElementById("btnExportJSON").addEventListener("click", exportJSON);
  document.getElementById("btnClearLogs").addEventListener("click", clearLogs);

  // ── Init ───────────────────────────────────────────────────────────────────

  loadLogs();
})();
