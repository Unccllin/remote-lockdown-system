# T8: Phase 2 — Server schema migration + enable_pba flag

> **Label:** `wayfinder:task`
> **Status:** CLOSED (2026-08-14)
> **Blocks:** T9
> **Blocked by:** T6
> **Implements:** Q1, Q9

## Question

Add the `password_type` enum to the `bios_passwords` table, add the
`enable_pba` flag to the lockdown command, and wire the server to pass PBA
credentials back and forth.

## Work

### Database migration
1. Create `server/src/db/migrations/008_pba_credentials.sql`:
   - Add `password_type` column to `bios_passwords` table:
     `ALTER TABLE bios_passwords ADD COLUMN IF NOT EXISTS password_type TEXT
     NOT NULL DEFAULT 'setup';`
   - Add CHECK constraint: `ALTER TABLE bios_passwords ADD CONSTRAINT
     valid_password_type CHECK (password_type IN ('setup', 'power_on',
     'bitlocker_pin', 'bitlocker_recovery'));`
2. Update existing rows: `UPDATE bios_passwords SET password_type='setup'
   WHERE password_type IS NULL OR password_type='';`

### Server command construction
1. In `server/src/routes/devices.js`, add `enable_pba` to the lockdown command
   creation (from request body, default false).
2. Store `enable_pba` in the `commands` table (add column or store in a
   `command_params` JSONB column).
3. In `server/src/routes/agent.js`, include `enable_pba` in the command
   response to the agent.

### Server ACK handling
1. In `server/src/routes/agent.js`, destructure `power_on_password` from the
   ACK.
2. Store it in `bios_passwords` with `password_type='power_on'`.
3. Include in the audit log detail.

### Tests
1. Test migration applies cleanly.
2. Test `enable_pba` flag flows from request → command → agent response.
3. Test `power_on_password` is stored in `bios_passwords` with correct type.
4. Test default `enable_pba=false` doesn't set PBA.

## Files to edit

- `server/src/db/migrations/008_pba_credentials.sql` (new)
- `server/src/routes/devices.js` (add enable_pba to command creation)
- `server/src/routes/agent.js` (include enable_pba in response, store
  power_on_password from ACK)
- `server/tests/` (new tests)

## Acceptance

- Migration applies cleanly on Postgres and SQLite.
- `enable_pba` flag flows server → agent.
- `power_on_password` is stored encrypted with `password_type='power_on'`.
- All server tests pass. ESLint clean.
