-- Supabase migration: create core tables for Watson Control Tower
-- Run this in the Supabase SQL editor or via `supabase db push`.

-- ── Activity log ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS activity (
  id        TEXT    PRIMARY KEY,
  url       TEXT    NOT NULL DEFAULT '',
  title     TEXT    NOT NULL DEFAULT '',
  action    TEXT    NOT NULL CHECK (action IN ('visit', 'blocked')),
  reason    TEXT,
  timestamp BIGINT  NOT NULL,
  domain    TEXT    NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS activity_timestamp_idx ON activity (timestamp DESC);
CREATE INDEX IF NOT EXISTS activity_action_idx    ON activity (action);
CREATE INDEX IF NOT EXISTS activity_domain_idx    ON activity (domain);

-- ── Alerts ──────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS alerts (
  id        TEXT    PRIMARY KEY,
  url       TEXT    NOT NULL DEFAULT '',
  domain    TEXT    NOT NULL DEFAULT '',
  reason    TEXT    NOT NULL DEFAULT 'Blocked',
  timestamp BIGINT  NOT NULL,
  severity  TEXT    NOT NULL DEFAULT 'low'
);

CREATE INDEX IF NOT EXISTS alerts_timestamp_idx ON alerts (timestamp DESC);

-- ── Custom blocked-domain filters ───────────────────────────────────────────

CREATE TABLE IF NOT EXISTS custom_filters (
  domain TEXT PRIMARY KEY
);

-- ── Row Level Security ──────────────────────────────────────────────────────
-- Enable RLS on every table so that Supabase enforces access policies.
-- The policies below allow the anonymous/public (anon) role full access,
-- which matches the current single-family deployment model.  Tighten these
-- if you add per-user authentication later.

ALTER TABLE activity       ENABLE ROW LEVEL SECURITY;
ALTER TABLE alerts         ENABLE ROW LEVEL SECURITY;
ALTER TABLE custom_filters ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow public access on activity"
  ON activity FOR ALL
  USING (true)
  WITH CHECK (true);

CREATE POLICY "Allow public access on alerts"
  ON alerts FOR ALL
  USING (true)
  WITH CHECK (true);

CREATE POLICY "Allow public access on custom_filters"
  ON custom_filters FOR ALL
  USING (true)
  WITH CHECK (true);
