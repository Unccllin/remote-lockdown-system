# Serverless deployment (Cloudflare Worker)

This directory is the **alternative** to the Docker stack: a stateless API on
Cloudflare Workers, with all durable state in a KV namespace. The Windows agent
and the Electron app talk to it the same way they talk to the Express server —
the wire contract is shared, so either backend can serve them.

It is not a mirror of `server/`: the Worker implements the agent ingress
(check-in, enrolment, command ACK, escrow, deadman, location), the dashboard's
admin API, the binary download endpoints, and the whole PBL `/v1/*` surface in
CBOR/COSE (`pbl/`).

## Bindings and secrets

| name | kind | purpose |
|------|------|---------|
| `LOCKDOWN_KV` | KV namespace | all durable state: devices (one key each — see [Device storage](#device-storage-adr-003)), commands (one key each — see [Command storage](#command-storage-adr-002)), admins, audit, binaries |
| `ADMIN_TOKEN` | secret | break-glass super-admin. Maps to a synthetic admin, so treat it as a root credential |
| `JWT_SECRET` | secret | signs admin JWTs (falls back to `ADMIN_TOKEN`, then a dev string — do not rely on the fallback in production) |
| `PBL_SIGNING_KEY` / `PBL_POLICY_SIGNING_KEY` | secret | keys for the firmware-facing `/v1/*` COSE signatures |
| `GOOGLE_API_KEY` | secret (optional) | Google Geolocation key, provisioned into the enrolment response at install time (ADR-008); omitted when unset. A session-0 service install cannot scan BSSIDs, so the key only helps interactive installs — see [ADR-009](../docs/adr/ADR-009-location-precision-by-install-type.md). |

The KV id lives in `wrangler.toml`. Create the namespace once:

```bash
cd serverless
npx wrangler kv namespace create LOCKDOWN_KV     # prints the id for wrangler.toml
```

Set the secrets (prompted, never on the command line):

```bash
npx wrangler secret put ADMIN_TOKEN
npx wrangler secret put JWT_SECRET
npx wrangler secret put PBL_SIGNING_KEY
npx wrangler secret put PBL_POLICY_SIGNING_KEY
npx wrangler secret put GOOGLE_API_KEY
```

## Command storage (ADR-002)

Commands are **per-entity records**, not one list:

| key | value |
|-----|-------|
| `command:<id>` | one command record (status, timestamps, the ACK's evidence) |
| `command_index` | the ids, append-mostly |
| `commands` | legacy whole-list key; read once for migration, then deleted |

Why: every mutation used to load the whole list, edit it, and write it back, so two
overlapping requests destroyed each other's fields. Observed live in S269 — the agent ACKed
`unlock … status=executed` and the device still reported the unlock `pending`, because a
concurrent check-in had written an older snapshot over it. Mutation now reads and writes
exactly one key (`updateCommand`). Every fleet-scale store is per-entity now (ADR-002 through
ADR-006); `serializeMutation()` remains as belt-and-braces for the multi-key paths and for the two
small lists that are still single values — `admins` and `hw_test_artifacts` — neither of which is a
per-device collection.

Residual, stated rather than hidden: `command_index` is itself one key. It is append-mostly
and holds only ids, so a lost append hides a command (recoverable from the audit log) instead
of corrupting a record. Removing that residual means a Durable Object per device; see
[docs/adr/ADR-002-per-entity-command-records.md](../docs/adr/ADR-002-per-entity-command-records.md).

## Device storage (ADR-003)

Devices follow the same shape, for the same reason — a lost field there can be `api_key_hash`
(the device stops authenticating) or `status` (the dashboard says `active` for a machine that is
locked):

| key | value |
|-----|-------|
| `device:<id>` | one device record |
| `device_index` | the ids, append-mostly |
| `agent_key:<sha256>` | the id of the device that owns that API key |
| `device_checkin:<id>` | check-in metadata (KV-RACE-001), merged on read |
| `devices` | legacy whole-list key; read once for migration, then deleted |

`agent_key:` exists so authentication is **one read**. Without it, `verifyAgentAuth` scanning
per-entity records would turn one fleet read per agent request into N — a 60-device fleet
polling every 300 s would go from ~288 reads/day to ~17,000. The pointer is derived data: the
record stays the source of truth, `verifyAgentAuth` still compares the hash it computed against
the hash on the record, and a pointer to a re-keyed device fails closed. See
[docs/adr/ADR-003-per-entity-device-records.md](../docs/adr/ADR-003-per-entity-device-records.md).

Reading a device back for the UI or a test goes through the API, not the KV layout:

```bash
GET /api/devices                            # the fleet, with derived lock_state
GET /api/devices/:id                        # one device
```

## Location storage (ADR-004)

Reports are per-entity too, with the index **per device** so devices do not share a window:

| key | value |
|-----|-------|
| `location:<id>` | one report (latitude/longitude/city…, `observed_at`, `created_at`) |
| `location_index:<deviceId>` | that device's report ids, oldest first |
| `locations` | legacy whole-list key; migrated once, then deleted |

Why: the old shape was ONE list capped at 1000 rows for the whole fleet. A tracking device polls
every 30 s, so at 60 tracked devices each kept **16 reports — about eight minutes of trail** — the
chattiest device starved the rest, and every single report rewrote up to 1000 rows. Each device
now keeps `LOCATION_HISTORY_LIMIT` reports (default 500 ≈ 4 hours of continuous tracking,
overridable with that `[vars]` entry), and any report that falls off the end is deleted rather
than left behind. See
[docs/adr/ADR-004-per-entity-location-reports.md](../docs/adr/ADR-004-per-entity-location-reports.md).

## Audit storage (ADR-005)

Audit entries are per-entity, behind **one** index that carries the device id:

| key | value |
|-----|-------|
| `audit:<id>` | one entry (`action`, `detail`, `created_at`, `hostname`) |
| `audit_index` | `[{id, device_id}]`, oldest first, capped |
| `audit_log` | legacy whole-list key; migrated once, then deleted |

Why: every mutation appended through a read of up to 500 entries **plus a scan of the whole
fleet** to find one hostname — since ADR-003 that scan was one index read plus one read per
device, on the busiest write in the system (measured: 61 gets for one `api_key_rotated` on a
60-device fleet, 3 now). The index holds `device_id` as well as the id because the read API is
either global or scoped to one device: per-device indexes would be a second write on every
append, while the id in the index gives a scoped read its own ids for one write.
`AUDIT_HISTORY_LIMIT` (default 1000) is overridable, and pruning deletes the record with its
index entry. See
[docs/adr/ADR-005-per-entity-audit-entries.md](../docs/adr/ADR-005-per-entity-audit-entries.md).

## Secret storage (ADR-006)

Encryption key material and BIOS/PBA credentials are one key **per device**, holding that
device's rows:

| key | value |
|-----|-------|
| `encryption_keys:<deviceId>` | that device's escrowed keys (one per command that escrowed) |
| `bios_passwords:<deviceId>` | that device's credentials, KEK-encrypted as before |
| `encryption_keys` / `bios_passwords` | legacy whole lists; migrated once, then deleted |

Why: every access to both stores was already scoped to one device, so `device_id` *is* the
partition — an index would add a write per escrow, and a cap would truncate secrets that must
never be truncated (a lost encryption key is an unrecoverable device). Rows per device are single
digits: one key per escrowing command, one credential per type of which there are four. See
[docs/adr/ADR-006-per-device-secret-stores.md](../docs/adr/ADR-006-per-device-secret-stores.md).

Reading a command back for the UI or a test goes through the API, not the KV layout:

```bash
GET /api/devices/:id/commands?limit=20      # newest first, viewer role
```

## Agent auto-update (`/api/agent/update`)

The agent asks for an update on every check-in (`agent/agent.py:3238`) and verifies
a detached Ed25519 signature over `v1:{version}:{sha256}` against its pinned update
key before applying anything.

The Worker serves that metadata from a single KV key, `agent_release`. It holds no
signing key: signing happens wherever the private key lives (CI), and the Worker
only serves the result — so it cannot drift from the payload that was signed.

**Do not hand-write this record.** `scripts/sign-release-metadata.py` computes the
digests and signs them; a hand-copied hash drifts from the bytes it names, and a
signature over a different hash is indistinguishable from an attack.

The signature is bound to one hash (the message is `v1:{version}:{sha256}`), so a
release whose platform builds differ needs **one signature per platform**. The
signer emits that shape and refuses to fake a single top-level signature over two
hashes; the Worker serves the per-platform signature and only falls back to the
top-level one for metadata published before per-platform signing existed.

CI does this in the `publish-agent-release-metadata` job and attaches
`agent-release.json` to the release. To publish what CI signed:

```bash
# 1. Upload the binary the update response points at.
#    `binary:agent:<platform>` (win|linux) takes precedence over the shared
#    `binary:agent`, so a release with different builds publishes one key each:
#      npx wrangler kv key put --binding=LOCKDOWN_KV binary:agent:win   --path ./dist/lockdown-agent.exe
#      npx wrangler kv key put --binding=LOCKDOWN_KV binary:agent:linux --path ./dist/lockdown-agent
npx wrangler kv key put --binding=LOCKDOWN_KV binary:agent --path ./dist/lockdown-agent.exe

# 2. Publish the metadata CI generated (do not edit it)
npx wrangler kv key put --binding=LOCKDOWN_KV agent_release --path ./agent-release.json
```

Building the record by hand, for a local release:

```bash
scripts/generate-update-keys.sh --out secrets/          # once: the keypair
scripts/sign-release-metadata.py \
  --version 1.1.0 \
  --key secrets/update_signing.key \
  --artifact win=agent/staging/lockdown-agent-windows-x64.exe \
  --artifact linux=agent/staging/lockdown-agent-linux-x64 \
  --out agent-release.json
```

### Publishing is two halves, and they only work together

Publishing `agent_release` makes `/api/agent/update` *offer* a version. It does not
make any device *verify* it: a device only pins the key if its own config names
`update_public_key`, which is a **path to `update_signing.pub`** (not PEM text — an
inline PEM logs `Update public key not found` and the verifier refuses everything).
So a release that publishes metadata but ships an installer without the public key
leaves the fleet updating on `sha256-only` evidence: a digest delivered by the same
origin as the bytes (see B-006).

```bash
# 1. sign the record (scripts/sign-release-metadata.py)
# 2. publish it
npx wrangler kv key put --binding=LOCKDOWN_KV agent_release --path agent-release.json
# 3. stage the public key next to the binaries and rebuild the installer, so every
#    install writes update_public_key into config.json
cp update_signing.pub agent/dist/            # or STAGE=<dir> for build-generic-installer.sh
# 4. verify on a device that its check-in flips to update_verification: signature
npx wrangler deploy                           # only if Worker code changed
```

Two traps worth knowing, both measured:

- `wrangler r2 object put` writes to the **local simulator** unless `--remote` is
  passed, so an upload can "succeed" where nothing serves traffic.
- A key published to R2 is **shadowed by KV** until the KV copy is deleted: the
download route reads KV first, and KV deletes take up to a minute to propagate.
Publish to R2, then `wrangler kv key delete … <key>`, then verify the served digest.
- Restarting the service is not enough to pick up a config change if the old agent
  child is still alive: stop the service, kill any lingering `lockdown-agent`
  process, then start it, and confirm a fresh `Agent starting … build=…` line.

`--artifact` takes `PLATFORM=PATH` with the platform names the agent sends in
`X-Agent-Platform` (`win`, `linux`, `darwin`). Without `--key` the tool refuses
unless `--unsigned` is passed explicitly, and an unsigned record is one a pinned
agent will reject.

Behaviour worth knowing:

- **no `agent_release` key** → `update_available: false` with
  `reason: "no_release_published"`, and `latest_version` echoes what the agent sent.
  Nothing breaks; the agent simply does not update.
- **corrupt or incomplete metadata** (unparseable, or no `sha256`/`size`) → **500**.
  Metadata that cannot be verified must never be offered, because the agent would
  download a binary whose hash it cannot check.
- **`platforms`** overrides the top-level hash/size *and signature* per
  `X-Agent-Platform` (`win`, `linux`), for when the two builds differ — which for
  an unsigned-per-platform record means every platform but one refuses the update.
- **unsigned metadata** (`signature: null`) → served as-is. Unpinned agents accept
  it and report `sha256-only` at check-in; pinned agents refuse it. `agent-release.json`
  from a CI run without `UPDATE_SIGNING_KEY` is exactly this case, and the job emits
  a warning annotation saying so.

## Deployment: TLS floor (C3 §4 / D-116)

The device cannot enforce a TLS version floor — PBL only holds
`EFI_HTTP_PROTOCOL`, and EDK2's `TlsDxe` defaults its minimum to TLS 1.0 — so the
floor belongs at the terminator. For this Worker that is the Cloudflare zone
setting, which is **not** in this repository and must be set once per zone:

> Cloudflare dashboard → SSL/TLS → Edge Certificates → **Minimum TLS Version**:
> **TLS 1.2** (the account default allows 1.0).

The self-hosted deployment states the same floor in `Caddyfile`
(`tls { protocols tls1.2 tls1.3 }`), and `scripts/test_tls_floor.py` proves a
terminator carrying that line refuses TLS 1.0/1.1 and accepts 1.2/1.3. Verdict
*integrity* does not depend on this: the verdict is a `COSE_Sign1` verified against
the policy key, so a downgrade cannot forge a decision — the floor protects
confidentiality of the echoed `device_id`/`nonce`.

## What this backend does not implement

**Integrations inventory** (`GET /api/integrations`,
`GET /api/integrations/:id/devices`) is **self-hosted only**. In `server/` it is a
connector subsystem (`server/src/integrations/`: a registry plus connectors that
read credentials from `process.env` and call upstream APIs such as MeshCentral).
The Worker has no equivalent, and duplicating that abstraction would mean two copies
to keep in step.

It answers **501 Not Implemented**, not 404 — 404 is indistinguishable from a
mistyped path, while 501 says "this deployment does not implement it", which is the
truth. Auth is checked first, so an anonymous caller learns nothing about which
backend is behind the URL.

Nothing else depends on it: lockdown, unlock, enrolment, verdicts, tracking and the
audit trail are all served by this Worker. Only the third-party inventory view is
missing.

## Verify locally before deploying

```bash
make verify-worker          # or: scripts/verify-worker.sh
```

That script needs **no Cloudflare account**. It proves the two things the Vitest
suite cannot, because those tests call `worker.fetch()` directly and never build
or boot anything:

1. **The bundle builds** — `wrangler deploy --dry-run` runs esbuild, and the
   script then greps the output for `/v1/verdict`, `/api/agent/checkin`,
   `/api/enroll` and `/api/download/agent` to catch a route table lost to
   tree-shaking;
2. **It serves** — `wrangler dev` boots workerd on a local port with a local KV
   directory, and the script checks over HTTP:

   | check | proves |
   |-------|--------|
   | `GET /api/setup/status` → 200 | public route reachable |
   | `GET /api/devices` no token → **401** | admin auth enforced |
   | `GET /api/devices` with `ADMIN_TOKEN` → 200 | the break-glass path works |
   | same with a bogus token → **401** | tokens are actually verified |
   | an unknown path → 404 | no catch-all that would mask a typo |
   | `POST /v1/verdict` with junk → **4xx** | the PBL handler routes and validates (a 5xx would mean it is wired but broken) |
   | `GET /v1/policy/1` → 200/404 | policy route routed |
   | `GET /api/download/agent` → 200/404/503 | binary route routed, no crash without KV data |

## Deploy

This is the one step that needs your credentials:

```bash
cd serverless
npx wrangler login          # opens a browser, once per machine
npx wrangler deploy         # publishes to lockdown-serverless.<account>.workers.dev
```

`serverless/package.json` also has `npm run deploy` (`wrangler deploy`) and
`npm run dev` (`wrangler dev`).

### Running it locally (no Cloudflare account needed)

`npm run dev` boots workerd on `127.0.0.1:8787` with a **local KV** — it shares
nothing with the deployed Worker, so it is safe to create admins and enrol
devices there.

1. `npm ci` (in `serverless/`), then `npm run dev`.
2. Secrets come from `serverless/.dev.vars` — gitignored, never committed. It
   needs `JWT_SECRET` and `ADMIN_TOKEN`, and **nothing else**: leave
   `PBL_SIGNING_KEY` / `PBL_POLICY_SIGNING_KEY` out, and the Worker generates
   ES256 keys into the local KV on first use. Placeholder values are worse than
   absent — an unparseable string makes `/v1/verdict` and `/v1/policy/:v` answer
   **500**, and because `wrangler dev` merges this file unconditionally it also
   fails `make verify-worker`, a gate that is supposed to check the bundle rather
   than your local secrets (S269).
3. First run has no admins: `GET /api/setup/status` returns
   `{"setupComplete":false}`. Create one with

   ```bash
   curl -s -X POST http://127.0.0.1:8787/api/setup/create-admin \
     -H 'Content-Type: application/json' \
     -d '{"username":"dev","password":"<at-least-8-chars>"}'
   ```

   and log in at `POST /api/auth/login` for a JWT that `GET /api/devices` accepts.

`make hw-preflight SERVER_URL=http://127.0.0.1:8787 ADMIN_TOKEN=<jwt>` works
against it, which is the cheapest way to exercise the window's readiness check
end to end without touching the real fleet. It reports `no devices enrolled on
this server` — an empty fleet is not a missing device.

**If `wrangler` fails with `The package "@cloudflare/workerd-linux-64" could not
be found`**, npm's install-scripts policy skipped workerd's postinstall: install
the platform package that matches `node_modules/workerd/package.json`
(`npm i --no-save @cloudflare/workerd-linux-64@<same version>`), or run
`npm install-scripts approve workerd`.

## After deploying

```bash
BASE=https://lockdown-serverless.<account>.workers.dev
curl -s "$BASE/api/health"                                  # expect 200
curl -s -o /dev/null -w '%{http_code}\n' "$BASE/api/devices" # expect 401
curl -s -H "Authorization: Bearer $ADMIN_TOKEN" "$BASE/api/devices"
```

Then point the agent and the Electron app at that URL. The Electron setup wizard
validates the Worker URL before saving it.

### Publish the binaries the installers need

The Worker has no filesystem, so anything a generated install script executes has
to be in KV first. Both the per-device installer
(`GET /api/installer/:deviceId`) and the firmware re-arm script (`POST /api/rearm`)
hand off to the CLI installer, so **three** keys are needed:

```bash
cd serverless
npx wrangler kv key put --binding=LOCKDOWN_KV binary:agent \
  --path ../agent/dist/lockdown-agent.exe
npx wrangler kv key put --binding=LOCKDOWN_KV binary:agent-installer \
  --path ../agent/dist/lockdown-installer.exe   # agent/installer.spec
npx wrangler kv key put --binding=LOCKDOWN_KV binary:installer \
  --path ../installer/generic/dist/lockdown-installer.exe  # the fleet installer
```

Without `binary:agent-installer` the generated scripts download nothing and the
install fails loudly (the download route returns 404). The generated script:

1. writes the device's baked `config.json` to a temp directory,
2. downloads `lockdown-agent.exe` and `lockdown-installer.exe`, verifying each
   against the `x-content-sha256` response header,
3. runs `lockdown-installer.exe --config-file ... --silent`, which normalises the
   config, creates the lockdown folder, installs the scheduled task + run key,
   applies tamper protection and verifies check-in,
4. deletes the temp directory (the API key must not outlive the run).

It deliberately contains no `sc.exe`: the agent implements no SCM handshake, so a
service created that way is failed with 1053 and the process terminated about 30
seconds after boot.

### Integrity of the downloads

Every `/api/download/*` response carries `x-content-sha256`: the SHA-256 of
exactly the bytes being served, computed per response rather than stored at
publish time. A separately published digest can drift from the artefact (the
failure class this repo keeps finding); a derived one cannot.

Both clients verify it before executing anything:

- the generated install scripts (`Get-VerifiedFile` → `Get-FileHash`), and
- `agent/installer_gui.py` (`_download_verified`, which previously accepted any
  body larger than 1 MB).

Be exact about what this buys: **transport integrity** — no truncation, no
corruption, no proxy substituting a body. It is not authenticity. A hash that
arrives from the same origin as the bytes is self-certifying, which is the same
caveat `agent/agent.py` records for channel-delivered update hashes (B-006).
Authenticity needs a signature, and the installer binaries are not
Authenticode-signed yet (that waits on the owner PFX — see D-130).

## What is not covered by the local verification

- **Real KV behaviour** (eventual consistency, size limits, cold reads) — local
  mode uses SQLite-backed storage, so it cannot show those;
- **Secrets and account bindings** — they only exist after `wrangler secret put`;
- **Cron/scheduled handlers** — `verify-worker.sh` does not trigger them; run
  `wrangler dev --test-scheduled` and hit `/__scheduled` if you change one.
The agent check-in response carries `settings.google_api_key` when `GOOGLE_API_KEY` is configured on the Worker, enabling runtime key rotation (ADR-010).
