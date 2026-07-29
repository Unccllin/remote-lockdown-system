# Skill Domain: Phase 14 — Backup & Restore

## Context
The system stores encryption keys, device data, and audit logs in PostgreSQL. If the database is lost, all encrypted data on locked devices becomes unrecoverable. Backup and restore procedures are critical.

## Current State
- No backup scripts
- No restore scripts
- No backup documentation
- docs/SECURITY.md mentions "Database backups are encrypted" as a checklist item but no procedure exists
- Encryption keys stored in `encryption_keys` table
- Audit log in `audit_log` table

## Research Findings
### Backup Strategy
1. **Database backup**: `pg_dump` with custom format for PostgreSQL, or SQLite file copy
2. **Secrets backup**: The `FIELD_ENCRYPTION_KEY` and `LOCATION_FIELD_KEY` must be backed up separately — they're in env vars/Docker secrets, not in the DB
3. **Recovery keys**: The RSA private key (`recovery_master.key`) must be backed up offline
4. **Backup encryption**: Backups should be encrypted with a separate key

### Backup Script Design
- `scripts/backup.sh` — creates encrypted backup
- Supports both PostgreSQL (`pg_dump`) and SQLite (file copy)
- Backs up: database + secrets directory + config
- Encrypts backup with `gpg` or `openssl enc`
- Outputs a single `.tar.gz.enc` file
- `--output <path>` — output file
- `--encrypt-key <key>` — GPG recipient or passphrase
- `--db-url <url>` — database URL (or read from env)

### Restore Script Design
- `scripts/restore.sh` — restores from encrypted backup
- `--input <path>` — backup file
- `--decrypt-key <key>` — GPG recipient or passphrase
- Verifies backup integrity before restoring
- Restores database (pg_restore or sqlite copy)
- Does NOT overwrite existing data without `--force`

### Backup Testing
- Script should support `--verify` mode: backup → restore to temp DB → verify data matches
- This validates the backup is complete and restorable

## Reasoning Questions
1. **Should backups be automated (cron) or manual?**
   - Answer: Script supports both. `--cron` mode for automated scheduling (outputs to dated files). Manual mode for one-off backups. Document both.

2. **GPG or openssl for encryption?**
   - Answer: Support both. GPG for asymmetric (public key encrypt), openssl for symmetric (passphrase). GPG is more secure for automated backups (no passphrase in scripts).

3. **Should backup include the JWT_SECRET?**
   - Answer: Yes, but in a separate file within the backup. JWT_SECRET backup allows restoring active sessions. Document the security implication.

4. **Should restore work on a different server?**
   - Answer: Yes. The backup should be portable. Restore script handles path differences via env vars.

## Implementation Guidelines
### scripts/backup.sh
- Detect DB type (PostgreSQL vs SQLite from env)
- `pg_dump --format=custom` for PostgreSQL
- `cp` the SQLite file for SQLite
- Tar: database dump + secrets/ + .env + config files
- Encrypt: `gpg --encrypt` or `openssl enc -aes-256-cbc`
- Output: `lockdown-backup-YYYYMMDD-HHMMSS.tar.gz.enc`
- `--verify` mode: backup → restore to temp → compare row counts
- Exit 0 on success, 1 on error

### scripts/restore.sh
- Decrypt backup
- Extract tar
- Detect existing DB — refuse without `--force`
- Restore: `pg_restore` or SQLite file copy
- Restore secrets to secrets/ directory
- Print summary of restored data
- Exit 0 on success, 1 on error

### docs/BACKUP.md
- Backup strategy overview
- Automated backup setup (cron/systemd timer)
- Manual backup procedure
- Restore procedure
- Backup verification
- Security considerations (encrypt, offline storage, test restores)
- RPO/RTO guidance

## File Boundaries
- CREATE: `scripts/backup.sh`, `scripts/restore.sh`, `docs/BACKUP.md`
- DO NOT EDIT: existing scripts, source code, docker-compose files
