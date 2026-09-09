# C4 — Policy Blob Schema

> **Status:** FROZEN (Day 0). Agents A, C code against this. Agent E tests
> against it. Changes require orchestrator approval and a version bump.
> **Owner:** Orchestrator (schema); Agent C (serves via `GET /v1/policy/{version}`).
> Agent A (parses + verifies); Agent E (fuzzes the parser).
> **References:** PBL-IMPLEMENTATION-PLAN.md §3, §4 all REQs; C1 §5
> (cert pin); C2 §1 (nv_index_base), §4.3 (sealing tier), §7 (TPM matrix);
> C3 §4 (TLS CA pin).

**Core principle (charter §3):** Policy is data. A new CVE becomes a policy
push, never a code change. PBL code is generic; the policy blob carries all
OEM-specific floors, allowlists, denylists, hashes, and pins.

---

## 1. Encoding

The policy blob is a **COSE_Sign1** structure (same envelope as C1):

```
COSE_Sign1 = [
    protected: bstr .cbor {1: alg_id, 4: kid},
    unprotected: {},
    payload: bstr .cbor PolicyBlob,
    signature: bstr
]
```

- **alg:** -8 (Ed25519) or -7 (ES256), same as C1.
- **kid:** SHA-256 of the policy signing key's public key. The policy signing
  key is the **same key** used for `TPM2_PolicyAuthorize` in C2 §2. This is
  deliberate: the policy blob's signature is the authorization for TPM NV
  access, so a single key governs both.
- **Signature:** over `Sig_structure` (RFC 8152 §4.2), same as C1.

The policy signing key is held in the same HSM/KMS as the verdict signing
key (C1 §5) but is a **separate key** (policy and verdict have different
rotation cadences and abuse profiles).

### 1.1 Size budget

The full COSE_Sign1 policy blob MUST be ≤ 64 KiB. This fits in a single UEFI
HTTP response and can be stored on the ESP. PBL rejects any policy body > 128
KiB (DoS guard).

---

## 2. Payload (PolicyBlob)

CBOR map, canonical encoding. Fields grouped by purpose:

### 2.1 Metadata

| Key | Name | Type | Required | Notes |
|-----|------|------|----------|-------|
| 1 | version | uint | yes | Monotonic. Must be ≥ C2 PBL_POLICY_VERSION counter or PBL rejects (REQ-11). |
| 2 | issued_at | uint | yes | Unix timestamp. |
| 3 | expires_at | uint | yes | Unix timestamp. After this, PBL fetches a new policy. Default: 90 days from issued_at. |
| 4 | min_pbl_version | uint | yes | Minimum PBL binary version that can evaluate this policy. If PBL's version < this, PBL enters DEGRADED (it may be missing a check the policy expects). |

### 2.2 Secure Boot policy (REQ-01, REQ-02)

| Key | Name | Type | Required | Notes |
|-----|------|------|----------|-------|
| 10 | oem_pk_allowlist | array of {subject: tstr, issuer: tstr, fingerprint: bstr(32)} | yes | REQ-01: PK issuer/subject must be in this list. `fingerprint` = SHA-256 of PK cert DER. |
| 11 | pkfail_denylist | array of bstr(32) | yes | REQ-01: SHA-256 fingerprints of known AMI/PKfail test keys. If PK fingerprint is in this list, BLOCK. |
| 12 | db_expectations | array of {fingerprint: bstr(32), label: tstr} | yes | REQ-02: db must contain these. `label` = human-readable (e.g., "Windows UEFI CA 2023"). |
| 13 | dbx_expectations | array of {fingerprint: bstr(32), label: tstr} | yes | REQ-02: dbx must contain these. Includes MS 2011 Windows Production CA revocation + BootHole-era hashes. |
| 14 | bootmgr_svn_floor | uint | yes | REQ-02: bootmgr Security Version Number floor. PBL reads SVN from the PE/COFF OPTIONAL_HEADER `WIN_CERTIFICATE` extension (Agent A `Svn.c`). |

### 2.3 SPI protections (REQ-03)

| Key | Name | Type | Required | Notes |
|-----|------|------|----------|-------|
| 20 | spi_protection_required | bool | yes | If true, REQ-03 checks are enforced. If false, REQ-03 is advisory (DEGRADED, never BLOCK). |
| 21 | spi_oem_matrix | array of {vendor: tstr, product: tstr, protocol: tstr, status: "ok"\|"unknown"\|"unsupported"} | yes | Per-OEM SPI register access protocol. `status="unknown"` → PBL marks REQ-03 unknown, server policy decides. |

### 2.4 Firmware version floors (REQ-04)

