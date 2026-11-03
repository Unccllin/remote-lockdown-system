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

Publish a release (CI step, run where the signing key is available):

```bash
# 1. Upload the binary the update response points at
npx wrangler kv key put --binding=LOCKDOWN_KV binary:agent --path ./dist/lockdown-agent.exe

# 2. Publish its metadata (sha256/size of the exact bytes uploaded above).
#    signature = base64 Ed25519 over "v1:<version>:<sha256>"
cat > /tmp/agent-release.json <<JSON
{
  "latest_version": "1.1.0",
  "sha256": "<64 hex chars>",
  "size": 12345678,
  "built_at": "2026-11-02T00:00:00.000Z",
  "signature": "<base64 detached signature>",
  "signature_alg": "ed25519",
  "platforms": { "win": { "sha256": "<win build sha256>", "size": 23456789 } }
}
JSON
npx wrangler kv key put --binding=LOCKDOWN_KV agent_release --path /tmp/agent-release.json
```

Behaviour worth knowing:

- **no `agent_release` key** → `update_available: false` with
  `reason: "no_release_published"`, and `latest_version` echoes what the agent sent.
  Nothing breaks; the agent simply does not update.
- **corrupt or incomplete metadata** (unparseable, or no `sha256`/`size`) → **500**.
  Metadata that cannot be verified must never be offered, because the agent would
  download a binary whose hash it cannot check.
- **`platforms`** overrides the top-level hash/size per `X-Agent-Platform`
  (`win`, `linux`), for when the two builds differ.

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
2. downloads `lockdown-agent.exe` and `lockdown-installer.exe`,
3. runs `lockdown-installer.exe --config-file ... --silent`, which normalises the
   config, creates the lockdown folder, installs the scheduled task + run key,
   applies tamper protection and verifies check-in,
4. deletes the temp directory (the API key must not outlive the run).

It deliberately contains no `sc.exe`: the agent implements no SCM handshake, so a
service created that way is failed with 1053 and the process terminated about 30
seconds after boot.

## What is not covered by the local verification

- **Real KV behaviour** (eventual consistency, size limits, cold reads) — local
  mode uses SQLite-backed storage, so it cannot show those;
- **Secrets and account bindings** — they only exist after `wrangler secret put`;
- **Cron/scheduled handlers** — `verify-worker.sh` does not trigger them; run
  `wrangler dev --test-scheduled` and hit `/__scheduled` if you change one.
