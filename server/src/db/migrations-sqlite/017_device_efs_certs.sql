-- 017: Per-device EFS certificate backups — SQLite version.
-- See the PostgreSQL file for why this exists. Same columns; timestamps are ISO
-- strings written by the route.

CREATE TABLE IF NOT EXISTS device_efs_certs (
  device_id TEXT PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
  cert_base64 TEXT NOT NULL,
  cert_password TEXT,
  cert_password_enc TEXT,
  cert_password_nonce TEXT,
  cert_password_tag TEXT,
  uploaded_at TEXT NOT NULL
);
