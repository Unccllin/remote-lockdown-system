# PBL Implementation Plan V2 — Low to High Complexity

> **Purpose**: Multi-session plan to close all 42 PBL debt items (D-100 through
> D-130 UEFI-side + D-200 through D-210 server-side), ordered from low to high
> complexity. Each session groups related debt items that share dependencies
> or code paths.
>
> **Source**: Grounded in the source-file survey (sess-036), the serverless
> Worker survey (sess-037), and the 4 frozen contract ADRs (C1–C4). Every
> item references the exact file, function, and contract section it implements.
>
> **Stateless architecture**: PBL is stateless across boots — all durable
> state is in TPM NV and the ESP policy blob. The serverless Worker signs
> independent, time-bounded verdicts per request. No session state, no HMAC
> API keys, no server-side boot tracking. The existing `/api/agent/checkin`
> model is incompatible with PBL and must not be reused.
>
> **Ordering principle**: Low-complexity items first (mechanical, well-defined,
> no crypto) → medium (protocol understanding, new code) → high (security-
> critical, crypto-heavy, contract-compliant). Server-side work is interleaved
> with UEFI-side work so that each side can be tested against the other.

---

## Session 1 — TPM PCR Reading (D-107, D-108)

**Goal**: Wire PCR reading end-to-end so PlatformState.c gets real PCR digests.

| Debt | File | Work |
|------|------|------|
| D-108 | `TpmClient.c:489` | Parse `TPM2_PCR_Read` response: skip header, read `TPM2B_DIGEST` values from `TPMS_PCR_READ` structure. Currently returns zeros at line 537. |
| D-107 | `PlatformState.c:350` | Replace the TODO at line 377 with calls to `PblTpmReadPcr()` for PCR 4, 5, 7, 11. Store digests in `PBL_PLATFORM_STATE.PcrValues[]`. |

**Dependencies**: None — both files exist and compile. `PblTpmReadPcr` already sends the command, just doesn't parse the response.

**Verification**: EDK II build passes. Trace reviewer passes. Response parsing verified by byte-level inspection of TPM2_PCR_Read response structure (TPM 2.0 Part 3 §22.4).

**Close criteria**: `PblCollectPcrReadings()` calls `PblTpmReadPcr()` for PCR 4/5/7/11 and stores non-zero digests (when TPM is present). `PblTpmReadPcr()` correctly parses `TPM2B_DIGEST` from the response.

---

## Session 2 — Secure Boot Fingerprinting (D-104, D-105)

**Goal**: Compute real SHA-256 fingerprints and parse signature lists.

| Debt | File | Work |
|------|------|------|
| D-104 | `PlatformState.c:122` | Replace TODO at line 140: call `Sha256HashAll()` from `BaseCryptLib` on PK, db, dbx variable data. Store 32-byte digests in `PBL_PLATFORM_STATE`. |
| D-105 | `PlatformState.c:152` | Replace TODOs at lines 164/175: parse `EFI_SIGNATURE_LIST` headers (GUID + signature type + signature size). Walk the list to identify known cert GUIDs (Microsoft UEFI CA 2011/2023). Store presence flags. |

**Dependencies**: `BaseCryptLib` is already in the DSC. `EFI_SIGNATURE_LIST` structure is in `IndustryStandard/SecureBoot.h` (or define locally).

**Verification**: EDK II build passes. SHA-256 digests are non-zero when PK/db/dbx variables exist. Signature list parsing handles empty lists and multi-entry lists.

**Close criteria**: PK/db/dbx SHA-256 digests computed and stored. `EFI_SIGNATURE_LIST` entries counted and known GUIDs identified.

---

## Session 3 — SMBIOS + ACPI Parsing (D-103, D-119)

**Goal**: Extract SMBIOS string fields and parse ACPI FADT for S3.

| Debt | File | Work |
|------|------|------|
| D-103 | `PlatformState.c:264` | Replace TODO at line 292: extract strings from SMBIOS string area (sequence of NUL-terminated strings indexed by 1-based numbers in the formatted area). Extract vendor (Type 0), product name (Type 1), manufacturer (Type 2), processor version (Type 4). |
| D-119 | `PlatformState.c:318` | Replace TODO at line 335: parse RSDP (find XSDT pointer), walk XSDT entries to find FADT (GUID `ACPI_6_TABLE_GUID` or signature "FACP"), read `IAPC_BOOT_ARCH` flags for S3 support bit. |

**Dependencies**: SMBIOS string extraction is pure pointer arithmetic. ACPI parsing requires reading the RSDP from `gST->ConfigurationTable` (already located at line 330).

**Verification**: EDK II build passes. SMBIOS strings are non-NULL when records exist. FADT S3 bit is read correctly.

