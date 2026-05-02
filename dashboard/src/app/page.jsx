"use client";

import { useRef, useState, useEffect, useCallback } from "react";
import {
  Monitor, Eye, EyeOff, Maximize2, Minimize2,
} from "lucide-react";
import { useMonitor } from "../context/MonitorContext";
import styles from "./page.module.css";

/* ── Helpers ──────────────────────────────────────────────────────────────── */

function getPlaceholderMessage(streaming, backend, extension) {
  if (!backend) return "Backend is disconnected";
  if (!extension) return "Extension is offline";
  if (!streaming) return "Click \"Start Stream\" to begin live monitoring";
  return "Starting stream…";
}

/* ── GlitchFreeImg — double-buffer to avoid flicker on rapid src updates ─── */

function GlitchFreeImg({ src, alt, className }) {
  const aRef = useRef(null);
  const bRef = useRef(null);
  // "a" is the currently visible buffer; "b" is loading the next frame
  const visibleRef = useRef("a");

  useEffect(() => {
    if (!src) return;
    const nextBuf = visibleRef.current === "a" ? "b" : "a";
    const nextImg = nextBuf === "a" ? aRef.current : bRef.current;
    const curImg  = nextBuf === "a" ? bRef.current : aRef.current;
    if (!nextImg || !curImg) return;

    const onLoad = () => {
      // Swap: make the newly-loaded image visible, hide the old one
      nextImg.style.opacity = "1";
      nextImg.style.zIndex  = "2";
      curImg.style.opacity  = "0";
      curImg.style.zIndex   = "1";
      visibleRef.current = nextBuf;
    };

    nextImg.onload = onLoad;
    nextImg.src    = src;

    // If the image is already cached it fires load synchronously in some browsers
    if (nextImg.complete && nextImg.naturalWidth > 0) onLoad();
  }, [src]);

  return (
    <div className={styles.bufferWrap}>
      <img ref={aRef} alt={alt} className={`${className} ${styles.bufferImg}`}
           style={{ opacity: 1, zIndex: 2 }} />
      <img ref={bRef} alt={alt} className={`${className} ${styles.bufferImg}`}
           style={{ opacity: 0, zIndex: 1 }} />
    </div>
  );
}

/* ── Main Dashboard — Live View Only ─────────────────────────────────────── */

export default function Dashboard() {
  const {
    wsStatus, extensionOnline,
    liveScreenshot, screenStreamActive, startScreenStream, stopScreenStream,
    windowScreenshots, selectedUserLabel,
  } = useMonitor();

  const [screenExpanded, setScreenExpanded] = useState(false);

  // FPS counter — counts new frames across all windows
  const [fps, setFps] = useState(0);
  const frameCountRef  = useRef(0);
  const prevShotRef    = useRef(null);
  const [currentTime, setCurrentTime] = useState(() => new Date());

  useEffect(() => {
    const id = setInterval(() => setCurrentTime(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    const id = setInterval(() => {
      setFps(frameCountRef.current);
      frameCountRef.current = 0;
    }, 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (liveScreenshot && liveScreenshot !== prevShotRef.current) {
      frameCountRef.current++;
      prevShotRef.current = liveScreenshot;
    }
  }, [liveScreenshot]);

  const backendConnected = wsStatus === "connected";

  // Derive ordered window list: focused (active) window first
  const windowEntries = Array.from(windowScreenshots.entries())
    .sort(([, a], [, b]) => (b.focused ? 1 : 0) - (a.focused ? 1 : 0));

  const hasScreenshot = windowEntries.length > 0;
  const activeEntry   = windowEntries.find(([, v]) => v.focused)?.[1]
    ?? windowEntries[0]?.[1]
    ?? null;
  const secondaryEntries = windowEntries.filter(([, v]) => !v.focused || windowEntries.length === 1 ? false : true);

  // Handler to expand to full screen
  const toggleExpand = useCallback(() => setScreenExpanded((p) => !p), []);

  return (
    <div className={styles.dashboard}>
      {/* ── Live Screen Panel — fills the viewport ── */}
      <div className={`${styles.screenCard} ${screenExpanded ? styles.screenCardExpanded : ""}`}>
        <div className={styles.cardHeader}>
          <div className={styles.cardTitle}>
            <Monitor size={15} strokeWidth={2} />
            Live Screen ({selectedUserLabel})
            {screenStreamActive && hasScreenshot && (
              <span className={styles.liveBadge}>
                <span className={styles.liveDot} />LIVE
                {fps > 0 && <span className={styles.fpsTag}>{fps} fps</span>}
              </span>
            )}
            {windowEntries.length > 1 && (
              <span className={styles.windowCount}>
                {windowEntries.length} windows
              </span>
            )}
          </div>
          <div className={styles.headerActions}>
            {screenStreamActive ? (
              <button className={styles.streamBtn} onClick={stopScreenStream} title="Stop streaming" aria-label="Stop screen stream">
                <EyeOff size={14} strokeWidth={2} />
                <span>Stop</span>
              </button>
            ) : backendConnected && extensionOnline ? (
              <button className={styles.streamBtn} onClick={startScreenStream} title="Start streaming" aria-label="Start screen stream">
                <Eye size={14} strokeWidth={2} />
                <span>Start Stream</span>
              </button>
            ) : null}
            {hasScreenshot && (
              <button
                className={styles.iconBtn}
                onClick={toggleExpand}
                title={screenExpanded ? "Collapse" : "Expand"}
              >
                {screenExpanded ? <Minimize2 size={14} strokeWidth={2} /> : <Maximize2 size={14} strokeWidth={2} />}
              </button>
            )}
          </div>
        </div>

        <div className={styles.screenBody}>
          {/* ── Primary (active/focused) window ── */}
          <div className={styles.primaryDisplay}>
            {activeEntry ? (
              <>
                <GlitchFreeImg
                  src={activeEntry.data}
                  alt="Active window"
                  className={styles.screenImg}
                />
                <div className={styles.screenOverlay}>
                  <span className={styles.screenOverlayDot} />
                  <span>Active · {currentTime.toLocaleTimeString()}</span>
                  {fps > 0 && <span className={styles.screenOverlayFps}>{fps} fps</span>}
                </div>
                {activeEntry.title && (
                  <div className={styles.windowTitleBar}>
                    <Monitor size={10} strokeWidth={2} />
                    <span>{activeEntry.title}</span>
                  </div>
                )}
              </>
            ) : (
              <div className={styles.screenPlaceholder}>
                <Monitor size={48} strokeWidth={1.2} />
                <span className={styles.placeholderTitle}>
                  {screenStreamActive ? "Waiting for first frame…" : "Screen stream inactive"}
                </span>
                <span className={styles.placeholderSub}>
                  {getPlaceholderMessage(screenStreamActive, backendConnected, extensionOnline)}
                </span>
                {!screenStreamActive && backendConnected && extensionOnline && (
                  <button className={styles.startBtn} onClick={startScreenStream}>
                    <Eye size={14} strokeWidth={2} /> Start Stream
                  </button>
                )}
              </div>
            )}
          </div>

          {/* ── Secondary windows row (background windows) ── */}
          {secondaryEntries.length > 0 && (
            <div className={styles.secondaryRow}>
              {secondaryEntries.map(([key, entry]) => (
                <div key={key} className={styles.secondaryWindow}>
                  <GlitchFreeImg
                    src={entry.data}
                    alt="Background window"
                    className={styles.secondaryImg}
                  />
                  <div className={styles.secondaryLabel}>
                    <Monitor size={9} strokeWidth={2} />
                    <span>{entry.title || "Window"}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
