# Research Blogs and EDK II Implementation Pitfalls — Defensive Study Notes

> **Scope:** Defensive synthesis of firmware-security research blogs and EDK II / TianoCore implementation post-mortems. The note covers UEFI bootkit detection research, image-parser and key-management vulnerabilities, and the build/linker/loader/networking pitfalls that affect real EDK II-based projects, including PBL.

## Source

- **Binarly — UEFI Bootkit Hunting: In-Depth Search for Unique Code Behavior** — `https://www.binarly.io/blog/uefi-bootkit-hunting-in-depth-search-for-unique-code-behavior`.
- **Binarly — Finding LogoFAIL: The Dangers of Image Parsing During System Boot** — `https://www.binarly.io/blog/finding-logofail-dangers-of-image-parsing-system-boot`; advisory `brly-2023-006` (`https://www.binarly.io/advisories/brly-2023-006`); 6-month post-mortem PDF: `https://22222483.fs1.hubspotusercontent-na1.net/hubfs/22222483/Reports/Binarly_LogoFAIL%20REsearch%20Report%206.20.24.pdf`.
- **Binarly — LogoFAIL Exploited to Deploy Bootkitty, the first UEFI bootkit for Linux** — `https://www.binarly.io/blog/logofail-exploited-deploy-bootkitty-first-uefi-bootkit-linux`.
- **Binarly — PKfail: Untrusted Platform Keys Undermine Secure Boot on UEFI Ecosystem** — `https://www.binarly.io/blog/pkfail-untrusted-platform-keys-undermine-secure-boot`; GitHub advisory `BRLY-2024-005` (`https://github.com/binarly-io/Vulnerability-REsearch/blob/main/PKfail/BRLY-2024-005.md`); report PDF (`https://res.cloudinary.com/dlnhqmgqi/image/upload/v1750803755/Binarly_Research_Report_July_25_2024_1_ohqwot.pdf`).
- **Binarly — The Untold Story of the BlackLotus UEFI Bootkit** — `https://www.binarly.io/blog/untold-story-blacklotus-uefi-bootkit`.
- **ESET — BlackLotus UEFI bootkit: Myth confirmed** — `https://www.welivesecurity.com/2023/03/01/blacklotus-uefi-bootkit-myth-confirmed/`.
- **Kaspersky Securelist — MoonBounce: the dark side of UEFI firmware** — `https://securelist.com/moonbounce-the-dark-side-of-uefi-firmware/105468/`; technical PDF: `https://media.kasperskycontenthub.com/wp-content/uploads/sites/43/2022/01/19115831/MoonBounce_technical-details_eng.pdf`.
- **Kaspersky Securelist — CosmicStrand: the discovery of a sophisticated UEFI firmware rootkit** — `https://securelist.com/cosmicstrand-uefi-firmware-rootkit/106973/`.
- **Kaspersky Securelist — MosaicRegressor: Lurking in the Shadows of UEFI** — `https://securelist.com/mosaicregressor/98849/`.
- **Eclypsium — BootHole (There's a Hole in the Boot)** — `https://eclypsium.com/wp-content/uploads/Theres-a-Hole-in-the-Boot.pdf`.
- **EDK II / TianoCore source and issues:**
  - `MdePkg/Library/BasePeCoffLib/BasePeCoff.c` — PE/COFF loader and relocation handling.
  - `MdeModulePkg/Core/Dxe/Image/Image.c` — DXE `LoadImage`/`StartImage` implementation.
  - `BaseTools/Source/C/GenFw/Elf64Convert.c` — ELF → PE/COFF conversion and `.reloc` generation.
  - `BaseTools/Conf/tools_def.template` and `PblPkg/PblPkg.dsc` — toolchain flags and LTO settings.
  - `firmware/PblPkg/PblApp/ForceReloc.c` — PBL workaround for missing `.reloc`.
  - `firmware/PblPkg/PblPkg.dsc` lines 28–33 — `-fno-lto` and `.reloc` comment.
  - GitHub issues `tianocore/edk2#12651`, `#4617`, `#10942`, `#12095`, `#10192` — TLS, GOTPCREL, boot-device discovery, BDS PXE.
  - TianoCore wiki — UEFI HTTPS Boot: `https://www.tianocore.org/tianocore-wiki.github.io/platforms-packages/component-guides/https_boot.html`.
- **PBL source mapped:**
  - `firmware/PblPkg/PblApp/PblApp.c`
  - `firmware/PblPkg/PblApp/PblApp.h`
  - `firmware/PblPkg/PblApp/ForceReloc.c`
  - `firmware/PblPkg/PblPkg.dsc`
  - `firmware/PblPkg/PblApp/ChainLoad.c`
  - `firmware/PblPkg/PblApp/PlatformState.c`
  - `firmware/PblPkg/PblApp/Decision.c`
  - `firmware/PblPkg/PblApp/Sbat.c`
  - `firmware/PblPkg/PblApp/PblTls.c` (if present)
  - `docs/adr/PBL-C3-Network-Client.md`
  - `docs/adr/PBL-C4-Policy-Blob.md`
  - `docs/adr/PBL-DEBT-LEDGER.md`

**Source gap:** Several Binarly blog pages are JS-only or Cloudflare-gated and returned little extractable text. The note relies on web-search-extracted snippets, public advisories, the previously saved report PDFs, and the ESET/Kaspersky reports already used in earlier study notes. EDK II issues are summarized from GitHub search-extracted snippets and source files.

## One-paragraph technical overview

Research blogs from Binarly, ESET, Kaspersky, and Eclypsium document the real-world evolution of UEFI bootkits (LoJax, MosaicRegressor, MoonBounce, CosmicStrand, BlackLotus, ESPecter, Bootkitty) and a growing class of supply-chain and parser-based attacks (LogoFAIL, BootHole, PKfail). Binarly's work on UEFI bootkit hunting shows that code-similarity and behavioral rules can discover previously unknown samples, while LogoFAIL demonstrates that UEFI image-parser code is an exploitable, pre-OS attack surface that bypasses Secure Boot and Boot Guard. PKfail shows that leaked or default Platform Keys can defeat the entire UEFI Secure Boot trust model. On the EDK II implementation side, the build, linker, loader, and network stack are full of practical pitfalls: `GenFw` only emits a `.reloc` section when the ELF contains absolute (`R_X86_64_64`) relocations, so `-fPIC`/LTO builds may produce an EFI binary that real firmware rejects; `GenFw` and LLD can produce stale or corrupt `GOTPCREL` relocations; UEFI HTTPS boot supports only one-way server authentication and has certificate-chain, TLS-version, security-level, and hostname-verification limitations; and BDS boot-device discovery can fail due to asynchronous driver initialization or QEMU `fw_cfg` ordering. PBL directly encounters the `.reloc`/LTO pitfall (the project already uses `-fno-lto` and `ForceReloc.c`), and its HTTPS verdict fetch must navigate the same EDK2 TLS caveats.

## 10-20 key technical facts/mechanisms

1. **Binarly's UEFI bootkit hunting research (2025) proposes detecting bootkits by analyzing unique code behaviors** such as hook chains and persistence mechanisms, rather than relying only on signatures; this led to YARA/FwHunt rules and the discovery of six previously unidentified bootkit samples via VirusTotal retrohunts and Binarly telemetry. (`binarly.io/blog/uefi-bootkit-hunting`)
2. **The studied bootkits share code characteristics** that enable code-similarity detection: LoJax, MosaicRegressor, MoonBounce, CosmicStrand, ESPecter, and BlackLotus all use hook chains, OS kernel/driver hooks, and distinctive persistence patterns. (`binarly.io/blog/uefi-bootkit-hunting`)
3. **LogoFAIL is a class of vulnerabilities in UEFI image parsers for BMP, JPEG, PNG, PCX, and TGA logo images;** all major independent BIOS vendors (IBVs) were found to contain parser bugs, and successful exploitation can achieve arbitrary code execution before the OS loader while bypassing Secure Boot and Boot Guard. (`binarly.io/advisories/brly-2023-006`; 6-month post-mortem PDF)
4. **LogoFAIL can be triggered by flashing firmware with a malicious logo, by placing a logo in an unsigned firmware-update section, or by storing a custom logo on the EFI System Partition;** it therefore does not require SPI flash write access in every variant. (`binarly.io/advisories/brly-2023-006`)
5. **Bootkitty is the first known UEFI bootkit for Linux;** it uses LogoFAIL as an entry point, deploys a UEFI application, disables kernel signature verification by patching GRUB and the Linux kernel, and preloads ELF binaries via `init`. (`binarly.io/blog/logofail-exploited-deploy-bootkitty`)
6. **PKfail is a supply-chain failure in which hundreds of devices from multiple vendors use an insecure, leaked American Megatrends (AMI) test Platform Key (PK) as their root of trust;** an attacker with the private PK can modify `db`/`dbx` and defeat Secure Boot on affected systems. (`binarly.io/blog/pkfail-untrusted-platform-keys-undermine-secure-boot`; `github.com/binarly-io/Vulnerability-REsearch/blob/main/PKfail/BRLY-2024-005.md`)
7. **PKfail shares root causes with earlier Intel Boot Guard key leaks:** poor cryptographic material management, use of non-production keys in production, no per-product-line key rotation, and the same OEM using the same security keys across different device manufacturers. (`binarly.io/blog/pkfail`)
8. **BlackLotus is the first publicly known in-the-wild UEFI bootkit that bypasses Secure Boot on fully updated Windows 11;** it exploits CVE-2022-21894, brings its own vulnerable-but-signed Windows binaries, enrolls an attacker MOK, and has been sold on underground forums since at least October 2022. (`welivesecurity.com/2023/03/01/blacklotus-uefi-bootkit-myth-confirmed/`)
9. **MoonBounce persists in SPI flash by patching `CORE_DXE` and hooks `AllocatePool`, `CreateEventEx`, and `ExitBootServices` in the `EFI_BOOT_SERVICES` table;** it then propagates into `winload.efi`, `ntoskrnl.exe`, and ultimately `svchost.exe`. (`securelist.com/moonbounce` PDF)
10. **CosmicStrand is a Gigabyte/ASUS H81 firmware rootkit that patches `CSMCORE`;** it chains hooks through UEFI `HandleProtocol`, the boot manager, `winload.efi` `OslArchTransferToKernel`, and `ntoskrnl.exe` `ZwCreateSection`. (`securelist.com/cosmicstrand-uefi-firmware-rootkit/106973/`)
11. **EDK II `GenFw` generates the PE/COFF `.reloc` section only when the input ELF contains absolute (`R_X86_64_64`) relocations;** code compiled with `-fPIC` or optimized with LTO typically emits only PC-relative (`R_X86_64_PC32`) relocations, so `GenFw` produces an EFI image without `.reloc`. (`BaseTools/Source/C/GenFw/Elf64Convert.c`; `PblPkg/PblPkg.dsc` lines 28–33)
12. **PBL's `ForceReloc.c` is a workaround for exactly this issue:** a global `__attribute__((used))` function-pointer table in `.data` holds absolute addresses, forcing `R_X86_64_64` relocations that `GenFw` converts into PE/COFF base relocations, satisfying the HP Insyde F.39 BIOS that rejects binaries without `.reloc`. (`firmware/PblPkg/PblApp/ForceReloc.c`)
13. **PBL's `PblPkg.dsc` therefore sets `-fno-lto` for GCC/RELEASE builds** because LTO can eliminate the absolute relocations needed for `.reloc`; without it, the HP/Insyde target fails to load. (`firmware/PblPkg/PblPkg.dsc` lines 28–33)
14. **EDK II's x86_64 `GenFw` has had repeated problems with `GOTPCREL` and `GOTPCRELX` relocations when using LLD/LTO;** the linker may relax a `movq _symbol@GOTPCREL(%rip)` to a direct `leaq _symbol(%rip)`, leaving a stale relocation that `GenFw` then converts to a PE/COFF relocation pointing into code, corrupting the image. (`tianocore/edk2#6346`; `tianocore/edk2` commit `ecbaa85`)
15. **EDK II UEFI HTTPS boot supports only one-way server authentication (unauthenticated client) with TLS 1.0/1.1/1.2;** the server's CA certificate must be pre-provisioned in the `TlsCaCertificate` UEFI variable in `EFI_SIGNATURE_LIST` format. (`www.tianocore.org/tianocore-wiki.github.io/platforms-packages/component-guides/https_boot.html`)
16. **EDK II TLS/OpenSSL in OVMF defaults to security level 3, which rejects end-entity certificates with key sizes or algorithms considered weak;** this has caused HTTPS boot failures such as `EE certificate key too weak` against real-world servers, with a workaround of lowering the OpenSSL security level to 2. (`tianocore/edk2#12651`)
17. **EDK II `HttpDxe` historically used `EFI_TLS_VERIFY_FLAG_NO_WILDCARDS` for hostname verification, breaking wildcard certificates;** a fix switched to `EFI_TLS_VERIFY_FLAG_NONE` (which in OpenSSL means no additional flags and wildcards are supported only in the left-most label). (`tianocore/edk2` commit `6f9e83f`)
18. **EDK II BDS boot-device discovery can fail because not all devices are connected before BDS runs;** asynchronous driver initialization, missing `EfiBootManagerConnectAll()` calls, or QEMU `fw_cfg` device lists can leave network, USB, or block devices undiscovered until the user re-enters the boot menu. (`tianocore/edk2#12095`; `tianocore/edk2#10192`; `gdbplus.substack.com/p/how-edk2-bds-finds-the-uefi-shell`)
19. **EDK II `BasePeCoffLib` will not relocate an image that has `EFI_IMAGE_FILE_RELOCS_STRIPPED` set and no base relocations;** an image loaded at an address different from its preferred base must have a valid `.reloc` section or it will fail. (`MdePkg/Library/BasePeCoffLib/BasePeCoff.c`)
20. **EDK II `DxeImageVerificationLib` and `EFI_SECURITY2_ARCH_PROTOCOL` are the code paths that enforce Secure Boot in DXE;** they parse the PE/COFF certificate table (data directory 4) and check `db`/`dbx`; if `dbx` is stale or the platform is in `SetupMode`, vulnerable or attacker-signed images can be loaded. (`SecurityPkg/Library/DxeImageVerificationLib/DxeImageVerificationLib.c`; `STUDY-EDK2.md`)
21. **OVMF network boot requires a random-number generator device such as `virtio-rng-pci`** because the network and TLS stacks consume entropy during DHCP, TLS handshakes, and TCP initial sequence numbers; without it, HTTPS boot can hang or fail. (`blog.yadutaf.fr/2026/06/12/introduction-to-uefi-https-boot-qemu-ovmf/`)
22. **Research and EDK II implementation experience converge on one principle:** a pre-OS security application must never trust a single control (Secure Boot, a signature, a hash, or a configuration bit); it must combine layered, independently measured signals and be prepared to update its policy when the supply chain or reference implementation changes.

## Glossary terms

- **FwHunt / FwHunt rule:** Binarly's firmware-hunting rule format for detecting bootkit and implant patterns in UEFI images.
- **Retrohunt:** VirusTotal feature that scans historical samples with new rules; used by Binarly to find previously undetected bootkits.
- **LogoFAIL:** Binarly's umbrella term for UEFI image-parser vulnerabilities in boot logos (BMP/JPEG/PNG/PCX/TGA) that enable pre-OS arbitrary code execution.
- **PKfail:** Binarly's name for the supply-chain issue of using leaked or test Platform Keys as the root of trust for UEFI Secure Boot.
- **BYOVD (Bring Your Own Vulnerable Driver) — UEFI version:** Using a legitimately signed but vulnerable UEFI module to bypass Secure Boot.
- **MOK (Machine Owner Key):** User-managed key list used by Linux `shim`; BlackLotus abused MOK enrollment to persist a self-signed GRUB.
- **`.reloc` section:** PE/COFF base-relocation directory used by the loader when an image is not loaded at its preferred address; required by some BIOS implementations.
- **Absolute relocation (`R_X86_64_64`):** ELF relocation that refers to a 64-bit absolute address; `GenFw` converts these to PE/COFF `.reloc` entries.
- **PC-relative relocation (`R_X86_64_PC32`):** ELF relocation relative to the program counter; does not produce a `.reloc` section in `GenFw`.
- **GOTPCREL / GOTPCRELX:** x86_64 ELF relocation types that use the Global Offset Table; can cause `GenFw`/PE/COFF corruption if the linker relaxes them after `GenFw` expects a GOT slot.
- **LTO (Link Time Optimization):** Compiler optimization that can eliminate or transform global symbols, changing the relocation types emitted by the linker and potentially stripping the `.reloc` section.
- **`TlsCaCertificate` (`{0xfd2340d0,...}`):** UEFI variable in `EFI_SIGNATURE_LIST` format used by EDK II to store trusted CA certificates for HTTPS boot.
- **OpenSSL security level:** A policy knob that rejects certificates, keys, and algorithms below a threshold; EDK II's level 3 is stricter than Linux/Windows defaults and can break real-world HTTPS boot.
- **`EFI_TLS_VERIFY_FLAG_NONE`:** In EDK II TLS, this flag means no additional hostname-verification flags are set; it does **not** mean "disable verification" and is required for wildcard certificate support.
- **BDS (Boot Device Selection):** UEFI phase that discovers devices, builds `Boot####` variables, and starts the selected boot option.
- **ConnectAll / `EfiBootManagerConnectAll()`:** BDS routine that forces all driver binding protocols to connect to all devices; missing this can leave boot devices undiscovered.
- **XIP (eXecute In Place):** PE/COFF image loaded and run directly from ROM/flash without being copied to RAM; cannot be relocated.

## Security implications

- **Research blogs confirm that UEFI bootkits are a continuously evolving, real-world threat.** New samples are discovered regularly, and attackers now target Linux as well as Windows (Bootkitty).
- **Image-parser and supply-chain vulnerabilities can defeat Secure Boot and Boot Guard without any direct attack on the boot manager.** LogoFAIL and PKfail show that the attack surface includes non-executable data parsing and key-management failures.
- **Code-similarity and behavioral detection are more robust than signature-only detection for new bootkits,** but they require a large, curated corpus and can still be evaded by novel code.
- **EDK II implementation pitfalls show that even correctly designed UEFI/PI code can fail in practice due to linker, loader, and network stack behavior.** A security application must be tested on the exact toolchain, firmware, and network configuration it will use.
- **The `.reloc`/LTO issue is a concrete example where a build setting can silently produce an EFI binary that is valid for QEMU but rejected by real hardware.** Build-time verification must include real firmware targets, not just `objdump` and QEMU.
- **UEFI HTTPS/TLS is a fragile, manually configured feature in EDK II.** Certificate format, security level, TLS version, hostname verification, and entropy source all matter and can all fail in non-obvious ways.
- **Boot-device discovery is not deterministic on all platforms;** a pre-OS application that assumes a device will be present may hang or drop to shell.

## PBL-specific relevance

- **PBL's `ForceReloc.c` and `-fno-lto` in `PblPkg.dsc` are direct responses to the EDK II `.reloc` generation pitfall.** The note documents why this is needed and that it remains fragile across toolchains and future EDK2 releases. (`firmware/PblPkg/PblApp/ForceReloc.c`; `firmware/PblPkg/PblPkg.dsc` lines 28–33)
- **PBL's `ChainLoad.c` `bootmgr_hash` and BCD parsing counter the BlackLotus/LogoFAIL/Bootkitty boot-manager replacement attack path,** but the hash must be updated with every OS/GRUB/Windows build and every new vulnerable signed binary. (`ChainLoad.c` ll. 217–278; `PblApp.h` ll. 247–273)
- **PBL's `Sbat.c` and SBAT policy check are relevant to the GRUB/BootHole and Bootkitty attack paths;** if `shim` is in the boot chain, a stale SBAT level can allow vulnerable GRUB loaders. (`Sbat.c`; `Decision.c` ll. 169–177)
- **PBL's `Decision.c` `SecureBootEnabled`, `SetupMode`, and `db`/`dbx` expectations are the correct defensive reaction to PKfail and BYOVD:** a platform with the wrong PK, in Setup Mode, or with a stale `dbx` cannot be treated as trusted. (`Decision.c` ll. 154–177)
- **PBL's `PlatformState.c` `LoadedImageCount` is a weak but related signal to Binarly's bootkit-hunting approach;** a future improvement could use per-image GUID/name baselines and code-similarity signals, but this is currently a research gap. (`PlatformState.c` ll. 910–939; `PBL-DEBT-LEDGER.md` D-213)
- **PBL's HTTPS verdict fetch (`PblTls.c` / `PblCurl` / `PblHttp`) must handle the EDK2 TLS caveats:** one-way server auth only, `TlsCaCertificate` provisioning, OpenSSL security level 3 rejecting weak keys, wildcard hostname matching, and the need for an RNG device in OVMF. (`PBL-C3-Network-Client.md`)
- **PBL's `Decision.c` S3/MOR/DMA and `SpiProtections.c` checks are the defensive counterparts to S3 resume, DMA, and SPI flash attacks documented by Binarly and Kaspersky.** (`Decision.c` ll. 244–255; `SpiProtections.c` ll. 27–85)
- **PBL's policy/verdict update channel must be able to push new mitigations quickly** because new bootkit techniques, `dbx` revocations, and SBAT levels appear faster than OEM firmware updates. (`PBL-C4-Policy-Blob.md` §7)

## Known implementation pitfalls

1. **`-fno-lto` and `ForceReloc.c` are necessary but toolchain-specific.** The same trick may not be needed or may behave differently with CLANGDWARF, VS2019, or future EDK2 `GenFw` changes; each target must be verified on real firmware. (`firmware/PblPkg/PblPkg.dsc`)
2. **EDK2 `GenFw` can emit corrupt PE/COFF relocations with LLD/GOTPCRELX,** causing the image to crash at load time. PBL should avoid mixing LTO and LLD on x64 until the toolchain is verified. (`tianocore/edk2#6346`)
3. **An EFI binary without `.reloc` may load in QEMU but be rejected by real HP/Insyde/AMI BIOS;** build verification must check the PE/COFF `RELOCS_STRIPPED` flag and the presence of a `.reloc` section.
4. **UEFI HTTPS boot only does one-way server authentication;** the verdict server cannot authenticate the UEFI client via TLS, and the client cannot use client certificates.
5. **EDK2 TLS defaults to OpenSSL security level 3,** which can reject certificates that work in browsers and general-purpose OSes; PBL's pinned CA and server cert must meet this level or the policy must configure a lower level.
6. **EDK2 hostname verification historically did not support wildcards by default;** PBL's verdict server certificate should avoid wildcards or the client must set the correct TLS flag.
7. **BDS boot-device discovery is not deterministic;** network or block devices may not be connected when PBL runs, so PBL should not rely on dynamic `Boot####` variables being complete.
8. **EDK2 `LoadImage` can fail for many reasons** (missing file, invalid PE, signature mismatch, relocation failure, memory allocation, security violation); PBL's error handling in `ChainLoad.c` must distinguish them and not fall back silently to a different path.
9. **EDK2 image verification depends on `db`/`dbx`;** if `dbx` is stale, vulnerable signed binaries (BootHole, BlackLotus) pass verification. PBL must enforce expected `db`/`dbx` baselines in policy.
10. **A `SetupMode` or leaked-`PK` platform can load an attacker-signed PBL.** PBL must verify the full `PK`/`KEK`/`db`/`dbx` state and not rely on a single boolean.

## Cross-references to previously studied sources

- **STUDY-UEFI-SPEC-2.10.md** — Defines `EFI_BOOT_SERVICES`, `LoadImage`, `StartImage`, UEFI variables, and HTTPS boot at the specification level.
- **STUDY-EDK2.md** — Explains `BasePeCoffLib`, `DxeImageVerificationLib`, `GenFw`, and BDS, which are the source of the `.reloc`/LTO and TLS implementation pitfalls.
- **STUDY-TPM-2.0.md** — Documents PCRs, attestation, and `EFI_TCG2_PROTOCOL`; relevant to PBL's tamper-evident measurements and the need to protect attestation keys from bootkits.
- **STUDY-INTEL-PLATFORM-SECURITY.md** — Covers Boot Guard, BIOS Guard, SPI, and SMM; the attack blogs and EDK2 pitfall notes repeatedly show how these protections are bypassed or misconfigured.
- **STUDY-WINDOWS-NT-INTERNALS.md** — Describes the Windows boot chain that BlackLotus, MoonBounce, and CosmicStrand hook.
- **STUDY-UEFI-BOOTKITS.md** — Provides the case-study context for LoJax, MoonBounce, CosmicStrand, BlackLotus, and Bootkitty.
- **STUDY-ACADEMIC-FIRMWARE-SECURITY.md** — Systematizes the SoK/Peacock/UEFI Memory Forensics research that the Binarly blogs operationalize.
- **STUDY-FIRMWARE-SECURITY-TALKS.md** — Collects conference presentations that first described many of the same EDK2/SMM/S3/Option ROM attack paths and mitigations.

## Outstanding questions

1. Does PBL's build on CLANGDWARF or VS2019 need a different `.reloc`/LTO mitigation than the current GCC `-fno-lto` + `ForceReloc.c`?
2. How can PBL verify that its produced `PblApp.efi` has a correct `.reloc` section and is not `RELOCS_STRIPPED` before signing?
3. What is the right way to provision and pin the `TlsCaCertificate` for PBL's verdict server on real hardware?
4. How should PBL handle EDK2 TLS security level 3 with existing or customer-managed PKI?
5. Can PBL safely detect and report the loaded UEFI image GUIDs/names, not just a count, to enable code-similarity-based detection?
6. How should PBL's policy respond to a device affected by PKfail or a leaked Intel Boot Guard key?
7. How can PBL detect or mitigate a LogoFAIL-style image-parser exploit that runs before PBL is loaded?
8. What is the expected behavior when BDS has not yet connected the network or block device PBL needs for verdict fetch or chain-load?
9. How can PBL keep its `dbx`/SBAT/`bootmgr_hash` expectations current without requiring a firmware reflash?
10. What build and runtime tests are needed to ensure PBL works on HP/Insyde, AMI, and OVMF with both GCC and CLANGDWARF toolchains?

## Self-test (research blogs and EDK II pitfalls)

1. **What is the core idea behind Binarly's UEFI bootkit hunting research?**
   - Answer: Detect UEFI bootkits by analyzing unique code behaviors and code similarity (hook chains, persistence mechanisms) using YARA/FwHunt rules, rather than relying only on signatures. Confidence: high (`binarly.io/blog/uefi-bootkit-hunting`).

2. **What is LogoFAIL and why is it significant?**
   - Answer: A set of UEFI image-parser vulnerabilities in BMP/JPEG/PNG/PCX/TGA logo handling; it can achieve arbitrary code execution before the OS loader and is not stopped by Secure Boot or Boot Guard. Confidence: high (`binarly.io/advisories/brly-2023-006`).

3. **What is PKfail and what is its impact on Secure Boot?**
   - Answer: A supply-chain failure where hundreds of devices use a leaked or test AMI Platform Key as the Secure Boot root of trust, allowing an attacker who controls the private key to modify `db`/`dbx` and bypass Secure Boot. Confidence: high (`binarly.io/blog/pkfail`; `github.com/binarly-io/Vulnerability-REsearch/PKfail`).

4. **Why does PBL use `-fno-lto` and `ForceReloc.c`?**
   - Answer: Because EDK2's `GenFw` only creates a `.reloc` section when the ELF has absolute (`R_X86_64_64`) relocations; LTO and `-fPIC` produce only PC-relative relocations, and some real BIOSes (HP Insyde F.39) reject a `.reloc`-less EFI binary. `ForceReloc.c` forces an absolute function-pointer table to ensure `.reloc` is generated. Confidence: high (`firmware/PblPkg/PblPkg.dsc`; `firmware/PblPkg/PblApp/ForceReloc.c`).

5. **What is a known EDK II `GenFw` pitfall with LLD and `GOTPCREL`?**
   - Answer: The linker may relax a `GOTPCREL` reference to a direct RIP-relative `leaq`, leaving a stale relocation that `GenFw` converts to a PE/COFF relocation pointing into code, corrupting the image at load time. Confidence: high (`tianocore/edk2#6346`).

6. **What is the EDK II UEFI HTTPS boot authentication model?**
   - Answer: One-way server authentication only, with the server CA certificate provisioned in the `TlsCaCertificate` UEFI variable in `EFI_SIGNATURE_LIST` format. Confidence: high (`www.tianocore.org/tianocore-wiki.github.io/platforms-packages/component-guides/https_boot.html`).

7. **What EDK II TLS/OpenSSL issue caused HTTPS boot to fail with "EE certificate key too weak"?**
   - Answer: EDK II defaulted to OpenSSL security level 3, which rejects certificates that are accepted by browsers and Linux; the workaround is to lower the security level to 2. Confidence: high (`tianocore/edk2#12651`).

8. **Why can BDS boot-device discovery fail in OVMF or on real hardware?**
   - Answer: Asynchronous driver initialization, missing `EfiBootManagerConnectAll()` calls, or platform-specific device-enumeration ordering can leave network, USB, or block devices unconnected when BDS runs. Confidence: high (`tianocore/edk2#12095`; `gdbplus.substack.com/p/how-edk2-bds-finds-the-uefi-shell`).

9. **What is the PE/COFF loader's behavior when `EFI_IMAGE_FILE_RELOCS_STRIPPED` is set?**
   - Answer: `BasePeCoffLib` marks the image as not relocatable and will not load it at a base different from its preferred address. Confidence: high (`MdePkg/Library/BasePeCoffLib/BasePeCoff.c`).

10. **Which PBL policy field is the direct countermeasure to the boot-manager replacement attacks described in Binarly's BlackLotus/Bootkitty research?**
    - Answer: `bootmgr_hash` (C4 key 58), enforced by `ChainLoad.c` before `LoadImage`. Confidence: high (`ChainLoad.c` ll. 217–278; `PBL-C4-Policy-Blob.md` §2.6).