**Close criteria**: SMBIOS Type 0/1/2/4 string fields populated. `S3Supported` flag set from FADT `IAPC_BOOT_ARCH` bit.

---

## Session 4 — Boot Order + BitLocker (D-106, D-120)

**Goal**: Detect network boot devices and BitLocker presence.

| Debt | File | Work |
|------|------|------|
| D-106 | `PlatformState.c:184` | Replace TODO at line 243: parse `EFI_DEVICE_PATH_PROTOCOL` from each `Boot####` variable. Identify network boot nodes: `MAC_ADDR_DEVICE_PATH` (Type 0x03 SubType 0x0B), `IPv4_DEVICE_PATH` (0x03/0x0C), `IPv6_DEVICE_PATH` (0x03/0x0D), `URI_DEVICE_PATH` (0x03/0x18). Set `NetworkBootEnabled` flag. |
| D-120 | `PlatformState.c:389` | Replace TODO at line 397: read BCD store from ESP, check for BitLocker recovery entries. Detect BitLocker presence from `\EFI\Microsoft\Boot\BCD` or BitLocker metadata files on the ESP. |

**Dependencies**: Device path parsing uses `EFI_DEVICE_PATH_PROTOCOL` from `MdePkg/Include/Protocol/DevicePath.h`. BCD parsing requires reading the ESP via `EFI_SIMPLE_FILE_SYSTEM_PROTOCOL`.

**Verification**: EDK II build passes. Network boot entries correctly identified. BitLocker detection handles both present and absent cases.

**Close criteria**: `NetworkBootEnabled` flag set from Boot#### device path parsing. `BitLockerEnabled` flag set from BCD/ESP inspection.

---

## Session 5 — Platform Security Checks (D-126, D-121, D-124)

**Goal**: Implement SVN check, SPI protections, and MOR.

| Debt | File | Work |
|------|------|------|
| D-126 | `Svn.c` (12 lines → ~40) | Implement `PblReadBootmgrSvn()`: read firmware version from SMBIOS Type 0 (already collected in `PBL_PLATFORM_STATE`). Return as a UINT32 SVN. |
| D-121 | `SpiProtections.c` (12 lines → ~60) | Implement `PblCheckSpiProtections()`: read SPI config registers via PCI config space (bus 0, device 31, function 5, offset 0xDC for BIOSWE/BLE/SMM_BWP). Store results in `PBL_PLATFORM_STATE`. |
| D-124 | `Mor.c` (12 lines → ~30) | Implement `PblRequestMor()`: set the `MemoryOverwriteRequestControl` UEFI variable (`gEfiMemoryOverwriteRequestControlGuid`) to 1. This triggers memory clear on next boot. |

**Dependencies**: SVN uses SMBIOS data already collected. SPI uses `EFI_PCI_ROOT_BRIDGE_IO_PROTOCOL` or direct PCI config access. MOR uses `gRT->SetVariable`.

**Verification**: EDK II build passes. SVN read from SMBIOS Type 0. SPI register bits read correctly. MOR variable set and readable.

**Close criteria**: `PblReadBootmgrSvn()` returns firmware version. `PblCheckSpiProtections()` reads BIOSWE/BLE/SMM_BWP. `PblRequestMor()` sets MOR variable.

---

## Session 6 — More Platform Checks (D-122, D-123, D-127, D-128)

**Goal**: Implement DCI, DMA, AMT, and SBAT checks.

| Debt | File | Work |
|------|------|------|
| D-122 | `DciCheck.c` (12 lines → ~40) | Implement `PblCheckDci()`: read DCI/DCP status via PCI config space (Intel debug port). Check if DCI is enabled (bit in PCI config or MSR). Mark as OEM-specific gap if not accessible. |
| D-123 | `DmaProtection.c` (12 lines → ~50) | Implement `PblCheckDmaProtection()`: find ACPI DMAR table in `gST->ConfigurationTable`. Check for VT-d enabled bit. Read PCI config for DMA remapping status. |
| D-127 | `AmtCheck.c` (12 lines → ~40) | Implement `PblCheckAmt()`: check for Intel AMT presence via MEI protocol or PCI config (bus 0, device 22, function 0). Mark as OEM-specific if not accessible. |
| D-128 | `Sbat.c` (12 lines → ~25) | Implement `PblGetSbatVersion()`: read `SbatLevel` variable from ESP. If not present, return 0 (SBAT is GRUB-specific, may be N/A for Windows-only boot). |

**Dependencies**: DCI/AMT are OEM-specific — document as known gaps per C4 §3.8. DMA uses ACPI DMAR table. SBAT reads from ESP.

**Verification**: EDK II build passes. All functions return meaningful values (not just EFI_UNSUPPORTED). OEM-specific gaps documented.

