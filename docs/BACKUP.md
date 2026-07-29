# Backup & Restore

This document describes the backup and restore procedures for the Remote
Lockdown System. The system stores encryption keys, device data, and audit
logs in its database. If the database is lost, all encrypted data on locked
devices becomes unrecoverable. **Backups are critical.**

---

## 1. Backup strategy overview

### What to back up

| Component | Location | Why it matters |
|---|---|---|
| **Database** | PostgreSQL (cloud) or SQLite file (desktop) | Device records, encryption keys, audit log, command queue |
| **`secrets/` directory** | `./secrets/` | `FIELD_ENCRYPTION_KEY`, `LOCATION_FIELD_KEY`, `JWT_SECRET`, `AGENT_KEY_PEPPER` — these are **not** stored in the DB and cannot be regenerated |
| **`.env` / `.env.prod`** | project root, `server/` | Connection strings, CORS config, retention settings |
| **Config files** | `docker-compose*.yml`, `Caddyfile` | Deployment topology, reverse-proxy config |

> **Critical:** The `FIELD_ENCRYPTION_KEY` and `LOCATION_FIELD_KEY` are used to
> encrypt sensitive columns at rest. If these keys are lost, **all encrypted
> data in the database becomes permanently unreadable**, even with a perfect
> database backup. They must be backed up separately and stored offline.

### Why a single encrypted archive

The `scripts/backup.sh` script produces a single `.tar.gz.enc` file containing
the database dump, secrets, env files, and config. A single archive:

- simplifies offsite transfer (one file to copy to cold storage),
- ensures the database and its encryption keys are always restored **together**
  (a database restored without its matching keys is useless),
- is encrypted at rest so it can be stored on untrusted media (S3, USB drives).

### Encryption methods

The script supports two encryption methods, auto-selected based on the
`--encrypt-key` value:

1. **GPG asymmetric** (recommended for automated backups) — pass a GPG
   recipient (email or key fingerprint). The public key encrypts; the private
   key (kept offline) decrypts. No passphrase lives in scripts or cron files.
2. **openssl symmetric** (`aes-256-cbc` + PBKDF2) — pass a passphrase. Simpler
   for one-off/manual backups, but the passphrase must be stored securely and
   is required for every restore.

---

## 2. Automated backup setup

### Option A — cron (simplest)

Create `/etc/cron.d/lockdown-backup`:

```cron
# Run a daily encrypted backup at 02:00.
# GPG asymmetric mode — no passphrase in the file.
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
0 2 * * *  lockdown  cd /opt/remote-lockdown-system && \
  ./scripts/backup.sh \
    --cron \
    --encrypt-key admin@example.com \
    --output /var/backups/lockdown/lockdown-$(date +\%Y\%m\%d).tar.gz.enc \
  >> /var/log/lockdown-backup.log 2>&1
```

Notes:
- `--cron` produces machine-friendly single-line output (`BACKUP_OK path=...`)
  and never prompts, so it is safe for unattended runs.
- Rotate old backups (e.g. `find /var/backups/lockdown -mtime +30 -delete`).
- The GPG private key must be available on the restore host, **not** on the
  backup host. Ideally the backup host only has the public key.

### Option B — systemd timer (recommended for production)

`/etc/systemd/system/lockdown-backup.service`:

```ini
[Unit]
Description=Remote Lockdown System — encrypted backup
After=docker.service
Requires=docker.service

[Service]
Type=oneshot
User=lockdown
WorkingDirectory=/opt/remote-lockdown-system
EnvironmentFile=/opt/remote-lockdown-system/.env.prod
ExecStart=/opt/remote-lockdown-system/scripts/backup.sh \
  --cron \
  --encrypt-key admin@example.com \
  --output /var/backups/lockdown/lockdown-%i.tar.gz.enc
```

`/etc/systemd/system/lockdown-backup.timer`:

```ini
[Unit]
Description=Daily Remote Lockdown System backup

[Timer]
OnCalendar=*-*-* 02:00:00
Persistent=true

[Install]
WantedBy=timers.target
```

Enable:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now lockdown-backup.timer
systemctl list-timers lockdown-backup.timer
```

### Offsite replication

A local backup is not enough — the same disaster that takes down the server
can take down its local disk. After each backup, replicate the encrypted
archive to offsite storage:

```bash
# Example: push to S3 with server-side encryption
aws s3 cp /var/backups/lockdown/lockdown-20240101.tar.gz.enc \
  s3://my-lockdown-backups/ \
  --sse aws:kms
```

Keep at least **7 daily + 4 weekly + 12 monthly** backups (grandfather-father-
son rotation) per RPO requirements below.

---

## 3. Manual backup procedure

Run from the project root:

```bash
# 1. (PostgreSQL) ensure DB connection env vars are set, e.g.:
export DATABASE_URL="postgres://lockdown:secret@localhost:5432/lockdown"
#    or set DB_HOST / DB_PORT / DB_NAME / DB_USER / DB_PASSWORD individually.

