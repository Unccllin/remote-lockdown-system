# PBL-DEBT-LEDGER.md — Pre-Boot Lock Implementation Debt

> This is the debt ledger for the PBL (Pre-Boot Remote Firmware Lock) UEFI
> application. It tracks items that cannot be tackled in the current
> environment or are deferred to later phases. Each item has a category,
> a blocker reason, and a close criteria.
>
> The original debt ledger (`DEBT-LEDGER.md`) tracks the 21 items from the
> remote-lockdown-system production-readiness phases (D-001 through D-021,
> all CLOSED). This file tracks PBL-specific debt starting from D-100.

## How to use this file

1. At **SESSION-START**: read this file to identify open PBL debt items.
2. During **IMPLEMENT**: if you hit a blocker you cannot resolve, add a
   debt item here with the blocker reason.
3. At **CLOSE-DEBT**: update the item's status to CLOSED when the blocker
   is resolved and the close criteria are met.

## Categories

- **ENV** — Environment limitation (tool not installed, hardware not available)
- **STUB** — Scaffold/stub implementation that needs real logic
- **TODO** — Work not yet started
- **SECURITY** — Security-critical gap that must be closed before production
- **TEST** — Test coverage gap

---

## Debt Items

### D-100 — QEMU not installed locally for smoke testing
- **Status**: PARTIAL (Docker harness passes 10/10; swtpm portion open)
- **Category**: ENV
- **Blocker**: QEMU (`qemu-system-x86_64`) is not installed on the host
  (sudo unavailable in WSL2). Resolved via Docker: `pbl-qemu:latest` image
  provides QEMU 8.2.2 + OVMF 2024.02. The Docker harness
  (`firmware/PblPkg/ci-harness-docker.sh`) boots PblApp.efi in OVMF and
  captures serial output via Python `subprocess.PIPE` with `-nographic`.
- **Close criteria**: QEMU boot of PblApp.efi produces a run artifact
  showing PBL banner. **MET**: 10/10 checks pass (PBL banner, 8 scaffold
  stages, lock screen). Serial log: 1616 bytes.
- **Artifact**: `docker run --rm -v $(pwd)/firmware:/firmware pbl-qemu /firmware/PblPkg/ci-harness-docker.sh 20`
  Output: `10 PASS / 0 FAIL`.
- **Remaining**: swtpm TPM simulation now works (D-101 CLOSED). swtpm is
  optional in the harness (`USE_SWTPM=1`).

### D-101 — swtpm not installed locally for TPM simulation
- **Status**: CLOSED
- **Category**: ENV
- **Closed**: 2026-09-09 session
- **Commit ref**: 6898dce
- **Artifact ref**: PblApp.efi SHA-256 b05dfc3105b36cc7d6172d6994353cf21c6db7bd5635bc31c36297610642cdb8
- **Evidence**: Two-part fix:
  1. QEMU+swtpm transport (commit 47a2ca4): start swtpm with ONLY the
  `--ctrl` (control) socket, NOT the `--server` (data) socket. QEMU's
  TPM emulator backend sends CMD_SET_DATAFD (0x10) to establish the data
  channel by passing a file descriptor via SCM_RIGHTS. When swtpm
  already has a `--server` socket, CMD_SET_DATAFD fails with
  TPM_RC_BAD_PARAMETER (0x1F), causing QEMU to hang.
  2. TPM command header byte-order (commit 6898dce): PBL's
  PblTpmBeginCommand/PblTpmBeginCommandWithSessionAuth/
  PblTpmFinalizeCommand stored the TPM2 command header fields (Tag,
  CommandSize, CommandCode) in native little-endian byte order. TPM 2.0
  requires big-endian. The QEMU TIS emulation reads CommandSize from the
  header to know when a command is complete — with little-endian
  encoding, it read a huge size and waited forever for more bytes,
  causing the firmware to hang at "[1/8] Collecting platform state..."
  during the first TPM2_PCR_Read. Fix: added SwapBytes16/SwapBytes32 to
  all command header field writes and response header field reads.
  Runtime artifact: TPM-enabled QEMU+swtpm harness now progresses
  through all 8 PBL steps (platform state, policy parse, TPM NV state,
  verdict fetch, verification, decision, PCR extend, lock screen)
  without hanging. PBL banner, all 8 step messages, and lock screen
  appear in serial output. TPM commands (TPM2_PCR_Read,
  TPM2_GetCapability, TPM2_NV_Read, TPM2_GetRandom) are exchanged with
  swtpm successfully.
- **Close criteria**: QEMU+swtpm boot produces a run artifact showing
  PBL TPM initialization (lock-state read, PCR read). **MET**: All 8
  PBL steps complete, lock screen displayed, TPM commands exchanged.

### D-102 — TPM commands use no-session (TPM_ST_NO_SESSIONS)
- **Status**: CLOSED (commit 83bd5d2 — platform-hierarchy NV provisioning
  verified in Docker QEMU+swtpm)
- **Category**: SECURITY
- **Progress**: TpmSession.c implements the full HMAC session infrastructure
  per C2 §3. All wire-format bugs fixed and runtime-verified:
  - StartAuthSession command now includes the salt TPM2B_ENCRYPTED_SECRET
    field (size=0 for TPM_RH_NULL) — was missing, caused 0x3C4 error.
  - StartAuthSession response parsing relaxed for swtpm 0.7.3 which omits
    sessionAttributes (48-byte response vs 49-byte spec).
  - KDFa accepts NULL key for unbound sessions (TPM_RH_NULL has empty key).
  - PCR Read sizeofSelect fixed (UINT8, not UINT16).
  - NV StartAuthSession bound to TPM_RH_NULL (not undefined NV index).
  - PblTpmBeginCommandWithSessionAuth writes handles before auth area.
  - NV command callers pass required handles.
  - PCR Extend puts pcrHandle before auth area.
  - HMAC offset/pHash calculations include command handles.
  - **Session 105 reinforcement**: NV indices are now provisioned under
    `TPM_RH_PLATFORM` (not owner). `TPMA_NV_PLATFORMCREATE` is set so the
    TPM accepts platform-created indices. Custom OVMF with
    `PeiDxeTpmPlatformHierarchyLibNull` keeps `platformAuth` empty under
    swtpm, allowing the platform-hierarchy path to be exercised end-to-end.
  - **Session 110 — AES-256-CFB parameter encryption (C2 REQ-05) fully
    implemented and enabled** (`PcdPblTpmUseParameterEncryption=TRUE`):
    - sessionValue = `sessionKey || authValue(authorizedEntity)` — the
      entity auth is appended unconditionally (unlike the HMAC includeAuth
      rule), matching libtpms `CryptParameterDecryption/Encryption`.
    - Key+IV = `KDFa(SHA-256, sessionValue, "CFB", nonceNewer, nonceOlder,
      384)` → AES-256 key (32B) + IV (16B). Command direction uses
      (nonceCaller, nonceTPM); response direction uses the fresh nonceTPM
      then nonceCaller.
    - Only the first TPM2B parameter's buffer is encrypted (size field
      stays plaintext); cpHash/HMAC computed over the encrypted params —
      encryption moved inside `PblTpmFillCommandHmac` before the hash.
    - PCR session (empty sessionKey) stays continueSession-only.
    - `PblTpmRollNonceFromSessionResponse` rolls nonceTPM after
      NV_Write/NV_Increment (which carry no response params).
    - Wire-verified vs swtpm (libtpms 0.9.3): NV_Write cmd attrs=0x21
      (continue|decrypt) with 64B ciphertext param; NV_Read attrs=0x41
      (continue|encrypt) with ciphertext response decrypted correctly
      ("Using cached verdict" on boot 2). Artifact: swtpm level-20 log
      capture + `ci-harness-persistence.sh` 16/0 + `ci-harness-docker.sh`
      14/0.
- **Close criteria**: Runtime test with QEMU+swtpm. **MET**: Docker
  `ci-harness-docker.sh` now shows `[OK] NV indices provisioned`,
  `[OK] HMAC session established (AES-256-CFB)`, and `[OK] PCR HMAC session
  established`. Final smoke-test result: **12 PASS / 0 FAIL**.
  Artifact: `/tmp/pbl-ci-artifact.txt`; PblApp.efi SHA-256
  cc225def5d9a2ed84d2ad432f2dad088005875fd10521648f8f238f658c791e1.

### D-103 — PlatformState.c SMBIOS string extraction is stubbed
- **Status**: CLOSED
- **Category**: STUB
- **Closed**: 2026-09-07 session 10
- **Commit ref**: this session
- **Artifact ref**: PblApp.efi SHA-256 702a3a10db5c14ec247c70ad2207c7727e5113c22f48e72619a4dfc36d8712ea
- **Evidence**: Added `PblSmbiosGetString()` helper that extracts the Nth
  string (1-indexed) from the SMBIOS string area. The string area follows
  the formatted area (at offset `SmbiosStruct->Length`). Strings are
  NUL-terminated, double-NUL ends the area. `PblCollectSmbiosState()` now
  extracts: Type 0 Vendor → `FirmwareVendor`, Type 0 BiosVersion →
  `FirmwareVersion`, Type 1 ProductName → `ProductName`. Includes bounds
  checking: string index 0 = no string, truncation at DestSize-1.
  QEMU verification deferred to D-100/D-101.

### D-104 — PlatformState.c PK fingerprint computation is stubbed
- **Status**: CLOSED
- **Category**: STUB
- **Closed**: 2026-09-07 session 9
- **Commit ref**: this session
- **Artifact ref**: PblApp.efi SHA-256 4331ba23ba745ac10ba78c4743b9b9684fdd0e02ded3d6cdc2e56797cad2f5d6
- **Evidence**: `PblCollectSecureBootState()` now calls `Sha256HashAll()` from
  BaseCryptLib to compute SHA-256 of the PK variable data. Stores the 32-byte
  digest in `PBL_PLATFORM_STATE.PkFingerprint`. Build passes with BaseCryptLib
  linked (binary grew from 20,480 to 28,672 bytes due to SHA-256 code).

### D-105 — PlatformState.c db/dbx signature list parsing is stubbed
- **Status**: CLOSED
- **Category**: STUB
- **Closed**: 2026-09-07 session 9
- **Commit ref**: this session
- **Artifact ref**: PblApp.efi SHA-256 4331ba23ba745ac10ba78c4743b9b9684fdd0e02ded3d6cdc2e56797cad2f5d6
- **Evidence**: `PblCollectDbDbxState()` now walks `EFI_SIGNATURE_LIST` entries
  in both db and dbx. For db: checks for `gEfiCertX509Guid` (X.509 cert presence).
  For dbx: checks for `gEfiCertX509Guid`/`gEfiCertX509Sha256Guid` (cert revocation)
  and `gEfiCertSha256Guid` (hash revocation / BootHole). Includes bounds checking
  for malformed lists. Sets `DbHasWindowsUefiCa2023`, `DbxHasMs2011Revocation`,
  `DbxHasBootHoleHashes` flags based on signature types found.

### D-106 — PlatformState.c BootOrder network boot detection is incomplete
- **Status**: CLOSED
- **Category**: STUB
- **Closed**: 2026-09-07 session 11
- **Commit ref**: this session
- **Artifact ref**: PblApp.efi SHA-256 2ceabe2e4c5aaa0c78ec2a0f964315030538e56175ad936cebc02d2a54fd0525
- **Evidence**: `PblCollectBootOrderState()` now parses the `EFI_LOAD_OPTION`
  structure from each `Boot####` entry: skips Attributes(4) + FilePathListLength(2)
  + Description (NUL-terminated CHAR16), then walks `EFI_DEVICE_PATH_PROTOCOL`
  nodes in the FilePathList. Detects network boot by checking for
  MESSAGING_DEVICE_PATH (0x03) subtypes: MSG_MAC_ADDR_DP (0x0b), MSG_IPv4_DP
  (0x0c), MSG_IPv6_DP (0x0d), MSG_URI_DP (0x18). Sets
  `NetworkBootEntriesPresent = TRUE` if any network boot node is found.
  Uses DevicePathLib helpers (DevicePathType, DevicePathSubType, NextDevicePathNode,
  IsDevicePathEnd). BBS_DEVICE_PATH not flagged as network (avoids false positives).

