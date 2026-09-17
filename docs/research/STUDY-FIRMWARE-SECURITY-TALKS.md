# Conference Talks on Firmware Security — Defensive Study Notes

> **Scope:** Defensive synthesis of conference presentations and workshops on UEFI/firmware security from Black Hat, REcon, CanSecWest, DEF CON, OffensiveCon, and the UEFI Forum. The note extracts defensive engineering lessons and does not reproduce or improve any rootkit/bootkit code.

## Source

- **"UEFI Firmware Rootkits: Myths and Reality"** — Alex Matrosov, Black Hat Asia 2017. Slides: `https://blackhat.com/docs/asia-17/materials/asia-17-Matrosov-The-UEFI-Firmware-Rootkits-Myths-And-Reality.pdf`.
- **"Betraying the BIOS: Going Deeper into BIOS Guard Implementations"** — Alex Matrosov, OffensiveCon 2018. Abstract: `https://sec.today/events/talk/ec90e67f-3d82-4c2a-99cc-f1c4f9bc8c82/`.
- **"Exposing Bootkits with BIOS Emulation"** — Lars Haukli, Black Hat USA 2014. Slides: `https://blackhat.com/docs/us-14/materials/us-14-Haukli-Exposing-Bootkits-With-BIOS-Emulation.pdf`.
- **"Fractured Backbone: Breaking Modern OS Defenses with Firmware Attacks"** — Yuriy Bulygin, Black Hat USA 2017. Slides: `https://blackhat.com/docs/us-17/wednesday/us-17-Bulygin-Fractured-Backbone-Breaking-Modern-OS-Defenses-With-Firmware-Attacks.pdf`.
- **"A Tale of One Software Bypass of Windows 8 Secure Boot"** — Yuriy Bulygin, Andrew Furtak, Oleksandr Bazhaniuk, Black Hat USA 2013. Slides: `https://media.blackhat.com/us-13/us-13-Bulygin-A-Tale-of-One-Software-Bypass-of-Windows-8-Secure-Boot-Slides.pdf`.
- **"ThunderStrike 2: Sith Strike"** — Trammell Hudson, Xeno Kovah, Corey Kallenberg, DEF CON 23 / Black Hat USA 2015. Annotated transcript: `https://trmm.net/Thunderstrike2_details/`; con page: `https://infocondb.org/con/def-con/def-con-23/thunderstrike-2-sith-strike`.
- **"GOP Complex: Image parsing bugs, EBC polymorphic engines and the Deus ex machina of UEFI exploit dev"** — Nika Korchok Wakulich (ic3qu33n), REcon 2024. Abstract: `https://recon.cx/cfp.recon.cx/recon2024/talk/XBSEXN/index.html`.
- **"Detect Me If You Can - Anti-Firmware Forensics"** — Takahiro Haruyama, REcon 2022. Abstract: `https://infocondb.org/con/recon/recon-2022/detect-me-if-you-can-anti-firmware-forensics`.
- **"All Your Boot Are Belong To Us"** — Xeno Kovah / John Butterworth / Corey Kallenberg / Intel + MITRE, CanSecWest 2014. Slides: `https://papers.put.as/papers/firmware/2014/AllYourBoot_csw14-mitre-final.pdf`.
- **"Platform Firmware Security Assessment with CHIPSEC" / "Exploring Your System Deeper [with CHIPSEC] is Not Naughty"** — CanSecWest 2014/2017. Slides: `http://www.c7zero.info/stuff/Platform%20Firmware%20Security%20Assessment%20wCHIPSEC-csw14-final.pdf`; `https://papers.put.as/papers/firmware/2017/csw2017_ExploringYourSystemDeeper_updated.pdf`.
- **"UEFI Firmware Security Concerns and Best Practices"** — Jim Mortensen & Dick Wilkins, Phoenix Technologies, UEFI Forum plugfest (2014/2015/2017 update). PDF: `https://uefi.org/sites/default/files/resources/UEFI%20Firmware%20-%20Security%20Concerns%20and%20Best%20Practices.pdf`.
- **"Best Practices for Secure Firmware Patching"** — Alex Bazhaniuk (Eclypsium) & Tim Lewis (Insyde), UEFI 2020 Virtual Plugfest. PDF: `https://uefi.org/sites/default/files/resources/UEFI_Plugfest_Best%20Practices%20for%20Secure%20Firmware%20Patching_8.18.2020.pdf`.
- **"Signed and Dangerous: BYOVD Attacks on Secure Boot"** — Alex Matrosov & Fabio Pagani, UEFI 2025 Developers Conference & Plugfest. PDF: `https://uefi.org/sites/default/files/resources/4.%20Signed%20and%20Dangerous_Binarly_Matrosov%20and%20Pagani_FINAL.pdf`.
- **"Repeatable Supply Chain Security Failures in Firmware Key Management"** — Alex Matrosov & Fabio Pagani, UEFI 2025 Developers Conference & Plugfest. Slides: `https://pagabuc.me/slides/Failures_UEFIDevCon2025.slides.pdf`.
- **PBL source mapped:**
  - `firmware/PblPkg/PblApp/PblApp.c`
  - `firmware/PblPkg/PblApp/PblApp.h`
  - `firmware/PblPkg/PblApp/PlatformState.c`
  - `firmware/PblPkg/PblApp/Decision.c`
  - `firmware/PblPkg/PblApp/ChainLoad.c`
  - `firmware/PblPkg/PblApp/SpiProtections.c`
  - `firmware/PblPkg/PblApp/DmaProtection.c`
  - `firmware/PblPkg/PblApp/Mor.c`
  - `firmware/PblPkg/PblApp/Sbat.c`
  - `docs/adr/PBL-C4-Policy-Blob.md`
  - `docs/adr/PBL-DEBT-LEDGER.md`

