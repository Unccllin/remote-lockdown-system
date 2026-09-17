# Intel Platform Security Study Notes

## Source

- **Title/Path:** `/tmp/intel-docs/bootguard.txt` — Alexander Ermolov, *Safeguarding rootkits: Intel BootGuard* (2016).
  - **Source type:** Reverse-engineering conference paper / slide deck text. **Important:** this is *not* an official Intel specification; the official Intel Boot Guard details are not fully public.
  - **Page numbers in this note are the PyPDF2-extracted page/slide numbers (possibly 0-indexed in the extraction).**
- **Title/Path:** `/tmp/intel-docs/txt_mle2.txt` — Intel, *Trusted Execution Technology — Measured Launched Environment Developer’s Guide*, Document Number 315168-005, June 2008.
  - Page numbers are the extracted header/footer page numbers (e.g., ` 7 1 Overview`).
- **Title/Path:** `/tmp/intel-docs/txt_enabling.txt` — Intel, *Trusted Execution Technology (TXT) Enabling Guide*, Version 1, Document Number 330139-001US, March 2014.
  - Page numbers are the extracted footer page numbers (e.g., ` | 10`).
- **Title/Path:** `/tmp/intel-docs/txt_whitepaper.txt` — Intel, *Trusted Execution Technology: Hardware-based Technology for Enhancing Server Platform Security*, white paper (2010-2012).
  - Page numbers are the extracted sheet numbers in the text (1-8 plus endnotes).
- **Title/Path:** `/tmp/intel-docs/ptt.txt` — Intel, *Platform Trust Technology (PTT): Strengthening Security with Intel Platform Trust Technology* white paper.
  - Page numbers are taken from the extracted table of contents (Executive Summary/Disk Encryption p.1, Measured Boot p.2, Hardware Key Attestation p.3, Conclusions p.3).
- **Title/Path:** `/tmp/intel-docs/csme.txt` — Intel, *Converged Security and Management Engine (CSME) Security Technical White Paper*, Document Number 631900, Revision 1.5, October 2022 (Alder Lake).
  - Page numbers are the extracted page/section numbers (e.g., `631900   9`).
- **Title/Path:** `/home/cllin/remote-lockdown-system/docs/research/windows-firmware-lecture.md` — Local lecture notes, Lectures 14/15. **Cited only as secondary.**
- **PBL code read for mapping:**
  - `firmware/PblPkg/PblApp/PblApp.h`
  - `firmware/PblPkg/PblApp/PlatformState.c`
  - `firmware/PblPkg/PblApp/SpiProtections.c`
  - `firmware/PblPkg/PblApp/DciCheck.c`
  - `firmware/PblPkg/PblApp/DmaProtection.c`
  - `firmware/PblPkg/PblApp/Mor.c`
  - `firmware/PblPkg/PblApp/Svn.c`
  - `firmware/PblPkg/PblApp/AmtCheck.c`
  - `firmware/PblPkg/PblApp/Sbat.c`
  - `firmware/PblPkg/PblApp/Decision.c`
- **PBL docs read for mapping:**
  - `docs/adr/PBL-C4-Policy-Blob.md`
  - `docs/adr/PBL-DEBT-LEDGER.md`

## One-paragraph technical overview

Intel platform security is a layered, hardware-rooted architecture. **Intel Boot Guard** roots trust in the CPU microcode ROM and the Management Engine/CSME Field Programmable Fuses (FPFs) to enforce a measured, verified, or combined boot: the Firmware Interface Table (FIT) at `0xFFFFFFC0` leads the CPU to an Authenticated Code Module (ACM) that verifies the Boot Guard Key Manifest and Initial Boot Block Manifest (IBBM) before the BIOS Initial Boot Block (IBB) runs, and the IBB then verifies later BIOS stages. **Intel TXT** adds Safer Mode Extensions (SMX), the `GETSEC[SENTER]` dynamic root of trust, a SINIT ACM, and a Measured Launch Environment (MLE) that records hashes into TPM PCRs 17-23, protects the MLE from SMM and DMA via the DMA Protected Range (DPR) and VT-d Protected Memory Regions, and enforces a Launch Control Policy (LCP). **CSME/ME** is an isolated PCH subsystem that initializes platform silicon, hosts Active Management Technology (AMT), and implements Platform Trust Technology (PTT), a firmware TPM 2.0. These hardware roots are **not visible** to a normal UEFI application: the PBL Pre-Boot Lock application can only collect *indirect* signals such as UEFI Secure Boot variables, SPI-controller write-protect bits, the `KernelDmaProtection` variable, ACPI DMAR, ME HECI PCI presence, and the Memory Overwrite Request bit, and it cannot directly inspect fused Boot Guard policy, CSME firmware integrity, or TXT launch state.

