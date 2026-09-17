# UEFI Bootkits — Defensive Case-Study Notes

> **Scope:** Defensive architecture, detection, and mitigation analysis only. This note does not contain, explain, or improve bootkit code. It summarizes documented in-the-wild case studies and maps them to the PBL pre-boot lock design.

## Source

- **LoJax** — ESET, *LoJax: First UEFI rootkit found in the wild, courtesy of the Sednit group*, September 2018. Local text: `/tmp/bootkit-docs/lojax.txt` (original PDF at `https://web-assets.esetstatic.com/wls/2018/09/ESET-LoJax.pdf`).
- **MosaicRegressor** — Kaspersky, *MosaicRegressor: Lurking in the shadows of UEFI*, 2020. Local text: `/tmp/bootkit-docs/mosaicregressor.txt` (blog + technical details). Original sources: `https://securelist.com/mosaicregressor/` and Kaspersky APT report.
- **MoonBounce** — Kaspersky, *Technical details of MoonBounce’s implementation*, 2022. Local text: `/tmp/bootkit-docs/moonbounce.txt` (extracted PDF). Original source: Kaspersky Securelist APT report.
- **CosmicStrand** — Kaspersky, *CosmicStrand: the discovery of a sophisticated UEFI firmware rootkit*, 2022. Local text: `/tmp/bootkit-docs/cosmicstrand.txt` (Securelist blog).
- **BlackLotus** — ESET/WeLiveSecurity, *BlackLotus UEFI bootkit: Myth confirmed*, March 2023. Local text: `/tmp/bootkit-docs/blacklotus_eset.txt` (blog). Original source: `https://www.welivesecurity.com/`.
- **LogoFAIL** — Binarly, 2023/2024. Local files: `/tmp/bootkit-docs/binarly_bootkit.html` (JS-only, not useful) and `/tmp/bootkit-docs/binarly_bootkit.txt` (93 characters, not useful). Supplementary sources used: `https://www.binarly.io/advisories/brly-2023-018`, Binarly 6-month report (`https://22222483.fs1.hubspotusercontent-na1.net/hubfs/22222483/Reports/Binarly_LogoFAIL%20REsearch%20Report%206.20.24.pdf`), and `https://www.binarly.io/blog/finding-logofail-dangers-of-image-parsing-system-boot`.
- **Bootkitty** — ESET, *Bootkitty: Analyzing the first UEFI bootkit for Linux*, November/December 2024. Source: `https://www.welivesecurity.com/en/eset-research/bootkitty-analyzing-first-uefi-bootkit-linux/` (retrieved by web fetch; no local text supplied).
- **Local lecture notes** — `/home/cllin/remote-lockdown-system/docs/research/windows-firmware-lecture.md`, Lecture 15 (bootkits, LoJax, Computrace, SPI/ME/Secure Boot bypasses, NIST 800-147/193).
- **PBL Windows 11 RE artifact** — `/home/cllin/remote-lockdown-system/docs/research/windows-11-23h2-iso-RE-findings.md` (BCD/bootmgr context for chain-load hashing).
- **PBL source mapped:**
  - `firmware/PblPkg/PblApp/PblApp.c`
  - `firmware/PblPkg/PblApp/PlatformState.c`
  - `firmware/PblPkg/PblApp/Decision.c`
  - `firmware/PblPkg/PblApp/ChainLoad.c`
  - `firmware/PblPkg/PblApp/SpiProtections.c`
  - `firmware/PblPkg/PblApp/PblApp.h`
  - `docs/adr/PBL-C4-Policy-Blob.md`
  - `docs/adr/PBL-DEBT-LEDGER.md`

**Source gap:** The Binarly LogoFAIL/Bootkitty local files are not useful. `binarly_bootkit.html` is a Next.js skeleton and `binarly_bootkit.txt` is only 93 characters. LogoFAIL/Bootkitty coverage in this note is therefore derived from web-fetched Binarly/ESET reports and is marked as such.