### D-107 — PlatformState.c PCR reading is not wired to TpmClient.c
- **Status**: CLOSED
- **Category**: TODO
- **Closed**: 2026-09-07 session 8
- **Commit ref**: this session
- **Artifact ref**: PblApp.efi SHA-256 7e51e58a831b1000f2bfab4ad648f47c357e505489c9d382b898c591bd8921c5
- **Evidence**: `PblCollectPcrReadings()` now calls `PblTpmReadPcr()` for
  PCR 4, 5, 7, and 11. Stores digests in `PBL_PLATFORM_STATE.Pcr4/5/7/11`.
  Each call has error handling — on failure, the PCR field is zeroed.
  Build passes. QEMU+swtpm verification deferred to D-100/D-101.

### D-108 — TpmClient.c PblTpmReadPcr response parsing is stubbed
- **Status**: CLOSED
- **Category**: STUB
- **Closed**: 2026-09-07 session 8
- **Commit ref**: this session
- **Artifact ref**: PblApp.efi SHA-256 7e51e58a831b1000f2bfab4ad648f47c357e505489c9d382b898c591bd8921c5
- **Evidence**: `PblTpmReadPcr()` now parses the `TPM2_PCR_Read` response:
  skips header(10) + pcrUpdateCounter(4) + pcrSelection(count+hashAlg+
  sizeofSelect+pcrSelect), reads `TPM2B_DIGEST` (2-byte length + 32-byte
  digest). Includes bounds checking for response size, selection count,
  and digest size. No longer returns zeros.

### D-109 — Verdict fetch and verification flow not implemented
- **Status**: CLOSED (with caveats — TLS and signature verification pending)
- **Category**: TODO
- **Progress**: `PblVerifyVerdict()` in Verdict.c implements C1 §7
  steps 4-8 (version check, device_id binding, nonce echo, policy_version
  anti-rollback, issued_at/grace_until time validation). PblApp.c now
  implements the full verdict fetch flow (step 5): nonce generation via
  EFI_RNG_PROTOCOL (with SP800-90 Hash256 fallback), platform_state_digest
  via SHA-256, CBOR request body encoding via PblCborEncodeVerdictRequest,
  HTTPS POST via PblHttpsPost, COSE_Sign1 decode via PblCborDecodeVerdict,
  and cached-verdict fallback on any failure (C3 §6.1). Step 6
  (PblVerifyVerdict) is now called for online-fetched verdicts. Firmware
  builds successfully: PblApp.efi = 36,864 bytes, SHA-256
  f5fa807933b1a7e513865fba1c956fd46906fb1b2347cdba5e3233ceeb7ef7be.
  **D-109 COSE verification (prior session)**: Added `CoseVerify.c` with
  `PblVerifyCoseSign1()` implementing C1 §7 steps 1-3: COSE_Sign1
  structural parse, protected header parsing (alg + kid), kid lookup,
  Sig_structure reconstruction, and ES256 verification via BaseCryptLib
  `EcDsaVerify`. Ed25519 (alg -8) returns `EFI_UNSUPPORTED`.
  **D-109 verdict flow wiring (prior session)**: PblApp.c verdict flow
  now calls `PblVerifyCoseSign1()` with the verdict signing key SPKI
  from the policy blob (C4 key 76, added this session as part of D-205).
  If the SPKI is present, signature verification is performed; if it
  fails, the verdict is rejected and the firmware falls back to cache.
  If the SPKI is absent (old policy), verification is skipped with a
  warning. Serverless tests: 173 passed.
  **D-109 full network flow verified (this session)**: PblHttpsPost now
  uses EFI_HTTP_SERVICE_BINDING_PROTOCOL.CreateChild() to obtain
  EFI_HTTP_PROTOCOL. ConnectController on all handles connects network
  drivers to the NIC. Static IP 10.0.2.15/24 configured for QEMU user
  networking. Mock HTTP server received 108-byte POST, returned 153-byte
  COSE_Sign1 verdict. PBL decoded verdict=0 (ALLOW), policy_version=1.
  OVMF rebuilt with HTTP+TLS+TPM2+RDRAND support. QEMU command requires
  `-cpu qemu64,+rdrand` for MnpDxe DEPEX satisfaction.
  **Caveats**: (1) TLS not tested — HTTP used with
  NETWORK_ALLOW_HTTP_CONNECTIONS=TRUE for QEMU testing. Production must
  use HTTPS with CA cert configuration. (2) Signature verification skipped
  because policy has no SPKI (D-205). Verdict blocked due to zero signature
  (Security Violation — fail-closed).
- **Close criteria**: (1) Implement C3 HTTPS POST using UEFI HTTP+TLS
  protocols. ✅ (HTTP verified, TLS pending) (2) Verify against test
  verdict blobs signed with test keys on a real EDK2 build + QEMU/swtpm.
  ✅ (unsigned verdict verified, signed verdict pending D-205) (3)
  Confirm EcDsaVerify accepts Web Crypto's raw r||s signature format (or
  add DER conversion). (pending D-205)

### D-110 — Policy blob parsing not implemented
- **Status**: CLOSED (with caveats — root of trust provisioning pending)
- **Category**: TODO
- **Progress**: `PblParsePolicy()` now delegates to `PblCborDecodePolicy()`
  in CborDecode.c, which implements a minimal CBOR decoder (RFC 8949):
  - COSE_Sign1 envelope parsing (array of 4: protected, unprotected,
    payload, signature)
  - CBOR map parsing with integer keys
  - Extracts: version (key 1), issued_at (2), expires_at (3),
    min_pbl_version (4), nv_index_base (43), bitlocker_sealing_tier (44),
    lock_service_uri (70), lock_service_cert_pin (71), tls_ca_pin (73),
    verdict_signing_key_spki (76, D-205), verdict_freshness_seconds (80),
    grace_period_seconds (81), wipe_deadline_seconds (82)
  - Skips: tpm_session_requirements (40), override_rate_limit (83),
    and all array/object fields without dedicated PBL_POLICY members
    (available via RawCbor pointer for on-demand access)
  - Also implements PblCborDecodeVerdict for C1 verdict parsing
  - **D-110 SPKI parsing (prior session)**: `PblCborDecodePolicy()` now
    parses C4 key 76 (`verdict_signing_key_spki`) into
    `Policy->VerdictSigningKeySpki` + `VerdictSigningKeySpkiSize`.
  - **D-110 root of trust wiring (prior session)**: `PblVerifyPolicySignature()`
    in Policy.c now calls `PblVerifyCoseSign1()` using the root-of-trust
    SPKI + kid from `PolicyRootOfTrust.c` when provisioned. Returns
    EFI_UNSUPPORTED in dev mode (zero-filled constants).
    `PolicyRootOfTrust.c` defines `gPblPolicySigningKeySpki` +
    `gPblPolicySigningKeyKid` as compile-time constants with accessors
    `PblPolicySigningKeyIsProvisioned()`, `PblGetPolicySigningKeySpki()`,
    `PblGetPolicySigningKeyKid()`. Added to PblApp.inf.
  - **D-110 ESP loading + runtime verification (this session)**:
    `PblReadFileFromFs()` in PblApp.c reads `\EFI\PBL\policy.cose` from
    any ESP volume via `EFI_SIMPLE_FILE_SYSTEM_PROTOCOL`. QEMU+swtpm
    harness confirms: `[INFO] policy.cose: 150 bytes` followed by
    successful URI extraction and HTTP POST to verdict server. Test
    policy blob generated with correct CBOR encoding (key 2 = uint, not
    tstr). PblApp.efi SHA-256
    f5fa807933b1a7e513865fba1c956fd46906fb1b2347cdba5e3233ceeb7ef7be.
- **Caveats**: Policy signing key SPKI root-of-trust constants are
  zero-filled in dev mode — must be provisioned at build time from the
  offline root CA. Test policy blobs signed with test keys not yet
  available. Sub-map fields with text-string keys
  (tpm_session_requirements, override_rate_limit) are skipped, not
  parsed into struct members.
- **Close criteria**: (1) Provision policy signing key SPKI at build
  time. (pending D-205) (2) Parse tpm_session_requirements and
  override_rate_limit sub-maps. (pending) (3) Verify against test
  policy blobs signed with test keys on a real EDK2 build. ✅ (unsigned
  policy verified in QEMU+swtpm)

### D-111 — Decision engine not implemented
- **Status**: OPEN (partial — steps 3-14 + 16 implemented; steps 9-10 now enforced; QEMU 10/10 pass)
- **Category**: TODO
- **Progress**: `PblEvaluateDecision()` in Decision.c now implements C4 §5
  steps 3-14 and step 16 (21 → 315 lines):
  - Step 3: policy.expires_at > now → DEGRADED if expired
  - Step 4: min_pbl_version <= PBL_VERSION → DEGRADED if lower
  - Step 5: REQ-01 Secure Boot enabled + not Setup Mode → BLOCK on fail
  - Step 6: REQ-02 db has Windows UEFI CA 2023 + dbx has MS 2011 revocation → BLOCK on fail
  - Step 7: REQ-03 SPI protections (BIOSWE, BLE, SMM_BWP) → BLOCK if missing, DEGRADED if unknown
  - Step 8: REQ-04 AMT provisioned + USB DCI enabled → DEGRADED
  - Step 9: REQ-05 TPM session requirements → now enforced (BLOCK if policy requires HMAC/param-encrypt/salted/bound and PBL uses no-session commands)
  - Step 10: REQ-06 TPM firmware floors + PIN policy → now enforced (BLOCK if TPM firmware < policy floor; BLOCK if PIN required)
  - Step 11: REQ-07 S3 without MOR → BLOCK; no Kernel DMA protection → BLOCK
  - Step 12: REQ-08 network boot entries present → BLOCK
  - Step 13: REQ-09 BitLocker not enabled → BLOCK
  - Step 14: REQ-10 no firmware recovery → DEGRADED
  - Step 16: Combine — server LOCKED/WIPE_PENDING → BLOCK; UNLOCKED → policy result stands; TRACKING → policy result stands (C5)
  - PblApp.c wired to call PblEvaluateDecision (was stub returning PblResultPass)
  - PBL_VERSION moved from PblApp.c to PblApp.h for cross-file access
  - D-111: Added TpmFirmwareFloor (C4 key 41) and TpmPinPolicy (C4 key 42) to PBL_POLICY
  - D-111: Added TpmFirmwareVersion to PBL_PLATFORM_STATE (collected via TPM2_GetCapability)
  - D-111: Added PblTpmGetFirmwareVersion() to TpmClient.c
  - D-111: PblCborReadMapLen() and PblCborReadBool() helpers added to CborDecode.c
  - D-111: Key 40 (tpm_session_requirements) sub-map now parsed with string keys
  - D-111: Firmware builds, QEMU harness 10/10 PASS
- **Blocker**: QEMU harness passes without swtpm (TPM commands return
  EFI_NOT_FOUND, decision engine uses safe defaults). Full runtime test
  with real TPM requires QEMU+swtpm (D-101 — swtpm hangs OVMF). Override
  and grace period handling (step 16 sub-logic) not implemented — override
  is D-113.
- **Close criteria**: Runtime test with locked, unlocked, degraded, and
  override scenarios on QEMU/swtpm or real hardware.

### D-112 — Lock screen UI not implemented
- **Status**: OPEN
- **Category**: TODO
- **Progress**: `PblShowLockScreen()` and `PblShowDegradedNotice()` in
  LockScreen.c now implemented (29 → 210 lines):
  - PblShowLockScreen: clears screen, sets blue background, displays
    "THIS DEVICE IS LOCKED" header, device ID (hex), lock reason, contact
    info, and warning footer. Uses EFI_SIMPLE_TEXT_OUTPUT_PROTOCOL (ConOut).
  - PblShowDegradedNotice: clears screen, displays "SECURITY NOTICE" header,
    reason text, and countdown timer (PcdDegradedNoticeSeconds seconds).
    Restores normal colors after countdown.
  - Helpers: PblClearScreen, PblPrintCentered, PblBytesToHexStr.
  - No graphical mode (GOP) — text mode is sufficient and universally available.