## 10-20 key technical facts/mechanisms

1. **Intel Boot Guard roots trust in the CPU microcode ROM and the ME/CSME fuses.** The CPU ROM contains an AES key and hashes of RSA public keys used to verify microcode updates and other Intel blobs such as ACMs; the ME/CSME contains bootcode ROM, an RSA public-key hash for ME firmware, an AES key for sensitive data, and FPFs for OEM configuration. (`bootguard.txt` p.7-12; `csme.txt` p.7, p.14)

2. **Boot Guard runs in measured, verified, or combined mode.** Measured Boot extends hashes of boot components into TPM PCRs; Verified Boot cryptographically verifies the integrity of boot components; the two can be combined. Failure of verified boot can be configured to do nothing, shut down after a timeout, or shut down immediately. (`bootguard.txt` p.18-20; `csme.txt` p.9)

3. **The Boot Guard policy is stored in ME Field Programmable Fuses (FPFs).** FPFs are one-time programmable and can only be programmed/read by the ME. The `BG_PROFILE` fields include `Force_Boot_Guard_ACM`, `Measured_Boot`, `Verified_Boot`, `Key_Manifest_ID`, and a 2-bit `Enforcement_Policy` (`00` do nothing, `01` shutdown timeout, `11` immediate shutdown). (`bootguard.txt` p.21-24)

4. **The Firmware Interface Table (FIT) lives at linear flash address `0xFFFFFFC0`.** Its header is the tag `_FIT_` and it enumerates pre-RESET-vector blobs including microcode updates, BIOS ACM, TXT policy, Boot Guard Key Manifest (`BG_KEYM`), and IBBM (`BG_IBBM`). (`bootguard.txt` p.28-32)

5. **The CPU boot ROM parses FIT, verifies the BIOS ACM, and uses it to verify the boot policy.** The BIOS ACM retrieves the OEM Root RSA public-key hash and boot policies from ME/FPFs, locates the Key Manifest (KEYM) and IBBM, verifies their signatures, and verifies the Initial Boot Block (IBB) described in the IBBM before the CPU fetches from the legacy RESET vector at `0xFFFFFFF0`. (`bootguard.txt` p.28-45)

6. **The IBB is the SEC/PEI code; it then verifies the rest of the BIOS (OBB).** The IBBM `IBB_DESCRIPTORS` list the blocks forming the IBB; after ACM verification, a Boot Guard PEI module (e.g., Lenovo/Gigabyte) finds a hash table by GUID and verifies the DXE volumes before dispatching them. (`bootguard.txt` p.43-51)

7. **Intel TXT provides a Dynamic Root of Trust for Measurement (DRTM) using SMX and `GETSEC[SENTER]`.** Unlike the Static RTM that starts at platform reset, DRTM can launch a Measured Launched Environment (MLE) without a reset, creating a small TCB whose trust properties are established by a secure event. (`txt_mle2.txt` p.7-9; `txt_whitepaper.txt` p.5-6)

8. **TXT measured launch requires the MLE and a chipset-specific SINIT Authenticated Code Module.** System software loads the MLE and SINIT below 4 GB, sets up MTRRs and the TXT heap (`TXT.HEAP.BASE/SIZE`, `TXT.SINIT.BASE/SIZE`), then executes `GETSEC[SENTER]` with SINIT in EBX/ECX. SINIT authenticates itself, checks the platform, and measures the MLE. (`txt_mle2.txt` p.17-23)

9. **SINIT/TXT ACM format is an RSA-signed authenticated code module.** The module header contains `ModuleType`, `HeaderLen`, `HeaderVersion`, `ModuleVendor` (`8086h`), `Date`, `Size`, `CodeControl`, `EntryPoint`, `RsaPubKey`, `RsaPubExp`, and `RsaSig`. The signature covers the header and the user-area code; unsupported or inconsistent modules cause an Intel TXT shutdown. (`txt_mle2.txt` p.54-60)