**Close criteria**: All 4 functions implemented with real logic. OEM-specific limitations noted in comments.

---

## Session 7 — TCG Event Log (D-125)

**Goal**: Log PBL events to the TCG event log.

| Debt | File | Work |
|------|------|------|
| D-125 | `TcgLog.c` (12 lines → ~80) | Implement `PblLogExtendEvent()`: call `EFI_TCG2_PROTOCOL->HashLogExtendEvent` with PBL event data. Use `gPblEventGuid` from `PblPkg.dec`. Implement `PblParseTcgLog()`: walk the TCG event log buffer to find PBL events. |

**Dependencies**: `EFI_TCG2_PROTOCOL` already located in TpmClient.c. `gPblEventGuid` declared in `PblPkg.dec`.

**Verification**: EDK II build passes. Event log extension produces a valid event log entry.

**Close criteria**: `PblLogExtendEvent()` calls `HashLogExtendEvent` with correct parameters. `PblParseTcgLog()` walks the event log and identifies PBL events.

---

## Session 8 — EFI_RNG Nonce (D-118)

**Goal**: Generate 32-byte nonces using `EFI_RNG_PROTOCOL`.

| Debt | File | Work |
|------|------|------|
| D-118 | `PblApp.c:122` | Replace STUB at line 122: locate `EFI_RNG_PROTOCOL` via `gBS->LocateProtocol(&gEfiRngProtocolGuid, ...)`. Call `GetRNG()` with `gEfiRngAlgorithmSp80090Ctr256Guid`. Verify 32 bytes returned. Use nonce in verdict request. |

**Dependencies**: `gEfiRngProtocolGuid` already in `PblApp.inf` protocols list. `EFI_RNG_PROTOCOL` is in `MdePkg/Include/Protocol/Rng.h`.

**Verification**: EDK II build passes. Nonce is 32 bytes and non-zero. If `EFI_RNG_PROTOCOL` is not available, fall back to `TPM2_GetRandom` or return error (no weak nonce allowed).

**Close criteria**: 32-byte nonce generated via `EFI_RNG_PROTOCOL`. Fallback to TPM2_GetRandom if RNG protocol unavailable. No zero nonce ever used.

---

## Session 9 — CBOR Encoding/Decoding (D-115)

**Goal**: Implement CBOR major type 0-7 encoding and decoding.

| Debt | File | Work |
|------|------|------|
| D-115 | `CborEncode.c` (12 lines → ~120) | Implement `PblCborEncodeVerdictRequest()`: encode a CBOR map with fields {device_id, nonce, policy_version, lock_state}. Use CBOR major type 5 (map) with unsigned integer keys. |
| D-115 | `CborDecode.c` (12 lines → ~200) | Implement `PblCborDecodeVerdict()`: decode COSE_Sign1 payload (CBOR map with verdict fields). Implement `PblCborDecodePolicy()`: decode COSE_Sign1 payload (CBOR map with ~40 policy fields). |

**Dependencies**: CBOR is specified in RFC 7049. No external library — implement from scratch (EDK II has no CBOR library). COSE_Sign1 is RFC 8152.

**Verification**: EDK II build passes. Round-trip test: encode a verdict request, decode it, verify fields match. Test against known CBOR test vectors from RFC 7049 Appendix A.

**Close criteria**: CBOR encode/decode handles major types 0-7, maps, arrays, byte strings, text strings. Verdict request encoding produces valid CBOR. Verdict and policy decoding extracts all required fields.

---

## Session 10 — Server-Side CBOR + COSE (D-207, D-208, D-205)

**Goal**: Build the server-side CBOR/COSE infrastructure that the Worker needs to communicate with PBL.

| Debt | File | Work |
|------|------|------|
| D-207 | `serverless/pbl/cbor.ts` (new) | Implement CBOR decoder for the Worker: parse major types 0-7, maps, arrays, byte strings, unsigned integers. Used to parse PBL's `POST /v1/verdict` request body. |
| D-208 | `serverless/pbl/cose.ts` (new) | Implement COSE_Sign1 encoder for the Worker: construct protected header `{1: alg, 4: kid}`, encode payload as CBOR map, compute `Sig_structure = ["Signature1", protected, external_aad'', payload]`, sign with Ed25519. Returns `Content-Type: application/cose`. |
| D-205 | `serverless/pbl/signing.ts` (new) | Generate Ed25519 signing key pair (using Web Crypto API `crypto.subtle.generateKey`). Create self-signed signing certificate for testing. Compute `kid = SHA-256(public key)`. Store signing key in Worker secret or KV. Document key rotation process (90-day certs chained to offline root). |

**Dependencies**: Session 9 (UEFI-side CBOR) defines the wire format. The server-side CBOR/COSE must produce/consume the same byte sequences. Web Crypto API is available in Cloudflare Workers.

