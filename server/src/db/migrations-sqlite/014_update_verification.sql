-- 014: Record how each device verifies agent updates (B-006).
-- SQLite version — TEXT holds the mode string ('signature' | 'sha256-only' |
-- 'key-unreadable'); NULL means the device has never reported one, which is a
-- different fact from "unverified".
--
-- This file must exist in both dialects. The check-in UPDATE in
-- routes/agent.js writes this column unconditionally, so a SQLite deployment
-- without it fails every check-in with "no such column" — the migration
-- runner's drift healing cannot invent the column, it only skips DDL that is
-- already present.

ALTER TABLE devices ADD COLUMN update_verification TEXT;