10. **TXT extends DRTM measurements into TPM PCRs 17-23.** PCR 17 is initialized with the SINIT hash and SENTER flags, then extended with the BIOS ACM ID, STM hash, LCP `PolicyControl`, LCP policy hash, and MLE capabilities; PCR 18 is the hash of the MLE. PCRs 19-22 are available for the MLE. (`txt_mle2.txt` p.11-12; `txt_enabling.txt` p.10-11)

11. **TXT protects the MLE from SMM, DMA, and other processors.** The DMA Protected Range (DPR) is a contiguous physical-memory region just below TSEG that covers the TXT heap and SINIT memory. The MLE must also reside in the DPR or in one of the two Intel VT-d Protected Memory Regions (PMRs); otherwise SINIT refuses launch. (`txt_mle2.txt` p.13)

12. **TXT uses TPM localities 2-4 for protected access.** Locality 0 is non-trusted/legacy, locality 1 is the trusted OS, locality 2 is the trusted OS, locality 3 is the ACM, and locality 4 is TXT hardware-only; `GETSEC[SENTER]` uses localities 3 and 4 to send measurements to the TPM. (`txt_mle2.txt` p.11)

13. **Launch Control Policy (LCP) is enforced by SINIT and stored in TPM NV.** There can be a Platform Default policy and a Platform Owner policy; the owner policy wins on conflict. Policy types are `POLTYPE_ANY`, `POLTYPE_HASHONLY`, `POLTYPE_UNSIGNED`, and `POLTYPE_FORCEOWNERPOLICY`; the `SINITRevocationCounter` prevents downgrades. (`txt_mle2.txt` p.42-49)

14. **Intel PTT is a firmware/integrated TPM 2.0 inside CSME/ME.** It is TCG TPM 2.0 compliant, used by Windows for BitLocker, Secure Boot, Virtual Smart Cards, measured boot, and hardware key attestation. Unlike a discrete TPM, PTT uses a separate crypto processor in an isolated CSME hardware environment. (`ptt.txt` p.1-3; `csme.txt` p.9)

15. **CSME is an isolated PCH subsystem with its own execution environment.** It contains a dedicated x86 CPU, internal SRAM, ROM, an OCS crypto/DMA engine, an IOMMU, and the Gasket/HECI host interface. It initializes PCH silicon, authenticates and loads firmware into integrated IPs, and acts as the root of trust for Intel platform components. (`csme.txt` p.7-12, p.14)

16. **CSME has its own secure boot and anti-rollback chain.** The immutable CSME ROM generates keys from the chipset key and HVM fuses, validates the ROM Boot Extension (RBE) and CSME firmware using a public-key hash in ROM, then the RBE and micro-kernel load/verify modules and create Integrity Check Values (ICVs). Anti-rollback is enforced by recording the firmware SVN in FPFs. (`csme.txt` p.14-20, p.24-25)

17. **AMT is an out-of-band manageability feature hosted in CSME/ME.** It can provide SOL, USB-R, KVM, remote power control, CIRA, and agent-presence even when the host is off or unresponsive, making it a powerful remote-management channel and a security risk if provisioned on a stolen or unmanaged system. (`csme.txt` p.9; `windows-firmware-lecture.md` §15.6)

18. **The HAP (High Assurance Platform) bit is a mitigation that can disable ME/AMT.** It is discussed in the local lecture notes as a way to reduce ME attack surface, but it is **not described in the reviewed CSME or PTT white papers**. (`windows-firmware-lecture.md` §15.6, l.1784)

19. **PBL collects Intel platform state only through UEFI/ACPI/PCI indirect signals.** `PBL_PLATFORM_STATE` in `PblApp.h` holds `Bioswe`, `Ble`, `SmmBwp`, `PrrCoverBios`, `AmtProvisioned`, `UsbDciEnabled`, `KernelDmaProtection`, `MorRequested`, `S3Enabled`, `FirmwareRecovery`, `BootmgrSvn`, and other fields; these are populated by `PblCollectPlatformState` in `PlatformState.c`. (`PblApp.h` ll.207-295; `PlatformState.c` ll.855-944)

20. **PBL’s Intel-specific checks are implemented in dedicated modules.** `SpiProtections.c` reads the Intel SPI controller at PCI B0:D31:F5 BAR0 and the HSFS/PRR registers; `DciCheck.c` reads PCH PMC config at B0:D31:F2; `DmaProtection.c` reads the `KernelDmaProtection` UEFI variable and falls back to the ACPI DMAR table; `Mor.c` sets the `MemoryOverwriteRequestControl` bit; `AmtCheck.c` checks ME HECI PCI vendor ID at B0:D22:F0; `Svn.c` reads a custom `PblBootmgrSvn` variable; `Sbat.c` reads the Shim `Sbat` variable. (respective `.c` files; `PBL-DEBT-LEDGER.md` D-121..D-128)

