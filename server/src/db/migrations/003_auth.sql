-- Auth hardening: per-device API keys (FA3 / CC5 / CC6)
--
-- Adds api_key_hash column to devices for per-device key authentication.
-- Legacy devices with api_key_hash IS NULL fall back to AGENT_SHARED_KEY
-- per-device (CC5: per-device fallback, not global).
--
-- Once a device is re-enrolled or rotated to have an api_key_hash,
-- the shared key stops working for that device immediately.

ALTER TABLE devices ADD COLUMN IF NOT EXISTS api_key_hash TEXT;

-- Index for fast hash lookup during agent auth
CREATE INDEX IF NOT EXISTS idx_devices_api_key_hash ON devices(api_key_hash) WHERE api_key_hash IS NOT NULL;
