"use client";

/**
 * MonitorContext — app-wide WebSocket state shared across all pages.
 *
 * Provides:
 *  - wsStatus:            "connecting" | "connected" | "disconnected"
 *  - extensionOnline:     boolean — whether the extension is currently active
 *  - liveEntries:         ActivityEntry[] — real-time activity feed (newest first)
 *  - newAlertCount:       number — unseen alerts badge
 *  - clearAlerts():       reset the badge
 *  - clearLiveEntries():  empty the live feed
 *  - internetBlocked:     boolean — whether internet is blocked on the extension
 *  - toggleInternetBlock(): toggle the internet block on/off
 *  - backendUrl:          string — configurable backend HTTP(S) URL
 *  - setBackendUrl():     update and persist backend URL
 *  - liveScreenshot:      string|null — latest screenshot data URL from extension
 *  - screenStreamActive:  boolean — whether live screen stream is running
 *  - startScreenStream(): ask the extension to start sending screenshots
 *  - stopScreenStream():  ask the extension to stop sending screenshots
 *  - openTabs:            Tab[] — open browser tabs on the monitored device
 *  - closeTab(tabId):     close a tab on the monitored device
 *  - focusMode:           { enabled: boolean, allowedDomains: string[] }
 *  - setFocusMode():      enable/disable focus mode with allowed domains
 *  - updateFocusDomains(): update just the allowed domains list
 */

import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  useRef,
} from "react";

/** Default backend URL — pre-configured for this deployment. */
const DEFAULT_BACKEND_URL = "https://backend.watsons.app";
const STORAGE_KEY = "watson_ct_backend_url";
const MAX_LIVE_ENTRIES = 500;

const MonitorContext = createContext(null);

export function MonitorProvider({ children }) {
  const [backendUrl, setBackendUrlState] = useState(DEFAULT_BACKEND_URL);

  // Hydrate from localStorage on mount — lets user override from Settings
  useEffect(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) setBackendUrlState(stored);
  }, []);

  const [wsStatus, setWsStatus]               = useState("disconnected");
  const [extensionOnline, setExtOnline]        = useState(false);
  const [liveEntries, setLiveEntries]          = useState([]);
  const [newAlertCount, setAlertCount]         = useState(0);
  const [liveScreenshot, setLiveScreenshot]    = useState(null);
  const [screenStreamActive, setStreamActive] = useState(false);
  const [openTabs, setOpenTabs]               = useState([]);
  const [internetBlocked, setInternetBlocked] = useState(false);
  const [focusMode, setFocusModeState]        = useState({ enabled: false, allowedDomains: [] });

  const wsRef        = useRef(null);
  const reconnectRef = useRef(null);
  const backoffRef   = useRef(1000);
  const mountedRef   = useRef(true);
  // Stable ref so the onclose handler always calls the latest connect fn
  const connectRef   = useRef(null);

  // ── WebSocket connection ────────────────────────────────────────────────

  const connect = useCallback(() => {
    if (!backendUrl) return;

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
      // Request current internet block status from extension
      ws.send(JSON.stringify({ type: "get_internet_status" }));
      // Request current focus mode status from extension
      ws.send(JSON.stringify({ type: "get_focus_mode" }));
    };

    ws.onmessage = (event) => {
      if (!mountedRef.current) return;
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }

      if (msg.type === "activity" && msg.entry) {
        setLiveEntries((prev) => {
          const next = [msg.entry, ...prev];
          return next.length > MAX_LIVE_ENTRIES ? next.slice(0, MAX_LIVE_ENTRIES) : next;
        });
        if (msg.entry.action === "blocked") {
          setAlertCount((n) => n + 1);
        }
      } else if (msg.type === "history" && Array.isArray(msg.entries)) {
        setLiveEntries((prev) => {
          if (prev.length > 0) return prev; // already have live data — don't overwrite
          return msg.entries.slice(0, MAX_LIVE_ENTRIES);
        });
      } else if (msg.type === "status") {
        setExtOnline(msg.status === "online");
        // Monitoring and screen stream are always on when extension is online
        if (msg.status === "online") {
          setStreamActive(true);
        }
      } else if (msg.type === "screenshot" && msg.data) {
        setLiveScreenshot(msg.data);
        setStreamActive(true);
      } else if (msg.type === "screen_stream_stopped") {
        setStreamActive(false);
        setLiveScreenshot(null);
      } else if (msg.type === "open_tabs" && Array.isArray(msg.tabs)) {
        setOpenTabs(msg.tabs);
      } else if (msg.type === "internet_status") {
        setInternetBlocked(msg.blocked === true);
      } else if (msg.type === "focus_mode_status") {
        setFocusModeState({
          enabled: msg.enabled === true,
          allowedDomains: Array.isArray(msg.allowedDomains) ? msg.allowedDomains : [],
        });
      }
    };

    ws.onclose = () => {
      if (!mountedRef.current) return;
      setWsStatus("disconnected");
      setStreamActive(false);
      wsRef.current = null;
      const delay = Math.min(backoffRef.current, 30_000);
      backoffRef.current = Math.min(delay * 2, 30_000);
      // Use the ref so we always call the latest version of connect
      reconnectRef.current = setTimeout(() => connectRef.current?.(), delay);
    };

    ws.onerror = () => { ws.close(); };
  }, [backendUrl]);

  // Keep ref in sync with the latest connect fn (inside effect, not during render)
  useEffect(() => {
    connectRef.current = connect;
  });

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
  const clearLiveEntries = useCallback(() => setLiveEntries([]), []);

  // ── Screen stream controls ──────────────────────────────────────────────

  const startScreenStream = useCallback(() => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({ type: "start_screen_stream" }));
    setStreamActive(true);
    setLiveScreenshot(null);
  }, []);

  const stopScreenStream = useCallback(() => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "stop_screen_stream" }));
    }
    setStreamActive(false);
    setLiveScreenshot(null);
  }, []);

  const toggleInternetBlock = useCallback(() => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    const newState = !internetBlocked;
    wsRef.current.send(JSON.stringify({ type: "set_internet_blocked", blocked: newState }));
    setInternetBlocked(newState); // optimistic update
  }, [internetBlocked]);

  // ── Tab management ──────────────────────────────────────────────────────

  const closeTab = useCallback((tabId) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({ type: "close_tab", tabId }));
    // Optimistic removal
    setOpenTabs((prev) => prev.filter((t) => t.id !== tabId));
  }, []);

  // ── Focus Mode controls ─────────────────────────────────────────────────

  const setFocusMode = useCallback((enabled, allowedDomains) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({
      type: "set_focus_mode",
      enabled,
      allowedDomains: allowedDomains || [],
    }));
    setFocusModeState({ enabled, allowedDomains: allowedDomains || [] }); // optimistic
  }, []);

  const updateFocusDomains = useCallback((allowedDomains) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({
      type: "update_focus_domains",
      allowedDomains,
    }));
    setFocusModeState((prev) => ({ ...prev, allowedDomains })); // optimistic
  }, []);

  return (
    <MonitorContext.Provider
      value={{
        wsStatus,
        extensionOnline,
        liveEntries,
        newAlertCount,
        clearAlerts,
        clearLiveEntries,
        backendUrl,
        setBackendUrl,
        liveScreenshot,
        screenStreamActive,
        startScreenStream,
        stopScreenStream,
        openTabs,
        closeTab,
        internetBlocked,
        toggleInternetBlock,
        focusMode,
        setFocusMode,
        updateFocusDomains,
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