21. **PBL’s decision engine maps these signals to policy thresholds per `PBL-C4-Policy-Blob.md`.** `Decision.c` steps 5-14 enforce: Secure Boot/SetupMode (BLOCK), db/dbx/SVN (BLOCK), SPI protections (BLOCK if missing, DEGRADED if unknown), AMT/DCI (DEGRADED), S3+MOR and Kernel DMA (BLOCK), network boot (BLOCK), BitLocker/BCD (BLOCK), and missing firmware recovery (DEGRADED). The matching C4 keys are 10-14, 20-21, 30-32, 40-44, 50-53, and 60. (`Decision.c` ll.140-286; `PBL-C4-Policy-Blob.md` ll.72-115)

22. **PBL cannot verify the actual hardware roots (Boot Guard, TXT, CSME).** It cannot read ME FPFs, fused Boot Guard policy, the FIT/ACM chain, the SINIT state, or CSME firmware integrity from UEFI; its checks are therefore indirect signals that assume the underlying platform and pre-boot environment are trustworthy. (`PblApp.h`/`PlatformState.c`; `PBL-DEBT-LEDGER.md` D-129, D-130)

## Glossary terms

- **S-RTM (Static Root of Trust for Measurement):** A measurement chain that starts at platform reset and extends through the boot process; used by Boot Guard and TCG-style measured boot.
- **DRTM (Dynamic Root of Trust for Measurement):** A late-launch trust root established by an instruction/event (e.g., `GETSEC[SENTER]`) that can create a small TCB without a full reboot.
- **ACM (Authenticated Code Module):** An Intel-signed module (e.g., BIOS ACM, SINIT ACM) loaded into the processor’s internal authenticated-code execution area and verified before execution.
- **FIT (Firmware Interface Table):** A table at linear flash `0xFFFFFFC0` describing early pre-RESET blobs such as microcode, ACMs, and Boot Guard manifests.
- **IBB (Initial Boot Block):** The first verified BIOS code (typically SEC/PEI modules) loaded and authenticated by Boot Guard before the legacy reset vector is executed.
- **IBBM (Initial Boot Block Manifest):** The Boot Guard manifest (`__IBBS__`/`__PMSG__`) that lists IBB descriptors and signs the IBB hash.
- **Key Manifest (KEYM):** The Boot Guard manifest (`__KEYM__`) that carries the IBBM public-key hash and the OEM root RSA key/signature.
- **FPF (Field Programmable Fuse):** One-time-programmable non-volatile storage inside the PCH/ME used for OEM keys, Boot Guard policy, and anti-rollback SVN.
- **SMX (Safer Mode Extensions):** The Intel instruction set (`GETSEC[*]`) that supports authenticated code execution and measured launch.
- **MLE (Measured Launched Environment):** The trusted environment (e.g., a hypervisor or trusted OS) launched by TXT and measured into PCR 18.
- **SINIT ACM:** The chipset-specific TXT Authenticated Code Module that prepares the platform, enforces LCP, and transfers control to the MLE.
- **LCP (Launch Control Policy):** The TXT policy, stored in TPM NV, that SINIT uses to decide whether an MLE and/or platform configuration are allowed to launch.
- **PCR (Platform Configuration Register):** A one-way-extend-only TPM hash accumulator; TXT uses PCRs 17-23 for DRTM measurements.
- **DPR (DMA Protected Range):** A contiguous physical memory region below TSEG that is protected from all DMA and covers the TXT heap and SINIT region.
- **PMR (Protected Memory Region):** One of two VT-d address ranges (low and high 4 GB) protected from DMA; the MLE must be in DPR or a PMR.
- **PTT (Platform Trust Technology):** Intel’s firmware/integrated TPM 2.0 inside CSME/ME.
- **fTPM:** A firmware-based TPM, specifically PTT in Intel systems or the PSP fTPM in AMD systems.
- **CSME (Converged Security and Management Engine):** The modern Intel PCH subsystem combining the former ME manageability engine and security engine.
- **ME (Management Engine):** The earlier Intel chipset microcontroller that preceded CSME.
- **AMT (Active Management Technology):** Out-of-band remote manageability hosted in ME/CSME.
- **HAP (High Assurance Platform) bit:** A configuration bit that can disable ME/AMT, noted only in the local lecture notes.
- **PCH (Platform Controller Hub):** The Intel chipset that hosts CSME/ME and platform I/O.
- **SPI flash:** The NOR flash chip that holds the flash descriptor, ME/CSME region, GbE, EC, and BIOS/UEFI image.
- **HECI (Host Embedded Controller Interface):** The host-to-ME/CSME communication protocol; also known as MEI.
- **SBAT (Secure Boot Advanced Targeting):** A Linux/GRUB/shim mechanism that uses a UEFI `Sbat` variable to revoke vulnerable bootloaders.
- **UMA (Unified Memory Access):** A protected DRAM region used by CSME for paging; on IMR-based CPUs it is an Isolated Memory Region (IMR).
- **IMR (Isolated Memory Region):** A memory region with hardware access controls used by CSME to protect UMA.
- **ODCA (On-Die Certificate Authority):** A CSME 15.0+ architecture where the ROM acts as an embedded CA to issue certificates for Boot Guard, AMT, PTT, etc.
- **EPID (Enhanced Privacy ID):** An anonymous group-signature scheme used by CSME/ME, replaced by ODCA on newer platforms.
- **TCB (Trusted Computing Base):** The set of components that must be trusted for a security property to hold.

