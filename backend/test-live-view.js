/**
 * End-to-end test for the PalsPlan live view system.
 *
 * Spawns the real server.js as a child process (no DATABASE_URL → in-memory
 * mode), then simulates:
 *  1. A dashboard client connecting and receiving status/history messages.
 *  2. An extension client connecting and broadcasting activity events.
 *  3. The dashboard receiving those activity events in real-time.
 *  4. The dashboard requesting a screen stream and the extension receiving
 *     the start command, then the dashboard receiving a screenshot.
 *  5. REST API endpoints returning the stored activity.
 *
 * Run with: node test-live-view.js
 * Exit code 0 = all assertions passed.
 * Exit code 1 = one or more assertions failed.
 */

"use strict";

const http      = require("http");
const WebSocket = require("ws");

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    console.log(`  ✓  ${label}`);
    passed++;
  } else {
    console.error(`  ✗  FAIL: ${label}`);
    failed++;
  }
}

// ─── Spawn the real server on a random port ────────────────────────────────

const { spawn } = require("child_process");
const path      = require("path");

const PORT = 13579; // fixed test port (unlikely to conflict)

async function waitForServer(port, retries = 20) {
  for (let i = 0; i < retries; i++) {
    await sleep(200);
    const ok = await new Promise((resolve) => {
      const req = http.get(`http://localhost:${port}/`, (res) => {
        res.resume();
        resolve(res.statusCode < 500);
      });
      req.on("error", () => resolve(false));
    });
    if (ok) return;
  }
  throw new Error(`Server on port ${port} did not start in time`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function wsConnect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.once("open",  () => resolve(ws));
    ws.once("error", reject);
  });
}

function nextMessage(ws, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("message timeout")), timeoutMs);
    ws.once("message", (data) => {
      clearTimeout(t);
      try { resolve(JSON.parse(data.toString())); }
      catch { resolve(data.toString()); }
    });
  });
}

function collectMessages(ws, count, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const msgs = [];
    const t = setTimeout(() => resolve(msgs), timeoutMs); // resolve with whatever we got
    ws.on("message", function handler(data) {
      try { msgs.push(JSON.parse(data.toString())); } catch { msgs.push(data.toString()); }
      if (msgs.length >= count) {
        clearTimeout(t);
        ws.removeListener("message", handler);
        resolve(msgs);
      }
    });
  });
}

