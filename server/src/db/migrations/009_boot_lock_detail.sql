-- 009: Persist boot_lock_detail and lockdown_effective on commands table.
--
-- Previously, boot_lock_detail was logged in the notification event but NOT
-- stored in the database. The commands table had no boot_lock_detail or
-- boot_lock_status column, so the enforcement path results were visible in
-- server logs but not queryable from the DB after the fact.
--
-- This migration adds:
--   - boot_lock_status TEXT   — the agent's reported boot_lock_status
--     (e.g. "full", "partial", "none", null if not attempted)
--   - boot_lock_detail JSONB  — the full boot_lock_detail object from the
--     agent ACK (per-layer breakdown: bcd, hp_uefi, critical_applied_total, etc.)
--   - lockdown_effective BOOLEAN — server-computed flag: true if at least one
--     critical boot lock setting was applied, false if zero critical settings
--     were applied (encryption-only), null if boot lock was not attempted

ALTER TABLE commands ADD COLUMN IF NOT EXISTS boot_lock_status TEXT;
ALTER TABLE commands ADD COLUMN IF NOT EXISTS boot_lock_detail JSONB;
ALTER TABLE commands ADD COLUMN IF NOT EXISTS lockdown_effective BOOLEAN;