## Security implications

- **Boot Guard is only effective when FPFs are properly fused and the OEM root key is not compromised.** The reverse-engineering paper describes many systems that shipped without the manufacturing fuse closed, allowing attackers to configure their own Boot Guard policy and install a persistent rootkit. (`bootguard.txt` p.52-57)
- **Verified Boot failures can be silent.** The `Enforcement_Policy` can be set to "do nothing" or a delayed timeout, so a verification failure may not be immediately visible to the user and may only be detectable through the TPM event log or PCRs. (`bootguard.txt` p.23)
- **TXT DRTM reduces the TCB but is not a substitute for a well-maintained SRTM.** Because TXT can exclude earlier firmware from the trust boundary, it can protect the MLE from a compromised BIOS; however, if SINIT is revoked or the LCP is misconfigured, `GETSEC[SENTER]` will trigger a TXT shutdown. (`txt_mle2.txt` p.42-49)
- **DMA protection is essential and fragile.** The MLE must be placed in the DPR or a VT-d PMR; if those regions are mis-sized or the MLE page tables are subverted before launch, SINIT will refuse the launch or the MLE may be vulnerable to DMA. (`txt_mle2.txt` p.13, p.25-26)
- **CSME/ME is a high-value, high-privilege target.** It has its own flash region, DRAM access, and (with AMT) out-of-band network access. Vulnerabilities such as CVE-2017-5689 and the *Silent Bob is Silent* research have demonstrated ME code execution. (`windows-firmware-lecture.md` §15.6)
- **PTT/fTPM security depends on CSME/ME integrity.** Because PTT is implemented inside CSME, a compromise of the ME firmware or the ME root key can undermine the TPM trust model that Windows BitLocker and Secure Boot rely on. (`ptt.txt` p.1-3; `csme.txt` p.14-20)
- **PBL’s indirect checks are not tamper-proof.** A UEFI bootkit or a malicious DXE driver that runs before PBL can spoof UEFI variables, modify the loaded image list, patch ACPI tables, or even intercept `gRT->GetVariable` results. Without hardware-rooted enforcement, PBL is measuring and enforcing at the same (untrusted) privilege level as the attacker. (`PBL-DEBT-LEDGER.md` D-129, D-130)

## PBL-specific relevance

- **PBL `PblCollectPlatformState` is the consumer of the Intel platform-state signals.** It calls `PblCheckSpiProtections`, `PblCheckAmt`, `PblCheckDci`, `PblCheckDmaProtection`, `PblReadBootmgrSvn`, `PblTpmGetFirmwareVersion`, `PblCollectAcpiState`, `PblCollectMorState`, `PblCollectBcdState`, and the loaded-image enumeration, storing the results in `PBL_PLATFORM_STATE`. (`PlatformState.c` ll.855-944)

