# Academic UEFI and Firmware Security — Defensive Study Notes

> **Scope:** Defensive synthesis of peer-reviewed and authoritative literature on UEFI security, firmware-rootkit detection, TPM attestation, and Secure Boot bypass techniques. This note does not contain, create, or improve rootkit/bootkit code.

## Source

- **SoK: Security Below the OS — A Security Analysis of UEFI** (arXiv:2311.03809v2, 2023/2026), by Surve et al. — `https://arxiv.org/abs/2311.03809`. Local HTML extract: `/tmp/devin-overflows-1000/cbfa3a73/content.txt`.
- **Peacock: UEFI Firmware Runtime Observability Layer for Detection and Response** (arXiv:2601.07402v1, 2026), by Gorelik et al. — `https://arxiv.org/abs/2601.07402`. Local HTML extract: `/tmp/devin-overflows-1000/bcb8e444/content.txt`.
- **UEFI Memory Forensics: A Framework for UEFI Threat Analysis** (arXiv:2501.16962v2, 2025/2026), by Segal et al. — `https://arxiv.org/abs/2501.16962`. Local HTML extract: `/tmp/devin-overflows-1000/27c0f2df/content.txt`.
- **BootKitty: A Stealthy Bootkit-Rootkit Against Modern Operating Systems** (USENIX WOOT 2025), by Lee et al. — `https://www.usenix.org/system/files/woot25-lee.pdf`.
- **vTPM: Virtualizing the Trusted Platform Module** (USENIX Security 2006), by Berger et al. — `https://www.usenix.org/conference/15th-usenix-security-symposium/vtpm-virtualizing-trusted-platform-module`.
- **fTPM: A Software-Only Implementation of a TPM Chip** (USENIX Security 2016), by Raj et al. — `https://www.usenix.org/system/files/conference/usenixsecurity16/sec16_paper_raj.pdf`.
- **Separate but Together: Integrating Remote Attestation into TLS** (USENIX ATC 2025), by Weinhold et al. — `https://www.usenix.org/system/files/atc25-weinhold.pdf`.
- **NIST SP 800-155, BIOS Integrity Measurement Guidelines** (Initial Public Draft, 2011) — `https://csrc.nist.gov/pubs/sp/800/155/ipd` and `https://www.govinfo.gov/content/pkg/GOVPUB-C13-PURL-gpo28778/pdf/GOVPUB-C13-PURL-gpo28778.pdf`.
- **TCG PC Client Platform Firmware Integrity Measurement (FIM) Specification** (v1.40, 2020) — `https://trustedcomputinggroup.org/wp-content/uploads/TCG_PC_Client_FIM_v1_r40_02dec2020.pdf`.
- **RFC 9683, Remote Integrity Verification of Network Devices Containing Trusted Platform Modules** (2024) — `https://datatracker.ietf.org/doc/html/rfc9683`.
- **BootHole** (Eclypsium, 2020) — `https://eclypsium.com/wp-content/uploads/Theres-a-Hole-in-the-Boot.pdf`.
- **Signed and Dangerous: BYOVD Attacks on Secure Boot** (Binarly, UEFI 2025 Developers Conference & Plugfest) — `https://uefi.org/sites/default/files/resources/4.%20Signed%20and%20Dangerous_Binarly_Matrosov%20and%20Pagani_FINAL.pdf`.
- **Setup For Failure: Defeating Secure Boot** (SyScan 2014) — `https://papers.put.as/papers/firmware/2014/SyScan2014_SPEAKER09_WP.pdf`.
- **PBL source mapped:**
  - `firmware/PblPkg/PblApp/PblApp.c`
  - `firmware/PblPkg/PblApp/PblApp.h`
  - `firmware/PblPkg/PblApp/PlatformState.c`
  - `firmware/PblPkg/PblApp/Decision.c`
  - `firmware/PblPkg/PblApp/ChainLoad.c`
  - `firmware/PblPkg/PblApp/SpiProtections.c`
  - `firmware/PblPkg/PblApp/TpmClient.c`
  - `firmware/PblPkg/PblApp/TpmSession.c`
  - `docs/adr/PBL-C1-LockVerdict.md`
  - `docs/adr/PBL-C2-TPM-Contract.md`
  - `docs/adr/PBL-C4-Policy-Blob.md`
  - `docs/adr/PBL-DEBT-LEDGER.md`

