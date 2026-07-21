-- Phase 0: HMAC auth — nonce cache table for replay protection.
--
-- Used when USE_DB_NONCE_CACHE=true (multi-instance deployments where
-- in-memory Map won't work across processes). Single-instance deployments
-- use the in-memory cache and don't need this table, but it's safe to
-- create regardless.
--
-- Each nonce is stored with an expiry timestamp. A periodic cleanup job
-- (or the INSERT ... ON CONFLICT path) removes expired rows. The TTL is
-- 10 minutes, longer than the ±300s timestamp window, so a replayed
-- request with a valid timestamp will still hit a live nonce.

CREATE TABLE IF NOT EXISTS nonce_cache (
    nonce           VARCHAR(64) PRIMARY KEY,
    expires_at      TIMESTAMP NOT NULL,
    created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Index for cleanup queries (DELETE WHERE expires_at < NOW())
CREATE INDEX IF NOT EXISTS idx_nonce_cache_expires ON nonce_cache(expires_at);
