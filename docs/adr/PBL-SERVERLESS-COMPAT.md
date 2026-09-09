# PBL-Serverless Compatibility ADR

> **Status**: APPROVED
> **Date**: 2026-09-07
> **Supersedes**: None (new)
> **Related**: PBL-C1-LockVerdict, PBL-C3-Network-Client, PBL-C4-Policy-Blob

## Context

The existing serverless Worker (`serverless/worker.ts`) handles OS agent
check-ins via `/api/agent/*` routes. PBL (the UEFI pre-boot lock app) needs
to call `POST /v1/verdict`, `GET /v1/policy/{version}`, and other `/v1/*`
endpoints. These two systems are incompatible at the wire-protocol level:

| Dimension | Agent (`/api/*`) | PBL (`/v1/*`) |
|-----------|-------------------|---------------|
| Wire format | JSON | CBOR (RFC 7049) |
| Response format | JSON | COSE_Sign1 (RFC 8152) |
| Auth | HMAC-SHA256 headers (`X-Agent-Key`, `X-Signature`) | TLS certificate pinning (no app-layer auth) |
| Interaction model | Polling (checkin every 30s, get commands) | Single request-response (stateless verdict) |
| Device identity | Random UUID (`generateId()`) | TPM-derived (`SHA-256(AK public area)`) |
| Signing | None (HMAC only) | Asymmetric (ES256 via Web Crypto API) |

**Key question**: How do we make the serverless Worker serve PBL without
breaking the existing agent infrastructure?

## Decision

### 1. Parallel routes, not replacement

Add `/v1/*` routes to the **same Worker**. Do NOT modify any existing
`/api/*` route. The Worker's `fetch` handler is a flat if-chain — adding
a new route prefix before the 404 catch-all is a 5-line change:

```ts
// In worker.ts, before the final "return errorResponse('Not found', 404)"
if (path.startsWith('/v1/')) {
  return handlePblRoute(request, env, path, method);
}
```

All PBL logic lives in `serverless/pbl/` — a new directory that keeps PBL
code isolated from agent code. The Worker remains a single deployment.

**Rationale**: A separate Worker would duplicate KV bindings, deployment
config, and CORS handling. The existing Worker already has KV access and
TLS termination. Adding routes is simpler than adding a deployment.

### 2. CBOR: pure JS, no dependencies

Implement a minimal CBOR encoder/decoder in `serverless/pbl/cbor.ts`
(~150 lines). The Worker currently has **zero runtime dependencies** —
this is a deliberate choice and we keep it.

PBL's CBOR is simple:
- Major type 0 (unsigned integers) for keys and numeric values
- Major type 2 (byte strings) for device_id, nonce, digests
- Major type 5 (maps) for request/response structures
- No floats, no tags, no nested complexity

**Verified**: A 60-line CBOR encoder/decoder was tested in the Workers
runtime environment (Node 22, esbuild target es2021) and successfully
round-tripped a PBL verdict request: 108-byte CBOR map with 4 entries
(3 byte strings of 32 bytes each + 1 unsigned integer).

### 3. COSE_Sign1: ES256 via Web Crypto API

C1 §5 specifies Ed25519 (`alg = -8`) with ES256 (`alg = -7`) as fallback.
Ed25519 is **not** in the standard Web Crypto API. ES256 (ECDSA P-256)
**is** available via `crypto.subtle.generateKey` / `crypto.subtle.sign`.

**Decision**: Use ES256 as the primary algorithm. C1 explicitly allows
this. If Ed25519 becomes available in Workers later, we can upgrade.

**Verified**: ES256 key generation, signing, and verification all work
in the Workers runtime:
- Key pair generated via `crypto.subtle.generateKey({name:'ECDSA', namedCurve:'P-256'})`
- Public key exported as SPKI (91 bytes) and raw (65 bytes: 04 + 32x + 32y)
- `kid = SHA-256(SPKI)` computed via `crypto.subtle.digest`
- 64-byte signature produced and verified

The COSE_Sign1 encoder constructs:
1. Protected header: CBOR map `{1: -7, 4: kid_bytes}` (alg=ES256, kid=SHA-256 of cert)
2. Payload: CBOR map with verdict fields
3. `Sig_structure = ["Signature1", protected, h'', payload]`
4. Signature: `crypto.subtle.sign({name:'ECDSA', hash:'SHA-256'}, privateKey, sig_structure)`
5. Final COSE_Sign1 = CBOR array `[protected, unprotected, payload, signature]`

### 4. Auth: TLS pinning at the edge, no app-layer auth

PBL does NOT send `X-Agent-Key` or `X-Signature` headers. The security
model is:

1. **TLS termination at Cloudflare edge**: PBL pins to the CA that signed
   Cloudflare's edge certificate. If the cert chain doesn't match the pin
   in the C4 policy (`tls_ca_pin`), PBL rejects the connection before
   sending any data.
2. **COSE_Sign1 on the verdict**: The server signs every verdict with
   ES256. PBL verifies the signature using the pinned public key
   (`lock_service_cert_pin` in C4 policy). A fake server cannot produce
   a valid signed verdict.