## One-paragraph technical overview

In-the-wild UEFI bootkits achieve persistence at one of three layers: (1) **SPI flash firmware implants** (LoJax, MosaicRegressor, MoonBounce, CosmicStrand), where malicious DXE drivers or patched core firmware modules run during the pre-OS boot phase and install Windows or Linux payloads; (2) **ESP-resident boot managers** (BlackLotus, Bootkitty), which replace or chain-load the OS boot manager without reflashing SPI, sometimes bypassing Secure Boot through vulnerable but signed binaries; and (3) **firmware image-parser vulnerabilities** (LogoFAIL), where malformed boot logos trigger memory corruption in UEFI BMP/JPEG/PNG/PCX/TGA parsers and execute attacker code before the OS loader runs. Defensively, these cases show that SPI write-protect bits, strict db/dbx management, MOK protection, BCD and boot-manager hash verification, loaded-image enumeration, and PCR-based attestation are necessary but each incomplete: a determined actor can still defeat or bypass them, so layered detection and fail-closed policy are required.

## 10-20 key technical facts/mechanisms

1. **LoJax (2018) was the first publicly reported in-the-wild UEFI rootkit.** ESET attributed it to the Sednit group (APT28/Fancy Bear) based on shared C2 infrastructure and co-occurrence with Sednit malware. (`lojax.txt` p. 3–4)
2. **LoJax is a trojanized version of Absolute Software’s LoJack/Computrace anti-theft agent.** It reuses the legitimate product’s “small agent” (`rpcnetp.exe`) and persistence model, but redirects the agent to attacker-controlled C2 servers. (`lojax.txt` p. 5–7)
3. **LoJax’s installer used a signed RWEverything kernel driver (`RwDrv.sys`) and two tools** — `ReWriter_read.exe` to dump SPI flash and `ReWriter_binary.exe` to patch and write it back. (`lojax.txt` p. 9–12)
4. **The malicious DXE driver `SecDxe` registers a callback on `EFI_EVENT_GROUP_READY_TO_BOOT`.** At that event it loads an embedded NTFS driver, writes `rpcnetp.exe` and `autoche.exe` to the Windows NTFS partition, and modifies the `HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\BootExecute` value from `autocheck autochk *` to `autocheck autoche *`. (`lojax.txt` p. 14–17, 425–435)
5. **Because `SecDxe` lives in SPI flash, LoJax persists across Windows reinstallation and hard-disk replacement.** Re-flashing or motherboard replacement is the only reliable remediation. (`lojax.txt` p. 14, 596–601)
6. **MosaicRegressor (2020) was the second known in-the-wild UEFI firmware rootkit and reused leaked Hacking Team `VectorEDK` code.** It was discovered in AMI firmware images using Kaspersky’s Firmware Scanner. (`mosaicregressor.txt` ll. 117–146)
7. **MosaicRegressor adds four malicious UEFI modules:** `SmmInterfaceBase` (registers the `READY_TO_BOOT` callback and loads `SmmAccessSub`), `Ntfs` (Hacking Team NTFS driver), `SmmReset` (sets the `fTA` infection marker variable), and `SmmAccessSub` (drops `IntelUpdate.exe` to the Windows Startup folder and re-writes it if removed). (`mosaicregressor.txt` ll. 145–177)
8. **The MosaicRegressor framework is multi-stage and modular,** using HTTP/HTTPS, BITS, WinHTTP, and even POP3/SMTP/IMAP email for C2, with payloads fetched on demand as DLLs. (`mosaicregressor.txt` ll. 190–207)
9. **MoonBounce (2022), attributed to APT41/Winnti, patches `CORE_DXE` in SPI flash and hooks functions in the `EFI_BOOT_SERVICES` table** — specifically `AllocatePool`, `CreateEventEx`, and `ExitBootServices` — using 5-byte `call`-based prologue overwrites. (`moonbounce.txt` ll. 5–19)
10. **MoonBounce’s in-memory chain uses the `AllocatePool` hook to stage shellcode, the `CreateEventEx` hook to register a `gEfiEventLegacyBootGuid` callback, and the `ExitBootServices` hook to patch `OslArchTransferToKernel` in `winload.efi`.** From there it patches `ExAllocatePool` in `ntoskrnl.exe`, maps a malicious kernel driver, and uses APC injection to place a user-mode stager in `svchost.exe` that downloads the final payload. (`moonbounce.txt` ll. 17–201)
11. **CosmicStrand (2022) resides in Gigabyte/ASUS H81 firmware and is attributed to a Chinese-speaking actor with ties to the MyKings botnet.** It patches the `CSMCORE` DXE driver and propagates through a hook chain: UEFI `HandleProtocol` → boot manager `Archpx64TransferTo64BitApplicationAsm` → `winload.efi` `OslArchTransferToKernel` → `ntoskrnl.exe` `ZwCreateSection`. (`cosmicstrand.txt` ll. 119–183)
12. **CosmicStrand’s kernel shellcode contacts `update.bokts[.]com` using raw TCP/UDP device objects,** reassembles chunked C2 payloads, and a recovered user-mode sample creates a local administrator account named `aaaabbbb`. (`cosmicstrand.txt` ll. 194–216)
13. **BlackLotus (2023) is an ESP-resident UEFI bootkit, not a SPI flash implant, and is the first publicly known bootkit to bypass Secure Boot on fully updated Windows 11.** It has been sold on underground forums since at least October 2022. (`blacklotus_eset.txt` ll. 14–37, 62)
14. **BlackLotus exploits CVE-2022-21894 (“Baton Drop”)** by bringing vulnerable signed Windows binaries (`bootmgfw.efi`, `bootmgr.efi`, `hvloader.efi`) to the victim and using a custom BCD with `avoidlowmemory`, `truncatememory`, `nointegritychecks`, and `testsingsigned` to make `hvloader.efi` load a self-signed `mcupdate_GenuineIntel.dll`/`mcupdate_AuthenticAMD.dll`. (`blacklotus_eset.txt` ll. 231–275)
15. **BlackLotus’s `MokInstaller` enrolls an attacker Machine Owner Key (MOK) into the `MokList` NVRAM variable and replaces the default Windows boot manager with a legitimate Microsoft-signed `shim`.** On subsequent boots, `shim` verifies and chain-loads the attacker’s self-signed bootkit (`grubx64.efi`). (`blacklotus_eset.txt` ll. 284–302)
16. **BlackLotus disables VBS/HVCI via the `VbsPolicyDisable` NVRAM variable, disables Windows Defender by patching `WdBoot.sys`/`WdFilter.sys`, and injects an HTTP downloader into `winlogon.exe`.** It also protects its ESP files from deletion by setting `ProtectFromClose` on open handles. (`blacklotus_eset.txt` ll. 308–407)
17. **LogoFAIL (Binarly, 2023/2024) is a class of vulnerabilities in UEFI image parsers for boot logos (BMP, JPEG, PNG, PCX, TGA).** An attacker with the ability to flash or modify firmware can supply a malformed logo that triggers memory-corruption flaws in the parser, diverting execution before the OS loader runs; Binarly reported it is not stopped by Secure Boot or Boot Guard. (Binarly advisory/report, web sources)
18. **Bootkitty (ESET, 2024) is the first Linux UEFI bootkit proof-of-concept.** It is self-signed, bypasses kernel signature verification by patching GRUB and the Linux kernel EFI stub/decompressed image at hardcoded offsets, and preloads two ELF binaries via the `init` process. ESET assesses it is a PoC and not yet seen in the wild. (`https://www.welivesecurity.com/en/eset-research/bootkitty-analyzing-first-uefi-bootkit-linux/`)
19. **Common defensive controls across these cases include:** enabling UEFI Secure Boot with a tightly managed `db` and up-to-date `dbx`; setting SPI controller write-protect bits (`BIOSWE=0`, `BLE=1`, `SMM_BWP=1`, and Protected Range Registers); using Intel Boot Guard or equivalent verified/measured boot; monitoring `MokList`/PK/db/dbx for unauthorized changes; hashing `bootmgfw.efi` and `BCD`; parsing BCD for dangerous elements; enumerating loaded UEFI images; and performing firmware scans with CHIPSEC or UEFI-level scanners. (`windows-firmware-lecture.md` §15.4, §15.9, §15.10)
20. **PBL can detect the *effects* of these bootkits but cannot directly observe SPI or ME compromise.** It enumerates loaded images (`LoadedImageCount`), computes `bootmgfw.efi` hash against policy (`bootmgr_hash`, C4 key 58), checks SPI protection bits via `SpiProtections.c`, parses BCD for `NOINTEGRITYCHECKS`/`TESTSIGNING`/debug/safe-mode elements, and extends PCR 12/13 with the platform-state digest. (`PblApp.h` ll. 207–295, `PlatformState.c` ll. 880–939, `ChainLoad.c` ll. 217–278, `Decision.c` ll. 140–286, `PBL-C4-Policy-Blob.md` §2.6)

