# UEFI 2.10 Specification Study Notes

## Source

- **Title:** UEFI Specification Version 2.10
- **Author/Organization:** UEFI Forum, Inc.
- **Source type:** Official specification reStructuredText source
- **Version/date:** Release 2.10, Aug 29, 2022
- **URL/path:** https://github.com/UEFI/UEFI-Specification-Release (cloned to `/tmp/uefi-spec-release`)
- **PI supplement source:** TianoCore / EDK II community wiki, `PI-Boot-Flow` and `UEFI & PI FAQ` (cloned to `/tmp/tianocore-wiki` and `/tmp/tianocore-wiki-new`). The official PI Specification PDFs at uefi.org are behind Cloudflare and could not be retrieved in this environment.
- **Sections reviewed:**
  - `01_Introduction.rst` — purpose, scope, organization
  - `02_Overview.rst` — boot manager, UEFI images, calling conventions, x64 environment, ExitBootServices
  - `04_EFI_System_Table.rst` — EFI_SYSTEM_TABLE, EFI_BOOT_SERVICES, EFI_RUNTIME_SERVICES, configuration tables
  - `07_Services_Boot_Services.rst` — events, memory allocation, protocol services, image services, ExitBootServices
  - `08_Services_Runtime_Services.rst` — variable services, reset, capsules
  - `09_Protocols_EFI_Loaded_Image.rst` — EFI_LOADED_IMAGE_PROTOCOL, EFI_LOADED_IMAGE_DEVICE_PATH_PROTOCOL
  - `10_Protocols_Device_Path_Protocol.rst` — device path nodes, media and file path nodes
  - `13_Protocols_Media_Access.rst` — Simple File System, File I/O, Block I/O, Disk I/O, Load File
  - `32_Secure_Boot_and_Driver_Signing.rst` — Secure Boot, signature databases, image validation
  - `Apx_D_Status_Codes.rst` — common EFI_STATUS codes
  - Supplementary: `03_Boot_Manager.rst` for `Boot####`, `EFI_LOAD_OPTION`, `LoadOptions`, and Secure Boot variable semantics

## One-paragraph technical overview

UEFI 2.10 defines the firmware-to-OS interface that is visible to a UEFI application or OS loader. It is not a firmware implementation spec: it standardizes the data tables (the EFI System Table, the EFI Boot Services Table, and the EFI Runtime Services Table), the PE32+ image format used for all UEFI executables, the device-path namespace, and the protocol-based services for memory, events, protocol discovery, image loading, file access, and variables. A UEFI image receives an `EFI_HANDLE` and a pointer to the `EFI_SYSTEM_TABLE` at its entry point. While running before `ExitBootServices()`, it can allocate memory, open protocols, read files, load additional images, and read or write UEFI variables. When an OS loader is ready to take control, it calls `ExitBootServices()` with the current memory-map key; from that point only Runtime Services remain available, and the OS owns every descriptor in the UEFI memory map not marked as runtime or reserved.

## 10-20 key technical facts/mechanisms