**Verification**: `npm test` in `serverless/` passes. CBOR round-trip test: encode a verdict request with the UEFI encoder, decode it with the Worker decoder, verify fields match. COSE_Sign1 test: sign a payload with the Worker, verify with `BaseCryptLib` on the UEFI side (or a host-side test).

**Close criteria**: Worker can parse CBOR request bodies. Worker can produce valid COSE_Sign1 responses. Ed25519 signing key generated and stored. `kid` computed correctly.

---

## Session 11 — Server-Side Device Identity + Enrollment (D-206, D-202, D-210)

**Goal**: Build the PBL device enrollment and identity mapping in the serverless Worker.

| Debt | File | Work |
|------|------|------|
| D-206 | `serverless/pbl/devices.ts` (new) | Implement KV schema for `pbl_devices:{device_id}`. Store `{device_id, ek_cert, ak_public, ak_name, status, enrolled_at, hardware_uuid, hostname}`. Implement `getPblDevice(device_id)` and `updatePblDeviceStatus(device_id, status)`. Link PBL device to existing device record by `hardware_uuid` if available. |
| D-202 | `serverless/pbl/routes/enroll.ts` (new) | Implement `POST /v1/enroll`: accept CBOR body `{device_id, ek_cert, ak_public, smbios}`. Store in KV. Return success with pinned cert (`lock_service_cert_pin`) and current policy version. Use admin bearer auth for initial enrollment (PBL enrollment is done by an operator, not by the UEFI app itself). |
| D-210 | `serverless/worker.ts` (modify) | Add `/v1/*` route dispatch to the Worker's main `fetch` handler. Route `/v1/enroll` to the new enrollment handler. Keep existing `/api/*` routes unchanged. |

**Dependencies**: Session 10 (CBOR parsing) for reading the enrollment request. KV namespace `LOCKDOWN_KV` already exists.

**Verification**: `npm test` passes. Enrollment test: POST a CBOR enrollment body, verify KV has the device record. Device lookup test: GET device by `device_id`, verify correct status returned.

**Close criteria**: PBL device enrolled and stored in KV. Device status lookup by TPM-based `device_id` works. `/v1/*` routes dispatched correctly.

---

## Session 12 — Server-Side Verdict + Policy Endpoints (D-200, D-201, D-209)

**Goal**: Build the core PBL verdict and policy endpoints in the serverless Worker.

| Debt | File | Work |
|------|------|------|
| D-200 | `serverless/pbl/routes/verdict.ts` (new) | Implement `POST /v1/verdict`: parse CBOR request `{device_id, nonce, platform_state_digest, policy_version}`. Look up device status in KV. If `stolen`/`locked`, return `verdict=LOCKED` (1). If `active`/`recovering`, return `verdict=UNLOCKED` (0). If `wipe_deadline` expired, `verdict=WIPE_PENDING` (2). Build COSE_Sign1 payload with `{version, device_id, nonce, verdict, policy_version, issued_at, grace_until, reason}`. Sign with Ed25519. Return with `Content-Type: application/cose`. |
| D-201 | `serverless/pbl/routes/policy.ts` (new) | Implement `GET /v1/policy/{version}`: look up `pbl_policies:{version}` in KV. Return raw COSE_Sign1 bytes with `Content-Type: application/cose`. If version not found, return 404. Support `GET /v1/policy/latest` to return the highest version. |
| D-209 | `serverless/pbl/policy-gen.ts` (new) | Implement policy blob generator: build CBOR map with all ~40 C4 fields (Secure Boot, db/dbx, SPI, firmware floors, TPM, boot config, recovery, pins/endpoints, verdict cache, override). Sign with policy signing key (separate from verdict signing key). Store in KV as `pbl_policies:{version}`. |

**Dependencies**: Session 10 (CBOR/COSE), Session 11 (device identity). The verdict endpoint is the critical integration point between PBL and the server.

**Verification**: `npm test` passes. Verdict test: POST a verdict request, verify COSE_Sign1 response with correct fields. Policy test: GET a policy, verify COSE_Sign1 response. Test with locked device → verdict=1. Test with active device → verdict=0.

**Close criteria**: `POST /v1/verdict` returns signed COSE_Sign1 verdict. `GET /v1/policy/{version}` returns signed policy blob. Policy generator produces all ~40 fields.

---

## Session 13 — Server-Side Attestation + Override (D-203, D-204)

**Goal**: Build the attestation and override endpoints for full C1 compliance.

