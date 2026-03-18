"use client";

import { useState, useEffect, useCallback } from "react";
import { AlertTriangle, ShieldOff, ChevronLeft, ChevronRight } from "lucide-react";
import { useMonitor } from "../../context/MonitorContext";
import styles from "./page.module.css";

const SEVERITY_META = {
  critical: { label: "Critical", color: "var(--red)",    bg: "var(--red-dim)",    border: "rgba(248,113,113,0.25)" },
  high:     { label: "High",     color: "var(--orange)",  bg: "var(--orange-dim)", border: "rgba(251,146,60,0.25)"  },
  medium:   { label: "Medium",   color: "var(--yellow)",  bg: "var(--yellow-dim)", border: "rgba(251,191,36,0.25)"  },
  low:      { label: "Low",      color: "var(--purple)",  bg: "var(--purple-dim)", border: "rgba(167,139,250,0.25)" },
};

export default function Alerts() {
  const { backendUrl, clearAlerts } = useMonitor();

  const [items,   setItems]   = useState([]);
  const [total,   setTotal]   = useState(0);
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState(null);
  const [page,    setPage]    = useState(1);
  const LIMIT = 50;

  // Clear badge on mount
  useEffect(() => { clearAlerts(); }, [clearAlerts]);

  const fetchAlerts = useCallback(async () => {
    if (!backendUrl || backendUrl.includes("YOUR_RENDER_URL")) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${backendUrl}/api/alerts?page=${page}&limit=${LIMIT}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setItems(data.items || []);
      setTotal(data.total || 0);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [backendUrl, page]);

  useEffect(() => { fetchAlerts(); }, [fetchAlerts]);

  const totalPages = Math.max(1, Math.ceil(total / LIMIT));
  const isUnconfigured = !backendUrl || backendUrl.includes("YOUR_RENDER_URL");

  return (
    <div className={styles.page}>
      {/* Header */}
      <div className={styles.header}>
        <div className={styles.headerLeft}>
          <div className={styles.headerIcon}>
            <AlertTriangle size={18} strokeWidth={2} />
          </div>
          <div>
            <h1 className={styles.title}>Alerts</h1>
            <p className={styles.subtitle}>Blocked site access attempts</p>
          </div>
        </div>
        {!loading && !isUnconfigured && (
          <div className={styles.countBadge}>{total.toLocaleString()} alerts</div>
        )}
      </div>

      {isUnconfigured ? (
        <div className={styles.notice}>Configure your backend URL in <a href="/settings">Settings</a>.</div>
      ) : error ? (
        <div className={styles.error}>Failed to load: {error}</div>
      ) : loading ? (
        <div className={styles.alertList}>
          {[...Array(6)].map((_, i) => (
            <div key={i} className={`${styles.skeletonCard} skeleton`} />
          ))}
        </div>
      ) : items.length === 0 ? (
        <div className={styles.empty}>
          <div className={styles.emptyIcon}><ShieldOff size={28} strokeWidth={1.5} /></div>
          <div className={styles.emptyTitle}>No alerts yet</div>
          <div className={styles.emptyText}>Blocked site attempts will appear here.</div>
        </div>
      ) : (
        <>
          <div className={styles.alertList}>
            {items.map((alert) => {
              const meta = SEVERITY_META[alert.severity] || SEVERITY_META.low;
              return (
                <div
                  key={alert.id}
                  className={styles.alertCard}
                  style={{ borderLeftColor: meta.color }}
                >
                  <div
                    className={styles.severityBadge}
                    style={{ background: meta.bg, color: meta.color, borderColor: meta.border }}
                  >
                    <AlertTriangle size={11} strokeWidth={2.5} />
                    {meta.label}
                  </div>

                  <div className={styles.alertContent}>
                    <div className={styles.alertUrl} title={alert.url}>{alert.url}</div>
                    <div className={styles.alertMeta}>
                      <span className={styles.alertDomain}>{alert.domain}</span>
                      <span className={styles.alertReason}>{alert.reason}</span>
                    </div>
                  </div>

                  <div className={styles.alertTime}>{formatDateTime(alert.timestamp)}</div>
                </div>
              );
            })}
          </div>

          {totalPages > 1 && (
            <div className={styles.pagination}>
              <button className={styles.pageBtn} disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                <ChevronLeft size={14} /> Prev
              </button>
              <span className={styles.pageInfo}>Page {page} of {totalPages}</span>
              <button className={styles.pageBtn} disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>
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
  return new Date(ts).toLocaleString([], {
    month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}
