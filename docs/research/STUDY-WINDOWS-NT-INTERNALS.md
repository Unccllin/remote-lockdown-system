# Windows NT Internals and PBL Relevance Study Notes

## Source

- **ReactOS** (open-source Windows NT-compatible reference), cloned at `/tmp/reactos`:
  - `/tmp/reactos/ntoskrnl/include/internal/ke.h` — internal kernel types, KiSystemStartup, KiInitializeKernel, trap-frame helpers.
  - `/tmp/reactos/ntoskrnl/include/internal/i386/ke.h` and `i386/trap_x.h` — x86 KTRAP_FRAME, trap entry/exit, fast system call, `KiUserTrap`, `PreviousPreviousMode`.
  - `/tmp/reactos/sdk/include/ndk/i386/ketypes.h` — public `KTRAP_FRAME` structure (lines 290-330).
  - `/tmp/reactos/ntoskrnl/ke/amd64/kiinit.c` — `KiSystemStartup` and `KiInitializeKernel` (lines 488-586).
  - `/tmp/reactos/ntoskrnl/ke/amd64/krnlinit.c` — `KiInitializeKernel` calls `ExpInitializeExecutive` (lines 225-301).
  - `/tmp/reactos/ntoskrnl/ke/krnlinit.c` — `KiInitSystem` initializes `KeServiceDescriptorTable` (lines 67-114).
  - `/tmp/reactos/ntoskrnl/ke/i386/traphdlr.c` — `KiSystemServiceHandler` (lines 1719-1794).
  - `/tmp/reactos/ntoskrnl/ke/i386/trap.s` — `KiSystemService` IDT entry and `KiFastCallEntry` (lines 66-159).
  - `/tmp/reactos/ntoskrnl/ex/init.c` — executive and kernel init phases 0 and 1 (`ExpInitializeExecutive`, `Phase1InitializationDiscard`, lines 928-2054).
  - `/tmp/reactos/ntoskrnl/ob/obinit.c` — `ObInitSystem`, object type and namespace initialization (lines 200-434).
  - `/tmp/reactos/ntoskrnl/ob/oblife.c` — `ObpObjectTypes[]` table (line 33) and type registration.
  - `/tmp/reactos/ntoskrnl/ps/psmgr.c` — `PsInitSystem`, `PspInitPhase0`, `PspInitPhase1` (lines 301-558).
  - `/tmp/reactos/ntoskrnl/include/internal/ob.h` and `ps.h` — object-manager and process-manager internal interfaces.
  - `/tmp/reactos/ntoskrnl/mm/ARM3/mminit.c` — `MmArmInitSystem` phase 0 (lines 2049-2428) and address-space setup.
  - `/tmp/reactos/ntoskrnl/mm/mminit.c` — `MmInitSystem` phase 1 (lines 217-313).
  - `/tmp/reactos/ntoskrnl/include/internal/mm.h` — `MMVAD`, `MEMORY_AREA`, working-set, MDL, and address-space helpers.
  - `/tmp/reactos/sdk/include/ndk/mmtypes.h` — public `MMVAD` structure (lines 720-744).
  - `/tmp/reactos/ntoskrnl/io/iomgr/iomgr.c` — `IoInitSystem`, device object creation, boot/system driver loading (lines 470-629).
  - `/tmp/reactos/ntoskrnl/include/internal/io.h` — IRP, driver object, reserve-IRP definitions.
  - `/tmp/reactos/ntoskrnl/config/cmcontrl.c` — `CmGetSystemControlValues` (lines 101-154).
  - `/tmp/reactos/ntoskrnl/config/cmsysini.c` — `CmInitSystem1` (lines 1642-1749).
  - `/tmp/reactos/ntoskrnl/include/internal/se.h` — security token, SID, ACL, privilege, `SeRmInitPhase1`.
  - `/tmp/reactos/ntoskrnl/se/accesschk.c` — `SeAccessCheck` (lines 1992-2047).
  - `/tmp/reactos/hal/halx86/generic/halinit.c` — `HalInitSystem` phases 0 and 1 (lines 84-187).
  - `/tmp/reactos/hal/halx86/include/halp.h` — `HalpInitializePICs`, `HalpInitializeClock`, `HalpInitBusHandlers`.
  - `/tmp/reactos/sdk/include/reactos/arc/arc.h` — `LOADER_PARAMETER_BLOCK` (lines 812-870).
  - `/tmp/reactos/sdk/include/ddk/ntimage.h` — `IMAGE_OPTIONAL_HEADER64`, `IMAGE_NT_HEADERS64`, `IMAGE_DATA_DIRECTORY`, `IMAGE_SECTION_HEADER`, directory indices (lines 208-225, 280-285, 340-410, 475-489).
  - `/tmp/reactos/sdk/include/xdk/winnt_old.h` — `IMAGE_REL_BASED_*` constants (lines 910-917).
  - `/tmp/reactos/sdk/lib/rtl/image.c` — `LdrRelocateImageWithBias`, `LdrProcessRelocationBlockLongLong` (lines 390-454, 474-533).
  - `/tmp/reactos/ntoskrnl/mm/ARM3/sysldr.c` — `MiReloadBootLoadedDrivers`, `MiUpdateThunks`, boot driver relocation (lines 1770-1957).
  - `/tmp/reactos/boot/freeldr/freeldr/ntldr/winldr.c` — ReactOS UEFI/NT loader analogue: kernel/HAL/KD/BOOTVID load, boot drivers, `LOADER_PARAMETER_BLOCK` setup (lines 113-1429).
  - `/tmp/reactos/ntoskrnl/include/internal/napi.h` and `ex/zw.S` — system-call table `MainSSDT`/`MainSSPT` and `Zw` stubs.