| Debt | File | Work |
|------|------|------|
| D-203 | `serverless/pbl/routes/attest.ts` (new) | Implement `POST /v1/attest`: accept TPM2_Quote (signed by AK). Verify quote signature using AK public key from enrollment record. Verify quoted PCRs match expected values. Return attestation result (success/failure + reason). |
| D-204 | `serverless/pbl/routes/override.ts` (new) | Implement `POST /v1/override/challenge`: generate a server-signed challenge bound to `device_id` (HMAC of device_id + timestamp + server secret). Return challenge as CBOR. Implement `POST /v1/override/response`: accept response code from operator. Verify HMAC-SHA256 of challenge with override key from policy. If valid, set device status to `recovering` and return unlock verdict. |

**Dependencies**: Session 12 (verdict endpoint for returning unlock verdict). TPM2_Quote verification requires the AK public key from enrollment (Session 11).

**Verification**: `npm test` passes. Attestation test: submit a valid TPM2_Quote, verify acceptance. Submit a tampered quote, verify rejection. Override test: request challenge, submit valid response, verify unlock verdict returned. Submit invalid response, verify rejection.

**Close criteria**: Attestation endpoint verifies TPM quotes. Override endpoints issue and verify challenges. Valid override returns unlock verdict.

---

## Session 14 — Lock Screen + Chain Load (D-112, D-114)

**Goal**: Render lock screen UI and chain-load Windows.

| Debt | File | Work |
|------|------|------|
| D-112 | `LockScreen.c` (29 lines → ~120) | Implement `PblShowLockScreen()`: clear screen via `EFI_SIMPLE_TEXT_OUTPUT_PROTOCOL`, set colors (red background), print device ID, contact info, and countdown timer. Implement `PblShowDegradedNotice()`: print reason and countdown. Optionally use `EFI_GRAPHICS_OUTPUT_PROTOCOL` for graphical mode. |
| D-114 | `ChainLoad.c` (16 lines → ~60) | Implement `PblChainLoadWindows()`: locate ESP via `gBS->HandleProtocol` for `EFI_SIMPLE_FILE_SYSTEM_PROTOCOL`. Open `\EFI\Microsoft\Boot\bootmgfw.efi`. Call `gBS->LoadImage()` and `gBS->StartImage()`. Handle missing file gracefully. |

**Dependencies**: Both protocols are in `PblApp.inf`. Lock screen uses `ConOut` (always available). Chain load needs ESP access.

**Verification**: EDK II build passes. Lock screen renders text in QEMU (if available). Chain load attempts to load bootmgfw.efi and returns appropriate status.

**Close criteria**: Lock screen displays device ID, contact info, and timer. Chain load locates and loads bootmgfw.efi, or returns `EFI_NOT_FOUND` if absent.

---

## Session 15 — Override Challenge/Response (D-113)

**Goal**: Implement offline override flow.

| Debt | File | Work |
|------|------|------|
| D-113 | `Override.c` (20 lines → ~100) | Implement `PblHandleOverride()`: display challenge (device ID + nonce from verdict). Accept response code via `EFI_SIMPLE_TEXT_INPUT_EX_PROTOCOL` (read keystrokes, build string). Verify response against server-issued override (HMAC-SHA256 of challenge with override key from policy). Set `*OverrideGranted = TRUE` if valid. |

**Dependencies**: `EFI_SIMPLE_TEXT_INPUT_EX_PROTOCOL` in `PblApp.inf`. Override key comes from C4 policy blob (requires D-110 to be done first, or use a test key).

**Verification**: EDK II build passes. Override flow displays challenge, accepts input, verifies response. Invalid responses are rejected.

**Close criteria**: Challenge displayed, response input works, verification logic correct. Invalid override codes rejected.

---

## Session 16 — TPM HMAC Sessions (D-102) — SECURITY CRITICAL

**Goal**: Replace `TPM_ST_NO_SESSIONS` with authenticated HMAC sessions.

| Debt | File | Work |
|------|------|------|
| D-102 | `TpmClient.c` (578 lines → ~800) | Implement `TPM2_StartAuthSession` (HMAC session + AES-256-CFB parameter encryption). Store session handle. Modify `PblTpmReadLockState`, `PblTpmWriteLockState`, `PblTpmReadPolicyVersion`, `PblTpmIncrementPolicyVersion`, `PblTpmReadAkName` to use `TPM_ST_SESSIONS` with the HMAC session. Add `TPM2_FlushContext` call before chain-load. Implement parameter encryption for NV write data. |

**Dependencies**: C2 §3 specifies the exact session attributes. AES-256-CFB is in `BaseCryptLib` (already linked). This is the most security-critical debt item.

**Verification**: EDK II build passes. All NV operations use `TPM_ST_SESSIONS`. Parameter encryption is active (verify by checking session attributes in command buffer). Unencrypted commands are rejected by the TPM (test in QEMU+swtpm if available).

