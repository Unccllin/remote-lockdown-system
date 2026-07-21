-- Migration 005: SQLite version — HMAC auth nonce cache table
-- See migrations/005_hmac_auth.sql for full rationale.

CREATE TABLE IF NOT EXISTS nonce_cache (
    nonce           VARCHAR(64) PRIMARY KEY,
    expires_at      TEXT NOT NULL,
    created_at      TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_nonce_cache_expires ON nonce_cache(expires_at);