3. **Device_id binding**: The verdict includes the `device_id` from the
   request. PBL verifies it matches its own TPM-derived `device_id`.

The `/v1/*` routes skip `verifyAgentAuth` entirely. No API keys, no
HMAC, no session tokens. The Worker just processes the request.

### 5. Device identity: separate KV namespace prefix

PBL devices get their own KV key prefix: `pbl_devices:{device_id}`.
This is completely separate from the existing `devices` array that
stores agent-enrolled devices.

```ts
// PBL device record in KV
interface PblDevice {
  device_id: string;      // SHA-256(AK public area), hex
  ek_cert: Uint8Array;    // Endorsement key certificate
  ak_public: Uint8Array;  // Attestation key public area
  ak_name: Uint8Array;    // TPM AK name
  status: 'active' | 'locked' | 'recovering';
  enrolled_at: string;    // ISO timestamp
  hardware_uuid?: string; // Optional link to existing device record
  hostname?: string;
}
```

PBL enrollment is done by an operator (not by the UEFI app) via the admin
dashboard. The operator enrolls a device with its TPM-derived `device_id`,
and the server stores it in KV. At boot, PBL sends its `device_id` and
the server looks it up.

### 6. Stateless verdict: single request-response

The `/v1/verdict` handler is completely stateless:

```
PBL → POST /v1/verdict (CBOR: {device_id, nonce, platform_state_digest, policy_version})
       ↓
Worker:
  1. Parse CBOR body
  2. KV.get(`pbl_devices:${device_id}`) → device status
  3. Build verdict payload (CBOR map)
  4. Sign with ES256
  5. Wrap in COSE_Sign1
       ↓
PBL ← 200 OK (Content-Type: application/cose, body: COSE_Sign1)
```

No session, no polling, no command queue. Each request is independent.
The verdict is time-bounded (`issued_at` + `grace_until`) so PBL can
cache it for the grace period and use it offline.

### 7. Policy blob: served from KV, generated offline

The policy blob is a COSE_Sign1 signed by a **policy signing key**
(separate from the verdict signing key). It's generated offline by an
admin tool and stored in KV as `pbl_policies:{version}`.

The Worker just serves it: `GET /v1/policy/{version}` → KV.get → return
raw bytes with `Content-Type: application/cose`. No transformation.

## File structure

```
serverless/
├── worker.ts              # existing — add /v1/* dispatch (5 lines)
├── wrangler.toml          # existing — add PBL_SIGNING_KEY secret
├── pbl/                   # NEW — all PBL server-side code
│   ├── cbor.ts            # CBOR encoder/decoder (~150 lines)
│   ├── cose.ts            # COSE_Sign1 encoder (~120 lines)
│   ├── signing.ts         # ES256 key management (~80 lines)
│   ├── devices.ts         # KV device store (~60 lines)
│   ├── policy-gen.ts      # Policy blob generator (~200 lines, offline tool)
│   └── routes/
│       ├── verdict.ts     # POST /v1/verdict (~100 lines)
│       ├── policy.ts      # GET /v1/policy/{version} (~30 lines)
│       ├── enroll.ts      # POST /v1/enroll (~60 lines)
│       ├── attest.ts      # POST /v1/attest (~80 lines)
│       └── override.ts    # POST /v1/override/* (~100 lines)
└── pbl.test.ts            # NEW — Vitest tests for PBL endpoints
```

Total new code: ~985 lines of TypeScript.

## What does NOT change

- `worker.ts` existing routes — untouched
- `wrangler.toml` KV binding — reused (same `LOCKDOWN_KV` namespace)
- Agent check-in flow — untouched
- Admin dashboard — untouched (PBL enrollment is a new admin page)
- Agent Python code — untouched

## Verification

1. **ES256 signing**: Verified in Workers runtime (Node 22, es2021 target).
   Key generation, signing, verification all work via Web Crypto API.
2. **CBOR round-trip**: Verified 108-byte PBL verdict request encodes and
   decodes correctly with pure JS (no dependencies).
3. **KV compatibility**: `LOCKDOWN_KV` namespace already exists. PBL uses
   new key prefixes (`pbl_devices:`, `pbl_policies:`) that don't collide
   with existing keys (`devices`, `commands`, etc.).
4. **Route isolation**: `/v1/*` routes are dispatched before the 404
   catch-all. Existing `/api/*` routes are checked first, so there's no
   conflict.
5. **TLS pinning**: Cloudflare terminates TLS at the edge. PBL pins to
   the CA in the C4 policy. The Worker receives decrypted requests —
   no app-layer auth needed for PBL.

## Risks and mitigations

| Risk | Mitigation |
|------|-----------|
| ES256 signatures are larger than Ed25519 (64 vs 64 bytes — actually same) | Not a real risk; both are 64 bytes |
| COSE_Sign1 structure is complex | Implement and test against RFC 8152 test vectors |
| Policy signing key management | Generate offline, store in Worker secret, document rotation |
| KV read latency on verdict path | KV is eventually consistent; for lock state, use KV with short TTL or accept eventual consistency (a locked device that boots once during propagation is caught on next boot) |
| Cloudflare cert rotation breaks TLS pin | Pin to the CA (not the leaf cert); CAs rotate less frequently |