**Source gap:** Some conference slide decks are PDFs that were not text-extracted locally; the note uses web-search-extracted slide text and public con-page abstracts. The Binarly 2025 UEFI DevCon PDFs were summarized from search-extracted snippets.

## One-paragraph technical overview

Conference presentations from Black Hat, REcon, CanSecWest, DEF CON, and the UEFI Forum document over a decade of UEFI/firmware offensive research and the corresponding defensive countermeasures. The talks show that UEFI rootkits are not theoretical: they are deployed in the wild via SMM exploits, SPI flash modifications, S3 resume script injection, unsigned Option ROMs, and signed-but-vulnerable bootloaders. A recurring theme is that hardware protections such as BIOS_CNTL, BLE, SMM_BWP, and PRR are frequently left unset or are bypassed, that Secure Boot can be defeated without setting it to "Disabled," and that the gap between Intel EDK2 reference-code fixes and vendor firmware updates can be years. Defensive frameworks such as CHIPSEC provide open-source checks for many of these weaknesses, while the research also warns that OS-level firmware scanners can be MitM'd by SMM rootkits and that firmware supply-chain key-management failures (PKfail, leaked PPAM certs, inconsistent `dbx`) are now a major attack path. For PBL, the practical takeaway is that a pre-OS lock application must combine many indirect platform-state signals, maintain per-platform baselines, keep its policy/verdict channel updatable, and never treat "Secure Boot enabled" as a complete trust verdict.

## 10-20 key technical facts/mechanisms

