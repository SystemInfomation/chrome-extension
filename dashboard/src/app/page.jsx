"use client";

import { useEffect, useRef } from "react";
import { Radio, Wifi, WifiOff, Globe, ShieldOff, Clock } from "lucide-react";
import { useMonitor } from "../context/MonitorContext";
import styles from "./page.module.css";

export default function LiveView() {
  const { liveEntries, wsStatus, extensionOnline, backendUrl } = useMonitor();
  const listRef = useRef(null);

  const isUnconfigured = !backendUrl || backendUrl.includes("YOUR_RENDER_URL");

  return (
    <div className={styles.page}>
      {/* Header */}
      <div className={styles.header}>
        <div className={styles.headerLeft}>
          <div className={styles.headerIcon}>
            <Radio size={18} strokeWidth={2} />
          </div>
          <div>
            <h1 className={styles.title}>Live View</h1>
            <p className={styles.subtitle}>Real-time browsing activity</p>
          </div>
        </div>
        <ConnectionBadge wsStatus={wsStatus} extensionOnline={extensionOnline} />
      </div>

      {/* Unconfigured notice */}
      {isUnconfigured && (
        <div className={styles.notice}>
          <WifiOff size={16} />
          <span>
            Backend URL not configured. Go to{" "}
            <a href="/settings">Settings</a> to set your Render.com URL.
          </span>
        </div>
      )}

      {/* Empty state */}
      {!isUnconfigured && liveEntries.length === 0 && (
        <div className={styles.empty}>
          <div className={styles.emptyIcon}>
            <Radio size={32} strokeWidth={1.5} />
          </div>
          <div className={styles.emptyTitle}>Waiting for activity…</div>
          <div className={styles.emptyText}>
            {wsStatus === "connected"
              ? "Connected. Browsing events will appear here in real-time."
              : wsStatus === "connecting"
              ? "Connecting to backend…"
              : "Not connected to backend. Check Settings."}
          </div>
        </div>
      )}

      {/* Live feed */}
      {liveEntries.length > 0 && (
        <div className={styles.feed} ref={listRef}>
          {liveEntries.map((entry, i) => (
            <ActivityRow key={entry.id || i} entry={entry} isNew={i === 0} />
          ))}
        </div>
      )}
    </div>
  );
}

function ActivityRow({ entry, isNew }) {
  const blocked = entry.action === "blocked";
  const domain  = entry.domain || extractDomain(entry.url);
  const time    = formatTime(entry.timestamp);
  const faviconUrl = `https://www.google.com/s2/favicons?domain=${domain}&sz=32`;

  return (
    <div className={`${styles.row} ${blocked ? styles.rowBlocked : styles.rowAllowed} ${isNew ? styles.rowNew : ""}`}>
      {/* Favicon */}
      <div className={styles.favicon}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={faviconUrl}
          alt=""
          width={16}
          height={16}
          onError={(e) => { e.currentTarget.style.display = "none"; }}
        />
      </div>

      {/* Status icon */}
      <div className={`${styles.actionIcon} ${blocked ? styles.actionBlocked : styles.actionAllowed}`}>
        {blocked
          ? <ShieldOff size={13} strokeWidth={2.5} />
          : <Globe      size={13} strokeWidth={2} />}
      </div>

      {/* Content */}
      <div className={styles.rowContent}>
        <div className={styles.rowUrl} title={entry.url}>
          {entry.title || entry.url}
        </div>
        {entry.title && (
          <div className={styles.rowDomain}>{entry.url}</div>
        )}
        {blocked && entry.reason && (
          <div className={styles.rowReason}>{entry.reason}</div>
        )}
      </div>

      {/* Time */}
      <div className={styles.rowTime}>
        <Clock size={11} strokeWidth={2} />
        {time}
      </div>
    </div>
  );
}

function ConnectionBadge({ wsStatus, extensionOnline }) {
  if (wsStatus === "connected" && extensionOnline) {
    return (
      <div className={`${styles.badge} ${styles.badgeGreen}`}>
        <span className={styles.badgeDot} style={{ background: "var(--green)" }} />
        Extension Online
      </div>
    );
  }
  if (wsStatus === "connected") {
    return (
      <div className={`${styles.badge} ${styles.badgeYellow}`}>
        <span className={styles.badgeDot} style={{ background: "var(--yellow)" }} />
        Extension Offline
      </div>
    );
  }
  if (wsStatus === "connecting") {
    return (
      <div className={`${styles.badge} ${styles.badgeYellow}`}>
        <span className={styles.badgeDot} style={{ background: "var(--yellow)" }} />
        Connecting…
      </div>
    );
  }
  return (
    <div className={`${styles.badge} ${styles.badgeRed}`}>
      <Wifi size={12} strokeWidth={2} />
      Disconnected
    </div>
  );
}

function extractDomain(url) {
  try { return new URL(url).hostname.replace(/^www\./, ""); }
  catch (_e) { return url; }
}

function formatTime(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}
