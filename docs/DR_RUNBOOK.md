# Disaster Recovery Runbook

This runbook covers the most likely failure scenarios for the Remote
Lockdown System in production. Each scenario has a concrete recovery
procedure with exact commands.

## RTO/RPO Targets

| Scenario | RTO (Recovery Time) | RPO (Data Loss) |
|----------|---------------------|-----------------|
| Server crash | < 1 min (auto-restart) | 0 (no data loss) |
| Database corruption | < 30 min | Up to 24h (last backup) |
| Full server loss | < 2 hours | Up to 24h (last backup) |
| Caddy/TLS failure | < 5 min | 0 |

Automated backups run daily at 2 AM (configurable via `BACKUP_SCHEDULE`).
With the default 30-day retention, you have 30 daily backups available.

## Prerequisites

- `.env.prod` file backed up in a secure location (password manager, etc.)
- `BACKUP_ENCRYPT_KEY` stored in a secure location (NOT on the same server)
- SSH access to the production server
- Docker + Docker Compose installed on the recovery machine

## Scenario 1: Server process crash

**Symptoms**: Dashboard returns 502/503, API unresponsive.

**Recovery**: Docker restart policy is `unless-stopped`, so the server
auto-restarts. If it's in a crash loop:

```bash
# Check logs
docker compose --env-file .env.prod -f docker-compose.prod.yml logs server --tail 50

# Manual restart
docker compose --env-file .env.prod -f docker-compose.prod.yml restart server
```

## Scenario 2: Database corruption

**Symptoms**: API errors on every request, "relation does not exist",
data inconsistency.

**Recovery**: Restore from the most recent backup.

```bash
# 1. Stop the server (keep postgres running for restore)
docker compose --env-file .env.prod -f docker-compose.prod.yml stop server

# 2. Find the latest backup
docker compose --env-file .env.prod -f docker-compose.prod.yml exec backup ls -lt /backups/ | head -5

# 3. Restore the backup
docker compose --env-file .env.prod -f docker-compose.prod.yml exec backup \
  /app/scripts/restore.sh \
  --input /backups/lockdown-backup-YYYYMMDD-HHMMSS.tar.gz.enc \
  --encrypt-key "$BACKUP_ENCRYPT_KEY" \
  --db-url "postgres://lockdown:PASSWORD@postgres:5432/lockdown"

# 4. Restart the server
docker compose --env-file .env.prod -f docker-compose.prod.yml start server
```

## Scenario 3: Full server loss

**Symptoms**: Server is gone (hardware failure, cloud provider termination,
accidental deletion).

**Recovery**: Provision a new server and restore from backup.

```bash
# On the new server:

# 1. Clone the repo
git clone https://github.com/Unccllin/remote-lockdown-system.git
cd remote-lockdown-system

# 2. Restore .env.prod from your secure backup
# (Copy your .env.prod file to the new server)

# 3. Copy the backup file from your secure storage to the new server
scp lockdown-backup-YYYYMMDD-HHMMSS.tar.gz.enc new-server:/tmp/

# 4. Start the stack (postgres will initialize fresh)
docker compose --env-file .env.prod -f docker-compose.prod.yml up -d

# 5. Wait for postgres to be healthy
docker compose --env-file .env.prod -f docker-compose.prod.yml wait postgres

# 6. Restore the database from backup
docker cp /tmp/lockdown-backup-YYYYMMDD-HHMMSS.tar.gz.enc \
  $(docker compose --env-file .env.prod -f docker-compose.prod.yml ps -q backup):/tmp/

docker compose --env-file .env.prod -f docker-compose.prod.yml exec backup \
  /app/scripts/restore.sh \
  --input /tmp/lockdown-backup-YYYYMMDD-HHMMSS.tar.gz.enc \
  --encrypt-key "$BACKUP_ENCRYPT_KEY" \
  --db-url "postgres://lockdown:PASSWORD@postgres:5432/lockdown"

# 7. Restart the server to pick up restored data
docker compose --env-file .env.prod -f docker-compose.prod.yml restart server
```

## Scenario 4: Caddy/TLS certificate failure

**Symptoms**: Browser shows certificate error, HTTP redirects fail.

**Recovery**: Caddy auto-renews Let's Encrypt certificates. If the Caddy
data volume is corrupted:

```bash
# Reset Caddy's certificate store (it will re-issue certificates)
docker compose --env-file .env.prod -f docker-compose.prod.yml down caddy
docker volume rm remote-lockdown-system_caddy_data
docker compose --env-file .env.prod -f docker-compose.prod.yml up -d caddy

# Caddy will obtain new certificates on first request.
# This may take 30-60 seconds.
```

## Scenario 5: Encryption key compromise

**Symptoms**: `FIELD_ENCRYPTION_KEY` or `LOCATION_FIELD_KEY` leaked.

**Recovery**: This is the most serious scenario. All encrypted data must
be re-encrypted with a new key.

```bash
# 1. Generate new keys
openssl rand -hex 32  # new FIELD_ENCRYPTION_KEY
openssl rand -hex 32  # new LOCATION_FIELD_KEY

# 2. Update .env.prod with the new keys

# 3. Restart the server — the dual-mode read will fall back to plaintext
#    for existing rows (if plaintext columns still have data).
docker compose --env-file .env.prod -f docker-compose.prod.yml restart server

# 4. Run a migration to re-encrypt all data with the new key.
#    This is a manual process — contact the development team for the
#    re-encryption script. The dual-mode read design ensures no data is
#    lost during the transition.
```

## Backup verification

Verify a backup without restoring to production:

```bash
docker compose --env-file .env.prod -f docker-compose.prod.yml exec backup \
  /app/scripts/backup.sh --verify \
  --input /backups/lockdown-backup-YYYYMMDD-HHMMSS.tar.gz.enc \
  --encrypt-key "$BACKUP_ENCRYPT_KEY"
```

This restores to a temporary database, compares row counts, and reports
any discrepancies.

## Post-recovery checklist

- [ ] Dashboard loads at https://your-domain.com
- [ ] Can log in with admin credentials
- [ ] Device list shows expected devices
- [ ] Audit log shows recent entries
- [ ] Agent checkins resuming (check Health page)
- [ ] Run a test backup to confirm backup service is working
- [ ] Document the incident: what happened, what was lost, what was restored
