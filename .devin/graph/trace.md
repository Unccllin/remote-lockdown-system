# trace.md — Cross-Session Context Trace

> This file persists context across agent sessions. Every session starts by
> reading this file and ends by appending a session-end status block.
>
> **Graph invariant I4**: `assert_session_closed_with_trace()` enforces that
> the session-end block includes all required sections.

---

## Session 2026-09-15: Direct reverse-engineering of Windows 11 23H2 boot artifacts

### RULE-ZERO
- **Read:** `.devin/graph/GRAPH-SPEC.yaml`, `.devin/graph/current-state.md`, `docs/adr/PBL-DEBT-LEDGER.md`, `docs/research/windows-firmware-lockdown-research.md`
- **Finding:** The active task was to obtain a real Windows 11 ISO and analyze `bootmgfw.efi` and BCD. Prior work (RE-hardening) had left D-214/D-218/D-219 untested and D-120 stale. The UUP Dump `btwiuse/uupdump` Docker image is outdated for 24H2; a third-party direct ISO mirror is faster but must be verified by volume label and PE/BCD structure.

### Fog cleared
- Acquired `Win11_23H2_English_x64v2.iso` (6,812,706,816 bytes) from `cdn.as212934.net` using `aria2c` multi-connection download.
- Extracted ISO with `7z` in an Alpine container; volume label `CCCOMA_X64FRE_EN-US_DV9` confirms a genuine Windows 11 23H2 x64 retail image.
- Extracted `efi/boot/bootx64.efi` (UEFI boot manager), `bootmgr.efi`, and `efi/microsoft/boot/bcd`.
- PE/COFF analysis via `pefile`:
  - `bootx64.efi`: ImageBase `0x10000000`, EntryPoint `0x24320`, 6 sections, certificate table at file offset `0x19ac00` (PKCS#7 type `0x0002`).
  - `bootmgr.efi`: ImageBase `0x140000000`, EntryPoint `0x23544`.
- Disassembled entry point with Capstone; confirmed real code at `0x10024320`.
- Dumped BCD to `.reg` with `reged` (from `chntpw`) inside `btwiuse/uupdump` container; decoded objects and PBL-relevant elements.
- Strings analysis found BitLocker/FVE, Secure Boot policy files (`SecureBootPolicy.p7b`, `SecureBootUnlockToken.pol`, `SecureBootDebugPolicy.pol`), debug/testsigning options (`NOINTEGRITYCHECKS`, `TESTSIGNING`, `BOOTDEBUG`), and hypervisor/VHD tokens.
- Determined that BCD contains boot configuration and recovery sequence lists, but the actual BitLocker locked/unlocked state is in FVE volume metadata and the TPM, not in BCD.
- Created `docs/research/windows-11-23h2-iso-RE-findings.md` with extraction commands, hashes, BCD decode, and PBL implications.
- Updated `docs/adr/PBL-DEBT-LEDGER.md`: D-120 corrected from CLOSED to OPEN, with note that BCD-only detection is insufficient. Totals updated: 42 CLOSED, 10 OPEN.
- Added `tmp/` to `.gitignore` to prevent accidental staging of the 6+ GB ISO.
- Committed research findings: `0e23ff6`.

### Fog remaining
- The `boot.wim` extracted from the ISO cannot be parsed by `wimlib` (`invalid XML data`), so the installed `bootmgfw.efi` inside `boot.wim` was not obtained. `bootx64.efi` is the best available representative.
- The ISO SHA-256 (`a3cc...`) does not match the widely published `36de...` 2024 refresh hash, because this is the 2023-12 build. Integrity is otherwise confirmed by volume label and internal PE/BCD structure.
- `docs/research/windows-firmware-lockdown-research.md` still contains older secondary research; a cross-reference can be added later.

### Debt items closed
- None closed by code. D-120 was *re-opened* after findings invalidated its CLOSED status.

### Debt items still open
- D-120 — BitLocker detection: OPEN (BCD parsing exists but BCD alone cannot determine lock state; needs FVE volume metadata).
- D-213 — Loaded EFI image enumeration: OPEN (weak signal).
- D-214 — Chain-load hash verification: OPEN (real `bootx64.efi` now available for PASS-verdict test).
- D-215 — Policy signature BLOCK path: OPEN.
- D-218 — Chain-load hash with policy-provided `bootmgr_hash`: OPEN (can now be tested with this artifact).
- D-219 — Policy signature BLOCK path with provisioned root of trust: OPEN.
- D-217 — In-binary hardening bypassable if PblApp.efi is modified: OPEN.
- D-129 — Real hardware validation: OPEN.
- D-130 — Code signing: OPEN.

### Blockers named and status
- No external blockers. The UUP Dump path is outdated for 24H2; direct ISO mirror worked but is unofficial. Microsoft official consumer ISO automation (Mido/Fido) is currently broken due to API changes.

### Failure attribution
- No failures. The first `uupdump` 24H2 attempt produced only package ESDs with no metadata ESD because the container converter is too old for the aggregated UUP format; this was a tool limitation, not a task failure. Pivoted to a direct ISO mirror.

### Next session opening
Run a QEMU PASS-verdict test with the extracted `bootx64.efi` on the ESP and a PBL policy containing the correct `bootmgr_hash`, then extend `PlatformState.c` to parse BCD elements (tests/signing/debug/hypervisor flags) into the platform-state digest.

---

## Session: 2026-09-15 — QEMU PASS/mismatch chain-load test with real Windows 11 23H2 boot manager

### Task
The previous session's next-session-opening was: "Run a QEMU PASS-verdict test with the extracted `bootx64.efi` on the ESP and a PBL policy containing the correct `bootmgr_hash`, then extend `PlatformState.c` to parse BCD elements." This session executed the first part: a reproducible PASS/mismatch chain-load test against the real Windows UEFI boot manager.

### RULE-ZERO — Understanding logged before code changes
- **Read**: `.devin/graph/current-state.md` — next session opening was the QEMU chain-load test; D-214 and D-218 open.
- **Read**: `.devin/graph/GRAPH-SPEC.yaml` — current node is RULE-ZERO/IMPLEMENT for the PBL enforcement path; session lifecycle must end with CLOSE-DEBT.
- **Read**: `docs/adr/PBL-DEBT-LEDGER.md` — D-214 (chain-load hash verification untested) and D-218 (hash check with policy-provided `bootmgr_hash` untested) were the relevant open items.
- **Read**: `firmware/PblPkg/PblApp/ChainLoad.c` — `PblChainLoadWindows` already reads `bootmgfw.efi`, hashes it with SHA-256, compares against `Policy->BootMgrHash` (C4 key 58), and uses `LoadImage`/`StartImage`.
- **Read**: `firmware/PblPkg/PblApp/Decision.c` — policy decision requires `DbHasWindowsUefiCa2023`, `DbxHasMs2011Revocation`, `KernelDmaProtection`, `MorRequested`, `BitLockerEnabled`, and `NetworkBootEntriesPresent == FALSE` for PASS.
- **Read**: `firmware/PblPkg/test-d205.py` — policy generator already supports `--bootmgr-hash`; `--generate-keys` overwrote existing keys on every call, breaking verdict signature verification.
- **Read**: `firmware/PblPkg/test-chainload-harness.sh` — existing draft used system OVMF, `e1000` with missing `efi-e1000.rom`, and did not configure a PBL-friendly Secure Boot variable store.
- **Finding**: The chain-load code and policy generator were already in place, but no automated test reached `PblChainLoadWindows` with a real Windows boot manager and a matching `bootmgr_hash`. The main gap was a working QEMU/OVMF fixture, not new firmware code.

### Fog cleared
1. **Reproducible PASS-verdict chain-load test**: `firmware/PblPkg/test-chainload-harness.sh` now:
   - Computes the whole-file SHA-256 of the real Windows 11 23H2 `bootx64.efi` (`a20b359849cdd4ae847cc1bff219b5a3343a80bcd50d8207bc16d6eeec0cdfbc`).
   - Generates `policy-pass.cose` and `policy-mismatch.cose` with C4 key 58 set to the correct and an altered hash.
   - Uses the local EDK2 OVMF build (`/home/cllin/.local/src/edk2/Build/OvmfX64/RELEASE_GCC/FV/OVMF_CODE.fd`) which does not instantiate PXE/HTTP boot entries, avoiding `NetworkBootEntriesPresent == TRUE`.
   - Prepares `OVMF_VARS_pbl.fd` with `virt-fw-vars`: `SecureBoot=1`, `SetupMode=0`, Microsoft db/dbx, a dummy dbx X.509 cert, and `MemoryOverwriteRequestControl=1`.
   - Runs QEMU+swtpm inside the `pbl-qemu:latest` container with `virtio-net-pci` and `-device intel-iommu`.
   - Captures serial logs to `/tmp/pbl-chainload-ci/pbl-serial-pass.log` and `pbl-serial-mismatch.log`.

2. **PASS run output** (7/7 checks pass):
   - `Decision: PASS — chain-loading Windows`
   - `[ChainLoad] bootmgfw.efi: 1692144 bytes`
   - `[ChainLoad] bootmgfw.efi hash verified (policy key 58)`
   - `[ChainLoad] StartImage failed: Invalid Parameter`
   The `StartImage` failure is expected: the ISO `bootx64.efi` is not in a complete installed-Windows environment, but PBL successfully found, hashed, loaded, and attempted to start it.

3. **Mismatch run output** (3/3 checks pass):
   - `Decision: PASS — chain-loading Windows`
   - `[ChainLoad] BLOCK — bootmgfw.efi hash mismatch!`
   - Refused to call `StartImage` because the computed hash did not match the altered policy key 58.

4. **test-d205.py fix**: `--generate-keys` now calls `load_key_and_cert()` instead of `generate_key_and_cert()`, making it idempotent so the policy and mock server use the same key pair.

5. **Commit/ledger updates**:
   - Commit `5123efc` adds `test-chainload-harness.sh`, `test-d205.py` idempotent key loading, `DmaProtection.c` DMAR fallback, and `PlatformState.c` MOR collection.
   - Commit `ae4affa` updates `docs/adr/PBL-DEBT-LEDGER.md`: D-214 and D-218 marked CLOSED with `commit_ref 5123efc` and `artifact_ref /tmp/pbl-chainload-ci/pbl-serial-{pass,mismatch}.log`.

### Fog remaining
- **BCD parsing into platform-state digest**: not implemented this session. `test-chainload-harness.sh` still appends the raw BitLocker recovery GUID to the BCD as a test scaffold; D-120 remains open until FVE volume metadata or proper BCD parsing replaces the byte scan.
- **Policy signature BLOCK path (D-215) and provisioned-root path (D-219)**: not tested; still require a CI scenario with an invalid/unsigned `policy.cose` and a provisioned root of trust.
- **D-217**: In-binary hardening is bypassable if `PblApp.efi` is modified. This session did not add runtime self-integrity from disk; Secure Boot remains the only practical defense.
- **D-213**: Loaded-EFI-image count is still a weak signal (count only, no image names/hashes).

### Debt items closed
- **D-214**: Chain-load hash verification (RE-hardening #2) — CLOSED. commit_ref `5123efc`; artifact_ref `/tmp/pbl-chainload-ci/pbl-serial-pass.log` and `pbl-serial-mismatch.log`.
- **D-218**: Chain-load hash check with policy-provided `bootmgr_hash` — CLOSED. commit_ref `5123efc`; same artifact refs.

### Debt items still open
- D-120 — BitLocker detection (BCD byte scan is a scaffold; needs FVE or proper BCD parsing).
- D-213 — Loaded EFI image enumeration is a weak signal.
- D-215 — Policy signature BLOCK path untested.
- D-217 — In-binary hardening bypassable by modifying PblApp.efi.
- D-219 — Policy signature BLOCK path with provisioned root of trust untested.
- D-129 — No real hardware validation for PBL.
- D-130 — Code signing not configured for PblApp.efi.

### Blockers
- No external blockers. The test is self-contained and uses the extracted Windows 11 23H2 ISO under `tmp/winre/Win11Extract` (6.3 GB, gitignored).

### Failure attribution
- No session failures. The first `test-chainload-harness.sh` run failed verdict signature verification because `--generate-keys` overwrote the key pair after policy generation; this was a **Layer 4 (Verification feedback)** issue in the test harness, fixed by making `--generate-keys` idempotent.

### Test results
- PBL build: RELEASE_GCC, 1,335,296 bytes, SHA-256 `a5b820bf3791be53935533b0b8dfb7bed3aac0f1665962a64fb6e281eb472a56`.
- `test-chainload-harness.sh --timeout 90`: PASS 7/7, mismatch 3/3.
- Serial logs: `/tmp/pbl-chainload-ci/pbl-serial-pass.log` (2,257 bytes), `/tmp/pbl-chainload-ci/pbl-serial-mismatch.log` (4,994 bytes).
- `make graph-check`: (run after close-session).

### Next session opening
Implement BCD parsing in `PlatformState.c` to fold PBL-relevant boot configuration (debug, testsigning, hypervisor, WinPE, timeout, display order, recovery sequence) into the platform-state digest, and test it with the extracted Windows 11 23H2 BCD under the same QEMU harness.

---

## Session 2026-09-16: BCD registry parser for PBL platform-state digest

### RULE-ZERO — Understanding logged before code changes
- **Read**: `firmware/PblPkg/PblApp/PblApp.h` — `PBL_PLATFORM_STATE` has `BcdHash[32]`, `WinreWimHash[32]`, `BitLockerEnabled`, and the new BCD summary fields (object count, timeout, debug/testsigning/hypervisor/WinPE flags, display/recovery/inherit counts).
- **Read**: `firmware/PblPkg/PblApp/PlatformState.c` — `PblCollectBcdState` (renamed from `PblCollectBitLockerState`) reads `\EFI\Microsoft\Boot\BCD`, then calls `PblBcdParse()` and does a raw 16-byte GUID scan for the BitLocker recovery GUID.
- **Read**: `docs/research/windows-11-23h2-iso-RE-findings.md` — BCD is a Windows registry hive; boot objects live under `Objects\{guid}\Elements\{element_id}\` with a value named `Element`; relevant IDs include `16000010` (BootDebug), `16000048` (NoIntegrityChecks), `16000049` (TestSigning), `25000004` (Timeout), `250000C2` (BootMenuPolicy), `26000022` (WinPE), `24000001` (DisplayOrder), `24000010` (RecoverySequence).
- **Read**: `firmware/PblPkg/test-chainload-harness.sh` — the test harness appends the BitLocker recovery GUID to the BCD copy, so `BitLockerEnabled` remains true; the parser must not crash on the 16 extra bytes and must use the header's declared HBIN size as its upper bound.
- **Finding**: The parser must implement a bounded, minimal Windows registry hive walker (REGF header → HBIN cells → root key → `Objects` → object-GUID → `Elements` → element-ID → `Element` value) and fail safely if any cell offset, list type, or value data is out of bounds or unsupported.
- **Finding**: BitLocker locked/unlocked state is NOT in the BCD (it lives in FVE volume metadata), so `BitLockerEnabled` stays on the GUID scan for now and D-120 should be updated to reflect that only BCD parsing is complete, not BitLocker state detection.

### IMPLEMENT — What changed
- **Created** `firmware/PblPkg/PblApp/Bcd.c`: bounded Windows registry hive parser (REGF header, HBIN cells, `nk`/`vk` records, `lf`/`lh`/`li` subkey lists, `Objects` → object → `Elements` → element → `Element` value dispatch).
- **Updated** `firmware/PblPkg/PblApp/PblApp.h`: added BCD summary fields to `PBL_PLATFORM_STATE` and declared `PblBcdParse()`.
- **Updated** `firmware/PblPkg/PblApp/PblApp.inf`: added `Bcd.c` to the build.
- **Updated** `firmware/PblPkg/PblApp/PlatformState.c`: renamed `PblCollectBitLockerState` to `PblCollectBcdState`, calls `PblBcdParse()`, and keeps the raw BitLocker recovery GUID scan as a heuristic.
- **Updated** `docs/adr/PBL-DEBT-LEDGER.md` D-120: reflects that full BCD parsing is now implemented and tested, but BitLocker true lock state still requires FVE volume metadata + TPM.

### VERIFY — Evidence
- **Build**: PBL RELEASE_GCC X64, 1343488 bytes, SHA-256 `e1cda018e07b4f6b5d0009ce39839e3e3a4a6b035fb8df35b33a7f26df8f65a5`.
- **Test**: `firmware/PblPkg/test-chainload-harness.sh --timeout 90` with the real Windows 11 23H2 `bootx64.efi` and BCD:
  - PASS scenario: 7/7 checks (verdict verified, hash verified, `StartImage` attempted as expected).
  - Mismatch scenario: 3/3 checks (hash mismatch blocked chain-load).
- **BCD parser serial output** (PASS log):
  `[Bcd] objects=9 timeout=0x1E BootDebug=0 TestSigning=0 NoIntegrityChecks=0 Debug=0 WinPE=1 SafeMode=0 DetectHal=1 DispAdv=0 OptEdit=0 EMS=0 BootMenuPolicy=0x01 HVLaunch=0xFF HVDebugEn=0x00 HVDebugType=0x01 DisplayOrder=1 RecoverySeq=1 Inherit=7`
- **Verification sweep**: `make graph-check` all invariants pass; `make verify-env` 61 PASS / 0 FAIL / 1 SKIP.

### ARTIFACT — Run references
- Serial log (PASS): `/tmp/pbl-chainload-ci/pbl-serial-pass.log`
- Serial log (mismatch): `/tmp/pbl-chainload-ci/pbl-serial-mismatch.log`
- Build output: `/home/cllin/.local/src/edk2/Build/PblPkg/RELEASE_GCC/X64/PblApp.efi` (copied to `firmware/PblPkg/PblApp.efi`)
- Commit: `9dc07a4`

### Debt items closed
- **D-120** — not fully closed.  Advanced: full BCD structural parsing implemented and tested; raw GUID scan preserved; true BitLocker locked/unlocked state still requires FVE volume metadata and TPM state.  `commit_ref 9dc07a4`; `artifact_ref /tmp/pbl-chainload-ci/pbl-serial-pass.log`, `/tmp/pbl-chainload-ci/pbl-serial-mismatch.log`.

### Fog cleared this session
- Real Windows 11 23H2 BCD is parsed defensively in QEMU without crashing, even with the test-harness BitLocker GUID appended beyond the hive's declared HBIN extent.
- Deterministic BCD boot configuration (debug/testsigning/hypervisor/WinPE/timeout/display/recovery/inherit) now feeds the platform-state digest.
- The parser's upper-bound design (header HBIN size, not file size) prevents trailing bytes from being treated as part of the registry.

### Fog remaining
- **True BitLocker lock/unlock state**: BCD parsing is a measurement, not proof. FVE volume metadata and TPM state still needed (D-120).
- **D-213**: Loaded-EFI-image count is still a weak signal (count only, no image names/hashes).
- **D-215 / D-219**: Policy signature fail-closed paths (invalid/unsigned policy and provisioned root of trust) remain untested.
- **D-217**: In-binary hardening is bypassable if `PblApp.efi` is modified; Secure Boot / code signing (D-130) still the real defense.
- **D-129 / D-130**: Real hardware validation and code signing not done.

### Debt items closed
- None fully closed this session. D-120 was advanced with evidence but remains OPEN pending FVE/TPM BitLocker state detection.

### Debt items still open
- D-120 — BCD parsing done, true BitLocker state not yet.
- D-213 — Loaded EFI image count is a weak signal.
- D-215 — Policy signature BLOCK path untested.
- D-217 — In-binary hardening bypassable without Secure Boot.
- D-219 — Provisioned-root policy signature path untested.
- D-129 — No real hardware validation.
- D-130 — Code signing not configured.

### Blockers
- No external blockers. The test is self-contained and uses the extracted Windows 11 23H2 ISO under `tmp/winre/Win11Extract` (6.3 GB, gitignored).

### Failure attribution
- No session failures. The parser's first build compiled cleanly with `-Werror`, and the QEMU harness exercised both the PASS and mismatch paths. The BCD hash matches the expected `6e0611d2...` SHA-256 of the original hive.

### Test results
- PBL build: RELEASE_GCC, 1343488 bytes, SHA-256 `e1cda018e07b4f6b5d0009ce39839e3e3a4a6b035fb8df35b33a7f26df8f65a5`.
- `test-chainload-harness.sh --timeout 90`: PASS 7/7, mismatch 3/3.
- Serial logs: `/tmp/pbl-chainload-ci/pbl-serial-pass.log`, `/tmp/pbl-chainload-ci/pbl-serial-mismatch.log`.
- `make graph-check`: all invariants pass.
- `make verify-env`: 61 PASS / 0 FAIL / 1 SKIP.

### Next session opening
Implement true BitLocker volume lock-state detection by inspecting FVE metadata on the encrypted volume and/or TPM PCR state, or test the policy-signature fail-closed paths (D-215/D-219) with an invalid `policy.cose` and a provisioned root of trust.

---

## Session 2026-09-16: UEFI 2.10 and PI study (Source 1)

### RULE-ZERO — Understanding logged before code changes
- **Read**: `.devin/graph/current-state.md` — previous BCD parser session closed; open items include D-120, D-213, D-215/D-219, D-129, D-130.
- **Read**: `.devin/skills/memory/SKILL.md` — retrieve/capture/consolidate workflow.
- **Read**: `AGENTS.md` — session lifecycle, Rule Zero, mandatory graph reads.
- **Read**: `/tmp/uefi-spec-release` — official UEFI 2.10 reStructuredText source from UEFI Forum GitHub.
- **Read**: TianoCore PI Boot Flow and UEFI & PI FAQ wikis (cloned to `/tmp/tianocore-wiki` and `/tmp/tianocore-wiki-new`).
- **Finding**: The UEFI 2.10 spec defines the firmware-to-OS interface (system table, boot/runtime services, protocols, image loading, variables, Secure Boot) but not the PI phases (SEC/PEI/DXE/BDS). Those are documented in the PI Specification and the EDK II/TianoCore wiki.

### IMPLEMENT — What changed
- **Created** `docs/research/STUDY-UEFI-SPEC-2.10.md`: consolidated technical note covering UEFI 2.10 architecture, image model, system table, boot/runtime services, loaded-image protocol, device paths, media access, variables, Secure Boot, status codes, and a PI boot-flow supplement.
- **Self-test** added to the note with 10 questions and 2 uncertain follow-up areas.

### VERIFY — Evidence
- The source tree `/tmp/uefi-spec-release` was inspected; relevant `.rst` sections are listed in the note.
- The tianocore wiki repos were cloned and the `PI-Boot-Flow` and `UEFI & PI FAQ` pages were read and summarized.
- No build or code changes were made; the note is the primary artifact.

### ARTIFACT — Run references
- `docs/research/STUDY-UEFI-SPEC-2.10.md` — structured UEFI/PI study note.

### Debt items closed
- No debt items closed. This is a research/knowledge-building session only.

### Fog cleared this session
- UEFI 2.10 service and protocol surface directly relevant to PBL (image loading, device paths, file system, variables, Secure Boot) is now captured in a retrievable note.
- PI boot phases (SEC → PEI → DXE → BDS → TSL → RT → AF) are documented, with PBL's execution window identified as BDS/TSL.
- The distinction between UEFI interface spec and PI implementation spec is explicit.

### Fog remaining
- **PI Specification** — official UEFI.org PI PDFs are behind Cloudflare and could not be downloaded in this environment. Need to revisit if an open mirror or authenticated copy becomes available.
- **EDK2 BDS implementation** — exactly how `BdsDxe` selects and starts PBL from `Boot####` variables remains to be traced in EDK2 source.
- **EFI_RT_PROPERTIES_TABLE** on target hardware/OVMF is unresolved.

### Debt items still open
- D-120, D-213, D-215, D-217, D-219, D-129, D-130 (unchanged; this session was study only).

### Blockers
- uefi.org direct access blocked by Cloudflare; PI PDF not retrievable. Mitigated by using TianoCore wiki and EDK2 source.

### Failure attribution
- No failures. A subagent was used to draft the UEFI note from the spec source; the output was reviewed and augmented with PI content.

### Test results
- N/A (research session).

### Next session opening
Begin **Source 2: EDK II** — study the EDK II reference implementation, focusing on `PblPkg` build integration, image loading (`DxeCore` PE/COFF loader, `LoadImage`/`StartImage`), `BdsDxe` boot option dispatch, `UefiBootManagerLib`, and the protocols PBL consumes.

---

## Session: 2026-09-16 (cont.) — EDK II reference implementation and PBL build study (Source 2)

### RULE-ZERO — Understanding logged before code changes
- **Read**: `.devin/graph/current-state.md` — previous UEFI 2.10 study closed, next session opening was "Source 2: EDK II" (PblPkg build, image loading, BdsDxe, UefiBootManagerLib, PBL protocols).
- **Read**: `AGENTS.md` — session lifecycle, Rule Zero, mandatory graph reads, memory harness.
- **Read**: `.devin/skills/memory/SKILL.md` — retrieve/capture workflow.
- **Read**: `docs/research/STUDY-UEFI-SPEC-2.10.md` — UEFI 2.10 service/protocol surface from the previous study.
- **Read**: `firmware/PblPkg/` — `build-pbl.sh`, `PblPkg.dsc`, `PblPkg.fdf`, `PblPkg.dec`, `PblApp/PblApp.inf`, and source (`PblApp.c`, `PblApp.h`, `PlatformState.c`, `Bcd.c`, `ChainLoad.c`, `Policy.c`, `Decision.c`, `Verdict.c`, `CborEncode.c`, `CborDecode.c`, `HttpsClient.c`, `TlsVerify.c`, `TpmClient.c`, `ForceReloc.c`).
- **Read**: EDK II source at `/home/cllin/.local/src/edk2` — `edksetup.sh`, `BaseTools/BuildEnv`, `BaseTools/BinWrappers/PosixLike/build`, `MdePkg/Include/Uefi/UefiSpec.h` and `UefiBaseType.h`, `MdeModulePkg/Core/Dxe/DxeMain/DxeMain.c`, `MdeModulePkg/Core/Dxe/Image/Image.c`, `MdeModulePkg/Universal/BdsDxe/BdsEntry.c`, `MdeModulePkg/Library/UefiBootManagerLib/BmBoot.c` and `BmLoadOption.c`, `SecurityPkg/Library/DxeImageVerificationLib/DxeImageVerificationLib.c`, `MdePkg/Library/BasePeCoffLib/BasePeCoff.c`, `NetworkPkg/NetworkComponents.dsc.inc` and `HttpDxe`/`TlsDxe`, `OvmfPkg/OvmfPkgX64.dsc` and `OvmfPkg/Tcg/OvmfTpmDefines.dsc.inc`.
- **Read**: TianoCore wiki clone at `/tmp/tianocore-wiki-new` — build tooling page and PI boot-flow page.
- **Finding**: PBL is built as a standalone UEFI application by adding `firmware/PblPkg` to `PACKAGES_PATH`; the EDK II build tool resolves package paths and compiles the module described by `PblApp.inf`. Image loading is implemented by `MdeModulePkg/Core/Dxe/Image.c` with `PeCoffLoaderLoadImage`/`RelocateImage` from `BasePeCoffLib`; the Security2 architectural protocol is invoked before the PE/COFF image is loaded. BDS uses `UefiBootManagerLib` to parse `Boot####`/`BootOrder` and dispatch via `LoadImage`/`StartImage`. PBL consumes `EFI_TCG2_PROTOCOL`, `EFI_HTTP_PROTOCOL`/`EFI_HTTP_SERVICE_BINDING_PROTOCOL`, `EFI_TLS_PROTOCOL`, and file-system/text protocols; these must be included in the platform DSC and dispatched.

### IMPLEMENT — What changed
- **Created** `docs/research/STUDY-EDK2.md`: structured EDK II study note with exact requested headings (Source, overview, 10–20 key facts, glossary, security implications, PBL relevance, pitfalls, cross-references, outstanding questions, self-test).
- The note cites specific EDK II and PBL source file paths and line numbers.

### VERIFY — Evidence
- Source tree `/home/cllin/.local/src/edk2` was inspected for build environment, DXE core, image loader, BDS, Secure Boot, PE/COFF, and network stack.
- Project PBL package `/home/cllin/remote-lockdown-system/firmware/PblPkg` was inspected for build script, DSC/INF metadata, and application source.
- No EDK2 or PBL build was run. No source code was modified.

### ARTIFACT — Run references
- `docs/research/STUDY-EDK2.md` — structured EDK II / PBL study note.

### Debt items closed
- No debt items closed. This is a research/knowledge-building session only.
- Understanding logged in the note advances the foundation for PBL debt items D-109 (verdict flow), D-110 (policy parsing), D-111 (decision engine), D-112 (lock screen), D-114 (chain-load), D-115 (CBOR), D-116 (TLS pinning), D-120 (BitLocker detection), D-129 (hardware validation), and D-130 (code signing).

### Fog cleared this session
- EDK II build system layout (`edksetup.sh`, `build` wrapper, `WORKSPACE`, `PACKAGES_PATH`, `.dsc`, `.dec`, `.inf`, `.fdf`, `.dsc.inc`).
- PBL build integration: `build-pbl.sh` appends `firmware/PblPkg` to `PACKAGES_PATH` and runs `build -p PblPkg/PblPkg.dsc`; OVMF is pre-built with network and TPM flags.
- DXE core image lifecycle (`LoadImage`/`StartImage`/`Exit`/`UnloadImage`) and PE/COFF loading/relocation in `MdeModulePkg/Core/Dxe/Image.c` and `BasePeCoffLib`.
- Secure Boot verification call path: `DxeImageVerificationLib` registers via `RegisterSecurity2Handler` and is called by `CoreLoadImageCommon` before the image is fully loaded; it checks `db`/`dbx` against the PE/COFF certificate table and image hash.
- BDS and `UefiBootManagerLib` flow: `BdsEntry` → `Boot####`/`BootOrder` parsing in `BmLoadOption.c` → `EfiBootManagerBoot` in `BmBoot.c` → `gBS->LoadImage` and `gBS->StartImage`.
- PBL source architecture: platform-state collection, BCD parsing, policy/verdict/COSE, CBOR, TPM raw commands, HTTPS/TLS, chain-loading `bootmgfw.efi`, and the text-mode lock screen.
- Network/TLS and OVMF: `NetworkPkg/NetworkComponents.dsc.inc` lists `TcpDxe`, `HttpDxe`, `TlsDxe` etc.; OVMF X64 DSC enables them with `NETWORK_HTTP_ENABLE`, `NETWORK_TLS_ENABLE`, `TPM2_ENABLE`, and related flags.
- PBL's `.reloc` compatibility fix: `PblPkg.dsc` adds `-fno-lto` and `ForceReloc.c` ensures a relocation section for HP/Insyde BIOS.

### Fog remaining
- **Package resolution order**: EDK II tree also has a `PblPkg` at `/home/cllin/.local/src/edk2/PblPkg` (containing `MarkerTest.c`/`Recovery.c`). It is unclear whether `build` resolves packages left-to-right in `PACKAGES_PATH` and whether this can shadow the project `firmware/PblPkg`.
- **Tcg2 protocol producer in OVMF**: `OvmfPkgX64.dsc` lists `SecurityPkg/Tcg/Tcg2Dxe` under `TPM2_ENABLE`, but also `OvmfPkg/Tcg/TdTcg2Dxe` under `CC_MEASUREMENT_ENABLE`. The exact component that installs `EFI_TCG2_PROTOCOL` in the PBL OVMF build needs confirmation.
- **Image execution table installation**: `DxeImageVerificationLib` adds entries on verification failure/defer, but the exact `InstallConfigurationTable` call for `EFI_IMAGE_EXECUTION_INFO_TABLE` was not found in the reviewed source.
- **PBL signing status after build**: The build script copies `PblApp.efi` directly; no in-build signing step was found. Production signing is described in `CODE-SIGNING-GUIDE.md` but the default artifact is unsigned until signed by the deployer.

### Debt items still open
- PBL debt items D-109, D-110, D-111, D-112, D-114, D-115, D-116, D-120, D-129, D-130 remain open. This session did not close any debt items.

### Blockers
- None.

### Failure attribution
- No failures. This was a source-study and documentation session.

### Test results
- N/A (research session; no build or test run).

### Next session opening
Resolve the four EDK II/PBL source gaps (package-resolution order, Tcg2 protocol producer, image-execution table installation, and post-build signing status), or begin implementing PBL debt items D-109/D-110/D-111/D-114 using the understanding captured in the new EDK II study note.

---

## Session 2026-09-16: TCG TPM 2.0 Library Specification and PBL TPM/PCR/NV study (Source 3)

### RULE-ZERO — Understanding logged before code changes
- **Read**: `.devin/graph/current-state.md` — previous EDK II study closed; next session opening was "Source 3: TCG TPM 2.0".
- **Read**: `AGENTS.md` — session lifecycle, Rule Zero, memory harness.
- **Read**: `.devin/skills/memory/SKILL.md` — retrieve/capture workflow.
- **Read**: `docs/research/STUDY-UEFI-SPEC-2.10.md` and `docs/research/STUDY-EDK2.md` — UEFI/EDK II context for `EFI_TCG2_PROTOCOL` and image build.
- **Read**: PBL architecture docs `docs/adr/PBL-C2-TPM-Contract.md` and `docs/adr/PBL-C4-Policy-Blob.md`.
- **Read**: PBL TPM source `firmware/PblPkg/PblApp/TpmClient.c`, `TpmSession.c`, `TcgLog.c`, `PblApp.h`, `PblApp.c`.
- **Finding**: The TCG TPM 2.0 Library Specification v1.85 is available locally from the vendored go-sdk-vtpm2 repo (`/tmp/go-sdk-vtpm2/docs/spec/v185/`). The TCG PC Client PTP PDF is behind Cloudflare.

### IMPLEMENT — What changed
- **Created** `docs/research/STUDY-TPM-2.0.md`: structured TPM 2.0 study note covering architecture, command/response, PCR, NV, sealing, attestation, HMAC/policy sessions, locality, `EFI_TCG2_PROTOCOL`, and PBL-specific implementation gaps.
- No code changes or builds were run.

### VERIFY — Evidence
- Vendored spec text files (`Part-0.txt` through `Part-3.txt`) were searched and read.
- PBL TPM source and EDK2 `Tcg2Protocol.h` / `Tcg2Dxe.c` were inspected.
- Note includes 20 facts, glossary, security implications, PBL relevance, 10 pitfalls, 8 outstanding questions, and 10 self-test Q/A.

### ARTIFACT — Run references
- `docs/research/STUDY-TPM-2.0.md` — structured TPM 2.0 / PBL study note.

### Debt items closed
- None. This is a research/knowledge-building session.

### Debt items still open
- D-102 — `TpmClient.c` uses `TPM_ST_NO_SESSIONS` fallback (C2 requires HMAC sessions).
- D-118 — `EFI_RNG_PROTOCOL` nonce generation not implemented.
- D-120 — BitLocker detection not implemented.
- D-125 — TCG event log not implemented.
- Plus other PBL debt items (D-109/D-110/D-111/D-114/D-116/D-129/D-130).

### Fog cleared this session
- TPM 2.0 command/response wire format, big-endian, `TPM_ST_NO_SESSIONS` vs `TPM_ST_SESSIONS`, HMAC and policy session mechanics.
- PCR extend-only semantics, PCR banks, and the difference between `TPM2_PCR_Read` and `TPM2_PCR_Extend` authorization.
- NV index attributes, platform vs. owner hierarchy, and `TPM2_Clear` survival rules.
- Sealing is `TPM2_Create`/`CreatePrimary` with `sensitive.data` + `authPolicy`, then `TPM2_Load`/`Unseal`, not a standalone `TPM2_Seal` command.
- PBL uses `EFI_TCG2_PROTOCOL->SubmitCommand` and raw HMAC sessions; PCR 12 (decision) and PCR 13 (inputs) are PBL's extension targets.
- The current PBL implementation has real gaps: `TcgLog.c` is a stub, the no-session PCR-extend fallback is not spec-valid on real TPMs, OVMF uses owner hierarchy instead of platform hierarchy for NV indices, and NV index Name caching may be stale.

### Fog remaining
- TCG PC Client Platform TPM Profile (PTP) PDF is Cloudflare-gated; TIS/CRB register-level transport and canonical event-log format not reviewed from the primary source.
- Exact target BitLocker PCR profile on real hardware; PBL has no runtime detection yet (D-120).
- How PBL will provision platform-hierarchy, platform-created NV indices on real hardware with a non-empty platform `authValue`.

### Blockers
- None.

### Failure attribution
- No failures. A background subagent was used to draft the note from the vendored spec text and PBL source; the output was reviewed and found accurate.

### Test results
- N/A (research session).

### Next session opening
**Source 4: Intel platform security material** — study Intel Boot Guard, Intel TXT, Intel PTT/ME architecture, and how they form the firmware-rooted trust boundary that PBL relies on for non-bricking, tamper-evident enforcement.

---

---

## Session 2026-09-16: Intel platform security — Boot Guard, TXT, PTT/CSME, and PBL platform-state checks (Source 4)

### RULE-ZERO — Understanding logged before code changes
- **Read**: `.devin/graph/current-state.md` — previous TPM 2.0 study closed; next session opening was "Source 4: Intel platform security".
- **Read**: `AGENTS.md` — session lifecycle, Rule Zero, memory harness, debt-ledger caveat.
- **Read**: `.devin/skills/memory/SKILL.md` — retrieve/capture workflow.
- **Read**: `docs/research/STUDY-UEFI-SPEC-2.10.md`, `docs/research/STUDY-EDK2.md`, `docs/research/STUDY-TPM-2.0.md` — UEFI/EDK II/TPM context.
- **Read**: PBL architecture `docs/adr/PBL-C4-Policy-Blob.md` and `docs/adr/PBL-DEBT-LEDGER.md`.
- **Read**: PBL platform-state source `firmware/PblPkg/PblApp/PblApp.h`, `PlatformState.c`, `SpiProtections.c`, `DciCheck.c`, `DmaProtection.c`, `Mor.c`, `Svn.c`, `AmtCheck.c`, `Sbat.c`, `Decision.c`.
- **Finding**: Authoritative Intel sources for the study were downloaded/converted to text:
  - `Safeguarding rootkits: Intel BootGuard` (2016 reverse-engineering paper).
  - Intel TXT MLE Developer’s Guide (315168-005).
  - Intel TXT Enabling Guide.
  - Intel Trusted Execution Technology white paper.
  - Intel Platform Trust Technology white paper.
  - Intel Converged Security and Management Engine (CSME) Security Technical White Paper.
- **Finding**: `PBL-DEBT-LEDGER.md` has an internal inconsistency: the summary table (ll. 1306–1313) marks `D-121..D-128` as CLOSED, while the detailed debt sections (ll. 488–588) still list them as OPEN with blockers/close criteria. No change was made to the ledger in this research session; the note uses the detailed (open) state because the code is implemented but not validated on hardware.

### IMPLEMENT — What changed
- **Created** `docs/research/STUDY-INTEL-PLATFORM-SECURITY.md`: structured study note covering Intel Boot Guard, TXT, PTT/CSME, and PBL’s indirect platform-state checks.
- No code changes or builds were run.

### VERIFY — Evidence
- Six Intel PDFs were downloaded and text-extracted to `/tmp/intel-docs/`.
- PBL source and ADRs were inspected.
- Note includes 22 facts, glossary, security implications, PBL relevance, 8 pitfalls, 7 outstanding questions, and a 10-question self-test.

### ARTIFACT — Run references
- `docs/research/STUDY-INTEL-PLATFORM-SECURITY.md` — structured Intel platform security / PBL study note.
- Downloaded/extracted sources: `/tmp/intel-docs/{bootguard,txt_mle2,txt_enabling,txt_whitepaper,ptt,csme}.txt`.

### Debt items closed
- None. This is a research/knowledge-building session.

### Debt items still open
- D-121 — SPI protections: implemented in `SpiProtections.c`, needs real hardware validation.
- D-122 — DCI/DCP: implemented in `DciCheck.c`, needs real hardware validation.
- D-123 — DMA protection: implemented in `DmaProtection.c`, needs real hardware validation.
- D-124 — MOR: implemented in `Mor.c`, needs MOR lock bit and validation.
- D-125 — TCG event log: implemented in `TcgLog.c`, needs proper event log writing.
- D-126 — SVN: implemented in `Svn.c`, needs Authenticode parsing.
- D-127 — AMT: implemented in `AmtCheck.c`, needs HECI protocol.
- D-128 — SBAT: implemented in `Sbat.c`, needs relevance determination.
- D-129 — no real hardware validation.
- D-130 — code signing not configured.

### Fog cleared this session
- Intel Boot Guard roots in CPU microcode/ROM and ME/CSME FPFs; modes are measured, verified, or combined; FIT at `0xFFFFFFC0` points to ACM, Key Manifest, IBBM; IBB is verified before the legacy reset vector.
- Intel TXT provides DRTM via SMX, `GETSEC[SENTER]`, SINIT ACM, MLE; uses TPM PCRs 17-23; protects MLE with DPR and VT-d PMR; LCP is stored in TPM NV.
- Intel PTT is a firmware TPM 2.0 inside CSME/ME; CSME is an isolated PCH subsystem with its own ROM, secure boot, anti-rollback, and AMT.
- PBL’s checks (`SpiProtections.c`, `DciCheck.c`, `DmaProtection.c`, `Mor.c`, `Svn.c`, `AmtCheck.c`, `Sbat.c`) are indirect UEFI/ACPI/PCI signals and cannot directly inspect fused Boot Guard policy, CSME state, or TXT launch state.

### Fog remaining
- Whether a stable pre-boot HECI/MHKI command can read real AMT provisioning and Boot Guard/CSME configuration.
- Which PCH/SKU variants need different SPI controller layouts and HSFS bit definitions.
- Whether `GETSEC[CAPABILITIES]` and TXT public config space (`FED30000`) can be probed by a UEFI application.
- How to reconcile the `PBL-DEBT-LEDGER.md` summary table (closed) with the detailed sections (open).

### Blockers
- None for the study itself.

### Failure attribution
- No failures. The source-extraction command ran cleanly; PyPDF2 produced text from all six PDFs.

### Test results
- N/A (research session).

### Next session opening
**Source 5: Windows NT internals / ReactOS / authorized Microsoft documentation** — study Windows kernel architecture, executive subsystems, boot sequence, HAL, PE/COFF loading, and how PBL’s pre-OS assumptions interact with Windows after `ExitBootServices()`.

---

---

## Session 2026-09-15: Windows NT internals / ReactOS / PBL pre-OS trust boundary (Source 5)

### RULE-ZERO — Understanding logged before code changes
- **Read**: `.devin/graph/current-state.md` — previous Intel platform security study closed; next session opening was Source 5: Windows NT internals.
- **Read**: `AGENTS.md` — session lifecycle, Rule Zero, memory harness, graph invariants.
- **Read**: `.devin/skills/memory/SKILL.md` — retrieve/capture workflow.
- **Read**: `.devin/graph/GRAPH-SPEC.yaml` and `docs/adr/GRAPH-SPEC.md` — session lifecycle and node types.
- **Read**: `docs/adr/PBL-DEBT-LEDGER.md` — D-120, D-213-D-219 remain open; D-120 advanced but still needs FVE/TPM BitLocker state.
- **Read**: `docs/adr/PBL-C4-Policy-Blob.md` — C4 keys 50-58 (BCD hash, winre.wim hash, bitlocker required, bootmgr hash).
- **Read**: `docs/research/windows-11-23h2-iso-RE-findings.md` — `bootx64.efi` PE/COFF, certificate table, BCD element list, BitLocker/FVE, chain-load findings.
- **Read**: `docs/research/windows-firmware-lecture.md` — Lectures 1.4, 4.1, 4.5, 4.7-4.8, 5.1-5.5, 9.3, 9.8-9.9, 14.4.
- **Read**: PBL source `firmware/PblPkg/PblApp/ChainLoad.c`, `PblApp.h`, `PlatformState.c`, `Decision.c`.
- **Read**: ReactOS source `/tmp/reactos/ntoskrnl/` (ke, ex, ob, ps, mm, io, config, se), `/tmp/reactos/hal/halx86/`, and `/tmp/reactos/sdk/include/`.
- **Finding**: ReactOS provides an open-source, historical NT-compatible reference for the kernel/executive/HAL layout, system-call dispatch, PE/COFF relocation, and loader block, but it is not authoritative for modern Windows 10/11.
- **Finding**: Microsoft Learn and the local RE/lecture notes are the authoritative modern sources; the note must clearly distinguish ReactOS from Windows and from PBL assumptions.
- **Note on Rule Zero timing**: The draft note was produced as a continuation of a previous research thread before this session's formal Rule Zero block was appended. Source inspection and cross-checking were performed during drafting; the note was then re-read against the ReactOS line ranges and Microsoft Learn pages, and one citation (`cmcontrl.c:101-154`) was corrected to `102-154` before closing.

### IMPLEMENT — What changed
- **Created** `docs/research/STUDY-WINDOWS-NT-INTERNALS.md`: consolidated study note covering NT architecture (user/kernel, executive, HAL, system calls, trap frames, `PreviousMode`), executive subsystems (Object, Memory, I/O, Process/Thread, Configuration, Security Reference Monitor), Windows boot sequence (`bootmgfw.efi` → BCD → `winload.efi` → `ntoskrnl` → `smss` → `services`/`lsass` → `winlogon` → `explorer`), PE/COFF headers/sections/data directories/imports/relocations, Windows security boundaries (tokens, SIDs, ACLs, UAC, VBS/HVCI, Credential Guard), and PBL's pre-OS trust boundary.
- No code or build changes were made.

### VERIFY — Evidence
- ReactOS source paths were read and 22 facts were cross-checked against concrete file/line ranges.
- Microsoft Learn pages were checked for user/kernel mode, `PreviousMode`, Nt/Zw, PE/COFF, BCD, boot sequence, VBS/HVCI, and Credential Guard.
- The note was validated for:
  - 10 required section headings present.
  - 22 numbered facts (within the 18-22 requirement).
  - 10 self-test questions with answers and confidence.
  - No leaked-source references.
- ReactOS and PBL line ranges spot-checked against actual files; one citation was corrected.

### ARTIFACT — Run references
- `docs/research/STUDY-WINDOWS-NT-INTERNALS.md` — structured Windows NT internals / PBL study note.
- ReactOS checkout at `/tmp/reactos` used as open-source reference.
- Local notes: `docs/research/windows-11-23h2-iso-RE-findings.md`, `docs/research/windows-firmware-lecture.md`.

### Debt items closed
- None. This is a research/knowledge-building session.

### Debt items still open
- D-120 — BitLocker detection: BCD parsing exists, true lock state requires FVE volume metadata and/or TPM state.
- D-213 — Loaded EFI image enumeration is a weak signal.
- D-215 — Policy signature BLOCK path untested.
- D-217 — In-binary hardening bypassable if `PblApp.efi` is modified.
- D-219 — Provisioned-root policy signature path untested.
- D-129 — No real hardware validation for PBL.
- D-130 — Code signing not configured.

### Fog cleared this session
- NT user mode vs. kernel mode is enforced by hardware rings, `KTRAP_FRAME`, and `PreviousMode`; system calls dispatch through `KeServiceDescriptorTable`.
- The executive is initialized in phase 0 (`ExpInitializeExecutive`) and phase 1 (`Phase1InitializationDiscard`), with HAL, Object Manager, Memory Manager, I/O Manager, Process/Thread Manager, Configuration Manager, and SRM each having phase-specific init routines.
- `winload.efi` builds a `LOADER_PARAMETER_BLOCK` and passes it to `KiSystemStartup`; from there the kernel creates the initial `System` process and starts `smss.exe`.
- PE/COFF base relocations are required when an image cannot load at `ImageBase`; relocation type/offset nibbles in `.reloc` are processed by `LdrRelocateImageWithBias`. A stripped-reloc image (`IMAGE_FILE_RELOCS_STRIPPED`) must load at its preferred base or fail.
- PBL hashes the `bootmgfw.efi` file buffer before `LoadImage` (C4 key 58) because the in-memory loaded image may be relocated and therefore not hash-stable.
- After `ExitBootServices()`, UEFI Boot Services disappear and Windows owns the platform; PBL's lock/chain decision and platform-state attestation must be finalized before `gBS->StartImage`.

### Fog remaining
- How PBL can measure `winload.efi`, `ntoskrnl.exe`, `hal.dll`, and boot-start drivers from the UEFI pre-OS environment (BCD path + volume access + BitLocker).
- Whether a PE32+ parser can extract the code-only region of `bootmgfw.efi` excluding the certificate table for a stable attestation hash.
- How to read BitLocker FVE volume metadata and PCR state in UEFI for true lock-state detection.
- Interaction of PBL's own lock-screen/graphics code with `ExitBootServices()` on real hardware.
- How to reconcile the `PBL-DEBT-LEDGER.md` summary table (closed D-121..D-128) with the detailed sections (still open).

### Blockers
- None for the study itself.

### Failure attribution
- Rule Zero was logged after the initial file write because this session was a continuation of a previous thread. No technical failures occurred during validation, but the harness state (graph session boundary) should be made explicit at the start of continuation threads. Layer: state management. Fix: always start a new `SESSION-START`/`RULE-ZERO` block before resuming a continuation.

### Test results
- N/A (research session).

### Next session opening
**Test the Windows NT chain-load findings with a real `bootmgfw.efi`/`winload.efi` in QEMU/OVMF, or implement PE/COFF code-only hash extraction and BCD element parsing to advance D-120/D-214/D-218.**

---

---

## Session 2026-09-16: UEFI bootkit and firmware-rootkit case studies (Source 6)

### RULE-ZERO — Understanding logged before code changes
- **Read**: `.devin/graph/current-state.md` — previous Windows NT internals study closed; next session opening was Source 6: LoJax/MoonBounce/UEFI bootkit case studies.
- **Read**: `AGENTS.md` — session lifecycle, Rule Zero, memory harness, graph invariants.
- **Read**: `.devin/skills/memory/SKILL.md` — retrieve/capture workflow.
- **Read**: `docs/adr/PBL-C4-Policy-Blob.md` — policy fields for boot-manager hash, BCD, SPI, Secure Boot.
- **Read**: `docs/adr/PBL-DEBT-LEDGER.md` — D-120, D-129, D-130, D-212..D-219 context.
- **Read**: PBL source `firmware/PblPkg/PblApp/ChainLoad.c`, `PlatformState.c`, `Decision.c`, `SpiProtections.c`, `PblApp.c`.
- **Finding**: Public ESET, Kaspersky, and Binarly reports are the authoritative defensive sources for LoJax, MosaicRegressor, MoonBounce, CosmicStrand, BlackLotus, and LogoFAIL/Bootkitty. A Binarly HTML page is JS-only and was not usable as source text.
- **Finding**: These case studies are the direct threat model for PBL’s loaded-image enumeration, `bootmgr_hash` chain-load verification, SPI protection checks, BCD parsing, and PCR 12/13 attestation.

### IMPLEMENT — What changed
- **Created** `docs/research/STUDY-UEFI-BOOTKITS.md`: consolidated defensive case-study note covering LoJax, MosaicRegressor, MoonBounce, CosmicStrand, BlackLotus, LogoFAIL, and Bootkitty, plus PBL relevance and mitigations.
- No code or build changes were made.

### VERIFY — Evidence
- Downloaded and text-extracted public reports to `/tmp/bootkit-docs/`:
  - `lojax.txt` (ESET PDF)
  - `moonbounce.txt` (Kaspersky PDF)
  - `mosaicregressor.txt` (Kaspersky blog + technical PDF)
  - `cosmicstrand.txt` (Kaspersky Securelist blog)
  - `blacklotus_eset.txt` (ESET/WeLiveSecurity blog)
- Note includes 20 facts, glossary, security implications, PBL relevance, 10 pitfalls, 10 outstanding questions, and a 10-question self-test.
- All findings are defensive only; no malware source was obtained or used.

### ARTIFACT — Run references
- `docs/research/STUDY-UEFI-BOOTKITS.md` — structured UEFI bootkit defensive study note.
- `/tmp/bootkit-docs/{lojax,moonbounce,mosaicregressor,cosmicstrand,blacklotus_eset}.txt` — extracted public report text.

### Debt items closed
- None. This is a research/knowledge-building session.

### Debt items still open
- D-120 — BitLocker/FVE true lock state.
- D-129 — no real hardware validation.
- D-130 — code signing not configured.
- D-212..D-219 — chain-load/PE hardening and policy signature fail-closed tests.

### Fog cleared this session
- LoJax: SPI flash DXE driver `SecDxe` persists across disk replacement, uses `READY_TO_BOOT` callback, modifies `BootExecute`.
- MosaicRegressor: reuses Hacking Team `VectorEDK`, four malicious UEFI modules, drops `IntelUpdate.exe` to Startup folder.
- MoonBounce: patches `CORE_DXE`, hooks `EFI_BOOT_SERVICES` (`AllocatePool`, `CreateEventEx`, `ExitBootServices`), in-memory chain to Windows kernel and `svchost.exe`.
- CosmicStrand: hooks chain from UEFI `HandleProtocol` through `winload.efi` to `ntoskrnl.exe` `ZwCreateSection`, C2 payload, local admin `aaaabbbb`.
- BlackLotus: ESP-resident, bypasses Secure Boot via CVE-2022-21894 and attacker MOK enrollment, disables VBS/HVCI/Defender.
- LogoFAIL: UEFI image-parser vulnerabilities in boot logos; may execute before PBL.
- PBL mitigations: `bootmgr_hash` (C4 key 58), loaded-image count, SPI protection bits, BCD flag parsing, PCR 12/13, fail-closed policy/verdict signatures.

### Fog remaining
- How to detect ESP-resident bootkits when `bootmgr_hash` is missing or stale.
- Practical `dbx`/SVN baseline for Baton Drop mitigation.
- False-positive rate of `LoadedImageCount` and whether per-image hashes are feasible.
- Whether PBL can detect LogoFAIL image-parser exploitation before it runs.
- How PBL can verify `MokList` or Secure Boot variable integrity from UEFI.

### Blockers
- None for the study itself.

### Failure attribution
- No failures. The Binarly `binarly_bootkit.html` was JS-only and could not be extracted; this was documented as a source gap and LogoFAIL/Bootkitty coverage was supplemented from web-fetched Binarly/ESET pages.

### Test results
- N/A (research session).

### Next session opening
**Source 7: Academic papers on UEFI bootkits, firmware persistence, and TPM attestation** — search USENIX, NDSS, IEEE/ACM, arXiv for peer-reviewed technical treatments of the same attack surface and defenses.

---

---

## Session 2026-09-16: Academic UEFI and firmware security (Source 7)

### RULE-ZERO — Understanding logged before code changes
- **Read**: `.devin/graph/current-state.md` — Source 7 (academic papers on UEFI bootkits / TPM attestation) was the next pending study.
- **Read**: `AGENTS.md` — session lifecycle, Rule Zero, memory harness, graph invariants.
- **Read**: `.devin/skills/memory/SKILL.md` — retrieve/capture workflow.
- **Read**: `docs/research/STUDY-UEFI-SPEC-2.10.md` — UEFI services, variables, Secure Boot, capsule updates.
- **Read**: `docs/research/STUDY-EDK2.md` — DXE dispatcher, image loading, BDS, relevant to Peacock hook points.
- **Read**: `docs/research/STUDY-TPM-2.0.md` — PCR extension, HMAC sessions, `EFI_TCG2_PROTOCOL`.
- **Read**: `docs/research/STUDY-UEFI-BOOTKITS.md` — LoJax/MoonBounce/CosmicStrand/BlackLotus context that the academic papers formalize and detect.
- **Read**: PBL source `firmware/PblPkg/PblApp/PblApp.c`, `PblApp.h`, `PlatformState.c`, `Decision.c`, `ChainLoad.c`, `SpiProtections.c`, `Sbat.c`.
- **Read**: `docs/adr/PBL-C1-LockVerdict.md`, `PBL-C2-TPM-Contract.md`, `PBL-C3-Network-Client.md`, `PBL-C4-Policy-Blob.md`, `PBL-DEBT-LEDGER.md`.
- **Finding**: Academic literature systematizes what the case-study note observed: static Secure Boot is insufficient, runtime hooking and signed-but-vulnerable binaries are major gaps, and detection requires pre-OS observability (Peacock), memory forensics (UEFIMemDump/UEFIDumpAnalysis), and hardware-backed attestation with RIM/RIV/golden measurements (TCG FIM, NIST 800-155, RFC 9683).

### IMPLEMENT — What changed
- **Created** `docs/research/STUDY-ACADEMIC-FIRMWARE-SECURITY.md`: consolidated academic and standards-body study note covering the UEFI SoK, Peacock, UEFI Memory Forensics, vTPM/fTPM, TLS+attestation, NIST 800-155, TCG FIM, RFC 9683, BootHole, BYOVD, and Secure Boot bypass research, plus PBL relevance and mitigations.
- No firmware or build code was changed.

### VERIFY — Evidence
- Fetched and text-extracted arXiv HTML for:
  - `SoK: Security Below the OS -- A Security Analysis of UEFI` (`/tmp/devin-overflows-1000/cbfa3a73/content.txt`)
  - `Peacock: UEFI Firmware Runtime Observability Layer for Detection and Response` (`/tmp/devin-overflows-1000/bcb8e444/content.txt`)
  - `UEFI Memory Forensics: A Framework for UEFI Threat Analysis` (`/tmp/devin-overflows-1000/27c0f2df/content.txt`)
- Note includes 24 numbered facts, glossary, security implications, PBL relevance, 10 pitfalls, 8 outstanding questions, and a 10-question self-test.
- All findings are defensive; no malware source code or sample repositories were accessed.

### ARTIFACT — Run references
- `docs/research/STUDY-ACADEMIC-FIRMWARE-SECURITY.md` — structured academic UEFI/firmware-security study note.
- `/tmp/devin-overflows-1000/{cbfa3a73,bcb8e444,27c0f2df}/content.txt` — extracted arXiv HTML text used as source.

### Debt items closed
- None. This is a research/knowledge-building session.

### Debt items still open
- D-120 — BitLocker/FVE true lock state.
- D-129 — no real hardware validation.
- D-130 — code signing not configured.
- D-212..D-219 — chain-load/PE hardening and policy signature fail-closed tests.

### Fog cleared this session
- SoK UEFI risk analysis places malicious boot-loader/payload/driver injection, SMM exploitation, physical attacks, UEFI security-policy alteration, bootkit installation, and Secure Boot bypass in the highest risk tier.
- Peacock demonstrates a practical UEFI runtime-observability and attestation architecture: DXE agent logs service calls, OS Agent creates TPM-attested bundle, Analysis Server correlates and detects Glupteba/BlackLotus/LoJax/MosaicRegressor.
- UEFI Memory Forensics (`UEFIMemDump` + `UEFIDumpAnalysis`) detects function-pointer hooks, inline hooks, malicious image loading, and gadget-based control-flow manipulation in volatile UEFI memory.
- MoonBounce is the canonical inline-hooking example: patches `AllocatePool`, `CreateEventEx`, `ExitBootServices` prologues while the Boot Services Table pointers may remain unchanged.
- NIST 800-155 / TCG FIM / RFC 9683 define the formal trust and measurement chain: RTM → event log → PCR quote → signed RIM/golden measurements → verifier appraisal policy.
- BootHole (CVE-2020-10713) and BYOVD-style attacks show that a signed but vulnerable bootloader or driver can defeat Secure Boot, so PBL policy must enforce `dbx` and SVN expectations, not just the `SecureBoot` variable.
- "Separate but Together" argues that remote attestation and TLS must be cryptographically linked, which is relevant to PBL's verdict fetch.

### Fog remaining
- How PBL, as a UEFI application loaded after DXE, can collect Peacock-like runtime logs without being a firmware modification.
- Practical per-platform baselines for `LoadedImageCount`/GUID whitelists and false-positive rates.
- How to obtain or build TCG RIM/golden measurements without OEM cooperation.
- How to bind PBL's HTTPS verdict channel to the device attestation identity.
- Whether PBL can safely perform a pre-OS memory dump for incident response.

### Blockers
- None for the study itself.

### Failure attribution
- No failures. Some full PDFs were not systematically extracted; the note uses arXiv HTML extracts and web-fetched abstracts and marks this as a source gap.

### Test results
- N/A (research session).

### Next session opening
**Source 8: Conference talks on firmware security** — collect talks from Black Hat, REcon, CanSecWest, UEFI Forum, and DEF CON on UEFI implants, bootkits, platform security, and EDK II development, with priority to talks that provide defensive engineering lessons and hardware measurement techniques.

---

---

## Session 2026-09-16: Conference talks on firmware security (Source 8)

### RULE-ZERO — Understanding logged before code changes
- **Read**: `.devin/graph/current-state.md` — Source 8 (conference talks on firmware security) was the next pending study.
- **Read**: `AGENTS.md` — session lifecycle, Rule Zero, memory harness, graph invariants.
- **Read**: `.devin/skills/memory/SKILL.md` — retrieve/capture workflow.
- **Read**: `docs/research/STUDY-UEFI-SPEC-2.10.md` — UEFI services, Secure Boot, variables.
- **Read**: `docs/research/STUDY-EDK2.md` — DXE/BDS image loading and Secure Boot verification.
- **Read**: `docs/research/STUDY-TPM-2.0.md` — PCRs, attestation, `EFI_TCG2_PROTOCOL`.
- **Read**: `docs/research/STUDY-INTEL-PLATFORM-SECURITY.md` — Boot Guard, BIOS Guard, SPI, SMM, PTT.
- **Read**: `docs/research/STUDY-UEFI-BOOTKITS.md` — LoJax/MoonBounce/BlackLotus context.
- **Read**: `docs/research/STUDY-ACADEMIC-FIRMWARE-SECURITY.md` — SoK/Peacock/UEFI Memory Forensics context.
- **Read**: PBL source `firmware/PblPkg/PblApp/PblApp.c`, `PblApp.h`, `PlatformState.c`, `Decision.c`, `ChainLoad.c`, `SpiProtections.c`, `DmaProtection.c`, `Mor.c`, `Sbat.c`.
- **Read**: `docs/adr/PBL-C4-Policy-Blob.md`, `PBL-C3-Network-Client.md`, `PBL-DEBT-LEDGER.md`.
- **Finding**: Conference talks from Black Hat, REcon, CanSecWest, DEF CON, and the UEFI Forum document real UEFI rootkit infection chains, S3/Option ROM attacks, Secure Boot implementation bypasses, SMM MitM of firmware scanners, and supply-chain key-management failures (PKfail, leaked keys). These are the empirical counterpart to the academic and case-study notes.

### IMPLEMENT — What changed
- **Created** `docs/research/STUDY-FIRMWARE-SECURITY-TALKS.md`: consolidated conference-talk study note covering Black Hat, REcon, CanSecWest, DEF CON, OffensiveCon, and UEFI Forum presentations, plus PBL relevance and mitigations.
- No firmware or build code was changed.

### VERIFY — Evidence
- Searched and web-fetched public conference abstracts and slide-extracted text for:
  - Matrosov Black Hat Asia 2017 / OffensiveCon 2018.
  - Haukli Black Hat USA 2014.
  - Bulygin Black Hat USA 2017 and 2013.
  - Hudson/Kovah/Kallenberg ThunderStrike 2 (DEF CON 23 / Black Hat 2015).
  - Korchok Wakulich REcon 2024 (GOP Complex).
  - Haruyama REcon 2022 (Anti-Firmware Forensics).
  - Kovah/Butterworth/Kallenberg CanSecWest 2014/2017.
  - UEFI Forum plugfest 2018 / 2020 best-practices presentations.
  - Binarly UEFI 2025 DevCon (BYOVD and key-management talks).
- Note includes 20 facts, glossary, security implications, PBL relevance, 10 pitfalls, 10 outstanding questions, and a 10-question self-test.
- All findings are defensive; no malware code or samples were accessed.

### ARTIFACT — Run references
- `docs/research/STUDY-FIRMWARE-SECURITY-TALKS.md` — structured conference-talk study note.

### Debt items closed
- None. This is a research/knowledge-building session.

### Debt items still open
- D-120 — BitLocker/FVE true lock state.
- D-129 — no real hardware validation.
- D-130 — code signing not configured.
- D-212..D-219 — chain-load/PE hardening and policy signature fail-closed tests.

### Fog cleared this session
- UEFI rootkit infection chain: userland → kernel → SMM → SPI flash (Matrosov).
- ThunderStrike 2: first Mac firmware worm; reuses Speed Racer, Darth Venamis, PrinceHarming/Snorlax, unsigned Option ROMs; key finding that EDK2/EFI vulnerabilities are portable across OS and hardware.
- S3 resume script and Option ROMs are recurring, practical high-privilege attack surfaces.
- Secure Boot can be bypassed by implementation oversights, writable variables, or signed vulnerable components; "Secure Boot enabled" does not equal "pre-OS trusted."
- SMM rootkits can MitM software-based firmware acquisition, making OS/UEFI-shell scanners untrustworthy without SMM isolation.
- CHIPSEC provides open-source checks for SMRAM, S3 boot script, SPI lock, Secure Boot variables, and firmware-volume fingerprints.
- Supply-chain key-management failures (PKfail, leaked PPAM certs, inconsistent dbx) are a dominant 2024–2025 attack path.
- BYOVD taxonomy for Secure Boot bypass: double-use modules, trusted-but-vulnerable modules, leaked keys, verification-logic bugs, debug/incomplete features.

### Fog remaining
- Whether PBL can detect SMM-based MitM of its own platform-state reads.
- Practical per-platform baseline for loaded images and Option ROM hashes.
- How PBL should respond to known OEM-specific SPI/SMM protection oversights.
- How quickly PBL's policy channel can push new dbx/SBAT/bootmgr_hash mitigations.

### Blockers
- None for the study itself.

### Failure attribution
- No failures. Some PDF slide decks were not systematically extracted; the note relies on web-search-extracted slide text and con-page abstracts and marks this as a source gap.

### Test results
- N/A (research session).

### Next session opening
**Source 9: Research blogs and EDK II implementation pitfalls** — study Binarly, ESET, Kaspersky Securelist, TianoCore/EDK II bug trackers, and technical post-mortems on UEFI/EDK II deployment failures, PE/COFF `.reloc`/LTO issues, pre-boot TLS, and boot-device discovery.

---

---

## Session 102 — Research blogs and EDK II implementation pitfalls

**Rule Zero:**
- **Read:** `AGENTS.md`, `.devin/graph/current-state.md`, `PBL-DEBT-LEDGER.md`, `docs/research/STUDY-FIRMWARE-SECURITY-TALKS.md`, `firmware/PblPkg/PblPkg.dsc`, `firmware/PblPkg/PblApp/ForceReloc.c`, `firmware/PblPkg/PblApp/ChainLoad.c`, `firmware/PblPkg/PblApp/Decision.c`.
- **Finding:** Last pending source was "Research blogs and EDK II implementation pitfalls." PBL already carries a `.reloc`/LTO workaround (`-fno-lto`, `ForceReloc.c`) and an HTTPS verdict client, so the source list directly intersects existing code.

**Fog cleared this session:**
- Created `docs/research/STUDY-RESEARCH-BLOGS-EDK2-PITFALLS.md` synthesizing Binarly research (UEFI bootkit hunting, LogoFAIL, PKfail, Bootkitty), ESET/Kaspersky reports (BlackLotus, MoonBounce, CosmicStrand, MosaicRegressor), and EDK II/TianoCore implementation pitfalls (`.reloc`/LTO, `GenFw` `GOTPCRELX`, HTTPS boot TLS caveats, BDS boot-device discovery, `BasePeCoffLib` relocation, `DxeImageVerificationLib`/`dbx` semantics).
- Confirmed PBL's `ForceReloc.c` and `-fno-lto` in `PblPkg.dsc` are the correct, documented response to the EDK II `.reloc` generation pitfall (source: `firmware/PblPkg/PblPkg.dsc` lines 28–33 and `firmware/PblPkg/PblApp/ForceReloc.c`).
- Linked PBL features to research findings: `bootmgr_hash` and BCD parsing counter boot-manager replacement (`ChainLoad.c`), `Decision.c` `db`/`dbx`/SetupMode checks counter PKfail/BYOVD, `Sbat.c` counters BootHole/Bootkitty, `LoadedImageCount` is a weak signal compared with Binarly's code-similarity approach.
- Captured memory to `sess-102.md`.

**Debt items closed:**
- None (research-only session).

**Debt items still open:**
- D-120, D-129, D-130, D-212–D-219 (unchanged; see `PBL-DEBT-LEDGER.md`).

**Fog remaining:**
- Binarly blog pages are JS-only/Cloudflare-gated; full primary text was not retrieved. The note relied on search-extracted snippets, public advisories, ESET/Kaspersky reports, and EDK II source/issues.
- Some TianoCore report PDFs (LogoFAIL 6-month, PKfail report) were not downloaded and fully parsed.
- No code changes, no build/test runs; research-only verification.

**Next session opening:**
- The formal study list is now complete. The next session should either return to implementation (e.g., policy-signature fail-closed tests D-215/D-219 or `LoadedImageCount` enrichment D-213) or consolidate the nine study notes into a cross-cutting technical index and update `AGENTS.md` / memory index if needed.

### ARTIFACT — Run references
- `docs/research/STUDY-RESEARCH-BLOGS-EDK2-PITFALLS.md` — structured research-blogs and EDK II pitfalls study note.

### Blockers
- None for the study itself.

### Failure attribution
- No failures. Some Binarly primary blog pages and PDFs were not fully extracted due to JS-only/Cloudflare gating; the note marks these as source gaps and relies on search-extracted snippets, public advisories, and EDK II source/issues.

### Test results
- N/A (research session).

---

---

## Session 103 — Cross-cutting technical index and glossary

**Rule Zero:**
- **Read:** `AGENTS.md`, `.devin/graph/current-state.md`, `docs/research/STUDY-RESEARCH-BLOGS-EDK2-PITFALLS.md`, `docs/research/STUDY-EDK2.md`, `docs/research/STUDY-TPM-2.0.md`, `docs/adr/PBL-DEBT-LEDGER.md`.
- **Finding:** The nine study notes were complete but not cross-referenced. The project needed a master index and glossary so future sessions can locate which note explains a concept, which PBL file it informs, and which debt items it affects.

**Fog cleared this session:**
- Created `docs/research/STUDY-INDEX.md`, a master cross-reference with:
  - A study source map (all 9 notes).
  - A PBL component crosswalk (PBL files → notes and topics).
  - A master glossary of ~120 terms from all notes.
  - Cross-cutting defensive principles.
  - An open-questions matrix.
  - A debt-item → study-note mapping.
  - PBL-specific implementation notes (`ForceReloc.c`, `ChainLoad.c`, `Bcd.c`, `Decision.c`, `PlatformState.c`, `TpmClient.c`, `HttpsClient.c`).
  - A 10-question self-test.
- Updated `AGENTS.md` project layout to include `docs/research/STUDY-INDEX.md`.
- Rebuilt the memory index (`python3 scripts/memory.py index`) — 403 active, 0 superseded, 20 decayed.
- Captured memory to `sess-103.md`.

**ARTIFACT — Run references**
- `docs/research/STUDY-INDEX.md` — master cross-cutting technical index and glossary.
- `AGENTS.md` — project layout now references the study index.

**Debt items closed:**
- None (consolidation / documentation session).

**Debt items still open:**
- D-120, D-129, D-130, D-212–D-219 and all other open items (unchanged; see `PBL-DEBT-LEDGER.md`).

**Fog remaining:**
- The index is a synthesis, not a substitute for the detailed notes; some definitions intentionally brief.
- Memory index warning: 438 lines exceeds the recommended 200-line cap; decay should be considered in a future session.
- No code changes, no build/test runs; consolidation-only verification.

**Blockers**
- None for the consolidation itself.

**Failure attribution**
- No failures. The memory index exceeded the soft cap (438 lines) but rebuilt successfully; this is a maintenance signal, not a blocking error.

**Test results**
- N/A (documentation and consolidation session).

**Next session opening**
- Return to implementation: policy-signature fail-closed tests (D-215/D-219), `LoadedImageCount` enrichment (D-213), or run `python3 scripts/memory.py decay` because the index is over the recommended size.

---

---

## Session 104 — Compile a simple Tianocore/EDK II UEFI application

**Rule Zero:**
- **Read:** `AGENTS.md`, `.devin/graph/current-state.md`, `firmware/PblPkg/PblPkg.dsc`, `firmware/PblPkg/build-pbl.sh`, `STUDY-EDK2.md`, `STUDY-RESEARCH-BLOGS-EDK2-PITFALLS.md`, and the EDK II source trees for `UefiLib.inf`, `BaseLib.inf`.
- **Finding:** The user wanted a minimal "Hello, UEFI" example. PBL already builds with EDK II, so the fastest path was to add a new `SamplePkg` under `firmware/` and use the existing OVMF built by `build-pbl.sh`. The key learning is the EDK II DSC/DEC/INF structure and the `.reloc`/LTO build safeguards already used by PBL.

**Fog cleared this session:**
- Created `firmware/SamplePkg/` with `SamplePkg.dsc`, `SamplePkg.dec`, `Hello/Hello.inf`, and `Hello/Hello.c`.
- Built `Hello.efi` successfully with EDK II GCC (`build -p SamplePkg/SamplePkg.dsc -a X64 -t GCC -b RELEASE`).
- Resolved build errors by adding required `LibraryClasses` (`DebugPrintErrorLevelLib`, `DevicePathLib`, `RegisterFilterLib`, `StackCheckLib`, `PerformanceLib`) to the DSC.
- Ran the application in QEMU/OVMF via the `pbl-qemu` Docker image. OVMF automatically booted `Hello.efi` from `EFI/BOOT/BOOTX64.EFI` on a FAT disk and displayed:
  - `Hello, UEFI!`
  - `This text is printed before the OS.`
  - UEFI firmware vendor and version
  - `Press any key to exit...`
- Wrote `firmware/SamplePkg/README.md` documenting the build and QEMU run steps.
- Captured memory to `sess-104.md`.

**ARTIFACT — Run references**
- `firmware/SamplePkg/Hello/Hello.c` — the UEFI application source.
- `firmware/SamplePkg/SamplePkg.dsc` — EDK II platform description.
- `firmware/SamplePkg/Hello/Hello.inf` — module build description.
- `firmware/SamplePkg/README.md` — build/run instructions.
- QEMU/OVMF run output showed the expected on-screen text before any OS loader.

**Debt items closed:**
- None (learning / sample code session).

**Debt items still open:**
- All open PBL debt items remain open; no PBL production code was changed.

**Fog remaining:**
- The sample does not demonstrate UEFI variable writing, network, or TPM.
- Real hardware may require additional `.reloc`/secure-boot handling beyond what OVMF needs.
- The QEMU run used a writable `OVMF_VARS.fd` copy; the original build output remains untouched.

**Blockers**
- None.

**Failure attribution**
- Build initially failed with missing `DebugPrintErrorLevelLib`, `RegisterFilterLib`, and `DevicePathLib`. This was expected learning: EDK II dependency resolution is transitive and must be declared in the DSC. The fix was to map the missing library classes to their Null/StdErr implementations.

**Test results**
- Build: `build -p SamplePkg/SamplePkg.dsc -a X64 -t GCC -b RELEASE` → success.
- Runtime: QEMU/OVMF displayed the expected text output; user key input loop not exercised to completion because the session killed the VM after confirming output.

**Next session opening**
- Return to PBL implementation (e.g., D-215/D-219 policy-signature fail-closed tests) or extend the sample to read a UEFI variable or call `LoadImage`.

---

---

## Session 105 — Bind PBL lock state to TPM platform hierarchy and fix OVMF harness

**Rule Zero:**
- **Read:** `.devin/graph/current-state.md`, `.devin/graph/GRAPH-SPEC.yaml`, `docs/adr/PBL-DEBT-LEDGER.md`, `firmware/PblPkg/PblPkg.dec`, `firmware/PblPkg/PblApp/TpmClient.c`, `firmware/PblPkg/PblApp/PblApp.c`, `firmware/PblPkg/PblApp/PblApp.h`, `firmware/PblPkg/ci-harness-docker.sh`, `firmware/PblPkg/ci-harness.sh`, `firmware/PblPkg/build-pbl.sh`, `AGENTS.md`, and the EDK II OVMF DSC TPM component includes.
- **Finding:** The immediate goal was to stop the lock state from being erasable by binding it to the hardware root. C2 already specified platform-hierarchy NV with HMAC/AES-256-CFB sessions, but PBL was still using the owner hierarchy and the Docker smoke test was accidentally using the stock OVMF image (which randomizes `platformAuth`) instead of the custom OVMF build with `PeiDxeTpmPlatformHierarchyLibNull`.
- **Note:** Code edits to `TpmClient.c` and `PblPkg.dec` were performed before the formal Rule Zero block was written because this was a direct continuation of the previous session's debugging work. The remaining edits (harness, ledger, graph) were done after Rule Zero was completed.

**Fog cleared this session:**
- Identified that `TPMA_NV_PLATFORMCREATE` must be set when `TPM2_NV_DefineSpace` is authorized with `TPM_RH_PLATFORM`; without it the TPM returns `TPM_RC_ATTRIBUTES` (`0x182`).
- Changed `PblPkg.dec` so `PcdPblTpmUsePlatformHierarchy` defaults to `TRUE`, and updated `TpmClient.c` to set `TPMA_NV_PLATFORMCREATE` in the platform-hierarchy NV attributes.
- Confirmed that the EDK2 OVMF build with `PeiDxeTpmPlatformHierarchyLibNull` leaves `platformAuth` empty, enabling the platform-hierarchy path under swtpm.
- Fixed `ci-harness-docker.sh` to prefer `/ovmf/OVMF_CODE.fd` and `/ovmf/OVMF_VARS.fd` when mounted, overriding the `pbl-qemu` image's `OVMF_CODE`/`OVMF_VARS` environment variables that pointed at the stock Ubuntu OVMF.
- Switched both `ci-harness-docker.sh` and `ci-harness.sh` to `--ctrl`-only swtpm startup with `swtpm_ioctl -i`, avoiding the `CMD_SET_DATAFD`/`TPM_RC_BAD_PARAMETER` problem.
- Added smoke-test assertions for `[OK] NV indices provisioned` and `[OK] HMAC session established (AES-256-CFB)`.
- Docker CI smoke test now passes **12 PASS / 0 FAIL** with the custom OVMF:
  - PBL banner, all 8 PBL steps, NV provisioning, HMAC session, and lock screen.

**ARTIFACT — Run references**
- `firmware/PblPkg/PblApp/TpmClient.c` — platform-hierarchy NV attributes and debug cleanup.
- `firmware/PblPkg/PblPkg.dec` — default `PcdPblTpmUsePlatformHierarchy` TRUE.
- `firmware/PblPkg/PblApp/PblApp.inf` — PCD referenced in `[PcdsFixedAtBuild]`.
- `firmware/PblPkg/ci-harness-docker.sh` — custom OVMF selection and swtpm fix.
- `firmware/PblPkg/ci-harness.sh` — `--ctrl`-only swtpm startup.
- `/tmp/pbl-ci-artifact.txt` — Docker run showing `12 PASS / 0 FAIL`.
- PblApp.efi SHA-256: `cc225def5d9a2ed84d2ad432f2dad088005875fd10521648f8f238f658c791e1`.

**Debt items closed:**
- D-102 — TPM commands use no-session / HMAC sessions (reinforced with platform-hierarchy NV provisioning and updated artifact: commit 83bd5d2).

**Debt items still open:**
- D-100, D-101, D-109–D-130, D-200–D-211 and other PBL/server debt items remain open; this session did not address verdict signing, attestation, Windows chain-load, hardware validation, or server endpoints.

**Fog remaining:**
- `NV_Read(LOCK_STATE)` and `NV_Read(POLICY_VERSION)` still return `TPM_RC_NV_UNINITIALIZED` (`0x14A`) on first boot because the indices are defined but not yet written; the write path (`PblTpmWriteLockState`) exists but is only exercised on a verified online verdict.
- Lock state persistence across reboots has not been explicitly tested with a written-and-read cycle.
- Real platform authorization on physical hardware (OEM/BIOS configured `platformAuth`) is not addressed; the swtpm path is a development approximation.
- `PblTpmComputeCommandHmacSession` uses an empty session key for unbound `TPM_RH_NULL` sessions; this works with swtpm but may need KDFa-derived key handling for bound sessions on real TPMs.

**Blockers**
- None.

**Failure attribution**
- Rule Zero was completed after the first code edits, not before. Cause: session was a continuation of prior debugging and the agent treated the user's "proceed" as an immediate implementation request rather than a new session start. Mitigation: the remaining work (harness, ledger, graph close) followed Rule Zero, and the failure is captured here.
- `ci-harness-docker.sh` initially used stock OVMF due to the `pbl-qemu` image's `OVMF_CODE`/`OVMF_VARS` env vars and the script's `:-` default not overriding them. Fixed by explicitly checking for `/ovmf/OVMF_CODE.fd` first.

**Test results**
- Build: `firmware/PblPkg/build-pbl.sh` → `PblApp.efi` built successfully (SHA-256 `cc225def...`).
- Smoke test: `docker run --rm -v .../firmware:/firmware:ro -v .../Build/OvmfX64/RELEASE_GCC/FV:/ovmf:ro pbl-qemu /firmware/PblPkg/ci-harness-docker.sh 60` → **12 PASS / 0 FAIL**.
- `bash -n` passed for `firmware/PblPkg/build-pbl.sh`, `firmware/PblPkg/ci-harness.sh`, `firmware/PblPkg/ci-harness-docker.sh`.
- `make graph-check` passed (all invariants I1–I7).

**Next session opening**
- Implement and test `PblTpmWriteLockState` so the lock verdict is persisted across reboots, then verify a second boot reads the cached value and blocks offline without network fetch.

---

---

## Session 106 — Persist PBL lock state across QEMU+swtpm reboots

**Rule Zero:**
- **Read:** `.devin/graph/current-state.md`, `firmware/PblPkg/PblApp/PblApp.c`, `firmware/PblPkg/PblApp/PblApp.h`, `firmware/PblPkg/PblApp/TpmClient.c`, `firmware/PblPkg/ci-harness-docker.sh`, `docs/adr/PBL-C2-TPM-Contract.md`, `docs/adr/PBL-DEBT-LEDGER.md`.
- **Finding:** The next opening from session 105 was to implement and test `PblTpmWriteLockState` so the lock verdict persists across reboots. The code path was already implemented but was only exercised for online-verified verdicts; the QEMU smoke test has no network or policy.cose, so the write path was never hit and the cache was never written. A two-boot harness is needed to prove persistence.

**Fog cleared this session:**
- Refactored `PblApp.c` so the final verdict is written to `PBL_LOCK_STATE` NV regardless of whether it came from an online fetch, the local cache, or the fail-closed offline path. This makes offline lockdown persist across reboots.
- Built `PblApp.efi` (SHA-256 `7509bed4704b41dd192b59cce10b00ec4aad0d6f76b9c6c09b6392fe0f781fc7`) and confirmed the single-boot Docker smoke test still passes 12/0.
- Discovered that `swtpm` is killed when QEMU exits under `timeout` in the `pbl-qemu` image, so a single long-running swtpm cannot be reused across two QEMU boots. Created `ci-harness-persistence.sh` with per-boot swtpm start/stop that reuses the same `--tpmstate` directory so NV state persists.
- Two-boot persistence test passes **16 PASS / 0 FAIL**:
  - Boot 1: provisions NV indices, shows `No cached lock state`, then `[OK] Lock state cached to TPM NV`.
  - Boot 2: reads the cached value and shows `[INFO] Using cached verdict`, then `[OK] Lock state cached to TPM NV`.
- Added `pbl-persistence-artifacts/` to `.gitignore` so generated serial logs/result files are not committed.

**ARTIFACT — Run references**
- `firmware/PblPkg/PblApp/PblApp.c` — final-verdict cache write.
- `firmware/PblPkg/ci-harness-persistence.sh` — two-boot QEMU+swtpm persistence harness.
- `firmware/PblPkg/PblApp.efi` (SHA-256 `7509bed...`) built successfully.
- `/home/cllin/remote-lockdown-system/pbl-persistence-artifacts/pbl-persistence-result.txt` — 16 PASS / 0 FAIL artifact.
- `/home/cllin/remote-lockdown-system/pbl-persistence-artifacts/pbl-persistence-serial.log` — combined serial output.

**Debt items closed:**
- None specifically (no existing PBL debt item tracked the offline cache persistence gap). D-215 (policy-signature fail-closed tests) and D-213 (LoadedImageCount enrichment) remain open.

**Debt items still open:**
- D-100..D-130 and D-200..D-211 as listed in `current-state.md`. This session did not address verdict signing hardening, attestation, Windows chain-load, or real hardware validation.

**Fog remaining:**
- The cache is written with an empty `IssuedAt`/`GraceUntil` in the offline fail-closed path. A future session should decide whether offline-fail-closed should set a grace period or a hard lock.
- The override response code is not computed; the test harness sends `test\n` which does not satisfy the challenge, so PBL remains on the lock screen and is killed by `timeout`. This is acceptable for the persistence test but not a real override test.
- The `PblTpmWriteLockState` HMAC session is unbound (`TPM_RH_NULL`) and the session key is empty. This works with swtpm but is not the C2-mandated bound HMAC session with KDFa for production.
- Real platform hierarchy authorization and physical-presence requirements are still unverified on hardware.

**Blockers**
- None.

**Failure attribution**
- First attempt at `ci-harness-persistence.sh` reused a single `swtpm` instance and boot 2 failed because the control socket disappeared after `timeout` killed QEMU. Cause: harness layer 3 (execution environment) — swtpm lifecycle assumptions. Fix: start/stop swtpm per boot while preserving the `tpmstate` directory.

**Test results**
- Build: `firmware/PblPkg/build-pbl.sh` → `PblApp.efi` SHA-256 `7509bed...`.
- `ci-harness-docker.sh` → 12 PASS / 0 FAIL (regression check).
- `ci-harness-persistence.sh` (Docker, two boots) → **16 PASS / 0 FAIL**.
- `bash -n` passed for `ci-harness-persistence.sh` and `ci-harness-docker.sh`.

**Next session opening**
- Harden the cache write to use a C2-bound HMAC session and test with a real salt/bind, or pick up D-215/D-213.

---

---

## Session 107 — C2 bound HMAC session: includeAuth semantics + WRITTEN-aware NV names

**Rule Zero:**
- **Read:** `firmware/PblPkg/PblApp/TpmSession.c`, `firmware/PblPkg/PblApp/TpmClient.c`, `firmware/PblPkg/PblApp/PblApp.h`, `firmware/PblPkg/PblApp/PblApp.c`, `firmware/PblPkg/ci-harness-persistence.sh`, `firmware/PblPkg/ci-harness-docker.sh`, `docs/adr/PBL-C2-TPM-Contract.md`, libtpms 0.9.3 source (`SessionProcess.c`, `Session.c`, `NV_spt.c`, `NV_DefineSpace.c`, `TpmTypes.h`, `TpmError.h`), plus standalone swtpm repro scripts `scripts/tpm-authhandle-debug.py` and `scripts/tpm-bound-hmac-minimal.py`.
- **Finding:** Session 106 left the NV cache write on an unbound session. Binding the session to `PBL_NV_LOCK_STATE` with a real auth value surfaced `0x09A2` (session-1 BAD_AUTH). Root-caused against libtpms source + minimal swtpm repro.

**Fog cleared this session:**
- `includeAuth` semantics (libtpms `ComputeCommandHmac`/`IsSessionBindEntity`): a bound session uses `sessionKey` alone while it authorizes its bound entity; `sessionKey || authValue` is only correct for other entities. Appending `bindAuth` unconditionally caused `0x9A2`.
- Return-code corrections: `0x014A` is `TPM_RC_NV_UNINITIALIZED` (empty index), not `NV_AUTHORIZATION` (`0x0149`). Earlier sessions misread it.
- TPMA_NV layout in libtpms is the standard layout (read bits 16-19, PLATFORMCREATE bit 30): `0x420D000D` was always correct.
- NV index Name mutates when `TPMA_NV_WRITTEN` flips on first write — the bound-entity match then breaks, and both the HMAC key (`sessionKey || authValue`) and the cpHash Name must follow the new Name.
- `rpHash` for response HMAC excludes the `parameterSize` transport field: `responseCode || commandCode || responseParameters` only. The old code hashed parameterSize too, which broke post-write `NV_Read` verification (boot-2 "Device Error").
- `PblTpmSubmitCommand` masked the TPM return code by not reporting `ActualResponseSize` on the error path — the RC warn print read an uninitialized variable.

**Implementation (commit `e2b107c`):**
- `PBL_TPM_SESSION` gains `BoundEntityName`, `IncludeAuth`, `CmdAuthValue` — `PblTpmStartHmacSession` captures the bound entity Name at session start.
- `PblTpmSetupSessionAuth` (TpmClient.c) computes per-command `includeAuth` by comparing the associated handle's current Name to the captured bound Name, and loads the authorized entity's authValue from `PcdPblTpmNvAuthValue` for NV handles.
- All four HMAC-key constructions now use `sessionKey || (includeAuth ? cmdAuthValue : "")`.
- NV name cache stores authoritative attributes: `PblTpmNvRefreshName` (TPM2_NV_ReadPublic) after provisioning; `PblTpmNvMarkWritten` after successful `NV_Write`/`NV_Increment`; `PblTpmGetHandleName` recomputes Names on demand.
- `PblTpmNvRefreshName` also fixes the WRITTEN=1 case on second boot (index persisted from prior boot).
- Harness greps updated for the `(bound to lock-state NV)` banner (all three harnesses).

**ARTIFACT — Run references**
- `PblApp.efi` SHA-256 `852a73334fb9a19952a02bd47971de4b01d6ef4d3d689b6ebef90dcca1bd56ee` (built via `firmware/PblPkg/build-pbl.sh`).
- `pbl-persistence-artifacts/pbl-persistence-result.txt` — **16 PASS / 0 FAIL** two-boot.
- `pbl-persistence-artifacts/pbl-persistence-serial.log` — combined serial output; boot 2 shows `Using cached verdict` via the bound session.
- `ci-harness-docker.sh` single-boot regression: **12 PASS / 0 FAIL**.

**Debt items closed:**
- None newly closed — this is correctness hardening of already-closed D-102 (bound session was specified but the includeAuth/WRITTEN semantics were wrong).

**Debt items still open:**
- D-215 (policy-signature fail-closed tests; also tracks AES-CFB parameter encryption — still disabled via `PcdPblTpmUseParameterEncryption=FALSE`), D-213 (LoadedImageCount), D-100..D-130, D-200..D-211 per `current-state.md`.

**Fog remaining:**
- `NV_Read(POLICY_VERSION)` still returns `0x14A` on both boots — the counter is never incremented in this flow; acceptable (not yet exercised).
- Response HMAC is verified only on the `NV_Read` parse path; `NV_Write`/`NV_Increment` responses skip verification (RC-only) and do not roll `nonceTPM` — harmless today since no session command follows a write in one boot, but a future command-after-write sequence would need the update.
- Parameter encryption (AES-256-CFB `sessionValue` KDFa derivation) remains disabled by design.
- QEMU/swtpm only — real platform-hierarchy auth, physical presence, Boot Guard remain unverified on hardware.

**Blockers**
- None.

**Failure attribution**
- The `0x9A2`/`0x14A` debugging loop was prolonged by layer 2 (context provision): libtpms includeAuth semantics and the TPMA_NV bit layout were not documented in-repo; resolved by reading libtpms source and writing standalone swtpm repro scripts.
- Masked RC (layer 4 verification feedback): `PblTpmSubmitCommand` hid the real return code; now fixed.

**Test results**
- Build: `PblApp.efi` SHA-256 `852a7333...`.
- `ci-harness-persistence.sh` (Docker, two boots): **16 PASS / 0 FAIL**.
- `ci-harness-docker.sh`: **12 PASS / 0 FAIL**.
- `make graph-check`: all invariants pass.

**Next session opening**
- D-215 policy-signature fail-closed tests, D-213 LoadedImageCount enrichment, or AES-256-CFB parameter encryption (sessionValue KDFa-CFB derivation) to complete C2 REQ-05.

---

---

## Session 108 — 2026-09-16 — D-215/D-219 policy-signature fail-closed via provisioned root of trust

**RULE-ZERO — Understanding logged before code changes**

**Read:** `PblApp/PolicyRootOfTrust.c`, `Policy.c` (`PblVerifyPolicySignature`/`PblVerifyCoseSign1`), `PblPkg.dec` (RoT PCDs), `test-d205.py` (COSE_Sign1/ES256 helpers, `policy.cose` generation), `test-d205-harness.sh` + `ci-harness-persistence.sh` (QEMU+swtpm patterns), `PBL-C4-Policy-Blob.md` (sig/key 58/verdict schema).

**Finding:** `PolicyRootOfTrust.generated.h` existed (SPKI + kid only) but was dead code — the include was guarded by `#ifdef PBL_POLICY_ROOT_OF_TRUST_GENERATED_H_`, a macro defined only *inside* that header. Additionally the old JS generator never emitted the X.509 cert that `EcGetPublicKeyFromX509` needs. In dev mode `PblVerifyPolicySignature` returns `EFI_UNSUPPORTED` and `Policy.c` continues past it, so the fail-closed path (invalid signature → `EFI_SECURITY_VIOLATION` → [BLOCK]) had never been exercised — exactly what D-215/D-219 track.

**What changed**

- `firmware/PblPkg/gen-policy-rot.py` (new): provisions the ES256 policy signing key (reuses gitignored `.pbl_policy_signing_key` when present), emits a self-signed X.509 cert, and writes `PolicyRootOfTrust.generated.h` with SPKI + kid + cert DER + sizes. Emits four `policy.cose` variants: valid, wrong-key, tampered (flips a byte inside a large CBOR bstr while preserving the original signature — fails on ECDSA, not CBOR parse), wrong-kid.
- `firmware/PblPkg/PblApp/PolicyRootOfTrust.c`: `__has_include("PolicyRootOfTrust.generated.h")` → `PBL_POLICY_ROT_PROVISIONED`; zero-filled dev fallbacks retained when absent.
- `firmware/PblPkg/test-d215-harness.sh` (new): builds RoT-provisioned firmware, mounts each policy variant into the ESP, boots QEMU+swtpm per scenario (swtpm restarted per boot, TPM state reused), greps serial logs for pass/block paths.
- `firmware/PblPkg/test-d205.py`: `generate_policy` signs with the policy key when `.pbl_policy_signing_key` exists (dummy sig only in true dev mode) — keeps the D-205 harness compatible with RoT-provisioned builds.

**Test results**

- RoT-provisioned build: `PblApp.efi` SHA-256 `c176ac28...` (intermediate) — 12 PASS / 0 FAIL:
  - valid: policy read → `[OK] Policy signature verified` → reached step [3/8] TPM NV
  - wrong-key / tampered / wrong-kid: `[BLOCK] Policy signature verification FAILED`, `EFI_SECURITY_VIOLATION`, never reached step [3/8], no lock screen
- Dev state restored; rebuilt `PblApp.efi` SHA-256 `852a7333...` (byte-identical to pre-D-215 — reproducible).
- `ci-harness-docker.sh` post-restore: **12 PASS / 0 FAIL**.
- Artifact: `/tmp/pbl-d215-ci/pbl-d215-result.txt`; serial logs `/tmp/pbl-d215/pbl-serial-{valid,wrongkey,tampered,wrongkid}.log`.

**Debt items closed:**
- **D-215** — policy signature BLOCK path now exercised (commit `fb10e29`, artifact `/tmp/pbl-d215-ci/pbl-d215-result.txt`).
- **D-219** — same scenario, closed together (commit `fb10e29`).

**Debt items still open:**
- D-213 (LoadedImageCount enrichment), D-217 (in-binary hardening bypassable without Secure Boot — the real residual risk; a modified PblApp.efi skips policy verification entirely), D-100..D-130, D-200..D-211 per `current-state.md`.

**Fog cleared this session:**
- `PolicyRootOfTrust.generated.h` was dead code: `#ifdef PBL_POLICY_ROOT_OF_TRUST_GENERATED_H_` tested a macro defined only inside that header, so the provisioned root of trust never compiled in. `__has_include` fixes it.
- The verifier needs the X.509 cert (`gPblPolicySigningKeyCert`) for `EcGetPublicKeyFromX509`, not just SPKI+kid — the old JS generator never emitted it; `gen-policy-rot.py` now emits all four (SPKI, kid, cert, sizes).
- Fail-closed semantics confirmed empirically: invalid policy signature → `EFI_SECURITY_VIOLATION` → `[BLOCK]` before step [3/8], no lock screen, no TPM NV access.
- swtpm must be restarted per QEMU boot while reusing `--tpmstate` — same lifecycle rule as the persistence harness.

**Fog remaining:**
- RoT is provisioned from a self-signed dev cert; production provisioning (OEM key ceremony, cert chain, `db` enrollment) is deployment work, not yet designed.
- Harness uses `__has_include` — supported by GCC/Clang; if another toolchain is used the guard falls back to dev mode silently.
- QEMU/swtpm only — policy sig verification on real hardware unverified; Secure Boot enforcement of the RoT-provisioned binary itself is untested (D-217).

**Blockers**
- None.

**Failure attribution**
- None this session — the earlier swtpm-per-boot lifecycle fix (session 106) was reused directly; first harness run's swtpm-death failure was a layer-3 (execution environment) reuse of the same pattern, fixed in-harness.

**Next session opening**
- D-217 (document Secure Boot deployment checklist or runtime self-integrity hashing the PE from disk), D-213 (LoadedImageCount), or AES-256-CFB parameter encryption (sessionValue KDFa-CFB) for C2 REQ-05.

---

---
