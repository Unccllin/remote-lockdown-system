-- 011: PBL device identity mapping (D-206).
--
-- PBL devices are identified by a 32-byte SHA-256(AK public area) hex string,
-- while the existing agent device store uses UUID primary keys. This migration
-- adds a `pbl_device_id` column to the devices table so a server-side agent
-- device record can be linked to its PBL (pre-boot) identity.
--
-- The column is nullable because not all agent devices have a PBL identity
-- (only devices with TPM 2.0 and PBL firmware enrolled). The UNIQUE constraint
-- ensures a PBL device maps to at most one agent device record.
--
-- Lookup direction:
--   Agent → PBL:  SELECT pbl_device_id FROM devices WHERE id = $1
--   PBL → Agent:  SELECT id FROM devices WHERE pbl_device_id = $1

ALTER TABLE devices ADD COLUMN pbl_device_id VARCHAR(64);
CREATE UNIQUE INDEX IF NOT EXISTS idx_devices_pbl_device_id ON devices(pbl_device_id) WHERE pbl_device_id IS NOT NULL;
