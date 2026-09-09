# C3 — Network Client API

> **Status:** FROZEN (Day 0). Agents A and B code against this. Agent E
> writes fault-injection tests against it.
> **Owner:** Agent B (implements `PblHttpsPost`); Agent A (calls it from
> PBL's verdict fetch path); Agent E (negative tests).
> **References:** PBL-IMPLEMENTATION-PLAN.md §3, §4 REQ-13; UEFI 2.10
> §27 (HTTP), §27.8 (TLS), §27.6 (DHCPv4/v6).

---

## 1. Function signature

```c
/**
  Perform an HTTPS POST request from the UEFI pre-boot environment.

  @param[in]  uri       Null-terminated ASCII URI. Must be "https://" only.
                        Plaintext "http://" is rejected unconditionally.
  @param[in]  body      Request body bytes (CBOR-encoded verdict request).
  @param[in]  body_len  Length of body in bytes. Must be ≤ 4096.
  @param[out] resp      On success, points to an allocated buffer containing
                        the response body (COSE_Sign1 LockVerdict, C1).
                        Caller MUST free with gBS->FreePool.
  @param[out] resp_len  On success, length of resp in bytes.

  @retval EFI_SUCCESS             Response received and body returned.
  @retval EFI_TIMEOUT             Connect or total timeout exceeded after
                                  retries. PBL falls back to cached verdict.
  @retval EFI_NO_MEDIA            No network link detected. PBL falls back
                                  to cached verdict.
  @retval EFI_NOT_FOUND           DNS resolution failed. PBL falls back.
  @retval EFI_SECURITY_VIOLATION  TLS handshake or certificate verification
                                  failed. PBL falls back (never to UNLOCKED).
  @retval EFI_BAD_BUFFER_SIZE     Response body exceeded 4 KiB. PBL falls back.
  @retval EFI_INVALID_PARAMETER   uri/body/resp/resp_len is NULL, or uri is
                                  not "https://".
  @retval EFI_OUT_OF_RESOURCES    Allocation failed. PBL falls back.
  @retval EFI_DEVICE_ERROR        Lower-layer network error not classified above.

  @note No allocation is performed after ExitBootServices. PBL never calls
        ExitBootServices (it chain-loads bootmgfw.efi which does), but this
        constraint keeps the code auditable and prevents late-allocation bugs.
**/
EFI_STATUS
EFIAPI
PblHttpsPost (
  IN  CONST CHAR8   *uri,
  IN  CONST UINT8   *body,
  IN  UINTN          body_len,
  OUT UINT8         **resp,
  OUT UINTN         *resp_len
  );
```

---

## 2. Protocol stack (UEFI-native, no iPXE)

```
PblHttpsPost
    │
    ▼
EFI_HTTP_PROTOCOL (UEFI 2.10 §27.4) — HTTP/1.1 POST
    │
    ▼
EFI_TLS_PROTOCOL + EFI_TLS_CONFIGURATION_PROTOCOL (§27.8) — TLS 1.2 min, 1.3 preferred
    │
    ▼
EFI_TCP4_PROTOCOL / EFI_TCP6_PROTOCOL (§27.3)
    │
    ▼
EFI_IP4_CONFIG2_PROTOCOL / EFI_IP6_CONFIG_PROTOCOL (§27.2) — DHCPv4/v6
    │
    ▼
EFI_DHCP4_PROTOCOL / EFI_DHCP6_PROTOCOL (§27.5)
    │
    ▼
EFI_MANAGED_NETWORK_PROTOCOL (§27.1) — NIC binding
```

**No iPXE.** iPXE as a chain-loaded ROM adds a second signed pre-OS component
and a second attack surface. PBL is not a network boot mechanism — it makes
one HTTPS POST per boot (or zero, if cached verdict is valid).

**CryptoPkg/mbedTLS fallback:** where OEM firmware lacks `EFI_TLS_PROTOCOL`
(documented per-OEM in `firmware/PblPkg/docs/oem-tls-matrix.md`), Agent B
implements TLS via CryptoPkg/mbedTLS over `EFI_TCP4/6`. This is a fallback,
not the primary path. The fallback must still enforce all §4 TLS requirements.

---

## 3. Request format

### 3.1 HTTP request

```
POST <path> HTTP/1.1
Host: <hostname from uri>
Content-Type: application/cbor
Content-Length: <body_len>
Connection: close

<CBOR body>
```

`Connection: close` — PBL does not keep-alive. One request, one response,
then the network stack is torn down before chain-loading Windows.

### 3.2 Request body (CBOR)

The body is a CBOR map sent to `POST /v1/verdict` (C1 §6):

```
{
  1: device_id,          // bstr(32) — SHA-256(AK public Area), from C2 §1.3
  2: nonce,              // bstr(32) — from EFI_RNG_PROTOCOL (§5 below)
  3: platform_state_digest, // bstr(32) — SHA-256 of platform state (C2 §5.1 step 6)
  4: policy_version      // uint — current policy version from C4
}
```

### 3.3 Response body

The response is a COSE_Sign1 LockVerdict (C1), `Content-Type: application/cose`.
`PblHttpsPost` returns the raw bytes in `*resp`; Agent A's `Verdict.c`
parses and verifies the COSE structure. **C3 does not parse the verdict** —
separation of concerns: C3 is transport, C1 is verdict semantics.

---

## 4. TLS requirements

| Requirement | Value | Enforcement |
|-------------|-------|-------------|
| Minimum TLS version | TLS 1.2 | Reject TLS 1.0/1.1 in handshake |
| Preferred TLS version | TLS 1.3 | Use if firmware stack supports it |
| Certificate pinning | Lock-service CA pinned in C4 `tls_ca_pin` | Do NOT trust platform `TlsCaCertificate` store alone |
| Hostname verification | Required | Reject if CN/SAN does not match uri hostname |
| Plaintext fallback | **Never** | `http://` URIs rejected with `EFI_INVALID_PARAMETER` |
| Verification failure | Fail to cached verdict | Return `EFI_SECURITY_VIOLATION`, never `EFI_SUCCESS` with UNLOCKED |
| Cipher suites | TLS 1.2: ECDHE-ECDSA-AES256-GCM-SHA384, ECDHE-RSA-AES256-GCM-SHA384. TLS 1.3: TLS_AES_256_GCM_SHA384 | Reject NULL/anon/export ciphers |

### 4.1 Certificate pinning detail

The lock-service CA certificate is pinned in C4 `tls_ca_pin` as a DER-encoded
certificate or SHA-256 fingerprint. `PblHttpsPost` validates the server's
certificate chain up to the pinned CA. If the platform `TlsCaCertificate`
UEFI variable contains additional CAs, they are **ignored** for verdict
requests — only the C4 pin is trusted. This prevents a T2 attacker who has
admin on the OS from injecting their own CA into `TlsCaCertificate` and
MITM-ing the verdict request.

---

## 5. Nonce generation

The nonce (C1 §2 key 3) is generated by PBL (Agent A) and passed to
`PblHttpsPost` inside the request body. The nonce source:

1. **Primary:** `EFI_RNG_PROTOCOL->GetRNG()` — UEFI 2.10 §38.2. Algorithm:
   `EFI_RNG_ALGORITHM_RAW` if available, else `EFI_RNG_ALGORITHM_SHA256`.
2. **Fallback:** `TPM2_GetRandom(32)` via C2's TpmClient. This is a TPM
   command, so it uses the HMAC session from C2 §3.
3. **Never:** timestamp (`AsmReadTsc`), MAC-derived, or hardcoded. Agent E
   tests that a timestamp-derived nonce is rejected.

The nonce is 32 bytes. It is included in the CBOR request body (§3.2 key 2)
and must be echoed in the COSE_Sign1 response (C1 §2 key 3). PBL verifies
the echo (C1 §7 step 6).

---

## 6. Timeout and retry semantics

| Parameter | Value | Notes |
|-----------|-------|-------|
| Connect timeout | 2 seconds | From `EFI_TCP4/6` connect attempt to established. |
| Total timeout | 3 seconds | From `PblHttpsPost` entry to response complete. |
| Retries | 2 | With jitter: 200ms ± 50ms, 400ms ± 100ms. |
| DNS timeout | 1 second | Per DNS query. |
| TLS handshake timeout | 1 second | Included in total. |

After 2 retries fail, `PblHttpsPost` returns `EFI_TIMEOUT` (or
`EFI_NO_MEDIA` / `EFI_NOT_FOUND` / `EFI_SECURITY_VIOLATION` depending on
the failure mode). **PBL never blocks longer than ~7 seconds total** (3s ×
2 retries + jitter). This is within the ≤ 3s cached / ≤ 3s+network online
runtime budget (charter §4 Agent A constraints).

### 6.1 Failure → fallback mapping

| `PblHttpsPost` return | PBL action |
|------------------------|------------|
| `EFI_SUCCESS` | Parse verdict (C1 §7), cache in TPM NV (C2 §5.2), act. |
| `EFI_TIMEOUT` | Read cached verdict from TPM NV (C2 §5.1 step 4). If valid (now < grace_until), honour it. If stale, denied-boot-with-local-unlock. |
| `EFI_NO_MEDIA` | Same as `EFI_TIMEOUT`. |
| `EFI_NOT_FOUND` | Same as `EFI_TIMEOUT`. |
| `EFI_SECURITY_VIOLATION` | Same as `EFI_TIMEOUT`. **Never** fall back to UNLOCKED on a security violation — the cached verdict may be LOCKED. |
| `EFI_BAD_BUFFER_SIZE` | Same as `EFI_TIMEOUT`. Response > 4 KiB is a DoS signal. |
| `EFI_OUT_OF_RESOURCES` | Same as `EFI_TIMEOUT`. |
| `EFI_INVALID_PARAMETER` | Programming error — PBL should never produce this. If it does, BLOCK (fail-closed on data). |

**Critical invariant:** the fallback on ANY non-SUCCESS return is to the
**cached verdict**, never to a default UNLOCKED. If there is no cached
verdict (first boot, or NV was cleared), PBL enters denied-boot-with-local-
unlock, not UNLOCKED. This is the §0.2 fail-open-on-availability /
fail-closed-on-data property: the machine is not bricked (local unlock UI
is available) but data is not accessible (BitLocker does not release VMK
without the PCR+NV policy being satisfied).

---

## 7. Network interface selection

1. **Wired NIC first.** PBL iterates handles with `EFI_MANAGED_NETWORK_PROTOCOL`
   and prefers wired (non-wireless) interfaces. Most enterprise machines are
   wired-only pre-boot — this is the expected path.
2. **Wi-Fi via `EFI_WIRELESS_MAC_CONNECTION_II_PROTOCOL`** only where the OEM
   provides it. Agent B documents the per-OEM Wi-Fi support matrix. This is a
   **known coverage gap** to surface to the customer, not something to fake.
3. **No PXE / HTTP-boot.** PBL does not use `EFI_LOAD_FILE_PROTOCOL` or
   network boot. It makes a single HTTPS POST to a known URI from C4.

---

## 8. Memory and allocation rules

- All allocations via `gBS->AllocatePool` / `gBS->AllocatePages`. No custom
  allocator.
- `*resp` is allocated by `PblHttpsPost`; caller (Agent A) frees with
  `gBS->FreePool(*resp)` after `Verdict.c` is done parsing.
- No allocation after `ExitBootServices` (constraint from charter §5; PBL
  never reaches ExitBootServices, but the rule keeps the code auditable).
- Maximum response body: 4 KiB. If the server sends more, truncate and
  return `EFI_BAD_BUFFER_SIZE`. This is a DoS guard — a legit LockVerdict is
  ≤ 512 bytes (C1 §2.2).
- All network buffers are freed before returning, except `*resp` on success.

---

## 9. Agent B deliverables

```
firmware/PblPkg/PblApp/
  HttpsClient.c    # PblHttpsPost implementation (EFI_HTTP + EFI_TLS)
  HttpsClient.h    # public signature (this contract)
  TlsVerify.c      # certificate pinning + hostname verification
  TlsVerify.h
  CborEncode.c     # CBOR request body encoder (§3.2)
  CborEncode.h

firmware/PblPkg/docs/
  oem-tls-matrix.md  # per-OEM EFI_TLS_PROTOCOL availability + fallback usage
```

Agent B also ships a **mock server** for CI and Agent A development:

```
server/pbl-mock/
  mock-server.js   # Express mock: /v1/verdict returns a signed test verdict
  fault-inject.js  # fault injection modes (see §10)
  docker-compose.yml # local mock for Agent A + Agent B CI
```

---

## 10. Agent E fault-injection tests

The mock server (`fault-inject.js`) supports these modes, one per test:

| Mode | Behavior | Expected `PblHttpsPost` return |
|------|----------|-------------------------------|
| `normal` | Returns valid signed verdict | `EFI_SUCCESS` |
| `no_dhcp` | DHCP server does not respond | `EFI_NO_MEDIA` or `EFI_TIMEOUT` |
| `no_link` | NIC reports no link | `EFI_NO_MEDIA` |
| `dns_fail` | DNS returns NXDOMAIN | `EFI_NOT_FOUND` |
| `tls_cert_mismatch` | Server presents cert from wrong CA | `EFI_SECURITY_VIOLATION` |
| `tls_expired` | Server cert expired | `EFI_SECURITY_VIOLATION` |
| `tls_plaintext` | Server attempts plaintext HTTP | `EFI_SECURITY_VIOLATION` (or `EFI_TIMEOUT` if PBL refuses to connect) |
| `verdict_replay` | Returns a valid verdict but with wrong nonce | `EFI_SUCCESS` (transport OK) — Agent A's `Verdict.c` rejects (C1 §7 step 6) |
| `verdict_other_device` | Valid verdict for a different device_id | `EFI_SUCCESS` — Agent A rejects (C1 §7 step 5) |
| `truncated_response` | Sends 100 bytes then closes | `EFI_DEVICE_ERROR` or `EFI_TIMEOUT` |
| `oversized_response` | Sends 10 MB | `EFI_BAD_BUFFER_SIZE` |
| `slow_loris` | Sends 1 byte/sec | `EFI_TIMEOUT` (total timeout hits) |
| `expired_verdict` | Returns validly-signed verdict with `issued_at` in the past beyond grace | `EFI_SUCCESS` — Agent A rejects (C1 §7 step 8) |

C3 is responsible only for transport-level failures (rows 1–6, 10–12).
Verdict-level failures (rows 7–9, 13) return `EFI_SUCCESS` from C3 and are
rejected by Agent A's `Verdict.c` per C1 §7. This separation is tested by
Agent E in the chain audit.