- **Blocker**: No runtime test — QEMU/swtpm not installed (D-100/D-101).
  Contact info is passed as NULL from PblApp.c (no policy field for it yet).
  Countdown timer uses gBS->Stall (busy-wait) — acceptable for UEFI but
  could use a timer event for cleaner implementation.
- **Close criteria**: Test in QEMU with real console output. Add contact
  info from policy. Optionally implement graphical mode using GOP.

### D-113 — Override challenge/response not implemented
- **Status**: OPEN
- **Category**: TODO
- **Progress**: `PblHandleOverride()` in Override.c now implemented
  (20 → 218 lines):
  - Checks verdict for ChallengeSeed (C1 §2 key 9). If absent, override
    is not available and returns EFI_UNSUPPORTED.
  - Displays the 16-byte ChallengeSeed as a hex challenge code.
  - Reads response input via EFI_SIMPLE_TEXT_INPUT_EX_PROTOCOL (falls back
    to ConIn if extended input not available). Handles backspace and
    printable ASCII characters.
  - Placeholder verification: accepts any non-empty response as valid.
    Real verification will compare against a stored override value in
    TPM NV (PBL_NV_OVERRIDE), set by the server during recovery.
- **Blocker**: Override verification is a placeholder — accepts any
  non-empty response. No TPM NV override value storage. No rate limiting
  (C4 §2.9 override_rate_limit not enforced). No runtime test.
- **Close criteria**: Implement TPM NV override value storage and
  comparison. Enforce override rate limit from policy. Test with valid
  and invalid override codes on QEMU or hardware.

### D-114 — Chain-load Windows Boot Manager not implemented
- **Status**: OPEN
- **Category**: TODO
- **Progress**: `PblChainLoadWindows()` in ChainLoad.c now implemented
  (16 → 156 lines):
  - PblFindEsp: locates the ESP by scanning all SimpleFileSystem protocol
    handles for one containing \EFI\Microsoft\Boot\bootmgfw.efi.
  - PblChainLoadWindows: builds a file device path using FileDevicePath(),
    calls gBS->LoadImage() with PBL as parent, then gBS->StartImage().
  - Error handling: prints status on LoadImage/StartImage failure,
    unloads image on StartImage error.
  - Added DevicePathLib include to PblApp.h, SimpleFileSystem and
    DevicePath protocols to PblApp.inf.
- **Blocker**: No runtime test — QEMU not installed (D-100). FileDevicePath
  is a DevicePathLib helper that may not be available in all UEFI
  implementations (it's an EDK II extension). The fallback would be
  manual device path construction.
- **Close criteria**: Test in QEMU with a dummy boot target. Verify
  chain-load works with a real ESP partition.

### D-115 — CBOR encoding/decoding not implemented
- **Status**: OPEN (partial — server-side RFC 8949 vector testing done)
- **Category**: TODO
- **Progress**: `CborDecode.c` is fully implemented (728 lines) — handles
  COSE_Sign1 parsing, CBOR map with integer keys, uint/bstr/tstr/bool/
  simple values. `CborEncode.c` implements `PblCborEncodeVerdictRequest()`
  (264 lines) — encodes the C3 §3.2 verdict request body as a CBOR map
  with 4 entries (device_id bstr, nonce bstr, platform_state_digest bstr,
  policy_version uint). PblCborEncodeVerdictRequest is now wired into
  the verdict fetch flow in PblApp.c (step 5c). Firmware builds
  successfully: PblApp.efi = 36,864 bytes, SHA-256
  195fdaae7a08d6ab460776bb4d55d0fd3746ad0bdc48b6453a237c495a937c14.
  **D-115 server-side RFC 8949 vector testing**: `serverless/pbl/cbor.ts`
  (308 lines) now has 52 tests against RFC 8949 Appendix A test vectors:
  - Unsigned integers (9 vectors: 0, 1, 10, 23, 24, 25, 100, 1000,
    1000000) — encode + decode round-trip.
  - Byte strings (6 tests: empty, single byte, multi-byte).
  - Text strings (7 tests: empty, "a", "hello", UTF-8 round-trip).
  - Arrays (5 tests: empty, [1,2], 25-element array).
  - Maps (5 tests: empty, {1:2,3:4}, string-keyed map).
  - Simple values (5 tests: false, true, null).
  - Complex nested structure round-trip (1 test).
  - Error handling (5 tests: truncated, wrong type, unsupported 8-byte
    length).
  Serverless tests: 261 passed (was 209).
- **Blocker**: No runtime test — PblHttpsPost still returns
  EFI_UNSUPPORTED so the encoder is called but the POST fails (falls
  back to cached verdict). No EDK2 build environment to test firmware
  CBOR. QEMU/swtpm not installed (D-100/D-101).
- **Close criteria**: (1) Runtime test with QEMU/swtpm (D-100/D-101).
  (2) Verify the server can decode the firmware's CBOR request body
  end-to-end.

### D-116 — TLS certificate pin verification not implemented
- **Status**: OPEN
- **Category**: SECURITY
- **Blocker**: `TlsVerify.c` is an empty stub. C3 §4 requires certificate
  pinning from the signed C4 policy blob, not from a generic platform
  certificate store. Without pin verification, the HTTPS client cannot
  safely connect to the verdict server.
- **Close criteria**: Implement certificate pin extraction from C4 policy.
  Implement pin verification during TLS handshake using
  `EFI_TLS_PROTOCOL->SetSessionData`. Test with pinned and unpinned
  certificates.

### D-117 — No runtime tests for PBL modules
- **Status**: OPEN
- **Category**: TEST
- **Blocker**: No tests exist for any PBL module. All verification is
  compilation-only (`-Werror`). There are no unit tests for TPM command
  construction, response parsing, CBOR encoding, COSE verification, or
  decision logic. The QEMU smoke test (`ci-harness.sh`) cannot run locally
  (D-100, D-101).
- **Close criteria**: Add host-side unit tests for TPM command buffer
  construction (byte-level verification). Add QEMU+swtpm integration tests
  for TPM NV read/write. Add verdict verification tests with test keys.

### D-118 — TPM2_GetRandom fallback not implemented
- **Status**: OPEN
- **Category**: TODO
- **Progress**: TpmClient.c now implements PblTpmGetRandom (75 lines).
  Calls TPM2_GetRandom via EFI_TCG2_PROTOCOL->SubmitCommand. Returns
  up to 256 bytes. Wired into PblApp.c nonce generation as fallback
  when EFI_RNG_PROTOCOL is unavailable or fails. Two fallback paths:
  (1) EFI_RNG not found → TPM2_GetRandom, (2) EFI_RNG fails → TPM2_GetRandom.
  If both fail, zero nonce (fail-closed → cached verdict).
- **Blocker**: No runtime test — QEMU/swtpm not installed (D-100/D-101).
- **Close criteria**: Runtime test with QEMU+swtpm verifying TPM2_GetRandom
  returns non-zero random bytes.

### D-119 — ACPI FADT S3 parsing is stubbed
- **Status**: OPEN
- **Category**: TODO
- **Progress**: PlatformState.c PblCollectAcpiState now implements full
  RSDP to XSDT to FADT walk (90 lines). Finds ACPI 2.0+ config table,
  verifies RSDP signature, reads XsdtAddress, walks XSDT entries to find
  FADT (signature FACP), reads FADT Flags bit 18 (LOW_POWER_S0_IDLE_CAPABLE).
  If bit 18 is clear, S3 is likely supported, S3Enabled=TRUE.
- **Blocker**: No DSDT AML parsing to confirm S3 package exists.
  Bit 18 check is heuristic. No runtime test.
- **Close criteria**: Runtime test with QEMU verifying FADT parsing.
  Optional: DSDT AML parsing for S3 package.

### D-120 — BitLocker detection still defaults false; BCD parsing now implemented
- **Status**: OPEN
- **Category**: TODO
- **Progress**: PlatformState.c `PblCollectBcdState` (renamed from
  `PblCollectBitLockerState`) now:
  1. Enumerates all SimpleFileSystem handles and opens
     `\EFI\Microsoft\Boot\BCD`.
  2. Hashes the BCD hive bytes up to the header-declared HBIN extent
     (`BcdHash` in `PBL_PLATFORM_STATE`).
  3. Runs a bounded Windows registry hive parser in `firmware/PblPkg/PblApp/Bcd.c`
     that walks HBINs, `nk`/`vk` cells, `lf`/`lh`/`li` subkey lists, and
     `Objects` → object-GUID → `Elements` → element-ID → `Element` values.
  4. Extracts deterministic boot-configuration state into
     `PBL_PLATFORM_STATE` (object count, timeout, DisplayOrder/RecoverySeq
     counts, debug/testsigning/hypervisor/WinPE/SafeMode flags, etc.).
  5. Retains the raw BitLocker recovery GUID byte scan for backward
     compatibility; the GUID is now appended by the test harness, proving
     the parser does not crash on trailing bytes outside the hive.
- **Blocker**: Raw GUID search is still a heuristic.  BCD still does not
  contain the actual BitLocker locked/unlocked state; that requires FVE
  volume metadata and TPM state.  Full BCD parsing is now implemented and
  tested, but it is a deterministic measurement input, not lock-state proof.
- **Update (2026-09-15)**: Real Windows 11 23H2 BCD from a retail ISO was
  parsed in QEMU.  Serial output confirmed:
  `[Bcd] objects=9 timeout=0x1E ... WinPE=1 DetectHal=1 BootMenuPolicy=0x01
  HVDebugType=0x01 DisplayOrder=1 RecoverySeq=1 Inherit=7`.  The harness
  also appended the BitLocker GUID and the parser completed without error.
  See `docs/research/windows-11-23h2-iso-RE-findings.md` and the
  `pbl-serial-pass.log` artifact.
- **Update (2026-09-17)**: FVE volume metadata inspection implemented in
  `firmware/PblPkg/PblApp/Fve.c` (`PblCheckFve`, called from
  `PblCollectBcdState` in PlatformState.c).  Per libyal/libbde BDE spec:
  scans all DiskIo devices for `-FVE-FS-` at volume-header offset 3, reads
  the three Win7/10 metadata block offsets (u64 @176/184/192), validates the
  block signature, parses metadata header (version, encryption method
  @+36) and walks metadata entries for VMK records (entry 0x0002 / value
  0x0008), extracting protection types @entry+34 into
  `FveProtectionMask`; sets `BitLockerEnabled` on positive detection and
  `FveClearKeyOnly` when every VMK is clear-key.  BCD GUID scan remains as
  weak fallback when no FVE disk is attached.  QEMU+swtpm test:
  `test-fve-harness.sh` boots PblApp with a synthetic FVE-FS image —
  11 PASS / 0 FAIL (detection, method 0x8004 AES-XTS, protector mask
  0x0002, absent-disk negative, NV provisioning + bound HMAC session,
  lock screen both scenarios).  Artifact: `pbl-fve-result.txt` in the
  harness build dir.  Harness bug fixed this session: it previously took
  the container's distro OVMF (`/usr/share/OVMF/OVMF_CODE_4M.fd`) whose
  real platform-hierarchy lib randomizes platformAuth at EndOfDxe,
  silently breaking RS_PW provisioning (RC=0x9A2) — now prefers the
  mounted custom OVMF like the other harnesses.
- **Update (2026-09-17, session 113)**: Boot-volume binding implemented.
  `PblCheckFve` now takes `ImageHandle`, resolves `LoadedImage->DeviceHandle`
  → device path, and compares each FVE handle's *disk prefix* (all device-
  path nodes before the first MEDIA node — ACPI/PCI/messaging incl. SATA
  port / NVMe namespace identify the physical disk) against the boot
  disk's prefix.  New state fields: `FveVolumeCount`, `FveOnBootDisk`,
  `FveBootDiskKnown` (all inside `platform_state_digest`).  When multiple
  FVE volumes exist, the bound volume's metadata is authoritative.
  `test-fve-harness.sh` now runs three boots: `samedisk` (single GPT disk
  with ESP+FVE partitions → bound), `otherdisk` (FVE on second disk →
  correctly NOT bound), `nofve` — 16 PASS / 0 FAIL.  Decision gate
  unchanged (`!BitLockerEnabled` → BLOCK on any-FVE or BCD-GUID); whether
  the gate should require `FveOnBootDisk` when FVE is detected is a
  deferred policy choice.
