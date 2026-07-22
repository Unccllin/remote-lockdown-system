-- Migration 006: SQLite version — Phase 5 command queue enhancements
--
-- SQLite doesn't support ADD COLUMN IF NOT EXISTS. The migration runner
-- tracks applied migrations, so this runs only once. If it fails partway,
-- the admin can manually add the missing column and mark the migration
-- as applied in schema_migrations.
--
-- We split each ALTER into its own statement so partial failures are
-- easier to recover from.

ALTER TABLE commands ADD COLUMN command_uuid VARCHAR(255);
ALTER TABLE commands ADD COLUMN expires_at TEXT;

-- Index for finding pending commands by device (checkin query)
CREATE INDEX IF NOT EXISTS idx_commands_device_status ON commands(device_id, status);

-- Unique index for command_uuid dedup (partial — only when not NULL)
CREATE UNIQUE INDEX IF NOT EXISTS idx_commands_uuid_unique
  ON commands(command_uuid) WHERE command_uuid IS NOT NULL;
