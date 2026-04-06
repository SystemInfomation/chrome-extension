/**
 * PalsPlan Parental Monitor — Backend Server
 *
 * Node.js + Express + WebSocket (ws) server for real-time parental monitoring.
 * Deployed on Render.com as a Web Service.
 *
 * Architecture:
 *  - Chrome extension connects to /ws and sends browsing activity events
 *  - Parent dashboard connects to /ws and receives real-time activity events
 *  - REST API provides activity history, stats, alerts, and filter management
 *
 * No authentication — this is a private, single-family deployment.
 * Change DASHBOARD_ORIGIN in your .env to restrict CORS to your dashboard URL.
 */

"use strict";

const http    = require("http");
const path    = require("path");
const fs      = require("fs");
const express = require("express");
const { WebSocketServer } = require("ws");

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT || "3001", 10);

/** Maximum number of activity entries kept in memory. */
const MAX_ACTIVITY_SIZE = 10_000;

/** Maximum number of alert entries kept in memory. */
const MAX_ALERT_SIZE = 1_000;

/** How often (ms) to persist activity data to disk. */
const PERSIST_INTERVAL_MS = 30_000;

/** Path to the persistent activity data file. */
const DATA_DIR  = path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "activity.json");

// ─────────────────────────────────────────────────────────────────────────────
// In-memory storage
// ─────────────────────────────────────────────────────────────────────────────

/** @type {Array<ActivityEntry>} */
let activityLog = [];

/** @type {Array<AlertEntry>} */
let alertLog = [];

/** @type {Set<string>} Custom blocked domains (managed via API) */
let customFilters = new Set();

/** Whether the extension is currently connected. */
let extensionConnected = false;

/**
 * @typedef {{ id: string, url: string, title: string, action: "visit"|"blocked", reason: string|null, timestamp: number, domain: string }} ActivityEntry
 * @typedef {{ id: string, url: string, domain: string, reason: string, timestamp: number, severity: string }} AlertEntry
 */

// ─────────────────────────────────────────────────────────────────────────────
// Persistence
// ─────────────────────────────────────────────────────────────────────────────

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function loadPersistedData() {
  ensureDataDir();
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, "utf8");
      const parsed = JSON.parse(raw);
      activityLog  = Array.isArray(parsed.activity) ? parsed.activity : [];
      alertLog     = Array.isArray(parsed.alerts)   ? parsed.alerts   : [];
      const filters = Array.isArray(parsed.filters)  ? parsed.filters  : [];
      customFilters = new Set(filters);
      console.log(`[PalsPlan] Loaded ${activityLog.length} activity entries from disk`);
    }
  } catch (err) {
    console.error("[PalsPlan] Failed to load persisted data:", err.message);
    activityLog  = [];
    alertLog     = [];
    customFilters = new Set();
  }
}

function persistData() {
  ensureDataDir();
  try {
    const payload = JSON.stringify({
      activity: activityLog.slice(-MAX_ACTIVITY_SIZE),
      alerts:   alertLog.slice(-MAX_ALERT_SIZE),
      filters:  Array.from(customFilters),
    });
    fs.writeFileSync(DATA_FILE, payload, "utf8");
  } catch (err) {
    console.error("[PalsPlan] Failed to persist data:", err.message);
  }
}

// Load persisted data on startup
loadPersistedData();

// Persist periodically
setInterval(persistData, PERSIST_INTERVAL_MS);

// Also persist on process exit
process.on("SIGTERM", () => { persistData(); process.exit(0); });
process.on("SIGINT",  () => { persistData(); process.exit(0); });

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function extractDomain(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch (_e) {
    return url;
  }
}

// Keywords used to classify block reason severity
const SEVERITY_CRITICAL = ["adult", "malicious", "malware", "ransomware", "phishing"];
const SEVERITY_HIGH     = ["vpn", "proxy"];
const SEVERITY_MEDIUM   = ["blocklist", "family"];

/**
 * Map a block reason string to a severity level.
 * @param {string|null} reason
 * @returns {"critical"|"high"|"medium"|"low"}
 */
function getSeverity(reason) {
  if (!reason) return "low";
  const r = reason.toLowerCase();
  if (SEVERITY_CRITICAL.some((kw) => r.includes(kw))) return "critical";
  if (SEVERITY_HIGH.some((kw) => r.includes(kw)))     return "high";
  if (SEVERITY_MEDIUM.some((kw) => r.includes(kw)))   return "medium";
  return "low";
}

// ─────────────────────────────────────────────────────────────────────────────
// Express app
// ─────────────────────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());

