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

## What is not covered by the local verification

- **Real KV behaviour** (eventual consistency, size limits, cold reads) — local
  mode uses SQLite-backed storage, so it cannot show those;
- **Secrets and account bindings** — they only exist after `wrangler secret put`;
- **Cron/scheduled handlers** — `verify-worker.sh` does not trigger them; run
  `wrangler dev --test-scheduled` and hit `/__scheduled` if you change one.