## Glossary terms

- **UEFI bootkit:** Malware that runs in the pre-OS UEFI environment to alter boot flow, disable security features, or persist across OS reinstalls.
- **Firmware rootkit / UEFI firmware implant:** Malware embedded in the SPI flash firmware image, typically as a malicious or patched DXE driver.
- **DXE (Driver Execution Environment):** The UEFI phase in which most drivers are dispatched and boot/runtime services become available.
- **DXE driver:** A PE/COFF UEFI image loaded by the DXE dispatcher; may install protocols or register event callbacks.
- **EFI_BOOT_SERVICES:** The UEFI table of functions (allocation, event, protocol, image, etc.) available before `ExitBootServices()`.
- **EFI_EVENT_GROUP_READY_TO_BOOT:** The event group signaled by the UEFI boot manager just before choosing a boot device; commonly abused by bootkits to execute code before the OS loader.
- **ExitBootServices():** The boundary at which UEFI Boot Services are terminated and the OS loader assumes control of platform memory.
- **OslArchTransferToKernel:** A Windows OS loader function at which many bootkits hook to modify the kernel before it runs.
- **ZwCreateSection:** A Windows kernel routine that CosmicStrand hooks to install its final kernel shellcode.
- **Machine Owner Key (MOK):** A user-managed key list used by Linux `shim` to authorize additional UEFI images under Secure Boot; BlackLotus abuses MOK enrollment.
- **ESP (EFI System Partition):** The FAT32 partition holding OS boot managers, BCD, and other pre-OS files; an alternative persistence location that does not require SPI flashing.
- **BCD (Boot Configuration Data):** The Windows registry-like store that `bootmgfw.efi` reads to determine boot options, debug flags, and recovery paths.
- **BIOSWE / BLE / SMM_BWP / PRR:** Intel SPI controller protection bits controlling BIOS-region write enable, lock enable, SMM-only write access, and protected range coverage.
- **db / dbx:** UEFI Secure Boot signature databases of authorized and revoked images/certificates.
- **Measured boot / PCR attestation:** Recording hashes of boot components into TPM Platform Configuration Registers for later remote or local attestation.
- **Image parser attack surface (LogoFAIL):** UEFI firmware code that decodes BMP/JPEG/PNG/PCX/TGA boot logos; vulnerabilities can be triggered before the OS loader runs.
- **Baton Drop (CVE-2022-21894):** A Windows Secure Boot bypass used by BlackLotus, in which vulnerable Windows boot applications allow the serialized Secure Boot policy to be removed from memory before it is enforced.

