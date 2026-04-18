"use client";

import { useRef, useState, useEffect } from "react";
import {
  Monitor, Eye, EyeOff, Maximize2, Minimize2,
} from "lucide-react";
import { useMonitor } from "../context/MonitorContext";
import styles from "./page.module.css";

/* ── Main Dashboard — Live View Only ─────────────────────────────────────── */

export default function Dashboard() {
  const {
    wsStatus, extensionOnline,
    liveScreenshot, screenStreamActive, startScreenStream, stopScreenStream,
  } = useMonitor();

  const [screenExpanded, setScreenExpanded] = useState(false);

  // FPS counter for live screen
  const [fps, setFps] = useState(0);
  const frameCountRef = useRef(0);
  const prevScreenRef = useRef(null);
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
    if (liveScreenshot && liveScreenshot !== prevScreenRef.current) {
      frameCountRef.current++;
      prevScreenRef.current = liveScreenshot;
    }
  }, [liveScreenshot]);

  const backendConnected = wsStatus === "connected";

  return (
    <div className={styles.dashboard}>
      {/* ── Live Screen Panel — fills the viewport ── */}
      <div className={`${styles.screenCard} ${screenExpanded ? styles.screenCardExpanded : ""}`}>
        <div className={styles.cardHeader}>
          <div className={styles.cardTitle}>
            <Monitor size={15} strokeWidth={2} />
            Live Screen
            {screenStreamActive && liveScreenshot && (
              <span className={styles.liveBadge}>
                <span className={styles.liveDot} />LIVE
                {fps > 0 && <span className={styles.fpsTag}>{fps} fps</span>}
              </span>
            )}
          </div>
          <div className={styles.headerActions}>
            {screenStreamActive ? (
              <button className={styles.streamBtn} onClick={stopScreenStream} title="Stop streaming">
                <EyeOff size={14} strokeWidth={2} />
                <span>Stop</span>
              </button>
            ) : backendConnected && extensionOnline ? (
              <button className={styles.streamBtn} onClick={startScreenStream} title="Start streaming">
                <Eye size={14} strokeWidth={2} />
                <span>Start Stream</span>
              </button>
            ) : null}
            {liveScreenshot && (
              <button
                className={styles.iconBtn}
                onClick={() => setScreenExpanded((p) => !p)}
                title={screenExpanded ? "Collapse" : "Expand"}
              >
                {screenExpanded ? <Minimize2 size={14} strokeWidth={2} /> : <Maximize2 size={14} strokeWidth={2} />}
              </button>
            )}
          </div>
        </div>

        <div className={styles.screenDisplay}>
          {liveScreenshot ? (
            <>
              <img src={liveScreenshot} alt="Live screen" className={styles.screenImg} />
              <div className={styles.screenOverlay}>
                <span className={styles.screenOverlayDot} />
                <span>Streaming · {currentTime.toLocaleTimeString()}</span>
                {fps > 0 && <span className={styles.screenOverlayFps}>{fps} fps</span>}
              </div>
            </>
          ) : (
            <div className={styles.screenPlaceholder}>
              <Monitor size={48} strokeWidth={1.2} />
              <span className={styles.placeholderTitle}>
                {screenStreamActive ? "Waiting for first frame…" : "Screen stream inactive"}
              </span>
              <span className={styles.placeholderSub}>
                {!screenStreamActive && backendConnected && extensionOnline
                  ? "Click \"Start Stream\" to begin live monitoring"
                  : !backendConnected
                    ? "Backend is disconnected"
                    : !extensionOnline
                      ? "Extension is offline"
                      : "Starting stream…"
                }
              </span>
              {!screenStreamActive && backendConnected && extensionOnline && (
                <button className={styles.startBtn} onClick={startScreenStream}>
                  <Eye size={14} strokeWidth={2} /> Start Stream
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