async function run() {
  console.log("\n=== PalsPlan Live View End-to-End Test ===\n");

  // ── 1. Start the server ──────────────────────────────────────────────────
  console.log("Starting backend server on port", PORT, "...");
  const serverProc = spawn(
    process.execPath,
    [path.join(__dirname, "server.js")],
    {
      env: { ...process.env, PORT: String(PORT) }, // no DATABASE_URL → in-memory mode
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
  serverProc.stdout.on("data", (d) => process.stdout.write("[server] " + d));
  serverProc.stderr.on("data", (d) => process.stderr.write("[server] " + d));

  try {
    await waitForServer(PORT);
    console.log("Server ready.\n");
  } catch (err) {
    console.error("Server failed to start:", err.message);
    serverProc.kill();
    process.exit(1);
  }

  const BASE = `http://localhost:${PORT}`;
  const WS   = `ws://localhost:${PORT}/ws`;

  // ── 2. Health check ──────────────────────────────────────────────────────
  console.log("── REST: health check ──────────────────────────────────────");
  {
    const body = await httpGet(`${BASE}/`);
    assert(body.status === "ok", "GET / returns {status:'ok'}");
    const status = await httpGet(`${BASE}/api/status`);
    assert(status.extensionConnected === false, "extensionConnected starts false");
    assert(status.dbConnected === false, "dbConnected is false (no DATABASE_URL)");
  }

  // ── 3. Dashboard connects, gets offline status ────────────────────────────
  console.log("\n── WebSocket: dashboard connects ───────────────────────────");
  const dash = await wsConnect(`${WS}?role=dashboard`);
  const statusMsg = await nextMessage(dash);
  assert(statusMsg.type === "status", "dashboard receives status message on connect");
  assert(statusMsg.status === "offline", "status is 'offline' (no extension yet)");

  // ── 4. Extension connects, dashboard gets online notification ─────────────
  console.log("\n── WebSocket: extension connects ───────────────────────────");

  // Collect the next message on the dashboard socket (should be status:online)
  const onlinePromise = nextMessage(dash);
  const ext = await wsConnect(`${WS}?role=extension`);
  const onlineMsg = await onlinePromise;
  assert(onlineMsg.type === "status",   "dashboard notified when extension connects");
  assert(onlineMsg.status === "online", "status is 'online'");

  const statusAfter = await httpGet(`${BASE}/api/status`);
  assert(statusAfter.extensionConnected === true, "REST /api/status shows extensionConnected=true");

  // ── 5. Extension sends activity events ───────────────────────────────────
  console.log("\n── WebSocket: activity events ──────────────────────────────");
  const activityPromise = collectMessages(dash, 3);

  ext.send(JSON.stringify({ type: "activity", url: "https://example.com/page", title: "Example", action: "visit",   timestamp: Date.now() }));
  ext.send(JSON.stringify({ type: "activity", url: "https://bad-site.com/",     title: "Bad",     action: "blocked", reason: "adult content", timestamp: Date.now() }));
  ext.send(JSON.stringify({ type: "activity", url: "https://google.com/",       title: "Google",  action: "visit",   timestamp: Date.now() }));

  const actMsgs = await activityPromise;
  // actMsgs may include the alert for the blocked entry too; filter to activity
  const actEvents = actMsgs.filter((m) => m.type === "activity");
  assert(actEvents.length >= 2,                            "dashboard receives activity events in real-time");
  assert(actEvents[0].entry.url === "https://example.com/page", "first activity URL matches");

  const alertEvents = actMsgs.filter((m) => m.type === "alert");
  assert(alertEvents.length >= 1,                         "dashboard receives alert for blocked entry");
  assert(alertEvents[0].alert.domain === "bad-site.com",  "alert domain is correct");
  assert(alertEvents[0].alert.severity === "critical",    "alert severity is 'critical' for adult content");

  // ── 6. REST: activity log ────────────────────────────────────────────────
  console.log("\n── REST: activity log ──────────────────────────────────────");
  await sleep(100); // give server a moment to process
  const actLog = await httpGet(`${BASE}/api/activity`);
  assert(actLog.total >= 3,          "activity log has at least 3 entries");
  assert(Array.isArray(actLog.items), "items is an array");
  assert(actLog.items[0].url === "https://google.com/", "newest entry is google.com");

  // Filter: blocked only
  const blockedLog = await httpGet(`${BASE}/api/activity?action=blocked`);
  assert(blockedLog.items.every((e) => e.action === "blocked"), "filter action=blocked works");

  // Search
  const searchLog = await httpGet(`${BASE}/api/activity?search=google`);
  assert(searchLog.items.some((e) => e.domain === "google.com"), "search filter works");

  // ── 7. REST: stats ───────────────────────────────────────────────────────
  console.log("\n── REST: stats ─────────────────────────────────────────────");
  const stats = await httpGet(`${BASE}/api/activity/stats`);
  assert(stats.totalToday   >= 3, "stats.totalToday   >= 3");
  assert(stats.blockedToday >= 1, "stats.blockedToday >= 1");
  assert(Array.isArray(stats.topDomains), "stats.topDomains is an array");

  // ── 8. REST: alerts ──────────────────────────────────────────────────────
  console.log("\n── REST: alerts ────────────────────────────────────────────");
  const alerts = await httpGet(`${BASE}/api/alerts`);
  assert(alerts.total >= 1,          "alerts log has at least 1 entry");
  assert(alerts.items[0].severity,   "alert has severity field");

  // ── 9. Screen stream relay ───────────────────────────────────────────────
  console.log("\n── WebSocket: screen stream relay ──────────────────────────");

  // Extension listens for start_screen_stream
  const streamCmdPromise = nextMessage(ext);

  dash.send(JSON.stringify({ type: "start_screen_stream" }));
  const streamCmd = await streamCmdPromise;
  assert(streamCmd.type === "start_screen_stream", "extension receives start_screen_stream from dashboard");

  // Extension sends a screenshot frame
  const screenshotPromise = nextMessage(dash);
  const fakeDataUrl = "data:image/jpeg;base64,/9j/fake==";
  ext.send(JSON.stringify({ type: "screenshot", data: fakeDataUrl, timestamp: Date.now(), url: "https://example.com", title: "Example" }));

  const ssMsg = await screenshotPromise;
  assert(ssMsg.type === "screenshot",    "dashboard receives screenshot message");
  assert(ssMsg.data === fakeDataUrl,     "screenshot data is relayed intact");

  // Dashboard stops the stream
  const stopCmdPromise = nextMessage(ext);
  dash.send(JSON.stringify({ type: "stop_screen_stream" }));
  const stopCmd = await stopCmdPromise;
  assert(stopCmd.type === "stop_screen_stream", "extension receives stop_screen_stream");

  // ── 10. Custom filters via REST ──────────────────────────────────────────
  console.log("\n── REST: custom filters ────────────────────────────────────");
  const addFilterPromise = nextMessage(ext); // extension should receive add_filter
  const addRes = await httpPost(`${BASE}/api/filters`, { domain: "blocked-example.com" });
  assert(addRes.ok === true,                       "POST /api/filters returns ok:true");
  assert(addRes.filters.includes("blocked-example.com"), "filter added to list");

  const filterCmd = await addFilterPromise;
  assert(filterCmd.type === "add_filter",            "extension receives add_filter command");
  assert(filterCmd.domain === "blocked-example.com", "add_filter domain is correct");

  // Verify GET
  const filtersRes = await httpGet(`${BASE}/api/filters`);
  assert(filtersRes.filters.includes("blocked-example.com"), "GET /api/filters shows new filter");

  // Remove it
  const removeRes = await httpDelete(`${BASE}/api/filters/blocked-example.com`);
  assert(removeRes.ok === true, "DELETE /api/filters/:domain returns ok:true");
  const filtersAfter = await httpGet(`${BASE}/api/filters`);
  assert(!filtersAfter.filters.includes("blocked-example.com"), "filter removed from list");

  // ── 11. Disconnect extension → dashboard notified ─────────────────────────
  console.log("\n── WebSocket: extension disconnect ─────────────────────────");
  const offlinePromise = nextMessage(dash);
  ext.close();
  const offlineMsg = await offlinePromise;
  assert(offlineMsg.type === "status",    "dashboard notified when extension disconnects");
  assert(offlineMsg.status === "offline", "status is 'offline' after extension leaves");

  // ── 12. New dashboard gets history ────────────────────────────────────────
  console.log("\n── WebSocket: history on connect ───────────────────────────");
  const dash2 = await wsConnect(`${WS}?role=dashboard`);
  const msgs2 = await collectMessages(dash2, 2, 2000);
  const histMsg = msgs2.find((m) => m.type === "history");
  assert(histMsg !== undefined,                  "new dashboard receives history on connect");
  assert(Array.isArray(histMsg.entries),         "history.entries is an array");
  assert(histMsg.entries.length >= 3,            "history contains the 3 activity entries sent earlier");

  // ── Clean up ─────────────────────────────────────────────────────────────
  dash.close();
  dash2.close();
  serverProc.kill();

  // ── Results ──────────────────────────────────────────────────────────────
  console.log(`\n${"─".repeat(52)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.error("SOME TESTS FAILED");
    process.exit(1);
  } else {
    console.log("ALL TESTS PASSED ✓");
    process.exit(0);
  }
}

// ─── HTTP helpers ──────────────────────────────────────────────────────────

function httpGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        try { resolve(JSON.parse(body)); } catch { resolve(body); }
      });
    }).on("error", reject);
  });
}

function httpPost(url, data) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(data);
    const opts = Object.assign(new URL(url), {
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
    });
    const req = http.request(opts, (res) => {
      let buf = "";
      res.on("data", (c) => (buf += c));
      res.on("end", () => {
        try { resolve(JSON.parse(buf)); } catch { resolve(buf); }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function httpDelete(url) {
  return new Promise((resolve, reject) => {
    const opts = Object.assign(new URL(url), { method: "DELETE" });
    const req = http.request(opts, (res) => {
      let buf = "";
      res.on("data", (c) => (buf += c));
      res.on("end", () => {
        try { resolve(JSON.parse(buf)); } catch { resolve(buf); }
      });
    });
    req.on("error", reject);
    req.end();
  });
}

run().catch((err) => {
  console.error("Unhandled error:", err);
  process.exit(1);
});