## Security implications

- **SPI flash is the highest-impact persistence location.** A malicious DXE driver in SPI flash survives disk replacement and OS reinstallation and can run before any endpoint security product, so write-protection bits and verified boot are the first line of defense.
- **Secure Boot does not block signed-but-vulnerable or maliciously enrolled binaries.** BlackLotus shows that a signed `shim` plus an attacker-controlled MOK, or vulnerable signed Windows binaries in `db`/`dbx` gaps, can defeat Secure Boot without disabling it.
- **ESP-resident bootkits lower the barrier to entry.** Attackers no longer need to defeat SPI protections; they only need admin access to the ESP and a way to bypass Secure Boot or user trust, making persistence easier and more scalable.
- **BCD is a high-value tamper target.** BlackLotus and the Windows RE findings show that `NOINTEGRITYCHECKS`, `TESTSIGNING`, `BOOTDEBUG`, `HYPERVISOR*` and other BCD elements materially change the trust boundary and can disable code-integrity and virtualization-based protections.
- **In-memory hook chains propagate trust violations.** MoonBounce and CosmicStrand demonstrate that a single compromised UEFI component can patch the boot manager, OS loader, and kernel in succession, turning a pre-OS compromise into full OS control.
- **Image parser vulnerabilities (LogoFAIL) expand the attack surface to non-executable data.** A malformed boot logo can execute arbitrary code before PBL or the OS loader even starts, bypassing image-signature checks.
- **MOK and key databases require active lifecycle management.** Without revocation, monitoring, and physical-presence protections, MOK enrollment can be silently abused to maintain persistence.
- **Detection in UEFI is hard and often indirect.** Most defensive tools see the SPI image only from the OS (with firmware scanners) or infer compromise from anomalous boot artifacts, PCR values, or loaded-image counts.
- **Attestation only works if the verifier knows the expected PCR values.** PCR 12/13 extensions by PBL are useful only if the server has a known-good baseline and can detect deviations; a bootkit that runs before PBL can alter the inputs PBL measures.
- **Linux is not exempt.** Bootkitty shows that the same UEFI boot-manager/loader attack patterns can be applied to Linux, using GRUB and kernel-signature checks as targets.