**Source gap:** Full PDFs for BootKitty, vTPM, fTPM, Separate but Together, NIST 800-155, TCG FIM, BootHole, and the Binarly BYOVD slides were not systematically extracted; the note relies on arXiv HTML extracts, web-fetched abstracts, and published report summaries. Line and table numbers cited are from the arXiv HTML extracts where available.

## One-paragraph technical overview

Peer-reviewed and standards-body literature confirms that UEFI is a high-privilege, pre-OS execution layer with persistent state across reboots, making it an attractive target for advanced bootkits. Static defenses such as UEFI Secure Boot and code signing are necessary but insufficient: real-world attacks increasingly exploit runtime behavior, in-memory hooking, signed-but-vulnerable binaries, and supply-chain weaknesses. Academic frameworks such as the SoK UEFI security analysis systematize these threats into a MITRE ATT&CK-like taxonomy and risk matrix; Peacock demonstrates a runtime observability and attestation architecture for the UEFI phase; and the UEFI memory-forensics framework shows how volatile pre-OS memory analysis can detect service-table, inline, and gadget-based hooking. Complementary work on vTPM/fTPM, remote attestation integrated with TLS, NIST/TCG integrity-measurement guidelines, and RFC 9683 remote-integrity verification provide the trust, measurement, and appraisal foundations. For PBL, the defensive lesson is that a signed pre-OS lock application must assume that pre-PBL firmware may already be compromised, must collect measurable platform-state signals rather than trusting Secure Boot alone, and must bind its observations to a remote verifier using hardware-backed attestation with known-good baselines.

## 10-20 key technical facts/mechanisms

