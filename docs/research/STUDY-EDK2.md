# EDK II Reference Implementation Study Notes

## Source
- **Title**: EDK II / TianoCore — Open Source UEFI/PI Reference Implementation
- **Author/Organization**: Intel and the TianoCore community
- **Source type**: Source code repository (C, INF, DSC, DEC, FDF) plus a local clone of the TianoCore wiki
- **Version/date**: edk2-stable202408 (checked out at `/home/cllin/.local/src/edk2`); project PBL package at `/home/cllin/remote-lockdown-system/firmware/PblPkg` as of the current session
- **URL/path**:
  - EDK II tree: `/home/cllin/.local/src/edk2` (also https://github.com/tianocore/edk2)
  - TianoCore wiki clone: `/tmp/tianocore-wiki-new`
  - Project PBL package: `/home/cllin/remote-lockdown-system/firmware/PblPkg`
  - Existing UEFI note: `/home/cllin/remote-lockdown-system/docs/research/STUDY-UEFI-SPEC-2.10.md`
- **Sections reviewed**:
  - `edksetup.sh`, `BaseTools/BuildEnv`, `BaseTools/BinWrappers/PosixLike/build`, `BaseTools/Source/Python/build/build.py`
  - `firmware/PblPkg/build-pbl.sh`, `PblPkg.dsc`, `PblPkg.dec`, `PblPkg.fdf`, `PblApp/PblApp.inf`, and PBL source (`PblApp.c`, `PblApp.h`, `PlatformState.c`, `Bcd.c`, `ChainLoad.c`, `Policy.c`, `Decision.c`, `Verdict.c`, `TpmClient.c`, `TpmSession.c`, `CborDecode.c`, `CborEncode.c`, `HttpsClient.c`, `TlsVerify.c`, `LockScreen.c`, `Override.c`, `ForceReloc.c`, `Sbat.c`, `TcgLog.c`)
  - `MdePkg/Include/Uefi/UefiSpec.h`, `UefiBaseType.h`, `UefiLib`, `UefiBootServicesTableLib`, `UefiRuntimeServicesTableLib`, `BasePeCoffLib/BasePeCoff.c`, `UefiDevicePathLib`, `BaseCryptLib`
  - `MdeModulePkg/Core/Dxe/DxeMain/DxeMain.c`, `MdeModulePkg/Core/Dxe/Image/Image.c`, `MdeModulePkg/Universal/BdsDxe/BdsEntry.c`, `MdeModulePkg/Library/UefiBootManagerLib/BmBoot.c` and `BmLoadOption.c`
  - `SecurityPkg/Library/DxeImageVerificationLib/DxeImageVerificationLib.c`
  - `NetworkPkg/NetworkComponents.dsc.inc`, `HttpDxe`, `TlsDxe`, `TcpDxe`
  - `OvmfPkg/OvmfPkgX64.dsc`, `OvmfPkg/Tcg/OvmfTpmDefines.dsc.inc`, `OvmfPkg/PlatformPei`, `OvmfPkg/PlatformDxe`
  - TianoCore wiki pages under `build-tooling/` and `development/design-architecture/pi_boot_flow.md`

## One-paragraph technical overview

EDK II is the open-source reference implementation of the UEFI and Platform Initialization (PI) specifications. It is organized as a collection of packages, each described by a `.dec` (declarations) and optionally a `.dsc` (platform/package build description), containing modules described by `.inf` files. `MdePkg` supplies the UEFI type system, boot/runtime services table libraries, protocol headers, and base libraries such as `BasePeCoffLib`. `MdeModulePkg` contains the DXE core (`DxeMain`) and the boot manager (`BdsDxe`, `UefiBootManagerLib`), which implement image loading (`gBS->LoadImage`), relocation, `StartImage`/`Exit`, and `Boot####`/`BootOrder` processing. `SecurityPkg` provides the `DxeImageVerificationLib` that registers with `EFI_SECURITY2_ARCH_PROTOCOL` to enforce UEFI Secure Boot using the `db` and `dbx` variables. The project PBL package is a standalone UEFI application that is built inside the EDK II workspace by appending the project `firmware/PblPkg` directory to `PACKAGES_PATH` and invoking `build -p PblPkg/PblPkg.dsc`, typically on top of an OVMF firmware image configured with `NETWORK_TLS_ENABLE`, `NETWORK_HTTP_ENABLE`, and `TPM2_ENABLE`.

## 10–20 key technical facts/mechanisms

1. **Environment setup is not the build itself.** `edksetup.sh` must be *sourced* (not executed) because it sets environment variables. It calls `BaseTools/BuildEnv`, which discovers or preserves `WORKSPACE`, `EDK_TOOLS_PATH`, `PACKAGES_PATH`, and `PYTHON_COMMAND`, and adds `BaseTools/BinWrappers/PosixLike` and `/home/cllin/.local/bin` to `PATH` (`edksetup.sh` lines 40–75; `BaseTools/BuildEnv` lines 10–260).

2. **`build` is a Python-backed wrapper.** `BaseTools/BinWrappers/PosixLike/build` exports `PYTHONPATH` and runs `BaseTools/Source/Python/build/build.py` with the supplied `-p <dsc> -a <arch> -t <toolchain> -b <target> -D FLAG=VALUE` options (`BaseTools/BinWrappers/PosixLike/build` lines 1–14).

3. **`PACKAGES_PATH` controls package resolution.** A colon-separated list of directories in which EDK II looks for package names. `build-pbl.sh` sets `WORKSPACE="${EDK2_DIR}"` and `PACKAGES_PATH="${EDK2_DIR}:${FIRMWARE_DIR}"` so `PblPkg/PblPkg.dsc` resolves from the project `firmware/PblPkg` while using EDK II as the workspace (`build-pbl.sh` lines 60–62).

4. **Core file types:**
   - `.dsc` — platform/package build description (packages, library classes, PCDs, components, build options).
   - `.dec` — package declarations (GUIDs, PCD token spaces, version).
   - `.inf` — module metadata (sources, module type, library classes, protocols, PCDs).
   - `.fdf` — flash/firmware-volume description. PBL uses a minimal `.fdf` because it is an ESP application, not a flash image (`PblPkg.dsc`, `PblPkg.dec`, `PblPkg.fdf`, `PblApp/PblApp.inf`).

5. **PBL is a `UEFI_APPLICATION`.** `PblApp.inf` declares `MODULE_TYPE = UEFI_APPLICATION` and `ENTRY_POINT = PblAppEntryPoint` (`PblApp.inf` lines 17, 19). This means it runs in the `EFI_BOOT_SERVICES` environment, does not install architectural protocols, and cannot return to BDS to continue the same boot attempt (it must explicitly `LoadImage`/`StartImage` the next OS loader).

6. **Global service pointers come from table libraries.** `UefiBootServicesTableLib` caches `gImageHandle`, `gST`, and `gBS`; `UefiRuntimeServicesTableLib` caches `gRT` in their constructors (`MdePkg/Library/UefiBootServicesTableLib/UefiBootServicesTableLib.c` lines 15–58; `UefiRuntimeServicesTableLib/UefiRuntimeServicesTableLib.c` lines 15–43).

7. **DXE core constructs the service tables at `DxeMain`.** `DxeMain` copies `mEfiSystemTableTemplate`, `mBootServices`, and `mEfiRuntimeServicesTableTemplate` into pool pages and publishes the real `gST`, `gBS`, and `gRT` handles (`MdeModulePkg/Core/Dxe/DxeMain/DxeMain.c` lines 100–202).

8. **Image services are in `MdeModulePkg/Core/Dxe/Image/Image.c`.** `CoreLoadImage`/`CoreLoadImageCommon`, `CoreLoadPeImage`, `CoreStartImage`, `CoreExit`, and `CoreUnloadImage` implement the UEFI image lifecycle (`Image.c` lines 1544, 1605, 1833, 1922; `CoreLoadPeImage` lines 579–899).

9. **Secure Boot verification is invoked from `CoreLoadImageCommon` before `CoreLoadPeImage`.** If `gSecurity2` is installed, `FileAuthentication(...)` is called with the file buffer and device path; if `gSecurity` is installed, it is used for firmware-volume images. Failure can return `EFI_SECURITY_VIOLATION` or `EFI_ACCESS_DENIED` (`Image.c` lines 1275–1310).

10. **The PE/COFF loader (`BasePeCoffLib`) loads and relocates images.** `PeCoffLoaderLoadImage` copies headers and sections; `PeCoffLoaderRelocateImage` applies the base relocation table (data directory 5) using the difference between `ImageBase` and the allocated address. It validates bounds and checks `RelocationsStripped` (`BasePeCoffLib/BasePeCoff.c` lines 957–1210, 1248–1420).

11. **Memory type is chosen from the PE subsystem.** In `Image.c`, `GetDxeImageMeMemType` maps `EFI_IMAGE_SUBSYSTEM_EFI_APPLICATION` to `EfiLoaderCode`/`EfiLoaderData`, boot-service drivers to `EfiBootServicesCode`/`EfiBootServicesData`, and runtime drivers to the runtime types (`Image.c` lines 625–641).

12. **The certificate table is PE data directory 4.** `DxeImageVerificationLib` reads the `WIN_CERTIFICATE` list at the `EFI_IMAGE_DIRECTORY_ENTRY_SECURITY` data directory, supports `WIN_CERT_TYPE_PKCS_SIGNED_DATA` and `WIN_CERT_TYPE_EFI_GUID` forms, hashes the image excluding the certificate table, and checks `db`/`dbx` (`SecurityPkg/Library/DxeImageVerificationLib/DxeImageVerificationLib.c` lines 1659–2078; `MdePkg/Include/IndustryStandard/PeImage.h` lines 123–126).

13. **`DxeImageVerificationLib` registers with Security2.** Its constructor calls `RegisterSecurity2Handler(DxeImageVerificationHandler, ...)` so the DXE image loader invokes it for every loaded image (`DxeImageVerificationLib.c` lines 2467–2472).

14. **BDS runs after DXE driver dispatch.** `BdsDxe` installs `gEfiBdsArchProtocolGuid` and `BdsEntry()` initializes consoles, processes `Driver`/`SysPrep` options, then processes `BootNext` and iterates `BootOrder`, calling `EfiBootManagerBoot()` for each active `Boot####` (`BdsEntry.c` lines 679–1118).

15. **Boot manager library parses and executes `Boot####` options.** `EfiBootManagerVariableToLoadOption`/`EfiBootManagerVariableToLoadOptionEx` parse the standard variable layout (attributes, file-path-list length, description, device path, optional data), and `EfiBootManagerBoot` in `BmBoot.c` connects the device path, calls `gBS->LoadImage` with `BootPolicy=TRUE`, sets `LoadOptions`, and calls `gBS->StartImage` (`BmLoadOption.c` lines 920–1034; `BmBoot.c` lines 1937–2213).

16. **PBL uses the BDS/LoadImage/StartImage model for chain-loading.** `ChainLoad.c` finds `\EFI\Microsoft\Boot\bootmgfw.efi`, reads it into a buffer, optionally hashes it against the policy, and then calls `gBS->LoadImage` and `gBS->StartImage` to transfer control to the Windows boot manager (`ChainLoad.c` lines 17–312).

17. **PBL depends on network and TPM protocols produced by the *platform* firmware.** Mere declaration of protocol GUIDs in `PblApp.inf` is not enough; the corresponding DXE drivers (e.g. `Tcg2Dxe`, `HttpDxe`, `TlsDxe`, `TcpDxe`, `SnpDxe`, `MnpDxe`) must be included in the platform DSC and dispatched. PBL's OVMF build enables them with `NETWORK_HTTP_ENABLE`, `NETWORK_TLS_ENABLE`, `TPM2_ENABLE`, etc. (`NetworkPkg/NetworkComponents.dsc.inc` lines 19–62; `build-pbl.sh` lines 78–85).

18. **PBL forces `.reloc` generation for firmware compatibility.** `PblPkg.dsc` disables LTO with a GCC `-fno-lto` build option, and `ForceReloc.c` creates a non-inlineable global function-pointer table that keeps `R_X86_64_64` relocations, addressing an HP Insyde BIOS that rejects images without a `.reloc` section (`PblPkg.dsc` lines 27–34; `ForceReloc.c` lines 1–30).

19. **PBL uses `EFI_TCG2_PROTOCOL` for raw TPM2 commands.** The protocol's `SubmitCommand` member passes command buffers directly to the TPM. `MdePkg/Include/Protocol/Tcg2Protocol.h` defines the interface (lines 280–306). PBL also consumes `EFI_HTTP_PROTOCOL`, `EFI_TLS_PROTOCOL`, `EFI_SIMPLE_FILE_SYSTEM_PROTOCOL`, `EFI_LOADED_IMAGE_PROTOCOL`, and others (`PblApp.inf` lines 72–112).

20. **OVMF X64 platform build is the project's reference target.** `OvmfPkg/OvmfPkgX64.dsc` includes `OvmfPkg/Tcg/OvmfTpmDefines.dsc.inc`, `OvmfPkg/Include/Dsc/NetworkDefines.dsc.inc`, and `NetworkPkg/NetworkComponents.dsc.inc`; it lists `PlatformPei`, `PlatformDxe`, `QemuFlashFvbServicesRuntimeDxe`, and `Tcg/TdTcg2Dxe` when `TPM2_ENABLE` is true (`OvmfPkgX64.dsc` lines 17–1198; `OvmfTpmDefines.dsc.inc` lines 1–8).

## Glossary terms

- **.dsc** — EDK II platform or package build description. Declares packages to include, library-class mappings, PCDs, build options, and the list of module components to compile.
- **.dec** — Package declarations file. Publishes a package GUID, version, and the GUID/PCD token-space names that modules in other packages may reference.
- **.inf** — Module information file. Describes one module: source files, module type, entry point, packages consumed, library classes, protocols, and PCDs.
- **.fdf** — Flash description file. Describes firmware volumes, flash regions, and how binary images are laid out in flash. PBL's `.fdf` is minimal because PBL is an ESP application.
- **PCD** — Platform Configuration Database. A compile- or run-time key/value store used to parameterize modules; PBL uses fixed-at-build PCDs for version, timeout, and buffer size values.
- **DXE** — Driver Execution Environment. The phase after PEI in which DXE drivers are dispatched, boot/runtime services are initialized, and BDS is eventually called.
- **BDS** — Boot Device Selection. The UEFI phase in which boot policy is applied, `BootOrder`/`Boot####` are parsed, and OS loaders are launched.
- **`UefiBootManagerLib`** — `MdeModulePkg` library used by BDS to read `Boot####`, validate load options, and call `LoadImage`/`StartImage`.
- **`Boot####` / `BootOrder`** — UEFI variable namespace for boot options. `BootOrder` is a list of 16-bit option numbers; each `Boot####` variable stores attributes, file path, description, and optional data.
- **`gSecurity2` / `EFI_SECURITY2_ARCH_PROTOCOL`** — Architectural protocol installed by a security driver. `LoadImage` calls its `FileAuthentication` member before loading any image, enabling Secure Boot and measured boot.
- **`EFI_IMAGE_EXECUTION_INFO_TABLE`** — Configuration table installed by `DxeImageVerificationLib` that records images that were not started or were deferred due to security policy.
- **PE/COFF data directories** — A fixed array of 16 entries in the optional header. Index 4 is the certificate/security table; index 5 is the base relocation table (`EFI_IMAGE_DIRECTORY_ENTRY_SECURITY`, `EFI_IMAGE_DIRECTORY_ENTRY_BASERELOC`).
- **`.reloc`** — The base relocation section. Used to fix up absolute addresses when the image is loaded at an address different from its preferred `ImageBase`.
- **OVMF** — Open Virtual Machine Firmware. An EDK II platform package that produces a QEMU/KVM-compatible UEFI firmware image.
- **PBL** — Pre-Boot Lock. The project's UEFI application built as an EDK II package; it evaluates platform state and policy and either chain-loads Windows or shows a lock screen.

## Security implications

- **Secure Boot is enforced in `LoadImage`, not `StartImage`.** `CoreLoadImageCommon` invokes the registered `FileAuthentication` handler before the PE/COFF image is fully loaded. A failure means `LoadImage` may still return a handle if the policy is `DEFER_EXECUTE`, but `StartImage` will not run the image or the image is added to the `EFI_IMAGE_EXECUTION_INFO_TABLE` (`Image.c` lines 1275–1310; `DxeImageVerificationLib.c` lines 1659–2078).
- **`DxeImageVerificationLib` is the current EDK II reference verifier.** It checks the PE/COFF certificate table, hashes the image excluding the certificate region, validates against `dbx` (denylist) and `db` (allowlist), and supports `WIN_CERT_TYPE_PKCS_SIGNED_DATA` and `WIN_CERT_TYPE_EFI_GUID` certificate types. It is installed by `RegisterSecurity2Handler` in the library constructor (`DxeImageVerificationLib.c` lines 2467–2472).
- **PBL must be trusted by the platform's Secure Boot policy.** `PblApp.efi` is loaded from the ESP as a `Boot####` target. It must therefore be signed by a key in `db` and not present in `dbx`, or the platform must be in Setup Mode / Custom Mode. The project's `CODE-SIGNING-GUIDE.md` describes self-signed, OEM, and Microsoft UEFI signing routes.
- **PBL's own policy/verdict signatures are application-level, not UEFI Secure Boot.** `Policy.c`, `Verdict.c`, and `CoseVerify.c` verify COSE_Sign1 objects against a project root of trust; this is separate from the Authenticode/PKCS#7 verification performed by the firmware when `PblApp.efi` is loaded.
- **PBL's PCR extensions are application-initiated.** The code extends PCR 12 with the decision and PCR 13 with the platform-state digest. These survive only if the TPM is available and the `EFI_TCG2_PROTOCOL` is installed. The PCR values are not firmware-enforced; the Windows Boot Manager / BitLocker seal is what provides the actual fail-closed property.
- **PBL's lock screen is best-effort.** It uses `EFI_SIMPLE_TEXT_OUTPUT_PROTOCOL` to display a message and waits for input. A hostile firmware or another DXE driver could suppress or ignore the lock screen, so the real enforcement must come from not starting `bootmgfw.efi` and from PCR-sealed BitLocker.
- **Network TLS depends on platform configuration.** `EFI_TLS_PROTOCOL` and `EFI_HTTP_PROTOCOL` are produced by `TlsDxe` and `HttpDxe`. PBL's OVMF build enables them, but real hardware must include equivalent platform DXE drivers and a trustworthy TLS certificate store/pinning policy.

## PBL-specific relevance

- **PBL builds as a separate package inside EDK II.** `build-pbl.sh` sets `WORKSPACE` to the EDK II tree and appends `firmware/PblPkg` via `PACKAGES_PATH`, then runs `build -p PblPkg/PblPkg.dsc -a X64 -t GCC -b RELEASE` (or the configured toolchain; defaults to `GCC`, not `GCC5`, since `GCC5` was deprecated in edk2-stable202408), producing `firmware/PblPkg/PblApp.efi` (`build-pbl.sh` lines 60–62, 92–100).

- **PBL's package dependencies.** `PblPkg.dsc` includes `MdePkg`, `MdeModulePkg`, `NetworkPkg`, `SecurityPkg`, `CryptoPkg`, and `PblPkg`. It maps library classes such as `BaseLib`, `BaseMemoryLib`, `UefiLib`, `UefiBootServicesTableLib`, `UefiRuntimeServicesTableLib`, `DevicePathLib`, `BaseCryptLib`, `RngLib`, and `TimerLib` (`PblPkg.dsc` lines 35–65).

- **PBL module metadata.** `PblApp.inf` lists all source files, protocols, and GUIDs consumed. The module type is `UEFI_APPLICATION`, UEFI spec version is 2.7, and `PblAppEntryPoint` is the entry point (`PblApp.inf` lines 15–19; `PblApp/PblApp.c` lines 149–152).

- **High-level PBL flow (from `PblApp.c`).**
  1. `PblAppEntryPoint` initializes and calls `CollectPlatformState`.
  2. `ParseAndVerifyPolicy` reads `\EFI\PBL\policy.cose` and verifies its COSE signature.
  3. `ReadCachedLockState` reads TPM NV state.
  4. `FetchVerdict` or `UseCachedVerdict` obtains a signed verdict.
  5. `VerifyVerdict` validates the verdict signature.
  6. `EvaluateDecision` computes `PASS`, `DEGRADED`, or `BLOCK`.
  7. PCR 13 is extended with the platform-state digest, PCR 12 with the decision.
  8. On `PASS`/`DEGRADED` the app calls `ChainLoadBootManager`; on `BLOCK` it calls `ShowLockScreen` (`PblApp.c` lines 155–360; `PblApp.h` lines 88–89).

- **Platform-state collection.** `PlatformState.c` reads Secure Boot variables, `db`/`dbx`, `PK`/`KEK`, SMBIOS, ACPI tables, TPM PCR values, `Boot####`/`BootOrder`, and the BCD hive, then hashes selected fields into a `PBL_PLATFORM_STATE` structure (`PlatformState.c`; `PblApp.h` lines 35–90).

- **BCD parsing.** `Bcd.c` is a bounded, custom Windows Boot Configuration Data registry-hive parser for `\EFI\Microsoft\Boot\BCD`. It is not an EDK II service but a project-specific parser.

- **Policy/verdict/COSE.** `Policy.c` parses the binary policy; `Verdict.c` parses the signed verdict; `CoseVerify.c` and `CborDecode.c`/`CborEncode.c` handle COSE_Sign1 and CBOR. `PolicyRootOfTrust.c` holds the embedded public key for policy signing.

- **TPM interaction.** `TpmClient.c` and `TpmSession.c` use `EFI_TCG2_PROTOCOL->SubmitCommand` to send raw TPM2 command buffers. `TcgLog.c` reads the TCG event log. PCRs 12 and 13 are extended by `PblApp.c` after the decision.

- **Chain-loading.** `ChainLoad.c` locates the Windows boot manager, optionally verifies its hash (`Policy->BootMgrHash`), and uses `gBS->LoadImage` and `gBS->StartImage`. If it is configured to replace `bootmgfw.efi`, it also handles the backup/restore marker.

- **TLS and HTTP.** `HttpsClient.c` uses `EFI_HTTP_PROTOCOL` and `EFI_HTTP_SERVICE_BINDING_PROTOCOL` to fetch verdicts; `TlsVerify.c` performs certificate pinning by comparing a SHA-256 of the configured CA/leaf certificate.

- **Lock screen / override.** `LockScreen.c` uses `EFI_SIMPLE_TEXT_OUTPUT_PROTOCOL` to display status; `Override.c` supports an offline challenge/response for local override.

- **Deployment path.** The package README states PBL is installed as a UEFI application on the ESP (e.g., `\EFI\PBL\PblApp.efi`) and is invoked by a `Boot####` entry. It is not flashed into a firmware volume (`PblPkg/README.md` lines 1–40).

## Known implementation pitfalls

1. **`edksetup.sh` must be sourced.** If it is executed in a subshell, `WORKSPACE`, `EDK_TOOLS_PATH`, and `PATH` changes are lost (`edksetup.sh` line 10; `BaseTools/BuildEnv` line 3).

2. **Stale `PblPkg` inside the EDK II tree.** `/home/cllin/.local/src/edk2/PblPkg` exists and contains `MarkerTest.c` and `Recovery.c` but is *not* the project's PBL package. Build resolution depends on `PACKAGES_PATH` order. The project build script uses `PACKAGES_PATH="${EDK2_DIR}:${FIRMWARE_DIR}"`, which puts the project `firmware/PblPkg` second. If the build tool resolves packages left-to-right, the EDK2 `PblPkg` could shadow the project package; the script may rely on the fact that the EDK2 tree copy is older/incomplete.

3. **OVMF is only built if `OVMF_CODE.fd` is missing.** `build-pbl.sh` checks `Build/OvmfX64/RELEASE_GCC/FV/OVMF_CODE.fd` and skips the OVMF build if the file exists. Changing OVMF configuration without deleting this file will not update the firmware (`build-pbl.sh` lines 74–88).

4. **LTO can strip `.reloc`.** PBL addresses this with `-fno-lto` in `PblPkg.dsc` and with `ForceReloc.c`. Without these, some Insyde/HP firmware rejects the binary. (`PblPkg.dsc` lines 27–34; `ForceReloc.c` lines 1–30).

5. **`LoadImage` returns a handle even on `EFI_SECURITY_VIOLATION`.** The caller must check the return status and not blindly call `StartImage`. BDS logs the status and tries the next `Boot####` if the current one fails (`Image.c` lines 1275–1310; `BmBoot.c` lines 2069–2079).

6. **`BootNext` is consumed before execution.** `BdsEntry` deletes the `BootNext` variable, so a PBL test that relies on `BootNext` must recreate it each boot (`BdsEntry.c` lines 1073–1118).

7. **Network protocols must be connected.** PBL calls `gBS->ConnectController` on all handles before locating `EFI_HTTP_SERVICE_BINDING_PROTOCOL` so the network stack is instantiated. On real hardware this depends on the platform including and dispatching the relevant SNP/MNP/TCP/IP/HTTP/TLS DXE drivers (`HttpsClient.c` lines 171–198).

8. **OVMF defaults do not include network or TPM.** `OvmfPkgX64.dsc` disables `TPM2_ENABLE` and some network features by default. PBL's build overrides them with `-D` flags. Forgetting the overrides produces an OVMF image without HTTP/TLS/TPM2 support (`OvmfPkgX64.dsc` lines 50–55; `OvmfTpmDefines.dsc.inc` lines 1–8).

9. **PBL source comments are ahead of some documentation.** `PblApp.c` contains a detailed implemented flow, while `PblPkg/README.md` still describes the package as a scaffold. The final artifact should be derived from the source, not from the README.

10. **UEFI variable writes require `EFI_VARIABLE_NON_VOLATILE` and `EFI_VARIABLE_BOOTSERVICE_ACCESS`.** PBL uses `gRT->SetVariable` for cached state. Writing without the correct attributes or with mismatched attributes will fail with `EFI_INVALID_PARAMETER` or `EFI_SECURITY_VIOLATION` if the variable is protected by authenticated variables.

## Cross-references to previously studied sources

- `STUDY-UEFI-SPEC-2.10.md`: UEFI boot services, runtime services, `LoadImage`/`StartImage`/`Exit`, `Boot####`/`BootOrder` layout, device paths, UEFI variables, memory map, `GetMemoryMap`/`ExitBootServices` key handling, and the Secure Boot `db`/`dbx` variable model. EDK II implements the behavior described there.
- TianoCore wiki (`build-tooling/build-workflows/build.md`): explains the `build` command, `WORKSPACE`, `PACKAGES_PATH`, and `edksetup.sh` workflow. This matches the local `build-pbl.sh` and EDK II `BaseTools/BuildEnv` behavior.
- TianoCore wiki (`development/design-architecture/pi_boot_flow.md`): describes the SEC → PEI → DXE → BDS → TSL → RT → AL phase model. EDK II `MdeModulePkg` is the reference implementation of DXE and BDS.
- `firmware/PblPkg/CODE-SIGNING-GUIDE.md`: production deployment requires UEFI Secure Boot signing; the certificate must be in the platform `db`.
- `PBL-DEBT-LEDGER.md` and `GRAPH-SPEC.md`: tracks open items D-100 through D-130. Many are implemented in the current PBL source, but some (e.g., D-116 TLS pinning, D-120 BitLocker detection, D-129 hardware validation) still need verification.

## Outstanding questions

1. What is the exact package search order in EDK II's `build` tool when `PACKAGES_PATH` contains two directories with a `PblPkg`? Does the rightmost or leftmost entry win, or is the workspace always searched first? This matters for the coexistence of `/home/cllin/.local/src/edk2/PblPkg` and `/home/cllin/remote-lockdown-system/firmware/PblPkg`.
2. Which OVMF DXE component produces `EFI_TCG2_PROTOCOL` when `TPM2_ENABLE` is true — `SecurityPkg/Tcg/Tcg2Dxe/Tcg2Dxe.inf` or `OvmfPkg/Tcg/TdTcg2Dxe/TdTcg2Dxe.inf`? The OVMF DSC shows `TdTcg2Dxe`, but the project PBL source talks to a generic `EFI_TCG2_PROTOCOL`.
3. Where in EDK II is the `EFI_IMAGE_EXECUTION_INFO_TABLE` installed as a UEFI configuration table? `DxeImageVerificationLib` collects entries and installs the table at `ReadyToBoot`, but the exact `InstallConfigurationTable` call was not found in the reviewed files.
4. How does `DxeImageVerificationLib` classify the source of an image as FV, removable media, or fixed media? `GetImageType` is referenced in policy but its implementation was outside the reviewed portions. This matters for PBL loaded from the ESP.
5. Does the PBL build produce a proper PE/COFF certificate table when not self-signed, or is it unsigned by default and expected to be signed post-build with `sign-efi.sh`? The build script copies `PblApp.efi` directly after `build`; no post-build signing step is visible in the build script itself.

## Self-test (EDK II) — 5-10 questions with answers and confidence

1. **Q:** What script must be *sourced* before running `build`, and what does it set?  
   **A:** `edksetup.sh` (or `edksetup.bat` on Windows). It sets `WORKSPACE`, `EDK_TOOLS_PATH`, `CONF_PATH`, `PYTHON_COMMAND`, and updates `PATH` to include `BaseTools/BinWrappers/PosixLike` and related tools.  
   **Confidence:** High.

2. **Q:** Which EDK II file types describe the package, the platform build, and an individual module?  
   **A:** `.dec` for package declarations, `.dsc` for platform/package build description, `.inf` for a module, and `.fdf` for flash layout.  
   **Confidence:** High.

3. **Q:** How does the project build PBL inside the EDK II tree?  
   **A:** By setting `WORKSPACE` to the EDK II directory and `PACKAGES_PATH` to `EDK2_DIR:FIRMWARE_DIR`, then running `build -p PblPkg/PblPkg.dsc`.  
   **Confidence:** High.

4. **Q:** Which global pointers cache the boot and runtime services tables in an EDK II UEFI application?  
   **A:** `gST` (system table), `gBS` (boot services), `gRT` (runtime services), and `gImageHandle`. They are initialized by `UefiBootServicesTableLib` and `UefiRuntimeServicesTableLib`.  
   **Confidence:** High.

5. **Q:** In which data directory of a PE/COFF image are the certificate table and the base relocation table found?  
   **A:** Certificate table is data directory 4 (`EFI_IMAGE_DIRECTORY_ENTRY_SECURITY`); base relocation is data directory 5 (`EFI_IMAGE_DIRECTORY_ENTRY_BASERELOC`).  
   **Confidence:** High.

6. **Q:** When is UEFI Secure Boot verification invoked during image loading in EDK II?  
   **A:** `CoreLoadImageCommon` calls the registered `EFI_SECURITY2_ARCH_PROTOCOL.FileAuthentication` handler (and `EFI_SECURITY_ARCH_PROTOCOL.FileAuthenticationState` for FV images) *before* the PE/COFF image is loaded.  
   **Confidence:** High.

7. **Q:** Which EDK II library registers the Secure Boot image verification handler?  
   **A:** `SecurityPkg/Library/DxeImageVerificationLib/DxeImageVerificationLib.c`; its constructor calls `RegisterSecurity2Handler(DxeImageVerificationHandler, ...)`.  
   **Confidence:** High.

8. **Q:** What is the call sequence from BDS to running a `Boot####` option?  
   **A:** `BdsEntry()` in `BdsDxe` obtains the load options, `BootBootOptions()` iterates, `EfiBootManagerBoot()` in `BmBoot.c` resolves the device path, calls `gBS->LoadImage`, sets `LoadOptions`, and then calls `gBS->StartImage`.  
   **Confidence:** High.

9. **Q:** What does PBL do to guarantee a `.reloc` section for HP/Insyde BIOS compatibility?  
   **A:** `PblPkg.dsc` adds `-fno-lto` for GCC release builds, and `ForceReloc.c` creates a global function pointer table that the compiler and linker cannot optimize away, forcing `R_X86_64_64` relocations.  
   **Confidence:** High.

10. **Q:** Which UEFI protocol does PBL use to submit raw TPM2 commands?  
    **A:** `EFI_TCG2_PROTOCOL`, in particular its `SubmitCommand` member, defined in `MdePkg/Include/Protocol/Tcg2Protocol.h`.  
    **Confidence:** High.