# 2. Run the backup script.
./scripts/backup.sh \
  --encrypt-key "my-secret-passphrase" \
  --output ./my-backup.tar.gz.enc \
  --verify
```

Step-by-step what happens:
1. The script detects the database type from the environment
   (`DATABASE_URL`/`DB_*` → PostgreSQL; `USE_SQLITE`/`SQLITE_PATH` → SQLite).
2. **PostgreSQL:** `pg_dump --format=custom` produces a portable custom-format
   dump. **SQLite:** the `.db` file is copied (using `sqlite3 .backup` for a
   safe online copy when `sqlite3` is available).
3. `secrets/`, `.env` files, and config files are staged alongside the dump.
4. Everything is tar'd into a single `.tar.gz`.
5. The archive is encrypted (GPG or openssl).
6. With `--verify`, the script immediately restores the backup into a
   temporary database and prints row counts to confirm the backup is
   restorable.

The script prints the output path on success. **Save the passphrase
securely** — without it the backup cannot be decrypted.

### SQLite (desktop / Electron) mode

```bash
export USE_SQLITE=true
export SQLITE_PATH="$HOME/.lockdown/lockdown.db"
./scripts/backup.sh --encrypt-key "passphrase" --output ~/backups/lockdown.tar.gz.enc
```

---

## 4. Restore procedure

> **Warning:** Restore overwrites the target database. Always restore into a
> fresh environment first and verify, then cut over. The script refuses to
> overwrite an existing populated database unless `--force` is given.

```bash
# 1. (PostgreSQL) point at the target database.
export DATABASE_URL="postgres://lockdown:secret@restore-host:5432/lockdown"

# 2. Restore.
./scripts/restore.sh \
  --input ./my-backup.tar.gz.enc \
  --decrypt-key "my-secret-passphrase" \
  --force
```

Step-by-step what happens:
1. The script decrypts the archive (auto-detects GPG vs openssl from the key
   format).
2. It extracts the tar and reads `MANIFEST.txt` to determine the database type.
3. It checks whether the target database already contains data. If it does and
   `--force` was not given, it aborts with an error.
4. **PostgreSQL:** `pg_restore --clean --if-exists` drops existing objects and
   reloads from the dump. **SQLite:** the `.db` file is copied back to the
   resolved path (the pre-existing file is saved with a `.pre-restore-*`
   suffix first).
5. `secrets/` is restored to `./secrets/`.
6. `.env` files are restored (each overwrite is confirmed unless `--force`).
7. A summary of restored table row counts is printed.

### Secrets-only restore

If you only need to recover the encryption keys (e.g. after a key loss scare
but the DB is intact):

```bash
./scripts/restore.sh \
  --input ./my-backup.tar.gz.enc \
  --decrypt-key "passphrase" \
  --secrets-only
