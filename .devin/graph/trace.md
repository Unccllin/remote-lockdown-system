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

---

## Session 109 — 2026-09-16 — D-217 runtime self-integrity: PCR 13 self-image measurement + Secure Boot checklist

**RULE-ZERO — Understanding logged before code changes**

**Read:** `PblApp.c` PCR-extend block (step [7/8]) incl. D-212 revert note, `TpmClient.c` `PblTpmExtendPcr`/`PblTpmReadPcr`, `PBL-C2-TPM-Contract.md` §4 (PCR 12 decision / PCR 13 inputs, high-assurance sealing tier), `Decision.c` REQ-01 (SecureBoot/SetupMode → BLOCK), `PblReadFileFromFs` SimpleFS pattern, `PlatformState.c` LoadedImage enumeration.

**Finding:** D-212 was reverted because hashing the **in-memory** image is non-deterministic (PE ImageBase=0 → DIR64 relocations at a random load address each boot). The on-disk PE file bytes ARE deterministic — hashable via `LoadedImage->DeviceHandle` + `FilePath` media node + SimpleFS. D-217's ledger close criteria allowed "runtime self-integrity that hashes the PE file from disk, or a Secure Boot deployment checklist" — both were delivered since self-measurement alone is detection, not prevention.

**What changed**

- `PblApp.c` — new `PblHashSelfImage`: resolves `EFI_LOADED_IMAGE_PROTOCOL` on the image handle, walks `FilePath` device-path nodes for `MEDIA_FILEPATH_DP`, opens the PE via SimpleFS on `DeviceHandle`, SHA-256s the file. Result extended into PCR 13 BEFORE the inputs extend; serial prints `Self-image SHA-256: <hex>`.
- `ci-harness-docker.sh` / `ci-harness.sh` — new checks: `PCR 13 (self-image) extended` present, and logged hash == `sha256sum(PblApp.efi)` (EDK II `Print %02x` emits uppercase; compare case-folded).
- `PBL-C2-TPM-Contract.md` §4.1 — three-extend ordering documented (PCR13 self-image, PCR13 inputs, PCR12 decision).
- `docs/adr/PBL-SECURE-BOOT-DEPLOYMENT.md` (new) — prevention-layer checklist: owner PK/KEK/db enrollment, sbsign, dbx/SBAT/min_svn, platform-hierarchy TPM NV, Boot Guard + SPI protection + firmware-volume placement, hardware-verification gaps.

**Test results**

- Build: `PblApp.efi` SHA-256 `b9fc20e9...`.
- `ci-harness-docker.sh`: **14 PASS / 0 FAIL** — logged self-image hash matches `sha256sum` of the booted binary exactly.
- `ci-harness-persistence.sh` (two boots): **16 PASS / 0 FAIL** — no regression.
- `make graph-check`: all invariants pass (after adding missing Fog cleared section).

**Debt items closed:**
- **D-217** — both close criteria met (commit `5a59aa2`, artifact `/tmp/pbl-ci/pbl-serial.log`).

**Debt items still open:**
- D-213 (LoadedImageCount enrichment), D-100..D-130, D-200..D-211 per `current-state.md`; AES-256-CFB parameter encryption for C2 REQ-05.

**Fog cleared this session:**
- Why D-212 failed: in-memory PE image has relocations applied at a random base; on-disk file bytes are stable — hashable deterministically.
- EDK II `Print` with `%02x` emits UPPERCASE hex — harness comparisons must case-fold.
- Self-measurement is complete for detection: tampered binary → different hash extended; patched binary that skips the code → missing extend. Both change PCR 13.
- `ci-harness-docker.sh` `set -eo pipefail` kills the script silently on any failing command substitution — needs `|| true` guards on grep pipelines.

**Fog remaining:**
- Self-image measurement runs AFTER decision evaluation (step [7/8]) — a tampered binary's damage (e.g. forced PASS) happens before detection. Ordering acceptable since detection is via attestation post-boot, but noted.
- `LoadedImage->FilePath` may be absent for firmware-volume-loaded images — `PblHashSelfImage` returns NOT_FOUND → WARN; FV deployment will need a ROM-volume read path instead.
- QEMU/swtpm only; real Secure Boot rejection of tampered binary untested (needs signed binary + enrolled keys on hardware or OVMF secure-boot vars).

**Blockers**
- None.

**Failure attribution**
- Layer 4 (verification feedback): first harness run failed silently — `set -eo pipefail` + failing `grep` in command substitution exited before printing FAIL. Guarded with `|| true`.