1. **UEFI images are PE32+ with a UEFI-specific signature.** The `Machine` and `Subsystem` fields in the PE/COFF header identify image type. `EFI_IMAGE_SUBSYSTEM_EFI_APPLICATION` (10), `_BOOT_SERVICE_DRIVER` (11), and `_RUNTIME_DRIVER` (12) determine the memory type used and the unload behavior. (`02_Overview.rst`, UEFI Images)
2. **Entry point signature is `EFI_IMAGE_ENTRY_POINT(ImageHandle, SystemTable)`**, returning `EFI_STATUS`. All UEFI images receive this interface. (`04_EFI_System_Table.rst`, UEFI Image Entry Point)
3. **`EFI_SYSTEM_TABLE` is the central dispatch structure.** It contains console in/out handles, pointers to `EFI_BOOT_SERVICES` and `EFI_RUNTIME_SERVICES`, firmware vendor/revision, and the `ConfigurationTable` array. After `ExitBootServices()` only the header, firmware identifiers, `RuntimeServices`, `NumberOfTableEntries`, and `ConfigurationTable` remain valid. (`04_EFI_System_Table.rst`, EFI System Table)
4. **`EFI_BOOT_SERVICES` and `EFI_RUNTIME_SERVICES` are separate function tables.** Boot services cover task priority, memory, events, protocols, image loading, and miscellaneous helpers; runtime services cover time, virtual-memory mapping, variables, reset, and capsules. (`04_EFI_System_Table.rst`, EFI Boot Services Table / EFI_RUNTIME_SERVICES)
5. **`ExitBootServices(ImageHandle, MapKey)` is the hand-off boundary.** It requires the latest `MapKey` from `GetMemoryMap()`. On success, boot services terminate, boot service drivers are unloaded, the `BootServices` pointer is cleared, and the OS loader owns all non-runtime memory. (`07_Services_Boot_Services.rst`, ExitBootServices)
6. **Image services are `LoadImage()`, `StartImage()`, `UnloadImage()`, and `Exit()`.** `LoadImage()` creates an image handle and installs `EFI_LOADED_IMAGE_PROTOCOL` plus `EFI_LOADED_IMAGE_DEVICE_PATH_PROTOCOL`; `StartImage()` calls the entry point; `Exit()` returns a status and optional `ExitData` to the caller. (`07_Services_Boot_Services.rst`, Image Services)
7. **`LoadImage()` resolves files by protocol precedence.** If a device path supports `EFI_SIMPLE_FILE_SYSTEM_PROTOCOL`, that is used first. Otherwise `EFI_LOAD_FILE_PROTOCOL` (for boot-policy loads) or `EFI_LOAD_FILE2_PROTOCOL` (for non-boot-policy loads) is tried. (`07_Services_Boot_Services.rst`, LoadImage; `13_Protocols_Media_Access.rst`, Load File Protocol)
8. **`EFI_LOADED_IMAGE_PROTOCOL` exposes the runtime identity of a loaded image.** It contains `ParentHandle`, `DeviceHandle`, `FilePath`, `LoadOptions`/`LoadOptionsSize`, `ImageBase`, `ImageSize`, `ImageCodeType`, `ImageDataType`, and an optional `Unload()` callback. (`09_Protocols_EFI_Loaded_Image.rst`)
9. **`EFI_LOADED_IMAGE_DEVICE_PATH_PROTOCOL` is a copy of the device path used during `LoadImage()`.** It is the same structure as the Device Path Protocol, only with a different GUID, and may be `NULL` for memory-buffer loads. (`09_Protocols_EFI_Loaded_Image.rst`)
10. **Memory is typed with `EFI_MEMORY_TYPE`.** Applications normally use `EfiLoaderData`; boot service drivers use `EfiBootServicesCode/Data`; runtime drivers use `EfiRuntimeServicesCode/Data`. After `ExitBootServices()` the loader may reclaim boot-service memory. (`07_Services_Boot_Services.rst`, AllocatePages / Memory Type Usage)
11. **Protocol access should use `OpenProtocol()` with an `AgentHandle`**, not the older `HandleProtocol()`. `OpenProtocol()` tracks consumers and supports `BY_HANDLE_PROTOCOL`, `GET_PROTOCOL`, `TEST_PROTOCOL`, `BY_DRIVER`, `EXCLUSIVE`, etc., preventing unsafe uninstall/reinstall. (`07_Services_Boot_Services.rst`, OpenProtocol)
12. **Device paths are byte-packed node lists ending with an End node (type `0x7F`, sub-type `0xFF`).** Media Device Path (type `0x04`) includes Hard Drive (4.1), CD-ROM (4.2), Vendor-defined (4.3), File Path (4.4), and Media Protocol (4.5). (`10_Protocols_Device_Path_Protocol.rst`, Media Device Path)
13. **File Path Media Device Path nodes carry a NULL-terminated UCS-2 string** and may be concatenated with a single backslash to form a full file path. (`10_Protocols_Device_Path_Protocol.rst`, File Path Media Device Path)
14. **Simple File System Protocol (`EFI_SIMPLE_FILE_SYSTEM_PROTOCOL`) is the canonical file-system abstraction.** `OpenVolume()` returns an `EFI_FILE_PROTOCOL` for the root directory; `EFI_FILE_PROTOCOL` provides Open/Close/Read/Write/SetPosition/GetInfo/Flush, with path modifiers `\`, `.`, and `..`. (`13_Protocols_Media_Access.rst`, Simple File System Protocol / File Protocol)
15. **Block I/O (`EFI_BLOCK_IO_PROTOCOL`) and Disk I/O (`EFI_DISK_IO_PROTOCOL`) sit below the file system.** Every block device also gets a Disk I/O interface for byte-level access, and the file system is layered on top. (`13_Protocols_Media_Access.rst`, Block I/O Protocol / Disk I/O Protocol)
16. **Variable services persist key/value pairs with attributes.** `GetVariable`, `SetVariable`, `GetNextVariableName`, and `QueryVariableInfo` are the main runtime APIs. Attributes include `NON_VOLATILE`, `BOOTSERVICE_ACCESS`, `RUNTIME_ACCESS`, `APPEND_WRITE`, `TIME_BASED_AUTHENTICATED_WRITE_ACCESS`, and `ENHANCED_AUTHENTICATED_ACCESS`. (`08_Services_Runtime_Services.rst`, Variable Services)
17. **Variables without `RUNTIME_ACCESS` disappear after `ExitBootServices()`**, and at runtime only `NON_VOLATILE | RUNTIME_ACCESS` variables can be written. (`08_Services_Runtime_Services.rst`, SetVariable)
18. **Secure Boot uses the PK, KEK, db, dbx, dbt, and dbr variables under `EFI_IMAGE_SECURITY_DATABASE_GUID`.** The platform is in setup, user, audit, or deployed mode depending on `PK`, `SetupMode`, `AuditMode`, and `DeployedMode`. (`32_Secure_Boot_and_Driver_Signing.rst`, Firmware/OS Key Exchange; `03_Boot_Manager.rst`, Global Variables)
19. **Image validation compares a PE/COFF image against db and dbx.** The image passes if a hash or certificate chain in db matches and no hash/certificate in dbx matches. Forbidden entries can be timestamp-limited using the `dbt` authorized timestamp database. (`32_Secure_Boot_and_Driver_Signing.rst`, UEFI Image Validation)
20. **PE/COFF signatures live in the 5th data directory certificate table as `WIN_CERTIFICATE` structures.** UEFI certificate types include `WIN_CERT_TYPE_EFI_GUID` with `CertType` `EFI_CERT_TYPE_PKCS7_GUID` or `EFI_CERT_TYPE_RSA2048_SHA256_GUID`, and `WIN_CERT_TYPE_PKCS_SIGNED_DATA` (Authenticode). (`32_Secure_Boot_and_Driver_Signing.rst`, Embedded Signatures / Code Definitions)
21. **Common `EFI_STATUS` codes used by the reviewed interfaces include `EFI_SUCCESS`, `EFI_LOAD_ERROR`, `EFI_INVALID_PARAMETER`, `EFI_UNSUPPORTED`, `EFI_BUFFER_TOO_SMALL`, `EFI_NOT_FOUND`, `EFI_ACCESS_DENIED`, `EFI_SECURITY_VIOLATION`, `EFI_OUT_OF_RESOURCES`, `EFI_WRITE_PROTECTED`, `EFI_VOLUME_CORRUPTED`, `EFI_MEDIA_CHANGED`, and `EFI_END_OF_FILE`.** (`Apx_D_Status_Codes.rst`)

## Glossary terms

- **UEFI image:** A PE32+ object with a UEFI-specific signature, an `AddressOfEntryPoint`, and a subsystem value identifying it as an application, boot service driver, or runtime driver.
- **OS loader:** A UEFI application that eventually calls `ExitBootServices()` and takes over platform resource management.
- **EFI System Table (`EFI_SYSTEM_TABLE`):** The root data structure passed to every UEFI image; it links to boot and runtime services, console devices, and configuration tables.
- **EFI Handle (`EFI_HANDLE`):** An opaque object that supports one or more protocols.
- **Protocol:** A GUIDed interface installed on a handle and consumed through `OpenProtocol()` / `HandleProtocol()`.
- **Device Path:** A byte-packed, variable-length list of nodes that describes the location of a device or file; terminated by an End node.
- **Media Device Path:** Device Path type `0x04`, used to identify partitions, CD-ROM volumes, vendor-specific media, file paths, and protocols.
- **File Path Media Device Path:** A Media Device Path node (sub-type `0x04`) containing a NULL-terminated UCS-2 path string.
- **Load Options:** Binary data passed to a loaded image; stored in `EFI_LOADED_IMAGE_PROTOCOL.LoadOptions` and originally sourced from `EFI_LOAD_OPTION.OptionalData`.
- **UEFI Variable:** A name/GUID/attributes/data tuple; may be volatile or non-volatile, and boot-only or runtime-accessible.
- **Signature Database (`db` / `dbx` / `dbt` / `dbr`):** Authenticated UEFI variables listing authorized, forbidden, timestamp, and recovery signatures.
- **Setup / User / Audit / Deployed Mode:** The Secure Boot lifecycle states defined by the presence of `PK` and the values of `SetupMode`, `AuditMode`, and `DeployedMode`.

## Security implications

- **The firmware is the trust anchor for Secure Boot.** It initializes the signature databases (`PK`, `KEK`, `db`, `dbx`, `dbt`, `dbr`) from tamper-resistant non-volatile storage before any UEFI image is started and evaluates every image against those databases. (`32_Secure_Boot_and_Driver_Signing.rst`)
- **Setup mode is a privileged state.** Without an enrolled `PK`, the platform does not require authentication to update the Platform Key, KEK, or signature databases, so any code running before `PK` enrollment can permanently alter the trust policy. (`32_Secure_Boot_and_Driver_Signing.rst`)
- **Image validation is enforced at start time, not just load time.** A loaded image can still be rejected when `StartImage()` runs, and a rejected image is recorded in the `EFI_IMAGE_EXECUTION_INFO_TABLE` for later audit. (`32_Secure_Boot_and_Driver_Signing.rst`)
- **The PE/COFF certificate table is the canonical enforcement surface.** A UEFI application (including PBL) must either have its hash in `db` or be signed by a certificate chain anchored in `db`, and must not be present in `dbx`. If `dbx` contains an `EFI_CERT_X509_SHA*_GUID` or `EFI_CERT_X509_GUID` entry matching the chain, the image is forbidden. (`32_Secure_Boot_and_Driver_Signing.rst`)
- **Signature database updates are authenticated.** In user or deployed mode, `SetVariable()` to `db`/`dbx`/`dbt`/`dbr` requires a signature from a currently enrolled `KEKpriv` or `PKpriv`; the payload is wrapped in `EFI_VARIABLE_AUTHENTICATION_2` (time-based) or `EFI_VARIABLE_AUTHENTICATION_3` (enhanced). (`08_Services_Runtime_Services.rst`, `32_Secure_Boot_and_Driver_Signing.rst`)
- **Audit mode is not a secure runtime state.** It disables enforcement and initializes every image to log all certificates; it is intended only for key discovery and configuration testing. (`32_Secure_Boot_and_Driver_Signing.rst`)
- **Runtime service boundaries matter for post-ExitBootServices security.** After `ExitBootServices()`, only `EFI_RUNTIME_SERVICES` remain, and only variables with `RUNTIME_ACCESS | NON_VOLATILE` can be written. The OS must preserve all `EfiRuntimeServicesCode`/`Data` descriptors, and the runtime services may not be safe for re-entry without the rules in `08_Services_Runtime_Services.rst`, *Rules for Reentry Into Runtime Services*. (`08_Services_Runtime_Services.rst`)

## PBL-specific relevance

- **PBL is a UEFI application (`EFI_IMAGE_SUBSYSTEM_EFI_APPLICATION`).** It is loaded by the UEFI boot manager (or by another UEFI application through `LoadImage()` / `StartImage()`), receives its own `ImageHandle` and `SystemTable`, and is automatically unloaded when its entry point returns or it calls `Exit()`. (`02_Overview.rst`, UEFI Applications; `07_Services_Boot_Services.rst`, Image Services)
- **For chain-loading Windows, PBL must use the same image services as the boot manager.** It calls `LoadImage()` with a device path pointing at `\EFI\Microsoft\Boot\bootmgfw.efi` (or an equivalent path), then `StartImage()`. If `LoadImage()` succeeds and `StartImage()` returns, control returns to PBL and PBL is still the current image. (`07_Services_Boot_Services.rst`, LoadImage / StartImage)
- **Device-path construction for Windows chain-loading is straightforward with Media and File Path nodes.** A full device path will typically contain a hardware path, a Hard Drive Media node (type 4.1) identifying the ESP by `UniquePartitionGuid` or MBR signature and partition number, and one or more File Path Media nodes (type 4.4) containing the UCS-2 path. (`10_Protocols_Device_Path_Protocol.rst`, Media Device Path)
- **`LoadImage()` can resolve short-form and full device paths automatically.** If the file path is on a block device with a supported FAT file system, `EFI_SIMPLE_FILE_SYSTEM_PROTOCOL` is used. If not, `EFI_LOAD_FILE_PROTOCOL` / `EFI_LOAD_FILE2_PROTOCOL` may be used. PBL does not have to reimplement file reading unless it wants explicit control. (`07_Services_Boot_Services.rst`, LoadImage; `13_Protocols_Media_Access.rst`, Load File Protocol)
- **PBL can inspect its own origin through `EFI_LOADED_IMAGE_PROTOCOL`.** It can read `LoadOptions`, `ImageBase`, `ImageSize`, `ImageCodeType`, `ImageDataType`, and the source `FilePath`. These fields are the natural way to anchor a platform-state digest and to verify the next image. (`09_Protocols_EFI_Loaded_Image.rst`)
- **PBL can locate the file system itself if it chooses to read manually.** `LocateDevicePath()` with the `EFI_SIMPLE_FILE_SYSTEM_PROTOCOL` GUID strips the file path from a device path and returns the device handle; `OpenVolume()` then yields the root `EFI_FILE_PROTOCOL`; `Open()` with the remaining path opens the target file. (`07_Services_Boot_Services.rst`, LocateDevicePath; `13_Protocols_Media_Access.rst`, Simple File System / File Protocol)
- **Platform attestation can consume UEFI variables before `ExitBootServices()`.** PBL can read `SecureBoot`, `SetupMode`, `PK`, `KEK`, `db`, `dbx`, and the `SignatureSupport` variable using `GetVariable()`. After PBL exits or chain-loads, only `RUNTIME_ACCESS | NON_VOLATILE` variables will remain readable by the OS through `EFI_RUNTIME_SERVICES.GetVariable()`. (`08_Services_Runtime_Services.rst`, `03_Boot_Manager.rst`)
- **Memory type choices affect what survives the transition.** PBL should use `EfiLoaderData` for normal data. Any state that must be passed to the Windows OS loader after `ExitBootServices()` should be allocated in `EfiRuntimeServicesData` (or copied by the OS loader before it calls `ExitBootServices()`). PBL must not use `EfiReservedMemoryType`, `EfiMemoryMappedIO`, or `EfiUnacceptedMemoryType`. (`07_Services_Boot_Services.rst`, AllocatePages)
- **PBL must be signed to run under Secure Boot.** The signature must be embedded in the PE/COFF certificate table (5th data directory) and the certificate or hash must be in `db` and not in `dbx`. If validation fails, the image is not started and an `EFI_IMAGE_EXECUTION_INFO_TABLE` entry is created. (`32_Secure_Boot_and_Driver_Signing.rst`)
- **PBL cannot unilaterally modify `db`/`dbx` in user mode.** Doing so requires an authenticated `SetVariable()` call signed with `KEKpriv` (for `db`/`dbx`/`dbt`/`dbr`) or `PKpriv` (for `PK` / `KEK`). Unless the platform is in setup mode, PBL must either be pre-authorized or be paired with an offline key-management step. (`32_Secure_Boot_and_Driver_Signing.rst`, Signature Database Update)
- **PI phases are not in the reviewed UEFI source files.** The UEFI 2.10 specification reviewed here defines the boot manager, image execution environment, services, and protocols, but it does *not* define the PI (Platform Initialization) phases `SEC`, `PEI`, `DXE`, or `BDS`. Those are part of the PI Specification, not the UEFI Specification. The UEFI boot manager and UEFI application execution would be entered after the PI phases have completed in a PI-compliant firmware.
- **Cross-project connection.** The existing PBL code in `firmware/PblPkg/PblApp` (e.g. `PlatformState.c`, `Bcd.c`) operates in this exact UEFI application window: it runs with all boot services available, can read files from the EFI System Partition, can inspect UEFI variables, and is expected to chain-load `bootmgfw.efi` before the Windows OS loader calls `ExitBootServices()`.

## Known implementation pitfalls

1. **ExitBootServices() requires the current memory-map key and is not idempotent.** Call `GetMemoryMap()` immediately before the call, use the returned `MapKey`, and be prepared to retry because the map may change between calls. (`07_Services_Boot_Services.rst`, ExitBootServices)
2. **GetMemoryMap() is self-increasing.** It returns `EFI_BUFFER_TOO_SMALL` with the required size, but allocating that buffer may itself change the map, so allocate a buffer larger than the reported size. (`07_Services_Boot_Services.rst`, GetMemoryMap)
3. **Device paths are unaligned and byte-packed.** Do not cast nodes as naturally aligned structures; traverse using the `Length` field of each generic node. (`10_Protocols_Device_Path_Protocol.rst`, Generic Device Path Structures)
4. **File Path node concatenation can create double backslashes.** The spec describes normalization rules for concatenating multiple File Path nodes into a single path. (`10_Protocols_Device_Path_Protocol.rst`, File Path Media Device Path)
5. **Open file handles prevent direct block access.** While `EFI_FILE_PROTOCOL` handles are open, direct `EFI_BLOCK_IO_PROTOCOL` or `EFI_DISK_IO_PROTOCOL` access to the same volume is unsafe. Close all file handles before leaving PBL. (`13_Protocols_Media_Access.rst`, File Protocol)
6. **Use `OpenProtocol()`, not `HandleProtocol()`, for new code.** `HandleProtocol()` does not track the consumer; using it can make later `UninstallProtocolInterface()` calls unsafe. (`07_Services_Boot_Services.rst`, HandleProtocol / OpenProtocol)
7. **Runtime services have strict re-entry rules.** `SetVirtualAddressMap()` cannot be called while any runtime service is in progress; `ResetSystem()` cannot be called while variable/capsule/time services are busy; and certain pairs of services cannot run concurrently. (`08_Services_Runtime_Services.rst`, Runtime Services Rules and Restrictions)
8. **Console pointers may be invalid after `ExitBootServices()`.** The `ConIn`, `ConOut`, `StdErr`, and their associated handles in the System Table may be set to `NULL` after a successful hand-off. (`07_Services_Boot_Services.rst`, ExitBootServices)
9. **Authenticated variable write failures are not generic write failures.** `SetVariable()` may return `EFI_SECURITY_VIOLATION` if the `AuthInfo` signature is invalid, the timestamp is not increasing, or the nonce is reused. (`08_Services_Runtime_Services.rst`, SetVariable)
10. **DataSize == 0 usually deletes a variable, except for authenticated or append-write cases.** Accidentally calling `SetVariable()` with size 0 on `db` or `dbx` could wipe the signature store, so the call must be carefully conditioned on `Attributes`. (`08_Services_Runtime_Services.rst`, SetVariable)
11. **PE/COFF certificates must be in the 5th data directory certificate table.** Using a certificate format not listed in `WIN_CERT_TYPE_*` or not supported by the firmware’s `SignatureSupport` will cause Secure Boot rejection. (`32_Secure_Boot_and_Driver_Signing.rst`, Embedded Signatures)

## PI (Platform Initialization) supplement

The UEFI 2.10 specification reviewed above defines the *interface* that the OS and OS loader see. The earlier Platform Initialization (PI) architecture defines the *internal firmware phases* that produce that interface. The PI Specification itself (latest public version 1.8 Errata A, March 2024) is not available as open reStructuredText source, but the EDK II / TianoCore documentation and the PI boot-flow description provide the authoritative community summary. The key PI phases are:

1. **SEC (Security) Phase** — first code to run after a platform reset. It creates a temporary memory store (often cache-as-RAM / No-Eviction-Mode on Intel x86), establishes the root of trust, and passes hand-off information to the PEI Foundation. Optional SEC Platform Information PPI may be passed.
2. **PEI (Pre-EFI Initialization) Phase** — runs while the platform is in a nascent state, often using the processor cache as a stack. PEIMs (Pre-EFI Initialization Modules) initialize permanent RAM, describe memory and firmware volumes in **Hand-Off Blocks (HOBs)**, and pass control to DXE. PEI is intentionally kept minimal and is also responsible for crisis recovery and S3 resume.
3. **DXE (Driver eXecution Environment) Phase** — where most system initialization happens. The DXE Foundation produces Boot Services, Runtime Services, and DXE Services. The DXE Dispatcher discovers and executes DXE drivers in dependency order. DXE drivers initialize the processor, chipset, and platform and provide console, boot-device, and software abstractions. DXE Core is boot-services code and does not persist after `ExitBootServices()`; only runtime DXE drivers and their data persist.
4. **BDS (Boot Device Selection) Phase** — implemented as the BDS Architectural Protocol. After the DXE Dispatcher has loaded all drivers whose dependencies are satisfied, the DXE Foundation hands control to BDS. BDS initializes consoles, loads any remaining device drivers, and attempts to load and execute boot selections according to the platform boot policy defined by the UEFI Boot Manager chapter. If BDS cannot progress, it can re-invoke the DXE Dispatcher.
5. **TSL (Transient System Load) Phase** — the OS loader is a UEFI application running with full boot services.
6. **RT (Run Time) Phase** — after `ExitBootServices()`, only the limited set of Runtime Services remains. The OS must preserve all UEFI memory-map descriptors marked runtime or reserved and may call variables/time/reset/capsule services.
7. **AF (After Life) Phase** — not specified; any recovery after a crash is platform-specific.

### Key PI mechanisms relevant to PBL

- **Firmware Volumes (FVs) and FFS:** A flash device (FD) contains one or more firmware volumes (FVs). Each FV uses the Firmware File System (FFS) and contains firmware files (FFSs), which in turn contain EFI sections. The Boot Firmware Volume (BFV) is known to PEI when it starts; additional FVs are declared by a platform PEIM. (`tianocore-wiki/PI-Boot-Flow.mediawiki`, UEFI & PI FAQ)
- **HOBs:** Hand-Off Blocks are position-independent data structures that carry state from PEI to DXE. They describe memory, firmware volumes, and platform-specific data such as `EFI_SMRAM_HOB_DESCRIPTOR_BLOCK`. (`tianocore-wiki/PI-Boot-Flow.mediawiki`)
- **Dependency Expressions (DEPEX) and SOR:** DXE drivers can be dispatched automatically when their protocol dependencies are met, or placed in an "Unrequested" state by the `SOR` (Schedule On Request) opcode and later scheduled by another driver's `Schedule()` call. (`tianocore-wiki/uefi_pi_faq.md`)
- **BDS Architectural Protocol:** This is the boundary where the platform decides which boot option to attempt. PBL is typically launched from BDS (or from an option-ROM-like path) before the Windows OS loader is selected, giving it all boot services and a rich protocol environment.

### PBL-specific PI relevance

- PBL runs during the **BDS/TSL window**, not during SEC/PEI/DXE. By the time PBL starts, DXE has already initialized all boot services, protocols, and console devices. PBL therefore does not need to initialize the platform, but it must not corrupt the environment before it chain-loads `bootmgfw.efi`.
- Because PBL executes in BDS, any firmware-rootkit that has modified DXE Core, the DXE Dispatcher, the BDS Architectural Protocol, or the `EFI_BOOT_SERVICES` table (as seen in MoonBounce) can execute *before* PBL and can potentially interfere with PBL's view of the platform. This is why the project emphasizes SPI write protection, Secure Boot, and measured boot in addition to PBL's own checks.
- The **BootOrder** / **Boot####** NVRAM variables used to select PBL are UEFI-spec concepts, but the code that interprets them lives in the BDS phase of PI. Understanding this split helps PBL diagnostics: if PBL is not selected, the problem is in BDS or the variable store; if PBL loads but a protocol is missing, the problem is in DXE driver dispatch.

## Cross-references to previously studied sources

- `docs/research/windows-11-23h2-iso-RE-findings.md` — documents the Windows BCD/registry structure, `bootmgfw.efi` path, and the boot objects that PBL is expected to validate before chain-loading.
- `docs/research/windows-firmware-lecture.md` and `docs/research/windows-firmware-lockdown-research.md` — prior project research on Windows boot-chain security, BitLocker, and firmware lockdown, which this UEFI spec note grounds in the actual firmware interfaces.
- `firmware/PblPkg/PblApp` — the PBL UEFI application being built; this study provides the formal UEFI basis for its use of image loading, file system access, variables, memory maps, and Secure Boot.
- `03_Boot_Manager.rst` (supplementary) — defines `Boot####` variables, `EFI_LOAD_OPTION`, and the Secure Boot policy variables, which connect the UEFI spec to how a real platform selects and starts PBL.
- `docs/research/...` prior Windows RE findings on the BCD hive parser are the OS-side counterpart to the UEFI-side file and image services described here.

