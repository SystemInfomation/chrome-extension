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
 *    PostgreSQL / Supabase (durable across restarts, unlimited history).
 *  - A small in-memory ring buffer (MAX_HISTORY_ENTRIES) is kept solely for
 *    sending recent history to newly-connected dashboard clients over WebSocket.
 *
 * No authentication — this is a private household deployment.
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
        domain    TEXT        NOT NULL DEFAULT '',
        monitored_user_id TEXT NOT NULL DEFAULT 'default'
      );
      ALTER TABLE activity ADD COLUMN IF NOT EXISTS monitored_user_id TEXT NOT NULL DEFAULT 'default';
      CREATE INDEX IF NOT EXISTS activity_timestamp_idx ON activity (timestamp DESC);
      CREATE INDEX IF NOT EXISTS activity_action_idx    ON activity (action);
      CREATE INDEX IF NOT EXISTS activity_domain_idx    ON activity (domain);
      CREATE INDEX IF NOT EXISTS activity_user_timestamp_idx ON activity (monitored_user_id, timestamp DESC);

      CREATE TABLE IF NOT EXISTS alerts (
        id        TEXT PRIMARY KEY,
        url       TEXT   NOT NULL DEFAULT '',
        domain    TEXT   NOT NULL DEFAULT '',
        reason    TEXT   NOT NULL DEFAULT 'Blocked',
        timestamp BIGINT NOT NULL,
        severity  TEXT   NOT NULL DEFAULT 'low',
        monitored_user_id TEXT NOT NULL DEFAULT 'default'
      );
      ALTER TABLE alerts ADD COLUMN IF NOT EXISTS monitored_user_id TEXT NOT NULL DEFAULT 'default';
      CREATE INDEX IF NOT EXISTS alerts_timestamp_idx ON alerts (timestamp DESC);
      CREATE INDEX IF NOT EXISTS alerts_user_timestamp_idx ON alerts (monitored_user_id, timestamp DESC);

      CREATE TABLE IF NOT EXISTS custom_filters (
        monitored_user_id TEXT NOT NULL DEFAULT 'default',
        domain TEXT NOT NULL
      );
      ALTER TABLE custom_filters ADD COLUMN IF NOT EXISTS monitored_user_id TEXT NOT NULL DEFAULT 'default';
      CREATE UNIQUE INDEX IF NOT EXISTS custom_filters_user_domain_idx ON custom_filters (monitored_user_id, domain);

      CREATE TABLE IF NOT EXISTS monitored_user_profiles (
        monitored_user_id TEXT PRIMARY KEY,
        email TEXT NOT NULL DEFAULT '',
        display_name TEXT NOT NULL DEFAULT '',
        last_seen BIGINT NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS monitored_user_profiles_last_seen_idx ON monitored_user_profiles (last_seen DESC);
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
 * @typedef {{ id: string, url: string, title: string, action: "visit"|"blocked", reason: string|null, timestamp: number, domain: string, monitoredUserId: string }} ActivityEntry
 * @typedef {{ id: string, url: string, domain: string, reason: string, timestamp: number, severity: string, monitoredUserId: string }} AlertEntry
 */

/** @type {Map<string, ActivityEntry[]>} — newest entries at end per monitored user */
const recentActivityByUser = new Map();

/** @type {Map<string, AlertEntry[]>} — newest alerts at end per monitored user */
const recentAlertsByUser = new Map();
const MAX_ALERT_SIZE = 500;

/** @type {Map<string, Set<string>>} Custom blocked domains by monitored user */
const customFiltersByUser = new Map();

/** @type {Map<string, { monitoredUserId: string, email: string, displayName: string, online: boolean, lastSeen: number }>} */
const monitoredUserProfiles = new Map();

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function normalizeMonitoredUserId(rawId) {
  if (typeof rawId !== "string") return "default";
  const normalized = rawId.trim().toLowerCase();
  return normalized || "default";
}

function getRecentActivityForUser(monitoredUserId) {
  const key = normalizeMonitoredUserId(monitoredUserId);
  if (!recentActivityByUser.has(key)) recentActivityByUser.set(key, []);
  return recentActivityByUser.get(key);
}

function getRecentAlertsForUser(monitoredUserId) {
  const key = normalizeMonitoredUserId(monitoredUserId);
  if (!recentAlertsByUser.has(key)) recentAlertsByUser.set(key, []);
  return recentAlertsByUser.get(key);
}

function getFiltersForUser(monitoredUserId) {
  const key = normalizeMonitoredUserId(monitoredUserId);
  if (!customFiltersByUser.has(key)) customFiltersByUser.set(key, new Set());
  return customFiltersByUser.get(key);
}

function ensureMonitoredUserProfile(monitoredUserId, patch = {}) {
  const key = normalizeMonitoredUserId(monitoredUserId);
  const existing = monitoredUserProfiles.get(key) || {
    monitoredUserId: key,
    email: "",
    displayName: "",
    online: false,
    lastSeen: Date.now(),
  };
  const next = {
    ...existing,
    ...patch,
    monitoredUserId: key,
  };
  monitoredUserProfiles.set(key, next);
  return next;
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
  const bucket = getRecentActivityForUser(entry.monitoredUserId);
  bucket.push(entry);
  if (bucket.length > MAX_HISTORY_ENTRIES) {
    bucket.shift();
  }
}

/**
 * Append an alert to the in-memory ring buffer (newest at end).
 * @param {AlertEntry} alert
 */
function pushRecentAlert(alert) {
  const bucket = getRecentAlertsForUser(alert.monitoredUserId);
  bucket.push(alert);
  if (bucket.length > MAX_ALERT_SIZE) {
    bucket.shift();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// DB helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Persist a single activity entry to the database (fire-and-forget). */
function dbInsertActivity(entry) {
  if (!db) return;
  db.query(
    `INSERT INTO activity (id, url, title, action, reason, timestamp, domain, monitored_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (id) DO NOTHING`,
    [entry.id, entry.url, entry.title, entry.action, entry.reason, entry.timestamp, entry.domain, entry.monitoredUserId]
  ).catch((err) => console.error("[WatsonCT DB] insert activity:", err.message));
}

/** Persist a single alert entry to the database (fire-and-forget). */
function dbInsertAlert(alert) {
  if (!db) return;
  db.query(
    `INSERT INTO alerts (id, url, domain, reason, timestamp, severity, monitored_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (id) DO NOTHING`,
    [alert.id, alert.url, alert.domain, alert.reason, alert.timestamp, alert.severity, alert.monitoredUserId]
  ).catch((err) => console.error("[WatsonCT DB] insert alert:", err.message));
}

/**
 * Load all custom filters from the database into the in-memory set.
 */
async function loadFiltersFromDb() {
  if (!db) return;
  try {
    const { rows } = await db.query("SELECT monitored_user_id, domain FROM custom_filters");
    customFiltersByUser.clear();
    for (const row of rows) {
      getFiltersForUser(row.monitored_user_id).add(row.domain);
    }
    console.log(`[WatsonCT DB] Loaded ${rows.length} custom filters across ${customFiltersByUser.size} monitored users.`);
  } catch (err) {
    console.error("[WatsonCT DB] load filters:", err.message);
  }
}

async function loadMonitoredUserProfilesFromDb() {
  if (!db) return;
  try {
    const { rows } = await db.query(`
      SELECT monitored_user_id, email, display_name, last_seen
      FROM monitored_user_profiles
    `);
    for (const row of rows) {
      ensureMonitoredUserProfile(row.monitored_user_id, {
        email: row.email || "",
        displayName: row.display_name || "",
        lastSeen: Number(row.last_seen) || Date.now(),
        online: false,
      });
    }
  } catch (err) {
    console.error("[WatsonCT DB] load monitored user profiles:", err.message);
  }
}

function dbUpsertMonitoredUserProfile(monitoredUserId, profile = {}) {
  if (!db) return;
  const normalized = normalizeMonitoredUserId(monitoredUserId);
  const email = typeof profile.email === "string" ? profile.email : "";
  const displayName = typeof profile.displayName === "string" ? profile.displayName : "";
  const lastSeen = Number(profile.lastSeen) || Date.now();
  db.query(
    `INSERT INTO monitored_user_profiles (monitored_user_id, email, display_name, last_seen)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (monitored_user_id)
     DO UPDATE SET
       email = EXCLUDED.email,
       display_name = EXCLUDED.display_name,
       last_seen = EXCLUDED.last_seen`,
    [normalized, email, displayName, lastSeen]
  ).catch((err) => console.error("[WatsonCT DB] upsert monitored user profile:", err.message));
}

/** Persist a filter addition to the database (fire-and-forget). */
function dbAddFilter(monitoredUserId, domain) {
  if (!db) return;
  db.query(
    "INSERT INTO custom_filters (monitored_user_id, domain) VALUES ($1, $2) ON CONFLICT DO NOTHING",
    [normalizeMonitoredUserId(monitoredUserId), domain]
  ).catch((err) => console.error("[WatsonCT DB] add filter:", err.message));
}

/** Persist a filter removal to the database (fire-and-forget). */
function dbRemoveFilter(monitoredUserId, domain) {
  if (!db) return;
  db.query(
    "DELETE FROM custom_filters WHERE monitored_user_id = $1 AND domain = $2",
    [normalizeMonitoredUserId(monitoredUserId), domain]
  ).catch((err) => console.error("[WatsonCT DB] remove filter:", err.message));
}

// ─────────────────────────────────────────────────────────────────────────────
// Daily reset — clear activity + alerts every 24 h at midnight UTC
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Truncate the activity and alerts tables (not custom_filters — those are
 * configuration) and clear the matching in-memory ring buffers.
 * Broadcasts a `db_reset` event to all connected dashboards so they can
 * refresh their data.
 */
async function resetDailyData() {
  console.log("[WatsonCT] Daily reset — clearing activity and alerts.");

  // Clear in-memory buffers immediately so live clients see the clean state
  recentActivityByUser.clear();
  recentAlertsByUser.clear();

  if (db) {
    try {
      await db.query("TRUNCATE TABLE activity, alerts");
      console.log("[WatsonCT DB] activity and alerts tables truncated.");
    } catch (err) {
      console.error("[WatsonCT DB] daily reset failed:", err.message);
    }
  }

  // Notify all connected dashboards so they can refresh their views
  broadcast({ type: "db_reset", timestamp: Date.now() }, "dashboard");
}

/**
 * Schedule `resetDailyData` to run at the next UTC midnight and then every
 * 24 hours thereafter.  Using a single-shot timeout aligned to midnight rather
 * than a plain 24 h interval means the reset always happens at the same wall-
 * clock time regardless of when the server started.
 */
function scheduleMidnightReset() {
  const now         = Date.now();
  const nextMidnight = (() => {
    const d = new Date(now);
    // Advance to the start of the next UTC day
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
  })();
  const msUntilMidnight = nextMidnight - now;

  console.log(`[WatsonCT] Daily reset scheduled in ${Math.round(msUntilMidnight / 60_000)} minutes (at next UTC midnight).`);

  setTimeout(() => {
    resetDailyData();
    // After the first aligned reset, repeat exactly every 24 h
    setInterval(resetDailyData, 24 * 60 * 60 * 1000);
  }, msUntilMidnight);
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
  const monitoredUserId = normalizeMonitoredUserId(_req.query.monitoredUserId);
  const extensionConnected = [...clients.values()].some(
    (m) => m.role === "extension" && m.monitoredUserId === monitoredUserId
  );
  res.json({
    monitoredUserId,
    extensionConnected,
    uptime: process.uptime(),
    dbConnected: db !== null,
  });
});

app.get("/api/monitored-users", async (_req, res) => {
  const connected = new Set(
    [...clients.values()]
      .filter((m) => m.role === "extension")
      .map((m) => m.monitoredUserId)
  );

  const users = new Map();
  for (const [id, profile] of monitoredUserProfiles.entries()) {
    users.set(id, {
      monitoredUserId: id,
      email: profile.email || "",
      displayName: profile.displayName || "",
      online: connected.has(id),
      lastSeen: profile.lastSeen || Date.now(),
    });
  }
  for (const monitoredUserId of connected) {
    const existing = users.get(monitoredUserId) || {
      monitoredUserId,
      email: "",
      displayName: "",
      lastSeen: Date.now(),
    };
    users.set(monitoredUserId, { ...existing, online: true });
  }

  if (db) {
    try {
      const { rows } = await db.query(`
        SELECT monitored_user_id, '' AS email, '' AS display_name, MAX(timestamp) AS last_seen FROM activity GROUP BY monitored_user_id
        UNION
        SELECT monitored_user_id, '' AS email, '' AS display_name, MAX(timestamp) AS last_seen FROM alerts GROUP BY monitored_user_id
        UNION
        SELECT monitored_user_id, '' AS email, '' AS display_name, 0 AS last_seen FROM custom_filters
        UNION
        SELECT monitored_user_id, email, display_name, last_seen FROM monitored_user_profiles
      `);
      for (const row of rows) {
        const id = normalizeMonitoredUserId(row.monitored_user_id);
        const existing = users.get(id) || {
          monitoredUserId: id,
          email: "",
          displayName: "",
          lastSeen: 0,
        };
        users.set(id, {
          monitoredUserId: id,
          email: existing.email || row.email || "",
          displayName: existing.displayName || row.display_name || "",
          online: connected.has(id),
          lastSeen: Math.max(existing.lastSeen || 0, Number(row.last_seen) || 0),
        });
      }
    } catch (err) {
      console.error("[WatsonCT DB] GET /api/monitored-users:", err.message);
    }
  }

  if (users.size === 0) {
    users.set("default", { monitoredUserId: "default", email: "", displayName: "", online: false, lastSeen: 0 });
  }

  res.json({ users: [...users.values()].sort((a, b) => a.monitoredUserId.localeCompare(b.monitoredUserId)) });
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
    monitoredUserId: monitoredUserIdParam,
  } = req.query;
  const monitoredUserId = normalizeMonitoredUserId(monitoredUserIdParam);

  const pageNum  = Math.max(1, parseInt(page, 10)  || 1);
  const limitNum = Math.min(200, Math.max(1, parseInt(limit, 10) || 50));
  const offset   = (pageNum - 1) * limitNum;

  if (db) {
    // ── PostgreSQL path ──────────────────────────────────────────────────────
    try {
      const conditions = [];
      const params     = [];
      let   p          = 1;

      conditions.push(`monitored_user_id = $${p++}`); params.push(monitoredUserId);
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
          `SELECT id, url, title, action, reason, timestamp, domain, monitored_user_id
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
        items: rowsRes.rows.map((r) => ({
          ...r,
          timestamp: Number(r.timestamp),
          monitoredUserId: r.monitored_user_id,
        })),
      });
    } catch (err) {
      console.error("[WatsonCT DB] GET /api/activity:", err.message);
      return res.status(500).json({ error: "database error" });
    }
  }

  // ── In-memory fallback (no DB configured) ───────────────────────────────
  let filtered = getRecentActivityForUser(monitoredUserId).slice().reverse();

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
  const monitoredUserId = normalizeMonitoredUserId(_req.query.monitoredUserId);
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayTs = todayStart.getTime();

  if (db) {
    try {
      const [totRes, blkRes, domRes] = await Promise.all([
        db.query("SELECT COUNT(*) AS cnt FROM activity WHERE monitored_user_id = $1 AND timestamp >= $2", [monitoredUserId, todayTs]),
        db.query("SELECT COUNT(*) AS cnt FROM activity WHERE monitored_user_id = $1 AND timestamp >= $2 AND action = 'blocked'", [monitoredUserId, todayTs]),
        db.query(
          `SELECT domain, COUNT(*) AS cnt
             FROM activity
            WHERE monitored_user_id = $1 AND timestamp >= $2
            GROUP BY domain
            ORDER BY cnt DESC
            LIMIT 10`,
          [monitoredUserId, todayTs]
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
  const todayEntries = getRecentActivityForUser(monitoredUserId).filter((e) => e.timestamp >= todayTs);
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
  const { page = "1", limit = "50", monitoredUserId: monitoredUserIdParam } = req.query;
  const monitoredUserId = normalizeMonitoredUserId(monitoredUserIdParam);
  const pageNum  = Math.max(1, parseInt(page, 10)  || 1);
  const limitNum = Math.min(200, Math.max(1, parseInt(limit, 10) || 50));
  const offset   = (pageNum - 1) * limitNum;

  if (db) {
    try {
      const [countRes, rowsRes] = await Promise.all([
        db.query("SELECT COUNT(*) AS cnt FROM alerts WHERE monitored_user_id = $1", [monitoredUserId]),
        db.query(
          `SELECT id, url, domain, reason, timestamp, severity, monitored_user_id
             FROM alerts
            WHERE monitored_user_id = $3
            ORDER BY timestamp DESC
            LIMIT $1 OFFSET $2`,
          [limitNum, offset, monitoredUserId]
        ),
      ]);
      return res.json({
        total: parseInt(countRes.rows[0].cnt, 10),
        page:  pageNum,
        limit: limitNum,
        items: rowsRes.rows.map((r) => ({
          ...r,
          timestamp: Number(r.timestamp),
          monitoredUserId: r.monitored_user_id,
        })),
      });
    } catch (err) {
      console.error("[WatsonCT DB] GET /api/alerts:", err.message);
      return res.status(500).json({ error: "database error" });
    }
  }

  // Fallback — not meaningful without DB but kept for compatibility
  const reversed = getRecentAlertsForUser(monitoredUserId).slice().reverse();
  const total = reversed.length;
  const items = reversed.slice(offset, offset + limitNum);
  return res.json({ total, page: pageNum, limit: limitNum, items });
});

// ─── GET /api/filters ────────────────────────────────────────────────────────
app.get("/api/filters", (req, res) => {
  const monitoredUserId = normalizeMonitoredUserId(req.query.monitoredUserId);
  res.json({ monitoredUserId, filters: Array.from(getFiltersForUser(monitoredUserId)) });
});

// ─── POST /api/filters ───────────────────────────────────────────────────────
app.post("/api/filters", (req, res) => {
  const { domain, monitoredUserId: monitoredUserIdRaw } = req.body || {};
  const monitoredUserId = normalizeMonitoredUserId(monitoredUserIdRaw);
  if (!domain || typeof domain !== "string") {
    return res.status(400).json({ error: "domain is required" });
  }
  const normalized = domain.trim().toLowerCase().replace(/^www\./, "");
  if (!normalized || !normalized.includes(".")) {
    return res.status(400).json({ error: "invalid domain" });
  }
  getFiltersForUser(monitoredUserId).add(normalized);
  dbAddFilter(monitoredUserId, normalized);

  // Broadcast add_filter command to connected extensions
  broadcast({ type: "add_filter", domain: normalized, monitoredUserId }, "extension", monitoredUserId);

  res.json({ ok: true, monitoredUserId, domain: normalized, filters: Array.from(getFiltersForUser(monitoredUserId)) });
});

// ─── DELETE /api/filters/:domain ─────────────────────────────────────────────
app.delete("/api/filters/:domain", (req, res) => {
  const monitoredUserId = normalizeMonitoredUserId(req.query.monitoredUserId);
  const domain = decodeURIComponent(req.params.domain).trim().toLowerCase().replace(/^www\./, "");
  const filters = getFiltersForUser(monitoredUserId);
  if (!filters.has(domain)) {
    return res.status(404).json({ error: "domain not found" });
  }
  filters.delete(domain);
  dbRemoveFilter(monitoredUserId, domain);

  // Broadcast remove_filter command to connected extensions
  broadcast({ type: "remove_filter", domain, monitoredUserId }, "extension", monitoredUserId);

  res.json({ ok: true, monitoredUserId, domain, filters: Array.from(filters) });
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
 * @type {Map<import("ws").WebSocket, { role: "extension"|"dashboard", monitoredUserId: string }>}
 */
const clients = new Map();

/**
 * Broadcast a message to clients matching the given role filter.
 * If role is omitted, broadcasts to all clients.
 *
 * @param {object} payload
 * @param {"extension"|"dashboard"|undefined} targetRole
 * @param {string|undefined} targetMonitoredUserId
 */
function broadcast(payload, targetRole, targetMonitoredUserId) {
  const msg = JSON.stringify(payload);
  const normalizedUser = targetMonitoredUserId ? normalizeMonitoredUserId(targetMonitoredUserId) : undefined;
  for (const [ws, meta] of clients.entries()) {
    if (ws.readyState !== ws.OPEN) continue;
    if (targetRole && meta.role !== targetRole) continue;
    if (normalizedUser && meta.monitoredUserId !== normalizedUser) continue;
    ws.send(msg);
  }
}

wss.on("connection", (ws, req) => {
  const url  = new URL(req.url, `http://${req.headers.host}`);
  const role = url.searchParams.get("role") === "extension" ? "extension" : "dashboard";
  const monitoredUserId = normalizeMonitoredUserId(
    url.searchParams.get("monitoredUserId")
    || url.searchParams.get("userId")
    || url.searchParams.get("email")
  );
  clients.set(ws, { role, monitoredUserId });

  console.log(`[WatsonCT WS] ${role}:${monitoredUserId} connected (${clients.size} total)`);

  if (role === "extension") {
    ensureMonitoredUserProfile(monitoredUserId, { online: true, lastSeen: Date.now() });
    broadcast({ type: "status", status: "online", monitoredUserId }, "dashboard", monitoredUserId);
    const filters = Array.from(getFiltersForUser(monitoredUserId));
    if (filters.length > 0) {
      ws.send(JSON.stringify({ type: "filters_sync", monitoredUserId, filters }));
    }
    ws.send(JSON.stringify({ type: "start_screen_stream" }));
  } else {
    const anyExtension = [...clients.values()].some(
      (m) => m.role === "extension" && m.monitoredUserId === monitoredUserId
    );
    ws.send(JSON.stringify({ type: "status", monitoredUserId, status: anyExtension ? "online" : "offline" }));
    const recent = getRecentActivityForUser(monitoredUserId).slice().reverse();
    if (recent.length > 0) {
      ws.send(JSON.stringify({ type: "history", monitoredUserId, entries: recent }));
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
      const eventUserId = normalizeMonitoredUserId(msg.monitoredUserId || monitoredUserId);
      const entry = {
        id:        generateId(),
        url:       msg.url       || "",
        title:     msg.title     || "",
        action:    msg.action === "blocked" ? "blocked" : "visit",
        reason:    msg.reason    || null,
        timestamp: msg.timestamp || Date.now(),
        domain:    extractDomain(msg.url || ""),
        monitoredUserId: eventUserId,
      };

      dbInsertActivity(entry);
      pushRecent(entry);

      if (entry.action === "blocked") {
        const alert = {
          id:        entry.id,
          url:       entry.url,
          domain:    entry.domain,
          reason:    entry.reason || "Blocked",
          timestamp: entry.timestamp,
          severity:  getSeverity(entry.reason),
          monitoredUserId: eventUserId,
        };
        dbInsertAlert(alert);
        pushRecentAlert(alert);
        broadcast({ type: "alert", monitoredUserId: eventUserId, alert }, "dashboard", eventUserId);
      }
      broadcast({ type: "activity", monitoredUserId: eventUserId, entry }, "dashboard", eventUserId);

    } else if (msg.type === "screenshot") {
      if (role === "extension" && msg.data) {
        const eventUserId = normalizeMonitoredUserId(msg.monitoredUserId || monitoredUserId);
        broadcast(
          {
            type:      "screenshot",
            monitoredUserId: eventUserId,
            data:      msg.data,
            timestamp: msg.timestamp || Date.now(),
            url:       msg.url      || "",
            title:     msg.title    || "",
            windowId:  msg.windowId ?? null,
            focused:   msg.focused  === true,
          },
          "dashboard",
          eventUserId
        );
      }

    } else if (msg.type === "start_screen_stream") {
      if (role === "dashboard") {
        const targetUser = normalizeMonitoredUserId(msg.monitoredUserId || monitoredUserId);
        broadcast({ type: "start_screen_stream", monitoredUserId: targetUser }, "extension", targetUser);
      }

    } else if (msg.type === "stop_screen_stream") {
      if (role === "dashboard") {
        const targetUser = normalizeMonitoredUserId(msg.monitoredUserId || monitoredUserId);
        broadcast({ type: "stop_screen_stream", monitoredUserId: targetUser }, "extension", targetUser);
      }

    } else if (msg.type === "status") {
      if (role === "extension") {
        const eventUserId = normalizeMonitoredUserId(msg.monitoredUserId || monitoredUserId);
        broadcast({ type: "status", monitoredUserId: eventUserId, status: "online" }, "dashboard", eventUserId);
      }
    } else if (msg.type === "open_tabs") {
      if (role === "extension" && Array.isArray(msg.tabs)) {
        const eventUserId = normalizeMonitoredUserId(msg.monitoredUserId || monitoredUserId);
        broadcast({ type: "open_tabs", monitoredUserId: eventUserId, tabs: msg.tabs, timestamp: msg.timestamp || Date.now() }, "dashboard", eventUserId);
      }
    } else if (msg.type === "set_internet_blocked") {
      if (role === "dashboard") {
        const targetUser = normalizeMonitoredUserId(msg.monitoredUserId || monitoredUserId);
        broadcast({ type: "set_internet_blocked", monitoredUserId: targetUser, blocked: msg.blocked === true }, "extension", targetUser);
      }
    } else if (msg.type === "get_internet_status") {
      if (role === "dashboard") {
        const targetUser = normalizeMonitoredUserId(msg.monitoredUserId || monitoredUserId);
        broadcast({ type: "get_internet_status", monitoredUserId: targetUser }, "extension", targetUser);
      }
    } else if (msg.type === "internet_status") {
      if (role === "extension") {
        const eventUserId = normalizeMonitoredUserId(msg.monitoredUserId || monitoredUserId);
        broadcast({ type: "internet_status", monitoredUserId: eventUserId, blocked: msg.blocked === true }, "dashboard", eventUserId);
      }

    } else if (msg.type === "close_tab") {
      if (role === "dashboard" && typeof msg.tabId === "number") {
        const targetUser = normalizeMonitoredUserId(msg.monitoredUserId || monitoredUserId);
        broadcast({ type: "close_tab", monitoredUserId: targetUser, tabId: msg.tabId }, "extension", targetUser);
      }

    } else if (msg.type === "set_focus_mode") {
      if (role === "dashboard") {
        const targetUser = normalizeMonitoredUserId(msg.monitoredUserId || monitoredUserId);
        broadcast({
          type: "set_focus_mode",
          monitoredUserId: targetUser,
          enabled: msg.enabled === true,
          allowedDomains: Array.isArray(msg.allowedDomains) ? msg.allowedDomains : [],
        }, "extension", targetUser);
      }
    } else if (msg.type === "update_focus_domains") {
      if (role === "dashboard" && Array.isArray(msg.allowedDomains)) {
        const targetUser = normalizeMonitoredUserId(msg.monitoredUserId || monitoredUserId);
        broadcast({ type: "update_focus_domains", monitoredUserId: targetUser, allowedDomains: msg.allowedDomains }, "extension", targetUser);
      }
    } else if (msg.type === "get_focus_mode") {
      if (role === "dashboard") {
        const targetUser = normalizeMonitoredUserId(msg.monitoredUserId || monitoredUserId);
        broadcast({ type: "get_focus_mode", monitoredUserId: targetUser }, "extension", targetUser);
      }
    } else if (msg.type === "focus_mode_status") {
      if (role === "extension") {
        const eventUserId = normalizeMonitoredUserId(msg.monitoredUserId || monitoredUserId);
        broadcast({
          type: "focus_mode_status",
          monitoredUserId: eventUserId,
          enabled: msg.enabled === true,
          allowedDomains: Array.isArray(msg.allowedDomains) ? msg.allowedDomains : [],
        }, "dashboard", eventUserId);
      }
    } else if (msg.type === "identity" && role === "extension") {
      const identityUser = normalizeMonitoredUserId(msg.monitoredUserId || msg.id || msg.email || monitoredUserId);
      clients.set(ws, { role, monitoredUserId: identityUser });
      const profile = ensureMonitoredUserProfile(identityUser, {
        email: typeof msg.email === "string" ? msg.email : "",
        displayName: typeof msg.displayName === "string" ? msg.displayName : "",
        online: true,
        lastSeen: Date.now(),
      });
      dbUpsertMonitoredUserProfile(identityUser, profile);
      broadcast(
        {
          type: "identity",
          monitoredUserId: identityUser,
          email: profile.email || "",
          displayName: profile.displayName || "",
          id: msg.id || "",
          status: "online",
        },
        "dashboard",
        identityUser
      );
      const filters = Array.from(getFiltersForUser(identityUser));
      ws.send(JSON.stringify({ type: "filters_sync", monitoredUserId: identityUser, filters }));
      broadcast({ type: "status", monitoredUserId: identityUser, status: "online" }, "dashboard", identityUser);
    } else if (msg.type === "filters_sync" && role === "extension" && Array.isArray(msg.filters)) {
      const eventUserId = normalizeMonitoredUserId(msg.monitoredUserId || monitoredUserId);
      const next = getFiltersForUser(eventUserId);
      next.clear();
      for (const domain of msg.filters) {
        if (typeof domain === "string" && domain.includes(".")) next.add(domain.trim().toLowerCase());
      }
    }
  });

  ws.on("close", () => {
    clients.delete(ws);
    const anyExtensionForUser = [...clients.values()].some(
      (m) => m.role === "extension" && m.monitoredUserId === monitoredUserId
    );
    if (!anyExtensionForUser && role === "extension") {
      ensureMonitoredUserProfile(monitoredUserId, { online: false, lastSeen: Date.now() });
      broadcast({ type: "status", monitoredUserId, status: "offline" }, "dashboard", monitoredUserId);
      broadcast({ type: "screen_stream_stopped", monitoredUserId }, "dashboard", monitoredUserId);
    }
    console.log(`[WatsonCT WS] ${role}:${monitoredUserId} disconnected (${clients.size} remaining)`);
  });

  ws.on("error", (err) => {
    console.error(`[WatsonCT WS] ${role}:${monitoredUserId} error:`, err.message);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Start
// ─────────────────────────────────────────────────────────────────────────────

async function start() {
  // Initialise DB schema and load persisted filters before accepting traffic
  await initDb();
  await loadFiltersFromDb();
  await loadMonitoredUserProfilesFromDb();

  // Schedule the daily 24 h data reset (activity + alerts) at UTC midnight
  scheduleMidnightReset();

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
