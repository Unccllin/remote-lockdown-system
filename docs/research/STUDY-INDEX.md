# PBL Technical Study Index

> **Purpose:** Master cross-reference for the sixteen PBL technical-study notes. Use this file to find which study note covers a concept, which PBL source file it informs, and which open debt items it affects. It is a synthetic index, not a replacement for the detailed notes.

## 1. Study source map

| # | Note file | Source type | Primary topics | PBL relevance |
|---|-----------|-------------|----------------|---------------|
| 1 | <ref_file file="/home/cllin/remote-lockdown-system/docs/research/STUDY-UEFI-SPEC-2.10.md" /> | Specification | UEFI 2.10 boot/runtime services, protocols, variables, Secure Boot, BDS/TSL window | All PBL UEFI protocol and variable usage; `LoadImage`/`StartImage`, `gRT->GetVariable` |
| 2 | <ref_file file="/home/cllin/remote-lockdown-system/docs/research/STUDY-EDK2.md" /> | Reference implementation | EDK II build system, `BasePeCoffLib`, `DxeImageVerificationLib`, BDS, `Tcg2Protocol`, `Http`/`Tls` | `PblPkg` build, `.reloc`/`LTO`, `GenFw`, `ChainLoad.c`, `HttpsClient.c` |
| 3 | <ref_file file="/home/cllin/remote-lockdown-system/docs/research/STUDY-TPM-2.0.md" /> | Specification | TPM 2.0 architecture, PCRs, NV, authorization sessions, attestation | `TpmClient.c`, `TpmSession.c`, `TcgLog.c`, PCR 12/13, `Override.c` |
| 4 | <ref_file file="/home/cllin/remote-lockdown-system/docs/research/STUDY-INTEL-PLATFORM-SECURITY.md" /> | Vendor documentation | Boot Guard, TXT, PTT/CSME/ME, SPI protections, SMM, DMA | `PlatformState.c`, `SpiProtections.c`, `DmaProtection.c`, `AmtCheck.c`, `DciCheck.c`, `Mor.c` |
| 5 | <ref_file file="/home/cllin/remote-lockdown-system/docs/research/STUDY-WINDOWS-NT-INTERNALS.md" /> | OS internals (authorized docs + ReactOS) | Windows boot chain, PE/COFF, `ntoskrnl.exe`, `winload.efi`, BCD, `ExitBootServices` | `ChainLoad.c`, `Bcd.c`, `Decision.c`, lock/allow boundary |
| 6 | <ref_file file="/home/cllin/remote-lockdown-system/docs/research/STUDY-UEFI-BOOTKITS.md" /> | Case studies | LoJax, MosaicRegressor, MoonBounce, CosmicStrand, BlackLotus, LogoFAIL, Bootkitty | `bootmgr_hash`, `LoadedImageCount`, `Sbat.c`, `Decision.c` |
| 7 | <ref_file file="/home/cllin/remote-lockdown-system/docs/research/STUDY-ACADEMIC-FIRMWARE-SECURITY.md" /> | Academic papers / standards | SoK UEFI, Peacock, UEFI memory forensics, vTPM/fTPM, NIST SP 800-155, TCG FIM, RFC 9683, BootHole | Attestation baselines, event-log integrity, runtime observability, COSE/remote attestation |
| 8 | <ref_file file="/home/cllin/remote-lockdown-system/docs/research/STUDY-FIRMWARE-SECURITY-TALKS.md" /> | Conference talks | Black Hat / REcon / CanSecWest / DEF CON / UEFI Forum material | S3/SMM/SPI/Option ROM/EBC/Secure Boot variable attacks and mitigations |
| 9 | <ref_file file="/home/cllin/remote-lockdown-system/docs/research/STUDY-RESEARCH-BLOGS-EDK2-PITFALLS.md" /> | Research blogs / post-mortems | Binarly, ESET, Kaspersky, EDK II bug trackers | `ForceReloc.c`, `PblPkg.dsc` `-fno-lto`, EDK II TLS caveats, BDS device discovery, `dbx`/SBAT |
| 10 | <ref_file file="/home/cllin/remote-lockdown-system/docs/research/STUDY-BEYOND-BIOS-DELTA.md" /> | Book (Beyond BIOS 3rd ed., Zimmer/Rothman/Marisetty 2017, UEFI 2.6/PI 1.5 era) | Boot-manager policy semantics (Boot#### return codes, watchdog, Driver#### ordering), BDS↔dispatcher handshake, connect-on-demand, S3/capsule boot paths, console splitter, HII config, monotonic counter, ESRT/FMP | `PblApp.c`, `ChainLoad.c`, `LockScreen.c`, `HttpsClient.c`, `Verdict.c`, `Mor.c`, `SpiProtections.c`, D-129/D-130 deployment |
| 11 | <ref_file file="/home/cllin/remote-lockdown-system/docs/research/STUDY-PLATFORM-EMBEDDED-SECURITY.md" /> | Book (open access, Intel engineer) | ME/CSME internals, HECI, secure storage, FPFs, EPID/SIGMA, Boot Guard, PTT, DAL, IPT, Intel AT prior art | `AmtCheck.c`, `DciCheck.c`, `Verdict.c`, `Decision.c`, `Override.c`, agent `handle_track`/`check_deadman`, E-TRACK, E-DEADMAN, D-127 |
| 12 | <ref_file file="/home/cllin/remote-lockdown-system/docs/research/STUDY-UEFI-SHELL.md" /> | Book + specification + reference implementation | *Harnessing the UEFI Shell* 2nd ed. (Rothman/Zimmer/Lewis, De Gruyter 2017), UEFI Shell Spec 2.2, EDK II `ShellPkg`; shell protocols, command set, `.nsh` scripting, `startup.nsh`, shell as diagnostic tool AND signed Secure Boot bypass (BombShell, VU#718077) | `Decision.c`, `PlatformState.c` (`Boot####`/BootOrder), `Mor.c`, `Svn.c`, `MarkerTest.c` (unauthenticated variables shell-writable), E-HP-UEFI hardening, deployment diagnostics |
| 13 | <ref_file file="/home/cllin/remote-lockdown-system/docs/research/STUDY-ROOTKITS-BOOTKITS-DELTA.md" /> | Book delta (Matrosov/Rodionov/Bratus, *Rootkits and Bootkits*, 2019) | Computrace/LoJack anti-theft precedent, Option ROMs, SMI/`SmiFlash` update abuse, S3 boot script, ME/AMT/BMC, MBR/VBR/IPL/`HiddenSectors` bootkits (TDL4/Olmasco/Rovnix/Gapz), hidden filesystems, storage-stack hooks, ELAM/`g_CiEnabled`/HVCI, APC/DPC/timer/work-item enumeration (ch3 exercises), MBR ransomware, firmware forensics/FSMIE | `PlatformState.c`, `SpiProtections.c`, `Decision.c`, `Mor.c`, `AmtCheck.c`, `LockScreen.c`, `Fve.c`, agent `tamper_protection.py`/`hw_test_harness.py`/`offline_recovery.py` |
| 14 | <ref_file file="/home/cllin/remote-lockdown-system/docs/research/STUDY-PRACTICAL-RE-DELTA.md" /> | Book delta (Dang/Gazet/Bachaalany, *Practical Reverse Engineering*, Wiley 2014) | Kernel introspection (KPCR/KPRCB, DPC/timer/APC/work-item queues, SSDT encoding, DKOM, MDL kernel writes), notify-callback weaknesses, debugger mechanics (0xCC vs DR0-7), obfuscation taxonomy + deobfuscation signals, PE/COFF internals | `ChainLoad.c` (PE structural validation), `Bcd.c` (debug-flag hard block), `agent.py` tamper_protection, ch3_* exercise drivers as detection-driver blueprints |
| 15 | <ref_file file="/home/cllin/remote-lockdown-system/docs/research/STUDY-OS-INTERNALS-AGENT-HARDENING.md" /> | Book-guided research (Tanenbaum *Modern Operating Systems*, security-relevant chapters + labeled primary-source substitutions) | Ring-3 agent ceiling vs admin adversary, process/module listing forgery, `hidepid`/ETW/Toolhelp, NTFS ADS, wall-clock tamper vs monotonic time, `LockWorkStation`/desktop model, VM/snapshot detection, watchdog/service-recovery primitives | `agent/agent.py` (deadman, tracking, offline queue, update), `tamper_protection.py`, `watchdog.py`, `service_installer.py`, E-TRACK/E-DEADMAN/E-GUARDIAN/E-AUTO-UPDATE/E-OFFLINE-QUEUE |
| 16 | <ref_file file="/home/cllin/remote-lockdown-system/docs/research/STUDY-MDM-FUNDAMENTALS-DELTA.md" /> | Book delta (Moskowitz, *MDM: Fundamentals, Security, and the Modern Desktop*, Wiley 2019) | Intune/AAD enrollment models (Autopilot TPM attestation, hardware hash, WCD bulk tokens), OMA-DM/CSP policy model, compliance+conditional-access chain, device-action ladder (retire/wipe/reset), BitLocker escrow-before-encrypt, update rings | `server/src/routes/{agent,devices,pbl}.js`, `agent/agent.py`, ADRs C1–C4, enrollment/verdict/key-escrow design, E-ACK command lifecycle |

## 2. PBL component crosswalk

| PBL component / concern | Informed by study notes | Key topics in those notes |
|-------------------------|--------------------------|---------------------------|
| `PblApp.c` — main UEFI application entry, console, event handling | 1, 2 | UEFI boot services, `EFI_EVENT_GROUP_READY_TO_BOOT`, BDS ordering |
| `ChainLoad.c` — hash and load `bootmgfw.efi` | 1, 2, 5, 6, 9 | PE/COFF loading, `.reloc`, TOCTOU, BlackLotus, CosmicStrand, `LoadImage`/`StartImage` |
| `Bcd.c` — BCD parser and dangerous-element detection | 5, 6 | Windows BCD elements, `winload` behavior, bootkit BCD tampering |
| `Decision.c` — final lock/allow/degraded decision | 1, 2, 3, 4, 6, 8, 9, 12, 13 | Secure Boot, `db`/`dbx`, SPI, DMA, MOR, S3, TPM auth, `dbx`/SBAT, PKfail/BYOVD, shell presence/`Boot####` tampering, resume-vs-cold-boot policy |
| `PlatformState.c` — platform-state digest for PCR 13 | 1, 2, 4, 6, 7, 8, 12, 13 | UEFI variables, SPI/DMA/MOR/S3, BCD, loaded images, event log, baselines, shell/`bcfg`-visible `Boot####` surface, disk boot-structure baseline, Option-ROM image classification, PCR 5 partition-table signal |
| `SpiProtections.c` — SPI write-protect checks | 4, 6, 8, 13 | `BIOSWE`/`BLE`/`SMM_BWP`/`PRR`/`FLOCKDN`, LoJax/MoonBounce, S3 resume, PRx-vs-FREG1 coverage (CHIPSEC `bios_wp` misconfig evidence) |
| `DmaProtection.c` — DMA and Kernel DMA protection | 1, 4 | `KernelDmaProtection` variable, VT-d, ThunderStrike 2, TXT DPR/PMR |
| `Mor.c` — Memory Overwrite Request | 1, 8, 13 | `MemoryOverwriteRequestControl`, S3 boot-script attacks, cold-boot mitigations, S3 boot-script table tamper/`AcpiGlobalVariable` |
| `Sbat.c` — SBAT level enforcement | 6, 9 | BootHole, GRUB/shim revocation, Bootkitty Linux bootkit |
| `Svn.c` — Secure Boot SVN / signing version | 6, 8, 9 | BlackLotus/Baton Drop, `dbx` revocations, vulnerable signed Windows binaries |
| `AmtCheck.c` / `DciCheck.c` — Intel ME/AMT/DCI checks | 4, 11, 13 | CSME/ME/AMT, HECI, DCI debug, USB4/Thunderbolt DCI, ME task isolation, debug fuses, AMT activatable on non-vPro, powered-off attack surface |
| `TpmClient.c` / `TpmSession.c` — TPM command interface | 2, 3 | `EFI_TCG2_PROTOCOL`, command/response format, HMAC/policy sessions |
| `TcgLog.c` — event-log handling (currently a stub) | 3, 7 | TCG event log, PCR reconstruction, reference integrity manifest |
| `Policy.c` / `PolicyRootOfTrust.c` — C4 policy parsing and root-of-trust | 1, 2, 3, 4, 6, 7, 9 | Secure Boot variables, measured boot, attestation, `dbx`/`SBAT`, PKfail |
| `Verdict.c` — server verdict fetch and validation | 2, 3, 6, 7, 9 | HTTPS/TLS, COSE_Sign1, attestation binding, server key compromise |
| `HttpsClient.c` / `TlsVerify.c` — pre-boot HTTPS client | 1, 2, 9 | `EFI_HTTP_PROTOCOL`, `EFI_TLS_PROTOCOL`, `TlsCaCertificate`, TLS security level, wildcard certs |
| `LockScreen.c` — lock UI | 1, 5, 13 | UEFI graphics protocols, Windows boot chain, no OS control yet, MBR-ransomware screen differentiation |
| `Override.c` — operator override challenge/response | 3, 7 | TPM NV, PCR-based policy, C1 contract, attestation |
| `CborDecode.c` / `CborEncode.c` / `CoseVerify.c` | 2, 7 | COSE_Sign1, CBOR, policy/verdict signing, remote-attestation formats |
| `PblPkg.dsc` / `ForceReloc.c` | 2, 9 | EDK II build, `.reloc` generation, LTO, HP/Insyde compatibility |
| `PblApp.inf` | 2, 9 | INF sources list, `ForceReloc.c`, build module types |

## 3. Master glossary

> Terms are alphabetized. Definitions are intentionally brief; see the linked note(s) for full context.

- **Absolute relocation (`R_X86_64_64`)** — ELF relocation that encodes a 64-bit absolute address. EDK II `GenFw` converts these into PE/COFF `.reloc` base-relocation entries. → 2, 9
- **ACM (Authenticated Code Module)** — Intel signed module (e.g., BIOS ACM, SINIT ACM, Boot Guard ACM) used by Boot Guard and TXT to establish a verified/ measured root. → 4, 11
- **AF (After Life)** — final PI phase; UEFI Runtime Services remain but Boot Services are gone. → 1
- **AMT (Active Management Technology)** — Intel ME subsystem for out-of-band management (WS-MAN, KVM/IDE-R/SOL); PBL checks if provisioned. CCM/ACM control modes. → 4, 11
- **APT28 / Sednit** — threat group associated with LoJax. → 6
- **APT41 / Winnti** — threat group associated with MoonBounce. → 6
- **Authenticated UEFI variable** — Variable stored with `EFI_VARIABLE_AUTHENTICATED_WRITE_ACCESS`; updates must be signed by the key that controls the variable namespace (e.g., PK/KEK). → 1
- **Base relocation (`IMAGE_REL_BASED_DIR64`, etc.)** — PE/COFF fixup applied by the loader when an image is loaded at a different base address. → 2, 5, 9
- **Baton Drop (CVE-2022-21894)** — Vulnerability in the Windows `revoke.efi`/`bootrec` tool chain used by BlackLotus to install a UEFI bootkit while Secure Boot is enabled. → 6, 9
- **BCD (Boot Configuration Data)** — Windows binary registry used by `bootmgfw.efi`/`winload.efi`; stores boot options and dangerous flags (`NoIntegrityChecks`, `TestSigning`, etc.). → 5
- **BDS (Boot Device Selection)** — PI phase that discovers devices, creates `Boot####` variables, and selects/starts the OS loader. PBL runs in the BDS/TSL window. → 1, 2
- **BIOSWE (BIOS Write Enable)** — SPI controller bit that, when set, allows the host to write to the BIOS flash region. → 4, 6
- **BIT (Boot Integrity Token)** — UEFI 2.11 concept for runtime measurement continuity. Not used by PBL today. → 1
- **BitLocker / FVE** — Windows full-volume encryption; key release can be sealed to TPM PCRs. PBL's `BitLocker check` is currently incomplete (D-120). → 3, 5
- **BLE (BIOS Lock Enable)** — SPI controller bit that, when set and `BIOSWE=1`, triggers an SMI on host flash-write attempts (if `SMM_BWP` enforced). → 4
- **Boot000x / Boot####** — UEFI NVRAM variables holding a single boot option; `BootOrder` defines the order. → 1, 2
- **Boot Guard** — Intel verified/measured boot: CPU microcode/ME fuses + ACM + IBBM + IBB. PBL cannot directly inspect the fuses but can check SPI protection and `Sbat`. → 4, 11
- **BootHole (CVE-2020-10713)** — Signed GRUB `.mod` loading vulnerability; requires SBAT enforcement to mitigate. → 6, 7, 9
- **Bootkitty** — First publicly analyzed Linux UEFI bootkit PoC; uses LogoFAIL and patches GRUB/kernel. → 6, 9
- **Bootmgr / `bootmgfw.efi`** — Windows UEFI boot manager; PBL hashes it and passes the same buffer to `LoadImage`. → 2, 5
- **Boot services (`EFI_BOOT_SERVICES`)** — UEFI services (memory, events, protocols, image, variable, etc.) available before `ExitBootServices()`. → 1
- **Bootkit** — Malware that runs before or during the OS loader, often in UEFI firmware or the ESP, to maintain persistence and bypass OS security. → 6, 8
- **BYOVD — UEFI version** — "Bring Your Own Vulnerable (signed) Driver/Module" attack, used to bypass Secure Boot. → 8, 9
- **Capsule update** — Signed UEFI firmware update mechanism; uses authenticated variables and monotonic counters. → 1, 9
- **Certificate table (PE data directory 4)** — Points to the PE/COFF certificate directory used by `DxeImageVerificationLib` for Secure Boot signature checks. → 2, 9
- **CHIPSEC** — Open-source framework for platform security assessment (SPI, SMM, S3, Secure Boot variables, etc.). → 8, 13
- **Code Integrity (`ci.dll` / `nt!g_CiEnabled`)** — Windows kernel code-signing enforcement; pre-Win8 a single variable disabled it (Uroburos via signed `VBoxDrv.sys`), now isolated under VBS/HVCI. → 13
- **Computrace / LoJack (Absolute Software)** — Legitimate firmware-resident anti-theft stack (DXE installer writes `rpcnetp.exe` into NTFS, SMM services, cloud C2, remote wipe); closest public architectural precedent for PBL + agent. → 13
- **CLANGDWARF** — EDK II LLVM/clang toolchain; historically has GOTPCRELX and visibility issues. → 2, 9
- **CMC (Content Modification Check)** — UEFI 2.11 optional feature for measuring files. Not used by PBL today. → 1
- **COSE_Sign1** — CBOR Object Signing and Encryption signature format; PBL policy/verdict signing intends to use it (D-205). → 7
- **CORE_DXE** — EDK II DXE core image; MoonBounce patches this image in SPI flash to install hooks. → 6
- **CosmicStrand** — 2022 UEFI rootkit observed on Gigabyte/ASUS H81; chains hooks through boot manager → `winload.efi` → `ntoskrnl.exe`. → 6
- **CSME (Converged Security and Management Engine)** / **ME** — Intel PCH subsystem hosting PTT, AMT, and silicon initialization; has its own ROM and secure boot. → 4
- **D-100..D-211** — PBL debt items. See `docs/adr/PBL-DEBT-LEDGER.md`. → 7, index §6
- **db** — UEFI Secure Boot allowed-signatures database. → 1
- **dbt** — UEFI Secure Boot allowed-signature timestamps (used for time-of-revocation checks). → 1
- **dbx** — UEFI Secure Boot forbidden-signatures database; critical for revoking vulnerable signed loaders. → 1, 6, 9
- **dbr** — UEFI Secure Boot recovery-signatures database. → 1
- **DCI (Direct Connect Interface)** — Intel debug over USB/Thunderbolt; PBL checks if DCI is enabled. → 4
- **DAL (Dynamic Application Loader)** — ME-resident JVM task loading Intel-signed Java applets (e.g., IPT); manifest DAL-flag separates applet vs. firmware images. → 11
- **Deadman's switch** — PBL enforcement path (E-DEADMAN); lock triggers if no server heartbeat within a window. → current-state, 11
- **Decision (PBL)** — `Decision.c` / `EvaluatePolicy()` combines local policy, platform state, and server verdict into `BLOCK`, `DEGRADED`, or `ALLOW`. → 2, 3, 4, 6
- **DEGRADED** — PBL verdict level that may allow boot with restrictions (e.g., local-only recovery) rather than an absolute block. → 2, 4
- **Device Path** — UEFI data structure describing a device or file location; used in boot options and file protocol handles. → 1
- **DHT (Device Path)** — see Device Path.
- **DMA Protected Range (DPR)** — TXT-protected physical memory range used to shield the MLE from DMA. → 4
- **DRTM (Dynamic Root of Trust for Measurement)** — TXT `GETSEC[SENTER]` launch; measured environment starts at runtime, not reset. → 4
- **DxeCore** — EDK II core DXE dispatcher and image loader; owns `LoadImage`/`StartImage` in DXE. → 2
- **DXE (Driver Execution Environment)** — PI phase where most UEFI drivers and applications (including PBL) run. → 1, 2
- **DxeImageVerificationLib** — EDK II library that implements Secure Boot signature verification for `LoadImage`. → 2, 9
- **E2B (End-to-Boot)** — shorthand for PBL's pre-OS lock decision point. → 2
- **EBC (EFI Byte Code)** — UEFI portable byte code; runtime interpreter enlarges attack surface and has been used in exploits. → 8, 9
- **EDK II** — Reference implementation of UEFI/PI, primary build environment for PBL. → 2
- **ELAM (Early Launch Anti-Malware)** — Boot-driver vetting from only name/registry/cert/hash (no image access); runs after bootkit injection points, default policy loads known-bad *critical* drivers. → 13
- **EFI_HTTP_PROTOCOL** — UEFI protocol used by PBL for verdict fetch. → 1, 2
- **EFI_IMAGE_FILE_RELOCS_STRIPPED** — PE/COFF flag indicating no base relocations are present; loader will not relocate the image. → 2, 9
- **EFI_RNG_PROTOCOL** — Entropy source for nonces and TLS; D-118. → 1, 9
- **EFI_SECTION / FFS** — Firmware file system sections inside an EDK II firmware volume. → 2
- **EFI_SIGNATURE_LIST** — Format used for Secure Boot variables and the `TlsCaCertificate` variable. → 1, 9
- **EFI_SIMPLE_FILE_SYSTEM_PROTOCOL** — File system protocol used by PBL to read BCD/ESP files. → 1
- **EFI_SYSTEM_TABLE** — UEFI global table containing boot/runtime services and configuration tables. → 1
- **EFI_TCG2_PROTOCOL** — EDK II interface to TPM 2.0 used by PBL for PCR extend/quote/submit. → 2, 3
- **EFI_TIME** — UEFI real-time clock structure; used by PBL for deadman/heartbeat windows. → 1
- **EFI_TLS_PROTOCOL** — UEFI TLS protocol used by `HttpsClient.c`; one-way server auth only. → 1, 2, 9
- **EFI_VARIABLE_BOOTSERVICE_ACCESS** / **RUNTIME_ACCESS** / **NON_VOLATILE** — Variable attributes. PBL uses non-volatile variables for counters and state. → 1
- **Endorsement hierarchy** — TPM hierarchy rooted in the endorsement primary seed, used for identity/attestation keys. → 3
- **EPID (Enhanced Privacy ID)** — Intel anonymous group-signature attestation: unique per-part private key in fuses, shared group public key; Priv-RL/Sig-RL/Group-RL revocation. → 11
- **ESP (EFI System Partition)** — FAT32 partition holding `bootmgfw.efi`, `BCD`, `shim`, GRUB, etc.; ESP-resident bootkits (BlackLotus) do not need SPI. → 1, 6
- **Event log (TCG)** — Log of measurements extended into PCRs, used to reconstruct and verify PCR state. → 3, 7
- **ExitBootServices()** — UEFI service that terminates Boot Services; once called, UEFI drivers/apps cannot use protocols. The OS loader/ `winload` runs after. → 1, 5
- **fTPM (firmware TPM)** — AMD/ARM/Intel firmware-based TPM, usually inside a TEE/SEV/CSME. PTT is Intel's fTPM. → 7
- **FIM (Firmware Integrity Measurement)** — TCG PC Client spec for event-log + reference integrity manifest + verifier workflow. → 7
- **FPF (Field Programmable Fuse)** — One-time-programmable fuse block inside ME/CSME holding OEM key hashes, boot policy, SVN counters, and feature-enrollment bits (e.g., Intel AT). → 4, 11
- **FIT (Firmware Interface Table)** — Intel SPI flash pointer table at `0xFFFFFFC0` to ACM, IBBM, etc. → 4
- **FLOCKDN** — Intel SPI flash controller lock bit that, once set, prevents further `PRR`/SMM_BWP changes. → 4
- **FSMIE (Flash SPI SMI# Enable)** — HSFC bit that fires an SMI at SPI cycle completion; an SMM implant can use it to forge software-side firmware dumps (FDATAX rewrite). → 13
- **FVE (Full Volume Encryption)** — BitLocker metadata; true lock/unlocked state requires FVE metadata and TPM, not BCD alone. → 3, 5
- **FwHunt** — Binarly's firmware-hunting rule format for UEFI implants. → 9
- **GCC** — Default EDK II GNU toolchain for `PblPkg`; `-fno-lto` is required for `.reloc`. → 2, 9
- **GenFw** — EDK II tool that converts ELF/DLL to PE/COFF `.efi`; source of `.reloc`/LTO/GOTPCRELX pitfalls. → 2, 9
- **GOP (Graphics Output Protocol)** — UEFI display protocol; GOP image parsers are an attack surface (LogoFAIL/GOP Complex). → 1, 8
- **GOTPCREL / GOTPCRELX** — x86_64 ELF relocation types using the Global Offset Table; LLD relaxation can confuse `GenFw`. → 9
- **GRUB / shim** — Linux bootloaders; `shim` manages the MOK list; BootHole and Bootkitty target GRUB. → 6, 7, 9
- **HAL (Hardware Abstraction Layer)** — Windows `hal.dll`; abstracts CPU/chipset from the kernel. → 5
- **HECI** — Host-ME communication interface; AMT/PTT exposed over PCI at B0:D22:F0; ~1-12 KB unencrypted client-ID-addressed messages; the missing driver for D-127. → 4, 11
- **Hidden filesystem (bootkit)** — Custom encrypted FS in unallocated disk space (TDL4/Olmasco/Rovnix/Gapz); accessed via private device objects/symlinks, invisible to Win32 APIs, requires offline imaging + per-family parsers (HiddenFsReader). → 13
- **HiddenSectors (NTFS BPB field)** — 4-byte VBR field locating the IPL; Gapz rewrites it to point at staged bootkit code — smallest in-the-wild bootkit footprint. → 13
- **HMAC session (TPM)** — Password-bound session authorizing commands; PBL currently falls back to `TPM_ST_NO_SESSIONS`. → 3
- **HTTPS boot** — UEFI boot over TLS; EDK II supports only one-way server auth and has certificate/level/wildcard pitfalls. → 2, 9
- **IBB (Initial Boot Block)** — Intel Boot Guard verified boot block checked by microcode/ACM. → 4
- **Intel AT (Anti-Theft Technology)** — ME-era hardware anti-theft: rendezvous timer, poison pill over IP/3G-SMS, chipset crypto-material erasure, passphrase/token recovery; EOL 2015. Historical prior art for PBL's lock/deadman design. → 11
- **IPT (Identity Protection Technology)** — ME-hosted TOTP/OCRA token + Protected Transaction Display via PAVP. → 11
- **IBBM (Initial Boot Block Manifest)** — Signed manifest describing the IBB region and hash. → 4
- **Image parser** — Code that decodes BMP/JPEG/PNG/PCX/TGA logos; LogoFAIL vulnerabilities run before OS. → 8, 9
- **Int 2e / `sysenter` / `syscall`** — x86 system-call entry mechanisms. → 5
- **IPL (Initial Program Loader)** — The ~15 sectors of bootstrap code following the NTFS VBR; Rovnix infects it. Not covered by any PBL file hash today. → 13
- **KEK (Key Exchange Key)** — UEFI variable used to sign `db`/`dbx` updates. → 1
- **Kernel DMA Protection** — Windows/UEFI feature using VT-d to protect kernel memory from DMA; PBL checks the variable. → 1, 4
- **KTRAP_FRAME** — x86 exception/系统调用帧 used by the Windows kernel. → 5
- **LTO (Link Time Optimization)** — Compiler optimization that can eliminate global symbols and `.reloc` generation. PBL disables it for GCC. → 2, 9
- **LoadedImageCount** — PBL's current weak anomaly signal for unexpected DXE images. → 6, 9
- **LOADER_PARAMETER_BLOCK** — Windows structure passing boot parameters from `winload.efi` to the kernel. → 5
- **LoJax** — 2018 UEFI rootkit; SPI flash DXE driver `SecDxe` dropping `rpcnetp.exe`. → 6
- **LogoFAIL** — UEFI image-parser vulnerabilities in boot logos; arbitrary code before the OS. → 6, 8, 9
- **MdeModulePkg / MdePkg** — Core EDK II packages containing `BasePeCoffLib`, `DxeCore`, `BdsDxe`, etc. → 2
- **MEBX** — ME BIOS extension; pre-POST, physically-present admin config channel; the engine treats all BIOS code as untrusted. → 11
- **Measured boot** — PCR extensions record boot history; a verifier compares against golden measurements. → 3, 4, 7
- **MBR / VBR bootkit (legacy chain)** — Pre-UEFI persistence via MBR code, MBR partition-table entry (Olmasco), VBR/IPL (Rovnix), or BPB `HiddenSectors` (Gapz); disk tampering persists even on UEFI systems, and PCR 5 measures the partition table. → 13
- **MLE (Measured Launched Environment)** — TXT-protected environment launched by `GETSEC[SENTER]`. → 4
- **MOK (Machine Owner Key)** — User-controlled key list used by Linux `shim`; abused by BlackLotus. → 6, 9
- **MoonBounce** — 2022 UEFI bootkit; patches `CORE_DXE` and hooks `AllocatePool`, `CreateEventEx`, `ExitBootServices`. → 6
- **MOR (Memory Overwrite Request)** — UEFI variable that requests memory wipe on boot to mitigate cold-boot attacks. → 1, 4
- **MosaicRegressor** — 2020 UEFI bootkit reusing Hacking Team `VectorEDK`; drops `IntelUpdate.exe`. → 6
- **NetworkPkg / HttpDxe / TlsDxe** — EDK II network/TLS stack packages. → 2, 9
- **NOOPT** — EDK II build target without optimization; CLANGDWARF X64 NOOPT had visibility/GOT issues. → 2, 9
- **NVRAM / UEFI variable** — Firmware non-volatile storage for Secure Boot variables, boot options, etc. → 1
- **ntoskrnl.exe** — Windows kernel; final target of some bootkit hook chains. → 5
- **Option ROM** — PCI/PCIe expansion firmware containing a PE/DXE image executed during DXE; unsigned-Option-ROM injection (Thunderstrike) bypasses image allowlists unless device-path classification distinguishes PCI-sourced images. → 13
- **OVMF (Open Virtual Machine Firmware)** — Open-source EDK II firmware for QEMU; used for PBL development. → 2, 9
- **Owner hierarchy** — TPM hierarchy rooted in the owner primary seed, used for NV and general keys. → 3
- **PCR (Platform Configuration Register)** — Extend-only SHA bank used to record boot measurements. PBL uses PCR 12 (decision) and PCR 13 (platform state). → 3
- **PE/COFF** — Microsoft Portable Executable format used by UEFI images and Windows; sections, data directories, `.reloc`. → 2, 5
- **Peacock** — UEFI runtime observability research: UEFI agent logs + OS agent + server-side attestation. → 7
- **PK (Platform Key)** — Root of trust for UEFI Secure Boot; PKfail showed the risk of leaked/test keys. → 1, 9
- **PKfail** — Binarly's name for the leaked/test AMI Platform Key supply-chain issue. → 9
- **Policy blob (C4)** — PBL signed policy describing expected platform-state and lock behavior. → 7
- **PRR (Protected Range Register)** / **PRR0..PRR4** — Intel SPI flash region lock registers. → 4
- **PTT (Platform Trust Technology)** — Intel fTPM 2.0 inside CSME/ME. → 4
- **PXE / HTTP boot** — Network boot mechanisms; device discovery and TLS pitfalls in EDK II. → 1, 2, 9
- **Quote (TPM)** — Signed set of PCR values + nonces, used for attestation. → 3, 7
- **RIM (Reference Integrity Manifest)** — Signed golden measurements used to verify event-log/PCR state. → 7
- **RISC-V / AARCH64 / X64 / IA32** — Architectures supported by EDK II; PBL currently targets X64. → 2
- **Runtime services (`EFI_RUNTIME_SERVICES`)** — Services (variable, time, capsule, etc.) available after `ExitBootServices()`. → 1
- **S3 (Suspend to RAM) resume** — Sleep/resume path that can reset protections and re-run unprotected boot scripts. → 4, 8
- **S3 boot script** — DRAM-resident opcode table replayed at end-of-PEI during resume; grants I/O port, PCI config, and arbitrary physical-memory R/W before DXE/security controls re-arm; tampered via the `AcpiGlobalVariable` table pointer. → 13
- **SbatLevel / SBAT** — UEFI RevocationSBAT variable used to revoke vulnerable Linux bootloaders. → 6, 9
- **Seal / Unseal (TPM)** — Encrypting data to a set of PCR values and policy; there is no `TPM2_Seal`, it is `TPM2_Create` + `TPM2_Unseal`. → 3
- **SEC / PEI / DXE / BDS / TSL / RT / AF** — PI boot phases. PBL is a DXE/BDS application. → 1, 2
- **Secure Boot** — UEFI signature verification using `PK`/`KEK`/`db`/`dbx`. Not sufficient alone. → 1, 2
- **Security Reference Monitor (SRM)** — Windows executive component enforcing access control. → 5
- **SetupMode** — UEFI state when no PK is enrolled; `SecureBoot=0` and any image may be loaded. → 1, 6
- **SIGMA** — Intel's SIGn-and-MAc protocol on top of EPID: anonymous platform auth + verifier X.509/OCSP auth + ECDH session keys. → 11
- **SINIT ACM** — Intel TXT ACM that verifies and launches the MLE. → 4
- **SMM (System Management Mode)** — Highly privileged x86 mode for firmware; SMM rootkits can MitM firmware acquisition. → 4, 8
- **SMRAM** — Protected memory for SMM code/data. → 4
- **SMM_BWP (SMM BIOS Write Protect)** — SPI bit requiring SMM to allow BIOS flash writes. → 4
- **SmiFlash / SecSmiFlash** — Vendor SMI handlers for BIOS update writes; `SmiFlash` flashes unauthenticated images (signed vendor drivers become a conduit), `SecSmiFlash` authenticates. PBL cannot audit handlers — server-side firmware floors are the lever. → 13
- **SoK: Security Below the OS** — arXiv 2311.03809 UEFI security survey and attack taxonomy. → 7
- **SourceBuffer (`LoadImage`)** — Passing the already-hashed buffer to `LoadImage` avoids TOCTOU between hash and load. → 2, 6
- **Speed Racer / Darth Venamis / PrinceHarming / Snorlax** — ThunderStrike 2 re-purposed Option ROM payloads. → 8
- **SPI flash** — NOR flash containing UEFI firmware; SPI-resident bootkits persist across disk replacement. → 1, 4, 6
- **SVN (Secure Version Number)** — Authenticode/UEFI version used to enforce minimum signed module versions; D-126. → 6, 8, 9
- **TE (Terse Executable)** — Compressed UEFI/PI image format for PEI; `DataDirectory[0]` holds `.reloc`. → 2
- **TCG** — Trusted Computing Group; TPM 2.0 specs. → 3
- **TCG FIM (Firmware Integrity Measurement) Specification** — Defines event log + RIM + verifier workflow. → 7
- **Tianocore / TianoCore EDK II** — The open-source UEFI reference implementation. → 2
- **TIS / CRB** — TPM command/response interfaces (TIS for I/O, CRB for command-response buffer). → 3
- **TLS security level** — OpenSSL policy rejecting weak certs/keys; EDK II level 3 broke real HTTPS boot. → 9
- **TlsCaCertificate** — UEFI variable storing trusted CA certs for HTTPS boot in `EFI_SIGNATURE_LIST` format. → 2, 9
- **TPM 2.0 command/response** — 10-byte big-endian header (`tag`, `size`, `commandCode`) plus auth/session areas. → 3
- **TPM2_Clear** — Clears owner/platform NV, but not platform-created indices with `TPMA_NV_PLATFORMCREATE`. → 3
- **TPM2_Create / TPM2_CreatePrimary** — Commands to create TPM objects; used for sealing. → 3
- **TPM2_Extend** — Updates a PCR as `newPCR = Hash(oldPCR || digest)`. → 3
- **TPM2_Load / TPM2_Unseal** — Load and unseal a TPM object with the correct auth. → 3
- **TPM2_NV_DefineSpace / Write / Read** — Manage non-volatile indices; attributes control persistence and auth. → 3
- **TPM2_PCR_Read / TPM2_Quote** — Read/quote PCRs for attestation. → 3
- **TPM_ST_NO_SESSIONS** — Command tag indicating no auth session; PBL's fallback is not spec-valid for PCR extend on real TPMs. → 3
- **TPM_RH_OWNER** — Owner hierarchy handle; PBL uses it with empty auth, so indices may not survive a real `TPM2_Clear`. → 3
- **Tracking verdict (C5)** — PBL covert tracking mode; boots Windows normally and uses decoy account/EFS. → current-state, C5
- **TXT (Trusted Execution Technology)** — Intel DRTM using SMX and SINIT ACM. → 4
- **UEFI 2.10** — Latest studied UEFI specification; defines interfaces used by PBL. → 1
- **UEFI application** — PE/COFF image with `EFI_IMAGE_SUBSYSTEM_EFI_APPLICATION`; PBL is one. → 1
- **UEFI boot manager** — Firmware or OS-specific (`bootmgfw.efi`) that uses UEFI `LoadImage`/`StartImage`. → 1, 2
- **UEFI bootkit** — Malware implant in firmware or ESP that runs before the OS loader. → 6
- **UEFI Forum** — Standards and event body; plugfests and DevCon presentations on Secure Boot. → 8
- **UEFI image parser** — Logo/graphics decoder; LogoFAIL attack surface. → 9
- **UEFI memory forensics** — Research into detecting UEFI hooks and implants from volatile memory. → 7
- **UEFI shell** — Interactive UEFI application; can be used for diagnostics but also as an attack vector (signed-shell Secure Boot bypass, `mm`/`startup.nsh`). → 2, 8, 12
- **`startup.nsh`** — Auto-executed UEFI shell script searched in the shell's launch directory then `PATH`; provisioning automation hook and attacker persistence primitive. → 12
- **`bcfg`** — UEFI shell command (Debug1/Install1 profile) that displays/adds/removes/reorders `Boot####`/`Driver####`/`BootOrder` NVRAM options; can remove or deprioritize PBL's boot entry. → 12
- **`dmpstore` / `setvar`** — UEFI shell Debug1 commands that dump, delete, save/load, and write arbitrary UEFI variables; can tamper with PBL's unauthenticated variables. → 12
- **`EFI_SHELL_PROTOCOL` / `EFI_SHELL_PARAMETERS_PROTOCOL`** — Shell service protocol (~40 members: env vars, mappings, file I/O, `Execute()`) and per-app Argv/StdIo protocol installed before `StartImage()`. → 12
- **`mm` / `dmem` / `hexedit`** — Shell Debug1 raw memory/MMIO/IO/PCI/disk access commands; the `mm` write primitive used to NULL `gSecurity2` in the Eclypsium signed-shell Secure Boot bypass. → 12
- **Double-use module** — Signed/trusted firmware module whose legitimate functionality can be misused to run untrusted code (Binarly BYOVD taxonomy); UEFI shells are the canonical example. → 12
- **Verified boot** — Cryptographic verification of firmware before execution (Intel Boot Guard). → 4
- **vTPM** — Virtualized TPM; hypervisor-backed, with migration and certificate-chain concerns. → 7
- **winload.efi** — Windows OS loader; loads `ntoskrnl.exe`, HAL, boot drivers, SYSTEM hive. → 5
- **X509_check_host()** — OpenSSL hostname verification; EDK II flags map to this API. → 9
- **XIP (eXecute In Place)** — PE/COFF image executed from ROM without relocation. → 2

## 4. Cross-cutting defensive principles for PBL

1. **Lock/allow is a layered, measured verdict, not a single boolean.** A `SecureBoot=1` bit, a hash, or a PCR is not enough; PBL combines policy, platform state, and server verdict. → 1, 3, 4, 6, 7
2. **The decision must be complete before `ExitBootServices()`.** Once `winload.efi`/`ntoskrnl.exe` runs, pre-OS assumptions can be overridden. → 1, 5
3. **Secure Boot needs expected contents, not just the `SecureBoot` variable.** `PK`/`KEK`/`db`/`dbx`/`SBAT` baselines, `SetupMode` checks, and `PKfail` awareness are required. → 1, 6, 9
4. **SPI write-protect bits are necessary but insufficient.** ESP-resident bootkits (BlackLotus) and image-parser attacks (LogoFAIL) bypass SPI-only thinking. → 4, 6, 8, 9
5. **Attestation needs known-good baselines and a protected channel.** PCRs alone are not a trust decision; a server must compare against signed RIMs and bind TLS to the attestation. → 3, 7
6. **EDK II build, linker, and network stack behavior is toolchain and firmware specific.** A binary that works in QEMU may fail on real hardware due to `.reloc`/LTO, `GOTPCRELX`, TLS certificate policy, or BDS device discovery. → 2, 9
7. **Non-bricking is a hard requirement, not a soft one.** Degraded states must allow safe recovery, not silently degrade to `ALLOW`. → 2, 4
8. **Supply-chain key management is part of the trust model.** PKfail and Intel Boot Guard key leaks show that leaked reference keys break the entire root. → 4, 9
9. **Static verification and runtime observability are complementary.** PBL can only take a snapshot; a server-side verifier with event logs and quotes is needed for continuous assurance. → 7, 8
10. **Policy must be updatable faster than the threat evolves.** New `dbx` revocations, `SBAT` levels, `bootmgr_hash` values, and C4 policy fields must be pushable without a firmware reflash. → 6, 7, 9

## 5. Open questions matrix

| Area | Open questions from the twelve study notes | Relevant PBL files |
|------|------------------------------------------|--------------------|
| UEFI/EDK2 | How can PBL detect or mitigate LogoFAIL-style image-parser exploitation before it executes? | `PblApp.c`, `LockScreen.c` |
| UEFI/EDK2 | How should PBL handle BDS not enumerating all devices on first boot? | `PblApp.c`, `ChainLoad.c` |
| UEFI/EDK2 | Does CLANGDWARF/VS2019 need a different `.reloc`/LTO workaround? | `PblPkg.dsc`, `ForceReloc.c` |
| EDK2 build | How can the build verify that `PblApp.efi` has a correct `.reloc` and is not `RELOCS_STRIPPED`? | `PblPkg.dsc`, CI scripts |
| PE/COFF | Are per-image GUID/name baselines feasible without enlarging attack surface? | `PlatformState.c`, `Decision.c` |
| Windows | How does PBL distinguish legitimate BCD/recovery changes from malicious replacement? | `Bcd.c`, `Decision.c` |
| TPM | How should PBL provision and use HMAC/salted sessions without `TPM_ST_NO_SESSIONS`? | `TpmSession.c`, `TpmClient.c` |
| TPM | How can PBL create platform-hierarchy NV indices that survive `TPM2_Clear`? | `TpmClient.c`, `Override.c` |
| TPM/attestation | How should the server verify and baseline PCR 12/13 event logs? | `TcgLog.c`, server |
| Network/TLS | How should `TlsCaCertificate` and certificate pinning be provisioned on real hardware? | `TlsVerify.c`, `HttpsClient.c` |
| Network/TLS | How should PBL handle OpenSSL security level 3 with customer PKI? | `TlsVerify.c`, `HttpsClient.c` |
| Intel platform | How should PBL respond to known OEM-specific SPI/SMM/AMT oversights? | `SpiProtections.c`, `AmtCheck.c`, `DciCheck.c` |
| Bootkits | How can PBL move from `LoadedImageCount` to code-similarity or hash baselines? | `PlatformState.c`, `Policy.c` |
| UEFI shell | Should `PlatformState.c` flag `Boot####` entries pointing at `Shell*.efi`/"UEFI Shell" (VU#718077 primitive) and `startup.nsh` presence on the ESP, and should `Decision.c` DEGRADED/BLOCK on them? | `PlatformState.c`, `Decision.c`, `Policy.c` |
| Supply chain | How should policy react to PKfail/leaked-`PK` or leaked Boot Guard keys? | `Policy.c`, `Decision.c` |

## 6. Debt item → study-note mapping

The table maps **open** PBL debt items to the study notes that explain the threat model or implementation context. It does not claim the debt is closed.

| Debt ID | Description | Relevant study notes | Why the notes matter |
|---------|-------------|----------------------|----------------------|
| D-100 | QEMU not installed locally | 2 | EDK II/OVMF smoke testing; PBL build targets |
| D-101 | swtpm not installed locally | 3 | TPM 2.0 simulation and `TpmClient` testing |
| D-102 | `TpmClient.c` uses `TPM_ST_NO_SESSIONS` | 3 | Authorization sessions; `TPM2_PCR_Extend` requires a session on real TPMs |
| D-109 | Verdict fetch and verification (C1 §7) | 1, 2, 3, 7, 9 | HTTPS/TLS, COSE_Sign1, attestation binding |
| D-110 | Policy blob parsing (C4) | 1, 2, 3, 4, 7, 9 | Platform-state fields, Secure Boot, `dbx`/SBAT, measured boot |
| D-111 | Decision engine (C4 §5) | 1, 2, 3, 4, 6, 7, 9, 12 | Combining local policy, platform state, TPM auth, and server verdict; shell/`Boot####` tampering as a decision input |
| D-112 | Lock screen UI | 1, 5 | UEFI graphics protocols, Windows boot chain |
| D-113 | Override challenge/response (C1 §6) | 3, 7 | TPM NV, PCR policy, attestation, C1 contract |
| D-114 | Chain-load Windows Boot Manager | 2, 5, 6, 9 | PE/COFF, `.reloc`, `LoadImage`, `bootmgr_hash`, BCD, BlackLotus |
| D-115 | CBOR encoding/decoding | 2, 7 | COSE_Sign1, CBOR, attestation formats |
| D-116 | TLS certificate pin verification (C3 §4) | 1, 2, 9 | `TlsCaCertificate`, one-way auth, security levels, wildcard certs |
| D-117 | No runtime tests for PBL modules | 2, 3, 9 | OVMF/QEMU, swtpm, EDK II build and TLS testing |
| D-118 | `EFI_RNG_PROTOCOL` nonce generation (C3 §5) | 1, 9 | Entropy for TLS and nonces; OVMF needs `virtio-rng-pci` |
| D-119 | ACPI FADT S3 parsing is stubbed | 1, 4, 8, 13 | S3 resume attacks and protections; boot-script table tamper mechanism |
| D-120 | BitLocker detection not implemented | 3, 5 | FVE metadata, TPM sealing, BCD alone is insufficient |
| D-121 | SPI protections check not implemented (C4 §2.3) | 4, 6, 8, 13 | `BIOSWE`/`BLE`/`SMM_BWP`/`PRR`/`FLOCKDN`, LoJax/MoonBounce, PRx-vs-FREG1 coverage validation |
| D-122 | DCI/DCP check not implemented (C4 §2.4) | 4 | Intel debug interfaces, DMA/SMI attacks |
| D-123 | DMA protection check not implemented (C4 §2.5) | 1, 4 | `KernelDmaProtection`, VT-d, ThunderStrike 2 |
| D-124 | MOR not implemented (C4 §2.6) | 1, 4, 8, 13 | Cold-boot and S3 boot-script attacks |
| D-125 | TCG event log not implemented (C4 §2.7) | 3, 7 | Event-log parsing, RIM, PCR reconstruction |
| D-126 | SVN check not implemented (C4 §2.8) | 6, 8, 9 | BlackLotus/Baton Drop, `dbx` revocations, BYOVD |
| D-127 | AMT check not implemented (C4 §2.9) | 4, 11, 13 | CSME/ME/AMT/HECI, out-of-band management, AMTactivator/CVE-2017-5689 powered-off surface |
| D-128 | SBAT variable check not implemented | 6, 9 | BootHole, Bootkitty, GRUB/shim revocation |
| D-129 | No real hardware validation for PBL | all | Every note's findings need real hardware/firmware verification; shell-mediated debug commands (`dmpstore`, `bcfg`, `map`) are the on-target inspection path |
| D-130 | Code signing not configured for `PblApp.efi` | 2, 4, 6, 9, 12 | Authenticode, Secure Boot, PKfail, Boot Guard, signing toolchain; signed-shell double-use shows signing alone is not a boundary |
| D-200–D-204 | Server/serverless verdict/policy/enroll/attest/override endpoints | 3, 7, 9 | COSE_Sign1, attestation, TLS, server key management |
| D-205 | Verdict signing infrastructure | 3, 7 | COSE_Sign1, Ed25519/ES256, TPM/attestation binding |
| D-206 | TPM-based device identity | 3, 7 | Endorsement key, attestation identity, fTPM/PTT |
| D-207–D-210 | Serverless CBOR/COSE and Worker integration | 7, 9 | COSE/CBOR, Cloudflare Worker constraints, TLS |
| D-211 | Covert tracking mode (C5) | 3, 5 | BitLocker, PCR sealing, decoy account/EFS, C5 design |
| D-212–D-219 | Chain-load/PE hardening and policy-signature fail-closed tests | 2, 5, 6, 7, 9 | `.reloc`, PE/COFF, `LoadImage`, `bootmgr_hash`, COSE verify, `dbx`, SBAT |

## 7. PBL-specific implementation notes

- **`.reloc`/LTO:** `firmware/PblPkg/PblPkg.dsc` disables LTO and `firmware/PblPkg/PblApp/ForceReloc.c` forces an absolute function-pointer table so `GenFw` emits a `.reloc` section. This is required by the HP Insyde F.39 BIOS and is the canonical EDK II pitfall. → <ref_snippet file="/home/cllin/remote-lockdown-system/firmware/PblPkg/PblPkg.dsc" lines="28-33" />
- **Chain-load TOCTOU:** `firmware/PblPkg/PblApp/ChainLoad.c` reads `bootmgfw.efi` into a buffer, hashes it, and passes that same buffer as `SourceBuffer` to `LoadImage`. This matches the BlackLotus/CosmicStrand countermeasure. → <ref_file file="/home/cllin/remote-lockdown-system/firmware/PblPkg/PblApp/ChainLoad.c" />
- **BCD parsing:** `firmware/PblPkg/PblApp/Bcd.c` extracts dangerous BCD elements (`NoIntegrityChecks`, `TestSigning`, `BootDebug`, etc.) and feeds them into the platform-state digest. → <ref_file file="/home/cllin/remote-lockdown-system/firmware/PblPkg/PblApp/Bcd.c" />
- **Decision matrix:** `firmware/PblPkg/PblApp/Decision.c` blocks or degrades on Secure Boot, Setup Mode, missing `db`/`dbx` entries, SPI protection bits, AMT/DCI/DMA, S3/MOR, network boot, BCD flags, and policy signatures. → <ref_file file="/home/cllin/remote-lockdown-system/firmware/PblPkg/PblApp/Decision.c" />
- **Platform state:** `firmware/PblPkg/PblApp/PlatformState.c` collects UEFI variables, BCD, SPI, DMA, MOR, SBAT, SVN, AMT, loaded images, and the `bootmgr_hash` into a digest for PCR 13. → <ref_file file="/home/cllin/remote-lockdown-system/firmware/PblPkg/PblApp/PlatformState.c" />
- **TPM auth:** `firmware/PblPkg/PblApp/TpmClient.c` and `TpmSession.c` use `EFI_TCG2_PROTOCOL->SubmitCommand` and currently fall back to `TPM_ST_NO_SESSIONS`; real hardware will require HMAC or policy sessions. → <ref_file file="/home/cllin/remote-lockdown-system/firmware/PblPkg/PblApp/TpmSession.c" />
- **HTTPS verdict:** `firmware/PblPkg/PblApp/HttpsClient.c` and `TlsVerify.c` must navigate the EDK II HTTPS/TLS caveats: one-way auth, `TlsCaCertificate` format, security level, wildcard matching, and RNG availability. → <ref_file file="/home/cllin/remote-lockdown-system/firmware/PblPkg/PblApp/HttpsClient.c" />

## 8. Self-test (cross-cutting)

1. **Which two study notes explain why PBL uses `ForceReloc.c` and `-fno-lto`?**
   - Answer: `STUDY-EDK2.md` (EDK II build and `GenFw`) and `STUDY-RESEARCH-BLOGS-EDK2-PITFALLS.md` (`.reloc`/LTO pitfall and LLD/GOTPCRELX). Confidence: high.

2. **Which bootkit is the direct reason for `bootmgr_hash` in `ChainLoad.c`?**
   - Answer: BlackLotus, CosmicStrand, and the general ESP-resident boot-manager replacement class; BlackLotus is the first in-the-wild Secure-Boot-bypassing UEFI bootkit. Confidence: high.

3. **Which Windows component can ignore pre-OS assumptions once it is running?**
   - Answer: `ntoskrnl.exe` (and earlier `winload.efi`). `ExitBootServices()` is the hard boundary; the decision must be complete before then. Confidence: high.

4. **What is the difference between measured boot and verified boot in the Intel context?**
   - Answer: Verified boot (Boot Guard) uses an ACM to check the IBB hash before execution; measured boot records boot components into TPM PCRs for later attestation. They can be combined. Confidence: high.

5. **Why is `LoadedImageCount` considered a weak signal compared with Binarly's bootkit hunting?**
   - Answer: A count alone does not identify which images are unexpected, cannot detect replaced-but-still-counted images, and produces false positives; Binarly uses code-similarity and behavioral rules. Confidence: high.

6. **What are the three main persistence layers for UEFI bootkits, and which PBL mitigations map to each?**
   - Answer: (a) SPI flash implants → `SpiProtections.c` + PCR measurements; (b) ESP-resident bootkits → `bootmgr_hash` + BCD parsing + `dbx`/SBAT; (c) firmware image-parser/runtime hooks → measured boot + server baselines + external firmware patching. Confidence: high.

7. **Which OpenSSL/EDK II issue can cause an otherwise valid HTTPS server certificate to be rejected during UEFI HTTPS boot?**
   - Answer: OpenSSL security level 3 (set in `TlsLib/TlsInit.c`) rejects weak keys/algorithms; EDK II defaults to level 3, which is stricter than Linux/Windows. Confidence: high.

8. **Which UEFI variable is the root of trust for Secure Boot, and what is the PKfail lesson about it?**
   - Answer: `PK` (Platform Key). PKfail showed that hundreds of devices used a leaked or test AMI PK, allowing trivial `db`/`dbx` modification and Secure Boot bypass. Confidence: high.

9. **What does the academic literature say about the relationship between TLS and remote attestation?**
   - Answer: They must be cryptographically bound to prevent relay attacks (USENIX ATC 25 "Separate but Together" and the Peacock/attestation papers). Confidence: high.

10. **Which PBL debt items are most directly informed by `STUDY-RESEARCH-BLOGS-EDK2-PITFALLS.md`?**
    - Answer: D-116 (TLS cert pin), D-118 (RNG), D-121 (SPI), D-126 (SVN), D-128 (SBAT), D-130 (code signing), D-212–D-219 (chain-load/PE/policy hardening). Confidence: high.