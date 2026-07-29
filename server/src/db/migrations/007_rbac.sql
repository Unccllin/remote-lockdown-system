-- Migration 007: RBAC — add role column to admins table.
--
-- Three roles: viewer (0), operator (1), super-admin (2).
-- Default is 'viewer' so existing admins get the lowest privilege until
-- explicitly promoted. The first admin created via the setup endpoint
-- is granted 'super-admin' in routes/setup.js (not here) because the
-- setup INSERT specifies the role explicitly.

ALTER TABLE admins ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'viewer';