## Outstanding questions

1. **PE/COFF signing for PblApp.efi:** Which `WIN_CERTIFICATE` type will the target HP/EDK2 firmware accept (PKCS7 via `WIN_CERT_TYPE_EFI_GUID`, `WIN_CERT_TYPE_PKCS_SIGNED_DATA`, or `WIN_CERT_TYPE_EFI_PKCS1_15`)? Will the Microsoft Windows UEFI CA 2023 hash in `db` be sufficient, or will a custom KEK enrollment be required?
2. **PBL as OS loader or chain-loader:** Will PBL itself call `ExitBootServices()`, or will it `LoadImage()` / `StartImage()` `bootmgfw.efi` and let the Windows boot manager call `ExitBootServices()`? This choice determines which boot services are available to PBL and which runtime variables remain visible.
3. **Variable visibility at runtime:** Which UEFI variables must be read by the Windows OS or a post-ExitBootServices driver? Do they carry `RUNTIME_ACCESS` and `NON_VOLATILE`, and has PBL’s platform-state storage been allocated in runtime memory?
4. **Image introspection before chain-loading:** Can PBL use `EFI_LOADED_IMAGE_PROTOCOL` and the `EFI_IMAGE_EXECUTION_INFO_TABLE` to verify the signature status of `bootmgfw.efi` before calling `StartImage()`?
5. **LoadImage policy for Windows:** Should `LoadImage()` for `bootmgfw.efi` use `BootPolicy = TRUE` or `FALSE`? A `TRUE` value triggers the boot manager policy interpretation and may affect short-form device path handling. (`07_Services_Boot_Services.rst`, LoadImage)
6. **Runtime service support on target firmware:** Does the HP platform publish an `EFI_RT_PROPERTIES_TABLE` indicating that `SetVariable` or capsule services are unsupported at runtime? How should PBL and the server-side attestation flow handle a partial runtime service set?
7. **Memory ownership across chain-load:** How does the current PBL code allocate and free the buffers it passes to `LoadImage()` and `StartImage()`? Is it using `EfiLoaderData` and then freeing handles and memory before `ExitBootServices()`?
8. **PI/BDS phase placement:** Although the UEFI spec does not define `BDS`, the project’s prior notes state PBL runs during the BDS-equivalent phase. How does the EDK2 platform used for PBL connect the boot-manager phase to the PBL application start, and is `BdsDxe` the component that loads PBL?

