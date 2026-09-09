-- 012: PBL KV store (D-206).
--
-- SQLite variant of the PBL KV store. See the Postgres migration for details.

CREATE TABLE IF NOT EXISTS pbl_kv_store (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_pbl_kv_store_key_prefix
  ON pbl_kv_store (key);
