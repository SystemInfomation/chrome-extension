"use client";

import { useState } from "react";
import {
  AppWindow, X, Globe, ExternalLink, RefreshCw, Search,
} from "lucide-react";
import { useMonitor } from "../../context/MonitorContext";
import styles from "./page.module.css";

export default function TabsPage() {
  const { openTabs, closeTab, wsStatus, extensionOnline } = useMonitor();
  const [search, setSearch] = useState("");

  const canManage = wsStatus === "connected" && extensionOnline;

  const filtered = search.trim()
    ? openTabs.filter((t) => {
        const q = search.toLowerCase();
        return (
          (t.title || "").toLowerCase().includes(q) ||
          (t.url || "").toLowerCase().includes(q)
        );
      })
    : openTabs;

  // Group tabs by windowId
  const byWindow = {};
  for (const tab of filtered) {
    const wid = tab.windowId || 0;
    if (!byWindow[wid]) byWindow[wid] = [];
    byWindow[wid].push(tab);
  }
  const windowIds = Object.keys(byWindow).sort((a, b) => Number(a) - Number(b));

  return (
    <div className={styles.page}>
      {/* Header */}
      <div className={styles.header}>
        <div className={styles.headerLeft}>
          <div className={styles.headerIcon}>
            <AppWindow size={18} strokeWidth={2} />
          </div>
          <div>
            <h1 className={styles.title}>Open Tabs</h1>
            <p className={styles.subtitle}>
              {openTabs.length} tab{openTabs.length !== 1 ? "s" : ""} across{" "}
              {new Set(openTabs.map((t) => t.windowId)).size} window
              {new Set(openTabs.map((t) => t.windowId)).size !== 1 ? "s" : ""}
            </p>
          </div>
        </div>
        <div className={styles.headerRight}>
          {!canManage && (
            <span className={styles.offlineHint}>
              Extension offline — read-only
            </span>
          )}
        </div>
      </div>

      {/* Search */}
      <div className={styles.searchBar}>
        <Search size={14} strokeWidth={2} className={styles.searchIcon} />
        <input
          className={styles.searchInput}
          placeholder="Search tabs…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        {search && (
          <button
            className={styles.clearSearch}
            onClick={() => setSearch("")}
            title="Clear search"
          >
            <X size={13} strokeWidth={2} />
          </button>
        )}
      </div>

      {/* Empty state */}
      {openTabs.length === 0 && (
        <div className={styles.empty}>
          <div className={styles.emptyIcon}>
            <AppWindow size={32} strokeWidth={1.5} />
          </div>
          <div className={styles.emptyTitle}>No tabs data</div>
          <div className={styles.emptyText}>
            {canManage
              ? "Waiting for the extension to report open tabs…"
              : "Extension is offline. Open tabs will appear here when connected."}
          </div>
        </div>
      )}

      {/* Filtered empty */}
      {openTabs.length > 0 && filtered.length === 0 && (
        <div className={styles.empty}>
          <div className={styles.emptyIcon}>
            <Search size={28} strokeWidth={1.5} />
          </div>
          <div className={styles.emptyTitle}>No matching tabs</div>
          <div className={styles.emptyText}>
            No tabs match &quot;{search}&quot;. Try a different query.
          </div>
        </div>
      )}

      {/* Tab list grouped by window */}
      {windowIds.map((wid) => (
        <div key={wid} className={styles.windowGroup}>
          <div className={styles.windowHeader}>
            <Globe size={13} strokeWidth={2} />
            Window {wid}{" "}
            <span className={styles.windowCount}>
              ({byWindow[wid].length} tab{byWindow[wid].length !== 1 ? "s" : ""})
            </span>
          </div>
          <div className={styles.tabList}>
            {byWindow[wid].map((tab) => (
              <TabRow
                key={tab.id}
                tab={tab}
                onClose={() => closeTab(tab.id)}
                canClose={canManage}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function TabRow({ tab, onClose, canClose }) {
  const domain = extractDomain(tab.url);
  const faviconUrl = tab.favIconUrl || `https://www.google.com/s2/favicons?domain=${domain}&sz=32`;
  const isInternal = (tab.url || "").startsWith("chrome://") || (tab.url || "").startsWith("chrome-extension://");

  return (
    <div className={`${styles.tabRow} ${tab.active ? styles.tabRowActive : ""}`}>
      <div className={styles.tabFavicon}>
        {isInternal ? (
          <Globe size={16} strokeWidth={1.5} />
        ) : (
          <img
            src={faviconUrl}
            alt=""
            width={16}
            height={16}
            onError={(e) => { e.currentTarget.style.display = "none"; }}
          />
        )}
      </div>

      <div className={styles.tabContent}>
        <div className={styles.tabTitle} title={tab.title || tab.url}>
          {tab.title || tab.url || "Untitled"}
          {tab.active && <span className={styles.activeBadge}>Active</span>}
        </div>
        <div className={styles.tabUrl} title={tab.url}>
          <ExternalLink size={9} strokeWidth={2} />
          {domain || tab.url}
        </div>
      </div>

      {canClose && (
        <button
          className={styles.closeBtn}
          onClick={onClose}
          title="Close this tab"
        >
          <X size={14} strokeWidth={2} />
        </button>
      )}
    </div>
  );
}

function extractDomain(url) {
  try { return new URL(url).hostname.replace(/^www\./, ""); }
  catch { return url || ""; }
}