1. **Matrosov's Black Hat Asia 2017 talk modeled UEFI rootkit infection as a four-stage chain:** user-mode dropper → kernel-mode payload (bypassing code signing) → SMM exploit → SPI flash write, with real-world examples from HackingTeam and Computrace/LoJack.
2. **The same talk covered SMM-handler, S3BootScript, ThinkPwn, and Aptiocalypsis vulnerabilities** as the recent practical paths to persistent UEFI infection, concluding that SMI handlers and S3 resume are a recurring rootkit enabler.
3. **Matrosov's OffensiveCon 2018 "Betraying the BIOS" argued that many vendors leave SMM and SPI flash memory wide open to rootkits;** even when Boot Guard / BIOS Guard / the Authenticated Code Module exist, implementation and reverse-engineering findings show weaknesses.
4. **Haukli's Black Hat USA 2014 "Exposing Bootkits with BIOS Emulation" demonstrated emulating the boot code and BIOS to observe bootkit behavior;** it also discussed detecting function-pointer and inline hooks in the boot chain and using heuristics on boot-sector behavior.
5. **Bulygin's Black Hat USA 2017 "Fractured Backbone" analyzed Vault 7 Mac EFI implants (DerStarke, DarkMatter, DarkSeaSkies, Sonic Screwdriver)** and showed how S3 sleep exploitation and Option ROM attacks can re-infect firmware even when flash is "locked." (`blackhat.com/us-17`)
6. **"Fractured Backbone" also described building an industry-scale whitelist of known EFI executables:** ~14,000 firmware images across 9 platform manufacturers yielded over 2 million PEI/DXE hashes for a `efi-whitelist` GitHub project and a CHIPSEC module. (`blackhat.com/us-17`)
7. **Bulygin, Furtak, and Bazhaniuk's Black Hat 2013 "A Tale of One Software Bypass" demonstrated two attacks that bypassed Windows 8 Secure Boot on an Asus VivoBook Q200E,** one kernel-mode and one user-mode, caused by UEFI implementation oversights rather than Secure Boot design flaws. (`media.blackhat.com/us-13`)
8. **The ThunderStrike 2 team (Hudson, Kovah, Kallenberg) presented the first Mac firmware worm at DEF CON 23 / Black Hat 2015;** it spreads via software or Thunderbolt accessories and writes to the MacBook boot flash. (`trmm.net/Thunderstrike2_details/`; `infocondb.org/def-con-23`)
9. **ThunderStrike 2 reused four previously disclosed vulnerabilities on Macs: Speed Racer (BIOS_CNTL race), Darth Venamis (S3 resume script injection), PrinceHarming/Snorlax (PRR not set after S3), and unsigned Thunderbolt Option ROMs;** the key finding is that EFI/UEFI vulnerabilities are portable across OS and hardware because of a shared EDK2/EFI 1.10 codebase and slow vendor patching. (`trmm.net/Thunderstrike2_details/`, §Background and §Vulnerabilities)
10. **The ThunderStrike 2 annotated transcript explains that the PCH/ME initially leaves SPI flash unlocked, and that early PEI locking of `FLOCKDN`/PRR is critical;** Apple did lock early, but many other design gaps remained. (`trmm.net/Thunderstrike2_details/`, §Background)
11. **Korchok Wakulich's REcon 2024 "GOP Complex" combined LogoFAIL image-parser vulnerabilities, the EBC (EFI Byte Code) virtual machine, and PCI Option ROM hacking** to develop cross-architecture UEFI shellcode and demonstrate that UEFI exploit development is increasingly platform-agnostic. (`recon.cx/cfp.recon.cx/recon2024/talk/XBSEXN`)
12. **Haruyama's REcon 2022 "Detect Me If You Can" showed that software-based firmware acquisition on Intel platforms can be MitM'd by SMM rootkits;** the PoC hid known bootkit components from both open and closed-source UEFI firmware scanners. (`infocondb.org/recon-2022`)
13. **CanSecWest 2014 "All Your Boot Are Belong To Us" traced the history of UEFI bootkits, demonstrated attacking a securely booted OS from userland, and introduced the CHIPSEC framework for platform firmware security assessment.** (`papers.put.as/papers/firmware/2014/AllYourBoot_csw14-mitre-final.pdf`)
14. **CanSecWest 2017 "Exploring Your System Deeper [with CHIPSEC]" focused on S3 resume boot-script vulnerabilities, SMM vulnerabilities, MMIO BAR issues, and Vault7 DerStarke/DarkMatter;** it showed how to use CHIPSEC modules such as `common.uefi.s3bootscript`, `common.smrr`, and `common.spi_lock`. (`papers.put.as/papers/firmware/2017/csw2017_ExploringYourSystemDeeper_updated.pdf`)
15. **The UEFI Forum plugfest "UEFI Firmware Security Concerns and Best Practices" (2018) summarized common threat classes:** maliciously crafted input (buffer overflow), SMM code injection, data tampering of UEFI variables (SecureBoot, etc.), unauthorized SMRAM disclosure, DoS via flash corruption, and key-management failures. (`uefi.org/sites/default/files/resources/UEFI%20Firmware%20-%20Security%20Concerns%20and%20Best%20Practices.pdf`)
16. **The UEFI 2020 Virtual Plugfest "Best Practices for Secure Firmware Patching" distinguished two attack models:** *firmware-as-vehicle* (modifies existing firmware to create a vulnerability) and *firmware-as-agent* (uses existing firmware weaknesses);** it recommended ESRT, TPM/TCM known-execution-pattern checks, and enterprise-wide firmware inventory/monitoring. (`uefi.org/sites/default/files/resources/UEFI_Plugfest_Best%20Practices%20for%20Secure%20Firmware%20Patching_8.18.2020.pdf`)
17. **The UEFI 2025 "Signed and Dangerous" talk defined a five-class taxonomy of Secure Boot bypass techniques:** double-use modules, trusted-but-vulnerable modules, leaked private keys, verification-logic bugs, and debug/incomplete features;** it reported 7,157 unique UEFI modules trusted by recent OEM firmware images. (`uefi.org` UEFI DevCon 2025)
18. **The UEFI 2025 "Repeatable Supply Chain Security Failures in Firmware Key Management" talk catalogued real-world key-management failures:** expired PPAM certificates, leaked platform keys (PKfail), inconsistent `dbx`, microcode vulnerabilities, and post-quantum unpreparedness. (`pagabuc.me/slides/Failures_UEFIDevCon2025.slides.pdf`)
19. **CHIPSEC is an open-source platform security assessment framework** with modules for SMRAM locking, S3 boot script, BIOS/SPI write protection, secure-boot key/variable access control, and generation of firmware-volume fingerprints; it runs on Windows, Linux, macOS, and UEFI Shell. (`c7zero.info/stuff/Platform%20Firmware%20Security%20Assessment%20wCHIPSEC-csw14-final.pdf`; `papers.put.as/papers/firmware/2017/csw2017_ExploringYourSystemDeeper_updated.pdf`)
20. **Across all talks, a common defensive thread is that "Secure Boot enabled" is not equivalent to "pre-OS chain trusted" because the implementation may not enforce the policy, variables may be writable, or vulnerable signed components may remain in `db`.**