- **The `PBL_PLATFORM_STATE` structure explicitly assumes an Intel (or at least x86/UEFI) platform.** It has fields for `SpiProtectionsKnown`, `Bioswe`, `Ble`, `SmmBwp`, `PrrCoverBios`, `AmtProvisioned`, `UsbDciEnabled`, `KernelDmaProtection`, `MorRequested`, `S3Enabled`, `FirmwareRecovery`, and `BootmgrSvn`, but no fields for the actual Boot Guard policy, TXT status, or CSME firmware version. (`PblApp.h` ll.207-295)

- **`SpiProtections.c` is the only hardware-rooted check PBL performs directly on the PCH.** It uses PCI config I/O `0xCF8/0xCFC` to locate the SPI controller at B0:D31:F5, reads `HSFS` (offset `0x04`) for `BIOSWE` (bit 0), `BLE` (bit 1), `SMM_BWP` (bit 5), and the Protected Range Register (offset `0x74`) for write-enable and protected-range bits. On non-Intel or inaccessible controllers it sets `SpiProtectionsKnown = FALSE`. (`SpiProtections.c` ll.27-84; `PBL-DEBT-LEDGER.md` D-121)

- **`DciCheck.c`, `DmaProtection.c`, and `Mor.c` are pre-boot mitigations for DMA/cold-boot attacks.** DCI is checked by reading PCH PMC config space; DMA is checked by the `KernelDmaProtection` UEFI variable or ACPI DMAR presence; MOR is set by writing the `MemoryOverwriteRequestControl` variable. These map to `Decision.c` step 11 and C4 keys 50-52. (`DciCheck.c`, `DmaProtection.c`, `Mor.c`; `PBL-C4-Policy-Blob.md` ll.100-103; `PBL-DEBT-LEDGER.md` D-122..D-124)

- **`AmtCheck.c` and `Svn.c` are conservative and incomplete.** AMT is assumed provisioned if the HECI device is present because PBL has no HECI protocol driver to query the provisioning state; SVN is read from a custom `PblBootmgrSvn` variable rather than parsed from `bootmgfw.efi` Authenticode. (`AmtCheck.c` ll.27-65; `Svn.c` ll.23-56; `PBL-DEBT-LEDGER.md` D-126, D-127)

- **`Decision.c` implements C4 §5 steps 3-14 and 16.** Step 7 (SPI) blocks if `Bioswe`/`Ble`/`SmmBwp` are not all true, but degrades if `SpiProtectionsKnown` is false. Step 8 (firmware version/AMT/DCI) degrades. Step 11 (S3 + DMA + MOR) blocks if S3 is enabled without MOR, or if `KernelDmaProtection` is false. Step 14 (firmware recovery) degrades if `FirmwareRecovery == 2` (`none`). (`Decision.c` ll.140-286; `PBL-C4-Policy-Blob.md` ll.268-282)

- **`PBL-C4-Policy-Blob.md` carries the per-device thresholds for the Intel checks.** Key 20 `spi_protection_required`, 30 `firmware_floors`, 31 `amt_allowlist`, 32 `usb_dci_policy`, 41 `tpm_firmware_floors` (includes Intel PTT), 51 `kernel_dma_protection_required`, 52 `mor_required`, and 60 `firmware_recovery_expectation` are the policy levers that govern `Decision.c`. (`PBL-C4-Policy-Blob.md` ll.72-115)

- **PBL cannot replace Intel hardware-rooted protections.** It cannot inspect the Boot Guard FIT/ACM/FPF chain, cannot call `GETSEC[CAPABILITIES]` to detect TXT, cannot open the ME HECI to read the actual CSME state, and cannot parse the DMA Protected Range or VT-d PMR settings. Therefore the project’s policy design treats PBL’s checks as *indicators* to be combined with the server verdict and the TPM PCR log, not as a self-sufficient root of trust. (`PBL-DEBT-LEDGER.md` D-129)

- **The open debt items D-121 through D-130 are the direct follow-ups for this study.** D-121..D-128 each track a specific Intel platform-state check that is implemented but needs real-hardware validation; D-129 is the lack of any real hardware validation; D-130 is the absence of code signing, which is a prerequisite for the Secure Boot chain PBL assumes. (`PBL-DEBT-LEDGER.md` ll.488-607)

## Known implementation pitfalls

1. **Boot Guard cannot be verified from a UEFI application.** PBL can read `SecureBoot`/`PK`/`db`/`dbx`, but it cannot read the Boot Guard FPFs or FIT. A system may have Secure Boot on but Boot Guard off, allowing a persistent attacker to reflash modified firmware that still passes UEFI Secure Boot. (`bootguard.txt` p.52-57)

