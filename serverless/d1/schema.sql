-- Relational schema for the serverless deployment (D1).
--
-- Why this exists at all: the Worker's durable state is a key-value namespace, which is fine
-- until two properties matter — consistency and per-poll cost. KV is eventually consistent
-- across locations, so replay protection is best-effort (a nonce written in one location is not
-- visible everywhere immediately), and every write is billed as a write. This schema closes both:
-- a UNIQUE index makes replay rejection authoritative, and rows are the billing unit.
--
-- This file is the SCHEMA, not a cutover. Nothing in the Worker reads or writes these tables yet
-- except `nonces`, which the replay check prefers when a D1 binding is present. The staged plan
-- and what each stage proves: docs/SERVERLESS-D1-CUTOVER.md.
--
-- Apply with:
--   npx wrangler d1 create lockdown
--   npx wrangler d1 execute lockdown --file=d1/schema.sql --remote
--
-- Every table keeps the KV key it replaces in a comment, so a migration can be written against
-- the same identity the records already have (ADR-002 to ADR-006 invented per-entity keys; the
-- primary keys here are those keys' suffixes, so ids do not change).

-- ADR-003: devices are per-entity records behind `device_index`.
CREATE TABLE IF NOT EXISTS devices (
  id                   TEXT PRIMARY KEY,          -- was `device:<id>`
  hostname             TEXT NOT NULL,
  owner_name           TEXT,
  status               TEXT NOT NULL,             -- active | stolen | locked | recovering | tracking
  api_key_hash         TEXT,                      -- sha256 of the device key; NULL after rotation
  mac_address          TEXT,
  hardware_uuid        TEXT,
  serial_number        TEXT,
  agent_version        TEXT,
  agent_version_at     TEXT,
  last_checkin         TEXT,
  created_at           TEXT NOT NULL,
  -- Check-in metadata used to live in `device_checkin:<id>` to stop a poll racing an ACK
  -- (KV-RACE-001). A separate row makes that structural rather than conventional.
  checkin              TEXT                       -- JSON: firmware audit, update verification, model
);

-- One row per device key, so authentication is a point lookup instead of a hash scan.
CREATE UNIQUE INDEX IF NOT EXISTS devices_api_key_hash ON devices (api_key_hash)
  WHERE api_key_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS devices_status ON devices (status);

-- ADR-002: commands are per-entity records; the indexes below replace `command_index` and
-- `command_index:<device_id>` with something the planner can use instead of a full scan.
CREATE TABLE IF NOT EXISTS commands (
  id                   TEXT PRIMARY KEY,          -- was `command:<id>`
  device_id            TEXT NOT NULL,
  command_type         TEXT NOT NULL,
  status               TEXT NOT NULL,             -- pending | executed | failed | cancelled
  created_at           TEXT NOT NULL,
  executed_at          TEXT,
  command_uuid         TEXT,
  payload              TEXT,                      -- JSON: evidence, lockdown_effective, key material refs
  FOREIGN KEY (device_id) REFERENCES devices (id) ON DELETE CASCADE
);

-- THE index that makes the poll cheap: this is the per-device command lookup, and the reason
-- the Worker's check-in stopped scanning a fleet-wide list (see docs/SERVERLESS-COST.md).
CREATE INDEX IF NOT EXISTS commands_device_status ON commands (device_id, status, created_at);
CREATE INDEX IF NOT EXISTS commands_pending ON commands (status) WHERE status = 'pending';

-- ADR-004: location reports, one row each, bounded per device by LOCATION_HISTORY_LIMIT and in
-- age by LOCATION_RETENTION_DAYS (the cron purge deletes rows rather than rewriting an index).
CREATE TABLE IF NOT EXISTS locations (
  id                   TEXT PRIMARY KEY,          -- was `location:<id>`
  device_id            TEXT NOT NULL,
  latitude             REAL,
  longitude            REAL,
  accuracy_meters      REAL,
  source               TEXT,
  city                 TEXT,
  region               TEXT,
  country              TEXT,
  ip_address           TEXT,
  wifi_count           INTEGER,
  observed_at          TEXT,
  created_at           TEXT NOT NULL,
  FOREIGN KEY (device_id) REFERENCES devices (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS locations_device_created ON locations (device_id, created_at);
-- The retention purge is a range delete on this index, not a table scan.
CREATE INDEX IF NOT EXISTS locations_created ON locations (created_at);

-- ADR-005: audit entries behind a capped index.
CREATE TABLE IF NOT EXISTS audit (
  id                   TEXT PRIMARY KEY,          -- was `audit:<id>`
  device_id            TEXT,
  action               TEXT NOT NULL,
  detail               TEXT,
  admin_username       TEXT,
  hostname             TEXT,
  created_at           TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS audit_created ON audit (created_at);
CREATE INDEX IF NOT EXISTS audit_device_created ON audit (device_id, created_at);
CREATE INDEX IF NOT EXISTS audit_action ON audit (action);

-- Admin accounts. `admins` is still one KV value in the Worker (the one list left), which is
-- fine at the scale it holds and wrong the moment two administrators are edited at once.
CREATE TABLE IF NOT EXISTS admins (
  id                   TEXT PRIMARY KEY,
  username             TEXT NOT NULL UNIQUE,
  password_hash        TEXT NOT NULL,
  role                 TEXT NOT NULL,             -- viewer | operator | super-admin
  created_at           TEXT NOT NULL
);

-- Replay protection, authoritative.
--
-- The Worker writes here first when a D1 binding exists, and falls back to KV otherwise. The
-- difference is not performance: a key-value store is eventually consistent across locations, so
-- two replays arriving in two places at once can both pass. A UNIQUE constraint cannot.
CREATE TABLE IF NOT EXISTS nonces (
  device_id            TEXT NOT NULL,
  nonce                TEXT NOT NULL,
  expires_at           TEXT NOT NULL,             -- ISO; the cron deletes rows past this
  PRIMARY KEY (device_id, nonce)
);

CREATE INDEX IF NOT EXISTS nonces_expires ON nonces (expires_at);
