-- Migration 002: SQLite version — DB integrity fixes (A2, A4, A6, A3, CC14, CC16)
--
-- See migrations/002_integrity.sql for full rationale.
--
-- SQLite differences:
--   - No plpgsql functions → guard_device_delete implemented as a SQLite
--     trigger using a SELECT + RAISE(ABORT) pattern
--   - Partial unique indexes work the same as PostgreSQL

-- A4: Add command_id to encryption_keys for idempotency
ALTER TABLE encryption_keys ADD COLUMN command_id VARCHAR(100);

-- A4: UNIQUE constraint — one key per (device, command)
-- SQLite supports partial unique indexes with WHERE
CREATE UNIQUE INDEX IF NOT EXISTS idx_encryption_keys_device_command
  ON encryption_keys (device_id, command_id)
  WHERE command_id IS NOT NULL;

-- A3: Add encrypted columns for encryption_keys
ALTER TABLE encryption_keys ADD COLUMN key_material_encrypted TEXT;
ALTER TABLE encryption_keys ADD COLUMN key_enc_nonce TEXT;
ALTER TABLE encryption_keys ADD COLUMN key_enc_tag TEXT;

-- A3: Add encrypted columns for bios_passwords
ALTER TABLE bios_passwords ADD COLUMN password_encrypted TEXT;
ALTER TABLE bios_passwords ADD COLUMN pw_enc_nonce TEXT;
ALTER TABLE bios_passwords ADD COLUMN pw_enc_tag TEXT;

-- A6/CC14: Guard trigger — prevent deleting devices with unreleased encryption keys.
-- SQLite trigger syntax: BEFORE DELETE, SELECT + RAISE(ABORT, msg)
DROP TRIGGER IF EXISTS trg_guard_device_delete;
CREATE TRIGGER trg_guard_device_delete
  BEFORE DELETE ON devices
  FOR EACH ROW
  WHEN EXISTS (
    SELECT 1 FROM encryption_keys
    WHERE device_id = OLD.id AND released_at IS NULL
  )
  BEGIN
    SELECT RAISE(ABORT, 'Cannot delete device: unreleased encryption keys exist. Recover the device first or use force-delete.');
  END;

-- A4: Add command_id to commands table
ALTER TABLE commands ADD COLUMN command_id VARCHAR(100);
CREATE UNIQUE INDEX IF NOT EXISTS idx_commands_device_command_id
  ON commands (device_id, command_id)
  WHERE command_id IS NOT NULL;
