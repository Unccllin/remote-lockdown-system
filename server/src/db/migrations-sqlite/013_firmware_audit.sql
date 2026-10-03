-- 013: Store per-device firmware protection audit (PblPersistDxe delivery recon).
-- SQLite version — TEXT holds the JSON blob, INTEGER holds the unix ts.

ALTER TABLE devices ADD COLUMN firmware_audit TEXT;
ALTER TABLE devices ADD COLUMN firmware_audit_at INTEGER;
