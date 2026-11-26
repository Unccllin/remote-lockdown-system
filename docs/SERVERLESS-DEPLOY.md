# Deploying the serverless Worker

**Audience**: whoever holds the account. Every step below needs credentials this repository does not
contain, which is why the checklist exists rather than a script that pretends to run it.
**Smoke after deploy**: `node scripts/serverless-smoke.mjs --url "$WORKER_URL" --token "$ADMIN_TOKEN"`

Run in order. Each step states what it proves, so a step that fails tells you which assumption broke
rather than only that something did.

---

## 0. Preconditions

| Need | Check |
|---|---|
| Wrangler authenticated to the right account | `npx wrangler whoami` |
| The bundle builds | `make verify-worker` (no account needed) |
| The suite is green | `cd serverless && npx vitest run` (534 tests) |

If `verify-worker` is not green, stop: a deploy will not fix a bundle that does not build.

---

## 1. Durable stores

```bash
cd serverless
npx wrangler kv namespace create LOCKDOWN_KV      # paste the id into wrangler.toml
npx wrangler r2 bucket create lockdown-binaries   # agent + installer payloads (27 MiB KV limit)
npx wrangler r2 bucket create lockdown-backups    # encrypted backups, separate lifecycle
```

Uncomment the `[[r2_buckets]]` block with `binding = "BACKUPS"` in `wrangler.toml`.

**Proves**: the three stores exist and the bindings in `wrangler.toml` name them. Nothing about the
code yet.

---

## 2. Secrets

```bash
npx wrangler secret put ADMIN_TOKEN                 # break-glass super-admin; treat as root
npx wrangler secret put JWT_SECRET                  # openssl rand -hex 32
npx wrangler secret put PBL_SIGNING_KEY             # ES256 private key for verdict signing
npx wrangler secret put PBL_POLICY_SIGNING_KEY      # a DIFFERENT key — separate domain on purpose
npx wrangler secret put BACKUP_ENCRYPT_KEY          # openssl rand -hex 32
# UPDATE_SIGNING_KEY is NOT a Worker secret. The serverless Worker never reads it: the release
# metadata is signed OFFLINE (scripts/sign-release-metadata.py) and published to KV as
# `agent_release`, so the signature arrives pre-computed. `wrangler secret put` for it would be
# inert — this step used to tell you to set it, which was wrong.
# optional, only if used:
# npx wrangler secret put GOOGLE_API_KEY
```

**Proves**: nothing yet — secrets are only exercised by the smoke in step 6.

One more must not be confused, and it is silent:

- `PBL_POLICY_SIGNING_KEY` must differ from `PBL_SIGNING_KEY`. One key for two domains means a
  verdict signature can be replayed as a policy signature.
- The **update-signing keypair is offline key material**, not a Worker binding. Keep the private
  half in escrow (`~/.lockdown-secrets/update_signing.key` on the authoring machine) and ship the
  public half as `update_signing.pub` beside the installer, so `config.json` pins it as
  `update_public_key`. Publish a release without that pin and the fleet updates on a digest served
  by the same origin as the bytes — `sha256-only`, which is not verification.

**Escrow before you deploy**: `BACKUP_ENCRYPT_KEY` and `UPDATE_SIGNING_KEY` are the two secrets whose
loss is unrecoverable (see `docs/handover-registry.json`, keys `K-BACKUP` and `K-UPDATE-SIGN`). Lose
the first and every backup is a brick; lose the second and no deployed agent can be updated again.

---

## 3. Configuration variables

Set these as `[vars]` in `wrangler.toml` (or `--var` per deploy):

| Var | Default | Why you would change it |
|---|---|---|
| `STALE_DEVICE_THRESHOLD_SEC` | 600 | Alert earlier on a stolen fleet, at the cost of noise on flaky links |
| `ALERT_REPEAT_HOURS` | 24 | Lower means a repeat reminder sooner, not more coverage |
| `NOTIFICATION_WEBHOOK_URL` / `SLACK_WEBHOOK_URL` | unset | **Set at least one**, or alerts are audited and delivered nowhere |
| `LOCATION_RETENTION_DAYS` | 90 | Must match what your privacy notice says, not exceed 180 |
| `BACKUP_RETENTION_DAYS` | 30 | Longer than your restore drill cadence is pointless |
| `REPLAY_PROTECTION` | on | Only `off` for a staged rollout, never in steady state |

**Proves**: the deployment's promises match the operator's intent. A privacy notice claiming 90 days
with `LOCATION_RETENTION_DAYS=180` set is a misrepresentation with an audit trail attached.

---

## 4. Stage the binaries the fleet updates from

```bash
# build, then publish to the bucket the Worker reads
npx wrangler r2 object put lockdown-binaries/binary:/agent --file=agent/dist/lockdown-agent.exe
npx wrangler r2 object put lockdown-binaries/binary:/installer --file=agent/dist/lockdown-installer.exe
cp update_signing.pub agent/dist/          # so generated installers pin update_public_key
```