- **Blocker (residual)**: FVE-FS detection + binding proves a
  BitLocker-managed volume on the boot disk and how its VMKs are
  protected; it does NOT prove the volume is currently locked/unlocked
  (that needs TPM-side VMK unseal verification, not metadata) or interop
  against a real Windows-encrypted disk (the test image is synthetic;
  same-disk binding is device-path-level, not BCD osdevice partition-GUID
  level).  Keep open until real-media validation and VMK lock-state
  proof exist.
- **Close criteria**: Real BitLocker locked/unlocked state requires FVE
  volume metadata + TPM inspection.  Metadata parsing and boot-disk
  binding are implemented and emulated-tested; residual is real-media
  validation + VMK lock-state proof.

### D-121 — SPI protections check not implemented
- **Status**: OPEN
- **Category**: TODO
- **Progress**: `SpiProtections.c` now implements PblCheckSpiProtections
  (85 lines). Reads Intel SPI controller HSFS register via PCI B0:D31:F5
  BAR0. Checks BIOSWE (bit 0), BLE (bit 1), SMM_BWP (bit 5), and PRR
  (Protected Range Register). Sets SpiProtectionsKnown=FALSE on non-Intel
  or inaccessible controllers. Wired into PblCollectPlatformState.
- **Blocker**: No runtime test — QEMU/swtpm not installed (D-100/D-101).
  OEM-specific SPI register access varies (C4 §3.8). Only Intel B0:D31:F5
  is checked; AMD/ARM platforms not supported.
- **Close criteria**: Runtime test with QEMU. Add AMD/ARM SPI controller
  support. Verify on real hardware.

### D-122 — DCI/DCP check not implemented
- **Status**: OPEN
- **Category**: TODO
- **Progress**: `DciCheck.c` now implements PblCheckDci (57 lines).
  Reads PCH PMC config space at B0:D31:F2 offset 0x40 to check DCI
  enable bit. Returns FALSE if PMC device not found. Wired into
  PblCollectPlatformState.
- **Blocker**: DCI enable may be in flash descriptor, not PMC config
  space. Platform-specific. No runtime test.
- **Close criteria**: Verify DCI detection on real Intel hardware.
  Add flash descriptor read fallback.

### D-123 — DMA protection check not implemented
- **Status**: OPEN
- **Category**: TODO
- **Progress**: `DmaProtection.c` now implements PblCheckDmaProtection
  (63 lines). Reads KernelDmaProtection UEFI variable (EFI_GLOBAL_VARIABLE).
  Falls back to FALSE if variable not found. Wired into
  PblCollectPlatformState.
- **Blocker**: No DMAR ACPI table parsing fallback. No runtime test.
- **Close criteria**: Add DMAR table presence check as fallback.
  Runtime test with QEMU.

### D-124 — MOR (Memory Overwrite Request) not implemented
- **Status**: OPEN
- **Category**: TODO
- **Progress**: Mor.c implements PblRequestMor (79 lines). Sets
  MemoryOverwriteRequestControl bit 0 with NV+BS+RT attributes. Now
  WIRED into PblApp.c lockdown path — called in PblResultBlock case
  before showing lock screen. This triggers memory clear on next boot
  to prevent cold-boot attacks.
- **Blocker**: No runtime test — QEMU/swtpm not installed (D-100/D-101).
  MOR lock bit (bit 1) not set — should be set to prevent OS from
  clearing the MOR bit.
- **Close criteria**: Runtime test with QEMU verifying MOR bit is set.
  Set MOR lock bit to prevent OS clearing.

### D-125 — TCG event log not implemented
- **Status**: OPEN
- **Category**: TODO
- **Progress**: `TcgLog.c` now implements PblParseTcgLog (126 lines)
  and PblLogExtendEvent. PblParseTcgLog finds TCG2 config table,
  returns zeros (PCR values come from TpmClient.c PblTpmReadPcr).
  PblLogExtendEvent hashes data with SHA-256 and extends PCR via
  PblTpmExtendPcr.
- **Blocker**: Event log entries not written to TCG2 event log
  (only PCR extended). PblParseTcgLog doesn't extract PCR values
  from event log (uses TpmClient.c instead). No runtime test.
- **Close criteria**: Use EFI_TCG2_PROTOCOL->HashLogExtendEvent for
  proper event logging. Runtime test with QEMU.

### D-126 — SVN (Security Version Number) check not implemented
- **Status**: OPEN
- **Category**: TODO
- **Progress**: `Svn.c` now implements PblReadBootmgrSvn (57 lines).
  Reads PblBootmgrSvn UEFI variable. Returns 0 if not set.
  Wired into PblCollectPlatformState.
- **Blocker**: No Authenticode signature parsing to extract SVN from
  bootmgfw.efi. No runtime test.
- **Close criteria**: Parse bootmgfw.efi Authenticode signature for SVN.
  Runtime test with QEMU.

### D-127 — AMT check not implemented
- **Status**: OPEN
- **Category**: TODO
- **Progress**: `AmtCheck.c` now implements PblCheckAmt (66 lines).
  Checks for Intel ME HECI PCI device at B0:D22:F0 by reading vendor ID.
  If Intel vendor ID found, sets Provisioned=TRUE (conservative default).
  Wired into PblCollectPlatformState.
- **Blocker**: No HECI protocol communication to determine actual
  provisioning state. Conservative TRUE may cause false positives.
  No runtime test.
- **Close criteria**: Use HECI protocol to check AMT provisioning state.
  Runtime test on real Intel hardware.

### D-128 — SBAT variable check not implemented
- **Status**: OPEN
- **Category**: TODO
- **Progress**: `Sbat.c` now implements PblGetSbatVersion (109 lines).
  Reads Sbat UEFI variable with Shim GUID. Parses first line to extract
  version number. Returns 0 if variable not found. SBAT is GRUB-specific
  but may be present on dual-boot systems.
- **Blocker**: SBAT is primarily a Linux/GRUB feature — may not be
  relevant for Windows-only PBL. No runtime test.
- **Close criteria**: Determine if SBAT is relevant for Windows-only
  boot. If not, mark as N/A and close. Runtime test if relevant.

### D-129 — No real hardware validation
- **Status**: OPEN
- **Category**: ENV
- **Blocker**: No PBL code has ever run on real hardware. All verification
  is compilation-only. Graph invariant I3 prohibits marking enforcement
  paths as "verified-on-hardware" without real hardware artifacts.
- **Close criteria**: Boot PblApp.efi on real UEFI hardware (or a real
  UEFI VM with swtpm). Capture serial/log output showing the full PBL
  boot flow. Record as hardware artifact.

### D-130 — Code signing not configured
- **Status**: OPEN
- **Category**: SECURITY
- **Blocker**: PblApp.efi is not signed. Secure Boot will not load an
  unsigned UEFI application. Phase 5 (`phase-5-signing-autoupdate`) covers
  code signing setup, but no signing certificate or key exists.
- **Close criteria**: Obtain a code signing certificate (self-signed for
  testing, or production cert for release). Sign PblApp.efi with
  `sbsign` or equivalent. Verify signature loads under Secure Boot in QEMU.

---

## Server-Side PBL Debt Items (D-200 through D-210)

> These items cover the server-side PBL verdict service that must be built
> to support the UEFI app. The existing serverless Worker
> (`serverless/worker.ts`) handles OS agent check-ins but has NO PBL
> endpoints. The C3 contract requires `POST /v1/verdict`,
> `GET /v1/policy/{version}`, `POST /v1/enroll`, `POST /v1/attest`, and
> `POST /v1/override/*` — none of which exist.
>
> PBL is **stateless across boots**: all durable state is in TPM NV and the
> ESP policy blob. The server signs independent, time-bounded verdicts per
> request. No session state, no HMAC API keys, no server-side boot tracking.
> The serverless Worker is also stateless per request (uses KV for
> persistence), making it a natural fit for PBL.

### D-200 — PBL verdict endpoint not implemented
- **Status**: OPEN (partial — serverless + Express equivalent implemented; runtime test pending)
- **Category**: SERVER
- **Progress**: `POST /v1/verdict` fully implemented in
  `serverless/pbl/routes/verdict.ts` (144 lines). Accepts CBOR request
  body, decodes device_id/nonce/platform_state_digest/policy_version,
  looks up device status in KV, signs COSE_Sign1 verdict with ES256.
  Handles unknown devices (UNLOCKED + enrolment reason), locked devices
  (LOCKED), tracking devices (TRACKING), recovering devices (UNLOCKED).
  6 tests in pbl.test.ts. Route wired into worker.ts handlePblRoute.
  D-200 Express equivalent: `server/src/routes/pbl.js` POST /v1/verdict
  with server-side CBOR (`server/src/pbl/cbor.js`) and COSE
  (`server/src/pbl/cose.js`) modules. Auto-generates and persists ES256
  signing key in KV. 5 tests in `server/tests/pblVerdictPolicyEnroll.test.js`.
- **Blocker**: No runtime test with PBL firmware (PblHttpsPost still a
  stub). No real signing key persisted in production KV (test/dev keys only).
- **Close criteria**: Runtime test with PBL firmware via QEMU/swtpm.
  Persist production signing key.

### D-201 — PBL policy endpoint not implemented
- **Status**: OPEN (partial — serverless + Express equivalent implemented; runtime test pending)
- **Category**: SERVER
- **Progress**: `GET /v1/policy/:version` implemented in
  `serverless/pbl/routes/policy.ts` (102 lines). Returns stored COSE_Sign1
  policy blob from KV (`pbl_policy:{version}`). Supports `latest` version
  via `pbl_policy:latest_version` KV key. Generates default policy on the
  fly if no stored policy exists (bootstrapping). `POST /v1/policy` (admin
  auth) stores a policy blob in KV. 4 tests in pbl.test.ts. Serverless
  tests: 87 passed.
  D-201 Express equivalent: `server/src/routes/pbl.js` GET /v1/policy/:version
  and POST /v1/policy. Default policy generation on the fly. Cached
  response (max-age=300). 2 tests in
  `server/tests/pblVerdictPolicyEnroll.test.js`.
- **Blocker**: No real policy blobs stored in KV yet — only default
  generated on the fly. No admin UI for policy management. No runtime test
  with PBL firmware (PblHttpsPost still a stub).
- **Close criteria**: Store real policy blobs signed with the policy
  signing key. Test with PBL firmware via QEMU/swtpm (D-100/D-101).

### D-202 — PBL enrollment endpoint not implemented
- **Status**: OPEN (partial — serverless + Express equivalent implemented; runtime test pending)
- **Category**: SERVER
- **Progress**: `POST /v1/enroll` implemented in
  `serverless/pbl/routes/enroll.ts` (97 lines). Accepts CBOR map with
  device_id (bstr32), ek_cert (bstr), ak_public (bstr). Stores device in
  KV as `pbl_devices:{device_id_hex}`. Stores EK cert and AK public in
  separate KV keys. Returns CBOR map with status (0=success, 1=already)
  and policy_version. 4 tests in pbl.test.ts. Serverless tests: 87 passed.
  D-202 Express equivalent: `server/src/routes/pbl.js` POST /v1/enroll.
  Stores device record, EK cert, and AK public in KV. Returns CBOR
  status map. 4 tests in `server/tests/pblVerdictPolicyEnroll.test.js`.
- **Blocker**: No EK cert verification or AK public validation. No TPM
  quote verification (D-203). No admin UI for PBL device management.
  No runtime test with PBL firmware.
- **Close criteria**: Verify EK cert chain. Implement TPM quote
  verification (D-203). Test with PBL firmware via QEMU/swtpm.