## Glossary terms

- **S3 resume / S3 boot script:** The firmware state restoration code executed when a system wakes from sleep (S3); vulnerabilities in this script allow attacker code to run with relaxed flash/SMM protections.
- **Option ROM:** Code embedded in a PCIe/Thunderbolt device or adapter that runs during UEFI boot, often with high privilege and sometimes without signature verification.
- **BIOS_CNTL / BLE / SMM_BWP / PRR:** Intel SPI controller and chipset protection bits that regulate write access to the firmware flash and the SMM-only write-back policy; missing or misconfigured bits enable flash rewrites.
- **SMM (System Management Mode):** A high-privilege x86 CPU mode used by firmware; an SMM rootkit can intercept OS and firmware operations, including firmware acquisition.
- **SMI handler:** The firmware entry point invoked by a System Management Interrupt; memory-corruption bugs in SMI handlers are a recurring path to SMM code execution.
- **EFI Byte Code (EBC):** A UEFI virtual-machine instruction set for architecture-independent UEFI drivers; can be used to write cross-architecture shellcode and exploits.
- **GOP (Graphics Output Protocol):** UEFI protocol for graphics; GOP Complex demonstrated image-parser bugs in GOP/LogoFAIL as an exploit path.
- **BIOS Guard / Boot Guard / ACM (Authenticated Code Module):** Intel technologies intended to verify and protect firmware; their configuration and implementation gaps are a recurring research target.
- **PKfail:** A 2024 disclosure that many systems shipped with the same default or leaked Platform Key, undermining Secure Boot trust.
- **PPAM (Platform Provider Attestation Manifest):** A firmware attestation structure; expired or mismanaged certificates can break attestation and boot security.
- **ESRT (EFI System Resource Table):** A UEFI table that reports firmware component versions and update status, used for firmware inventory and update orchestration.
- **CHIPSEC:** Open-source framework for analyzing PC platform firmware and hardware security, including many of the checks relevant to PBL's `SpiProtections.c`.
- **firmware-as-vehicle vs. firmware-as-agent:** Two attack delivery models: creating a vulnerability by modifying firmware vs. exploiting an existing firmware weakness.
- **BYOVD (Bring Your Own Vulnerable Driver) — UEFI version:** Using a legitimately signed but vulnerable UEFI module or driver to bypass Secure Boot.