- **Microsoft Learn / public Windows Internals documentation**:
  - <https://learn.microsoft.com/en-us/windows-hardware/drivers/kernel/> — kernel-mode driver architecture and executive components.
  - <https://learn.microsoft.com/en-us/windows-hardware/drivers/gettingstarted/user-mode-and-kernel-mode> — user vs. kernel mode and virtual address spaces.
  - <https://learn.microsoft.com/en-us/windows-hardware/drivers/kernel/previousmode> — `PreviousMode`, `RequestorMode`, Nt/Zw parameter validation.
  - <https://learn.microsoft.com/en-us/windows-hardware/drivers/kernel/using-nt-and-zw-versions-of-the-native-system-services-routines> — Nt/Zw relationship.
  - <https://learn.microsoft.com/en-us/windows/win32/debug/pe-format> — PE/COFF header, sections, data directories, base relocations, certificate table.
  - <https://learn.microsoft.com/en-us/windows-hardware/manufacture/desktop/bcd-system-store-settings-for-uefi> — BCD store, `bootmgfw.efi`, `winload.efi`.
  - <https://learn.microsoft.com/en-us/troubleshoot/windows-client/performance/windows-boot-issues-troubleshooting> — boot phases from PreBoot through kernel.
  - <https://learn.microsoft.com/en-us/windows-hardware/drivers/bringup/device-guard-and-credential-guard> — VBS/HVCI (Memory Integrity) and Credential Guard.
  - <https://learn.microsoft.com/en-us/sysinternals/resources/windows-internals> — *Windows Internals, 7th Edition* overview.

- **Local lecture and research notes** (secondary sources):
  - `/home/cllin/remote-lockdown-system/docs/research/windows-firmware-lecture.md` — Lectures 4 (Windows Boot Manager/BCD), 5 (kernel boot), 9 (Windows security features), 14 (hardware-firmware interface / UEFI Runtime Services).
  - `/home/cllin/remote-lockdown-system/docs/research/windows-11-23h2-iso-RE-findings.md` — direct RE of `bootx64.efi`/`bootmgr.efi`, BCD object/element IDs, `NOINTEGRITYCHECKS`/`TESTSIGNING`/`BOOTDEBUG`/`HYPERVISOR*` load options, BitLocker/FVE metadata, `bootmgr_hash` lesson.

- **PBL source files mapped**:
  - `/home/cllin/remote-lockdown-system/firmware/PblPkg/PblApp/ChainLoad.c` — `PblChainLoadWindows`, `PblFindAndReadBootMgr`, `PblReadFile`, boot manager hash verification.
  - `/home/cllin/remote-lockdown-system/firmware/PblPkg/PblApp/PlatformState.c` — `PblCollectPlatformState`, UEFI variable/SMBIOS/ACPI/BCD collection.
  - `/home/cllin/remote-lockdown-system/firmware/PblPkg/PblApp/Decision.c` — 18-step policy evaluation, REQ-09 BCD/BitLocker checks.
  - `/home/cllin/remote-lockdown-system/firmware/PblPkg/PblApp/PblApp.h` — `PBL_PLATFORM_STATE`, `PBL_POLICY`, policy keys.
  - `/home/cllin/remote-lockdown-system/docs/adr/PBL-C4-Policy-Blob.md` — C4 policy schema, keys 50-58 (boot config and `bootmgr_hash`).

> **Source fidelity note:** This note uses ReactOS as an open-source, historical/implementation reference. Modern Windows (10/11/Server) differs in many details and has additional mitigations. Microsoft Learn and the local lectures are used for the modern, authoritative picture; where ReactOS is cited, it is explicitly labeled as ReactOS.

## One-paragraph technical overview

Windows NT is a layered, protected-mode operating system. The Hardware Abstraction Layer (`hal.dll`) hides buses, interrupts, clocks, and DMA from the rest of the kernel. On top of HAL sits the **kernel layer** (`ntoskrnl.exe`), which provides thread scheduling, IRQL/ISR management, DPCs, exception and trap handling, and the system-call dispatch. The **executive** builds on the kernel and supplies the Object Manager, Memory Manager, I/O Manager, Process/Thread Manager, Configuration Manager (registry), and Security Reference Monitor. User-mode code, including `Ntdll.dll`, calls the executive through a system call (`int 2e` / `sysenter` / `syscall` depending on the era), which enters kernel mode, builds a `KTRAP_FRAME`, sets `PreviousMode`, and dispatches via `KeServiceDescriptorTable`. The kernel is loaded by `winload.efi` (after `bootmgfw.efi` reads the BCD store); `winload` also maps `hal.dll`, `kdcom.dll`, boot-start drivers, and the `SYSTEM` hive and passes a `LOADER_PARAMETER_BLOCK` to `ntoskrnl`. The kernel then runs phase-0 and phase-1 initialization, creates the `System` process, starts `smss.exe`, and eventually reaches `csrss`, `services.exe`/`lsass.exe`, `winlogon`, and `explorer.exe`. Because UEFI Boot Services disappear at `ExitBootServices()`, any pre-OS lock or chain-load decision must be finalized before Windows is started; after that point the OS controls the machine.

## 10-20 key technical facts/mechanisms

