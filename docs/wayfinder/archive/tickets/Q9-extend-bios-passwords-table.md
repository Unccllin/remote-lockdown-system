# Q9: Server schema migration

> **Label:** `wayfinder:grilling`
> **Status:** CLOSED
> **Resolved:** 2026-08-13 (grilling Round 2)

## Question

How should the server store the new PBA credentials (BitLocker PIN, recovery
password, HP power-on password)?

## Resolution

**A — Extend the `bios_passwords` table with a `password_type` enum.** The
table already stores encrypted BIOS passwords with nonce/tag. Adding a type
discriminator lets us store all credential types in one place with the same
encryption pattern. New migration `008_pba_credentials.sql`.

## Rationale

The table already exists, the encryption pattern is established. A type
discriminator (`password_type` enum: 'setup', 'power_on', 'bitlocker_pin',
'bitlocker_recovery') is cleaner than separate tables or bloating the devices
table. Matches the existing convention.
