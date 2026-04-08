"use client";

import { useState, useEffect, useCallback } from "react";
import { List, Search, Filter, Globe, ShieldOff, ChevronLeft, ChevronRight } from "lucide-react";
import { useMonitor } from "../../context/MonitorContext";
import styles from "./page.module.css";

export default function ActivityLog() {
  const { backendUrl } = useMonitor();

  const [items,   setItems]   = useState([]);
  const [total,   setTotal]   = useState(0);
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState(null);

  // Filters
  const [search,  setSearch]  = useState("");
  const [action,  setAction]  = useState("all"); // "all"|"visit"|"blocked"
  const [page,    setPage]    = useState(1);
  const LIMIT = 50;

  const fetchActivity = useCallback(async () => {
    if (!backendUrl || backendUrl.includes("YOUR_RENDER_URL")) return;
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ page, limit: LIMIT });
      if (search) params.set("search", search);
      if (action !== "all") params.set("action", action);
      const res = await fetch(`${backendUrl}/api/activity?${params}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setItems(data.items || []);
      setTotal(data.total || 0);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [backendUrl, page, search, action]);

  useEffect(() => { fetchActivity(); }, [fetchActivity]);

  // Reset page when filters change
  useEffect(() => { setPage(1); }, [search, action]);

  const totalPages = Math.max(1, Math.ceil(total / LIMIT));
  const isUnconfigured = !backendUrl || backendUrl.includes("YOUR_RENDER_URL");

  return (
    <div className={styles.page}>
      {/* Header */}
      <div className={styles.header}>
        <div className={styles.headerLeft}>
          <div className={styles.headerIcon}>
            <List size={18} strokeWidth={2} />
          </div>
          <div>
            <h1 className={styles.title}>Activity Log</h1>
            <p className={styles.subtitle}>Full browsing history</p>
          </div>
        </div>
        {!loading && !isUnconfigured && (
          <div className={styles.countBadge}>{total.toLocaleString()} entries</div>
        )}
      </div>

      {isUnconfigured ? (
        <div className={styles.notice}>Configure your backend URL in <a href="/settings">Settings</a>.</div>
      ) : (
        <>
          {/* Filters */}
          <div className={styles.filters}>
            <div className={styles.searchWrap}>
              <Search size={14} className={styles.searchIcon} />
              <input
                className={styles.searchInput}
                placeholder="Search URL or title…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            <div className={styles.filterGroup}>
              <Filter size={14} style={{ color: "var(--text-muted)", flexShrink: 0 }} />
              {["all", "visit", "blocked"].map((v) => (
                <button
                  key={v}
                  className={`${styles.filterBtn} ${action === v ? styles.filterActive : ""}`}
                  onClick={() => setAction(v)}
                >
                  {v === "all" ? "All" : v === "visit" ? "Allowed" : "Blocked"}
                </button>
              ))}
            </div>
          </div>

          {/* Error */}
          {error && <div className={styles.error}>Failed to load: {error}</div>}

          {/* Table */}
          <div className={styles.tableWrap}>
            {loading ? (
              <div className={styles.loadingRows}>
                {[...Array(8)].map((_, i) => (
                  <div key={i} className={`${styles.skeletonRow} skeleton`} />
                ))}
              </div>
            ) : items.length === 0 ? (
              <div className={styles.empty}>No activity found.</div>
            ) : (
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>Status</th>
                    <th>URL / Title</th>
                    <th>Domain</th>
                    <th>Reason</th>
                    <th>Time</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((entry) => (
                    <tr key={entry.id} className={entry.action === "blocked" ? styles.rowBlocked : ""}>
                      <td>
                        <span className={`${styles.pill} ${entry.action === "blocked" ? styles.pillRed : styles.pillGreen}`}>
                          {entry.action === "blocked"
                            ? <><ShieldOff size={11} /> Blocked</>
                            : <><Globe     size={11} /> Allowed</>}
                        </span>
                      </td>
                      <td className={styles.urlCell}>
                        <div className={styles.urlMain}>{entry.title || entry.url}</div>
                        {entry.title && <div className={styles.urlSub}>{entry.url}</div>}
                      </td>
                      <td className={styles.domainCell}>{entry.domain}</td>
                      <td className={styles.reasonCell}>{entry.reason || "—"}</td>
                      <td className={styles.timeCell}>{formatDateTime(entry.timestamp)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {/* Pagination */}
          {!loading && totalPages > 1 && (
            <div className={styles.pagination}>
              <button
                className={styles.pageBtn}
                disabled={page <= 1}
                onClick={() => setPage((p) => p - 1)}
              >
                <ChevronLeft size={14} /> Prev
              </button>
              <span className={styles.pageInfo}>
                Page {page} of {totalPages}
              </span>
              <button
                className={styles.pageBtn}
                disabled={page >= totalPages}
                onClick={() => setPage((p) => p + 1)}
              >
                Next <ChevronRight size={14} />
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function formatDateTime(ts) {
  if (!ts) return "—";
  const d = new Date(typeof ts === "string" ? Number(ts) : ts);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleString([], {
    month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}
