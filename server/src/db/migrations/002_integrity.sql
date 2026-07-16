-- Migration 002: Server DB integrity fixes (A2, A4, A6, A3, CC14, CC16)
--
-- A4: Add command_id to encryption_keys + UNIQUE constraint for ACK idempotency.
--     When the agent retries a pending ACK, the INSERT ... ON CONFLICT DO NOTHING
--     prevents duplicate key rows. The UNIQUE constraint is on (device_id, command_id)
--     so the same command can't insert two key rows.
--
-- A6/CC14: Add a guard trigger that prevents deleting devices with active
--     encryption keys (ON DELETE RESTRICT at the application level). We can't
--     use a hard FK RESTRICT because the original schema uses CASCADE, and
--     changing FK constraints requires a drop+recreate. Instead, we add a
--     BEFORE DELETE trigger that raises an exception if the device has
--     unreleased encryption keys.
--
-- A3: Add encrypted columns to encryption_keys and bios_passwords.
--     key_material_encrypted (TEXT, AES-256-GCM) replaces plaintext key_material.
--     password_encrypted (TEXT, AES-256-GCM) replaces plaintext password.
--     The plaintext columns are kept for CC16 dual-mode read (backfill period).

-- A4: Add command_id to encryption_keys for idempotency
ALTER TABLE encryption_keys ADD COLUMN IF NOT EXISTS command_id VARCHAR(100);

-- A4: UNIQUE constraint — one key per (device, command)
CREATE UNIQUE INDEX IF NOT EXISTS idx_encryption_keys_device_command
  ON encryption_keys (device_id, command_id)
  WHERE command_id IS NOT NULL;

-- A3: Add encrypted columns for encryption_keys
ALTER TABLE encryption_keys ADD COLUMN IF NOT EXISTS key_material_encrypted TEXT;
ALTER TABLE encryption_keys ADD COLUMN IF NOT EXISTS key_enc_nonce TEXT;
ALTER TABLE encryption_keys ADD COLUMN IF NOT EXISTS key_enc_tag TEXT;

-- A3: Add encrypted columns for bios_passwords
ALTER TABLE bios_passwords ADD COLUMN IF NOT EXISTS password_encrypted TEXT;
ALTER TABLE bios_passwords ADD COLUMN IF NOT EXISTS pw_enc_nonce TEXT;
ALTER TABLE bios_passwords ADD COLUMN IF NOT EXISTS pw_enc_tag TEXT;

-- A6/CC14: Guard trigger — prevent deleting devices with unreleased encryption keys.
-- This is a soft-RESTRICT: the DELETE will fail with a clear error message if the
-- device has any encryption_keys row where released_at IS NULL.
-- Admins must first recover (release the key) or explicitly force-delete.
CREATE OR REPLACE FUNCTION guard_device_delete() RETURNS TRIGGER AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM encryption_keys
    WHERE device_id = OLD.id AND released_at IS NULL
  ) THEN
    RAISE EXCEPTION 'Cannot delete device %: unreleased encryption keys exist. Recover the device first or use force-delete.', OLD.id;
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_guard_device_delete ON devices;
CREATE TRIGGER trg_guard_device_delete
  BEFORE DELETE ON devices
  FOR EACH ROW
  EXECUTE FUNCTION guard_device_delete();

-- A4: Add command_id to commands table for explicit client-supplied IDs.
--     The agent's pending ACK retry sends the same command_id; the server
--     uses this to dedup. The existing UUID id column remains the PK.
--     command_id is a separate optional column for agent-supplied dedup keys.
--     (Currently the agent uses the server-generated UUID as command_id in ACKs,
--     so this column is for future use / deadman synthetic IDs.)
ALTER TABLE commands ADD COLUMN IF NOT EXISTS command_id VARCHAR(100);
CREATE UNIQUE INDEX IF NOT EXISTS idx_commands_device_command_id
  ON commands (device_id, command_id)
  WHERE command_id IS NOT NULL;