1. **SoK UEFI analysis (arXiv 2311.03809v2) builds a comprehensive MITRE ATT&CK-like taxonomy of UEFI attacks, mapping tactics, techniques, and sub-techniques from real-world incidents and published PoCs.** (`cbfa3a73/content.txt`, §4)
2. **The SoK risk analysis ranks eight techniques in the highest qualitative risk tier: malicious boot loader injection, malicious payload injection, physical attacks, malicious driver injection, SMM exploitation, UEFI security-policy alteration, bootkit installation, and Secure Boot bypass.** (`cbfa3a73/content.txt`, Table 9, lines 1878–1893)
3. **SoK organizes countermeasures into preventive, detective, mitigation, remediation, and identification categories aligned with NIST CSF, and computes an applicability/effectiveness score for each countermeasure/technique pair.** (`cbfa3a73/content.txt`, §5 and §6)
4. **The SoK conclusion is that no single control fully covers the UEFI attack surface; layered, adaptive, and well-deployed defenses are required, with notable gaps in dynamic runtime monitoring and SMM isolation.** (`cbfa3a73/content.txt`, §6 and §8)
5. **Peacock is a three-component framework: a UEFI DXE Agent that hooks and logs Boot/Runtime Service calls, an OS Agent that retrieves the logs and produces a TPM-backed attestation bundle, and an Analysis Server that verifies and correlates the attestation.** (`bcb8e444/content.txt`, §IV)
6. **Peacock's UEFI Agent operates in three phases: (I) embedding the DXE driver into the firmware image, (II) collecting and cryptographically protecting service-call logs, and (III) exporting the logs to the ESP for the OS Agent to forward.** (`bcb8e444/content.txt`, §IV-A)
7. **Peacock logs service calls, hashes log records, and extends the TPM PCRs to protect log integrity and detect tampering; the OS Agent later quotes the same PCRs to bind the logs to the TPM.** (`bcb8e444/content.txt`, §IV-A2 "Log Integrity and Tamper Detection")
8. **Peacock detected Glupteba by observing an unauthorized `LoadImage` hook and the execution of `EfiGuardDxe.efi` from the ESP, with the attacker also recalculating the Boot Services Table CRC32.** (`bcb8e444/content.txt`, §V-B1)
9. **Peacock detected BlackLotus by flagging `grubx64.efi` execution in a Windows environment, `ESP:\system32\` directory usage, unauthorized `MokList` modification, and the `VbsPolicyDisable` variable.** (`bcb8e444/content.txt`, §V-B2)
10. **Peacock detected LoJax by identifying a non-whitelisted `READY_TO_BOOT` callback, rapid `LocateHandleBuffer`/`DiskIo`/`BlockIo` protocol enumeration, and filesystem access patterns.** (`bcb8e444/content.txt`, §V-B3)
11. **Peacock detected MosaicRegressor by correlating creation of the short-named `fTA` NVRAM variable, clustering of related malicious DXE GUIDs, and non-standard `READY_TO_BOOT` callbacks.** (`bcb8e444/content.txt`, §V-B4)
12. **The UEFI Memory Forensics framework consists of `UEFIMemDump` (a DXE driver and UEFI shell application that captures a memory snapshot) and `UEFIDumpAnalysis` (an extensible set of analysis modules).** (`27c0f2df/content.txt`, §IV)
13. **`UEFIDumpAnalysis` parses the in-memory `EFI_BOOT_SERVICES`, `EFI_RUNTIME_SERVICES`, and `EFI_DXE_SERVICES` tables (signatures `b'BOOTSERV'`, `b'RT_SERV'`, `b'DXE_SERV'`), the loaded-image list, and relevant UEFI data structures.** (`27c0f2df/content.txt`, §IV-B1)
14. **The framework detects four classes of UEFI threats: function-pointer hooking, inline hooking, malicious image loading (UEFI image carving), and gadget-based control-flow manipulation using Capstone disassembly and ROP-style gadget chaining.** (`27c0f2df/content.txt`, §IV-B2–B5)
15. **MoonBounce exemplifies inline hooking: it patches the prologues of `AllocatePool`, `CreateEventEx`, and `ExitBootServices` in the Boot Services Table, diverting execution to attacker code while the function-pointer table itself can remain unchanged.** (`27c0f2df/content.txt`, §II-D2 and §V-E)
16. **Evaluation of the memory-forensics framework covered Thunderstrike, Thunderstrike 2, CosmicStrand, Glupteba, EFIGuard, and MoonBounce; the authors report false positives and use GUID-based whitelists and tunable thresholds to manage them.** (`27c0f2df/content.txt`, §V)
17. **vTPM (USENIX Security 2006) virtualizes a TPM for virtual machines, supports suspend/resume and migration, and presents four certificate-chain designs with different security/efficiency trade-offs to link a vTPM to a hardware TPM.** (`https://www.usenix.org/conference/15th-usenix-security-symposium/vtpm-virtualizing-trusted-platform-module`)
18. **fTPM (USENIX Security 2016) implements a software-only TPM 2.0 using ARM TrustZone/Intel SGX; it is the reference implementation used in millions of mobile devices and demonstrates that CPU TEE primitives can displace dedicated TPM hardware.** (`https://www.usenix.org/system/files/conference/usenixsecurity16/sec16_paper_raj.pdf`)
19. **"Separate but Together" (USENIX ATC 2025) argues that TLS and remote attestation must be cryptographically linked so that the TLS channel terminates inside the attested TEE; otherwise relay attacks can present a valid attestation report while proxying the connection to a malicious endpoint.** (`https://www.usenix.org/system/files/atc25-weinhold.pdf`)
20. **NIST SP 800-155 and the TCG PC Client FIM specification define a firmware integrity-measurement chain: a Root of Trust for Measurement (RTM) measures boot components, a Reference Integrity Manifest (RIM) is signed by the manufacturer, and a verifier compares event logs and PCR quotes against golden measurements.** (`https://csrc.nist.gov/pubs/sp/800/155/ipd`; `https://trustedcomputinggroup.org/wp-content/uploads/TCG_PC_Client_FIM_v1_r40_02dec2020.pdf`)
21. **RFC 9683 standardizes Remote Integrity Verification (RIV) for network devices with TPMs, separating attestation evidence, appraisal policy, and attestation results; the appraiser compares device measurements to reference values (golden measurements).** (`https://datatracker.ietf.org/doc/html/rfc9683`)
22. **BootHole (CVE-2020-10713) is a GRUB2 buffer overflow that allows arbitrary code execution even when Secure Boot is enabled, because many signed GRUB2 versions were vulnerable and trusted by the default Microsoft UEFI CA.** (`https://eclypsium.com/wp-content/uploads/Theres-a-Hole-in-the-Boot.pdf`)
23. **"Signed and Dangerous" (Binarly 2025) describes BYOVD-style attacks on Secure Boot, in which legitimately signed but vulnerable UEFI drivers are used to bypass Secure Boot; the taxonomy includes double-use modules and revoked-but-still-present binaries.** (`https://uefi.org/sites/default/files/resources/4.%20Signed%20and%20Dangerous_Binarly_Matrosov%20and%20Pagani_FINAL.pdf`)
24. **"Setup For Failure" (SyScan 2014) showed that UEFI Secure Boot could be bypassed by exploiting weaker write protection on the UEFI variable region and SMI suppression, allowing ring-0 code to overwrite critical authenticated variables while Secure Boot still reports enabled.** (`https://papers.put.as/papers/firmware/2014/SyScan2014_SPEAKER09_WP.pdf`)

