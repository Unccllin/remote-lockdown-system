-- 014: Record how each device verifies agent updates (B-006).
--
-- The agent reports update_verification on every check-in:
--   'signature'   — a pinned Ed25519 update key is loaded; unsigned or
--                   invalidly-signed updates are refused
--   'sha256-only' — no pinned key; the only check is the SHA-256 served
--                   alongside the binary (unauthenticated)
--   NULL          — never reported (older agent) or an unrecognised value:
--                   "unknown" is not the same fact as "unverified"
--
-- Stored per device so the dashboard can show which devices would accept a
-- binary that only a compromised or misconfigured backend vouched for.

ALTER TABLE devices ADD COLUMN IF NOT EXISTS update_verification VARCHAR(16);