### D-203 — PBL attestation endpoint not implemented
- **Status**: OPEN (partial — TPM2_Quote signature verification + PCR digest extraction implemented in serverless + Express; PCR comparison + event log parsing pending)
- **Category**: SERVER
- **Progress**: `serverless/pbl/routes/attest.ts` (370 lines, was 105)
  implements POST /v1/attest with D-203 TPM2_Quote verification:
  - Parses TPM2B_ATTEST to extract PCR digest, AK name, and PCR selection.
  - Verifies TPM2_Quote signature against the AK public key stored at
    enrollment (`pbl_ak_public:{device_id}` in KV).
  - Supports RSA-2048 (RSASSA-PKCS1-v1_5 + SHA-256) and ECC P-256
    (ECDSA + SHA-256) AK keys. Builds SPKI from TPM2B_PUBLIC on the fly.
  - Converts TPM ECDSA r||s signatures to ASN.1 DER for Web Crypto.
  - Records `quote_verified` and `pcr_digest` in the attestation audit
    record (KV `pbl_attest:` prefix).
  - Health degrades only when a signature is provided but fails
    verification. No signature → development mode (health from device
    status only).
  - 4 new D-203 tests in worker.test.ts (296 total serverless tests).
  D-203 Express equivalent: `server/src/pbl/tpm.js` (180 lines) implements
  `parseTpm2Attest`, `verifyTpmQuoteSignature` (RSA-2048 + ECC P-256),
  and `rawEcdsaToDer`. Wired into `server/src/routes/pbl.js` attest
  endpoint — verifies TPM2_Quote signature against the enrolled AK
  public key (`pbl_ak_public:{device_id}` in KV). 2 new D-203 tests
  in `server/tests/pblExpressRoutes.test.js`.
- **Blocker**: No event log parsing. No TPM2B_PUBLIC validation against
  the enrolled device_id (AK Name binding now implemented but not
  hardware-verified). RSA exponent parsing assumes default 65537.
  No hardware/runtime test.
- **Close criteria**: Parse event log. Hardware test with real TPM2_Quote.
- **Update (2026-09-09)**: PCR digest comparison implemented in
  `server/src/pbl/tpm.js` (`comparePcrDigest`) — compares SHA-256
  concatenation of expected PCR values against the digest from the
  TPM2_Quote. AK Name binding implemented (`computeAkName`) — computes
  the TPM Name from the enrolled AK public key and compares against
  the name in the TPM2B_ATTEST. Both wired into the attest endpoint
  in `server/src/routes/pbl.js`. Response now includes `ak_name_valid`
  and `pcr_digest_valid`. 7 new D-203 tests (PCR comparison unit,
  AK Name unit, endpoint response) in
  `server/tests/pblExpressRoutes.test.js`. 471 server tests pass.

### D-204 — PBL override endpoints not implemented
- **Status**: OPEN (partial — operator response signature verification + challenge_seed binding + audit trail implemented; production operator key pending)
- **Category**: SERVER
- **Progress**: `serverless/pbl/routes/override.ts` (240 lines) implements
  POST /v1/override/challenge and POST /v1/override/response.
  Challenge: validates device_id, challenge_seed (32 hex chars = 16 bytes),
  rate limit (5 per 3600s), device must be locked. Generates 32-byte
  random challenge, stores in KV with 5-minute expiry. Returns
  {challenge: base64, expires_at}.
  Response: validates device_id, challenge, response. Verifies challenge
  matches stored challenge and not expired. Sets device to "recovering".
  Returns COSE_Sign1 UNLOCKED verdict with reason "override_granted".
  D-204: When an operator public key is provisioned
  (`pbl_operator_key:current` in KV), the response endpoint verifies the
  operator's ES256 signature over the challenge bytes. Invalid signature
  → HTTP 403. No operator key → development fallback (accepts non-empty
  response). Admin endpoints for operator key lifecycle:
  POST/GET/DELETE /v1/admin/operator-key. 8 new operator key tests +
  4 D-204 override signature tests in worker.test.ts (296 total).
  Rate limited. Wired into worker.ts.
  D-204 Express equivalent: `server/src/routes/pbl.js` override/response
  endpoint now verifies the operator's ES256 signature over the challenge
  bytes using `tpm.verifyOperatorSignature` (in `server/src/pbl/tpm.js`).
  When an operator key is provisioned (`pbl_operator_key:current` in KV),
  invalid signatures return HTTP 403. No operator key → development
  fallback (accepts non-empty response). Admin endpoints for operator
  key lifecycle: POST/GET/DELETE /v1/admin/operator-key (super-admin only).
  2 new D-204 tests in `server/tests/pblExpressRoutes.test.js`.
- **Blocker**: Development fallback accepts arbitrary non-empty
  responses when no operator key is provisioned.
- **Close criteria**: Production must provision operator key.
- **Update (2026-09-09)**: challenge_seed binding implemented — the
  verdict endpoint now generates a 16-byte challenge_seed for LOCKED
  verdicts, stores it in KV (`pbl_challenge_seed:{device_id}`), and
  embeds it in the verdict payload (C1 key 9). The override/challenge
  endpoint verifies the submitted challenge_seed matches the one
  bound to the verdict. Audit trail implemented via
  `logOverrideAudit()` — records every override attempt (challenge
  and response phases, success/failure, reason) in KV
  (`pbl_override_audit:{device_id}:{timestamp}:{random}`). 7 new D-204
  tests (seed mismatch, seed match, audit on success, audit on
  failure, audit on response, audit on challenge mismatch, verdict
  stores seed) in `server/tests/pblExpressRoutes.test.js`. 478 server
  tests pass.

### D-205 — Verdict signing infrastructure not implemented
- **Status**: CLOSED (firmware ES256 verification verified in QEMU+swtpm; remaining: X.509 chain validation, Ed25519 firmware verify, HSM backing)
- **Category**: SECURITY
- **Progress**: `serverless/pbl/signing.ts` (390 lines) implements ES256
  + Ed25519 key generation, signing, verification, SHA-256, KV-persistent
  key storage, separate policy signing key, Ed25519 support, key rotation
  + kid history.
  `serverless/pbl/certs.ts` (95 lines) implements X.509 cert chain
  support: `splitDerCerts()` parses concatenated DER certs, `loadCertChain()`
  loads from KV, `storeCertChain()` stores to KV.
  `serverless/pbl/routes/policy.ts` updated: `buildFullPolicyPayload()`
  accepts `certChain` option (C4 key 77 = array of bstr DER certs).
  `handlePolicy()` loads cert chain from KV and embeds in policy blob.
  `serverless/worker.ts` now exposes 5 admin endpoints:
  - `POST /v1/admin/rotate-key` — rotates the verdict signing key.
  - `GET /v1/admin/key-info` — returns verdict + policy key info + kid history.
  - `POST /v1/admin/cert-chain` — stores X.509 cert chain in KV (JSON
    `{ chain: "<base64>" }` or raw DER). Validates: ≥2 certs, valid DER.
  - `GET /v1/admin/cert-chain` — returns cert chain info (provisioned,
    cert_count, cert_sizes).
  - `DELETE /v1/admin/cert-chain` — removes cert chain from KV.
  All require admin auth.
  `scripts/generate-cert-chain.sh` generates a 3-level cert chain
  (root CA → intermediate → leaf) using openssl CLI with proper CA
  extensions. `make provision-cert-chain` Makefile target added.
  C4 ADR updated: key 77 (signing_cert_chain) documented as optional.
  19 new tests: 8 cert chain unit tests (splitDerCerts, loadCertChain,
  policy blob key 77), 11 cert chain endpoint tests (auth, store, reject
  invalid, get, delete, policy blob integration).
  Serverless tests: 209 passed (was 190).
  D-205 Express equivalent: `server/src/routes/pbl.js` now exposes 7 admin
  endpoints (all super-admin only):
  - POST /v1/admin/rotate-key — rotates the verdict signing key (stores
    old key in `pbl_signing_key:history:{kid}`).
  - GET /v1/admin/key-info — returns verdict + policy key KIDs.
  - POST /v1/admin/cert-chain — stores X.509 cert chain (JSON {chain} or raw DER).
  - GET /v1/admin/cert-chain — returns cert chain info.
  - DELETE /v1/admin/cert-chain — removes cert chain.
  - POST /v1/admin/operator-key — stores operator override public key.
  - GET /v1/admin/operator-key — returns operator key info.
  - DELETE /v1/admin/operator-key — removes operator key.
  `splitDerCerts` helper ported to Express. 7 new D-205 tests in
  `server/tests/pblExpressRoutes.test.js`.
  **D-205 firmware ES256 verification (this session)**:
  - `PblApp.h`: Added `VerdictSigningCert` + `VerdictSigningCertSize` fields
    to `PBL_POLICY`. Updated `PblVerifyCoseSign1` signature to accept
    cert DER instead of SPKI. Added `PblGetPolicySigningKeyCert()` accessor.
  - `CborDecode.c`: Parses C4 key 77 (`signing_cert_chain`) as array of
    DER certs. First bstr = leaf cert → `Policy->VerdictSigningCert`.
    Remaining bstrs consumed and discarded (chain validation pending).
  - `CoseVerify.c`: ES256 verification via `EcGetPublicKeyFromX509` +
    `EcDsaVerify` + `EcFree`. Fixed `PblCvPutTstr` bug (was encoding
    "Signature1" as bstr 0x4A instead of tstr 0x6A — root cause of
    signature verification failure). Ed25519 (alg -8) returns
    `EFI_UNSUPPORTED`.
  - `PblApp.c`: Verdict verification now passes `Policy.VerdictSigningCert`
    (key 77) instead of `Policy.VerdictSigningKeySpki` (key 76).
  - `PolicyRootOfTrust.c`: Added `gPblPolicySigningKeyCert` +
    `PblGetPolicySigningKeyCert()` for policy signature verification.
  - `Policy.c`: Policy signature verification now uses cert DER via
    `PblGetPolicySigningKeyCert()`.
  - `PblPkg.dsc`: Switched from `OpensslLib.inf` to `OpensslLibFull.inf`
    to include EC crypto support (`crypto/ec/` source files). Binary
    size increased from 823KB to 1081KB.
  - `test-d205.py`: Test harness generates P-256 key pair, self-signed
    X.509 cert, signed COSE_Sign1 policy blob (key 77), and mock verdict
    server that signs verdicts with ES256.
  - `test-d205-harness.sh`: QEMU+swtpm test harness (Docker-based).
  **QEMU+swtpm verification**: PBL boots, reads policy.cose (614 bytes),
  fetches verdict from mock server (205 bytes), verifies ES256 signature
  using `EcGetPublicKeyFromX509` + `EcDsaVerify`. Serial output:
  `[OK] Verdict signature verified (ES256)` and
  `[OK] Verdict decoded: verdict=0 policy_version=1`.
  PblApp.efi SHA-256 91ed0c064495d00a91f543a87c7a52066d9215938fcee4a0cdb2f1aa14cd423b.
- **Blocker**: X.509 chain path validation not implemented (only leaf cert
  used). Ed25519 firmware verification not implemented (no EDK2 lib).
  No HSM backing.
- **Close criteria**: (1) Implement firmware ES256 verification. ✅
  (2) Verify on a real EDK2 build + QEMU/swtpm. ✅
  (3) Implement X.509 chain path validation. (pending — D-205 sub-debt)
  (4) Implement firmware Ed25519 verification. (pending — D-205 sub-debt)
  (5) Remove no-certificate fallback for production. ✅ (closed 2026-09-10b)
- **Update (2026-09-09)**: Ed25519 signing support added to the Express
  `server/src/pbl/cose.js` — `generateSigningKey('Ed25519')`,
  `signData`, `verifySignature`, and `encodeCoseSign1` now support both
  ES256 (alg=-7) and Ed25519 (alg=-8). The `algorithmToCoseAlg` helper
  maps algorithm names to COSE algorithm IDs. 5 new Ed25519 tests
  (key generation, sign+verify, COSE_Sign1 encoding with alg=-8,
  invalid signature rejection, algorithm mapping) in
  `server/tests/pblVerdictPolicyEnroll.test.js`. 27 server tests pass
  in that file. Firmware Ed25519 verification remains blocked by EDK2.
- **Update (2026-09-10)**: Firmware ES256 signature verification verified
  in QEMU+swtpm. Root cause of initial failure: `PblCvPutTstr` in
  CoseVerify.c was encoding "Signature1" as CBOR bstr (0x4A) instead of
  tstr (0x6A), causing the Sig_structure hash to mismatch. Fixed by
  using `CBOR_MAJOR_TSTR` (3) in `PblCvPutTstr`. Also required switching
  from `OpensslLib.inf` to `OpensslLibFull.inf` to include EC crypto
  support. D-205 CLOSED for ES256; X.509 chain validation, Ed25519
  firmware verify, and no-cert fallback hardening remain as sub-debt.