## Glossary terms

- **SoK (Systematization of Knowledge):** A survey paper that organizes a research area, defines taxonomies, and maps attacks/defenses. Here, the UEFI security SoK.
- **MITRE ATT&CK-like taxonomy:** A tactics/techniques/sub-techniques framework adapted for UEFI-specific attacks.
- **Peacock UEFI Agent:** A DXE driver that hooks UEFI Boot and Runtime Services, logs calls, and protects log integrity via TPM PCRs.
- **Peacock OS Agent:** A cross-platform post-boot agent that retrieves UEFI logs and produces a TPM-attested bundle.
- **UEFIMemDump:** A DXE driver and UEFI shell application for capturing a complete snapshot of system memory during the pre-OS phase.
- **UEFIDumpAnalysis:** An extensible set of analysis modules that parse UEFI memory structures and detect hooking, image loading, and gadget-based attacks.
- **Function-pointer hooking:** Modifying the function pointers in a UEFI service table to redirect calls.
- **Inline hooking:** Patching the first instructions of a target function to redirect execution while the table pointers may still be valid.
- **Gadget-based control-flow manipulation:** Reusing short instruction sequences (gadgets) from existing PE/COFF images, similar to ROP, in the UEFI environment.
- **Reference Integrity Manifest (RIM):** A signed collection of expected firmware-component measurements from the manufacturer, used by a verifier for attestation.
- **Remote Integrity Verification (RIV):** The IETF/RFC-9683 workflow for remotely verifying device firmware and software integrity using TPM evidence.
- **Appraisal policy:** The set of rules a verifier uses to decide whether attestation evidence matches the expected golden state.
- **Golden measurements:** Trusted reference hash values for firmware and boot components.
- **BYOVD (Bring Your Own Vulnerable Driver) / BYOVD-UEFI:** Using a legitimately signed, vulnerable UEFI driver to disable or bypass Secure Boot.
- **BootHole (CVE-2020-10713):** A GRUB2 vulnerability that defeated Secure Boot on many Linux and Windows systems.
- **MOK (Machine Owner Key):** A user-managed key list used by shim to authorize additional bootloaders; abused by BlackLotus to persist a self-signed GRUB.
- **Attestation bundle:** A package containing measured evidence, a TPM quote, and metadata, transmitted from a device to a verifier.
- **TAP (Trusted Attestation Protocol):** TCG protocol for reporting attestation evidence with TPM-backed integrity.

## Security implications

- **Static code signing is not runtime integrity.** Secure Boot and `db`/`dbx` only decide whether a loaded image is signed by a trusted key; they do not detect in-memory patching, runtime hooking, or signed-but-vulnerable binaries.
- **UEFI runs with the highest privilege before the OS.** A compromise at this layer can disable kernel, hypervisor, and endpoint security before those layers start, and can persist across OS reinstall and disk replacement.
- **The pre-OS stage has a large visibility gap.** Until recently, there were few practical runtime monitors or memory forensics tools for UEFI, making hook-based and fileless bootkits hard to detect.
- **Attestation must be bound to the protected channel.** A remote attestation report proves device state at one point; if the TLS channel that follows can be terminated elsewhere, a valid report can be relayed to a malicious endpoint.
- **Supply chain and update mechanisms are part of the TCB.** Malicious capsules, compromised OEM signing keys, and vulnerable signed drivers (BYOVD, BootHole) can all defeat an otherwise correctly configured Secure Boot policy.
- **False positives are unavoidable without baselines.** Legitimate firmware variants, option ROMs, and cross-driver calls create hook-like patterns; effective detection requires per-platform whitelists and thresholds.
- **Memory forensics acquisition cannot be fully trusted if the firmware is compromised.** A rootkit with DXE-level control can forge or hide memory, so hardware-backed or isolated acquisition is preferable.