## Security implications

- **Firmware rootkits are practical and have been demonstrated at major conferences for over a decade.** The attacks are not academic-only; real-world incidents and in-the-wild samples back them.
- **S3 resume and Option ROMs are persistent, practical attack surfaces.** Sleep/resume and removable-device firmware run with high privilege and are often less scrutinized than the main boot path.
- **Secure Boot implementation gaps are at least as dangerous as Secure Boot design flaws.** Writeable authenticated variables, missing `dbx` revocations, and trusted-but-vulnerable binaries repeatedly allow bypass without disabling Secure Boot.
- **SMM compromise breaks the trust of all higher-level acquisition and detection tools.** If SMM is rootkitted, an OS-based firmware scanner can receive a forged image.
- **Supply-chain key management is now a primary failure mode.** Leaked Platform Keys, inconsistent `dbx`, expired PPAM certs, and shared default keys can invalidate the entire Secure Boot trust model.
- **Whitelist/fingerprint approaches are powerful but not operationally trivial.** Building a corpus of millions of known-good EFI hashes across thousands of firmware images requires scale and maintenance.
- **The lag between EDK2 reference fixes and OEM deployment creates a long exploit window.** A vulnerability patched in EDK2 can remain exploitable in end-user systems for years.

## PBL-specific relevance

- **PBL's `SpiProtections.c` checks exactly the controller bits these talks flag as often wrong or bypassed:** `Bioswe`, `Ble`, `SmmBwp`, and `PrrCoverBios`. The conference literature shows that checking the bits is necessary but not sufficient; an SMM rootkit or misconfigured register can still leave the system exposed. (`SpiProtections.c` ll. 27–85; `Decision.c` ll. 179–191)
- **PBL's `Decision.c` S3/MOR/DMA checks (REQ-07) address the S3 resume and DMA attack vectors repeatedly demonstrated at CanSecWest and Black Hat.** If `S3Enabled` and `!MorRequested`, PBL blocks; this is the defensive counterpart to S3 resume-script exploits. (`Decision.c` ll. 244–255)
- **PBL's Secure Boot / `SetupMode` / db/dbx checks (REQ-01/02) implement the lessons from "A Tale of One Software Bypass" and "All Your Boot Are Belong To Us":** the platform must be in user mode, the PK enrolled, and the expected db/dbx contents present. (`Decision.c` ll. 154–177)
- **PBL's `bootmgr_hash` and BCD parsing (REQ-09) are the direct countermeasure to the userland→bootloader attacks shown in the CanSecWest and Black Hat talks:** if the boot manager or BCD is modified, PBL refuses to chain-load. (`ChainLoad.c` ll. 217–278; `PblApp.h` ll. 247–273)
- **PBL's `LoadedImageCount` (D-213) is a very weak version of the whitelist/fingerprint idea behind CHIPSEC and the "Fractured Backbone" efi-whitelist project;** a count alone cannot distinguish legitimate option ROMs or DXE drivers from implants. (`PlatformState.c` ll. 910–939)
- **PBL's `DmaProtection.c` and `KernelDmaProtection` check are the defensive response to DMA attacks that can be launched from compromised SMM or from external Thunderbolt/PCIe devices;** the talks show that DMA protection must be enabled and verified. (`DmaProtection.c`; `Decision.c` ll. 252–255)
- **PBL's `Sbat.c` and SBAT policy (REQ-02) are relevant to the GRUB/BootHole and BYOVD attack paths,** but the conference talks also show that `dbx` inconsistency and MOK abuse are harder to detect from a UEFI application. (`Sbat.c`; `Decision.c` ll. 169–177)
- **The PKfail and leaked-key disclosures mean PBL cannot rely solely on "Secure Boot enabled" or a Microsoft signature;** it must also verify that the `PK`/`KEK`/`db`/`dbx` contents match an expected baseline in policy. (`Decision.c` ll. 154–177; `PBL-C4-Policy-Blob.md` §2.2)
- **PBL's verdict/policy fetch channel is the right place to push new mitigations (new `dbx` entries, SBAT levels, `bootmgr_hash` updates) when new BYOVD/option-ROM/SMM attacks are disclosed,** because the lag between EDK2 fixes and OEM deployment can be years. (`PBL-C3-Network-Client.md`; `PBL-C4-Policy-Blob.md` §7)
- **PBL's current checks cannot detect an SMM-based MitM of its own memory or variable reads,** so `Decision.c` must treat missing or inconsistent platform state as `DEGRADED` or `BLOCK` rather than implicitly trusting the read. (`Decision.c` ll. 182–186)

