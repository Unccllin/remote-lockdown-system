# ADR-001 — Admin password hashing differs per surface, deliberately and with a ceiling

**Status**: accepted (2026-11-16, session 269)
**Supersedes**: nothing
**Constrains**: `server/src/routes/admins.js`, `serverless/worker.ts`

## Context

Admin credentials are stored on two surfaces that never share a database:

| Surface | Store | Scheme | Work factor |
|---|---|---|---|
| Express server | SQLite/Postgres | bcrypt (`bcryptjs`) | cost **12** |
| Serverless Worker | KV `LOCKDOWN_KV` | PBKDF2-HMAC-SHA256 | **100,000** iterations |

The Worker number is not a choice made in a vacuum. Cloudflare Workers' WebCrypto
rejects PBKDF2 above 100,000 iterations with `NotSupportedError`, and the older
210,000 value (a NIST-era target) crashes the live runtime with error 1101 on
create-admin. That history is recorded at `serverless/worker.ts:442-449`, together
with the fact that 210,000 "only ever ran in Node tests, never on the live Worker,
so no live admin uses it". `LEGACY_PBKDF2_ITERATIONS = 210_000` exists only to
describe records that could never have been written in production.

Current guidance for PBKDF2-HMAC-SHA256 is ~600,000 iterations (OWASP, 2023). The
Worker therefore sits **below** the recommended work factor and cannot reach it on
this runtime. bcrypt cost 12 on the Express side is a modern factor and is not
affected.

## Decision

1. **Keep the two schemes.** They are not an accident to be unified: bcrypt cost 12
   is available on Node and not on Workers; PBKDF2 is the only KDF WebCrypto
   exposes. Each surface uses the strongest thing it can.
2. **Keep 100,000 on the Worker**, as the platform maximum, and treat the gap to
   current guidance as an accepted, recorded risk rather than an unnoticed one.
3. **Do not migrate records between surfaces.** An admin record from KV cannot
   authenticate against SQLite and vice versa. If the deployment ever consolidates
   onto one surface, every admin must reset their password — that is the cost, and
   it is stated here so nobody discovers it during an incident.
4. **Pin the divergence with a test.** `scripts/test_cross_surface_contract.py`
   asserts the cost parameters on both surfaces and the existence of this ADR, so
   changing either scheme fails a test instead of silently widening the split.

## Consequences

- A deployment that moves to a runtime without the WebCrypto cap (or to a Worker
  with a longer CPU budget) should raise `PBKDF2_ITERATIONS` and update this ADR;
  the test will require it.
- Password-reset flows must stay available on the Worker: they are the only way to
  re-hash an existing credential at a new cost.
- Anyone hardening the fleet should note that admin login on the Worker is the
  weakest credential-handling path in the system, and that it is bounded by the
  platform rather than by this code.

## Alternatives considered

- **Scrypt/Argon2 on the Worker** — WebCrypto exposes neither without WASM, which
  would add a large binary to every cold start.
- **bcrypt via WASM on the Worker** — same objection, plus a third-party crypto
  dependency in the authentication path.
- **Move admin auth to the Express surface only** — the Worker must be able to
  authenticate admins before any server exists (bootstrap, break-glass), which is
  why `ADMIN_TOKEN` and KV-backed admins exist at all.