## PBL-specific relevance

- **PBL's `LoadedImageCount` and `bootmgr_hash` are coarse analogues of the Peacock/UEFIDumpAnalysis approach.** Peacock and the memory-forensics papers show that more useful signals are per-image names/GUIDs, `LoadImage`/`StartImage` arguments, protocol-open sequences, and filesystem access patterns, not just a count. (`PlatformState.c` ll. 910–939; `PblApp.h` ll. 285–290; `STUDY-UEFI-BOOTKITS.md` §PBL-specific relevance)
- **PBL's BCD dangerous-element parsing can be extended with high-value NVRAM variables observed in the wild.** Peacock flags `MokList`, `VbsPolicyDisable`, and non-standard `READY_TO_BOOT` callbacks; the SoK taxonomy includes UEFI variable manipulation and security-policy alteration as high-risk techniques. (`PblApp.h` ll. 247–273; `Decision.c` ll. 154–177; `bcb8e444/content.txt` §V-B)
- **PBL's PCR 12/13 design is consistent with the Peacock tamper-evident logging pattern, but PBL does not currently sign or log individual UEFI service calls.** Peacock binds each log record to a TPM PCR, and the OS Agent later quotes that PCR; PBL could extend PCR 13 with a service-call/event log to provide an auditable, tamper-evident chain. (`PblApp.c` ll. 560–634; `bcb8e444/content.txt` §IV-A2)
- **PBL's chain-load verification (`bootmgr_hash`, C4 key 58) is the direct countermeasure to malicious boot-loader injection and Secure Boot bypass, but it must be updated with every OS build.** Academic BYOVD/BootHole work shows that a stale `dbx` or trust in a once-valid signature is a recurring failure mode. (`ChainLoad.c` ll. 217–278; `PBL-C4-Policy-Blob.md` §2.6)
- **PBL's SPI protection checks (`Bioswe`, `Ble`, `SmmBwp`, `PrrCoverBios`) align with the SoK countermeasure taxonomy, but they only verify that the controller is configured to protect the flash, not that the image itself is unmodified.** (`SpiProtections.c` ll. 27–85; `Decision.c` ll. 179–191)
- **The SoK high-risk list (SMM exploitation, malicious driver injection, Secure Boot bypass, bootkit installation) maps directly to PBL `Decision.c` REQ-01/02/03/07/08/09 checks, but several of those checks are indirect or incomplete.** (`Decision.c` ll. 154–286; `PBL-DEBT-LEDGER.md` D-121–D-128)
- **NIST SP 800-155 / TCG FIM / RFC 9683 provide the formal framework for what PBL's server-side verifier should do:** compare a reported event log and PCR quote against a signed RIM/golden measurements and apply an appraisal policy. PBL currently does not use RIMs or reference values. (`PBL-C1-LockVerdict.md`; `PBL-C2-TPM-Contract.md`)
- **vTPM/fTPM research is a warning for PBL's test environment:** QEMU/swtpm OVMF uses an owner-provisioned software TPM with empty auth; on real hardware, PBL must use the platform hierarchy and a discrete TPM or firmware TPM whose trust chain is rooted in the CPU/chipset. (`STUDY-TPM-2.0.md` §PBL gaps; `STUDY-INTEL-PLATFORM-SECURITY.md` §PTT)
- **The "Separate but Together" TLS+attestation paper reinforces that PBL's HTTPS verdict fetch must eventually bind the TLS channel to the device's attestation identity, otherwise a stolen or relayed attestation can bypass the server.** (`PBL-C3-Network-Client.md`; `PBL-C4-Policy-Blob.md` §5)
- **PBL's `Sbat.c` and SBAT variable handling is relevant to BootHole/shim/GRUB ecosystems, but the Windows-only PBL path must still account for an attacker enrolling a malicious MOK or replacing `bootmgfw.efi` with a Linux shim/GRUB.** (`Sbat.c`; `STUDY-UEFI-BOOTKITS.md` §Security implications)

## Known implementation pitfalls

