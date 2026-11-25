# Serverless backup and restore

**Code**: [`serverless/backup.ts`](../serverless/backup.ts)
**Routes**: `GET/POST /api/admin/backups`, `POST /api/admin/restore` (super-admin)
**Cron**: the Worker ticks **hourly**; this pass runs on the **03:00 UTC** tick only (retention,
nonce purge and alerting run every hour). A backup reads every device, command and report — cost
scales with the fleet, while an alert reads one key per device — so the frequencies differ on
purpose. `shouldRunBackup()` in `worker.ts` is the gate, and it runs the pass when the tick's
timestamp is unknown rather than skipping: a backup that stops silently is the worse failure.

---

## What a backup contains

| Entity | Why it is in there |
|---|---|
| Devices | Including `api_key_hash` — lose it and every device re-enrols by hand |
| Commands | The queue plus the evidence each acknowledgement carried |
| Location reports | Bounded by the retention window, which is why the backup runs *after* the purge |
| Audit entries | The trail is evidence; a partial copy is worse than none |
| Admins | Password hashes and roles |

**It is encrypted, and it refuses to be written otherwise.** `BACKUP_ENCRYPT_KEY` must be 64 hex
characters (`openssl rand -hex 32`). With no key, or a short one, the pass records
`backup_skipped` and writes nothing — there is no unencrypted fallback, because this object holds
every credential hash in the system at once.

**Envelope**: `RMLB` + version byte + 12-byte IV + AES-256-GCM ciphertext, with the header as
additional authenticated data. An edited or truncated file fails to decrypt; there is no
"mostly restored" state. This is the Worker's own format and is **not** interchangeable with the
Node server's on-disk backups.

---

## Configure

```bash
cd serverless
npx wrangler r2 bucket create lockdown-backups
npx wrangler secret put BACKUP_ENCRYPT_KEY      # paste 64 hex characters
# uncomment the [[r2_buckets]] block with binding = "BACKUPS" in wrangler.toml
npx wrangler deploy
```

`BACKUP_RETENTION_DAYS` defaults to 30 and prunes on every write. The key is **not** stored in the
bucket, and it must not be: a backup and its key in one place is a plaintext dump with extra steps.
Keep it in the same escrow as `K-BACKUP` in the handover package — it is the same secret class.

---

## The drill (do this quarterly; a backup nobody restored is a hypothesis)

```bash
export WORKER_URL="https://lockdown.example.com"    # production
export STAGING_URL="https://staging.example.com"    # a second deployment, same key
export ADMIN_TOKEN="..."

# 1. take one now instead of waiting for the 03:00 UTC tick
curl -X POST "$WORKER_URL/api/admin/backups" -H "Authorization: Bearer $ADMIN_TOKEN"

# 2. list what exists
curl "$WORKER_URL/api/admin/backups" -H "Authorization: Bearer $ADMIN_TOKEN"

# 3. restore it — into the staging deployment, never into production first
curl -X POST "$STAGING_URL/api/admin/restore" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"key":"backups/2026-11-24T03-00-00-000Z.rmlb"}'
```

**Exit condition for the drill**: the response's `counts` match the numbers in the backup's
`customMetadata`, a device from the backup authenticates against the staging deployment, and the
last audit entry is `backup_restored`. Anything less is a written backup, not a working one.

---

## Limits, stated rather than discovered later

| Property | Reality |
|---|---|
| RPO | 24 hours — one backup per cron tick. Shorten by adding a second cron expression; the write is cheap |
| RTO | Minutes to the object, plus one restore per entity: the restore is a loop of per-record writes, not a bulk load |
| Restore semantics | **A merge, not a replacement.** Records written after the backup are left alone; records deleted after it are not removed by restoring |
| Cross-deployment | A staging restore needs the same `BACKUP_ENCRYPT_KEY`; a different key fails closed |
| Consistency | The collection pass reads many keys, so a restore can contain a command whose acknowledgement landed mid-pass. Harmless — the acknowledgement is re-delivered — but it is not a point-in-time snapshot |
| Large fleets | The daily pass lists every device and every report. Above a few thousand devices this belongs in a relational store, which is what the D1 cutover is for |

---

## What is still missing

- **No restore-induced wipe.** Restoring an old backup over a healthy deployment leaves newer
  records in place, which is the safe default but means "roll back to Monday" is manual.
- **No integrity manifest.** The envelope authenticates its own bytes; nothing records the object's
  size or the expected counts alongside it. `customMetadata` carries counts, so a mismatch is
  visible — it is not enforced.
- **No off-account copy.** The bucket is the same account as the deployment. A backup on the same
  account does not survive losing the account.
