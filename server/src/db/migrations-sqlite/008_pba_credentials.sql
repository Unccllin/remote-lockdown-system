-- Migration 008: SQLite version — PBA Credentials
--
-- SQLite doesn't support ADD COLUMN IF NOT EXISTS. The migration runner
-- tracks applied migrations, so this runs only once.
--
-- SQLite doesn't have a separate BOOLEAN type — uses INTEGER (0/1).
-- CHECK constraints are supported inline with ADD COLUMN.

-- Add password_type column with CHECK constraint (defaults to 'setup')
ALTER TABLE bios_passwords ADD COLUMN password_type TEXT NOT NULL DEFAULT 'setup'
  CHECK (password_type IN ('setup', 'power_on', 'bitlocker_pin', 'bitlocker_recovery'));

-- Add enable_pba flag to commands table (0 = false, 1 = true — PBA is opt-in)
ALTER TABLE commands ADD COLUMN enable_pba INTEGER NOT NULL DEFAULT 0;
