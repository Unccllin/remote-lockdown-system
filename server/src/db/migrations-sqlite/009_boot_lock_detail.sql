-- 009: Persist boot_lock_detail and lockdown_effective on commands table.
-- SQLite version — same columns, TEXT/INTEGER instead of JSONB/BOOLEAN.

ALTER TABLE commands ADD COLUMN boot_lock_status TEXT;
ALTER TABLE commands ADD COLUMN boot_lock_detail TEXT;
ALTER TABLE commands ADD COLUMN lockdown_effective INTEGER;
