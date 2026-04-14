/**
 * Watson Control Tower — Backend Server
 *
 * Node.js + Express + WebSocket (ws) server for real-time parental monitoring.
 * Deployed on Render.com as a Web Service.
 *
 * Architecture:
 *  - Chrome extension connects to /ws and sends browsing activity events
 *  - Parent dashboard connects to /ws and receives real-time activity events
 *  - REST API provides activity history, stats, alerts, and filter management
 *
 * Persistence:
 *  - When DATABASE_URL is set, all activity, alerts, and filters are stored in
 *    PostgreSQL (durable across restarts, unlimited history).
 *  - A small in-memory ring buffer (MAX_HISTORY_ENTRIES) is kept solely for
 *    sending recent history to newly-connected dashboard clients over WebSocket.
 *
 * No authentication — this is a private, single-family deployment.
 */

"use strict";

const http    = require("http");
const express = require("express");
const { WebSocketServer } = require("ws");
const { Pool } = require("pg");

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT || "3001", 10);

/**
 * Number of recent activity entries held in memory for the initial WS history
 * broadcast sent to newly-connected dashboard clients.
 */
const MAX_HISTORY_ENTRIES = 50;

// ─────────────────────────────────────────────────────────────────────────────
// PostgreSQL
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Connection pool. Initialised only when DATABASE_URL is present.
 * @type {import("pg").Pool|null}
 */
let db = null;

if (process.env.DATABASE_URL) {
  // Render-hosted (and most cloud) PostgreSQL instances use self-signed TLS
  // certificates that Node.js cannot verify against its built-in CA bundle.
  // `rejectUnauthorized: false` is the standard workaround for these providers.
  // If you run Postgres locally or with a properly signed cert, you can remove
  // the ssl option entirely.
  const sslOption = /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL)
    ? false
    : { rejectUnauthorized: false };

  db = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: sslOption,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
  db.on("error", (err) => {
    console.error("[WatsonCT DB] Pool error:", err.message);
  });
} else {
  console.warn("[WatsonCT] DATABASE_URL not set — data will not be persisted across restarts.");
}

/**
 * Create the database schema if it does not already exist.
 */
