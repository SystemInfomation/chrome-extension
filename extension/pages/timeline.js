/**
 * Incident Timeline Page — InternetWize
 *
 * Displays a chronological visual timeline of all blocked incidents,
 * VPN bypass attempts, SafeSearch violations, and HTTPS/SSL flags.
 * Supports type/severity/date filters and clickable detail views.
 */

/* eslint-env browser */
/* global chrome */

(function () {
  "use strict";

  const ITEMS_PER_PAGE = 30;
  let currentPage = 1;
  let allIncidents = [];
  let filteredIncidents = [];

  // ── DOM references ─────────────────────────────────────────────────────────

  const timelineEl = document.getElementById("timeline");
  const emptyState = document.getElementById("emptyState");
  const pagination = document.getElementById("pagination");
  const filterType = document.getElementById("filterType");
  const filterSeverity = document.getElementById("filterSeverity");
  const filterDateFrom = document.getElementById("filterDateFrom");
  const filterDateTo = document.getElementById("filterDateTo");
  const detailModal = document.getElementById("detailModal");
  const modalBody = document.getElementById("modalBody");
  const modalTitle = document.getElementById("modalTitle");

  // ── Load incidents from storage ────────────────────────────────────────────

  function loadIncidents() {
    chrome.storage.local.get(["incidentTimeline"], (result) => {
      allIncidents = result.incidentTimeline || [];
      // Sort newest first
      allIncidents.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
      applyFilters();
    });
  }

  // ── Filtering ──────────────────────────────────────────────────────────────

  function applyFilters() {
    const typeFilter = filterType.value;
    const severityFilter = filterSeverity.value;
    const dateFrom = filterDateFrom.value
      ? new Date(filterDateFrom.value).getTime()
      : 0;
    const dateTo = filterDateTo.value
      ? new Date(filterDateTo.value).getTime() + 86400000
      : Infinity;

    filteredIncidents = allIncidents.filter((inc) => {
      if (typeFilter !== "all" && inc.type !== typeFilter) return false;
      if (severityFilter !== "all" && inc.severity !== severityFilter) return false;
      const ts = inc.timestamp || 0;
      if (ts < dateFrom || ts > dateTo) return false;
      return true;
    });

    currentPage = 1;
    renderTimeline();
  }

  // ── Rendering ──────────────────────────────────────────────────────────────

  /**
   * Map incident types to human-readable labels and severity-to-dot colors.
   */
  const TYPE_LABELS = {
    blocked: "Blocked Site",
    vpn_attempt: "VPN/Proxy Attempt",
    safesearch_bypass: "SafeSearch Bypass",
    ssl_flag: "HTTPS/SSL Flag",
  };

  const SEVERITY_DOT = {
    critical: "dot-danger",
    high: "dot-danger",
    medium: "dot-warning",
    low: "dot-info",
  };

  const SEVERITY_BADGE = {
    critical: "badge-danger",
    high: "badge-danger",
    medium: "badge-warning",
    low: "badge-info",
  };

  function renderTimeline() {
    const start = (currentPage - 1) * ITEMS_PER_PAGE;
    const end = start + ITEMS_PER_PAGE;
    const page = filteredIncidents.slice(start, end);

    if (filteredIncidents.length === 0) {
      timelineEl.style.display = "none";
      emptyState.style.display = "block";
      pagination.innerHTML = "";
      return;
    }

    timelineEl.style.display = "block";
    emptyState.style.display = "none";
    timelineEl.innerHTML = "";

    let lastDateStr = "";

    for (let i = 0; i < page.length; i++) {
      const inc = page[i];
      const date = new Date(inc.timestamp || 0);
      const dateStr = date.toLocaleDateString();
      const timeStr = date.toLocaleTimeString();

      // Date separator
      if (dateStr !== lastDateStr) {
        const sep = document.createElement("div");
        sep.className = "text-muted text-sm mb-4 mt-4";
        sep.style.fontWeight = "600";
        sep.textContent = dateStr;
        timelineEl.appendChild(sep);
        lastDateStr = dateStr;
      }

      const dotClass = SEVERITY_DOT[inc.severity] || "dot-info";
      const badgeClass = SEVERITY_BADGE[inc.severity] || "badge-info";
      const typeLabel = TYPE_LABELS[inc.type] || inc.type || "Unknown";

      const item = document.createElement("div");
      item.className = "timeline-item";
      item.dataset.index = start + i;
      item.innerHTML = `
        <div class="dot ${dotClass}"></div>
        <div class="timeline-card">
          <div class="time">${escapeHtml(timeStr)}</div>
          <div class="title">${escapeHtml(inc.reason || typeLabel)}</div>
          <div class="detail">${escapeHtml(inc.url || "")}</div>
          <div class="meta">
            <span class="badge ${badgeClass}">${escapeHtml(inc.severity || "low")}</span>
            <span class="badge badge-info">${escapeHtml(typeLabel)}</span>
          </div>
        </div>
      `;
      item.addEventListener("click", () => showDetail(inc));
      timelineEl.appendChild(item);
    }

    renderPagination();
  }

  function renderPagination() {
    const totalPages = Math.ceil(filteredIncidents.length / ITEMS_PER_PAGE);
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
      " </span>";
    html +=
      '<button class="btn btn-outline btn-sm" id="nextPage" ' +
      (currentPage >= totalPages ? "disabled" : "") +
      ">Next →</button>";

    pagination.innerHTML = html;

    const prevBtn = document.getElementById("prevPage");
    const nextBtn = document.getElementById("nextPage");
    if (prevBtn) prevBtn.addEventListener("click", () => { currentPage--; renderTimeline(); });
    if (nextBtn) nextBtn.addEventListener("click", () => { currentPage++; renderTimeline(); });
  }

  // ── Detail modal ───────────────────────────────────────────────────────────

  function showDetail(inc) {
    const date = new Date(inc.timestamp || 0);
    const typeLabel = TYPE_LABELS[inc.type] || inc.type || "Unknown";
    const badgeClass = SEVERITY_BADGE[inc.severity] || "badge-info";

    let html = `
      <div class="field">
        <div class="field-label">Type</div>
        <div class="field-value">${escapeHtml(typeLabel)}</div>
      </div>
      <div class="field">
        <div class="field-label">Severity</div>
        <div class="field-value"><span class="badge ${badgeClass}">${escapeHtml(inc.severity || "low")}</span></div>
      </div>
      <div class="field">
        <div class="field-label">Date &amp; Time</div>
        <div class="field-value">${escapeHtml(date.toLocaleString())}</div>
      </div>
      <div class="field">
        <div class="field-label">URL</div>
        <div class="field-value">${escapeHtml(inc.url || "N/A")}</div>
      </div>
      <div class="field">
        <div class="field-label">Reason</div>
        <div class="field-value">${escapeHtml(inc.reason || "N/A")}</div>
      </div>
    `;

    if (inc.domain) {
      html += `
        <div class="field">
          <div class="field-label">Domain</div>
          <div class="field-value">${escapeHtml(inc.domain)}</div>
        </div>
      `;
    }

    if (inc.detail) {
      html += `
        <div class="field">
          <div class="field-label">Additional Detail</div>
          <div class="field-value">${escapeHtml(inc.detail)}</div>
        </div>
      `;
    }

    if (inc.screenshot) {
      html += `
        <div class="field">
          <div class="field-label">Screenshot</div>
          <img src="${escapeHtml(inc.screenshot)}" class="screenshot-preview" alt="Screenshot at time of incident">
        </div>
      `;
    }

    modalTitle.textContent = typeLabel + " — Incident Details";
    modalBody.innerHTML = html;
    detailModal.classList.add("active");
  }

  function hideDetail() {
    detailModal.classList.remove("active");
  }

  // ── Utilities ──────────────────────────────────────────────────────────────

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  // ── Event listeners ────────────────────────────────────────────────────────

  filterType.addEventListener("change", applyFilters);
  filterSeverity.addEventListener("change", applyFilters);
  filterDateFrom.addEventListener("change", applyFilters);
  filterDateTo.addEventListener("change", applyFilters);
  document.getElementById("btnRefresh").addEventListener("click", loadIncidents);
  document.getElementById("modalClose").addEventListener("click", hideDetail);
  detailModal.addEventListener("click", (e) => {
    if (e.target === detailModal) hideDetail();
  });

  // ── Init ───────────────────────────────────────────────────────────────────

  loadIncidents();
})();