## Known implementation pitfalls

1. **Assuming `SecureBoot=1` means enforcement is correct.** Conference talks repeatedly show implementation oversights that keep Secure Boot reported as enabled while it is effectively bypassed.
2. **Ignoring S3 resume and sleep states.** S3 resume script attacks are a recurring path; PBL's S3/MOR check is only one indirect signal.
3. **Trusting OS-level or UEFI-shell firmware scanners when SMM may be compromised.** The REcon 2022 talk demonstrated that SMM can MitM firmware image acquisition.
4. **Assuming Option ROMs are signed or benign.** ThunderStrike 2 and GOP Complex show that unsigned or vulnerable Option ROMs can run before the OS with high privilege.
5. **Using a single `bootmgr_hash` without a plan for Windows updates.** The hash changes with each Windows build; stale policy will block legitimate boots or force an unsafe fallback.
6. **Not considering leaked Platform Keys or `PKfail` as a threat.** If the OEM PK is known, an attacker can sign a malicious `PblApp.efi` and pass Secure Boot.
7. **Not maintaining a per-platform baseline for loaded images and GUIDs.** Without a whitelist, `LoadedImageCount` and similar signals generate false positives.
8. **Treating conference PoCs as irrelevant to real deployments.** Many of these techniques have been seen in the wild (LoJax, MosaicRegressor, BlackLotus, CosmicStrand) and continue to evolve.
9. **Failing to update `dbx` and SBAT in policy quickly.** BootHole and BYOVD both exploit the gap between vulnerability disclosure and revocation.
10. **No recovery path when firmware integrity is uncertain.** The talks show that a full reflash with a known-good image, physical access, or vendor recovery may be the only remediation.

## Cross-references to previously studied sources

- **STUDY-UEFI-SPEC-2.10.md** — Defines the UEFI services, variables, Secure Boot, and capsule-update semantics that the conference talks exploit and defend.
- **STUDY-EDK2.md** — Explains the EDK II DXE dispatcher and image loader; the talks' rootkits and exploits target these same code paths.
- **STUDY-TPM-2.0.md** — Documents PCRs, attestation, and `EFI_TCG2_PROTOCOL`; relevant to the integrity-measurement and attestation themes in the UEFI Forum and Binarly talks.
- **STUDY-INTEL-PLATFORM-SECURITY.md** — Covers Boot Guard, BIOS Guard, SMM, SPI protections, and PTT; the conference talks repeatedly test and bypass these layers.
- **STUDY-WINDOWS-NT-INTERNALS.md** — Describes the Windows boot chain and PE/COFF loading; needed to understand the userland→bootloader escalation demos.
- **STUDY-UEFI-BOOTKITS.md** — Provides the LoJax/MoonBounce/CosmicStrand/BlackLotus case-study context that these conference talks helped develop and present.
- **STUDY-ACADEMIC-FIRMWARE-SECURITY.md** — Systematizes the same attack surface with SoK/Peacock/UEFI Memory Forensics; the conference talks are the empirical, real-world counterpart.

## Outstanding questions

