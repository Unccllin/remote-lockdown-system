-- Migration 008: PBA Credentials — password_type enum + enable_pba flag
--
-- T8 (Phase 2 PBA): Extends the bios_passwords table with a password_type
-- discriminator so we can store multiple credential types (setup password,
-- power-on password, BitLocker PIN, BitLocker recovery password) in one table.
--
-- Also adds the enable_pba flag to the commands table so the server can
-- tell the agent whether to set the Power-On Password (Tier 1 PBA) for
-- a specific lockdown command.
--
-- Q1=A: PBA is opt-in (enable_pba defaults to FALSE). The operator explicitly
-- chooses PBA per lockdown, sacrificing remote recoverability for data protection.
-- Q9=A: A type discriminator is cleaner than separate tables or bloating the
-- devices table. Matches the existing encryption pattern in bios_passwords.

-- Add password_type column to bios_passwords (defaults to 'setup' for existing rows)
ALTER TABLE bios_passwords ADD COLUMN IF NOT EXISTS password_type TEXT NOT NULL DEFAULT 'setup';

-- Update any NULL or empty password_type values to 'setup' (safety net)
UPDATE bios_passwords SET password_type = 'setup' WHERE password_type IS NULL OR password_type = '';

-- Add CHECK constraint for valid password types (idempotent via DO block)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'valid_password_type') THEN
    ALTER TABLE bios_passwords ADD CONSTRAINT valid_password_type
      CHECK (password_type IN ('setup', 'power_on', 'bitlocker_pin', 'bitlocker_recovery'));
  END IF;
END $$;

-- Add enable_pba flag to commands table (defaults to FALSE — PBA is opt-in)
ALTER TABLE commands ADD COLUMN IF NOT EXISTS enable_pba BOOLEAN NOT NULL DEFAULT FALSE;
