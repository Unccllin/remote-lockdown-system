-- Migration 003: SQLite version — per-device API keys (FA3 / CC5 / CC6)
-- See migrations/003_auth.sql for full rationale.

ALTER TABLE devices ADD COLUMN api_key_hash TEXT;

CREATE INDEX IF NOT EXISTS idx_devices_api_key_hash ON devices(api_key_hash) WHERE api_key_hash IS NOT NULL;
