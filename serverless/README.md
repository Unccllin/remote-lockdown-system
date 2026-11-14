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
| `LOCKDOWN_KV` | KV namespace | all durable state: devices, commands, admins, audit, binaries |
| `ADMIN_TOKEN` | secret | break-glass super-admin. Maps to a synthetic admin, so treat it as a root credential |
| `JWT_SECRET` | secret | signs admin JWTs (falls back to `ADMIN_TOKEN`, then a dev string — do not rely on the fallback in production) |
| `PBL_SIGNING_KEY` / `PBL_POLICY_SIGNING_KEY` | secret | keys for the firmware-facing `/v1/*` COSE signatures |

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
   needs `JWT_SECRET` and `ADMIN_TOKEN`; `PBL_SIGNING_KEY` /
   `PBL_POLICY_SIGNING_KEY` only matter for the policy-signature paths (random
   values there make those paths fail closed, which is the right local default).
3. First run has no admins: `GET /api/setup/status` returns
   `{"setupComplete":false}`. Create one with

   ```bash
   curl -s -X POST http://127.0.0.1:8787/api/setup/create-admin \
     -H 'Content-Type: application/json' \
     -d '{"username":"dev","password":"at-least-8-chars"}'
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
