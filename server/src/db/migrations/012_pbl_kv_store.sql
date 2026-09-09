-- 012: PBL KV store (D-206).
--
-- The PBL routes (verdict, policy, enroll, attest, override, devices) use a
-- KV interface (env.LOCKDOWN_KV.get/put/delete/list) that was previously backed
-- by an in-memory Map. This migration adds a persistent backing store so PBL
-- device state, signing keys, policy blobs, and challenge seeds survive
-- server restarts.
--
-- The table is a simple key-value store:
--   key   TEXT PRIMARY KEY  — e.g. 'pbl_devices:<hex>', 'pbl_policy:latest_version'
--   value TEXT               — JSON string, base64 blob, or plain text
--   created_at TIMESTAMPTZ   — audit
--   updated_at TIMESTAMPTZ   — audit
--
-- The KV shim in server/src/pbl/kvStore.js uses this table when a database
-- pool is available. In tests, the in-memory Map is still used.

CREATE TABLE IF NOT EXISTS pbl_kv_store (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pbl_kv_store_key_prefix
  ON pbl_kv_store (key text_pattern_ops);