| Key | Name | Type | Required | Notes |
|-----|------|------|----------|-------|
| 30 | firmware_floors | array of {vendor: tstr, product: tstr, min_version: tstr, advisories: [tstr]} | yes | REQ-04: SMBIOS Type 0 vendor/product → minimum firmware version. `advisories` lists the CVE class (e.g., "LogoFAIL", "Binarly SMM", "ME"). Below floor → DEGRADED. |
| 31 | amt_allowlist | array of {device_id: bstr(32), reason: tstr} | yes | REQ-04: AMT must be de-provisioned unless device_id is in this list. |
| 32 | usb_dci_policy | "disabled" \| "allowlisted_only" | yes | REQ-04: USB DCI must be disabled (default) or only allowlisted devices. |

### 2.5 TPM policy (REQ-05, REQ-06, cross-ref C2)

| Key | Name | Type | Required | Notes |
|-----|------|------|----------|-------|
| 40 | tpm_session_requirements | {hmac: bool, param_encrypt: bool, salted: bool, bound: bool} | yes | REQ-05: all must be true. PBL refuses if it cannot satisfy. |
| 41 | tpm_firmware_floors | array of {vendor: tstr, model: tstr, min_version: tstr, risk: tstr} | yes | REQ-06: TPM-Fail (Intel fTPM, STMicro) + faulTPM (AMD Zen 2/3) floors. |
| 42 | tpm_pin_policy | array of {tpm_type: "dtpm"\|"ftpm_intel"\|"ftpm_amd_zen2_3"\|"ftpm_amd_zen4_plus"\|"ftpm_stm", pin_required: bool} | yes | REQ-05/06: PIN mandatory for dTPM and AMD Zen 2/3 fTPM. |
| 43 | nv_index_base | uint | yes | C2 §1: base offset for NV indices. Default `0x01C00000`. Override if OEM collides. |
| 44 | bitlocker_sealing_tier | "standard"\|"high_assurance" | yes | C2 §4.3: standard = PCR 7+11, high_assurance = PCR 7+11+12+13. |

### 2.6 Boot configuration (REQ-07, REQ-08, REQ-09)

| Key | Name | Type | Required | Notes |
|-----|------|------|----------|-------|
| 50 | s3_policy | "disabled" \| "allowed" | yes | REQ-07: S3 must be disabled (default). PBL reads ACPI FADT. |
| 51 | kernel_dma_protection_required | bool | yes | REQ-07: Kernel DMA Protection must be on. |
| 52 | mor_required | bool | yes | REQ-07: Memory Overwrite Request bit must be set. |
| 53 | network_boot_policy | "absent" \| "https_pinned_only" | yes | REQ-08: network boot entries absent from BootOrder, or pinned to HTTPS with CA in TlsCaCertificate. |
| 54 | bcd_hash | bstr(32) | yes | REQ-09: SHA-256 of expected BCD store. PBL reads BCD from ESP. |
| 55 | winre_wim_hash | bstr(32) | yes | REQ-09: SHA-256 of expected winre.wim. |
| 56 | recoverysequence_target | tstr | yes | REQ-09: expected BCD recoverysequence target. |
| 57 | bitlocker_required | bool | yes | REQ-09: OS volume must be BitLocker-protected with escrowed recovery key. |

### 2.7 Recovery capability (REQ-10)

| Key | Name | Type | Required | Notes |
|-----|------|------|----------|-------|
| 60 | firmware_recovery_expectation | "dual_image" \| "intel_pfr" \| "none" | yes | REQ-10: "none" → DEGRADED, never BLOCK. |

### 2.8 Pins and endpoints (cross-ref C1, C3)

| Key | Name | Type | Required | Notes |
|-----|------|------|----------|-------|
| 70 | lock_service_uri | tstr | yes | C3: base URI for verdict requests (e.g., "https://pbl-verdict.example.com"). |
| 71 | lock_service_cert_pin | bstr(32) | yes | C1 §5: SHA-256 of the verdict signing cert. PBL resolves COSE kid → this. |
| 72 | lock_service_cert_pin_history | array of bstr(32) | yes | C1 §5: previous signing cert fingerprints, for grace-period overlap during key rotation. |
| 73 | tls_ca_pin | bstr(32) | yes | C3 §4: SHA-256 of the lock-service TLS CA cert. |
| 74 | attestation_uri | tstr | yes | C1 §6: `POST /v1/attest` endpoint for TPM quote upload. |
| 75 | policy_uri | tstr | yes | C1 §6: `GET /v1/policy/{version}` endpoint for policy fetch. |
| 76 | verdict_signing_key_spki | bstr | yes | D-205: Full SPKI DER of the verdict signing key. PBL uses this with `EcDsaVerify` to verify verdict COSE_Sign1 signatures. `kid` (key 71) = SHA-256 of this SPKI. |
| 77 | signing_cert_chain | array of bstr | no | D-205: X.509 cert chain [leaf, intermediate, root CA] as DER bytes. Firmware verifies the chain back to the pinned root CA, then extracts the leaf SPKI for signature verification. Enables key rotation without firmware updates. Empty array if not provisioned (use pinned SPKI instead). |