2. **PBL’s SPI check is Intel-specific and hard-coded.** It only probes PCI B0:D31:F5 and the legacy HSFS bit definitions; it will silently return `SpiProtectionsKnown = FALSE` on newer SoCs with a different SPI controller layout, AMD systems, or ARM UEFI. (`SpiProtections.c` ll.54-63; `PBL-DEBT-LEDGER.md` D-121)

3. **The DCI enable bit may not be in the PMC config space.** The current `DciCheck.c` reads B0:D31:F2 offset `0x40`, but the real DCI enable may be in the flash descriptor or a PCH fuse. A false negative is possible. (`DciCheck.c` ll.46-54; `PBL-DEBT-LEDGER.md` D-122)

4. **DMA protection cannot be confirmed by an ACPI table alone.** `DmaProtection.c` falls back to the presence of a DMAR table, but a DMAR table only means the platform *can* enable VT-d; it does not prove remapping is active at boot. (`DmaProtection.c` ll.55-69; `PBL-DEBT-LEDGER.md` D-123)

5. **AMT provisioning is over-estimated by `AmtCheck.c`.** Because it only checks for the HECI device, it conservatively reports `Provisioned = TRUE` whenever ME is present, leading to false-positive DEGRADED results. Real provisioning requires a HECI command exchange. (`AmtCheck.c` ll.59-63; `PBL-DEBT-LEDGER.md` D-127)

6. **MOR lock is not set by `Mor.c`.** PBL sets the MOR clear bit but does not set the MOR lock bit, so a compromised OS could clear the MOR bit before the next S3 resume. (`Mor.c` ll.62-72; `PBL-DEBT-LEDGER.md` D-124)

7. **PBL cannot distinguish PTT from a discrete TPM.** `PblTpmGetFirmwareVersion` reads a TPM2 `GetCapability` firmware version, but the manufacturer/vendor string is not parsed, so the `tpm_firmware_floors` policy cannot specifically target Intel PTT. (`PblApp.h` ll.160-161, 237; `PBL-C4-Policy-Blob.md` ll.91-95)

8. **PBL itself runs in the same untrusted DXE/BDS environment as a potential bootkit.** A malicious DXE driver that loads before PBL can hook `gRT->GetVariable`, `gBS->LocateProtocol`, or the `EFI_TCG2_PROTOCOL` and lie to PBL. This is why the project relies on Secure Boot, measured boot, and (ideally) Boot Guard, but PBL does not currently verify those roots. (`STUDY-EDK2.md`; `PBL-DEBT-LEDGER.md` D-130)

## Cross-references to previously studied sources

- **`docs/research/STUDY-UEFI-SPEC-2.10.md`:** Explains the UEFI variables, image loading, and Secure Boot mechanisms PBL uses to read `SecureBoot`, `SetupMode`, `DeployedMode`, `PK`, `db`, `dbx`, `KernelDmaProtection`, `MemoryOverwriteRequestControl`, `BootOrder`, and `Boot####`. This is the interface layer below PBL.
- **`docs/research/STUDY-EDK2.md`:** Describes the EDK II build environment, `BdsDxe`, `LoadImage`/`StartImage`, `EFI_SECURITY2_ARCH_PROTOCOL`, `DxeImageVerificationLib`, and the OVMF target used to run PBL in QEMU. This is where PBL’s UEFI application context comes from.
- **`docs/research/STUDY-TPM-2.0.md`:** Covers TPM 2.0 PCRs, HMAC sessions, NV indices, `TPM2_Quote`, and `EFI_TCG2_PROTOCOL`. PBL’s PTT/fTPM usage depends on this, and the `tpm_firmware_floors` policy in `PBL-C4-Policy-Blob.md` directly references Intel PTT as a TPM implementation.
- **`firmware/PblPkg/PblApp`:** The PBL UEFI application files read for this note are the ones that consume the platform-state data described above. `Decision.c` is the bridge between the raw platform state, the policy blob, and the server verdict.
- **`docs/adr/PBL-C4-Policy-Blob.md`:** Defines the CBOR policy fields (keys 20-21, 30-32, 40-44, 50-53, 60) that encode the Intel platform-state checks in a signed, anti-rollback policy.
- **`docs/adr/PBL-DEBT-LEDGER.md`:** Tracks the unresolved PBL work items D-121..D-130, most of which are direct fall-out from the gaps between the hardware-rooted Intel technologies and what a UEFI application can actually inspect.

