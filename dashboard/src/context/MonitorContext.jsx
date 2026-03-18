"use client";

/**
 * MonitorContext — app-wide WebSocket state shared across all pages.
 *
 * Provides:
 *  - wsStatus:        "connecting" | "connected" | "disconnected"
 *  - extensionOnline: boolean — whether the extension is currently active
 *  - liveEntries:     ActivityEntry[] — real-time activity feed (newest first)
 *  - newAlertCount:   number — unseen alerts badge
 *  - clearAlerts():   reset the badge
 *  - backendUrl:      string — configurable backend HTTP(S) URL
 *  - setBackendUrl(): update and persist backend URL
 */

import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  useRef,
} from "react";

const DEFAULT_BACKEND_URL = "https://YOUR_RENDER_URL.onrender.com";
const STORAGE_KEY = "palsplan_backend_url";
const MAX_LIVE_ENTRIES = 500;

const MonitorContext = createContext(null);

export function MonitorProvider({ children }) {
  const [backendUrl, setBackendUrlState] = useState(DEFAULT_BACKEND_URL);

  // Hydrate from localStorage on mount (client-only)
  useEffect(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) setBackendUrlState(stored);
  }, []);

  const [wsStatus, setWsStatus]         = useState("disconnected");
  const [extensionOnline, setExtOnline] = useState(false);
  const [liveEntries, setLiveEntries]   = useState([]);
  const [newAlertCount, setAlertCount]  = useState(0);

  const wsRef        = useRef(null);
  const reconnectRef = useRef(null);
  const backoffRef   = useRef(1000);
  const mountedRef   = useRef(true);

  // ── WebSocket connection ────────────────────────────────────────────────

  const connect = useCallback(() => {
    if (!backendUrl || backendUrl.includes("YOUR_RENDER_URL")) return;

    const wsUrl =
      backendUrl
        .replace(/^https:/, "wss:")
        .replace(/^http:/, "ws:")
        .replace(/\/+$/, "") + "/ws?role=dashboard";

    if (mountedRef.current) setWsStatus("connecting");

    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      if (!mountedRef.current) return;
      setWsStatus("connected");
      backoffRef.current = 1000;
    };

    ws.onmessage = (event) => {
      if (!mountedRef.current) return;
      let msg;
      try { msg = JSON.parse(event.data); } catch (_e) { return; }

      if (msg.type === "activity" && msg.entry) {
        setLiveEntries((prev) => {
          const next = [msg.entry, ...prev];
          return next.length > MAX_LIVE_ENTRIES ? next.slice(0, MAX_LIVE_ENTRIES) : next;
        });
        if (msg.entry.action === "blocked") {
          setAlertCount((n) => n + 1);
        }
      } else if (msg.type === "status") {
        setExtOnline(msg.status === "online");
      }
    };

    ws.onclose = () => {
      if (!mountedRef.current) return;
      setWsStatus("disconnected");
      wsRef.current = null;
      const delay = Math.min(backoffRef.current, 30_000);
      backoffRef.current = Math.min(delay * 2, 30_000);
      reconnectRef.current = setTimeout(connect, delay);
    };

    ws.onerror = () => { ws.close(); };
  }, [backendUrl]);

  useEffect(() => {
    mountedRef.current = true;
    connect();
    return () => {
      mountedRef.current = false;
      clearTimeout(reconnectRef.current);
      wsRef.current?.close();
    };
  }, [connect]);

  // ── Backend URL change ──────────────────────────────────────────────────

  const setBackendUrl = useCallback((url) => {
    localStorage.setItem(STORAGE_KEY, url);
    setBackendUrlState(url);
    clearTimeout(reconnectRef.current);
    wsRef.current?.close();
    backoffRef.current = 1000;
  }, []);

  const clearAlerts = useCallback(() => setAlertCount(0), []);

  return (
    <MonitorContext.Provider
      value={{
        wsStatus,
        extensionOnline,
        liveEntries,
        newAlertCount,
        clearAlerts,
        backendUrl,
        setBackendUrl,
      }}
    >
      {children}
    </MonitorContext.Provider>
  );
}

export function useMonitor() {
  const ctx = useContext(MonitorContext);
  if (!ctx) throw new Error("useMonitor must be used inside <MonitorProvider>");
  return ctx;
}