**Close criteria**: All 5 NV operations use HMAC sessions with AES-256-CFB. Session is flushed before chain-load. No `TPM_ST_NO_SESSIONS` commands remain in the codebase.

---

## Session 17 — Policy Blob Parsing (D-110)

**Goal**: Parse and verify the C4 policy blob.

| Debt | File | Work |
|------|------|------|
| D-110 | `Policy.c` (45 lines → ~300) | Implement `PblParsePolicy()`: parse COSE_Sign1 envelope (RFC 8152), extract payload, call `PblCborDecodePolicy()` (from Session 9) to decode ~40 fields. Implement `PblVerifyPolicySignature()`: extract signature from COSE_Sign1, verify using `BaseCryptLib` ECDSA-256 with pinned public key from policy blob itself (bootstrapped from a known root key compiled into PBL). |

**Dependencies**: D-115 (CBOR decode) must be done first. COSE_Sign1 structure is defined in RFC 8152 §4.2. `BaseCryptLib` has ECDSA verify functions.

**Verification**: EDK II build passes. Test with a known-good policy blob signed with a test key. Test with a tampered blob (signature verification fails). Test with an expired policy version (anti-rollback check fails).

**Close criteria**: COSE_Sign1 parsed correctly. All ~40 policy fields extracted. Signature verification passes for valid blobs and fails for invalid ones. Anti-rollback check compares policy version against NV counter.

---

## Session 18 — Verdict Fetch + Verification (D-109)

**Goal**: Fetch verdict from server and verify it.

| Debt | File | Work |
|------|------|------|
| D-109 | `HttpsClient.c` (25 lines → ~200) | Implement `PblHttpsPost()`: configure `EFI_HTTP_PROTOCOL` with server URL from policy. Configure `EFI_TLS_PROTOCOL` with pinned CA from policy. Send POST request with CBOR-encoded body (from Session 9). Read response. Handle timeouts (2s connect, 3s total, 2 retries per C3 §3). Return `EFI_TIMEOUT` / `EFI_NO_RESPONSE` on failure so PBL falls back to cached verdict. |
| D-109 | `Verdict.c` (24 lines → ~150) | Implement `PblVerifyVerdict()`: perform C1 §7 9-step verification: (1) parse COSE_Sign1, (2) resolve `kid` to pinned cert, (3) verify signature, (4) check version, (5) check device binding, (6) check nonce echo, (7) check policy version, (8) check grace window, (9) check cache validity. |

**Dependencies**: D-115 (CBOR), D-118 (nonce), D-110 (policy for pinned cert), D-116 (TLS pin verification). This is the integration point for C1+C3.

**Verification**: EDK II build passes. Test with a valid verdict (all 9 steps pass). Test with each step failing (wrong nonce, wrong device, expired grace, wrong version, bad signature).

**Close criteria**: HTTPS POST sends request and receives response. C1 §7 9-step verification implemented. All failure modes return appropriate `EFI_*` status.

---

## Session 19 — TLS Certificate Pin Verification (D-116) — SECURITY CRITICAL

**Goal**: Verify TLS server certificate against pinned CA.

| Debt | File | Work |
|------|------|------|
| D-116 | `TlsVerify.c` (12 lines → ~100) | Implement `PblTlsVerifyCert()`: extract pinned CA certificate from C4 policy blob. Configure `EFI_TLS_CONFIGURATION_PROTOCOL` with the pinned CA. During TLS handshake, verify the server certificate chain terminates at the pinned CA. Reject if chain is invalid or doesn't match the pin. |

**Dependencies**: D-110 (policy parsing for pinned CA). `EFI_TLS_CONFIGURATION_PROTOCOL` in `PblApp.inf`. `BaseCryptLib` for X.509 parsing.

**Verification**: EDK II build passes. TLS handshake succeeds with pinned CA. Handshake fails with wrong CA. Handshake fails with self-signed cert not in pin.

**Close criteria**: Certificate pin extracted from policy. TLS handshake verifies against pin. Non-pinned certificates rejected.

---

## Session 20 — Decision Engine (D-111)

**Goal**: Implement the C4 §5 18-step evaluation.

| Debt | File | Work |
|------|------|------|
| D-111 | `Decision.c` (21 lines → ~250) | Implement `PblEvaluateDecision()`: perform C4 §5 18-step evaluation: (1-6) Secure Boot state checks, (7-10) db/dbx checks, (11) SPI protections, (12) firmware SVN, (13) TPM state, (14) boot config, (15) BitLocker, (16) network boot, (17) server verdict, (18) override. Final result is the worst of policy checks and server verdict. Return `PblResultPass`, `PblResultLock`, or `PblResultDegraded`. |

**Dependencies**: All platform-state collection (Sessions 1-7), policy parsing (Session 13), verdict verification (Session 14). This is the integration point for all upstream data.