// CORS — allow all origins (private deployment, no auth needed)
app.use((_req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (_req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// ─── GET /api/status ─────────────────────────────────────────────────────────
app.get("/api/status", (_req, res) => {
  res.json({
    extensionConnected,
    uptime: process.uptime(),
    activityCount: activityLog.length,
    alertCount: alertLog.length,
  });
});

// ─── GET /api/activity ───────────────────────────────────────────────────────
app.get("/api/activity", (req, res) => {
  const {
    page    = "1",
    limit   = "50",
    action,
    domain,
    search,
    from,
    to,
  } = req.query;

  const pageNum  = Math.max(1, parseInt(page, 10)  || 1);
  const limitNum = Math.min(200, Math.max(1, parseInt(limit, 10) || 50));

  let filtered = activityLog.slice().reverse(); // newest first

  if (action === "blocked" || action === "visit") {
    filtered = filtered.filter((e) => e.action === action);
  }
  if (domain) {
    const d = domain.toLowerCase();
    filtered = filtered.filter((e) => e.domain.includes(d));
  }
  if (search) {
    const s = search.toLowerCase();
    filtered = filtered.filter(
      (e) => e.url.toLowerCase().includes(s) || (e.title || "").toLowerCase().includes(s)
    );
  }
  if (from) {
    const ts = new Date(from).getTime();
    if (!isNaN(ts)) filtered = filtered.filter((e) => e.timestamp >= ts);
  }
  if (to) {
    const ts = new Date(to).getTime();
    if (!isNaN(ts)) filtered = filtered.filter((e) => e.timestamp <= ts);
  }

  const total = filtered.length;
  const start = (pageNum - 1) * limitNum;
  const items = filtered.slice(start, start + limitNum);

  res.json({ total, page: pageNum, limit: limitNum, items });
});

// ─── GET /api/activity/stats ──────────────────────────────────────────────────
app.get("/api/activity/stats", (_req, res) => {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayTs = todayStart.getTime();

  const todayEntries = activityLog.filter((e) => e.timestamp >= todayTs);

  const totalToday   = todayEntries.length;
  const blockedToday = todayEntries.filter((e) => e.action === "blocked").length;

  // Most visited domains today
  const domainCounts = {};
  for (const e of todayEntries) {
    domainCounts[e.domain] = (domainCounts[e.domain] || 0) + 1;
  }
  const topDomains = Object.entries(domainCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([domain, count]) => ({ domain, count }));

  res.json({ totalToday, blockedToday, topDomains });
});

// ─── GET /api/alerts ─────────────────────────────────────────────────────────
app.get("/api/alerts", (req, res) => {
  const { page = "1", limit = "50" } = req.query;
  const pageNum  = Math.max(1, parseInt(page, 10)  || 1);
  const limitNum = Math.min(200, Math.max(1, parseInt(limit, 10) || 50));

  const reversed = alertLog.slice().reverse();
  const total = reversed.length;
  const start = (pageNum - 1) * limitNum;
  const items = reversed.slice(start, start + limitNum);

  res.json({ total, page: pageNum, limit: limitNum, items });
});

// ─── GET /api/filters ────────────────────────────────────────────────────────
app.get("/api/filters", (_req, res) => {
  res.json({ filters: Array.from(customFilters) });
});

// ─── POST /api/filters ───────────────────────────────────────────────────────
app.post("/api/filters", (req, res) => {
  const { domain } = req.body;
  if (!domain || typeof domain !== "string") {
    return res.status(400).json({ error: "domain is required" });
  }
  const normalized = domain.trim().toLowerCase().replace(/^www\./, "");
  if (!normalized || !normalized.includes(".")) {
    return res.status(400).json({ error: "invalid domain" });
  }
  customFilters.add(normalized);
  persistData();

  // Broadcast add_filter command to connected extensions
  broadcast({ type: "add_filter", domain: normalized }, "extension");

  res.json({ ok: true, domain: normalized, filters: Array.from(customFilters) });
});

// ─── DELETE /api/filters/:domain ─────────────────────────────────────────────
app.delete("/api/filters/:domain", (req, res) => {
  const domain = decodeURIComponent(req.params.domain).trim().toLowerCase().replace(/^www\./, "");
  if (!customFilters.has(domain)) {
    return res.status(404).json({ error: "domain not found" });
  }
  customFilters.delete(domain);
  persistData();

  // Broadcast remove_filter command to connected extensions
  broadcast({ type: "remove_filter", domain }, "extension");

  res.json({ ok: true, domain, filters: Array.from(customFilters) });
});

// Health check
app.get("/", (_req, res) => res.json({ status: "ok", service: "PalsPlan Parental Monitor" }));

// ─────────────────────────────────────────────────────────────────────────────
// HTTP + WebSocket server
// ─────────────────────────────────────────────────────────────────────────────

const server = http.createServer(app);
const wss    = new WebSocketServer({ server, path: "/ws" });

/**
 * Connected clients, tagged by role.
 * @type {Map<import("ws").WebSocket, { role: "extension"|"dashboard" }>}
 */
const clients = new Map();

/**
 * Broadcast a message to clients matching the given role filter.
 * If role is omitted, broadcasts to all clients.
 *
 * @param {object} payload
 * @param {"extension"|"dashboard"|undefined} targetRole
 */
function broadcast(payload, targetRole) {
  const msg = JSON.stringify(payload);
  for (const [ws, meta] of clients.entries()) {
    if (ws.readyState !== ws.OPEN) continue;
    if (targetRole && meta.role !== targetRole) continue;
    ws.send(msg);
  }
}

wss.on("connection", (ws, req) => {
  // Determine client role from query string: ?role=extension or ?role=dashboard
  const url    = new URL(req.url, `http://${req.headers.host}`);
  const role   = url.searchParams.get("role") === "extension" ? "extension" : "dashboard";
  clients.set(ws, { role });

  console.log(`[PalsPlan WS] ${role} connected (${clients.size} total)`);

  if (role === "extension") {
    extensionConnected = true;
    // Notify dashboards that extension is online
    broadcast({ type: "status", status: "online" }, "dashboard");
    // Send current custom filters to extension on connect
    if (customFilters.size > 0) {
      ws.send(JSON.stringify({ type: "filters_sync", filters: Array.from(customFilters) }));
    }
  } else {
    // Send current extension status to the newly-connected dashboard immediately
    ws.send(JSON.stringify({ type: "status", status: extensionConnected ? "online" : "offline" }));
    // Send recent activity history so the live feed isn't empty on load
    const recent = activityLog.slice(-50).reverse(); // last 50 entries, newest first
    if (recent.length > 0) {
      ws.send(JSON.stringify({ type: "history", entries: recent }));
    }
  }

  ws.on("message", (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch (_e) {
      return;
    }

    if (msg.type === "activity") {
      // Browsing activity event from the extension
      const entry = {
        id:        generateId(),
        url:       msg.url       || "",
        title:     msg.title     || "",
        action:    msg.action === "blocked" ? "blocked" : "visit",
        reason:    msg.reason    || null,
        timestamp: msg.timestamp || Date.now(),
        domain:    extractDomain(msg.url || ""),
      };

      activityLog.push(entry);
      if (activityLog.length > MAX_ACTIVITY_SIZE) {
        activityLog.splice(0, activityLog.length - MAX_ACTIVITY_SIZE);
      }

      // If blocked, also add an alert
      if (entry.action === "blocked") {
        const alert = {
          id:        entry.id,
          url:       entry.url,
          domain:    entry.domain,
          reason:    entry.reason || "Blocked",
          timestamp: entry.timestamp,
          severity:  getSeverity(entry.reason),
        };
        alertLog.push(alert);
        if (alertLog.length > MAX_ALERT_SIZE) {
          alertLog.splice(0, alertLog.length - MAX_ALERT_SIZE);
        }
        // Forward alert to dashboards
        broadcast({ type: "alert", alert }, "dashboard");
      }

      // Forward activity to all dashboard clients in real-time
      broadcast({ type: "activity", entry }, "dashboard");

    } else if (msg.type === "screenshot") {
      // Live screenshot from the extension — relay to all dashboards
      if (role === "extension" && msg.data) {
        broadcast({ type: "screenshot", data: msg.data, timestamp: msg.timestamp || Date.now(), url: msg.url || "", title: msg.title || "" }, "dashboard");
      }

    } else if (msg.type === "start_screen_stream") {
      // Dashboard requesting live screen stream — forward to extension(s)
      if (role === "dashboard") {
        broadcast({ type: "start_screen_stream" }, "extension");
      }

    } else if (msg.type === "stop_screen_stream") {
      // Dashboard stopping live screen stream — forward to extension(s)
      if (role === "dashboard") {
        broadcast({ type: "stop_screen_stream" }, "extension");
      }

    } else if (msg.type === "status") {
      // Extension heartbeat / status update
      if (role === "extension") {
        extensionConnected = true;
        broadcast({ type: "status", status: "online" }, "dashboard");
      }
    }
  });

  ws.on("close", () => {
    clients.delete(ws);
    // Check if any extension clients remain
    const anyExtension = [...clients.values()].some((m) => m.role === "extension");
    if (!anyExtension && role === "extension") {
      extensionConnected = false;
      broadcast({ type: "status", status: "offline" }, "dashboard");
      // Extension is gone — tell dashboards the screen stream has stopped
      broadcast({ type: "screen_stream_stopped" }, "dashboard");
    }
    console.log(`[PalsPlan WS] ${role} disconnected (${clients.size} remaining)`);
  });

  ws.on("error", (err) => {
    console.error(`[PalsPlan WS] ${role} error:`, err.message);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Start
// ─────────────────────────────────────────────────────────────────────────────

server.listen(PORT, () => {
  console.log(`[PalsPlan] Server listening on port ${PORT}`);
  console.log(`[PalsPlan] WebSocket endpoint: ws://localhost:${PORT}/ws`);
});