1. **NT architecture has four main layers: hardware, HAL, kernel, and executive.** The kernel layer schedules, traps, and dispatches interrupts; the executive subsystems (Object, Memory, I/O, Process, Configuration, Security) provide the services drivers and user mode actually call. (ReactOS `ntoskrnl/include/internal/ke.h` and `ex/init.c`; Microsoft Learn *Kernel-Mode Driver Architecture* overview.)

2. **User mode has a private virtual address space and private handle table per process; kernel mode shares a single virtual address space.** This isolation is why user-mode crashes are local but a kernel-mode driver crash can bugcheck the system. (Microsoft Learn <https://learn.microsoft.com/en-us/windows-hardware/drivers/gettingstarted/user-mode-and-kernel-mode>; ReactOS `ntoskrnl/mm/ARM3/mminit.c:2102-2105` sets `MmSystemRangeStart`, `MmHighestUserAddress`, and `MmUserProbeAddress`.)

3. **User-mode system calls enter the kernel through `int 2e` (NT 3.x/4/2000), `sysenter` (XP+ x86), or `syscall` (x64).** The entry path builds a `KTRAP_FRAME` on the kernel stack and dispatches through `KeServiceDescriptorTable` to the executive. (ReactOS `ntoskrnl/ke/i386/trap.s:69, 149-159`; `ntoskrnl/ke/i386/traphdlr.c:1719-1794`; `ntoskrnl/ke/krnlinit.c:103-113` initializes `KeServiceDescriptorTable`.)

4. **`KTRAP_FRAME` captures the user-mode register state and kernel bookkeeping.** It holds `Eax`/`Ecx`/`Edx`, `Eip`, `Ebp`, `SegCs`, `EFlags`, `Dr0-Dr7`, and `PreviousPreviousMode`; `PreviousPreviousMode` records the calling mode so `Nt`/`Zw` routines can validate parameters. (ReactOS `sdk/include/ndk/i386/ketypes.h:293-330`; `ntoskrnl/include/internal/i386/trap_x.h:20-24`, `52-65`, `189-189`; Microsoft Learn *PreviousMode*.)

5. **`PreviousMode` (also `RequestorMode` in an IRP) tells a native routine whether the caller came from user or kernel mode.** When `PreviousMode == UserMode`, the routine probes and copies user buffers; `Zw` calls set `PreviousMode = KernelMode` explicitly. (Microsoft Learn *PreviousMode* and *Using Nt and Zw Versions of the Native System Services Routines*; ReactOS `ntoskrnl/ke/i386/traphdlr.c:1766-1767` sets `Thread->PreviousMode = KiUserTrap(TrapFrame)`.)

6. **The HAL abstracts hardware during two init phases.** `HalInitSystem(0, ...)` saves bus type, parses command-line options, initializes ACPI, the PIC, CMOS, and clock, fills out the HAL dispatch table, and calls `HalpInitPhase0`. `HalInitSystem(1, ...)` initializes bus handlers and `HalpInitPhase1`. (ReactOS `hal/halx86/generic/halinit.c:84-187`; `hal/halx86/include/halp.h:235-270`.)

7. **The Object Manager is the kernel-wide namespace and object manager.** It creates type objects (`Type`, `Directory`, `SymbolicLink`, etc.), root directories (`\`, `\ObjectTypes`, `\KernelObjects`), and per-process handle tables; object types define parse/close/delete/security procedures. (ReactOS `ntoskrnl/ob/obinit.c:203-434`; `ntoskrnl/ob/oblife.c:33`; `ntoskrnl/include/internal/ob.h:88-92`, `623-632`.)

8. **Handles are per-process indices into the process handle table; kernel handles are marked with the high bit on x86.** `ObpIsKernelHandle` tests the high bit and requires `ProcessorMode == KernelMode` and that the handle is not `NtCurrentProcess`/`NtCurrentThread`. (ReactOS `ntoskrnl/include/internal/ob.h:69-78`.)

9. **The Process/Thread Manager creates the `Process`, `Thread`, and `Job` object types during phase 0, then creates the initial `System` process and the phase-1 initialization thread.** `PspInitPhase0` sets up the active process list, `PspCidTable`, and working-set structures, then calls `PspCreateProcess` and `PsCreateSystemThread(..., Phase1Initialization, LoaderBlock)`. (ReactOS `ntoskrnl/ps/psmgr.c:314-528`; `ntoskrnl/ex/init.c:1319-1320` calls `PsInitSystem(LoaderBlock)`.)

10. **The Memory Manager uses per-process virtual address spaces described by a VAD (Virtual Address Descriptor) tree.** The `MMVAD` structure spans `StartingVpn`..`EndingVpn` and links to a `ControlArea` for sections/mapped files; `MmArmInitSystem(0, ...)` sets the user/kernel address split and initializes page lists and the PFN bitmap. (ReactOS `sdk/include/ndk/mmtypes.h:720-744`; `ntoskrnl/mm/ARM3/mminit.c:2049-2428`; `ntoskrnl/include/internal/mm.h:250-268`.)

11. **The I/O Manager uses `IRP`s (I/O Request Packets), device objects, driver objects, and device stacks.** `IoInitSystem` creates the IRP, Driver, Device, Controller, and Adapter object types, initializes PnP and root bus enumeration, loads *boot-start* drivers, then *system-start* drivers, and finally creates ARC names and assigns drive letters. (ReactOS `ntoskrnl/include/internal/io.h` IRP and object definitions; `ntoskrnl/io/iomgr/iomgr.c:470-629`.)

12. **Boot-start drivers (`Start = 0`) are loaded before the kernel can use the boot volume; system-start drivers (`Start = 1`) and auto-start drivers (`Start = 2`) follow later.** This ordering is why disk, file-system, and storage miniport drivers must be boot-start. (Microsoft Learn *Windows startup issues troubleshooting*, phase table; local `windows-firmware-lecture.md` §5.3; ReactOS `ntoskrnl/io/iomgr/iomgr.c:563-599`.)

13. **The Configuration Manager (registry) is initialized in two phases.** Phase 0 uses `CmGetSystemControlValues` to read a volatile `SYSTEM` hive from `LoaderBlock->RegistryBase`. Phase 1 (`CmInitSystem1`) creates the master volatile hive and the `\Registry\Machine` and `\Registry\User` roots, then links the `SYSTEM`, `SAM`, `SECURITY`, `SOFTWARE`, and `DEFAULT` hives. (ReactOS `ntoskrnl/config/cmcontrl.c:102-154`; `ntoskrnl/config/cmsysini.c:1642-1749`; `ntoskrnl/ex/init.c:1094, 1697`.)

14. **The Security Reference Monitor enforces object access through `SeAccessCheck`.** It takes a `SECURITY_DESCRIPTOR` (owner, group, DACL, SACL), the caller's `SECURITY_SUBJECT_CONTEXT` (token, impersonation level), the desired `ACCESS_MASK`, the object-type `GENERIC_MAPPING`, and `KPROCESSOR_MODE AccessMode`, and returns a granted mask or `STATUS_ACCESS_DENIED`. (ReactOS `ntoskrnl/se/accesschk.c:1992-2047`; `ntoskrnl/include/internal/se.h:14-17, 41-46, 330-381, 505-520`.)

15. **A token carries a user SID, group SIDs, privileges (LUIDs), default DACL, and impersonation level; UAC uses a split token and Mandatory Integrity Control.** Admin users normally get a filtered token; the Secure Desktop (`ConsentPrompt`) is used for elevation to defeat shatter attacks. (Microsoft Learn *User Mode and Kernel Mode*; local `windows-firmware-lecture.md` §9.3; ReactOS `ntoskrnl/include/internal/se.h` privileges and SIDs.)

16. **Virtualization-Based Security (VBS), HVCI / Memory Integrity, and Credential Guard use the hypervisor to create an isolated Virtual Secure Mode (VSM).** HVCI runs kernel code-integrity checks inside VSM so malicious kernel code cannot tamper with executable pages; Credential Guard isolates `lsass.exe` secrets. (Microsoft Learn <https://learn.microsoft.com/en-us/windows-hardware/drivers/bringup/device-guard-and-credential-guard>; local `windows-firmware-lecture.md` §9.8-9.9.)

17. **Modern Windows UEFI boot flow: `bootmgfw.efi` → BCD store → `winload.efi` → `ntoskrnl.exe` + `hal.dll` + `kdcom.dll`/`kd1394.dll`/`kdusb2.dll` + `ci.dll` + `clfs.sys` + boot-start drivers → `LOADER_PARAMETER_BLOCK` → kernel.** `bootmgfw.efi` is the Windows Boot Manager; `winload.efi` is the OS loader. (Microsoft Learn *BCD System Store Settings for UEFI* and *Windows startup issues troubleshooting*; local `windows-firmware-lecture.md` §4.1, §5.1-5.4; ReactOS `boot/freeldr/freeldr/ntldr/winldr.c:880-1429` is a documented, open-source analogue of this loader sequence.)

18. **`LOADER_PARAMETER_BLOCK` is the hand-off structure from the loader to the kernel.** It contains `LoadOrderListHead`, `MemoryDescriptorListHead`, `BootDriverListHead`, `KernelStack`, `Prcb`, `Process`, `Thread`, `RegistryBase`, `LoadOptions`, `Extension`, and the architecture-specific union. (ReactOS `sdk/include/reactos/arc/arc.h:812-870`.)

19. **Kernel init has phase 0 and phase 1.** `KiSystemStartup` (boot CPU) calls `KiInitializeKernel` → `ExpInitializeExecutive(0, LoaderBlock)`, which runs `HalInitSystem(0)`, `ExInitSystem`, `MmArmInitSystem(0)`, `ObInitSystem`, `SeInitSystem`, `PsInitSystem`. A new thread then runs `Phase1InitializationDiscard`, which re-runs `HalInitSystem(1)`, `ObInitSystem`, `ExInitSystem`, `KeInitSystem`, `SeInitSystem`, `MmInitSystem(1)`, `CmInitSystem1`, `IoInitSystem`, and `PsInitSystem`. (ReactOS `ntoskrnl/ke/amd64/kiinit.c:488-586`; `ntoskrnl/ke/amd64/krnlinit.c:225-301`; `ntoskrnl/ex/init.c:928-2054`.)

20. **A PE/COFF image is described by its headers: MS-DOS stub, `PE\0\0` signature, COFF file header, optional header (PE32 or PE32+), and a section table.** The optional header contains `ImageBase`, `AddressOfEntryPoint`, `SectionAlignment`, `FileAlignment`, `DllCharacteristics`, and 16 `IMAGE_DATA_DIRECTORY` entries for export, import, resource, exception, security (certificates), base relocation, debug, TLS, load config, bound import, IAT, delay import, and COM descriptor. (ReactOS `sdk/include/ddk/ntimage.h:208-225, 280-285, 340-410, 475-489`; Microsoft Learn *PE Format*, "File Headers" and "Optional Header Data Directories" sections.)

21. **Base relocations fix up absolute addresses when an image cannot load at its preferred `ImageBase`.** The `.reloc` directory is a list of `IMAGE_BASE_RELOCATION` blocks, each containing a `VirtualAddress`, `SizeOfBlock`, and an array of 4-bit type / 12-bit offset nibbles. Common types are `IMAGE_REL_BASED_HIGHLOW` (32-bit) and `IMAGE_REL_BASED_DIR64` (64-bit); the loader computes `Delta = ActualBase - PreferredBase` and adds it to the address at each entry. (ReactOS `sdk/lib/rtl/image.c:474-533` and `390-443`; `sdk/include/xdk/winnt_old.h:910-917`; Microsoft Learn *PE Format*, "The .reloc Section".)

22. **The import table and Import Address Table (IAT) are resolved at load time.** The loader walks `IMAGE_IMPORT_DESCRIPTOR` entries, loads the named DLLs (or uses an already-loaded one), and fills in the IAT with the addresses of the imported functions. ReactOS's `MiUpdateThunks` and `PeLdrScanImportDescriptorTable` show the same pattern for boot drivers and the UEFI loader. (ReactOS `ntoskrnl/mm/ARM3/sysldr.c:1944-1948`; `boot/freeldr/freeldr/ntldr/winldr.c:1035-1048`; Microsoft Learn *PE Format*, "The .idata Section" and "Import Address Table".)

## Glossary terms

- **HAL (Hardware Abstraction Layer):** The `hal.dll` layer that hides chipset, bus, interrupt controller, clock, and DMA details from `ntoskrnl`.
- **Kernel layer:** The lowest part of `ntoskrnl.exe` that handles scheduling, IRQL, ISRs, DPCs, traps, exceptions, and the system-call dispatch.
- **Executive:** The upper part of `ntoskrnl.exe` that implements Object Manager, Memory Manager, I/O Manager, Process/Thread Manager, Configuration Manager, and Security Reference Monitor.
- **KTRAP_FRAME:** The kernel structure that saves CPU registers and mode information when a user-mode thread enters kernel mode or an exception/interrupt occurs.
- **PreviousMode:** A per-thread field (`KTHREAD->PreviousMode`) that records whether the last entry into the kernel came from user or kernel mode; used by `Nt`/`Zw` routines to decide how to validate parameters.
- **System call:** A user-mode request to the kernel, historically issued through `int 2e`, `sysenter`, or `syscall`, which dispatches through the `KeServiceDescriptorTable`.
- **Object Manager:** The executive namespace that creates, names, references, and deletes kernel objects such as processes, threads, events, mutexes, files, devices, and registry keys.
- **Handle:** A per-process integer index into the process handle table that references a kernel object.
- **Object Type:** A kernel object that describes the common behavior (close/delete/parse/security) of a class of objects.
- **VAD (Virtual Address Descriptor):** A balanced-tree node describing a contiguous range of virtual addresses in a process and its protection/section/control area.
- **Working Set:** The set of physical pages currently resident for a process or the system cache.
- **MDL (Memory Descriptor List):** A structure that describes a user or kernel buffer as a list of physical page frame numbers for DMA or kernel access.
- **IRP (I/O Request Packet):** The structure the I/O Manager uses to route a request through a device stack to the appropriate driver dispatch routine.
- **Device stack:** A stack of device objects through which an IRP passes; typically contains filter, function, and bus driver objects.
- **Boot-start driver:** A driver whose `Start` value is `SERVICE_BOOT_START` (0) and that must be loaded before the kernel can access the boot volume.
- **Configuration Manager (CM):** The registry subsystem; manages hive files, keys, values, and security.
- **Security Descriptor:** An `SECURITY_DESCRIPTOR` containing an owner SID, group SID, DACL, and SACL; the basis of SRM access checks.
- **Token / Access Token:** The object representing a user identity, group memberships, privileges, and default ACL; used by the SRM to make access decisions.
- **UAC (User Account Control):** The split-token/elevation mechanism that runs admin users with a filtered token until an elevation prompt.
- **VBS (Virtualization-Based Security):** The use of a hypervisor to create an isolated virtual environment for OS security features.
- **HVCI / Memory Integrity:** A VBS feature that validates kernel code-integrity inside a protected environment, preventing modification of executable kernel pages.
- **Credential Guard:** A VBS feature that isolates `lsass.exe` credentials, NTLM hashes, and Kerberos tickets from the normal OS.
- **BCD (Boot Configuration Data):** A registry-style store at `\EFI\Microsoft\Boot\BCD` (UEFI) or `\Boot\BCD` (BIOS) that `bootmgfw.efi` reads to find `winload.efi` and boot options.
- **LOADER_PARAMETER_BLOCK:** The structure `winload.efi` builds and passes to `KiSystemStartup`, describing the loaded images, memory map, registry, boot options, and initial thread/process.
- **PE32+:** The 64-bit PE executable format; `IMAGE_OPTIONAL_HEADER64` with `Magic = 0x20b`.
- **Base Relocation / `.reloc`:** The PE directory that lists absolute addresses in the image that must be patched if the image is loaded at a base different from its preferred `ImageBase`.
- **IAT (Import Address Table):** The section of a PE image that the loader fills with the actual addresses of imported functions at load time.

## Security implications

- **The user/kernel boundary is enforced by hardware rings and `PreviousMode`.** Once an attacker can execute arbitrary kernel code (e.g., through a vulnerable driver), all object, memory, and security checks can be bypassed because the kernel is the final arbiter.
- **The SRM is only as strong as the object security descriptors and tokens.** Weak DACLs, NULL security descriptors, or tokens with high privileges can grant unintended access to processes, files, registry keys, and devices.
- **UAC is not a full security boundary.** It is an elevation/consent convenience; malware running in the same user session can still use the filtered token to persist, and a kernel compromise defeats it entirely.
- **VBS/HVCI/Credential Guard raise the bar but require compatible hardware and firmware.** They move critical logic into the hypervisor, so a hypervisor or firmware compromise (e.g., malicious UEFI, SMM, or TXT/ME exploit) can undermine them.
- **PE/COFF base relocations make in-memory hashes fragile.** Loading the same `bootmgfw.efi` at different addresses or with different BCD/load-options can alter the in-memory bytes. PBL therefore hashes the file *before* `LoadImage`, not the loaded image. (`windows-11-23h2-iso-RE-findings.md` §4.5; `ChainLoad.c:257-276`.)
- **BCD/load-options can turn off security features.** `NOINTEGRITYCHECKS`, `TESTSIGNING`, `BOOTDEBUG`, `DEBUG`, `SafeMode`, and hypervisor debug settings change the trust boundary; they must be measured into the platform-state digest. (`windows-11-23h2-iso-RE-findings.md` §3.6, §4.2; `windows-firmware-lecture.md` §4.5-4.8.)
- **After `ExitBootServices()`, the OS owns the platform.** Any pre-OS security decision—lock screen, chain-load, attestation—must be completed and recorded before that point, because once Windows starts it can rewrite UEFI Runtime Services memory, ignore NVRAM, and patch the boot chain in RAM.

## PBL-specific relevance

- **PBL runs in the UEFI BDS phase, before `bootmgfw.efi` is started.** It is the last opportunity to enforce a policy and produce an attestation before Windows takes control. (`ChainLoad.c:1-16` file comment.)

- **`PblChainLoadWindows` in `ChainLoad.c` is the Windows-specific handoff.** It locates `\EFI\Microsoft\Boot\bootmgfw.efi` (or a PBL-managed backup at `\EFI\Microsoft\Boot\bootmgfw_orig.efi` if the marker file exists), reads the file into a buffer, optionally hashes it against `Policy->BootMgrHash`, calls `gBS->LoadImage` with the verified buffer, and then `gBS->StartImage`. (`ChainLoad.c:217-311`.) This prevents a TOCTOU race between hash and load.

- **Policy key 58 (`bootmgr_hash`) is the SHA-256 of the boot manager file.** If present in the C4 policy blob, PBL computes `Sha256HashAll(BootMgrBuf, BootMgrSize)` and compares it to `Policy->BootMgrHash[32]`; a mismatch returns `EFI_SECURITY_VIOLATION`. (`PBL-C4-Policy-Blob.md` key 58, p. 4; `ChainLoad.c:256-276`.) The Windows 11 23H2 RE findings note that `bootx64.efi`/`bootmgr.efi` has a non-zero `ImageBase`, uses a certificate table, and is a self-contained UEFI application, so the file buffer is the stable measurement target. (`windows-11-23h2-iso-RE-findings.md` §2.2, §4.1.)

- **`PBL_PLATFORM_STATE` captures the Windows-relevant boot configuration.** It records `SecureBootEnabled`, `SetupMode`, `BcdHash`, `BitLockerEnabled`, BCD object/element flags (`BcdNoIntegrityChecks`, `BcdTestSigning`, `BcdBootDebug`, `BcdDebug`, `BcdWinPEMode`, `BcdSafeMode`, `BcdDisplayAdvancedOptions`, `BcdBootMenuPolicy`, `BcdHypervisorLaunchType`, etc.), and `LoadedImageCount`. (`PblApp.h:206-295`; `PlatformState.c` collection logic.)

- **`Decision.c` step 13 treats BCD, `winre.wim`, and BitLocker as a single REQ-09 block that can BLOCK.** The current code blocks if `!State->BitLockerEnabled`; BCD and `winre.wim` hashes are collected but not yet compared. (`Decision.c:20, 267-272`.) The Windows 11 RE findings clarify that the actual BitLocker lock/unlock state is in FVE volume metadata, not in BCD, so the platform-state digest may over- or under-approximate the real risk. (`windows-11-23h2-iso-RE-findings.md` §4.3.)

- **The PBL platform-state digest must include the same BCD elements that `bootmgfw.efi` will act on.** The RE findings list the relevant BCD elements: `TESTSIGNING`/`NOINTEGRITYCHECKS`/`BOOTDEBUG`/`DEBUG` (`0x16000049`, `0x16000048`, `0x16000010`, `0x260000a0`), `WinPEMode` (`0x26000022`), `HypervisorLaunchType` (`0x250000f0`), `SafeMode` (`0x26000081`), `BootMenuPolicy`/`DisplayAdvancedOptions`/`Timeout`. (`windows-11-23h2-iso-RE-findings.md` §3.6, §4.2; `PblApp.h:260-273`.)

- **PBL cannot trust anything Windows does once `bootmgfw.efi` is started.** The boot manager may load a debug Windows, a `winload.efi` with `NOINTEGRITYCHECKS`, or a BitLocker recovery path. PBL's chain-load or lock-screen decision must therefore be final before `gBS->StartImage` is called. This maps to the UEFI `ExitBootServices()` boundary in Lecture 1.4 and 14.4. (`ChainLoad.c:300-311`; `windows-firmware-lecture.md` §1.4, §14.4.)

- **PBL's `LoadedImageCount` is a weak bootkit signal.** A malicious DXE driver loaded before PBL can add itself to the loaded image list, so the count alone cannot detect a bootkit; it is one input to the platform-state digest. (`windows-11-23h2-iso-RE-findings.md` §4.2, D-213; `PblApp.h:285-290`.)

## Known implementation pitfalls

1. **ReactOS is not Windows.** It is an open-source re-implementation. The file/line numbers above describe ReactOS behavior and are useful for understanding the historical NT design, but modern Windows 10/11 may differ in exact data structures, initialization order, and security mitigations.

2. **In-memory PE hashes are non-deterministic because of base relocations.** The Windows 11 23H2 `bootx64.efi` has `ImageBase = 0x10000000`; UEFI `LoadImage` can relocate it, so an in-memory hash would change. PBL hashes the *file buffer* before `LoadImage`, which is the correct pattern. (`windows-11-23h2-iso-RE-findings.md` §2.2, §4.5; `ChainLoad.c:257-290`.)

3. **A whole-file hash of `bootmgfw.efi` includes the PKCS#7 certificate table.** For a stable "code-only" measurement, the hash should stop at the certificate table offset, as the certificate table is appended after the image. The Windows 11 RE findings note the certificate table begins at file offset `0x19ac00` for the analyzed `bootx64.efi`. (`windows-11-23h2-iso-RE-findings.md` §2.2, §4.1.)

4. **BCD parsing is necessary but not sufficient for BitLocker state.** BCD only records boot configuration and recovery UI hints. The actual locked/unlocked/recovery state lives in the FVE metadata on the encrypted volume and in the TPM/PCR state. (`windows-11-23h2-iso-RE-findings.md` §4.3.)

5. **`bootmgfw.efi` can honor dangerous load options.** `NOINTEGRITYCHECKS`, `TESTSIGNING`, `BOOTDEBUG`, `DEBUG`, `HYPERVISORLAUNCHTYPE=AUTO/OFF`, and debug transport options materially change the trust boundary; PBL must include them in the platform-state digest and policy. (`windows-11-23h2-iso-RE-findings.md` §2.4, §4.2.)

6. **PBL does not currently verify `winload.efi`, `ntoskrnl.exe`, or the BCD `winload` path.** It only hashes `bootmgfw.efi` and the BCD hive. A boot manager replacement could chain to a malicious `winload.efi` on a different path, or a malicious BCD could redirect `winload`. (`ChainLoad.c:217-311`; `windows-11-23h2-iso-RE-findings.md` §4.1.)

7. **The PBL backup-marker mechanism is fragile.** The marker file `\EFI\PBL\.bootmgr_backup` is meant to prove that PBL created `bootmgfw_orig.efi`, but if an attacker can create files in `\EFI\PBL` they could also plant a malicious backup. The backup check in `PblFindAndReadBootMgr` only opens the marker for read; it does not authenticate it. (`ChainLoad.c:27-26`, `180-189`, `191-201`.)

8. **Once `gBS->StartImage` returns, PBL is no longer the active image; if it returns, the boot manager has exited unexpectedly.** In the normal case `StartImage` does not return. (`ChainLoad.c:309-311`.)

9. **PBL runs in the same untrusted DXE/BDS environment as a potential bootkit.** A malicious DXE driver can hook `gRT->GetVariable`, `gBS->LocateProtocol`, or the file system and lie to `PblCollectPlatformState`. This is why PBL also relies on TPM PCR quotes, but PBL cannot verify the Windows image itself from inside UEFI. (`windows-firmware-lecture.md` §15.2-15.5; `STUDY-EDK2.md` DxeImageVerification discussion.)

## Cross-references to previously studied sources

- **`docs/research/STUDY-UEFI-SPEC-2.10.md`:** Defines `ExitBootServices()`, `LoadImage()`, `StartImage()`, UEFI Boot/Runtime Services, and the PE32+ image format that applies to `bootmgfw.efi` and PBL itself. This is the firmware interface layer PBL uses.

- **`docs/research/STUDY-EDK2.md`:** Describes the EDK II build environment, `BdsDxe`, `DxeImageVerificationLib`, and the OVMF target used to run and test PBL. It is the implementation context for the UEFI calls in `ChainLoad.c` and `PlatformState.c`.

- **`docs/research/STUDY-TPM-2.0.md`:** Covers PCRs, HMAC sessions, NV counters, and `TPM2_Quote`. PBL extends PCRs 12 and 13 with the decision and inputs, and the Windows boot chain extends PCRs 4, 8, 9, 11, etc.; both are needed for attestation.

- **`docs/research/STUDY-INTEL-PLATFORM-SECURITY.md`:** Describes Boot Guard, TXT, ME/CSME, and SPI flash protections. Those are the hardware roots that *should* protect the UEFI image and BCD before PBL runs; PBL cannot verify them directly but consumes their indirect UEFI/ACPI signals.

- **`docs/adr/PBL-C4-Policy-Blob.md`:** Defines the policy fields (`bcd_hash`, `winre_wim_hash`, `bootmgr_hash`, `bitlocker_required`, hypervisor and BCD flags) that connect the NT boot facts above to the decision engine.

- **`docs/adr/PBL-DEBT-LEDGER.md`:** Tracks open debt items D-120, D-213-D-219 that fall out of the Windows NT boot study (BCD parsing, BitLocker state, boot manager hash testing, chain-load with real Windows media).

## Outstanding questions

1. **How should PBL measure `winload.efi`, `ntoskrnl.exe`, `hal.dll`, and boot-start drivers?** The current code only hashes `bootmgfw.efi` and BCD. A complete chain-of-trust needs the OS loader and kernel images, but their paths are inside the BCD and may be in a location PBL cannot read without a file-system driver for the BitLocker-protected volume.

2. **Can PBL detect a tampered BCD `winload` path or recovery entry at runtime?** The BCD parser in `firmware/PblPkg/PblApp/Bcd.c` is stubbed/limited; it needs to be validated against real Windows BCD hives to ensure it catches the elements `bootmgfw.efi` actually uses.

3. **What is the correct way to read BitLocker FVE metadata from a pre-OS tool?** The Windows 11 RE findings show the lock state is not in BCD. A PE/UEFI file-system or raw-block parser would be needed to read the FVE metadata block from the OS volume.

4. **How does `ExitBootServices()` affect PBL's ability to enforce a lock?** If PBL were to display its own lock screen, it must do so before calling `gBS->StartImage` for `bootmgfw.efi`, because `winload.efi` will later call `ExitBootServices()` and UEFI Boot Services will vanish. The exact interaction with the Boot Services timer/graphics/variable services needs to be tested on real hardware.

5. **What is the ReactOS equivalent of modern Windows VBS/HVCI boot options?** ReactOS does not implement VBS. For PBL, the BCD `IsolatedExecutionContext` and `HypervisorLaunchType` fields are the only pre-OS signals that Windows will start under a hypervisor; their security meaning needs to be mapped to policy.

6. **Can PBL use the UEFI `EFI_SECURITY2_ARCH_PROTOCOL` or `DxeImageVerificationLib` to verify `bootmgfw.efi` instead of its own SHA-256 hash?** If Secure Boot is on, `LoadImage` already validates signatures, but PBL's policy hash is a second, server-controlled check. The trade-off between UEFI Secure Boot, PBL hash, and Authenticode extraction should be documented.

7. **How does Windows measured boot (PCR 4, 8, 9, 11) relate to PBL's PCR 12/13 extensions?** PBL currently extends PCRs with its decision and inputs; Windows extends the boot manager and kernel into TCG PCRs. The server-side attestation needs a policy that combines both sets of PCR expectations.

## Self-test (Windows NT internals)

| # | Question | Answer | Confidence |
|---|----------|--------|------------|
| 1 | What are the four main layers of Windows NT from the hardware up? | Hardware → HAL → Kernel → Executive. | High |
| 2 | What structure is built on the kernel stack when a user-mode thread makes a system call? | `KTRAP_FRAME`. It saves registers, `Eip`, `EFlags`, `SegCs`, debug registers, and `PreviousPreviousMode`. | High |
| 3 | What does `PreviousMode` tell the kernel, and why does it matter for `Nt` vs `Zw` calls? | It tells the native routine whether the parameters came from user or kernel mode. `Zw` calls force `PreviousMode = KernelMode` so the routine trusts the parameters; `Nt` calls preserve the caller's `PreviousMode`. | High |
| 4 | Which executive subsystem owns the kernel object namespace and handle tables? | The Object Manager. | High |
| 5 | What does the Memory Manager use to describe a contiguous range of virtual addresses in a process? | A VAD (Virtual Address Descriptor) tree. | High |
| 6 | What is an IRP and what does the I/O Manager use it for? | An I/O Request Packet; it routes I/O, PnP, and power requests through a device stack to the appropriate driver dispatch routine. | High |
| 7 | Which registry hive does `winload.efi` load before the kernel starts, and which process loads the rest? | `winload.efi` loads the `SYSTEM` hive; `smss.exe` loads the remaining hives (SAM, SECURITY, SOFTWARE, DEFAULT). | High |
| 8 | What is the modern UEFI Windows boot chain from the firmware to the shell? | UEFI firmware → `bootmgfw.efi` (reads BCD) → `winload.efi` → `ntoskrnl.exe` + `hal.dll` + boot drivers → kernel init → `smss.exe` → `csrss`/`wininit` → `services.exe`/`lsass.exe` → `winlogon` → `userinit` → `explorer.exe`. | High |
| 9 | Why must PBL's lock screen or chain-load decision happen *before* `bootmgfw.efi` starts? | Because `winload.efi` calls `ExitBootServices()`, UEFI Boot Services disappear, and the Windows kernel takes full control of memory, devices, and the platform. After that, PBL cannot enforce or measure anything. | High |
| 10 | Why does PBL hash the `bootmgfw.efi` file buffer before `LoadImage` rather than the loaded in-memory image? | Because PE/COFF images are relocated at load time, and UEFI may load `bootmgfw.efi` at an address other than its preferred `ImageBase`, changing the in-memory bytes. Hashing the file buffer avoids the non-determinism. | High |

**Uncertain / follow-up areas to revisit**

- How PBL can extend chain-of-trust measurements to `winload.efi`, `ntoskrnl.exe`, `hal.dll`, and the `SYSTEM` hive.
- Whether a PE32+ parser can reliably extract `bootmgfw.efi` certificate table and code-only hash for attestation.
- How to read BitLocker FVE metadata from the OS volume in the UEFI pre-OS environment.
- The exact interaction between PBL's lock-screen graphics, UEFI Boot Services, and `ExitBootServices()` on real hardware.