1. **Runtime logging can be subverted if the logging agent is loaded after the attacker.** Peacock explicitly assumes the UEFI Agent is embedded before third-party DXE components. PBL, as a standalone application, starts after DXE dispatch and cannot observe earlier DXE drivers. (`bcb8e444/content.txt` §III; `PblApp.c`)
2. **PCR attestation only proves what was extended; a pre-PBL rootkit can extend or suppress measurements.** The verifier must compare quotes to a known-good baseline, not assume that a PCR value by itself is trustworthy. (`27c0f2df/content.txt` §II-A3; `STUDY-TPM-2.0.md` §Security implications)
3. **Memory-forensic acquisition from a running, compromised UEFI is not trustable without hardware isolation.** A malicious DXE driver can intercept `GetMemoryMap` or patch the acquisition tool. (`27c0f2df/content.txt` §VII-A)
4. **False positives in hook and image-carving detection require per-platform baselines.** PBL's `LoadedImageCount` has the same problem; without a whitelist of legitimate images and GUIDs, it cannot safely drive a block decision. (`27c0f2df/content.txt` §VII-D; `PBL-DEBT-LEDGER.md` D-213)
5. **`dbx` revocations lag behind vulnerability disclosure.** BootHole and BlackLotus both exploited this gap; PBL's policy must include boot-manager SVN floors and `dbx` expectations, not just a boolean Secure Boot check. (`PBL-C4-Policy-Blob.md` §2.2; `STUDY-UEFI-BOOTKITS.md` §Known implementation pitfalls)
6. **Attestation freshness and clock are critical.** PBL's `PblGetUnixTime` fallback and no-session TPM commands may not meet the freshness assumptions of RFC 9683 or Peacock's log integrity model. (`STUDY-TPM-2.0.md` §PBL gaps)
7. **MOK and UEFI variable abuse is hard to distinguish from legitimate use.** Blocking every `MokList` change or `VbsPolicyDisable` set would break legitimate Linux dual-boot and VBS debugging; policy needs an expected baseline. (`bcb8e444/content.txt` §V-B2; `PBL-C4-Policy-Blob.md`)
8. **RIM and golden-measurement verification require a trusted OEM supply chain.** PBL has no signed RIM from OEMs, so it must build its own baselines per device model, which is a large operational burden. (`TCG PC Client FIM`; `NIST SP 800-155`)
9. **vTPM/fTPM trust collapses to the hypervisor or TEE.** PBL targeting physical laptops should rely on a discrete TPM or Intel PTT with Boot Guard, not a virtualized or test-only fTPM. (`STUDY-INTEL-PLATFORM-SECURITY.md` §PTT; `STUDY-TPM-2.0.md` §PBL gaps)
10. **New academic PoCs (BootKitty, etc.) will continue to bypass then-current controls.** PBL's policy/verdict mechanism must be updatable over the network or via signed policy blobs without requiring a firmware reflash. (`PBL-C4-Policy-Blob.md` §7; `STUDY-UEFI-BOOTKITS.md` §Outstanding questions)

## Cross-references to previously studied sources

- **STUDY-UEFI-SPEC-2.10.md** — Provides the UEFI 2.10 foundation for `EFI_BOOT_SERVICES`, `EFI_RUNTIME_SERVICES`, `LoadImage`, `ExitBootServices`, Secure Boot variables, and capsule updates that the academic papers analyze.
- **STUDY-EDK2.md** — Explains how EDK II's DXE dispatcher, image loader, `DxeImageVerificationLib`, and BDS load and verify images; relevant to Peacock's hook points and UEFI memory-forensics structure parsing.
- **STUDY-TPM-2.0.md** — Documents PCR extension, HMAC/policy sessions, NV indices, and `EFI_TCG2_PROTOCOL`; essential for understanding Peacock's log-integrity binding and PBL's PCR 12/13 design.
- **STUDY-INTEL-PLATFORM-SECURITY.md** — Covers Boot Guard, SPI write protection, PTT/ME, and CPU TEEs; provides the hardware-root-of-trust context for vTPM/fTPM and RIM/RIV attestation.
- **STUDY-WINDOWS-NT-INTERNALS.md** — Describes the Windows boot chain (`bootmgfw.efi` → `winload.efi` → `ntoskrnl.exe`) and PE/COFF loading; needed to understand why bootkits hook `OslArchTransferToKernel` and how PBL's `bootmgr_hash` fits.
- **STUDY-UEFI-BOOTKITS.md** — Provides the LoJax/MoonBounce/CosmicStrand/BlackLotus/LogoFAIL case-study context that the academic papers formalize, systematize, and detect.

## Outstanding questions

