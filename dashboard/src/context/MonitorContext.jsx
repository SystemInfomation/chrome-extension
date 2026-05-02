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
 *  - liveScreenshot:      string|null — latest screenshot of the focused window (backward compat)
 *  - screenStreamActive:  boolean — whether live screen stream is running
 *  - startScreenStream(): ask the extension to start sending screenshots
 *  - stopScreenStream():  ask the extension to stop sending screenshots
 *  - windowScreenshots:   Map<string, {data, focused, url, title, timestamp}> — per-window screenshots
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
  useMemo,
} from "react";

/** Default backend URL — pre-configured for this deployment. */
const DEFAULT_BACKEND_URL = "https://backend.watsons.app";
const STORAGE_KEY = "watson_ct_backend_url";
const SELECTED_USER_STORAGE_KEY = "watson_ct_selected_monitored_user";
const MAX_LIVE_ENTRIES = 500;
const DEFAULT_USER_ID = "default";

const MonitorContext = createContext(null);

export function MonitorProvider({ children }) {
  const [backendUrl, setBackendUrlState] = useState(DEFAULT_BACKEND_URL);
  const [selectedMonitoredUserId, setSelectedMonitoredUserId] = useState(DEFAULT_USER_ID);
  const [monitoredUsers, setMonitoredUsers] = useState([{ monitoredUserId: DEFAULT_USER_ID, online: false }]);

  // Hydrate from localStorage on mount — lets user override from Settings
  useEffect(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) setBackendUrlState(stored);
    const selected = localStorage.getItem(SELECTED_USER_STORAGE_KEY);
    if (selected) setSelectedMonitoredUserId(selected);
  }, []);

  const [wsStatus, setWsStatus]               = useState("disconnected");
  const [liveStateByUser, setLiveStateByUser]  = useState(() => new Map());
  const [newAlertCount, setAlertCount]         = useState(0);

  const getUserState = useCallback((userId) => {
    const key = userId || DEFAULT_USER_ID;
    return liveStateByUser.get(key) || {
      extensionOnline: false,
      liveEntries: [],
      liveScreenshot: null,
      screenStreamActive: false,
      windowScreenshots: new Map(),
      openTabs: [],
      internetBlocked: false,
      focusMode: { enabled: false, allowedDomains: [] },
    };
  }, [liveStateByUser]);

  const selectedUserState = getUserState(selectedMonitoredUserId);

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
        .replace(/\/+$/, "") + `/ws?role=dashboard&monitoredUserId=${encodeURIComponent(selectedMonitoredUserId)}`;

    if (mountedRef.current) setWsStatus("connecting");

    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      if (!mountedRef.current) return;
      setWsStatus("connected");
      backoffRef.current = 1000;
      ws.send(JSON.stringify({ type: "get_internet_status", monitoredUserId: selectedMonitoredUserId }));
      ws.send(JSON.stringify({ type: "get_focus_mode", monitoredUserId: selectedMonitoredUserId }));
    };

    ws.onmessage = (event) => {
      if (!mountedRef.current) return;
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }
      const userId = msg.monitoredUserId || selectedMonitoredUserId || DEFAULT_USER_ID;

      if (msg.type === "activity" && msg.entry) {
        setLiveStateByUser((prev) => {
          const next = new Map(prev);
          const current = getUserState(userId);
          const liveEntries = [msg.entry, ...current.liveEntries];
          next.set(userId, { ...current, liveEntries: liveEntries.slice(0, MAX_LIVE_ENTRIES) });
          return next;
        });
        if (msg.entry.action === "blocked" && userId === selectedMonitoredUserId) {
          setAlertCount((n) => n + 1);
        }
      } else if (msg.type === "history" && Array.isArray(msg.entries)) {
        setLiveStateByUser((prev) => {
          const next = new Map(prev);
          const current = getUserState(userId);
          if (current.liveEntries.length > 0) return prev;
          next.set(userId, { ...current, liveEntries: msg.entries.slice(0, MAX_LIVE_ENTRIES) });
          return next;
        });
      } else if (msg.type === "status") {
        const online = msg.status === "online";
        setMonitoredUsers((prev) => {
          const map = new Map(prev.map((u) => [u.monitoredUserId, u]));
          map.set(userId, { monitoredUserId: userId, online });
          return [...map.values()].sort((a, b) => a.monitoredUserId.localeCompare(b.monitoredUserId));
        });
        setLiveStateByUser((prev) => {
          const next = new Map(prev);
          const current = getUserState(userId);
          next.set(userId, { ...current, extensionOnline: online, screenStreamActive: online ? true : current.screenStreamActive });
          return next;
        });
      } else if (msg.type === "screenshot" && msg.data) {
        const key = msg.windowId != null ? String(msg.windowId) : "default";
        const entry = {
          data: msg.data,
          focused: msg.focused === true,
          url: msg.url || "",
          title: msg.title || "",
          timestamp: msg.timestamp || Date.now(),
        };
        setLiveStateByUser((prev) => {
          const next = new Map(prev);
          const current = getUserState(userId);
          const windowScreenshots = new Map(current.windowScreenshots);
          windowScreenshots.set(key, entry);
          const nextState = {
            ...current,
            windowScreenshots,
            liveScreenshot: entry.focused || msg.windowId == null ? msg.data : current.liveScreenshot,
            screenStreamActive: true,
          };
          next.set(userId, nextState);
          return next;
        });
      } else if (msg.type === "screen_stream_stopped") {
        setLiveStateByUser((prev) => {
          const next = new Map(prev);
          const current = getUserState(userId);
          next.set(userId, { ...current, screenStreamActive: false, liveScreenshot: null, windowScreenshots: new Map() });
          return next;
        });
      } else if (msg.type === "open_tabs" && Array.isArray(msg.tabs)) {
        setLiveStateByUser((prev) => {
          const next = new Map(prev);
          const current = getUserState(userId);
          next.set(userId, { ...current, openTabs: msg.tabs });
          return next;
        });
      } else if (msg.type === "internet_status") {
        setLiveStateByUser((prev) => {
          const next = new Map(prev);
          const current = getUserState(userId);
          next.set(userId, { ...current, internetBlocked: msg.blocked === true });
          return next;
        });
      } else if (msg.type === "focus_mode_status") {
        setLiveStateByUser((prev) => {
          const next = new Map(prev);
          const current = getUserState(userId);
          next.set(userId, {
            ...current,
            focusMode: {
              enabled: msg.enabled === true,
              allowedDomains: Array.isArray(msg.allowedDomains) ? msg.allowedDomains : [],
            },
          });
          return next;
        });
      } else if (msg.type === "db_reset") {
        setLiveStateByUser((prev) => {
          const next = new Map(prev);
          const current = getUserState(userId);
          next.set(userId, { ...current, liveEntries: [] });
          return next;
        });
        setAlertCount(0);
      } else if (msg.type === "identity") {
        setMonitoredUsers((prev) => {
          const map = new Map(prev.map((u) => [u.monitoredUserId, u]));
          map.set(userId, { monitoredUserId: userId, online: true, email: msg.email || "" });
          return [...map.values()].sort((a, b) => a.monitoredUserId.localeCompare(b.monitoredUserId));
        });
      }
    };

    ws.onclose = () => {
      if (!mountedRef.current) return;
      setWsStatus("disconnected");
      wsRef.current = null;
      const delay = Math.min(backoffRef.current, 30_000);
      backoffRef.current = Math.min(delay * 2, 30_000);
      // Use the ref so we always call the latest version of connect
      reconnectRef.current = setTimeout(() => connectRef.current?.(), delay);
    };

    ws.onerror = () => { ws.close(); };
  }, [backendUrl, getUserState, selectedMonitoredUserId]);

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

  const refreshMonitoredUsers = useCallback(async () => {
    if (!backendUrl) return;
    try {
      const res = await fetch(`${backendUrl}/api/monitored-users`);
      if (!res.ok) return;
      const data = await res.json();
      if (Array.isArray(data.users) && data.users.length > 0) {
        setMonitoredUsers(data.users);
        setSelectedMonitoredUserId((prev) => {
          const exists = data.users.some((u) => u.monitoredUserId === prev);
          return exists ? prev : data.users[0].monitoredUserId;
        });
      }
    } catch {
      // no-op
    }
  }, [backendUrl]);

  useEffect(() => {
    refreshMonitoredUsers();
  }, [refreshMonitoredUsers]);

  // ── Backend URL change ──────────────────────────────────────────────────

  const setBackendUrl = useCallback((url) => {
    localStorage.setItem(STORAGE_KEY, url);
    setBackendUrlState(url);
    clearTimeout(reconnectRef.current);
    wsRef.current?.close();
    backoffRef.current = 1000;
  }, []);

  const setSelectedUser = useCallback((userId) => {
    const normalized = userId || DEFAULT_USER_ID;
    localStorage.setItem(SELECTED_USER_STORAGE_KEY, normalized);
    setSelectedMonitoredUserId(normalized);
    setAlertCount(0);
  }, []);

  const clearAlerts = useCallback(() => setAlertCount(0), []);
  const clearLiveEntries = useCallback(() => {
    setLiveStateByUser((prev) => {
      const next = new Map(prev);
      const current = getUserState(selectedMonitoredUserId);
      next.set(selectedMonitoredUserId, { ...current, liveEntries: [] });
      return next;
    });
  }, [getUserState, selectedMonitoredUserId]);

  // ── Screen stream controls ──────────────────────────────────────────────

  const startScreenStream = useCallback(() => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({ type: "start_screen_stream", monitoredUserId: selectedMonitoredUserId }));
    setLiveStateByUser((prev) => {
      const next = new Map(prev);
      const current = getUserState(selectedMonitoredUserId);
      next.set(selectedMonitoredUserId, { ...current, screenStreamActive: true, liveScreenshot: null });
      return next;
    });
  }, [getUserState, selectedMonitoredUserId]);

  const stopScreenStream = useCallback(() => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "stop_screen_stream", monitoredUserId: selectedMonitoredUserId }));
    }
    setLiveStateByUser((prev) => {
      const next = new Map(prev);
      const current = getUserState(selectedMonitoredUserId);
      next.set(selectedMonitoredUserId, { ...current, screenStreamActive: false, liveScreenshot: null, windowScreenshots: new Map() });
      return next;
    });
  }, [getUserState, selectedMonitoredUserId]);

  const toggleInternetBlock = useCallback(() => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    const newState = !selectedUserState.internetBlocked;
    wsRef.current.send(JSON.stringify({ type: "set_internet_blocked", monitoredUserId: selectedMonitoredUserId, blocked: newState }));
    setLiveStateByUser((prev) => {
      const next = new Map(prev);
      const current = getUserState(selectedMonitoredUserId);
      next.set(selectedMonitoredUserId, { ...current, internetBlocked: newState });
      return next;
    });
  }, [getUserState, selectedMonitoredUserId, selectedUserState.internetBlocked]);

  // ── Tab management ──────────────────────────────────────────────────────

  const closeTab = useCallback((tabId) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({ type: "close_tab", monitoredUserId: selectedMonitoredUserId, tabId }));
    setLiveStateByUser((prev) => {
      const next = new Map(prev);
      const current = getUserState(selectedMonitoredUserId);
      next.set(selectedMonitoredUserId, { ...current, openTabs: current.openTabs.filter((t) => t.id !== tabId) });
      return next;
    });
  }, [getUserState, selectedMonitoredUserId]);

  // ── Focus Mode controls ─────────────────────────────────────────────────

  const setFocusMode = useCallback((enabled, allowedDomains) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({
      type: "set_focus_mode",
      monitoredUserId: selectedMonitoredUserId,
      enabled,
      allowedDomains: allowedDomains || [],
    }));
    setLiveStateByUser((prev) => {
      const next = new Map(prev);
      const current = getUserState(selectedMonitoredUserId);
      next.set(selectedMonitoredUserId, { ...current, focusMode: { enabled, allowedDomains: allowedDomains || [] } });
      return next;
    });
  }, [getUserState, selectedMonitoredUserId]);

  const updateFocusDomains = useCallback((allowedDomains) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({
      type: "update_focus_domains",
      monitoredUserId: selectedMonitoredUserId,
      allowedDomains,
    }));
    setLiveStateByUser((prev) => {
      const next = new Map(prev);
      const current = getUserState(selectedMonitoredUserId);
      next.set(selectedMonitoredUserId, { ...current, focusMode: { ...current.focusMode, allowedDomains } });
      return next;
    });
  }, [getUserState, selectedMonitoredUserId]);

  const contextValue = useMemo(() => ({
    wsStatus,
    extensionOnline: selectedUserState.extensionOnline,
    liveEntries: selectedUserState.liveEntries,
    newAlertCount,
    clearAlerts,
    clearLiveEntries,
    backendUrl,
    setBackendUrl,
    liveScreenshot: selectedUserState.liveScreenshot,
    screenStreamActive: selectedUserState.screenStreamActive,
    startScreenStream,
    stopScreenStream,
    windowScreenshots: selectedUserState.windowScreenshots,
    openTabs: selectedUserState.openTabs,
    closeTab,
    internetBlocked: selectedUserState.internetBlocked,
    toggleInternetBlock,
    focusMode: selectedUserState.focusMode,
    setFocusMode,
    updateFocusDomains,
    monitoredUsers,
    selectedMonitoredUserId,
    setSelectedMonitoredUserId: setSelectedUser,
    refreshMonitoredUsers,
  }), [
    wsStatus,
    selectedUserState,
    newAlertCount,
    clearAlerts,
    clearLiveEntries,
    backendUrl,
    setBackendUrl,
    startScreenStream,
    stopScreenStream,
    closeTab,
    toggleInternetBlock,
    setFocusMode,
    updateFocusDomains,
    monitoredUsers,
    selectedMonitoredUserId,
    setSelectedUser,
    refreshMonitoredUsers,
  ]);

  return (
    <MonitorContext.Provider value={contextValue}>
      {children}
    </MonitorContext.Provider>
  );
}

export function useMonitor() {
  const ctx = useContext(MonitorContext);
  if (!ctx) throw new Error("useMonitor must be used inside <MonitorProvider>");
  return ctx;
}