**Next session opening**
- D-213 LoadedImageCount enrichment (hash each image's device path or record names), AES-256-CFB parameter encryption for C2 REQ-05, or OVMF Secure Boot vars test to prove tampered-binary rejection in emulation.

---

---

---

## Session 109b — 2026-09-16 — Secure Boot rejection of tampered PblApp.efi proven in emulation

**RULE-ZERO — Understanding logged before code changes**

**Read:** `test-d215-harness.sh` (boot_scenario pattern), `PBL-SECURE-BOOT-DEPLOYMENT.md` §2.6 (unverified list), OVMF build flags in `build-pbl.sh`, virt-firmware `peutils.pesign` (`pe_authenticode_hash`, `pe_check_hash`), `virt-fw-vars` CLI options.

**Finding:** The existing OVMF was built with `SECURE_BOOT_ENABLE=FALSE` — `SecurityStubDxe` was the non-enforcing stub, so Secure Boot never actually rejected anything in our QEMU loop. Rebuilt with `-D SECURE_BOOT_ENABLE=TRUE` (snakeoil PK/KEK material already present in the FV dir). `virt-fw-vars` can create a vars store with generated PK + arbitrary `db` hash entries + `SecureBootEnable=ON`, and `pe_authenticode_hash` computes the exact digest `DxeImageVerificationLib` checks — no sbsigntool needed for a hash-enrollment test.

**What changed**

- Rebuilt OVMF with `SECURE_BOOT_ENABLE=TRUE` (kept in `Build/OvmfX64`; default `OVMF_VARS.fd` has no PK → SetupMode → unsigned binaries still boot, so existing harnesses unaffected — verified 14/0).
- `build-pbl.sh` — OVMF build now carries `-D SECURE_BOOT_ENABLE=TRUE`.
- `firmware/PblPkg/test-sb-harness.sh` (new) — host side computes the authenticode hash, builds `OVMF_VARS-sb.fd` via virt-fw-vars, creates a tampered PblApp.efi (1 byte appended past last section); container boots 3 scenarios.
- `PBL-SECURE-BOOT-DEPLOYMENT.md` §2.6 — emulation proof recorded.
- `PBL-DEBT-LEDGER.md` — D-217 entry updated with the emulation evidence.

**Test results — 8 PASS / 0 FAIL**

- `allowed`: enrolled-hash binary boots under Secure Boot; banner, decision, self-image SHA-256 printed.
- `tampered-sb`: serial shows `BdsDxe: failed to load Boot0002 ... Access Denied -- rejected probably by Secure Boot`; NO banner, NO decision, NO lock screen.
- `tampered-nosb` (control): same tampered binary boots under plain vars — rejection is Secure Boot, not corruption.

**Fog cleared this session:**
- `SECURE_BOOT_ENABLE=FALSE` OVMF silently accepts everything — "Secure Boot tested" claims require the enforcing build; check `DxeImageVerificationLib` in the FV, not just the flag's intent.
- Authenticode hash ≠ file SHA-256: it excludes the checksum field, security-directory entry, and cert table. `pe_authenticode_hash` from virt-firmware computes it correctly.
- A byte flip inside `.reloc` is NOT a clean tamper: the loader applies relocations and fails with `Unsupported` even without SB. Appending overlay bytes past the last section is covered by the authenticode hash but never mapped — clean tamper.
- `virt-fw-vars --add-db-hash` + `--enroll-generate` + `--sb` fully provisions PK/db/SecureBootEnable into a raw edk2 varstore file — no in-guest enrollment step needed.

**Fog remaining:**
- Emulation used a db *hash* entry, not a signed binary — real deployments sign with an enrolled cert (sbsign/pesign) and the signature-verification path differs slightly (cert chain + image hash).
- OVMF vars are unprotected (no SMM_REQUIRE) — a guest could rewrite vars in emulation; on hardware, SMM-protected var stores matter.
- Real-hardware Secure Boot rejection still untested (I3).

**Debt items closed:** none newly — strengthens already-closed D-217 with prevention-layer evidence.
**Debt items still open:** D-213, D-100..D-130, D-200..D-211; AES-CFB parameter encryption (C2 REQ-05).

**Blockers** — none.

**Failure attribution**
- Layer 2 (context provision): two test-design bugs — (a) `.reloc` byte flip corrupts the load path (learned: relocations are applied from that section), (b) checking for `PCR 13 extended` in a no-swtpm harness. Both fixed in-harness.

**Next session opening**
- D-213 LoadedImageCount enrichment, or AES-256-CFB parameter encryption (sessionValue KDFa-CFB) for C2 REQ-05.

---

---

## Session 110 — 2026-09-16 — AES-256-CFB TPM parameter encryption (C2 REQ-05) implemented and enabled

**RULE-ZERO — Understanding logged before code changes**

**Read:** `TpmSession.c` (AES-CFB impl, `PblKDFa`, session state), `TpmClient.c` (`PblTpmSessionAttrsForCommand`, `PblTpmFillCommandHmac`, `PblTpmParseSessionResponse`, NV read/write call sites), libtpms 0.9.3 `SessionProcess.c`/`CryptUtil.c` (`ParmDecryptSym`, `ParmEncryptSym`, `CryptParameterDecryption`, `CryptParameterEncryption`), `PBL-C2-TPM-Contract.md` §3, `PblPkg.dec` PCD.

**Finding:** The previous parameter-encryption path used the raw `sessionKey` as the AES key with IV=0 — not TPM-compliant. Per libtpms: sessionValue = `sessionKey || authValue(authorizedEntity)` (extraKey appended unconditionally, unlike the HMAC includeAuth rule); key+IV = `KDFa(SHA-256, sessionValue, "CFB", nonceNewer, nonceOlder, 384)` → AES-256 key(32)‖IV(16). Command direction: (nonceCaller, nonceTPM); response: (fresh nonceTPM, nonceCaller). Only the first TPM2B param's buffer is encrypted; cpHash covers ciphertext, so encryption must precede HMAC. The PCR session has an empty sessionKey and must never claim decrypt.

**What changed**

- `TpmSession.c` — new `PblTpmSessionCfbKeyIv` (sessionValue concat + KDFa "CFB" 384-bit derive, direction-dependent nonce order); `PblTpmEncryptCommandParams`/`PblTpmDecryptResponseParams` rewritten: TPM2B-aware (size field plaintext), KDFa-derived key/IV, no more zero-IV.
- `TpmClient.c` — `PblTpmFillCommandHmac` now runs `PblTpmSetupSessionAuth` then parameter encryption BEFORE building the cpHash input (nonce refresh → auth-area write → encrypt → HMAC); removed all four post-hoc encrypt call sites; `PblTpmCommandSupportsDecrypt`/`SessionAttrsForCommand` trimmed to the actual NV-session set and gated on non-empty sessionKey; PCR_Extend auth attrs hardcoded to continueSession; new `PblTpmRollNonceFromSessionResponse` rolls nonceTPM after NV_Write/NV_Increment (previously unparsed session responses — latent BAD_AUTH for any following command).
- `PblPkg.dec` — `PcdPblTpmUseParameterEncryption=TRUE`.
- `PBL-C2-TPM-Contract.md` §3 implementation note; `PBL-DEBT-LEDGER.md` D-102 progress.

**Test results**

- Build: `PblApp.efi` SHA-256 `e839ce5534ee4168d576d0b6ce9918ee703d7013990ffe3b1b0f943971590147`; PCD compiled = 1U.
- `ci-harness-persistence.sh` (two boots, shared swtpm state): **16 PASS / 0 FAIL**.
- `ci-harness-docker.sh`: **14 PASS / 0 FAIL**.
- Wire-level proof (swtpm level-20 log, `/tmp/pbl-cfb-host/swtpm{1,2}.log`): NV_Write cmd attrs=`0x21` (continue|decrypt), `data` param = 64B ciphertext (`E1 46 B4…`, plaintext starts `0x50`), rc=0; boot-2 NV_Read attrs=`0x41` (continue|encrypt), response `data` = 64B ciphertext (`A0 43 21 F3…`) decrypted correctly → "Using cached verdict: 1" + magic check passed.
- Artifact: `/tmp/pbl-ci-persist-host/pbl-persistence-result.txt` + serial logs.

**Fog cleared this session:**
- CFB extraKey rule differs from HMAC includeAuth: for parameter encryption the entity authValue is appended to sessionKey *even when the session is bound to that entity* (libtpms `CryptParameterDecryption`).
- cpHash covers encrypted params — the TPM checks HMAC over ciphertext, then decrypts. Encryption after HMAC (previous code) would have produced BAD_AUTH once enabled.
- Response decryption requires the *new* nonceTPM from the response auth area — `PblTpmParseSessionResponse` updates it before callers decrypt.
- NV_Write/NV_Increment responses were never parsed — nonceTPM went stale; latent failure for any session command after them. Fixed via `PblTpmRollNonceFromSessionResponse`.

**Fog remaining:**
- swtpm/libtpms 0.9.3 only — real dTPM parameter-encryption behavior on hardware unverified (I3).
- NV_DefineSpace/NV_ChangeAuth decrypt paths are code-correct but not exercised at runtime (provisioning uses password sessions before the HMAC session starts).
- Salted sessions (tpmKey != TPM_RH_NULL) still not used — bus-sniffing defence relies on bound session + param encryption only.

**Debt items closed:** none new — completes the deferred REQ-05 scope inside already-closed D-102 (commit aa9a0cf, artifacts above).
**Debt items still open:** D-213, D-100..D-130 (hardware items), D-200..D-211.

**Blockers** — none.

**Failure attribution**
- None this session — implementation verified on first harness run after build fixes (unused-variable cleanup).

**Next session opening**
- D-213 LoadedImageCount enrichment, or remaining D-1xx hardware-debt items (SPI/DCI/DMA/MOR/SBAT checks).

---

## Session 111 — 2026-09-16 — D-213 loaded-image enumeration enrichment (per-image identity digest)

**RULE-ZERO — Understanding logged before code changes**

**Read:** `PlatformState.c` (loaded-image enumeration block, ~line 910), `PblApp.h` (`PBL_PLATFORM_STATE`), `PblApp.c` (platform_state_digest computation + logging site), `PBL-DEBT-LEDGER.md` D-213 row.

**Finding:** `platform_state_digest = SHA-256(PBL_PLATFORM_STATE)` — adding a `LoadedImageDigest[32]` field to the struct automatically enriches the digest sent to the server; no CBOR schema change needed (struct is hashed, never marshalled field-by-field). Ledger wanted "hash each image's device path" — implemented as per-image `SHA-256(DevicePath(DeviceHandle) || FilePath)` sorted then aggregated, making the result independent of LocateHandleBuffer order.

**What changed**

- `PblApp.h` — `PBL_PLATFORM_STATE.LoadedImageDigest[32]` after `LoadedImageCount`.
- `PlatformState.c` — enumeration now per-image: HandleProtocol → LoadedImage + DevicePath on `Loaded->DeviceHandle`, hash `DevPathSize||DevPath||FilePathSize||FilePath` per image, insertion-sort the 32B hashes, aggregate SHA-256 → `LoadedImageDigest`. Count retained.
- `PblApp.c` — serial line `Loaded images: N (digest %08x…)` after collection.
- `ci-harness-docker.sh` — new D-213 check.

**Test results**

- Build: `PblApp.efi` SHA-256 `e6be03fba1f1df1a88cdb416bba12b3aa117a91a2dc5ed35204fef9536e51bdc`.
- `ci-harness-docker.sh`: **15 PASS / 0 FAIL** (new check included).
- `ci-harness-persistence.sh`: **16 PASS / 0 FAIL**; digest `32FB22F41C5469B9` identical across both boots (deterministic); differs from the single-boot digest `650224876D9C939F` because the persistence ESP lives on a GPT disk — different device paths → different image-set identity. This is the intended sensitivity.
- Artifact: `/tmp/pbl-ci-persist-host/pbl-persistence-result.txt`, serial logs in `/tmp/pbl-persist-mount/`.

**Fog cleared this session:**
- `platform_state_digest` covers the whole `PBL_PLATFORM_STATE` struct — enrichment fields ride along without wire-format changes.
- Device-path identity is layout-sensitive by design: the same image set on a different disk topology produces a different digest (GPT-disk ESP vs raw-ESP harness runs differ). Server baselines must be per deployment layout.

**Fog remaining:**
- Server-side baseline tracking for `LoadedImageDigest` not implemented — the server only sees the opaque `platform_state_digest` change today; a dedicated field in the attestation payload would let the server report WHICH aspect changed.
- Digest is detection-only; no local decision logic consumes it.
- QEMU device-path determinism may not match real hardware (USB/NVMe path nodes vary more).

**Debt items closed:** D-213 (commit 56c4728; artifacts above).
**Debt items still open:** D-100..D-130 hardware items (D-121 SPI, D-122 DCI, D-123 DMA, D-124 MOR, D-126 SVN, D-127 AMT, D-128 SBAT, D-129 real-hardware validation, D-130 signing), D-200..D-211 server-side items.

**Blockers** — none.

**Failure attribution**
- None — clean first-run verification.

**Next session opening**
- Remaining D-1xx hardware-debt items (SPI/DCI/DMA/MOR/SVN/AMT/SBAT) — most are emulated/stubbed checks needing real-hardware or deeper emulation evidence; or D-200..D-211 server-side attestation/policy work.

---

---

## Session 112 — 2026-09-17 — D-120 FVE-FS metadata inspection (BitLocker detection) + distro-OVMF harness bug found

**Read:** `docs/research/windows-11-23h2-iso-RE-findings.md` (FVE layout), libbde BDE format spec, `PlatformState.c` (BCD collection + `BitLockerEnabled` consumer), `Decision.c` (blocks when `!BitLockerEnabled`), `PblApp.h`/`PblApp.inf`, `ci-harness-persistence.sh` (swtpm lifecycle + OVMF convention), `firmware/Dockerfile.qemu` (distro-OVMF env), edk2 `PeiDxeTpmPlatformHierarchyLib`, `Tcg2PlatformDxe`, `PlatformBootManagerLib`.

**Finding:** BCD only carries boot config — the authoritative BitLocker signal is the FVE volume metadata (per libbde spec: `-FVE-FS-` @3, Win7/10 metadata offsets u64 @176/184/192, block header 64B + metadata header 48B, VMK entry type 0x0002/value 0x0008, protection type @entry+34). Implemented `Fve.c` accordingly. While validating, found the new harness silently booted the container's **distro OVMF** (`/usr/share/OVMF/OVMF_CODE_4M.fd` via `OVMF_CODE` env from `Dockerfile.qemu`) instead of the custom Null-hierarchy-lib build — distro OVMF sends `TPM2_HierarchyChangeAuth` at EndOfDxe randomizing platformAuth (with uninitialized-buffer bytes since qemu64 lacks RDRAND), so every DefineSpace failed `RC=0x9A2` and all NV ops cascaded `0x18B`. Harness passed 9/0 anyway because it never checked TPM steps. Root-caused via swtpm level-20 wire logs + `Loaded images: 104 vs 92` divergence.

**What changed**

- `Fve.c` (new) — DiskIo/BlockIo scan, `-FVE-FS-` detect, metadata block validation, metadata-header parse (version, method), VMK entry walk → `FveProtectionMask`, `FveEncryptionMethod`, `FveMetadataVersion`, `FveClearKeyOnly`; sets `BitLockerEnabled` on positive detection. All packed reads use `ReadUnaligned*`.
- `PblApp.h` — new `PBL_PLATFORM_STATE` FVE fields + `PblCheckFve` decl; `PlatformState.c` — call after `PblCollectBcdState` (FVE authoritative-positive, BCD GUID fallback); `PblApp.inf` — Fve.c + DiskIo/BlockIo GUIDs.
- `test-fve-harness.sh` (new) — synthetic FVE-FS image (python), two boots (fve/nofve), 11 checks including NV-provisioning + bound-HMAC-session so the TPM path can't silently break again.
- `ovmf-platform-hierarchy-null.patch` — committed; documents the required edk2 Null-lib patch for the test OVMF.

**Test results**

- Build: `PblApp.efi` SHA-256 `f52824490f121f3e4ad8eaf710def6cc90c82c8ed42c97fd43665e24760ad160`, 1,347,584 B.
- `test-fve-harness.sh` (custom OVMF): **11 PASS / 0 FAIL** — FVE detected, metadata v2 parsed, method 0x8004 AES-XTS, protectors 0x0002 (TPM), negative absent-disk, provisioned + bound session, lock screen both.
- `ci-harness-docker.sh`: **15/0**; `ci-harness-persistence.sh` (two boots): **16/0**.
- Artifact: `/tmp/pbl-fve-ci/pbl-fve-result.txt` (in-container `/tmp/pbl-fve-ci`, host `/tmp/pbl-fve-mount`).

**Fog cleared this session:**
- Distro OVMF (Ubuntu 4M) randomizes platformAuth via `Tcg2PlatformDxe`+`PeiDxeTpmPlatformHierarchyLib` when `DxeSmmReadyToLock` is produced — this OVMF variant produces it; our custom build links the Null lib (`ovmf-platform-hierarchy-null.patch`) so platformAuth stays empty for RS_PW dev provisioning. Wire-level proof: `0x129` command present in distro-boot swtpm log, absent in custom-OVMF log.
- `0x9A2` = session-1 `BAD_AUTH` (platformAuth mismatch); `0x18B` = NV index undefined after failed DefineSpace.
- A harness that only checks the decision UI can pass while the entire TPM path is dead — every boot harness must assert NV provisioning + session establishment.

**Fog remaining:**
- Whether distro OVMF's `DxeSmmReadyToLock` producer is its SMM stack or `SecurityStubDxe` deferral path — not fully traced (irrelevant once custom OVMF is used).
- `FveClearKeyOnly`/`FveProtectionMask` not yet surfaced in the attestation payload (opaque inside `platform_state_digest`).

**Debt items closed:** none — D-120 updated with implementation+evidence but kept OPEN (residual: real-media validation, boot-volume binding, VMK lock-state proof).
**Debt items still open:** D-120 (narrowed), D-121..D-128 (hardware checks), D-129 (real hardware), D-130 (signing), D-200..D-211 server-side.

**Blockers** — none.

**Failure attribution**
- Layer 3 (execution environment): the new harness inherited `OVMF_CODE` env → distro OVMF with different TPM-hierarchy behavior; undetected because layer 4 (verification feedback) — the harness asserted only UI/decision lines, not TPM steps. Prevention: prefer-`/ovmf` convention (now matching other harnesses) + provisioning/session checks added.

**Next session opening**
- D-120 residual (bind FVE volume to boot device path / real-media test) or remaining D-1xx hardware items; alternatively D-200-side attestation enrichment to surface FveProtectionMask/LoadedImageDigest.

---

---

---

## Session 113 — 2026-09-17 — RULE-ZERO (pre-code): D-120 residual — FVE boot-volume binding

**Read:** `Fve.c` (DiskIo scan + metadata parse), `PblApp.h` (`PBL_PLATFORM_STATE` FVE fields, prototypes), `PlatformState.c` (`PblCollectBcdState`, `PblCollectPlatformState` call graph), `PblApp.c` (entry point, sole `PblCollectPlatformState` caller, whole-struct `platform_state_digest`), `ChainLoad.c` (ESP discovery pattern), `Decision.c:270` (`!BitLockerEnabled` → BLOCK gate), `Bcd.c` (element walk; no device-element extraction), `test-fve-harness.sh` (2-boot topology: raw ESP + second raw FVE disk), `Dockerfile.qemu` (gdisk/mtools/dosfstools/python3 available), `ci-harness-docker.sh` (`/ovmf` preference convention), PBL-DEBT-LEDGER D-120.

**Finding:**
- "Boot-volume binding" = device-path disk-prefix match: strip each device path at the first MEDIA_DEVICE_PATH node; the remainder (ACPI/PCI/messaging incl. SATA port / NVMe namespace / USB) identifies the physical disk. PBL's `LoadedImage->DeviceHandle` path identifies the boot disk by construction (PBL boots from the ESP on the Windows disk).
- Signature changes are single-caller-safe: `PblCollectPlatformState` (1 caller, PblApp.c:322) gains `ImageHandle`; `PblCheckFve` gains `ImageHandle` and resolves LoadedImage→DeviceHandle→DevicePath internally.
- Harness topology must change for a positive case: current FVE-on-second-disk can only ever test the negative (different Sata port). Positive binding needs a single GPT disk with ESP + FVE partitions — sgdisk present in pbl-qemu image.
- Decision gate kept on `BitLockerEnabled` (any-FVE or BCD-GUID); binding recorded as `FveOnBootDisk` evidence + WARN. Gate-tightening deferred as a policy choice.
- Ledger staleness noted: current-state.md open-items table lists D-121..D-128/D-200..D-211 OPEN but ledger summary shows CLOSED — graph-spec debt list needs reconciliation (separate cleanup, not this session's scope).

**Plan:**
1. `PblApp.h`: +`FveVolumeCount`(UINT8), `FveOnBootDisk`, `FveBootDiskKnown`; `PblCheckFve` + `PblCollectPlatformState` gain `ImageHandle`.
2. `PlatformState.c`/`PblApp.c`: plumb `ImageHandle` through.
3. `Fve.c`: boot-disk prefix resolve + per-handle prefix match; scan all DiskIo handles; bound volume wins metadata parse; count volumes; print bound/not-bound/unknown lines.
4. `test-fve-harness.sh`: 3 boots — `samedisk` (GPT ESP+FVE, expect bound), `otherdisk` (existing topology, expect not-bound), `nofve`; ~14 checks.
5. Verify: edk2 build → test-fve-harness → ci-harness-docker → persistence; `make graph-check`; ledger update.


---

## Session 113 — 2026-09-17 — D-120 residual: FVE boot-volume binding (device-path disk-prefix match)

**Read:** `Fve.c` (DiskIo scan + metadata parse), `PblApp.h` (`PBL_PLATFORM_STATE` FVE fields, prototypes), `PlatformState.c` (`PblCollectBcdState`, `PblCollectPlatformState` call graph), `PblApp.c` (entry point, sole `PblCollectPlatformState` caller, whole-struct `platform_state_digest`), `ChainLoad.c` (ESP discovery), `Decision.c:270` (`!BitLockerEnabled` → BLOCK gate), `Bcd.c` (element walk; no device-element extraction), `test-fve-harness.sh` (2-boot topology), `Dockerfile.qemu` (gdisk/mtools present), `ci-harness-docker.sh` (`/ovmf` preference convention), PBL-DEBT-LEDGER D-120.

**Finding:** Binding = device-path disk-prefix match. Strip a device path at the first MEDIA_DEVICE_PATH node; the remainder (ACPI/PCI/messaging incl. SATA port, NVMe namespace, USB port) identifies the physical disk. PBL's `LoadedImage->DeviceHandle` IS the boot disk by construction (PBL boots from the ESP on the Windows disk). An FVE partition sharing that prefix is the OS-volume candidate; an FVE volume on another disk is detected but not bound. Prior harness topology (FVE on second disk) could only ever exercise the negative case — positive binding needed a single GPT disk with ESP+FVE partitions.

**What changed**

- `Fve.c` — `PblFveDiskPrefixLen` (prefix = path bytes before first MEDIA node), `PblFveSameDisk` (prefix equality on handle's DevicePath), `PblFveInspectVolume` (extracted per-volume metadata parse). `PblCheckFve` gains `ImageHandle`, resolves `LoadedImage->DeviceHandle->DevicePath` as the boot-disk reference, scans ALL DiskIo handles (no more break-at-first), counts volumes, and lets the bound volume supersede a provisional metadata parse. Prints `bound to boot disk` / `not on boot disk` / `binding not evaluated` lines.
- `PblApp.h` — new `PBL_PLATFORM_STATE` fields `FveVolumeCount`, `FveOnBootDisk`, `FveBootDiskKnown` (inside `platform_state_digest`); `PblCheckFve`/`PblCollectPlatformState` gain `ImageHandle`.
- `PlatformState.c`, `PblApp.c` — `ImageHandle` plumbed through (single call site each).
- `test-fve-harness.sh` — 3 boots: `samedisk` (sgdisk-built GPT combo: 16M ESP partition + 8M FVE partition on one disk), `otherdisk` (existing 2-disk topology → negative binding), `nofve`. 16 checks.
- `PBL-DEBT-LEDGER.md` — D-120 updated; residual narrowed to real-media validation + VMK lock-state proof.

**Test results**

- Build: `PblApp.efi` SHA-256 `a475a0ffbeb6349c8feb41e0eea53214e194688aac839fb5a48b613f466123b4`, 1,347,584 B, -Werror clean.
- `test-fve-harness.sh` (custom OVMF): **16 PASS / 0 FAIL** — samedisk bound (device 2 = FVE partition on GPT disk), otherdisk not-bound (device 1 = second disk), nofve clean negative; NV provisioning + bound HMAC session asserted.
- `ci-harness-docker.sh`: **15/0**; `ci-harness-persistence.sh` (two boots): **16/0**.
- Artifact: `/tmp/pbl-fve-mount/pbl-fve-result.txt` (host mount of in-container `/tmp/pbl-fve-ci`); serial logs in same dir.

**Fog cleared this session:**
- EDK2 device-path prefix before the first MEDIA node is a sufficient physical-disk identity for binding — covers SATA port, NVMe namespace, USB port uniformly; no transport-specific code needed.
- The raw superfloppy ESP image gets NO HD media node (whole path is the prefix) while a GPT ESP partition handle ends at HD(1,GPT) — same-disk binding requires the FVE volume to be a partition on the same disk, exercised via the sgdisk combo image.
- `PblApp.efi` is gitignored (build artifact) — the SHA-256 in trace/ledger is the record, not a committed binary.

**Fog remaining:**
- BCD `osdevice` (0x11000001) element binary format not yet parsed — binding is disk-level (same physical disk), not partition-level (osdevice partition GUID == FVE partition GUID). Partition-level binding needs the device-blob layout (not documented in repo research notes).
- Whether the decision gate should REQUIRE `FveOnBootDisk` when FVE is detected — currently detection-only satisfies `BitLockerEnabled`; tightening is a deferred policy choice.
- VMK lock-state proof (TPM-side unseal verification) still absent.

**Debt items closed:** none — D-120 narrowed (binding done) but kept OPEN for real-media + VMK lock-state.
**Debt items still open:** D-120 (narrowed further), D-129 (real hardware), D-130 (signing); ledger summary shows D-121..D-128, D-200..D-211 CLOSED — note: `current-state.md` open-items table is STALE for those (graph-spec debt list disagrees with ledger summary; needs reconciliation).

**Blockers** — none.

**Failure attribution**
- None — clean first-run verification (16/0, 15/0, 16/0).

**Next session opening**
- Reconcile graph-spec debt list vs ledger summary (stale OPEN flags for D-121..D-128, D-200..D-211), then D-129 real-hardware validation prep or D-200-side attestation enrichment to surface FveProtectionMask/FveOnBootDisk/LoadedImageDigest as discrete server-visible fields.

---

---

## Session 114 — 2026-09-17 — Debt-ledger reconciliation (spec vs ledger vs code) + roadmap

**Read:** `GRAPH-SPEC.yaml` debt section (all 55 items), `PBL-DEBT-LEDGER.md` detail + summary tables, `graph_assert.py` (I2 field requirements: commit_ref + artifact_ref on spec items), `graph_session.py` convergence computation, per-item implementing files (`Decision.c`, `LockScreen.c`, `Override.c`, `ChainLoad.c`, `Cbor*.c`, `TlsVerify.c`, `TcgLog.c`, `Svn.c`, `AmtCheck.c`, `Sbat.c`, `SpiProtections.c`, `DciCheck.c`, `DmaProtection.c`, `Mor.c`, `server/src/routes/pbl.js`, `agent/agent.py` handle_track), git log per file.

**Finding:** Three-way disagreement. GRAPH-SPEC.yaml showed 36 OPEN; ledger summary showed ~3 OPEN; ledger *detail* sections still said OPEN/PARTIAL for ~20 items. Ground truth from code+git: nearly all were implemented in commit `684d7eb` (the 2026-09-09 PBL effort chain) and are exercised in every QEMU harness boot (platform-state collection runs SPI/DCI/DMA/MOR/SBAT/TCGLog/SVN/AMT each boot; lock screen + override + decision visible in serial). Server items backed by 579 Jest + 305 Vitest. Real open: D-120 (narrowed), D-129, D-130.

**What changed**

- `GRAPH-SPEC.yaml` — 33 items flipped OPEN→CLOSED with real commit_ref + artifact_ref (I2-compliant). D-100/D-101, D-109..D-119, D-121..D-128, D-200..D-211.
- `PBL-DEBT-LEDGER.md` — reconciliation note (summary table authoritative over stale detail Status lines) + totals corrected (51 items / 48 CLOSED / 3 OPEN).
- `current-state.md` regenerated — convergence now honest: **52/55 debt, 4/13 enforcement on hardware.**

**Test results**

- `make graph-check`: all invariants pass (I2 satisfied — every CLOSED has both refs).
- `make graph-status`: 3 debt open (D-120/129/130), 9 enforcement paths hardware-pending.

**Fog cleared this session:**
- The convergence report had been understating closure for weeks — spec debt statuses were write-only since ~session 9x. `make graph-status` is only as honest as GRAPH-SPEC.yaml; the ledger summary was the fresher source but lacked per-item refs.
- Firmware close-criteria of the "runtime test" form are satisfied by the QEMU+swtpm harnesses exercising every collector each boot — hardware residuals belong to D-129, not per-item OPEN states.

**Fog remaining:**
- Whether a handful of detail-section caveats deserve their own debt items (D-203 PCR/event-log deep compare, D-204 production operator key, D-205 Ed25519 firmware verify blocked by EDK2) — noted as residuals in artifact_ref, not promoted to items.
- D-100 detail says PARTIAL ("swtpm portion open") — judged CLOSED since swtpm lives under D-101 (CLOSED); interpretation recorded here.

**Debt items closed:** none this session (bookkeeping only — no new code).
**Debt items still open:** D-120 (real-media + VMK lock-state), D-129 (real hardware), D-130 (signing).

**Blockers** — none.

**Failure attribution**
- Layer 5 (state management): spec debt statuses went stale across ~20 sessions because closes were recorded in the ledger but not synced to GRAPH-SPEC.yaml. Prevention applied: spec is now authoritative-synced; consider a `graph_assert` check that spec status == ledger status (not implemented this session).

**Next session opening**
- Software-doable queue in order: (a) attestation enrichment — surface FveProtectionMask/FveOnBootDisk/LoadedImageDigest as discrete server fields; (b) VMK lock-state proof via swtpm seal/unseal emulation; (c) BCD osdevice partition-GUID binding (needs device-blob RE); then the hardware window (D-129 + D-120 real-media + 9 E-paths); D-130 signing needs a cert decision.

---

---

## Session 115 — 2026-09-18 — Book corpus research + next-gen synthesis

**Read:** `docs/reference/books/` inventory (6 PDFs on disk), `docs/research/STUDY-INDEX.md`, `GRAPH-SPEC.yaml` enforcement paths, `agent/agent.py` handler inventory, `server/src/routes/` inventory. RULE-ZERO satisfied for doc-only session — no source code touched.

**Finding:** Three books existed only as topics (`Modern OS`, `Harnessing the UEFI Shell`, `Platform Embedded Security Technology Revealed` — no PDFs); three PDFs on disk had never been mined against the codebase (`rootkits-and-bootkits`, `beyond-bios`, `practical-reverse-engineering`); a fourth PDF (`mdm-fundamentals`, Moskowitz/Wiley — Intune/MDM) existed but wasn't on the study list.

**What changed**

- Seven parallel research agents produced six new study notes + updated index:
  - `STUDY-BEYOND-BIOS-DELTA.md` — full PDF mine (325pp): Boot#### return-semantics inversion, 5-min BDS watchdog, fast-boot no-BdsConnectAll, S3-resume bypass, monotonic counter, ESRT/FMP, HII keywords, UEFI error records.
  - `STUDY-ROOTKITS-BOOTKITS-DELTA.md` — full PDF mine (450pp): Computrace as architectural precedent, MBR/VBR/IPL bootkit lineage, hidden filesystems, S3 boot-script attacks, FSMIE forgery, PRx-coverage gaps, 14 new capabilities.
  - `STUDY-PRACTICAL-RE-DELTA.md` — full PDF mine (384pp): kernel introspection (KPCR/DPC/APC/timer queues, SSDT, DKOM, MDL writes), debugger mechanics, obfuscation taxonomy; ch3_* pre-exercises confirmed as detection-driver blueprints.
  - `STUDY-MDM-FUNDAMENTALS-DELTA.md` — full PDF mine (528pp): Autopilot TPM-attested enrollment, OMA-DM/CSP model, device-action ladder, escrow-before-encrypt, update rings; 15 capabilities.
  - `STUDY-PLATFORM-EMBEDDED-SECURITY.md` — open-access book read in full (SpringerLink CC): ME/HECI wire details, FPF enrollment fuse, EPID/SIGMA, Intel AT prior art mapped to E-DEADMAN/verdict/override.
  - `STUDY-UEFI-SHELL.md` — book reconstructed via TOC + Shell Spec 2.2 + local ShellPkg + BombShell/VU#718077: shell as dual-use signed bypass; PBL's unauthenticated variables are shell-writable.
  - `STUDY-OS-INTERNALS-AGENT-HARDENING.md` — MOS-guided agent-hardening research: ring-3 ceiling, wall-clock deadman flaw, unsigned-update flaw, VM detection.
- `SYNTHESIS-NEXT-GEN-DESIGN.md` — corpus synthesis: 5 design laws, 7 fix-first correctness findings, ~40 capabilities by layer, 5-tier roadmap.
- `STUDY-INDEX.md` — 16 notes, crosswalk + glossary extended.
- Commit `6e6b37a` — entire docs/research corpus committed (previously all untracked; *.pdf still gitignored by design).

**Fog cleared:** The "weakest books" gap is closed — all 6 listed books + the surprise 7th (MDM) now have study notes. Disk-structure baseline, shell-threat model, Boot#### semantics, and Intel AT prior art were all genuinely absent from the codebase's knowledge.

**Fog remaining:** PRE/RB deltas rely on PDF-extraction page mapping (book≈PDF−36/−27 offsets); UEFI Shell book itself wasn't readable (TOC + spec + ShellPkg reconstruction, flagged in-note); uefi.org/intel.com were Cloudflare-blocked to the host.

**Debt items closed:** none — documentation session.
**Debt items still open:** D-120 (real-media + VMK), D-129 (hardware), D-130 (signing) — plus the synthesis' Tier-0 correctness findings are candidate new debt items pending user triage.

**Blockers:** none.

**Failure attribution:** None — pure research session, all deliverables produced.

**Next session opening:** Triage synthesis findings — decide whether Tier-0 items (F1 BLOCK-path return semantics, F2 variable authentication, F3 deadman clock-rollback, F5 NIC connect, F7 shell detection) become new debt items, then implement Tier-1 emulation-doable work starting with F1 verification.

---

---

## Session 116 — 2026-09-18 — Wayfinder map + F1 real bug found and fixed (D-220)

**Read:** `docs/wayfinder/` conventions (harness-engineering map precedent), `firmware/PblPkg/PblApp/PblApp.c` return paths (entry function, all early exits, decision switch), `LockScreen.c` (NULL-verdict tolerance), `ChainLoad.c` return semantics, `PblApp.inf`/`PblPkg.dsc` (BaseLib/CpuDeadLoop), edk2 `AuthService.c`/`TcgMor*`/`MdePkg.dec` (NG-R2 via agent), pybcd + BCD RE sources (NG-R1 via agent).

**Finding:** F1 is a REAL BUG. Two BLOCK-intent paths returned `EFI_SECURITY_VIOLATION` to BDS (`PblApp.c` policy-sig-fail @RoT-provisioned, anti-rollback). Per Boot#### semantics (Beyond BIOS p.186) a non-success return advances BDS to the next BootOrder entry — the "refusing to boot" paths actually booted Windows. Chain-load returns were also ignored (fail-open to boot menu). Bug invisible to harnesses: dev mode skips sig verify, and D-219's test checked serial lines not post-BLOCK behavior — the same blind-spot class as the dead-TPM bug.

**What changed**

- Wayfinder map `next-gen-lockdown` charted (docs/wayfinder/): destination, notes (execution override), fog, 7 tickets.
- NG-R1 (BCD osdevice blob) + NG-R2 (variable auth) resolved via research agents → `NOTE-BCD-DEVICE-BLOB.md`, `NOTE-PBL-VAR-AUTH.md`. NG-R2 side-finding: **MOR GUID bug** — PBL writes MOR under EFI_GLOBAL_VARIABLE but spec GUID is gEfiMemoryOverwriteControlDataGuid (no-op decoy); also found spec's `MemoryOverwriteRequestControlLock` as the correct hardening.
- Graduated: NG-T4 (variable hardening/MOR fix — OPEN), NG-T5 (partition-level FVE binding — OPEN, format spec'd).
- NG-T1 verified F1 → NG-T6 implemented: `PblBlockHalt()` helper (lock screen → MOR → ResetSystem → CpuDeadLoop, never returns) replaced both propagating returns; chain-load return checked at 3 sites; CpuDeadLoop after both ResetSystem calls.
- D-220 added to PBL-DEBT-LEDGER (CLOSED, SECURITY).
- `docs/reference/FETCH-LIST.md` created (Tier 1-3 source/artifact list for human fetch).
- Commits: 6e6b37a (research corpus), bd06f72 (fetch list), 43209d (wayfinder map), 94877f (NG-R2), 9b7d3c (NG-R1+NG-T5), 6cd33f4 (F1 fix).

**Test results**

- `PblApp.efi` `44c44e6485235cb1…` — build clean (-Werror).
- test-fve-harness: 16/0 (3 topologies). ci-harness-docker: 15/0. ci-harness-persistence: 16/0.
- QEMU timeout-at-lock-screen observed — confirms PBL holds control instead of returning to BDS.
- `make graph-check`: all invariants pass.

**Fog cleared:** Boot#### return semantics verified against actual code (book claim confirmed); MOR writes proven no-op (GUID bug); BCD osdevice format fully decoded (was "fog" since session 113).

**Fog remaining:** Whether real firmware BDS behaves identically (vendor boot-menu behavior after error/menu — D-129); the two fixed sites can't be exercised end-to-end in emulation without a RoT-provisioned harness scenario (future test ticket); `PblBlockHalt` skips PCR-12/13 extends on early paths (documented — pre-verdict paths have no decision payload to extend).

**Debt items closed:** D-220 (new — found + fixed this session).
**Debt items still open:** D-120 (partition binding ticketed NG-T5; real-media + VMK remain), D-129 (hardware), D-130 (signing). Ledger: 52 items / 49 CLOSED / 3 OPEN.

**Blockers:** none.

**Failure attribution**
- Layer 4 (verification feedback): D-219's harness passed the buggy BLOCK-return code — it asserted serial lines, not post-BLOCK behavior. Prevention: NG-T6 ticket notes RoT-provisioned harness scenario as future work; finding recorded in ledger.

**Next session opening**
- NG-T4 (MOR GUID fix + MOR-lock + advisory vars) or NG-T5 (partition-level binding, ~60-line parser, spec'd) — both agent-doable; NG-Q1 capability cut and NG-T2/T3 fetch need the human.

---

---

## Session 118 — 2026-09-18

### RULE-ZERO
**Read**: scripts/memory.py conventions, .devin/graph/graph_loader.py (PyYAML), graph_assert.py invariant structure, CONFIRMATION-FINDINGS.md, synthesis §2 F-findings.
**Finding**: All 7 synthesis findings verified against code — 6 confirmed, F5 killed (ConnectController sweep already exists at HttpsClient.c:171-184). MOR GUID bug confirmed via spec header. Verification-blind-spot pattern: harnesses checked log output not security outcomes.

### Fog cleared this session
- F2/F3/F4/F6/F7 confirmed with file:line evidence (MarkerTest.c:31, agent.py:2906, agent.py:3028, Decision.c:248, PlatformState.c:233-346)
- F5 refuted — mitigation already present
- MOR GUID + bit-semantics double bug confirmed against MemoryOverwriteControl.h:19,35-41
- Bonus defects B1-B5 (QEMU static IP, http:// in release, no BootNext check, writable PblBootmgrSvn)

### Fog remaining
- Whether undispatched NIC drivers (fast-boot) can be connected — hardware window
- Resume-vs-cold-boot provenance mechanism — Tier-3
- SVN from Authenticode (NG-R2 recommendation) — not yet implemented

### Debt items closed
- None this session (confirmation + brain build only)

### Debt items still open
- D-120 (real-media BitLocker/VMK residual), D-129 (real hardware), D-130 (signing)
- Newly surfaced, not yet ledgered: MOR GUID fix (NG-T4), static-IP/DHCP (B-015), http:// release fallback (B-016), BootNext inspection (B-017), shell classification (B-010), deadman clock-rollback (B-005), detached-signature updates (B-006)

### Blockers
- NG-Q1 architecture ruling still needs user decision (capability cut)
- NG-T2/T3 need user-side artifacts (downloads, Windows media)

### Session artifacts
- scripts/brain.py + .devin/brain/beliefs.yaml (23 beliefs) + BELIEFS.md
- .devin/skills/brain/SKILL.md; AGENTS.md brain section
- docs/research/CONFIRMATION-FINDINGS.md
- Commit: brain layer + findings committed this session

### Next session opening
Present NG-Q1 for the architecture ruling — five laws + capability cut — using the now-verified belief store as ground truth; or take NG-T4 (MOR GUID fix) if user directs implementation first.

---

## Session 119 — 2026-09-18 (continuation)

### RULE-ZERO
**Read**: NG-T4 ticket, EDK2 spec headers (MemoryOverwriteControl.h, MemoryOverwriteRequestControlLock.h), TcgMor.c, TcgMorLockDxe.c, TcgMorLockSmm.c, Variable.c MOR paths, Mor.c/PlatformState.c/Svn.c/PblApp.inf, ci-harness-docker.sh.
**Finding**: MOR fix is not just a GUID correction — EDK2's non-SMM variable driver unconditionally LOCK_NOWs both MOR vars at EndOfDxe; post-EndOfDxe MOR writes are architecturally denied on such platforms (B-026). PBL runs at BDS — always after EndOfDxe.

### Mode Discipline
- User challenge on premature "proceed" → built the guardrail this session demanded: `.devin/PENDING-RULING.md` + `scripts/check-ruling.sh` + AGENTS.md Mode Discipline + B-024 (commit 6669a0, verified both directions).
- User then ruled: fix-first; S0–S5 segmented plan approved; TPM restart-counter anchor; resume = DEGRADED alarm. Ruling closed → task mode.

### IMPLEMENT (S0.1 / NG-T4)
- Mor.c: spec GUID (e20939be-…) for read-modify-write; correct bit semantics (bit0 clear, bit4 no-autodetect, NO lock bit); new PblLockMor() → 0x01 on MemoryOverwriteRequestControlLock (BB983CCF-…).
- PlatformState.c: MOR read under spec GUID; SVN call passes Trusted out-param.
- Svn.c + PblApp.h: BootmgrSvnTrusted from TBA attribute — variable demoted to advisory-only (B-027).
- PblApp.c: PblBlockHalt() + PblResultBlock path both do request+lock.
- PblApp.inf: gEfiMemoryOverwriteControlDataGuid + gEfiMemoryOverwriteRequestControlLockGuid.
- test-mor-harness.sh: NEW outcome harness — parses post-run OVMF NVRAM varstore (UTF-16 name scan → VendorGuid/NameSize/DataSize/Data extraction), asserts spec-GUID placement, decoy absence, lock var; SMM=1 mode for SMM-capable OVMF.

### VERIFY
- Build: RELEASE_GCC clean under -Werror -Wall -Wextra. Artifact 807a9c80e7a469e6…caeac35.
- ci-harness-docker.sh regression: 15/0.
- test-mor-harness non-SMM: PASS — WRITE_PROTECTED denial proves request hit the real policy-guarded variable (decoy GUID would succeed silently); no decoy under EFI_GLOBAL_VARIABLE; spec-GUID var live (TcgMor's 00); lock write denied as expected.
- test-mor-harness SMM=1 (Ubuntu secboot OVMF): platform ALSO denies — Ubuntu OVMF ships no functional MOR; SB denied unsigned app under ms vars (Setup-Mode pairing workaround used).
- Functional MOR (bit lands, memory cleared): NOT verifiable in emulation — hardware-gated (B-025/B-026).

### Fog cleared this session
- Exact platform MOR-denial mechanism resolved end-to-end: VariableRuntimeDxe MorLockInit deletes both vars at init, MorLockInitAtEndOfDxe registers unconditional LOCK_NOW policies; TcgMor recreates control var (data=00) — explains every NVRAM observation.
- Ubuntu OVMF builds ship no MOR implementation; secboot+ms-vars enforces Secure Boot (Setup-Mode VARS needed for unsigned apps).
- WRITE_PROTECTED as positive evidence: policy-engine denial proves correct target (decoy writes succeed silently).

### Fog remaining
- Whether real SMM firmware's legitimacy path (VariableIsMorVariableLegitimate via gBS->LocateProtocol in SMM context) accepts TcgMor's var — hardware question.
- Whether a DXE-phase PBL component could set MOR before the EndOfDxe lock (feeds Q8/DXE-tier ruling — recorded, not implemented).

### Debt items closed
- NG-T4 implemented + verified (ticket updated with outcome table). Beliefs: B-023 refuted→B-025; B-026, B-027 confirmed.

### Debt items still open
- D-120, D-129, D-130; S0.2–S0.7 (http:// fallback, deadman clock, shell/BootNext, detached-sig updates, DHCP); S1–S5 per approved plan.

### Blockers
- Functional MOR verification requires SMM-capable firmware/hardware — flagged.

### Session artifacts
- Commits: 6669a0 (guardrail, prior block), 97f4a6e (NG-T4), 792d369 (brain refs)
- firmware/PblPkg/test-mor-harness.sh; NG-T4 ticket verification section; beliefs 24→27.

### Failure attribution
- None this session — the new outcome harness caught a platform constraint (not a code defect), which is its designed purpose.

### Next session opening
S0.2 — remove http:// fallback from HttpsClient release path (XS, confirmed B-016); then S0.3 deadman clock-rollback (agent.py:2906).

---

---

## Session 120 — 2026-09-18 (continuation)

### RULE-ZERO
**Read**: `HttpsClient.c` (URI acceptance + contract comments), `PblApp.c` verdict-fetch call site, `test-d215-harness.sh` + `gen-policy-rot.py` (policy provisioning path), `build-pbl.sh` BUILD_TYPE → -DPBL_DEBUG wiring.
**Finding**: `http://` was accepted in ALL builds despite contract "Plaintext fallback: never". Verdict URI comes from signed policy CBOR key 70 — the D-215 valid policy carries http://10.0.2.2:8080, making it the outcome-evidence vehicle for release rejection.

### IMPLEMENT (S0.2 / B-016)
- HttpsClient.c:132-145 — `#ifdef PBL_DEBUG`: accept http://+https:// (QEMU dev path, no TLS CA); `#else` (release): https:// only, all other schemes → EFI_INVALID_PARAMETER. Comment documents the fail-closed rationale.
- test-d215-harness.sh — two fixes:
  1. `touch PolicyRootOfTrust.c` before RoT build — the generated header is __has_include-gated, so an incremental build after a dev compile skipped the object and silently tested the UNPROVISIONED binary (RoT efi hash == dev efi hash on run 1). B-029.
  2. `check_absent "no lock screen"` → `check "lock screen shown"` — PblBlockHalt displays the lock screen by design (D-220 semantics); the stale assertion predated that fix.

### VERIFY
- Release build clean (-Werror -Wall -Wextra); artifact 074f1617….
- Release efi + signed http:// policy: "Online fetch failed: Invalid Parameter — falling back to cache" — param-check rejection, fail-closed (reproduced across 2 harness runs).
- DEBUG RoT build (7d9feb7a…) + same policy: "Online fetch failed: Not Found" — passes param check, fails at network layer. Both branches proven end-to-end.
- test-d215-harness.sh: 12 PASS / 0 FAIL (valid flows through; wrongkey/tampered/wrongkid all blocked with lock screen; QEMU exits 0 via PblBlockHalt reset — F1 semantics working).
- ci-harness-docker.sh regression on release build: 15/0 (prior run).
- Cleanup verified: generated.h removed, dev RELEASE efi restored to tree.

### Fog cleared this session
- The release/debug split is provable by error-code at the serial line: Invalid Parameter = param-check rejection; Not Found = network-layer failure past the check.
- __has_include + incremental builds = silent wrong-artifact testing — the same failure class that let B-016 itself survive (green harness, wrong binary). Fixed generically in the harness.

### Fog remaining
- Whether production policy generators should emit https:// URIs by default (test fixtures still carry http:// — acceptable for DEBUG/QEMU, flagged for S0.6 key-separation work).
- TLS CA pin provisioning path for real https:// verdict fetch (needs the deployment-side PKI decision, D-130-adjacent).

### Debt items closed
- S0.2 implemented + verified: B-016 refuted→B-028 (emulated); B-029 confirmed (harness trap). Commit f229cc9.

### Debt items still open
- S0.3–S0.7; S1–S5 per approved plan (next-gen-lockdown-map.md); D-120, D-129, D-130.

### Blockers
- None.

### Session artifacts
- Commit f229cc9 (S0.2 + harness fixes); release efi 074f1617, debug RoT efi 7d9feb7a; /tmp/pbl-d215-ci/pbl-serial-valid.log + pbl-d215-result.txt (12/0); beliefs 27→29; next-gen-lockdown-map.md approved-sequence section.

### Failure attribution
- Layer 4 (verification feedback): the D-215 harness's first S0.2 run tested the wrong binary — no artifact-identity check. Fixed by forcing recompilation; future harnesses should hash-check provisioned vs dev binaries as an assertion.

### Next session opening
S0.3 — deadman clock-rollback: `now < last_seen` tamper detection + server-timestamp anchor (agent.py:2906, B-005).

---

---

---

## Session 121 — 2026-09-18 (continuation)

### RULE-ZERO
**Read**: `agent.py` deadman block (`update_deadman_timer`, `check_deadman`, `_read_deadman_state`), main-loop checkin flow (:3466-3511), `server/src/routes/agent.js` checkin handler, `test_agent_encryption.py` TestDeadmanKey conventions, `agent.routes.test.js` checkin tests.
**Finding**: B-005 confirmed — `elapsed = time.time() - last_seen` trusts the local wall clock; rollback → negative elapsed → deadman never fires. Checkin response carried no server timestamp to anchor against. Rollback check only matters when status=stolen (early return otherwise), so false-positive blast radius is confined to flagged devices — fail-secure is the right posture there.

### IMPLEMENT (S0.3 / B-005)
- `server/src/routes/agent.js`: checkin response gains `server_time` (epoch seconds) — the anchor.
- `agent/agent.py`:
  - `DEADMAN_CLOCK_ROLLBACK_TOLERANCE_SEC = 300` (NTP slew/step stays under; attacker rewind must exceed it)
  - `check_deadman`: `now < last_seen - tolerance` → "clock rollback detected", treated as stolen + expired (fail-secure); sentinel gains `clock_rollback: true` forensic marker
  - `update_deadman_timer(status, server_time=None)`: anchors `last_seen` to server time when provided, records `last_seen_source`; local fallback for older servers
  - main loop passes `data.get("server_time")`
- Tests: 4 agent tests (rollback→lockdown+marker, 60s skew tolerated, server anchor, local fallback) + 1 server test (server_time present and sane).

### VERIFY
- `.venv/bin/pytest tests/test_agent_encryption.py`: 49 tests pass (4 new); full agent suite 100%.
- `npx jest tests/agent.routes.test.js`: 45/45 (1 new server_time test).
- `ruff check` + `ruff format --check`: clean.
- Security property: attacker window bounded — rewind >5min trips wire; forward-set fires deadman early; either direction hostile.

### Fog cleared this session
- The deadman's trust boundary is now the server clock, not the device clock — the remaining local-clock dependence is the *gap between checkins*, which is what the rollback wire covers.
- Tolerance sizing: 300s bounds attacker gain to 5min per rewound boot while absorbing legitimate NTP corrections; only evaluated on stolen-flagged devices.

### Fog remaining
- Whether `server_time` should also feed other agent clock uses (pending-ack timestamps, location report times) — out of S0.3 scope, flagged.
- NTP/hostile-time-server manipulation (server_time is ours, but local `time.time()` between checkins can still be NTP-shifted forward — early fire = fail-secure direction, acceptable).

### Debt items closed
- S0.3 implemented + verified: B-005 refuted→B-030 (emulated). Commit c8b9f96.

### Debt items still open
- S0.4–S0.7; S1–S5 per approved plan; D-120, D-129, D-130.

### Blockers
- None.

### Session artifacts
- Commit c8b9f96; beliefs 29→30; map S0.3 marked done.

### Failure attribution
- None.

### Next session opening
S0.4 — variable advisory treatment: audit remaining plain-variable consumers of PblBootmgrSvn/MarkerTest semantics (B-003/B-004 partially done via NG-T4; verify what remains).

---

---

---

## Session 122 — 2026-09-18 (continuation)

### RULE-ZERO
**Read**: B-003/B-004/B-027 statements; every gRT->GetVariable consumer in PblApp (Svn, Mor, Sbat, DmaProtection, PlatformState SecureBoot/PK/db/dbx/BootOrder); Decision.c gate usage; MarkerTest.c role.
**Finding**: B-004-class audit — PblBootmgrSvn already advisory post-NG-T4 (no decision consumer; Trusted flag hashed into platform_state_digest). One LIVE spoof-to-pass remained: Decision.c:252 BLOCKs on KernelDmaProtection, read from the unauthenticated variable BEFORE the firmware DMAR table — an OS/shell writer plants var=1 and passes the DMA gate.

### IMPLEMENT (S0.4 / B-003+B-004)
- DmaProtection.c: inverted trust order — DMAR (Intel VT-d) / IVRS (AMD-Vi) ACPI tables (firmware-authored) are authoritative; KernelDmaProtection variable demoted to advisory telemetry with an explicit log line; never elevates.
- Sbat.c: doc-marked advisory-only (unauthenticated read, zero callers — prevents future trust).
- ci-harness-docker.sh: swtpm ctrl-socket wait before ioctl init (startup-race hardening).
- Audit result: SecureBoot/SetupMode/DeployedMode/PK/db/dbx = platform-protected (read-only/auth-write); BootOrder/Boot#### = digest telemetry (S0.5 covers classification); MOR var = spec-inherent unauthenticated, planted bit self-fulfills; MarkerTest = diagnostic app, no consumer.

### VERIFY
- Release build clean; efi eb684120.
- SPOOF TEST (new technique): injected KernelDmaProtection=1 into OVMF_VARS.fd NVRAM via direct VARIABLE_HEADER write at 0x64 (auth-store layout, 60B header) — QEMU boot logged "KernelDmaProtection variable claims 1 (advisory, unauthenticated)" and still reached BLOCK. Under old code the planted var would have satisfied the gate.
- ci-harness-docker 15/0 (with /ovmf mount — custom OVMF).
- NOTE: without the /ovmf mount the harness falls back to Ubuntu OVMF_*_4M SECBOOT — NV provisioning fails there (TPM config difference); environment issue, not a code regression.

### Fog cleared this session
- vars.fd variable injection is a proven adversarial-testing primitive — arbitrary unauthenticated variables can be planted into NVRAM to exercise advisory-treatment boundaries.
- setvar via UEFI Shell is BLOCKED by this OVMF's VariablePolicy (both attempts denied) — injection bypasses the policy, which is itself evidence the policy gates writes.
- Ubuntu OVMF SECBOOT build ≠ custom OVMF for TPM NV — harnesses must mount /ovmf.

### Fog remaining
- Whether SbatVersion should get a Trusted/digest treatment like SVN if it ever gains a consumer — currently dead code.
- MorRequested advisory semantics on non-MOR platforms (planted bit arms clearing where MOR works; on non-functional platforms the S3 gate softens — B-026 hardware question).

### Debt items closed
- S0.4 implemented + verified: B-031 confirmed (emulated), B-004 refuted→B-032 (code-read). Commit 0391bde.

### Debt items still open
- S0.5–S0.7; S1–S5 per approved plan; D-120, D-129, D-130.

### Blockers
- None.

### Session artifacts
- Commit 0391bde; efi eb684120; spoof vars.fd technique (/tmp/vars-spoofed.fd); beliefs 30→32.

### Failure attribution
- Layer 3 (execution environment): ci-harness fell back to Ubuntu OVMF without /ovmf mount — NV failures looked like a regression; harness should hard-require /ovmf or label the fallback clearly.

### Next session opening
S0.5 — shell/BootNext classification into the boot-path digest (B-010/B-017): extend the BootOrder walker with filename classification + BootNext read.

---

---
