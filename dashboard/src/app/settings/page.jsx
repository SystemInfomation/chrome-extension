"use client";

import { useState, useEffect, useCallback } from "react";
import { Settings, Wifi, WifiOff, Plus, Trash2, RefreshCw, CheckCircle } from "lucide-react";
import { useMonitor } from "../../context/MonitorContext";
import styles from "./page.module.css";

export default function SettingsPage() {
  const { backendUrl, setBackendUrl, wsStatus, extensionOnline } = useMonitor();

  // Backend URL editor
  const [urlDraft, setUrlDraft] = useState(backendUrl);
  const [urlSaved, setUrlSaved] = useState(false);

  useEffect(() => { setUrlDraft(backendUrl); }, [backendUrl]);

  function saveUrl() {
    const trimmed = urlDraft.trim().replace(/\/$/, "");
    setBackendUrl(trimmed);
    setUrlSaved(true);
    setTimeout(() => setUrlSaved(false), 2000);
  }

  // Custom filters
  const [filters,    setFilters]   = useState([]);
  const [filterLoad, setFilterLoad] = useState(false);
  const [filterErr,  setFilterErr]  = useState(null);
  const [newDomain,  setNewDomain]  = useState("");
  const [adding,     setAdding]     = useState(false);

  const isUnconfigured = !backendUrl || backendUrl.includes("YOUR_RENDER_URL");

  const loadFilters = useCallback(async () => {
    if (isUnconfigured) return;
    setFilterLoad(true);
    setFilterErr(null);
    try {
      const res = await fetch(`${backendUrl}/api/filters`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setFilters(data.filters || []);
    } catch (err) {
      setFilterErr(err.message);
    } finally {
      setFilterLoad(false);
    }
  }, [backendUrl, isUnconfigured]);

  useEffect(() => { loadFilters(); }, [loadFilters]);

  async function addFilter(e) {
    e.preventDefault();
    const domain = newDomain.trim().toLowerCase().replace(/^www\./, "");
    if (!domain) return;
    setAdding(true);
    setFilterErr(null);
    try {
      const res = await fetch(`${backendUrl}/api/filters`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ domain }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setFilters(data.filters || []);
      setNewDomain("");
    } catch (err) {
      setFilterErr(err.message);
    } finally {
      setAdding(false);
    }
  }

  async function removeFilter(domain) {
    setFilterErr(null);
    try {
      const res = await fetch(`${backendUrl}/api/filters/${encodeURIComponent(domain)}`, { method: "DELETE" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setFilters(data.filters || []);
    } catch (err) {
      setFilterErr(err.message);
    }
  }

  return (
    <div className={styles.page}>
      {/* Header */}
      <div className={styles.header}>
        <div className={styles.headerLeft}>
          <div className={styles.headerIcon}>
            <Settings size={18} strokeWidth={2} />
          </div>
          <div>
            <h1 className={styles.title}>Settings</h1>
            <p className={styles.subtitle}>Configure monitoring & filters</p>
          </div>
        </div>
      </div>

      {/* Connection status card */}
      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Connection Status</h2>
        <div className={styles.card}>
          <StatusRow
            label="Backend"
            value={
              wsStatus === "connected"  ? "Connected"   :
              wsStatus === "connecting" ? "Connecting…" :
              "Disconnected"
            }
            color={
              wsStatus === "connected"  ? "var(--green)"  :
              wsStatus === "connecting" ? "var(--yellow)" :
              "var(--red)"
            }
          />
          <StatusRow
            label="Extension"
            value={extensionOnline ? "Online" : "Offline"}
            color={extensionOnline ? "var(--green)" : "var(--red)"}
          />
        </div>
      </section>

      {/* Backend URL */}
      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Backend URL</h2>
        <p className={styles.sectionDesc}>
          Your Render.com server URL. Replace <code>YOUR_RENDER_URL</code> after deploying.
        </p>
        <div className={styles.card}>
          <div className={styles.urlRow}>
            <input
              className={styles.input}
              value={urlDraft}
              onChange={(e) => setUrlDraft(e.target.value)}
              placeholder="https://your-app.onrender.com"
              onKeyDown={(e) => { if (e.key === "Enter") saveUrl(); }}
            />
            <button className={`${styles.btn} ${styles.btnPrimary}`} onClick={saveUrl}>
              {urlSaved ? <><CheckCircle size={14} /> Saved!</> : "Save"}
            </button>
          </div>
          <p className={styles.hint}>
            The extension connects to <code>{backendUrl || "—"}/ws</code>
          </p>
        </div>
      </section>

      {/* Custom blocked domains */}
      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Custom Blocked Domains</h2>
        <p className={styles.sectionDesc}>
          Domains added here are sent to the extension and blocked in real-time.
        </p>

        {isUnconfigured ? (
          <div className={styles.notice}>Configure the Backend URL above first.</div>
        ) : (
          <div className={styles.card}>
            {/* Add form */}
            <form className={styles.addRow} onSubmit={addFilter}>
              <input
                className={styles.input}
                value={newDomain}
                onChange={(e) => setNewDomain(e.target.value)}
                placeholder="example.com"
                disabled={adding}
              />
              <button
                type="submit"
                className={`${styles.btn} ${styles.btnPrimary}`}
                disabled={adding || !newDomain.trim()}
              >
                {adding ? <RefreshCw size={14} className={styles.spin} /> : <Plus size={14} />}
                Add
              </button>
            </form>

            {filterErr && <div className={styles.filterErr}>{filterErr}</div>}

            {/* List */}
            {filterLoad ? (
              <div className={styles.skeletonList}>
                {[...Array(3)].map((_, i) => (
                  <div key={i} className={`${styles.skeletonItem} skeleton`} />
                ))}
              </div>
            ) : filters.length === 0 ? (
              <div className={styles.filterEmpty}>No custom filters yet.</div>
            ) : (
              <ul className={styles.filterList}>
                {filters.map((domain) => (
                  <li key={domain} className={styles.filterItem}>
                    <span className={styles.filterDomain}>{domain}</span>
                    <button
                      className={styles.removeBtn}
                      onClick={() => removeFilter(domain)}
                      title="Remove"
                    >
                      <Trash2 size={13} strokeWidth={2} />
                    </button>
                  </li>
                ))}
              </ul>
            )}

            <button className={`${styles.btn} ${styles.btnGhost}`} onClick={loadFilters} style={{ marginTop: 12 }}>
              <RefreshCw size={13} /> Refresh
            </button>
          </div>
        )}
      </section>
    </div>
  );
}

function StatusRow({ label, value, color }) {
  return (
    <div className={styles.statusRow}>
      <span className={styles.statusLabel}>{label}</span>
      <span className={styles.statusValue} style={{ color }}>
        <span className={styles.statusDot} style={{ background: color }} />
        {value}
      </span>
    </div>
  );
}