async function initDb() {
  if (!db) return;
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS activity (
        id        TEXT PRIMARY KEY,
        url       TEXT        NOT NULL DEFAULT '',
        title     TEXT        NOT NULL DEFAULT '',
        action    TEXT        NOT NULL CHECK (action IN ('visit', 'blocked')),
        reason    TEXT,
        timestamp BIGINT      NOT NULL,
        domain    TEXT        NOT NULL DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS activity_timestamp_idx ON activity (timestamp DESC);
      CREATE INDEX IF NOT EXISTS activity_action_idx    ON activity (action);
      CREATE INDEX IF NOT EXISTS activity_domain_idx    ON activity (domain);

      CREATE TABLE IF NOT EXISTS alerts (
        id        TEXT PRIMARY KEY,
        url       TEXT   NOT NULL DEFAULT '',
        domain    TEXT   NOT NULL DEFAULT '',
        reason    TEXT   NOT NULL DEFAULT 'Blocked',
        timestamp BIGINT NOT NULL,
        severity  TEXT   NOT NULL DEFAULT 'low'
      );
      CREATE INDEX IF NOT EXISTS alerts_timestamp_idx ON alerts (timestamp DESC);

      CREATE TABLE IF NOT EXISTS custom_filters (
        domain TEXT PRIMARY KEY
      );
    `);
    console.log("[WatsonCT DB] Schema ready.");
  } catch (err) {
    console.error("[WatsonCT DB] Failed to initialise schema:", err.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// In-memory ring buffer (recent entries for WS history only)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @typedef {{ id: string, url: string, title: string, action: "visit"|"blocked", reason: string|null, timestamp: number, domain: string }} ActivityEntry
 * @typedef {{ id: string, url: string, domain: string, reason: string, timestamp: number, severity: string }} AlertEntry
 */

/** @type {ActivityEntry[]} — newest entries at the end, capped at MAX_HISTORY_ENTRIES */
const recentActivity = [];

/** @type {AlertEntry[]} — newest alerts at the end, capped at MAX_ALERT_SIZE */
const recentAlerts = [];
const MAX_ALERT_SIZE = 500;

/** @type {Set<string>} Custom blocked domains (managed via API) */
let customFilters = new Set();

/** Whether the extension is currently connected. */
let extensionConnected = false;

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

/**
 * Append an entry to the in-memory ring buffer (newest at end).
 * @param {ActivityEntry} entry
 */
function pushRecent(entry) {
  recentActivity.push(entry);
  if (recentActivity.length > MAX_HISTORY_ENTRIES) {
    recentActivity.shift();
  }
}

/**
 * Append an alert to the in-memory ring buffer (newest at end).
 * @param {AlertEntry} alert
 */
function pushRecentAlert(alert) {
  recentAlerts.push(alert);
  if (recentAlerts.length > MAX_ALERT_SIZE) {
    recentAlerts.shift();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// DB helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Persist a single activity entry to the database (fire-and-forget). */
function dbInsertActivity(entry) {
  if (!db) return;
  db.query(
    `INSERT INTO activity (id, url, title, action, reason, timestamp, domain)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (id) DO NOTHING`,
    [entry.id, entry.url, entry.title, entry.action, entry.reason, entry.timestamp, entry.domain]
  ).catch((err) => console.error("[WatsonCT DB] insert activity:", err.message));
}

/** Persist a single alert entry to the database (fire-and-forget). */
function dbInsertAlert(alert) {
  if (!db) return;
  db.query(
    `INSERT INTO alerts (id, url, domain, reason, timestamp, severity)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (id) DO NOTHING`,
    [alert.id, alert.url, alert.domain, alert.reason, alert.timestamp, alert.severity]
  ).catch((err) => console.error("[WatsonCT DB] insert alert:", err.message));
}

/**
 * Load all custom filters from the database into the in-memory set.
 */
async function loadFiltersFromDb() {
  if (!db) return;
  try {
    const { rows } = await db.query("SELECT domain FROM custom_filters");
    customFilters = new Set(rows.map((r) => r.domain));
    console.log(`[WatsonCT DB] Loaded ${customFilters.size} custom filters.`);
  } catch (err) {
    console.error("[WatsonCT DB] load filters:", err.message);
  }
}

/** Persist a filter addition to the database (fire-and-forget). */
function dbAddFilter(domain) {
  if (!db) return;
  db.query(
    "INSERT INTO custom_filters (domain) VALUES ($1) ON CONFLICT DO NOTHING",
    [domain]
  ).catch((err) => console.error("[WatsonCT DB] add filter:", err.message));
}

/** Persist a filter removal to the database (fire-and-forget). */
function dbRemoveFilter(domain) {
  if (!db) return;
  db.query(
    "DELETE FROM custom_filters WHERE domain = $1",
    [domain]
  ).catch((err) => console.error("[WatsonCT DB] remove filter:", err.message));
}

// ─────────────────────────────────────────────────────────────────────────────
// Simple in-memory rate limiter
// Limits each IP to MAX_REQUESTS within WINDOW_MS on protected routes.
// ─────────────────────────────────────────────────────────────────────────────

const RATE_WINDOW_MS  = 60_000; // 1 minute
const RATE_MAX        = 120;    // requests per window per IP

/** @type {Map<string, { count: number, resetAt: number }>} */
const rateCounts = new Map();

function rateLimitMiddleware(req, res, next) {
  const ip  = req.socket.remoteAddress || "unknown";
  const now = Date.now();
  let entry = rateCounts.get(ip);
  if (!entry || now >= entry.resetAt) {
    entry = { count: 0, resetAt: now + RATE_WINDOW_MS };
    rateCounts.set(ip, entry);
  }
  entry.count++;
  if (entry.count > RATE_MAX) {
    res.setHeader("Retry-After", Math.ceil((entry.resetAt - now) / 1000));
    return res.status(429).json({ error: "Too many requests. Please slow down." });
  }
  next();
}

// Periodically prune expired entries to prevent unbounded map growth
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateCounts.entries()) {
    if (now >= entry.resetAt) rateCounts.delete(ip);
  }
}, RATE_WINDOW_MS);

// ─────────────────────────────────────────────────────────────────────────────
// Express app
// ─────────────────────────────────────────────────────────────────────────────

const app = express();

// Disable X-Powered-By header to reduce information leakage
app.disable("x-powered-by");

// CORS — must be first so the header is present on every response, including
// body-parse errors and global error-handler responses.
app.use((_req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (_req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// Security headers — applied to every response
app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  next();
});

// Limit request body size to prevent DoS via large payloads
app.use(express.json({ limit: "1mb" }));

// ─── GET /api/status ─────────────────────────────────────────────────────────
app.get("/api/status", (_req, res) => {
  res.json({
    extensionConnected,
    uptime: process.uptime(),
    dbConnected: db !== null,
  });
});

// ─── GET /api/activity ───────────────────────────────────────────────────────
app.get("/api/activity", rateLimitMiddleware, async (req, res) => {
  const {
    page   = "1",
    limit  = "50",
    action,
    domain,
    search,
    from,
    to,
  } = req.query;

  const pageNum  = Math.max(1, parseInt(page, 10)  || 1);
  const limitNum = Math.min(200, Math.max(1, parseInt(limit, 10) || 50));
  const offset   = (pageNum - 1) * limitNum;

  if (db) {
    // ── PostgreSQL path ──────────────────────────────────────────────────────
    try {
      const conditions = [];
      const params     = [];
      let   p          = 1;

      if (action === "blocked" || action === "visit") {
        conditions.push(`action = $${p++}`); params.push(action);
      }
      if (domain) {
        conditions.push(`domain ILIKE $${p++}`); params.push(`%${domain}%`);
      }
      if (search) {
        conditions.push(`(url ILIKE $${p} OR title ILIKE $${p})`); params.push(`%${search}%`); p++;
      }
      if (from) {
        const ts = new Date(from).getTime();
        if (!isNaN(ts)) { conditions.push(`timestamp >= $${p++}`); params.push(ts); }
      }
      if (to) {
        const ts = new Date(to).getTime();
        if (!isNaN(ts)) { conditions.push(`timestamp <= $${p++}`); params.push(ts); }
      }

      const where = conditions.length ? "WHERE " + conditions.join(" AND ") : "";

      const [countRes, rowsRes] = await Promise.all([
        db.query(`SELECT COUNT(*) AS cnt FROM activity ${where}`, params),
        db.query(
          `SELECT id, url, title, action, reason, timestamp, domain
             FROM activity ${where}
            ORDER BY timestamp DESC
            LIMIT $${p} OFFSET $${p + 1}`,
          [...params, limitNum, offset]
        ),
      ]);

      return res.json({
        total: parseInt(countRes.rows[0].cnt, 10),
        page:  pageNum,
        limit: limitNum,
        items: rowsRes.rows.map((r) => ({ ...r, timestamp: Number(r.timestamp) })),
      });
    } catch (err) {
      console.error("[WatsonCT DB] GET /api/activity:", err.message);
      return res.status(500).json({ error: "database error" });
    }
  }

  // ── In-memory fallback (no DB configured) ───────────────────────────────
  let filtered = recentActivity.slice().reverse();

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
  const items = filtered.slice(offset, offset + limitNum);
  return res.json({ total, page: pageNum, limit: limitNum, items });
});

// ─── GET /api/activity/stats ──────────────────────────────────────────────────
app.get("/api/activity/stats", rateLimitMiddleware, async (_req, res) => {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayTs = todayStart.getTime();

  if (db) {
    try {
      const [totRes, blkRes, domRes] = await Promise.all([
        db.query("SELECT COUNT(*) AS cnt FROM activity WHERE timestamp >= $1", [todayTs]),
        db.query("SELECT COUNT(*) AS cnt FROM activity WHERE timestamp >= $1 AND action = 'blocked'", [todayTs]),
        db.query(
          `SELECT domain, COUNT(*) AS cnt
             FROM activity
            WHERE timestamp >= $1
            GROUP BY domain
            ORDER BY cnt DESC
            LIMIT 10`,
          [todayTs]
        ),
      ]);

      return res.json({
        totalToday:   parseInt(totRes.rows[0].cnt, 10),
        blockedToday: parseInt(blkRes.rows[0].cnt, 10),
        topDomains:   domRes.rows.map((r) => ({ domain: r.domain, count: parseInt(r.cnt, 10) })),
      });
    } catch (err) {
      console.error("[WatsonCT DB] GET /api/activity/stats:", err.message);
      return res.status(500).json({ error: "database error" });
    }
  }

  // Fallback
  const todayEntries = recentActivity.filter((e) => e.timestamp >= todayTs);
  const totalToday   = todayEntries.length;
  const blockedToday = todayEntries.filter((e) => e.action === "blocked").length;
  const domainCounts = {};
  for (const e of todayEntries) {
    domainCounts[e.domain] = (domainCounts[e.domain] || 0) + 1;
  }
  const topDomains = Object.entries(domainCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([d, count]) => ({ domain: d, count }));

  return res.json({ totalToday, blockedToday, topDomains });
});

// ─── GET /api/alerts ─────────────────────────────────────────────────────────
app.get("/api/alerts", rateLimitMiddleware, async (req, res) => {
  const { page = "1", limit = "50" } = req.query;
  const pageNum  = Math.max(1, parseInt(page, 10)  || 1);
  const limitNum = Math.min(200, Math.max(1, parseInt(limit, 10) || 50));
  const offset   = (pageNum - 1) * limitNum;

  if (db) {
    try {
      const [countRes, rowsRes] = await Promise.all([
        db.query("SELECT COUNT(*) AS cnt FROM alerts"),
        db.query(
          `SELECT id, url, domain, reason, timestamp, severity
             FROM alerts
            ORDER BY timestamp DESC
            LIMIT $1 OFFSET $2`,
          [limitNum, offset]
        ),
      ]);
      return res.json({
        total: parseInt(countRes.rows[0].cnt, 10),
        page:  pageNum,
        limit: limitNum,
        items: rowsRes.rows.map((r) => ({ ...r, timestamp: Number(r.timestamp) })),
      });
    } catch (err) {
      console.error("[WatsonCT DB] GET /api/alerts:", err.message);
      return res.status(500).json({ error: "database error" });
    }
  }

  // Fallback — not meaningful without DB but kept for compatibility
  const reversed = recentAlerts.slice().reverse();
  const total = reversed.length;
  const items = reversed.slice(offset, offset + limitNum);
  return res.json({ total, page: pageNum, limit: limitNum, items });
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
  dbAddFilter(normalized);

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
  dbRemoveFilter(domain);

  // Broadcast remove_filter command to connected extensions
  broadcast({ type: "remove_filter", domain }, "extension");

  res.json({ ok: true, domain, filters: Array.from(customFilters) });
});

// Health check
app.get("/", (_req, res) => res.json({ status: "ok", service: "Watson Control Tower Monitor" }));

// Global error handler — must be defined after all routes.
// Ensures CORS headers (already set by the CORS middleware above) are preserved
// and that Express-level errors return a structured JSON body instead of an
// HTML stack-trace page.
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  console.error("[WatsonCT] Unhandled Express error:", err.message || err);
  const status = typeof err.status === "number" ? err.status : 500;
  res.status(status).json({ error: "internal server error" });
});

// ─────────────────────────────────────────────────────────────────────────────
// HTTP + WebSocket server
// ─────────────────────────────────────────────────────────────────────────────

const server = http.createServer(app);
const wss    = new WebSocketServer({ server, path: "/ws", maxPayload: 5 * 1024 * 1024 }); // 5 MB max (screenshots are large)

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
  const url  = new URL(req.url, `http://${req.headers.host}`);
  const role = url.searchParams.get("role") === "extension" ? "extension" : "dashboard";
  clients.set(ws, { role });

  console.log(`[WatsonCT WS] ${role} connected (${clients.size} total)`);

  if (role === "extension") {
    extensionConnected = true;
    // Notify dashboards that extension is online
    broadcast({ type: "status", status: "online" }, "dashboard");
    // Send current custom filters to extension on connect
    if (customFilters.size > 0) {
      ws.send(JSON.stringify({ type: "filters_sync", filters: Array.from(customFilters) }));
    }
    // Auto-start live screen stream so monitoring is always on
    ws.send(JSON.stringify({ type: "start_screen_stream" }));
  } else {
    // Send current extension status to the newly-connected dashboard immediately
    ws.send(JSON.stringify({ type: "status", status: extensionConnected ? "online" : "offline" }));
    // Send recent activity history so the live feed isn't empty on load
    const recent = recentActivity.slice().reverse(); // newest first
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

      // Save to DB and keep in the in-memory ring buffer
      dbInsertActivity(entry);
      pushRecent(entry);

      // If blocked, also create an alert
      if (entry.action === "blocked") {
        const alert = {
          id:        entry.id,
          url:       entry.url,
          domain:    entry.domain,
          reason:    entry.reason || "Blocked",
          timestamp: entry.timestamp,
          severity:  getSeverity(entry.reason),
        };
        dbInsertAlert(alert);
        pushRecentAlert(alert);
        // Forward alert to dashboards
        broadcast({ type: "alert", alert }, "dashboard");
      }

      // Forward activity to all dashboard clients in real-time
      broadcast({ type: "activity", entry }, "dashboard");

    } else if (msg.type === "screenshot") {
      // Live screenshot from the extension — relay to all dashboards
      if (role === "extension" && msg.data) {
        broadcast(
          {
            type:      "screenshot",
            data:      msg.data,
            timestamp: msg.timestamp || Date.now(),
            url:       msg.url   || "",
            title:     msg.title || "",
          },
          "dashboard"
        );
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
    } else if (msg.type === "open_tabs") {
      // Extension reporting all open tabs — relay to dashboards
      if (role === "extension" && Array.isArray(msg.tabs)) {
        broadcast({ type: "open_tabs", tabs: msg.tabs, timestamp: msg.timestamp || Date.now() }, "dashboard");
      }
    } else if (msg.type === "set_internet_blocked") {
      // Dashboard requesting to toggle internet block — forward to extension(s)
      if (role === "dashboard") {
        broadcast({ type: "set_internet_blocked", blocked: msg.blocked === true }, "extension");
      }
    } else if (msg.type === "get_internet_status") {
      // Dashboard requesting current internet block status — forward to extension(s)
      if (role === "dashboard") {
        broadcast({ type: "get_internet_status" }, "extension");
      }
    } else if (msg.type === "internet_status") {
      // Extension reporting internet block status — forward to dashboards
      if (role === "extension") {
        broadcast({ type: "internet_status", blocked: msg.blocked === true }, "dashboard");
      }

    // ── Tab management ─────────────────────────────────────────────────────
    } else if (msg.type === "close_tab") {
      // Dashboard requesting to close a specific tab — forward to extension(s)
      if (role === "dashboard" && typeof msg.tabId === "number") {
        broadcast({ type: "close_tab", tabId: msg.tabId }, "extension");
      }

    // ── Focus Mode ─────────────────────────────────────────────────────────
    } else if (msg.type === "set_focus_mode") {
      // Dashboard toggling focus mode — forward to extension(s)
      if (role === "dashboard") {
        broadcast({
          type: "set_focus_mode",
          enabled: msg.enabled === true,
          allowedDomains: Array.isArray(msg.allowedDomains) ? msg.allowedDomains : [],
        }, "extension");
      }
    } else if (msg.type === "update_focus_domains") {
      // Dashboard updating focus mode allowed domains — forward to extension(s)
      if (role === "dashboard" && Array.isArray(msg.allowedDomains)) {
        broadcast({ type: "update_focus_domains", allowedDomains: msg.allowedDomains }, "extension");
      }
    } else if (msg.type === "get_focus_mode") {
      // Dashboard requesting current focus mode state — forward to extension(s)
      if (role === "dashboard") {
        broadcast({ type: "get_focus_mode" }, "extension");
      }
    } else if (msg.type === "focus_mode_status") {
      // Extension reporting focus mode state — forward to dashboards
      if (role === "extension") {
        broadcast({
          type: "focus_mode_status",
          enabled: msg.enabled === true,
          allowedDomains: Array.isArray(msg.allowedDomains) ? msg.allowedDomains : [],
        }, "dashboard");
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
    console.log(`[WatsonCT WS] ${role} disconnected (${clients.size} remaining)`);
  });

  ws.on("error", (err) => {
    console.error(`[WatsonCT WS] ${role} error:`, err.message);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Start
// ─────────────────────────────────────────────────────────────────────────────

async function start() {
  // Initialise DB schema and load persisted filters before accepting traffic
  await initDb();
  await loadFiltersFromDb();

  server.listen(PORT, () => {
    console.log(`[WatsonCT] Server listening on port ${PORT}`);
    console.log(`[WatsonCT] WebSocket endpoint: ws://localhost:${PORT}/ws`);
    console.log(`[WatsonCT] Database: ${db ? "PostgreSQL" : "in-memory (no DATABASE_URL)"}`);
  });
}

// Log uncaught exceptions / unhandled rejections before letting the process
// exit so Render can restart it cleanly rather than running a broken process.
process.on("uncaughtException", (err) => {
  console.error("[WatsonCT] Uncaught exception — exiting for clean restart:", err);
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  console.error("[WatsonCT] Unhandled promise rejection — exiting for clean restart:", reason);
  process.exit(1);
});

start().catch((err) => {
  console.error("[WatsonCT] Fatal startup error:", err);
  process.exit(1);
});
