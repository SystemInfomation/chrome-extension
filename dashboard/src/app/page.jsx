"use client";

import { useRef, useState, useEffect, useCallback } from "react";
import {
  Radio, Wifi, Globe, ShieldOff, Clock, Monitor, MonitorOff,
  Pause, Play, Trash2, Filter, Maximize2, Minimize2, ExternalLink,
} from "lucide-react";
import { useMonitor } from "../context/MonitorContext";
import styles from "./page.module.css";

export default function LiveView() {
  const {
    liveEntries, wsStatus, extensionOnline,
    liveScreenshot, screenStreamActive, startScreenStream, stopScreenStream,
    clearLiveEntries,
  } = useMonitor();

  const feedRef = useRef(null);
  const [paused, setPaused] = useState(false);
  const [filterMode, setFilterMode] = useState("all"); // "all" | "blocked" | "allowed"
  const pausedEntriesRef = useRef([]);

  // When paused, freeze the displayed entries
  useEffect(() => {
    if (!paused) {
      pausedEntriesRef.current = [];
    }
  }, [paused]);

  const displayEntries = paused && pausedEntriesRef.current.length > 0
    ? pausedEntriesRef.current
    : liveEntries;

  // Capture snapshot when pausing
  const togglePause = useCallback(() => {
    setPaused((prev) => {
      if (!prev) {
        pausedEntriesRef.current = [...liveEntries];
      }
      return !prev;
    });
  }, [liveEntries]);

  // Apply filter
  const filtered = filterMode === "all"
    ? displayEntries
    : displayEntries.filter((e) =>
        filterMode === "blocked" ? e.action === "blocked" : e.action !== "blocked"
      );

  const blockedCount = displayEntries.filter((e) => e.action === "blocked").length;

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
        <div className={styles.headerRight}>
          {displayEntries.length > 0 && (
            <div className={styles.entryCount}>
              <span className={styles.entryCountNum}>{displayEntries.length}</span> events
              {blockedCount > 0 && (
                <span className={styles.entryCountBlocked}>
                  · <ShieldOff size={10} strokeWidth={2.5} /> {blockedCount} blocked
                </span>
              )}
            </div>
          )}
          <ConnectionBadge wsStatus={wsStatus} extensionOnline={extensionOnline} />
        </div>
      </div>

      {/* Live Screen panel */}
      <LiveScreenPanel
        screenshot={liveScreenshot}
        active={screenStreamActive}
        extensionOnline={extensionOnline}
        wsStatus={wsStatus}
        onStart={startScreenStream}
        onStop={stopScreenStream}
      />

      {/* Feed toolbar */}
      {displayEntries.length > 0 && (
        <div className={styles.feedToolbar}>
          <div className={styles.feedToolbarLeft}>
            <button
              className={`${styles.toolBtn} ${paused ? styles.toolBtnActive : ""}`}
              onClick={togglePause}
              title={paused ? "Resume live feed" : "Pause live feed"}
            >
              {paused ? <Play size={13} strokeWidth={2} /> : <Pause size={13} strokeWidth={2} />}
              {paused ? "Resume" : "Pause"}
            </button>

            <div className={styles.filterGroup}>
              <Filter size={12} strokeWidth={2} style={{ color: "var(--text-muted)" }} />
              {["all", "blocked", "allowed"].map((mode) => (
                <button
                  key={mode}
                  className={`${styles.filterBtn} ${filterMode === mode ? styles.filterActive : ""}`}
                  onClick={() => setFilterMode(mode)}
                >
                  {mode === "all" ? "All" : mode === "blocked" ? "Blocked" : "Allowed"}
                </button>
              ))}
            </div>
          </div>

          <button
            className={styles.toolBtn}
            onClick={clearLiveEntries}
            title="Clear live feed"
          >
            <Trash2 size={12} strokeWidth={2} /> Clear
          </button>
        </div>
      )}

      {/* Empty state */}
      {filtered.length === 0 && displayEntries.length === 0 && (
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

      {/* Filtered empty state */}
      {filtered.length === 0 && displayEntries.length > 0 && (
        <div className={styles.empty}>
          <div className={styles.emptyIcon}>
            <Filter size={28} strokeWidth={1.5} />
          </div>
          <div className={styles.emptyTitle}>No matching events</div>
          <div className={styles.emptyText}>
            No {filterMode} events in the current feed. Try a different filter.
          </div>
        </div>
      )}

      {/* Live feed */}
      {filtered.length > 0 && (
        <div className={styles.feed} ref={feedRef}>
          {paused && (
            <div className={styles.pausedBanner}>
              <Pause size={12} strokeWidth={2.5} />
              Feed paused — new events are buffered
            </div>
          )}
          {filtered.map((entry, i) => (
            <ActivityRow key={entry.id || i} entry={entry} isNew={!paused && i === 0} />
          ))}
        </div>
      )}
    </div>
  );
}

function LiveScreenPanel({ screenshot, active, extensionOnline, wsStatus, onStart, onStop }) {
  const canStream = wsStatus === "connected" && extensionOnline;
  const [expanded, setExpanded] = useState(false);

  return (
    <div className={`${styles.screenPanel} ${expanded ? styles.screenPanelExpanded : ""}`}>
      <div className={styles.screenPanelHeader}>
        <div className={styles.screenPanelTitle}>
          <Monitor size={15} strokeWidth={2} />
          Live Screen
          {active && screenshot && (
            <span className={styles.screenLiveBadge}>
              <span className={styles.screenLiveDot} />LIVE
            </span>
          )}
        </div>
        <div className={styles.screenPanelControls}>
          {screenshot && (
            <button
              className={styles.screenBtn}
              onClick={() => setExpanded((prev) => !prev)}
              title={expanded ? "Collapse" : "Expand"}
            >
              {expanded
                ? <Minimize2 size={13} strokeWidth={2} />
                : <Maximize2 size={13} strokeWidth={2} />}
            </button>
          )}
          {active ? (
            <button className={`${styles.screenBtn} ${styles.screenBtnStop}`} onClick={onStop}>
              <MonitorOff size={13} strokeWidth={2} /> Stop
            </button>
          ) : (
            <button
              className={`${styles.screenBtn} ${styles.screenBtnStart}`}
              onClick={onStart}
              disabled={!canStream}
              title={!canStream ? "Extension must be online to view live screen" : "Start live screen view"}
            >
              <Monitor size={13} strokeWidth={2} /> Watch Screen
            </button>
          )}
        </div>
      </div>

      <div className={styles.screenDisplay}>
        {screenshot ? (
          <>
            <img
              src={screenshot}
              alt="Live screen capture"
              className={styles.screenImg}
            />
            <ScreenOverlay />
          </>
        ) : (
          <div className={styles.screenPlaceholder}>
            {active ? (
              <>
                <Monitor size={28} strokeWidth={1.5} className={styles.screenPlaceholderIcon} />
                <span>Waiting for first frame…</span>
              </>
            ) : (
              <>
                <Monitor size={28} strokeWidth={1.5} className={styles.screenPlaceholderIcon} />
                <span>{canStream ? 'Click "Watch Screen" to view the live screen' : "Extension offline — cannot show live screen"}</span>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function ScreenOverlay() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  return (
    <div className={styles.screenOverlay}>
      <span className={styles.screenOverlayDot} />
      <span>Streaming · {new Date(now).toLocaleTimeString()}</span>
    </div>
  );
}

function ActivityRow({ entry, isNew }) {
  const blocked    = entry.action === "blocked";
  const domain     = entry.domain || extractDomain(entry.url);
  const faviconUrl = `https://www.google.com/s2/favicons?domain=${domain}&sz=32`;

  return (
    <div className={`${styles.row} ${blocked ? styles.rowBlocked : styles.rowAllowed} ${isNew ? styles.rowNew : ""}`}>
      {/* Favicon */}
      <div className={styles.favicon}>
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
          : <Globe     size={13} strokeWidth={2} />}
      </div>

      {/* Content */}
      <div className={styles.rowContent}>
        <div className={styles.rowUrl} title={entry.url}>
          {entry.title || entry.url}
        </div>
        {entry.title && (
          <div className={styles.rowDomain}>
            <ExternalLink size={9} strokeWidth={2} />
            {domain}
          </div>
        )}
        {blocked && entry.reason && (
          <div className={styles.rowReason}>{entry.reason}</div>
        )}
      </div>

      {/* Time */}
      <div className={styles.rowTime}>
        <Clock size={11} strokeWidth={2} />
        <RelativeTime timestamp={entry.timestamp} />
      </div>
    </div>
  );
}

function RelativeTime({ timestamp }) {
  const [, setTick] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 5000);
    return () => clearInterval(id);
  }, []);

  return <span title={formatAbsoluteTime(timestamp)}>{formatRelativeTime(timestamp)}</span>;
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
  catch { return url; }
}

function formatAbsoluteTime(ts) {
  if (!ts) return "";
  const d = new Date(typeof ts === "string" ? Number(ts) : ts);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function formatRelativeTime(ts) {
  if (!ts) return "";
  const numTs = typeof ts === "string" ? Number(ts) : ts;
  const diff = Math.max(0, Math.floor((Date.now() - numTs) / 1000));
  if (diff < 5) return "just now";
  if (diff < 60) return `${diff}s ago`;
  const mins = Math.floor(diff / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return formatAbsoluteTime(ts);
}
