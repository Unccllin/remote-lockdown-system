-- Migration 006: Phase 5 — command queue enhancements
--
-- Adds:
--   command_uuid: client-generated UUID for idempotent command dedup.
--                 The agent generates this when it creates a command ACK,
--                 so retries don't create duplicate encryption key entries.
--   expires_at:  when the command expires if not yet executed.
--                NULL = no expiration (default for existing commands).
--                Phase 5: commands expire after 30 days by default.
--
-- Also adds an index on (device_id, status) for efficient queue queries
-- and a unique index on command_uuid for dedup.

ALTER TABLE commands ADD COLUMN IF NOT EXISTS command_uuid VARCHAR(255);
ALTER TABLE commands ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;

-- Index for finding pending commands by device (checkin query)
CREATE INDEX IF NOT EXISTS idx_commands_device_status ON commands(device_id, status);

-- Unique index for command_uuid dedup (partial — only when not NULL)
CREATE UNIQUE INDEX IF NOT EXISTS idx_commands_uuid_unique
  ON commands(command_uuid) WHERE command_uuid IS NOT NULL;
