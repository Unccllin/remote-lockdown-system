-- 018: devices.agent_version + agent_version_at — SQLite version.
-- See the PostgreSQL file for why this exists. SQLite has no ADD COLUMN IF NOT
-- EXISTS, so the runner's "already applied" bookkeeping is what makes this
-- idempotent; timestamps are ISO strings written by the route.
ALTER TABLE devices ADD COLUMN agent_version TEXT;
ALTER TABLE devices ADD COLUMN agent_version_at TEXT;