1. How can PBL detect or react to an SMM-based interception of its own platform-state reads?
2. Should PBL disable or warn about S3 sleep if MOR/DMA/SPI protections are uncertain?
3. How can PBL include the presence and hashes of loaded PCI/Thunderbolt Option ROMs in the platform state?
4. What is the expected `dbx` baseline and update cadence for PBL's target fleet, and how is inconsistency handled?
5. How should PBL respond if the device's Platform Key is known or leaked (PKfail scenario)?
6. Can PBL verify the integrity of the UEFI variable store on a live system without writing to it?
7. How many of the CHIPSEC checks (`common.spi_lock`, `common.smrr`, `common.uefi.s3bootscript`, `common.secureboot.*`) can be ported into PBL's `Decision.c` engine?
8. How should PBL handle a `DEGRADED` verdict caused by a known OEM-specific implementation oversight (e.g., missing SMM_BWP on a specific model)?
9. Should PBL maintain a server-side database of per-model baselines for loaded UEFI images, and how would that be provisioned?
10. How quickly can PBL's policy/verdict channel push new mitigations for new BYOVD, SMM, or option-ROM attacks?

## Self-test (firmware security conference talks)

1. **What was the four-stage infection chain presented by Matrosov for UEFI rootkits?**
   - Answer: user-mode dropper → kernel-mode payload → SMM exploit → SPI flash write. Confidence: high (Black Hat Asia 2017 slide outline).

2. **What is the key finding of ThunderStrike 2?**
   - Answer: EFI/UEFI vulnerabilities are portable across operating systems and hardware platforms because of a shared EDK2/EFI 1.10 codebase and slow vendor patching; ThunderStrike 2 combined Speed Racer, Darth Venamis, PrinceHarming/Snorlax, and unsigned Option ROMs into the first Mac firmware worm. Confidence: high (`trmm.net/Thunderstrike2_details/`, §Background and §Vulnerabilities).

3. **Which two sleep/resume and removable-device vectors were repeatedly demonstrated in conference talks?**
   - Answer: S3 resume script injection and Option ROM (PCI/Thunderbolt) execution. Confidence: high (ThunderStrike 2; GOP Complex; CanSecWest CHIPSEC slides).

4. **What is the defensive lesson of "A Tale of One Software Bypass of Windows 8 Secure Boot"?**
   - Answer: Secure Boot can be bypassed due to UEFI implementation oversights on real systems even when the feature is reported as enabled. Confidence: high (Black Hat 2013; search-extracted summary).

5. **What is the key limitation of OS-level firmware scanners demonstrated in "Detect Me If You Can"?**
   - Answer: An SMM rootkit can perform a MitM on software-based firmware acquisition and hide malicious components from the scanner. Confidence: high (`infocondb.org/recon-2022`).

6. **What is the purpose of the CHIPSEC framework?**
   - Answer: An open-source platform security assessment framework that checks hardware/firmware security settings including SMRAM/SMM, SPI lock, S3 boot script, and Secure Boot variables, and computes firmware-volume fingerprints. Confidence: high (CanSecWest 2014/2017 slides).

7. **What did "All Your Boot Are Belong To Us" introduce at CanSecWest 2014?**
   - Answer: A history of UEFI bootkits, a userland attack against a securely booted OS, and the CHIPSEC framework. Confidence: high (CanSecWest 2014 slides).

8. **What are the five classes of Secure Boot bypass in Binarly's UEFI 2025 "Signed and Dangerous" talk?**
   - Answer: double-use modules; trusted but vulnerable modules; leaked private keys; verification logic bugs; debug or incomplete features. Confidence: high (UEFI DevCon 2025 slide outline).

9. **What is PKfail, and why does it matter for PBL?**
   - Answer: PKfail is the disclosure that many systems shipped with a shared or leaked Platform Key, allowing an attacker to sign malicious firmware; PBL's trust in Secure Boot must include verifying the actual `PK`/`KEK`/`db`/`dbx` contents. Confidence: medium-high (UEFI 2025 "Repeatable Supply Chain Security Failures" slide; public reporting).

10. **Which PBL component directly corresponds to the SPI write-protection checks emphasized in many talks?**
    - Answer: `SpiProtections.c`, which reads the Intel SPI controller HSFS/PRR registers and reports `Bioswe`, `Ble`, `SmmBwp`, and `PrrCoverBios`. Confidence: high (`SpiProtections.c` ll. 27–85).