### 2.9 Verdict cache and override (REQ-13, REQ-14)

| Key | Name | Type | Required | Notes |
|-----|------|------|----------|-------|
| 80 | verdict_freshness_seconds | uint | yes | C1 §3.1: max age of an online verdict. Default 900 (15 min). |
| 81 | grace_period_seconds | uint | yes | C1 §3.1: offline cache validity. Default 604800 (7 days). |
| 82 | wipe_deadline_seconds | uint | yes | C1 §3.1: WIPE_PENDING execution window. Default 86400 (24h). |
| 83 | override_rate_limit | {max_attempts: uint, window_seconds: uint} | yes | REQ-14: offline override rate limit. Default 5 attempts per 3600s. |
| 84 | override_challenge_uri | tstr | yes | C1 §6: `POST /v1/override/challenge` endpoint. |

### 2.10 No secrets

**The policy blob contains NO secrets.** No private keys, no passwords, no
PINs, no unlock codes. The policy is public data signed by the policy key.
REQ-14 mandates "no static/global unlock secret anywhere in the codebase" —
the policy blob is no exception. Override is challenge/response (C1 §6),
not a shared secret.

---

## 3. CBOR diagnostic example (abbreviated)

```
{
  1: 7,                                    // version
  2: 1725555200,                           // issued_at
  3: 1728147200,                           // expires_at (30 days)
  4: 1,                                    // min_pbl_version

  10: [{subject: "HP Inc.", issuer: "HP Inc. Self-Signed", fingerprint: h'...'}],
  11: [h'...', h'...'],                    // PKfail denylist
  12: [{fingerprint: h'...', label: "Windows UEFI CA 2023"}],
  13: [{fingerprint: h'...', label: "MS 2011 Prod CA revocation"},
       {fingerprint: h'...', label: "BootHole GRUB hash"}],
  14: 7,                                   // bootmgr_svn_floor

  20: true,                                // spi_protection_required
  21: [{vendor: "HP", product: "EliteBook 840", protocol: "HpSpiLib", status: "ok"},
       {vendor: "Dell", product: "Latitude 7440", protocol: "none", status: "unknown"}],

  30: [{vendor: "HP", product: "EliteBook 840 G10", min_version: "U70 Ver. 01.05.00", advisories: ["LogoFAIL", "Binarly SMM"]}],
  31: [],                                  // amt_allowlist (empty = de-provision all)
  32: "disabled",                          // usb_dci_policy

  40: {hmac: true, param_encrypt: true, salted: true, bound: true},
  41: [{vendor: "Intel", model: "PTT", min_version: "11.0.0.0", risk: "TPM-Fail"},
       {vendor: "AMD", model: "Zen3 fTPM", min_version: "none", risk: "faulTPM"}],
  42: [{tpm_type: "dtpm", pin_required: true},
       {tpm_type: "ftpm_amd_zen2_3", pin_required: true}],
  43: 17825792,                            // nv_index_base = 0x01100000
  44: "high_assurance",                    // bitlocker_sealing_tier

  50: "disabled",                          // s3_policy
  51: true,                                // kernel_dma_protection_required
  52: true,                                // mor_required
  53: "absent",                            // network_boot_policy
  54: h'...',                              // bcd_hash
  55: h'...',                              // winre_wim_hash
  56: "{default}",                         // recoverysequence_target
  57: true,                                // bitlocker_required

  60: "dual_image",                        // firmware_recovery_expectation

  70: "https://pbl-verdict.example.com",
  71: h'...',                              // lock_service_cert_pin
  72: [h'...'],                            // cert_pin_history
  73: h'...',                              // tls_ca_pin
  74: "https://pbl-verdict.example.com/v1/attest",
  75: "https://pbl-verdict.example.com/v1/policy",
  76: h'3059...',                           // verdict_signing_key_spki (DER)

  80: 900,                                 // verdict_freshness_seconds
  81: 604800,                              // grace_period_seconds
  82: 86400,                               // wipe_deadline_seconds
  83: {max_attempts: 5, window_seconds: 3600},
  84: "https://pbl-verdict.example.com/v1/override/challenge"
}
```

---

## 4. Anti-rollback (REQ-11)

PBL enforces monotonic policy version via C2's `PBL_POLICY_VERSION` NV
counter (C2 §1.2):

1. PBL reads the policy blob (from ESP or via C3 `GET /v1/policy/{version}`).
2. PBL reads `PBL_POLICY_VERSION` from TPM NV (C2 §5.1 step 5).
3. If `policy.version < NV counter` → **reject** (rolled-back policy). BLOCK.
4. If `policy.version > NV counter` → `TPM2_NV_Increment` (C2 §5.3), then apply.
5. If `policy.version == NV counter` → apply (same version, e.g., re-fetched).

