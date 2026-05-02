-- Add monitored user identity profile storage for dashboard labeling.

ALTER TABLE activity
  ADD COLUMN IF NOT EXISTS monitored_user_id TEXT NOT NULL DEFAULT 'default';

ALTER TABLE alerts
  ADD COLUMN IF NOT EXISTS monitored_user_id TEXT NOT NULL DEFAULT 'default';

ALTER TABLE custom_filters
  ADD COLUMN IF NOT EXISTS monitored_user_id TEXT NOT NULL DEFAULT 'default';

CREATE INDEX IF NOT EXISTS activity_user_timestamp_idx
  ON activity (monitored_user_id, timestamp DESC);

CREATE INDEX IF NOT EXISTS alerts_user_timestamp_idx
  ON alerts (monitored_user_id, timestamp DESC);

CREATE UNIQUE INDEX IF NOT EXISTS custom_filters_user_domain_idx
  ON custom_filters (monitored_user_id, domain);

CREATE TABLE IF NOT EXISTS monitored_user_profiles (
  monitored_user_id TEXT PRIMARY KEY,
  email TEXT NOT NULL DEFAULT '',
  display_name TEXT NOT NULL DEFAULT '',
  last_seen BIGINT NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS monitored_user_profiles_last_seen_idx
  ON monitored_user_profiles (last_seen DESC);