## Outstanding questions

1. **Can PBL read the actual Boot Guard state from ME/CSME at runtime?** There may be a HECI/MHKI command to read the Boot Guard policy from the FPFs, but this is not in the sources and would require a stable pre-boot ME interface.

2. **How does PBL distinguish PTT from a discrete TPM?** `EFI_TCG2_PROTOCOL` exposes a firmware version and a manufacturer string, but PBL currently does not parse the vendor string, so the `tpm_firmware_floors` policy cannot specifically target Intel PTT versus a third-party dTPM.

3. **Which PCH/SKU variants does `SpiProtections.c` cover?** The HSFS register layout at B0:D31:F5 is generation-specific; newer Intel SoCs and Atom platforms may use different functions. The `spi_oem_matrix` in `PBL-C4-Policy-Blob.md` is intended to handle this, but no entries are validated.

4. **What is the correct, generation-independent DCI detection method?** The current implementation guesses at a PMC register; the real DCI enable may be in the flash descriptor or a debug/fuse policy that PBL cannot read through PCI config.

5. **Is there a documented HECI command to query AMT provisioning and PTT firmware version in pre-boot?** Adding a HECI driver to PBL would close the AMT and fTPM gaps, but HECI commands are not public and vary by CSME generation.

6. **Should PBL verify the SINIT/LCP/TXT state?** `GETSEC[CAPABILITIES]` and the TXT public configuration space (`FED30000`) could be queried from a UEFI application, but no support for this is in the current PBL code or in `PBL-C4-Policy-Blob.md`.

7. **How does the project close D-130 (code signing) before the Intel platform checks can be trusted?** PBL is an unsigned UEFI application; an attacker can replace it on any system that does not enforce Secure Boot, undermining the entire chain before the platform-state checks even run.

## Self-test (Intel platform security)

| # | Question | Answer | Confidence |
|---|----------|--------|------------|
| 1 | What are the three operating modes of Intel Boot Guard? | Measured Boot, Verified Boot, and combined (Measured + Verified) Boot. | High |
| 2 | Where in flash is the Firmware Interface Table (FIT) located? | At linear address `0xFFFFFFC0`. | High |
| 3 | What does the Boot Guard `Enforcement_Policy` field encode? | `00b` = do nothing on verification failure, `01b` = shutdown after a timeout, `11b` = immediate shutdown. (`10b` reserved.) | High |
| 4 | What SMX instruction starts an Intel TXT measured launch? | `GETSEC[SENTER]`. | High |
| 5 | Which TPM PCRs are reserved for the TXT DRTM? | PCRs 17-23. | High |
| 6 | What is the difference between DPR and PMR? | DPR is a single DMA-protected memory range below TSEG covering the TXT heap and SINIT; PMRs are two VT-d protected memory ranges (low/high 4 GB) that can also contain the MLE. | High |
| 7 | What is an LCP and where is it stored? | Launch Control Policy; enforced by SINIT and stored in the TPM’s non-volatile storage. | High |
| 8 | What is Intel PTT and how does it relate to CSME/ME? | PTT is an integrated/firmware TPM 2.0 implemented inside the CSME/ME isolated subsystem. | High |
| 9 | Why is `AmtCheck.c` conservative and what does it actually check? | It checks for the Intel HECI PCI device at B0:D22:F0; if the vendor ID is Intel it sets `Provisioned = TRUE` because PBL has no HECI protocol to query real provisioning. | High |
| 10 | Why can PBL not directly verify Intel Boot Guard, TXT, or CSME integrity? | A UEFI application cannot read ME FPFs/fuses, cannot inspect the FIT/ACM chain, cannot execute `GETSEC` to verify TXT, and cannot read CSME firmware integrity; it can only read UEFI variables, PCI config, and ACPI tables. | High |

**Uncertain / follow-up areas to revisit**

- Whether PBL can use a stable HECI command in pre-boot to read the real AMT provisioning state and the Boot Guard/CSME configuration (this could close D-127 and parts of D-122).
- Which PCH/SKU variants need a different SPI controller/HSFS layout, and whether `PBL-C4-Policy-Blob.md` key 21 `spi_oem_matrix` should be populated for them.
- Whether `GETSEC[CAPABILITIES]` and the TXT public configuration space can be probed by PBL to detect and partially validate TXT availability on the target platform.