Agent E's REQ-11 negative test: replay an old signed policy → PBL reads NV
counter (higher) → rejects the old policy → BLOCK.

### 4.1 Policy storage on ESP

The policy blob is stored on the ESP at `\EFI\PBL\policy.cose` (signed
COSE_Sign1). PBL reads this at boot. If the file is missing or the signature
is invalid, PBL fetches via C3 `GET /v1/policy/{version}` where `{version}`
is the NV counter value. If both fail, PBL enters DEGRADED (cannot evaluate
policy) — never BLOCK, because a missing policy is an availability issue,
not a security violation. The cached verdict (C2 §1.1) still governs the
lock decision.

### 4.2 Policy update flow

```
New CVE discovered
        │
        ▼
Orchestrator updates policy fields (e.g., add hash to dbx_expectations)
        │
        ▼
Bump version, sign with policy key (HSM)
        │
        ▼
Agent C publishes: GET /v1/policy/{new_version}
        │
        ▼
OS agent (Agent D) downloads new policy, writes to ESP \EFI\PBL\policy.cose
        │
        ▼
Next boot: PBL reads new policy, increments NV counter, applies
```

No PBL code change. No reflash. No re-signing of the PBL binary. This is the
"policy is data" principle in action.

---

## 5. PBL policy evaluation order (Agent A `Decision.c`)

PBL evaluates the policy checks in this order. Each check produces a result:
`PASS`, `DEGRADED`, or `BLOCK`. The final verdict is the worst result across
all checks, **except** that the server verdict (C1) can override DEGRADED →
LOCKED if the server says LOCKED.

```
1. Parse + verify policy blob signature (C4 §1)        → BLOCK on fail
2. Check policy.version >= NV counter (REQ-11)          → BLOCK on rollback
3. Check policy.expires_at > now                        → DEGRADED if expired
4. Check min_pbl_version <= self version                → DEGRADED if lower
5. REQ-01: PK allowlist + PKfail denylist               → BLOCK on fail
6. REQ-02: db/dbx expectations + bootmgr SVN            → BLOCK on fail
7. REQ-03: SPI protections (or unknown → DEGRADED)      → DEGRADED if unknown
8. REQ-04: firmware version floors + AMT + DCI          → DEGRADED on fail
9. REQ-05: TPM session requirements                     → BLOCK on fail
10. REQ-06: TPM firmware floors + PIN policy            → BLOCK on fail
11. REQ-07: S3 + DMA + MOR                              → BLOCK on fail
12. REQ-08: network boot policy                         → BLOCK on fail
13. REQ-09: BCD + winre.wim + BitLocker                 → BLOCK on fail
14. REQ-10: firmware recovery capability                → DEGRADED if none
15. Fetch verdict via C3 (or read cache)                → C1 §7
16. Combine: worst(policy_checks, server_verdict)
17. Extend PCR 13 (inputs) + PCR 12 (decision)          → C2 §4.1
18. PASS → chain-load; DEGRADED → notice + chain-load; BLOCK → lock screen
```

Steps 1–4 are policy-meta checks. Steps 5–14 are REQ checks. Step 15 is the
network/cache path. Step 16 combines — a server LOCKED verdict always wins
over a policy DEGRADED. Step 17 is the measurement (§0.3). Step 18 is the
action.

---

## 6. Agent C serving

Agent C serves the policy blob at `GET /v1/policy/{version}` (C1 §6). The
response is `Content-Type: application/cose` with the COSE_Sign1 body. Agent
C stores signed policy blobs in the database keyed by version. The latest
version is discoverable via `GET /v1/policy/latest` (returns a redirect or
the current version number).

Policy blobs are **immutable** once published — a version number is never
reused. To revoke a policy, publish a new version with the revoked fields
removed or adjusted. The NV counter (C2 §1.2) ensures old versions cannot
be re-applied.

---

## 7. Agent E fuzz targets

The policy blob parser is a primary fuzz target (charter §8):

| Target | Input | What to fuzz |
|--------|-------|--------------|
| `Policy.c::PblParsePolicy` | CBOR bytes | Malformed CBOR, missing keys, wrong types, oversized fields, nested structures |
| `Policy.c::PblVerifyPolicySig` | COSE_Sign1 bytes | Invalid signatures, wrong alg, unknown kid, truncated |
| `Cbor.c::PblCborDecode` | CBOR bytes | Generic CBOR decoder — all other parsers depend on this |

Corpus: valid policy blobs with field variations. CI runs libFuzzer/AFL++
with ASan/UBSan for 10k iterations per push. Crashes are gate failures.
