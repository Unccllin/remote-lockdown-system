-- 020: rearm_requests — SQLite version. See the PostgreSQL file for why (ADR-011, D-226).
-- SQLite has no UUID type, no NOW(), and no ADD COLUMN IF NOT EXISTS, so timestamps are ISO-8601
-- TEXT written by the route and the runner's `schema_migrations` bookkeeping is what makes the
-- migration idempotent. `expires_at` is compared as TEXT, which is valid for ISO-8601.

CREATE TABLE IF NOT EXISTS rearm_requests (
  device_id     TEXT PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
  hardware_uuid TEXT NOT NULL,
  hostname      TEXT,
  requested_at  TEXT NOT NULL,
  source_ip     TEXT,
  status        TEXT NOT NULL DEFAULT 'pending',
  decided_at    TEXT,
  decided_by    TEXT REFERENCES admins(id) ON DELETE SET NULL,
  expires_at    TEXT
);

CREATE INDEX IF NOT EXISTS rearm_requests_status_idx ON rearm_requests (status, requested_at DESC);