```

### Restoring to a different server

Backups are portable. To restore on a new host:

1. Install prerequisites: `tar`, `openssl`, and either `postgresql-client`
   (`pg_restore`/`psql`) or `sqlite3` depending on the backup's DB type.
2. Copy the encrypted backup and the decryption key to the new host.
3. Set the target `DATABASE_URL` (or `SQLITE_PATH`) to the new server's
   connection details — the script reads connection info from the environment,
   not from the backup, so path differences are handled automatically.
4. Run `restore.sh` as above.
5. Re-run migrations if the schema version is older than the code:
   `node server/src/db/migrate.js`.

---

## 5. Backup verification

A backup that cannot be restored is worthless. Always verify.

### `--verify` flag

```bash
./scripts/backup.sh --encrypt-key "passphrase" --verify
```

With `--verify`, immediately after creating the backup the script:

1. Decrypts the just-written archive.
2. Restores the database dump into a **temporary** database
   (PostgreSQL: a `_verify_<pid>` database that is dropped afterwards;
   SQLite: an in-process read of the extracted file).
3. Queries row counts for every user table.
4. Prints the counts and exits `0` if successful, `1` otherwise.

### Regular restore drills

Beyond the automated `--verify`, perform a full restore drill **at least
quarterly**:

1. Provision a throwaway server (or a local Docker container).
2. Run `restore.sh` against it from a recent backup.
3. Start the admin server and confirm: login works, devices list loads,
   audit log is visible.
4. Tear down the throwaway environment.

Log the drill result (date, backup used, time taken, issues found) in your
operations runbook.

---

## 6. Security considerations

- **Encrypt every backup.** Never write an unencrypted database dump to disk,
  even temporarily. `backup.sh` always encrypts the final archive.
- **Store the decryption key offline and separately from the backups.** A
  backup plus its key on the same compromised host is equivalent to no
  encryption. For GPG mode, keep the private key on an offline USB token or
  HSM; the backup host only needs the public key.
- **Use GPG asymmetric encryption for automated backups.** This avoids
  storing a passphrase in cron files or environment variables. The public key
  cannot decrypt — only the offline private key can.
- **Restrict file permissions.** Backups contain all secrets and the full
  database. Store them with `chmod 600` and restrict the backup directory to
  the `lockdown` user.
- **Rotate backup encryption keys periodically** (annually) and re-encrypt
  retained archives with the new key before destroying the old key.
- **Never commit backups or keys to git.** The `.gitignore` already excludes
  `secrets/` and `*.enc`; double-check before adding new patterns.
- **Test restores regularly.** An untested backup is an assumption, not a
  guarantee. See §5.
- **Consider immutability.** Store backups in write-once / object-lock storage
  (e.g. S3 Object Lock, GCP Bucket Lock) so ransomware or a compromised admin
  cannot delete them.

---

## 7. RPO / RTO guidance

| Metric | Target | Notes |
|---|---|---|
| **RPO** (Recovery Point Objective) | ≤ 24 hours | Daily backups. For higher-criticality deployments, run backups every 6–12 hours. The audit log and command queue change continuously; a 24h RPO means up to 24h of audit/command history may be lost. |
| **RTO** (Recovery Time Objective) | ≤ 2 hours | Restore is a single `restore.sh` invocation plus server restart. Allow extra time for offsite download of the encrypted archive. |
| **Retention** | 7 daily + 4 weekly + 12 monthly | Grandfather-father-son rotation. Monthly backups support long-term audit requirements. |
| **Verify cadence** | Every backup (`--verify`) + quarterly full drill | Automated verify catches corruption; drills catch environment drift. |

### Sizing the backup

- PostgreSQL custom-format dumps are compressed and typically 3–10× smaller
  than the live database. Expect a few MB for small deployments.
- The encrypted archive adds negligible overhead (<1%).
- Plan offsite storage for ~12 monthly backups × average size.

---

## 8. Troubleshooting

### `pg_dump: command not found`
Install the PostgreSQL client tools (`postgresql-client` / `postgresql16-client`).
The version of `pg_dump` must match or exceed the server's PostgreSQL major
version.

### `pg_dump: server version mismatch`
The local `pg_dump` is older than the server. Upgrade the client package, or
run `backup.sh` from inside the postgres container:
```bash
docker compose -f docker-compose.prod.yml exec -T postgres \
  pg_dump --format=custom -U lockdown lockdown > database.dump
```
then point `backup.sh` at the dump with `--db-url` set accordingly.

### `Decryption failed — wrong key or corrupted backup?`
- Confirm the passphrase/recipient matches what was used at backup time.
- For GPG: ensure the private key is imported (`gpg --list-secret-keys`).
- For openssl: ensure you are not confusing the GPG and openssl key formats.
  If the key contains `@` the script tries GPG first; pass a non-email
  passphrase to force openssl.
- Check the archive was not truncated in transit (`ls -l`, compare sizes).

### `Refusing to overwrite existing data without --force`
The target database already has rows. Either:
- restore into a fresh database, or
- re-run with `--force` (the script will `pg_restore --clean` / overwrite the
  SQLite file, saving a `.pre-restore-*` copy first).

### `Backup is missing MANIFEST.txt — not a valid lockdown backup`
The input file is not a backup produced by `backup.sh`, or the archive is
corrupted. Re-decrypt and inspect manually:
```bash
openssl enc -d -aes-256-cbc -pbkdf2 -pass pass:KEY -in file.enc -out file.tar.gz
tar -tzf file.tar.gz | head
```

### `sqlite3 .backup failed, falling back to file copy`
The `sqlite3` CLI is either missing or the DB is locked. The file copy fallback
is safe for desktop single-process use. For server-side SQLite under load,
ensure no writes are in flight during backup (stop the server first).

### `--verify` reports zero row counts
The backup may be of an empty database, or the temp restore failed silently.
Re-run without `--verify`, decrypt manually, and inspect the dump. For
PostgreSQL, check the temp `_verify_*` database was created (requires
`CREATEDB` privilege on the backup user).

### Restored server fails to decrypt data
The `FIELD_ENCRYPTION_KEY` / `LOCATION_FIELD_KEY` in the restored `secrets/`
or `.env` do not match the keys used when the data was originally encrypted.
Keys are tied to the data — you must restore the **matching** secrets backup.
If the keys are permanently lost, the encrypted columns are unrecoverable.

---

## Reference

- `scripts/backup.sh --help` — full option list
- `scripts/restore.sh --help` — full option list
- `docs/SECURITY.md` — overall security posture
- `server/.env.example` — database connection variables
- `docker-compose.prod.yml` — production PostgreSQL configuration