1. How can PBL, as a UEFI application rather than a DXE driver, collect Peacock-like service-call telemetry without itself becoming a firmware-modification target?
2. Should PBL extend PCR 13 with a structured event log of its own observations, and if so, how should that log be transmitted to the server for replay verification?
3. What is the practical baseline for `LoadedImageCount` and per-image hash/GUID whitelists across the supported HP/Intel fleet?
4. How does PBL distinguish between a legitimate Linux dual-boot `MokList` entry and an attacker-enrolled MOK?
5. How can PBL's server implement TCG RIM/SP 800-155 golden-measurement appraisal without OEM-signed reference manifests?
6. What is the right policy action when the UEFI phase is itself potentially compromised and all pre-PBL inputs are untrustable?
7. Can PBL use a pre-OS memory dump or a minimal UEFI shell tool for incident response without exposing new attack surface?
8. How should PBL handle fTPM vs dTPM devices in its attestation policy?
9. How can PBL bind its HTTPS verdict channel to the device's attestation identity to prevent relay and proxy attacks?
10. How quickly can PBL's policy `dbx` and `Sbat` expectations be updated when new BYOVD/BootHole-class vulnerabilities are disclosed?

## Self-test (academic UEFI and firmware security)

1. **What is the main limitation of UEFI Secure Boot that the SoK, Peacock, and UEFI Memory Forensics papers all highlight?**
   - Answer: It verifies static code signatures at load time but does not detect in-memory hooking, runtime manipulation, or signed-but-vulnerable binaries. Confidence: high (cross-paper consensus).

2. **Which four real-world bootkits did Peacock evaluate, and what was the common detection pipeline?**
   - Answer: Glupteba, BlackLotus, LoJax, and MosaicRegressor; detected by UEFI Agent logging, OS Agent TPM attestation bundle, and Analysis Server rule correlation. Confidence: high (`bcb8e444/content.txt` §V-B).

3. **What are the two primary hooking techniques in UEFI, and which bootkit exemplifies inline hooking?**
   - Answer: Function-pointer hooking and inline hooking; MoonBounce exemplifies inline hooking of `AllocatePool`, `CreateEventEx`, and `ExitBootServices`. Confidence: high (`27c0f2df/content.txt` §II-D2, §V-E).

4. **What are the three main components of the UEFI Memory Forensics framework?**
   - Answer: `UEFIMemDump` (memory acquisition), `UEFIDumpAnalysis` (analysis modules), and detection modules for function-pointer hooking, inline hooking, image carving, and gadget-based control flow. Confidence: high (`27c0f2df/content.txt` §IV).

5. **What is the key takeaway from "Separate but Together: Integrating Remote Attestation into TLS"?**
   - Answer: TLS and attestation must be cryptographically linked so the secure channel terminates at the origin of the attestation report; otherwise relay attacks are possible. Confidence: high (paper abstract).

6. **What is a Reference Integrity Manifest (RIM) in TCG FIM terminology?**
   - Answer: A manufacturer-signed set of expected firmware-component measurements used by a verifier to compare against device-reported event logs and PCR quotes. Confidence: high (`TCG PC Client FIM`).

7. **Why is BootHole (CVE-2020-10713) significant for Secure Boot?**
   - Answer: It is a GRUB2 buffer overflow that allows arbitrary code execution while Secure Boot is enabled, because many signed GRUB2 images remained trusted. Confidence: high (`BootHole` report).

8. **What does NIST SP 800-155 require as the foundation of BIOS integrity measurement?**
   - Answer: A Root of Trust for Measurement (RTM) that measures BIOS code and configuration, stores measurements in protected registers, and reports them to a Measurement Assessment Authority (MAA). Confidence: high (`NIST SP 800-155`).

9. **How does the SoK risk analysis score countermeasures against attack techniques?**
   - Answer: It assigns an applicability score of 0–3 for each countermeasure/technique pair, then computes an average effectiveness score and places techniques into High/Mid/Moderate/Fair risk tiers. Confidence: medium (`cbfa3a73/content.txt` §6).

10. **Which PBL policy field is the direct counterpart to the academic countermeasure of "verify the exact boot manager before chain-load"?**
    - Answer: `bootmgr_hash` (C4 key 58), enforced by `ChainLoad.c` before `LoadImage`. Confidence: high (`ChainLoad.c` ll. 217–278; `PBL-C4-Policy-Blob.md` §2.6).