-- 013: Store per-device firmware protection audit (PblPersistDxe delivery recon).
--
-- The agent's firmware_audit module reports Secure Boot / SPI-observable
-- posture on each checkin so the operator can decide which persistence
-- delivery path works per unit (signed capsule / Setup-Mode / external
-- flash). Stored as JSONB so new audit fields don't need schema changes.

ALTER TABLE devices ADD COLUMN IF NOT EXISTS firmware_audit JSONB;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS firmware_audit_at TIMESTAMPTZ;