**Verification**: EDK II build passes. Test with: all-pass state → `PblResultPass`. Locked verdict → `PblResultLock`. Missing TPM → `PblResultDegraded`. Network boot enabled + policy forbids → `PblResultLock`.

**Close criteria**: All 18 evaluation steps implemented. Returns correct `PBL_RESULT` for each scenario. No unconditional `PblResultPass`.

---

## Session 21 — Wire PblApp.c Main Flow

**Goal**: Connect all implemented modules into the main application flow.

| Debt | File | Work |
|------|------|------|
| — | `PblApp.c` (190 lines → ~300) | Replace all STUB comments with real calls: (1) read policy from ESP or fetch via C3, (2) generate nonce via EFI_RNG, (3) encode CBOR request, (4) call `PblHttpsPost`, (5) call `PblVerifyVerdict`, (6) call `PblEvaluateDecision`, (7) extend PCR with decision, (8) show lock screen / degraded notice / chain-load based on result. Handle cached verdict fallback on network failure. |

**Dependencies**: All Sessions 1-16 must be complete. This is the final integration.

**Verification**: EDK II build passes. Full PBL flow executes: collect state → read policy → fetch verdict → verify → decide → act. Trace reviewer passes.

**Close criteria**: No STUB comments remain in PblApp.c. All steps call real implementations. Cached verdict fallback works on network failure.

---

## Session 22 — QEMU + swtpm Environment (D-100, D-101)

**Goal**: Install QEMU and swtpm for local smoke testing.

| Debt | Work |
|------|------|
| D-100 | Install `qemu-system-x86_64` via `sudo apt install qemu-system-x86`. Verify OVMF boots. |
| D-101 | Install `swtpm` via `sudo apt install swtpm swtpm-tools`. Configure QEMU to use swtpm as the TPM 2.0 backend. |

**Dependencies**: None (environment setup). OVMF firmware already built at `~/.local/src/edk2/Build/OvmfX64/RELEASE_GCC/FV/OVMF_CODE.fd`.

**Verification**: QEMU boots OVMF with swtpm. PblApp.efi loads and prints banner. TPM commands execute (lock-state read, PCR read).

**Close criteria**: QEMU+swtpm boot produces a serial log showing PBL banner and TPM initialization.

---

## Session 23 — Runtime Tests (D-117)

**Goal**: Add host-side unit tests for PBL modules.

| Debt | Work |
|------|------|
| D-117 | Create `firmware/PblPkg/Tests/` directory. Write host-side tests (compiled with host GCC, not EDK II) for: TPM command buffer construction (byte-level verification), CBOR encode/decode round-trip, COSE_Sign1 parsing, decision engine scenarios. Write QEMU+swtpm integration tests for: TPM NV read/write, PCR read, full PBL boot flow. |

**Dependencies**: D-100/D-101 (QEMU+swtpm) for integration tests. All implementation sessions for unit tests.

**Verification**: Unit tests pass. Integration tests produce run artifacts (serial logs).

**Close criteria**: Unit tests cover TPM commands, CBOR, COSE, decision engine. Integration tests cover TPM NV, PCR, full boot flow.

---

## Session 24 — Code Signing (D-130) — SECURITY CRITICAL

**Goal**: Sign PblApp.efi for Secure Boot.

| Debt | Work |
|------|------|
| D-130 | Generate a self-signed code signing certificate for testing. Sign `PblApp.efi` using `sbsign` (or `pesign`). Enroll the test certificate in the PK/db variables in OVMF. Verify PblApp.efi loads under Secure Boot in QEMU. |

**Dependencies**: D-100 (QEMU installed). `sbsign` tool (`sudo apt install sbsigntool`).

**Verification**: Signed PblApp.efi loads under Secure Boot in QEMU. Unsigned PblApp.efi is rejected.

**Close criteria**: PblApp.efi signed. Secure Boot enrollment works. Signed binary loads in QEMU with Secure Boot enabled.

---

## Session 25 — Real Hardware Validation (D-129)

**Goal**: Boot PBL on real UEFI hardware.

| Debt | Work |
|------|------|
| D-129 | Flash signed PblApp.efi to a real UEFI machine (or a real UEFI VM with swtpm). Enroll the signing certificate in the machine's PK/db. Boot and capture serial/log output showing the full PBL boot flow. Record as a hardware artifact. |

**Dependencies**: D-130 (code signing). Real UEFI hardware or a real UEFI VM.

**Verification**: Serial log shows PBL banner, platform state collection, TPM initialization, verdict fetch (or cached fallback), decision evaluation, and chain-load (or lock screen).

**Close criteria**: PBL boots on real hardware. Full flow captured in serial log. Hardware artifact recorded in trace.md.

