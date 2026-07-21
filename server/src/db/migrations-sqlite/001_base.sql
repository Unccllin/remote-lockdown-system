-- Base schema — SQLite version of 001_base.sql
--
-- SQLite type differences from PostgreSQL:
--   UUID        → TEXT (we generate via lower(hex(randomblob(16))))
--   TIMESTAMPTZ → TEXT (ISO8601 strings, UTC)
--   JSONB       → TEXT (JSON strings, parsed in JS with JSON.parse)
--   BOOLEAN     → INTEGER (0/1)
--
-- SQLite doesn't support:
--   - CREATE EXTENSION (pgcrypto) — not needed, gen_random_uuid() translated
--   - DO $$ ... $$ blocks — not needed in SQLite
--   - gen_random_uuid() — translated to lower(hex(randomblob(16))) by sqlitePool

-- SQLite can't use gen_random_uuid() as a DEFAULT, but we can use
-- lower(hex(randomblob(16))) which generates a 32-char hex string.
-- This mimics PostgreSQL's DEFAULT gen_random_uuid() behavior.

CREATE TABLE IF NOT EXISTS admins (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  username VARCHAR(100) UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  hostname VARCHAR(255) NOT NULL,
  owner_name VARCHAR(255) NOT NULL,
  status VARCHAR(50) NOT NULL DEFAULT 'active',
  mac_address VARCHAR(100) UNIQUE,
  hardware_uuid VARCHAR(255) UNIQUE,
  last_checkin TEXT,
  enrolled_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS commands (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  command_type VARCHAR(50) NOT NULL,
  status VARCHAR(50) NOT NULL DEFAULT 'pending',
  created_at TEXT DEFAULT (datetime('now')),
  executed_at TEXT
);

CREATE TABLE IF NOT EXISTS encryption_keys (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  key_material TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  released_at TEXT
);

CREATE TABLE IF NOT EXISTS bios_passwords (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  password TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  device_id TEXT REFERENCES devices(id) ON DELETE SET NULL,
  admin_id TEXT REFERENCES admins(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  detail TEXT,
  timestamp TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS location_reports (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  latitude DOUBLE PRECISION,
  longitude DOUBLE PRECISION,
  accuracy_meters DOUBLE PRECISION,
  source VARCHAR(20) DEFAULT 'ip',
  city VARCHAR(255),
  region VARCHAR(255),
  country VARCHAR(10),
  ip_address VARCHAR(100),
  wifi_count INT,
  raw_data TEXT,
  reported_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_location_reports_device_id ON location_reports(device_id);
CREATE INDEX IF NOT EXISTS idx_location_reports_reported_at ON location_reports(reported_at DESC);