## Self-test (UEFI / PI)

| # | Question | Answer | Confidence |
|---|----------|--------|------------|
| 1 | What are the three UEFI image subsystems and their PE/COFF subsystem values? | Application = 10, Boot service driver = 11, Runtime driver = 12. | High |
| 2 | What are the two parameters passed to `EFI_IMAGE_ENTRY_POINT`? | `EFI_HANDLE ImageHandle` and `EFI_SYSTEM_TABLE *SystemTable`. | High |
| 3 | Which service table is no longer valid after `ExitBootServices()`? | `EFI_BOOT_SERVICES`; `EFI_RUNTIME_SERVICES` remains available. | High |
| 4 | Why must `GetMemoryMap()` be called immediately before `ExitBootServices()`? | The memory map key can change; the key passed to `ExitBootServices()` must match the current map. | High |
| 5 | What is the canonical protocol for file system access in UEFI? | `EFI_SIMPLE_FILE_SYSTEM_PROTOCOL`; `OpenVolume()` yields `EFI_FILE_PROTOCOL`. | High |
| 6 | What Media Device Path node type represents a file path? | Sub-type `0x04` (File Path Media Device Path), containing a NULL-terminated UCS-2 string. | High |
| 7 | Name the Secure Boot signature variables and their purpose. | `PK` (Platform Key), `KEK` (Key Exchange Key), `db` (allowed signatures), `dbx` (forbidden signatures), `dbt` (authorized timestamps), `dbr` (recovery signatures). | High |
| 8 | What determines the memory type a UEFI image's code/data uses? | The PE/COFF `Subsystem` field: application → `EfiLoaderCode/Data`, boot service driver → `EfiBootServicesCode/Data`, runtime driver → `EfiRuntimeServicesCode/Data`. | High |
| 9 | In PI, which phase is responsible for initializing permanent memory and producing HOBs? | PEI (Pre-EFI Initialization) phase; PEIMs initialize RAM and describe it with HOBs. | High |
| 10 | Which PI phase implements the boot policy and hands off to the OS loader? | BDS (Boot Device Selection) phase, via the BDS Architectural Protocol. | High |

**Uncertain / follow-up areas to revisit**

- The exact call sequence and `BootPolicy` value used by the EDK2 `BdsDxe` boot manager when loading an option like PBL from a `Boot####` variable. Need to verify in EDK2 source (`BdsDxe` or `UefiBootManagerLib`).
- Whether OVMF / the target HP firmware publishes an `EFI_RT_PROPERTIES_TABLE` and which runtime services it marks as `EFI_RT_SUPPORTED`. This affects what PBL can rely on after a fallback `ExitBootServices()` path.