---

## Dependency Graph

```
UEFI-Side (firmware/PblPkg/PblApp/)          Server-Side (serverless/pbl/)
══════════════════════════════════════       ═══════════════════════════════════

Session 1 (PCR) ────────────────────┐
Session 2 (Secure Boot) ────────────┤
Session 3 (SMBIOS+ACPI) ────────────┤
Session 4 (Boot+BitLocker) ─────────┤
Session 5 (SVN+SPI+MOR) ────────────┤
Session 6 (DCI+DMA+AMT+SBAT) ───────┤
Session 7 (TCG Log) ────────────────┤
Session 8 (RNG Nonce) ──────────────┤
                                     │
Session 9 (UEFI CBOR) ──────┐        │
                             │        │
                             ▼        │
              Session 10 (Server CBOR+COSE+Signing) ◄──┘
                             │
                             ▼
              Session 11 (Server Device+Enroll+Routes)
                             │
                             ▼
              Session 12 (Server Verdict+Policy)
                             │
                             ▼
              Session 13 (Server Attest+Override)
                             │
Session 14 (LockScreen+ChainLoad) ──────────────────┐
Session 15 (Override) ───────────────────────────────┤
Session 16 (TPM HMAC) ───────────────────────────────┤
Session 17 (UEFI Policy Parse) ◄── Session 9 + 12   ┤
Session 18 (UEFI Verdict Fetch) ◄── Session 9 + 12  ┤
Session 19 (TLS Pin) ◄── Session 17                 ┤
                                                     │
Session 20 (Decision Engine) ◄── ALL ABOVE ─────────┤
                                                     │
Session 21 (Wire Main Flow) ◄── Session 20 ─────────┘
                                                     │
                                                     ▼
Session 22 (QEMU+swtpm) ──────────────────► Session 23 (Tests)
                                                     │
                                                     ▼
Session 24 (Code Signing) ─────────────────► Session 25 (Hardware)
```

**Sessions 1-8 are independent** (UEFI-side platform state) and can be done in any order or in parallel.

**Sessions 9-13 are the server-side chain**: CBOR (S9 UEFI + S10 server) → Device/Enroll (S11) → Verdict/Policy (S12) → Attest/Override (S13). The server-side work must be done before UEFI-side verdict fetch (S18) can be tested end-to-end.

**Sessions 14-19 are UEFI-side integration** that depends on both the platform state (S1-8) and the server-side endpoints (S10-13).

**Session 20 (Decision Engine)** integrates all upstream data. **Session 21 (Wire Main Flow)** is the final UEFI integration.

**Sessions 22-25 are verification/deployment**: QEMU, tests, signing, hardware.

---

## Summary

| Session | Debt Items | Side | Complexity | Est. Lines |
|---------|-----------|------|------------|------------|
| 1 | D-107, D-108 | UEFI | Low | ~60 |
| 2 | D-104, D-105 | UEFI | Low | ~80 |
| 3 | D-103, D-119 | UEFI | Low | ~100 |
| 4 | D-106, D-120 | UEFI | Low-Medium | ~120 |
| 5 | D-126, D-121, D-124 | UEFI | Medium | ~130 |
| 6 | D-122, D-123, D-127, D-128 | UEFI | Medium | ~155 |
| 7 | D-125 | UEFI | Medium | ~80 |
| 8 | D-118 | UEFI | Medium | ~40 |
| 9 | D-115 | UEFI | Medium-High | ~320 |
| 10 | D-207, D-208, D-205 | Server | Medium-High | ~300 |
| 11 | D-206, D-202, D-210 | Server | Medium | ~200 |
| 12 | D-200, D-201, D-209 | Server | **High** | ~350 |
| 13 | D-203, D-204 | Server | Medium | ~150 |
| 14 | D-112, D-114 | UEFI | Medium | ~180 |
| 15 | D-113 | UEFI | Medium | ~100 |
| 16 | D-102 | UEFI | **High (SECURITY)** | ~220 |
| 17 | D-110 | UEFI | **High** | ~255 |
| 18 | D-109 | UEFI | **High** | ~350 |
| 19 | D-116 | UEFI | **High (SECURITY)** | ~100 |
| 20 | D-111 | UEFI | **High** | ~230 |
| 21 | — (wire main flow) | UEFI | **High** | ~110 |
| 22 | D-100, D-101 | ENV | ENV | ~0 (apt install) |
| 23 | D-117 | TEST | TEST | ~400 |
| 24 | D-130 | ENV | **High (SECURITY)** | ~0 (signing) |
| 25 | D-129 | ENV | ENV | ~0 (hardware) |

**Total**: 25 sessions, 42 debt items, ~3,550 lines of new/changed code (UEFI + server).
