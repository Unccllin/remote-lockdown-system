-- 015: Single-use enrolment tokens — SQLite version.
-- See the PostgreSQL file for why this exists. Same columns; timestamps are ISO
-- strings written by the route, so both dialects store and compare the same shape.

CREATE TABLE IF NOT EXISTS enrollment_tokens (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  created_by TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_enrollment_tokens_hash ON enrollment_tokens(token_hash);