**Proves**: `/api/download/agent` serves a payload. Without this, the smoke reports it as skipped and
the fleet cannot self-update — which is a silent fleet-wide failure, not a cosmetic gap.

---

## 5. Deploy

```bash
npx wrangler deploy
```

Then create the first administrator: `POST /api/setup/create-admin` runs once and disables itself.
There is no self-registration and no SSO — see `docs/HANDOVER.md` gap `G-SSO`.

**Proves**: the bundle is live. Nothing about behaviour.

---

## 6. Smoke

```bash
export WORKER_URL="https://lockdown.example.com"   # your deployed Worker
export ADMIN_TOKEN="..."                           # the break-glass token

node scripts/serverless-smoke.mjs --url "$WORKER_URL" --token "$ADMIN_TOKEN"
node scripts/serverless-smoke.mjs --url "$WORKER_URL" --token "$ADMIN_TOKEN" --allow-writes
```

The first run is read-only and safe against production. The second writes one backup and enrols one
throwaway device to prove replay rejection end to end — run it against production once, then delete
the smoke device in the dashboard.

Exit code 0 with every check `OK` or `SKIP` (with a reason) is the pass condition. `SKIP` on
`/api/download/agent` means no binary is staged; `SKIP` on `POST /api/admin/backups` with a refusal
means no bucket or key — both are configuration gaps the smoke names rather than hides.

---

## 7. First device

1. Enrol a real device. Confirm it checks in (dashboard, or `GET /api/devices`).
2. Confirm the check-in reports `update_verification: signature`, not `sha256-only`.
3. Queue a harmless command (track, not lockdown) and confirm the acknowledgement lands.
4. Let the device go quiet past `STALE_DEVICE_THRESHOLD_SEC` and confirm exactly one alert arrives —
   one, not one per tick, is what the dedupe marker is for.

**Proves the whole loop**: signed auth, command delivery, acknowledgement, and alerting. Steps 1–6
prove the API answers; this proves the product works.

---

## Optional: relational store (stage 0 only)

```bash
npx wrangler d1 create lockdown
npx wrangler d1 execute lockdown --file=d1/schema.sql --remote
```

Uncomment `[[d1_databases]]` and redeploy. This changes exactly one behaviour: replay rejection
becomes authoritative instead of eventually consistent. The rest of the migration is staged in
`docs/SERVERLESS-D1-CUTOVER.md` and should wait until the fleet is past a few hundred devices.

---

## Rollback

| Situation | Action |
|---|---|
| The deploy is broken | `npx wrangler rollback` (previous version), then `make verify-worker` locally |
| Data is wrong after a deploy | Restore from the last good backup — see `docs/SERVERLESS-BACKUP.md`. Restore is a merge: it does not remove records added after the backup |
| A secret is compromised | Rotate it, redeploy, and re-enrol only if it was `AGENT_KEY_PEPPER` or the update key |
| Everything is wrong | `npx wrangler delete` — the KV namespace and both buckets are separate and survive it |

**Deleting the Worker does not delete data.** That is deliberate: the recovery path for a bad deploy
is a rollback of code, not a rebuild of state.

---

## What this checklist does not do

- It does not create an administrator for you, choose your domain, or set up DNS.
- It does not prove the hardware enforcement paths — those need real devices
  (`make hw-preflight`, `docs/D-129-HARDWARE-RUNBOOK.md`).
- It does not give you SSO, MFA, audit export or a licence mechanism. Those are gaps with a
  remediation plan, not deployment steps.

---

## GOOGLE_API_KEY must be restricted before it is set (D-230)

The Worker hands this key to every device in its own enrolment response, and the agent uses it to
resolve BSSID scans into coordinates. So it is a *deployment* secret in the weakest possible position:
any device can read it out of the response it already receives (field `google_api_key`), and so can
anyone holding a device or a log of that response.

Two rules, and the second is in the code:

1. **Restrict the key in Google Cloud** to the **Geolocation API only**, with a **daily quota**.
   An unrestricted key is a billing incident waiting for the first extracted device.
2. **A placeholder is not served.** `serverless/kv-store.ts` (`servedGeolocationKey`) and
   `server/lib/geolocationKey.js` treat `ROT-TEST-…`, `changeme`, `placeholder`, `your-key`,
   `example…` and `xxx…` as "no key" — the field is omitted and the agent's runtime settings report
   `null`, so it falls back to city-level IP location *knowingly* instead of presenting a key that
   cannot work. This deployment shipped `ROT-TEST-…`, which is why the rule exists.

```bash
# what the deployment currently serves (should be null until a restricted key is set)
npx wrangler secret list | grep GOOGLE_API_KEY
```
