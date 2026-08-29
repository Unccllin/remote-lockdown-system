---
name: phase-14-backup-restore
description: Encrypted backup and restore scripts for database, secrets, and recovery keys
---

# Phase 14 — Backup & Restore

## Context

The system stores encryption keys, device data, and audit logs in PostgreSQL.
If the database is lost, all encrypted data on locked devices becomes
unrecoverable. Backup and restore procedures are critical.

## Current State

### Backup Script
- `scripts/backup.sh` — creates encrypted backup
  - Detects DB type (PostgreSQL vs SQLite from env)
  - `pg_dump --format=custom` for PostgreSQL, `cp` for SQLite
  - Tars: database dump + secrets/ + .env + config files
  - Encrypts: `gpg --encrypt` (asymmetric) or `openssl enc -aes-256-cbc` (symmetric)
  - Output: `lockdown-backup-YYYYMMDD-HHMMSS.tar.gz.enc`
  - `--output <path>` — output file
  - `--encrypt-key <key>` — GPG recipient or passphrase
  - `--db-url <url>` — database URL (or read from env)
  - `--cron` mode for automated scheduling (outputs to dated files)
  - `--verify` mode: backup → restore to temp DB → verify data matches
  - Exit 0 on success, 1 on error

### Restore Script
- `scripts/restore.sh` — restores from encrypted backup
  - `--input <path>` — backup file
  - `--decrypt-key <key>` — GPG recipient or passphrase
  - Verifies backup integrity before restoring
  - Restores: `pg_restore` or SQLite file copy
  - Restores secrets to `secrets/` directory
  - Does NOT overwrite existing data without `--force`
  - Portable — works on a different server (handles path differences via env vars)
  - Exit 0 on success, 1 on error

### Documentation
- `docs/BACKUP.md` — comprehensive backup documentation
  - Backup strategy overview
  - Automated backup setup (cron/systemd timer)
  - Manual backup procedure
  - Restore procedure
  - Backup verification
  - Security considerations (encrypt, offline storage, test restores)
  - RPO/RTO guidance

### Backup Strategy
1. **Database backup**: `pg_dump` with custom format for PostgreSQL, or SQLite file copy
2. **Secrets backup**: `FIELD_ENCRYPTION_KEY` and `LOCATION_FIELD_KEY` backed up separately (env vars/Docker secrets, not in DB)
3. **Recovery keys**: RSA private key (`recovery_master.key`) backed up offline
4. **Backup encryption**: Backups encrypted with a separate key (GPG or openssl)

## Verification

```bash
# Verify backup script exists
ls -la scripts/backup.sh

# Verify restore script exists
ls -la scripts/restore.sh

# Verify backup documentation exists
ls docs/BACKUP.md

# Shell syntax check
bash -n scripts/backup.sh scripts/restore.sh

# Test backup --verify mode (creates backup, restores to temp, compares)
scripts/backup.sh --verify --output /tmp/test-backup

# Full environment verification
make verify-env

# Full verification sweep
make full-verify
```

## Regression checks

1. **Verify backup supports both PostgreSQL and SQLite**: `grep -c "pg_dump\|sqlite" scripts/backup.sh`
2. **Verify backup --verify mode exists**: `grep -c "\-\-verify" scripts/backup.sh`
3. **Verify restore refuses without --force**: `grep -c "\-\-force" scripts/restore.sh`
4. **Verify backup includes JWT_SECRET (in separate file)**: `grep -i "jwt" scripts/backup.sh docs/BACKUP.md`
5. **Verify backup is portable (works on different server)**: `grep -i "portable\|env" scripts/restore.sh`
6. **Verify GPG and openssl are both supported**: `grep -c "gpg\|openssl" scripts/backup.sh`

## Gotchas

- `FIELD_ENCRYPTION_KEY` and `LOCATION_FIELD_KEY` must be backed up separately — they're in env vars/Docker secrets, not in the DB
- If `FIELD_ENCRYPTION_KEY` is lost, all encrypted data on locked devices becomes unrecoverable
- Recovery RSA private key (`recovery_master.key`) must be backed up offline (safe/HSM)
- Restore does NOT overwrite existing data without `--force` — prevents accidental data loss
- GPG is more secure for automated backups (no passphrase in scripts) — openssl for symmetric (passphrase)
- `--verify` mode validates the backup is complete and restorable (backup → restore to temp DB → compare row counts)

## Graph Integration

**Phase node**: `P14` in `.devin/graph/GRAPH-SPEC.yaml` — status: COMPLETE

This phase is part of the node graph — the center and heart of the project.
Before working on this phase, an agent MUST:

1. Read `.devin/graph/GRAPH-SPEC.yaml` — locate the `P14` node
2. Read `.devin/graph/current-state.md` — compact session state (read FIRST)
3. Read `docs/adr/DEBT-LEDGER.md` — check for open debt items blocking this phase
4. Complete RULE-ZERO (read this skill file + source code before coding)
5. At session end, append a status block to `trace.md` and run `make gen-state`

**Verification nodes gating this phase**: V-SERVER, V-SHELL-SYNTAX

**Enforcement paths touched by this phase**: —

**Debt items related to this phase**: — (none)

**Graph invariants that apply**:
- I1: Phase dependencies must be COMPLETE before this phase runs
- I5: RULE-ZERO must be complete before any code changes
- I7: If this phase is COMPLETE, its `.complete` file must have a commit hash + artifact ref (D-002 CLOSED)