## PBL-specific relevance

- **Loaded image enumeration (RE-hardening #3):** `PlatformState.c` calls `gBS->LocateHandleBuffer(ByProtocol, &gEfiLoadedImageProtocolGuid, ...)` to populate `State->LoadedImageCount`. A LoJax/MosaicRegressor-style DXE driver would appear as an extra loaded image, so the platform-state digest can signal an anomaly to the server. (`PlatformState.c` ll. 910–939; `PblApp.h` ll. 285–290)
- **Limitation of `LoadedImageCount`:** The count alone does not identify which images are loaded and the baseline varies by firmware version, so PBL treats it as a weak detection signal rather than a block criterion. (`PlatformState.c` ll. 917–922)
- **`bootmgr_hash` verification (RE-hardening #2):** `ChainLoad.c` reads `\EFI\Microsoft\Boot\bootmgfw.efi` into a buffer, hashes it with SHA-256, and compares it to `Policy->BootMgrHash` (C4 key 58) before `LoadImage`. This is the direct BlackLotus/CosmicStrand countermeasure: if the boot manager has been replaced, PBL refuses to chain-load. (`ChainLoad.c` ll. 217–278; `PBL-C4-Policy-Blob.md` §2.6)
- **TOCTOU-safe chain-load:** `ChainLoad.c` passes the already-hashed buffer as the `SourceBuffer` to `gBS->LoadImage`, so the loaded bytes are exactly the bytes that were hashed. (`ChainLoad.c` ll. 280–290)
- **SPI protection checks (REQ-03):** `SpiProtections.c` reads the Intel SPI controller HSFS and PRR registers to determine `Bioswe`, `Ble`, `SmmBwp`, and `PrrCoverBios`. `Decision.c` blocks if protections are missing and degrades if they cannot be determined. (`SpiProtections.c` ll. 27–85; `Decision.c` ll. 179–191)
- **BCD parsing (REQ-09):** `PBL_PLATFORM_STATE` stores a SHA-256 of the BCD file (`BcdHash`) and parsed flags for `NoIntegrityChecks`, `TestSigning`, `BootDebug`, `Debug`, `WinPEMode`, `SafeMode`, `HypervisorLaunchType`, etc., matching the real `bootx64.efi` behavior described in the Windows 11 RE findings. (`PblApp.h` ll. 247–273; `windows-11-23h2-iso-RE-findings.md` §3, §4.2)
- **Secure Boot and db/dbx policy (REQ-01/02):** `Decision.c` blocks if `SecureBootEnabled` is false, `SetupMode` is true, or the expected `db`/`dbx` contents are missing. This is the primary defense against unsigned `SecDxe` and against BlackLotus-style MOK/db abuse. (`Decision.c` ll. 154–177)
- **Policy-driven floor controls (REQ-04/06/07/08/10):** `PBL-C4-Policy-Blob.md` carries `firmware_floors`, `amt_allowlist`, `usb_dci_policy`, `tpm_firmware_floors`, `s3_policy`, `kernel_dma_protection_required`, `network_boot_policy`, and `firmware_recovery_expectation`, allowing new bootkit-related mitigations to be pushed as policy rather than firmware updates.
- **PCR 12/13 attestation (C2 §4):** `PblApp.c` extends PCR 13 with the platform-state digest (policy hash, nonce, device ID, PCR 4/5/7/11) and PCR 12 with the final decision. This provides a tamper-evident record of what PBL observed, but the record is only as trustworthy as the pre-PBL environment. (`PblApp.c` ll. 560–634)
- **Fail-closed policy signature and verdict verification:** PBL verifies the COSE_Sign1 policy signature and the verdict signing key chain, and it falls back to cached verdict or blocks if online verification fails. This limits an attacker’s ability to spoof a `UNLOCKED` verdict after tampering with boot files. (`PblApp.c` ll. 236–250, 419–503)
- **What PBL cannot see:** PBL has no direct visibility into SPI flash contents, ME/CSME integrity, Boot Guard state, or UEFI image-parser code. It can only observe the *effects* of compromise: unexpected images, missing SPI protections, BCD changes, and boot-manager hash mismatches.

## Known implementation pitfalls

1. **Bootkit detection by image count is a weak signal.** A count above baseline is suggestive, but benign firmware updates and option ROMs also change the count; without image names or hashes it produces false positives. (`PlatformState.c` ll. 917–922; `PBL-DEBT-LEDGER.md` D-213)
2. **In-memory self-image hashing is non-deterministic.** Prior PBL experiments with `ImageBase = 0` showed that UEFI applies DIR64 relocations differently each boot, making a self-image hash unstable. The lesson is to hash the *file* on the ESP, not the loaded in-memory image. (`PblApp.c` ll. 563–570; `windows-11-23h2-iso-RE-findings.md` §4.5; `PBL-DEBT-LEDGER.md` D-212)
3. **Boot-manager hash must be updated with every OS/Windows build.** `bootmgfw.efi` changes with Windows updates; if the policy `bootmgr_hash` is stale, PBL will block legitimate boots. (`PBL-C4-Policy-Blob.md` §2.6; `windows-11-23h2-iso-RE-findings.md` §4.1)
4. **PCR extensions are not tamper-proof if the attacker runs before PBL.** A malicious DXE driver can extend PCRs or intercept `EFI_TCG2_PROTOCOL`, so the server must compare quotes to a known-good baseline and not trust the PCRs in isolation. (`STUDY-TPM-2.0.md` §Security implications)
5. **BCD tells you boot configuration, not BitLocker/FVE state.** PBL can detect dangerous BCD elements, but the actual encryption/lock state is in the volume’s FVE metadata. (`windows-11-23h2-iso-RE-findings.md` §4.3)
6. **Secure Boot revocation is too slow to be the only control.** BlackLotus exploits a vulnerability fixed in January 2022 but still effective because the affected binaries had not been added to `dbx` a year later. PBL should enforce `dbx` expectations and boot-manager SVN floors in policy. (`blacklotus_eset.txt` ll. 533–540; `PBL-C4-Policy-Blob.md` §2.2)
7. **MOK abuse is hard to detect from UEFI.** PBL can read `MokList` only if the variable is exposed and the policy contains expected fingerprints, but there is no universal `MokList` format or standard verification path. (`blacklotus_eset.txt` ll. 284–302)
8. **ESP-resident bootkits bypass SPI protection checks entirely.** `SpiProtections.c` will report the hardware bits correctly, but a fully protected SPI does not stop BlackLotus or Bootkitty because they do not need to flash firmware. (`blacklotus_eset.txt` ll. 14–37)
9. **Image parser vulnerabilities run before PBL.** A LogoFAIL exploit in early DXE/BDS can execute before PBL is loaded, so PBL cannot protect against it; mitigation must come from OEM firmware updates and secure capsule update verification. (Binarly LogoFAIL report)
10. **Policy parser robustness matters.** A malformed or adversarial policy blob could cause PBL to mis-evaluate checks; `PBL-C4-Policy-Blob.md` identifies CBOR/COSE parsers as fuzz targets. (`PBL-C4-Policy-Blob.md` §7)

## Cross-references to previously studied sources

- **STUDY-UEFI-SPEC-2.10.md** — Provides the UEFI 2.10 foundation for `EFI_EVENT_GROUP_READY_TO_BOOT`, `ExitBootServices()`, `LoadImage()`, `EFI_BOOT_SERVICES`, `EFI_LOADED_IMAGE_PROTOCOL`, and Secure Boot variable semantics that these bootkits abuse.
- **STUDY-EDK2.md** — Explains how EDK II’s DXE dispatcher, image loader, `DxeImageVerificationLib`, and BDS/`UefiBootManagerLib` dispatch the DXE drivers and load `bootmgfw.efi`; relevant to how a malicious DXE driver gets loaded and how PBL chain-loads Windows.
- **STUDY-TPM-2.0.md** — Documents PCR extend semantics, NV indices, HMAC sessions, and `EFI_TCG2_PROTOCOL`; essential for understanding PBL’s PCR 12/13 attestation and why a pre-PBL attacker can influence those PCRs.
- **STUDY-INTEL-PLATFORM-SECURITY.md** — Covers Boot Guard, SPI write-protect bits, Intel ME/CSME, and PTT; explains the hardware roots that PBL cannot directly verify and why it relies on indirect signals such as `Bioswe`/`Ble`/`SmmBwp`.
- **STUDY-WINDOWS-NT-INTERNALS.md** — Describes the Windows boot flow `bootmgfw.efi` → `winload.efi` → `ntoskrnl.exe`, BCD load options, and kernel init; needed to understand how UEFI bootkits bridge into the OS and why `OslArchTransferToKernel` is a common hook point.

## Outstanding questions

1. How can PBL detect an ESP-resident bootkit like BlackLotus or Bootkitty when SPI protections are intact and the boot manager file has not been hash-protected at deployment?
2. What is the minimum viable `dbx` baseline PBL should require before treating a system as “not vulnerable to Baton Drop”? Can the boot-manager SVN floor (C4 key 14) serve as a proxy for `dbx` coverage?
3. How should PBL handle a missing or stale `bootmgr_hash`? Should it degrade, block, or fall back to Secure Boot signature verification only?
4. Can PBL safely read and parse the UEFI `MokList` variable and compare it to a known-good list, or is this a server-side attestation concern?
5. What is the false-positive rate of `LoadedImageCount` anomalies, and would collecting per-image hashes or device paths materially improve detection without exposing PBL to new attack surface?
6. How can PBL distinguish a legitimate Windows recovery/BCD change from a BlackLotus-style BCD replacement before chain-loading?
7. Is there any pre-boot signal PBL can collect that would indicate a LogoFAIL-style image-parser exploit has already executed (e.g., anomalous GOP state, heap corruption, or unexpected loaded modules)?
8. How should PBL respond to a `DEGRADED` platform state caused by unknown SPI protections or no firmware recovery capability when the server verdict is `UNLOCKED`?
9. What is the correct policy action if `BitLocker` is enabled but the BCD `RecoverySequence` or `AutoRecoveryEnabled` values differ from the expected baseline?
10. How much of the CosmicStrand/MoonBounce hook-chain technique can be generalized into PBL policy checks (e.g., verifying that `OslArchTransferToKernel` and `ZwCreateSection` prologues are unmodified) without access to the OS loader or kernel images in UEFI?

## Self-test (UEFI bootkits)

1. **Which was the first in-the-wild UEFI rootkit, and which group was it attributed to?**
   - Answer: **LoJax**, attributed to **Sednit/APT28**. Confidence: high (`lojax.txt` p. 3–4).
2. **Why does a UEFI firmware rootkit in SPI flash survive Windows reinstallation and disk replacement?**
   - Answer: The malicious code is stored in the **motherboard SPI flash**, not on the hard disk, and is loaded by the firmware at every boot. Confidence: high (`lojax.txt` p. 14).
3. **What Windows registry value did LoJax modify to execute its dropped payload at boot?**
   - Answer: `HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\BootExecute`, changing `autocheck autochk *` to `autocheck autoche *`. Confidence: high (`lojax.txt` p. 16, 488–492).
4. **What is the main technical difference between MosaicRegressor and LoJax in terms of dropped file?**
   - Answer: MosaicRegressor’s `SmmAccessSub` drops `IntelUpdate.exe` to the Windows **Startup folder**, while LoJax drops `rpcnetp.exe` and `autoche.exe` and modifies the BootExecute value. Confidence: medium (`mosaicregressor.txt` ll. 160–177; `lojax.txt` p. 16–17).
5. **Which UEFI boot services did MoonBounce hook in `CORE_DXE`?**
   - Answer: `AllocatePool`, `CreateEventEx`, and `ExitBootServices`. Confidence: high (`moonbounce.txt` ll. 17–19).
6. **What is the key Windows function that BlackLotus and CosmicStrand both target in `winload.efi`?**
   - Answer: `OslArchTransferToKernel`. Confidence: high (`cosmicstrand.txt` ll. 178–180; `blacklotus_eset.txt` ll. 356–357).
7. **How does BlackLotus bypass UEFI Secure Boot on a fully patched system?**
   - Answer: It exploits **CVE-2022-21894 (Baton Drop)** using vulnerable signed Windows boot binaries and a custom BCD, then enrolls an attacker **MOK** so a legitimate `shim` will chain-load the self-signed bootkit. Confidence: high (`blacklotus_eset.txt` ll. 231–302).
8. **Where does BlackLotus persist its main bootkit? In SPI flash or on the ESP?**
   - Answer: **On the ESP**, specifically `\EFI\Microsoft\Boot\grubx64.efi`. Confidence: high (`blacklotus_eset.txt` ll. 151–164, 302).
9. **What is the defensive significance of LogoFAIL?**
   - Answer: It shows that **UEFI image-parser code** for boot logos (BMP/JPEG/PNG/PCX/TGA) can be exploited to run arbitrary code before the OS loader, bypassing Secure Boot and Boot Guard. Confidence: medium (Binarly LogoFAIL report, web search).
10. **Which PBL policy field is intended to prevent a BlackLotus-style boot-manager replacement?**
    - Answer: `bootmgr_hash` (**C4 key 58**), enforced by `ChainLoad.c` before `LoadImage`. Confidence: high (`PBL-C4-Policy-Blob.md` §2.6; `ChainLoad.c` ll. 217–278).