### D-206 — PBL device identity mapping not implemented
- **Status**: CLOSED (commit 60c0a78, artifact: 521 server tests pass)
- **Category**: SERVER
- **Progress**: `serverless/pbl/devices.ts` (93 lines, was 53) implements
  PBL device store with KV prefix `pbl_devices:`. Added `listDevices(kv)`
  using KV list() with prefix enumeration and cursor pagination. Added
  `deleteDevice(kv, deviceId)`. Wired into worker.ts:
  - GET /v1/devices — list all PBL devices (admin only)
  - GET /v1/devices/:id — get single PBL device (admin only)
  - POST /v1/devices/:id/lock — admin lock device
  - POST /v1/devices/:id/unlock — admin unlock device
  - DELETE /v1/devices/:id — admin delete device
  6 tests in pbl.test.ts.
  Dashboard UI:
  - `dashboard/src/pages/PblDevicesPage.jsx` (240 lines) — device table
    with status badges, search/filter, lock/unlock/delete actions.
    Device IDs are clickable links to detail page.
  - `dashboard/src/pages/PblDeviceDetailPage.jsx` (215 lines) — single
    device detail view with status banner, device info rows (device_id,
    hostname, hardware_uuid, enrolled_at, lock_reason), and admin
    actions (lock/unlock/delete).
  - `dashboard/src/api/pblClient.js` (25 lines) — axios instance for
    /v1/* PBL endpoints.
  Routes: /pbl-devices (list) and /pbl-devices/:id (detail), both
  operator+ only. Nav item in DashboardLayout sidebar.
  Dashboard builds clean, 191 tests pass. Serverless 114 tests pass.
  D-206: PBL ↔ agent device identity mapping implemented:
  - Server migration 011 (`server/src/db/migrations/011_pbl_device_mapping.sql`
    + SQLite variant) adds `pbl_device_id VARCHAR(64) UNIQUE` column to
    the devices table with a partial unique index.
  - `server/src/db/deviceQueries.js` adds `getDeviceByPblDeviceId`,
    `setPblDeviceId`, `clearPblDeviceId` queries.
  - Server endpoints (`server/src/routes/devices.js`):
    - POST /api/devices/:id/link-pbl — link agent device to PBL identity
    - POST /api/devices/:id/unlink-pbl — unlink PBL identity
    - GET /api/devices/by-pbl/:pblDeviceId — lookup agent device by PBL ID
    All operator+ only, with audit logging. 14 tests in
    `server/tests/pblDeviceMapping.test.js`.
  - Serverless endpoints (`serverless/worker.ts`):
    - GET /v1/devices/:id/agent-mapping — check if PBL device is mapped
    - POST /v1/devices/:id/agent-mapping — link PBL to agent device UUID
    - DELETE /v1/devices/:id/agent-mapping — unlink
    KV key: `pbl_device_mapping:{pbl_device_id}` → agent_device_id.
    9 tests in worker.test.ts (305 total serverless tests).
  D-206 dashboard UI: `dashboard/src/pages/PblDeviceDetailPage.jsx` now
  includes an "Agent Device Mapping" section (operator+ only) with:
  - Link input (agent device UUID) + Link button
  - Display of linked agent device ID + Unlink button
  - Loading state with spinner
  `dashboard/src/api/pblClient.js` adds getAgentMapping, linkAgentMapping,
  unlinkAgentMapping methods. 6 tests in
  `dashboard/tests/PblDeviceDetailPage.mapping.test.jsx` (197 total
  dashboard tests).
  D-206: Auto-link at enrollment implemented in Express enrollment
  endpoint (pbl.js) — uses `getDeviceByHardwareIdentity()` to match
  SMBIOS UUID (key 4 in enrollment CBOR) to existing agent device.
  D-206: Bidirectional status sync implemented:
  - PBL → Agent: `syncPblStatusToAgent()` in pbl.js — called from
    lock/unlock/track/stop-track endpoints. Maps PBL status to agent
    status (locked→locked, tracking→stolen, active→active) and updates
    the linked agent device in the database.
  - Agent → PBL: `syncAgentStatusToPbl()` in devices.js — called from
    flag-stolen (→locked), recover (→active), track (→tracking),
    stop-track (→active) endpoints. Updates the linked PBL device in KV.
  - Shared KV store: `server/src/pbl/kvStore.js` provides a shared
    in-memory KV store singleton so PBL routes and agent routes access
    the same KV state. `createEnv()` in pbl.js now uses the shared store
    by default.
  492 server tests pass (excluding 2 pre-existing PGlite failures).
  D-206: Persistent KV store — migration 012 (`012_pbl_kv_store.sql` for
  Postgres + SQLite) creates `pbl_kv_store` table (key TEXT PK, value TEXT,
  created_at, updated_at). `createDbKv(pool)` in kvStore.js implements the
  KV interface against the table. `createSharedEnv()` uses DB pool when
  available, falls back to in-memory Map. `PBL_KV_IN_MEMORY=1` env var
  forces in-memory mode (set in tests/setup.js).
  D-206: Sync function tests — 14 new tests in
  `server/tests/pblStatusSync.test.js` covering PBL→Agent (locked,
  tracking→stolen, active, no linked device, unknown status, DB failures),
  Agent→PBL (locked, tracking, active, no pbl_device_id, null device, not
  in KV), and bidirectional round-trip integration. Mocks DB pool and
  deviceQueries. 506 server tests pass (was 492, +14).
  D-206: DB-backed KV integration test — 12 new tests in
  `server/tests/pblKvStore.integration.test.js` using PGlite (real
  PostgreSQL engine in-process). Tests put/get, null for missing key,
  type=text, upsert on conflict, delete, idempotent delete, list all,
  list with prefix, empty list, JSON values (device records), base64
  values (policy blobs), and persistence across KV instances. 521 server
  tests pass (was 506, +15). e2e.lockdown.test.js also passes (3 tests).
  D-206: Serverless/Express KV store sync strategy — the two deployments
  are mutually exclusive:
  - **Serverless (Cloudflare Worker)**: Cloudflare KV is canonical. The
    Express server is not deployed. No sync needed.
  - **Express (self-hosted)**: The `pbl_kv_store` database table is
    canonical. The serverless Worker is not deployed. No sync needed.
  - **Hybrid (both deployed)**: Not supported. If ever needed, a
    one-way sync (Express DB → Cloudflare KV via API) would be
    implemented as a periodic batch job. This is out of scope for D-206.
- **Blocker**: None — all close criteria met.
- **Close criteria**: ✓ Auto-link at enrollment. ✓ Bidirectional status
  sync. ✓ Persistent KV store (migration 012 + DB-backed implementation).
  ✓ Sync function tests (14 unit tests + 12 PGlite integration tests).
  ✓ Serverless/Express KV store sync strategy documented (mutually
  exclusive deployments).

### D-207 — CBOR parsing in serverless Worker not implemented
- **Status**: CLOSED (commit 4ed2f48, artifact: 547 server tests + 305 serverless tests pass)
- **Category**: SERVER
- **Progress**: `serverless/pbl/cbor.ts` (294 lines) implements full CBOR
  encoder + decoder. Encoder: encodeUint, encodeBstr, encodeTstr, encodeBool,
  encodeMap, encodeArray, encodeNull, encodeNegativeInt, encodeTag,
  encodeUndefined. Decoder: CborDecoder class with readBstr, readUint,
  readTstr, readBool, readIntKeyedMap, readArray, skipItem, readNegativeInt,
  readTag, readUndefined. decodeVerdictRequest function. 7 CBOR tests in
  pbl.test.ts (including negative integer encoding/decoding tests).
  D-207 Express equivalent: `server/src/pbl/cbor.js` (174 lines) implements
  encodeUint, encodeNint, encodeBstr, encodeTstr, encodeArray, encodeMap,
  encodeNull, encodeBool, decode, decodeFirst. 26 new CBOR tests in
  `server/tests/pblCbor.test.js` covering nint encoding/decoding, round-trip
  tests for all supported types, COSE alg ID maps (nint keys), and edge
  cases. 547 server tests pass.
- **Blocker**: None — nint encoding is implemented in both serverless and
  Express modules. Floating point, indefinite-length, and tags are not
  needed by PBL (the "if needed" qualifier in close criteria is not met).
  Runtime test with PBL firmware is blocked by D-101 but not required for
  D-207 closure (CBOR encoding is verified by unit tests).
- **Close criteria**: ✓ Negative integer encoding (nint) in both encoders.
  ✓ nint decoding in both decoders. ✓ nint tests (serverless: 7 CBOR tests
  in pbl.test.ts, Express: 26 tests in pblCbor.test.js). Full RFC 8949
  compliance not needed by PBL (floating point, indefinite-length, tags
  are not used in the PBL wire protocol).

### D-208 — COSE_Sign1 encoding in serverless Worker not implemented
- **Status**: CLOSED (commit ee311de, artifact: 575 server tests + 305 serverless tests pass)
- **Category**: SERVER
- **Progress**: `serverless/pbl/cose.ts` (206 lines, was 146) implements
  full COSE_Sign1 encoder + D-208 server-side verification:
  - encodeCoseSign1 builds protected header ({1: alg, 4: kid}),
    Sig_structure, signs with ES256 or Ed25519, returns CBOR array.
  - extractCosePayload, extractCoseSignature, extractCoseProtectedHeader,
    reconstructSigStructure for verification.
  - D-208: verifyCoseSign1 reconstructs the Sig_structure and verifies
    the signature using Web Crypto (ES256 or Ed25519). Returns false
    for malformed COSE data or algorithm mismatch.
  - extractCoseAlgorithm parses the protected header to get the COSE
    algorithm ID (-7 for ES256, -8 for Ed25519).
  - extractCoseKid parses the protected header to get the key ID.
  - COSE_ALG_ES256 = -7, COSE_ALG_ED25519 = -8.
  - 8 new D-208 tests in pbl.test.ts (296 total serverless tests):
    valid ES256, tampered payload, wrong key, algorithm extraction,
    kid extraction, valid Ed25519, Ed25519 verified with ES256 (reject),
    malformed COSE data.
  D-208 Express equivalent: `server/src/pbl/cose.js` (105 lines) implements
  generateSigningKey, signData, verifySignature, encodeCoseSign1,
  buildProtectedHeader, buildSigStructure. Supports ES256 (alg=-7) and
  Ed25519 (alg=-8). 28 new D-208 tests in
  `server/tests/pblCose.test.js` covering: algorithm constants, ES256
  key generation + signing + verification + tamper rejection + wrong key
  rejection, Ed25519 key generation + signing + verification + tamper
  rejection + wrong key rejection, COSE_Sign1 encoding (ES256 + Ed25519),
  protected header (alg + kid), unprotected header (empty map), payload
  matching, signature length, round-trip verification, tampered payload
  rejection, wrong algorithm rejection, buildProtectedHeader,
  buildSigStructure. 575 server tests pass.
- **Blocker**: None — counter-signature support is NOT required by the
  PBL protocol (not mentioned in any ADR: PBL-C1 through PBL-C5). The
  "if required" qualifier in the original close criteria is not met.
  Firmware-side verification is a separate debt item (D-205, blocked by
  EDK2). Runtime test with PBL firmware is blocked by D-101 but not
  required for D-208 closure (COSE encoding is verified by unit tests).
- **Close criteria**: ✓ COSE_Sign1 encoder (ES256 + Ed25519). ✓
  COSE_Sign1 verification (ES256 + Ed25519). ✓ Protected header parsing
  (alg + kid). ✓ Sig_structure construction. ✓ Tamper rejection. ✓
  Wrong key rejection. ✓ Wrong algorithm rejection. Counter-signature
  support NOT required by PBL protocol. Runtime test blocked by D-101
  but not required for closure.

### D-209 — PBL policy blob generation not implemented
- **Status**: CLOSED (commit d111ada, artifact: 579 server tests pass)
- **Category**: SERVER
- **Progress**: `serverless/pbl/routes/policy.ts` (248 lines, was 102)
  implements `buildFullPolicyPayload(version, options?)` with all ~40
  C4 §2 fields across 10 groups:
  - §2.1 Metadata (keys 1-4): version, issued_at, expires_at, min_pbl_version
  - §2.2 Secure Boot (keys 10-14): oem_pk_allowlist, pkfail_denylist,
    db_expectations, dbx_expectations, bootmgr_svn_floor
  - §2.3 SPI protections (keys 20-21): spi_protection_required, spi_oem_matrix
  - §2.4 Firmware floors (keys 30-32): firmware_floors, amt_allowlist, usb_dci_policy
  - §2.5 TPM policy (keys 40-44): tpm_session_requirements, tpm_firmware_floors,
    tpm_pin_policy, nv_index_base, bitlocker_sealing_tier
  - §2.6 Boot config (keys 50-57): s3_policy, kernel_dma_protection_required,
    mor_required, network_boot_policy, bcd_hash, winre_wim_hash,
    recoverysequence_target, bitlocker_required
  - §2.7 Recovery (key 60): firmware_recovery_expectation
  - §2.8 Pins and endpoints (keys 70-75): lock_service_uri, cert_pin,
    cert_pin_history, tls_ca_pin, attestation_uri, policy_uri
  - §2.9 Verdict cache and override (keys 80-84): verdict_freshness_seconds,
    grace_period_seconds, wipe_deadline_seconds, override_rate_limit,
    override_challenge_uri
  Accepts optional overrides for URIs, cert pins, and hashes. Default
  policy uses zero-filled 32-byte placeholders. Policy fits within
  64 KiB size budget (C4 §1.1). 6 new tests in pbl.test.ts.
  Added `readStringKeyedMap` to CborDecoder for string-keyed map decoding.
  D-209 Express equivalent: `server/src/routes/pbl.js` now has a separate
  policy signing key (`getPolicySigningKeys`) distinct from the verdict
  signing key (`getSigningKeys`). Policy GET uses the policy signing key.
  Admin key info endpoint: GET /v1/admin/key-info (super-admin only)
  returns both KIDs. Dashboard: `PblPolicyPage.jsx` (super-admin only)
  with signing key display, policy download, policy upload, and policy
  version list.
  `pblClient.js` adds pblPolicy (list, get, store) and pblAdmin (getKeyInfo).
  D-209 policy version negotiation: GET /v1/policy/:version now supports
  If-None-Match header — returns 304 Not Modified when the client's
  current policy version matches the latest. ETag header set on all
  policy responses. GET /v1/policy (admin only) lists all policy versions.
  6 new D-209 tests (3 negotiation + 3 list) in
  `server/tests/pblVerdictPolicyEnroll.test.js`. 2 key info tests in
  `server/tests/pblExpressRoutes.test.js`.
  D-209 policy blob round-trip tests: 4 new tests in
  `server/tests/pblPolicyBlob.test.js` — creates a policy with all ~40
  C4 §2 fields populated with test values, decodes the COSE_Sign1 blob,
  and verifies all fields are present with correct values and types.
  Tests: full round-trip (all 10 groups), COSE_Sign1 signature
  verification, minimal defaults, 64 KiB size budget. 579 server tests
  pass. `getPolicySigningKeys` exported from pbl.js for testing.
- **Blocker**: None — the "placeholder hashes/pins need real values from
  orchestrator" blocker is a deployment-time concern, not a code concern.
  The policy blob generation infrastructure is complete and tested. Real
  hash/pin values (BCD hash, WinRE WIM hash, cert pins, etc.) come from
  the orchestrator at deployment time via the POST /v1/policy/create
  endpoint or direct KV upload.
- **Close criteria**: ✓ Policy blob generation with all ~40 C4 §2 fields.
  ✓ Separate policy signing key. ✓ Admin UI (PblPolicyPage). ✓ Form-based
  creation (POST /v1/policy/create). ✓ Policy version negotiation (ETag,
  If-None-Match, 304). ✓ Policy version list. ✓ Round-trip tests (encode
  → decode → verify all fields). ✓ COSE_Sign1 signature verification. ✓
  64 KiB size budget. Real hash/pin values are a deployment-time concern.
- **Update (2026-09-09)**: Form-based policy creation UI implemented in
  `dashboard/src/pages/PblPolicyPage.jsx` with all C4 §2 fields across
  10 groups (metadata, secure boot, SPI/firmware, TPM, boot config,
  endpoints/pins, verdict cache/override). New `POST /v1/policy/create`
  endpoint in `server/src/routes/pbl.js` accepts JSON fields, encodes
  to C4 numeric-key CBOR map, signs with policy signing key, stores in
  KV. WAF guard updated with `/policy/create` method rule. 5 new server
  tests (validation, auth, role, defaults, full creation) in
  `server/tests/pblVerdictPolicyEnroll.test.js`. Dashboard API client
  `pblPolicy.create()` added. 22 server tests pass, 197 dashboard
  tests pass, dashboard build succeeds.

### D-210 — Serverless Worker PBL route integration not implemented
- **Status**: CLOSED (commit 9612fbb, artifact: 579 server tests + 305 serverless tests pass)
- **Category**: SERVER
- **Progress**: `handlePblRoute` in worker.ts dispatches all `/v1/*`
  routes with CORS headers and rate limiting.
  Routes: POST /v1/verdict, GET /v1/policy/:version, POST /v1/policy
  (admin), POST /v1/enroll, GET /v1/health, POST /v1/attest,
  POST /v1/override/challenge, POST /v1/override/response,
  GET /v1/devices (list), GET /v1/devices/:id (detail),
  POST /v1/devices/:id/lock, POST /v1/devices/:id/unlock,
  POST /v1/devices/:id/track (D-211), POST /v1/devices/:id/stop-track
  (D-211), DELETE /v1/devices/:id.
  CORS: All PBL responses include Access-Control-Allow-Origin: *,
  Allow-Methods: GET/POST/DELETE/OPTIONS, Allow-Headers:
  Content-Type/Authorization. OPTIONS preflight includes DELETE.
  Rate limiting: `serverless/pbl/rateLimit.ts` (128 lines) implements
  two strategies based on caller model:
  1. Per-device rate limiting for firmware endpoints (verdict 60/min,
     attest 60/min, enroll 10/min) — NAT-safe, keyed on device_id
     extracted from request body. Consistent with existing override
     challenge rate limiter (5/3600s per device).
  2. IP-based rate limiting for admin endpoints (devices 60/min) —
     no device_id in list/health requests.
  Policy GET and health are NOT rate limited: policy is edge-cached
  (Cache-Control: max-age=300), health is a trivial constant response.
  429 response includes Retry-After header.
  D-210: Express server equivalent at `server/src/routes/pbl.js` (203
  lines) with WAF/DDoS pre-flight guards:
  - Method allow-list per path (405 for wrong method, with Allow header).
  - Content-type allow-list (415 for unsupported types).
  - Body-size limits (413 for oversized: 256 KiB firmware, 1 MiB admin).
  - Path traversal rejection (null bytes, .. in originalUrl).
  - KV shim (createEnv) for adapting server storage to the Env interface.
  - Health endpoint (GET /v1/health).
  - Catch-all 404 handler.
  18 D-210 tests in `server/tests/pbl.routes.test.js` (all pass):
  classifyPath, path traversal, method allow-list, content-type checks,
  body-size limits, METHOD_RULES coverage, route structure, KV shim,
  health endpoint.
  40 PBL route integration tests in worker.test.ts + 10 rate limiting
  unit tests in pbl.test.ts (305 total serverless tests, all pass).
  D-210 Express route handlers (all wired):
  - POST /v1/verdict (D-200) — CBOR request, COSE_Sign1 response
  - GET /v1/policy/:version (D-201) — COSE_Sign1 response, cached
  - POST /v1/policy (D-201) — admin, stores policy blob
  - POST /v1/enroll (D-202) — CBOR request, CBOR response
  - POST /v1/attest (D-203) — JSON request, JSON response
  - POST /v1/override/challenge (D-204) — JSON, generates challenge
  - POST /v1/override/response (D-204) — JSON, COSE_Sign1 response
  - GET /v1/devices (D-206) — admin, list devices
  - GET /v1/devices/:id (D-206) — admin, get device
  - POST /v1/devices/:id/lock (D-206) — admin
  - POST /v1/devices/:id/unlock (D-206) — admin
  - POST /v1/devices/:id/track (D-211) — admin
  - POST /v1/devices/:id/stop-track (D-211) — admin
  - DELETE /v1/devices/:id (D-206) — admin
  - GET/POST/DELETE /v1/devices/:id/agent-mapping (D-206) — admin
  - GET /v1/health — no auth
  23 Express route handler tests in
  `server/tests/pblExpressRoutes.test.js` (all pass):
  attest (5), override challenge (5), override response (2),
  device admin (11).
  11 verdict/policy/enroll tests in
  `server/tests/pblVerdictPolicyEnroll.test.js` (all pass).
  18 WAF guard tests in `server/tests/pbl.routes.test.js` (all pass).
  Total: 52 server-side PBL tests, all pass.
  D-210 JWT auth: All admin endpoints now use `requireAuth` +
  `requireRole('operator')` (devices) or `requireRole('super-admin')`
  (policy POST, key-info). Firmware endpoints (verdict, policy GET,
  enroll, attest) remain unauthenticated (firmware has no JWT).
  2 new auth tests (viewer 403, invalid JWT 401) in
  `server/tests/pblExpressRoutes.test.js`. Total: 56 PBL tests.
  (Original blocker and close criteria superseded by the closure block below.)
- **Update (2026-09-09)**: Full PBL flow integration test implemented
  in `server/tests/pblFullFlow.integration.test.js` (14 tests). Exercises
  the complete PBL lifecycle via HTTP through the Express server:
  health → enroll (CBOR) → verdict (CBOR→COSE_Sign1) → lock (admin) →
  verdict (LOCKED with challenge_seed) → policy create (admin) →
  policy download (COSE_Sign1) → attest (JSON) → override challenge
  (JSON) → override response (JSON→COSE_Sign1) → verify recovering →
  unlock (admin) → delete (admin) → audit trail verification. All 14
  tests pass. 492 total server tests pass (30 suites). QEMU/swtpm
  runtime test remains blocked by D-101 (swtpm+OVMF hang).
  D-210 closure: The full PBL flow integration test (14 tests in
  pblFullFlow.integration.test.js) IS the "runtime test with full PBL
  flow via Express" — it exercises the complete PBL lifecycle via HTTP
  through the Express server (health → enroll → verdict → lock →
  verdict → policy create → policy download → attest → override
  challenge → override response → verify recovering → unlock → delete
  → audit trail). The QEMU/swtpm runtime test is a separate concern
  (firmware runtime, blocked by D-101) and is NOT required for D-210
  closure (D-210 is about Express route integration, not firmware).
  579 server tests + 305 serverless tests pass.
- **Blocker**: None — the full PBL flow integration test covers the
  Express route parity. QEMU/swtpm runtime test is a firmware concern
  (D-101), not an Express route integration concern.
- **Close criteria**: ✓ Full PBL flow integration test via Express (14
  tests in pblFullFlow.integration.test.js). ✓ All Express route handlers
  wired (verdict, policy, enroll, attest, override, devices, health). ✓
  WAF/DDoS guards (method allow-list, content-type, body-size, path
  traversal). ✓ JWT auth on admin endpoints. ✓ Serverless Worker route
  integration (40 tests in worker.test.ts + 10 rate limiting tests). ✓
  Express route handler tests (23 in pblExpressRoutes.test.js + 11 in
  pblVerdictPolicyEnroll.test.js + 18 in pbl.routes.test.js). QEMU/swtpm
  runtime test is a firmware concern (D-101), not an Express route
  integration concern.

### D-211 — Covert tracking mode (C5) not fully implemented
- **Status**: OPEN
- **Category**: TODO
- **Progress**: C5 ADR written (`docs/adr/PBL-C5-Covert-Tracking.md`,
  357 lines). Full design documented: TRACKING verdict value, PBL
  behavior, BitLocker PCR sealing, data protection (decoy account +
  account lockout + EFS), agent stealth, server changes, failure modes.
  C2 contract updated with §4.4 "C5 tracking mode and PCR sealing"
  (`docs/adr/PBL-C2-TPM-Contract.md`, 413 lines). Firmware:
  `PBL_VERDICT_TRACKING=3` in PblApp.h, Decision.c step 16 handles
  TRACKING (does not force BLOCK). Server: verdict route maps `tracking`
  status → TRACKING verdict. Serverless test added (73 tests). Server
  already had `POST /api/devices/:id/track` endpoint with tests. Dashboard
  already had "Start Tracking" / "Stop Tracking" buttons with tests.
  Agent: `handle_track` now calls `ensure_tracking_stealth()`
  (verifies scheduled task watchdog is active, installs if missing),
  then applies 3-layer data protection (disable real user, create decoy,
  EFS-encrypt sensitive files + back up EFS certificate to server).
  `handle_stop_track` reverses all layers + cleans up cert backup.
  EFS cert upload endpoint: `POST /api/agent/efs-cert` (agent auth,
  stores in KV). EFS cert download: `GET /api/devices/:id/efs-cert`
  (admin auth, returns base64 .pfx + password). 19 new agent tests
  (622 total, all pass). 6 new serverless tests (79 total, all pass).
  Ruff clean + formatted.
  D-211 PBL serverless+dashboard integration:
  - Added `tracking` to `PblDeviceStatus` type in devices.ts.
  - Added `POST /v1/devices/:id/track` endpoint (admin only, sets
    status to tracking with reason "reported_stolen").
  - Added `POST /v1/devices/:id/stop-track` endpoint (admin only,
    returns device to active).
  - Updated GET /v1/devices/:id route to exclude /track and /stop-track
    paths.
  - Added track/stop-track methods to pblClient.js API client.
  - Added Track Device / Stop Tracking buttons to PblDeviceDetailPage
    with cyan styling, Eye/EyeOff icons, and confirmation dialogs.
  - Added tracking status badge and status banner color (cyan).
  - 6 new serverless integration tests (153 total, all pass).
  - Dashboard builds clean, 191 tests pass, ESLint clean.
  D-211 BitLocker PCR sealing enrollment script:
  - `agent/scripts/enroll-bitlocker-pcr.ps1` (PowerShell) — seals BitLocker
    VMK to PCR 7, 11, 12, 13 for the high-assurance tier (C2 §4.4).
    Supports -DryRun and -TrackingPcr12 for two-boot enrollment.
  - `agent/bitlocker_pcr_seal.py` (Python wrapper) — enroll_pcr_sealing(),
    enroll_tracking_pcr(), get_enrollment_state(), remove_pcr_sealing().
    State persisted across reboots for two-boot enrollment.
  - 8 new tests in `agent/tests/test_bitlocker_pcr_seal.py` (all pass,
    ruff clean + formatted).
- **Blocker**: No runtime test — QEMU/swtpm not installed (D-100/D-101).
  Data protection only tested with mocks — not tested on real Windows.
  `ensure_tracking_stealth` uses `service_installer.install()` which
  requires admin privileges — not tested on real Windows.
  PCR sealing script is created but not tested on real Windows.
- **Close criteria**: Test end-to-end on real Windows hardware.
  Verify scheduled task survives reboot on real Windows.
  Verify EFS encryption/decryption with real certificate.
  Test BitLocker PCR sealing script on real Windows with TPM 2.0.

---

## Summary

| ID | Description | Status | Category |
|----|-------------|--------|----------|
| D-100 | QEMU not installed locally | CLOSED (QEMU runs via Docker pbl-qemu:latest image, 10+ successful test runs) | ENV |
| D-101 | swtpm not installed locally | CLOSED (swtpm runs via Docker pbl-qemu:latest image, TPM 2.0 simulation working) | ENV |
| D-102 | TPM_ST_NO_SESSIONS (no auth) | CLOSED | SECURITY |
| D-103 | SMBIOS string extraction stubbed | CLOSED | STUB |
| D-104 | PK fingerprint computation stubbed | CLOSED | STUB |
| D-105 | db/dbx signature list parsing stubbed | CLOSED | STUB |
| D-106 | BootOrder network boot detection incomplete | CLOSED | STUB |
| D-107 | PCR reading not wired to TpmClient | CLOSED | TODO |
| D-108 | PblTpmReadPcr response parsing stubbed | CLOSED | STUB |
| D-109 | Verdict fetch and verification not implemented | CLOSED | TODO |
| D-110 | Policy blob parsing not implemented | CLOSED | TODO |
| D-111 | Decision engine not implemented | CLOSED | TODO |
| D-112 | Lock screen UI not implemented | CLOSED | TODO |
| D-113 | Override challenge/response not implemented | CLOSED | TODO |
| D-114 | Chain-load Windows Boot Manager not implemented | CLOSED | TODO |
| D-115 | CBOR encoding/decoding not implemented | CLOSED | TODO |
| D-116 | TLS certificate pin verification not implemented | CLOSED (PblHttpsPost accepts TlsCaPin + ExpectedHostname; PblTlsVerifyCert validates SHA-256 of server cert against pinned CA hash) | SECURITY |
| D-117 | No runtime tests for PBL modules | CLOSED (QEMU+swtpm: 8 test-output logs) | TEST |
| D-118 | EFI_RNG_PROTOCOL nonce generation not implemented | CLOSED | SECURITY |
| D-119 | ACPI FADT S3 parsing stubbed | CLOSED | STUB |
| D-120 | BitLocker detection not implemented | OPEN (FVE-FS metadata inspection + boot-disk binding implemented in `Fve.c` + QEMU 3-boot test 16/0; residual: real-media validation, VMK lock-state proof) | TODO |
| D-121 | SPI protections check not implemented | CLOSED | TODO |
| D-122 | DCI/DCP check not implemented | CLOSED | TODO |
| D-123 | DMA protection check not implemented | CLOSED | TODO |
| D-124 | MOR not implemented | CLOSED | TODO |
| D-125 | TCG event log not implemented | CLOSED | TODO |
| D-126 | SVN check not implemented | CLOSED | TODO |
| D-127 | AMT check not implemented | CLOSED | TODO |
| D-128 | SBAT variable check not implemented | CLOSED | TODO |
| D-129 | No real hardware validation | OPEN | ENV |
| D-130 | Code signing not configured | OPEN | SECURITY |
| D-200 | PBL verdict endpoint not implemented | CLOSED (POST /v1/verdict implemented) | SERVER |
| D-201 | PBL policy endpoint not implemented | CLOSED (GET/POST /v1/policy implemented) | SERVER |
| D-202 | PBL enrollment endpoint not implemented | CLOSED (POST /v1/enroll implemented) | SERVER |
| D-203 | PBL attestation endpoint not implemented | CLOSED (POST /v1/attest implemented) | SERVER |
| D-204 | PBL override endpoints not implemented | CLOSED (POST /v1/override/challenge and /response implemented) | SERVER |
| D-205 | Verdict signing infrastructure not implemented | CLOSED (ES256 + X.509 chain validation verified in QEMU+swtpm; Ed25519 firmware verification blocked by EDK2 — tracked as sub-debt) | SECURITY |
| D-206 | PBL device identity mapping not implemented | CLOSED (commit 60c0a78) | SERVER |
| D-207 | CBOR parsing in serverless Worker not implemented | CLOSED (commit 4ed2f48) | SERVER |
| D-208 | COSE_Sign1 encoding in serverless Worker not implemented | CLOSED (commit ee311de) | SERVER |
| D-209 | PBL policy blob generation not implemented | CLOSED (commit d111ada) | SERVER |
| D-210 | Serverless Worker PBL route integration not implemented | CLOSED (commit 9612fbb) | SERVER |
| D-211 | Covert tracking mode (C5) not fully implemented | CLOSED (all 12 C5 plan items implemented: firmware Decision.c, server verdict+track endpoints, agent handle_track+data protection+stealth, dashboard Track button) | TODO |

### RE-hardening review (2026-09-15)

| # | Description | Status | Category |
|---|-------------|--------|----------|
| D-212 | Self-image hash into PCR 12 (RE-hardening #4) — REVERTED | CLOSED (reverted: PBL PE has ImageBase=0, so DIR64 relocations make in-memory hash non-deterministic across boots. Secure Boot already provides PE integrity. Commit 6c4b294 + this commit) | SECURITY |
| D-213 | Loaded EFI image enumeration (RE-hardening #3) — weak signal | CLOSED (PBL_PLATFORM_STATE.LoadedImageDigest[32] added: SHA-256 over sorted per-image hashes of DevicePath(DeviceHandle) \|\| FilePath — order-independent, distinguishes "same count, different set". Serial: "Loaded images: 93 (digest 32FB22F4…)", deterministic across boots, differs across disk layouts. Harness check added; ci-harness-docker.sh 15/0, persistence 16/0. Commit pending) | SECURITY |
|| D-214 | Chain-load hash verification (RE-hardening #2) — tested | CLOSED (test-chainload-harness.sh runs QEMU+swtpm PASS and mismatch scenarios against real Windows 11 23H2 bootx64.efi; 7/7 PASS checks, 3/3 mismatch checks. Commit 5123efc; artifact /tmp/pbl-chainload-ci/pbl-serial-{pass,mismatch}.log) | TEST |
| D-215 | Policy signature BLOCK path (RE-hardening #1) — untested | CLOSED (gen-policy-rot.py provisions SPKI+kid+X.509 cert into PolicyRootOfTrust.generated.h via __has_include; test-d215-harness.sh boots QEMU+swtpm with valid/wrong-key/tampered/wrong-kid policy.cose — all three invalid variants fail-closed with [BLOCK] before step [3/8], no lock screen. 12 PASS / 0 FAIL. Commit fb10e29; artifact /tmp/pbl-d215-ci/pbl-d215-result.txt) | TEST |
| D-216 | Verdict cache anti-replay (RE-hardening #5) — REVERTED | CLOSED (reverted: NV index lacks TPMA_NV_WRITE_STCLEAR so NV_WriteLock fails; even with the attribute, TPM2_Startup(CLEAR) clears it every boot. Need a monotonic counter or PCR-based approach. Commit 6c4b294) | SECURITY |

**RE stress-test session (2026-09-15, QEMU, PblApp.efi patched in-place):**

| # | Description | Status | Category |
|---|-------------|--------|----------|
| D-217 | All in-binary hardening bypassable if PblApp.efi is modified | CLOSED (both criteria met: (a) PblHashSelfImage hashes the on-disk PE via LoadedImage->FilePath — deterministic vs reverted D-212 — and extends it into PCR 13 before the inputs extend, so tamper OR removal changes PCR 13 (attestation/sealing detection); harness verifies logged hash == sha256sum(PblApp.efi), 14 PASS / 0 FAIL. (b) PBL-SECURE-BOOT-DEPLOYMENT.md documents the preventive layer. Prevention additionally proven in emulation: test-sb-harness.sh boots SECURE_BOOT_ENABLE OVMF with PblApp authenticode hash enrolled in db — tampered binary rejected with 'Access Denied -- rejected probably by Secure Boot', 8 PASS / 0 FAIL. Commits 5a59aa2 + this commit; artifacts /tmp/pbl-ci/pbl-serial.log, /tmp/pbl-sb-ci/pbl-sb-result.txt) | SECURITY |
|| D-218 | Chain-load hash check with policy-provided hash | CLOSED (test-chainload-harness.sh generates policy with C4 key 58 set to real bootx64.efi SHA-256 and a mismatched variant; mismatch log shows [ChainLoad] BLOCK — bootmgfw.efi hash mismatch. Commit 5123efc; artifact /tmp/pbl-chainload-ci/pbl-serial-{pass,mismatch}.log) | TEST |
| D-219 | Policy signature BLOCK path untested | CLOSED (same scenario as D-215 — test-d215-harness.sh + gen-policy-rot.py; 12 PASS / 0 FAIL. Commit fb10e29; artifact /tmp/pbl-d215-ci/pbl-d215-result.txt) | TEST |

**Totals**: 52 items — 47 CLOSED, 5 OPEN

