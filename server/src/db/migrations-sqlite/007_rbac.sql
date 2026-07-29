-- Migration 007: SQLite version — RBAC role column on admins.
--
-- SQLite does not support ADD COLUMN IF NOT EXISTS. The migration runner
-- tracks applied migrations, so this runs only once on a fresh DB. If it
-- fails partway (e.g. column already exists), the admin can mark the
-- migration as applied in schema_migrations and skip it.
--
-- Default is 'viewer'. The first admin created via the setup endpoint
-- gets 'super-admin' (see routes/setup.js).

ALTER TABLE admins ADD COLUMN role TEXT NOT NULL DEFAULT 'viewer';
