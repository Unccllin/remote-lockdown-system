# Windows Firmware and Boot Internals — University Lecture Series

**Course title:** Windows Firmware, Boot, and Platform Security
**Target audience:** Upper-division undergraduate / graduate students in computer engineering, cybersecurity, and operating systems
**Prerequisites:** Basic digital logic, x86 architecture, C, and operating-system concepts
**Last updated:** 2026-08-29

> **Scope note:** This is a stand-alone educational reference. It is not tied to a specific product or project and draws primarily on Microsoft Learn, the UEFI Forum, Trusted Computing Group, Intel, and NIST publications.

---

## How to use this course

Each lecture is self-contained. Read them in order because later lectures build on earlier ones (e.g., the TPM lecture before BitLocker, and the BCD lecture before the kernel-boot lecture). Every lecture ends with review questions and the primary sources used.

## Citation style

Citations use bracketed links that point to primary sources. A consolidated reference list appears at the end.

---

# LECTURE 1: The PC Boot Process — From Power Button to Desktop

## Learning objectives
1. Explain the ATX power-supply sequence from a power-button press to CPU release from reset.
2. Describe the x86 reset vector and why it is at the top of 4 GB address space.
3. Map the UEFI Platform-Init phases (SEC, PEI, DXE, BDS, TSL, RT, AL).
4. Contrast legacy BIOS and UEFI boot flows and partitioning (MBR vs. GPT).

## 1.1 The electrical boot: ATX power-good sequence

When the user presses the front-panel power button, the physical signal is **PS_ON#** (often just called `PS_ON`) on the 24-pin ATX connector. On a modern ATX12V supply:

1. The +5 VSB (standby rail) is already alive and powers the embedded controller (EC) or Super I/O that watches the button.
2. The button grounds the `PS_ON` line, pulling it low.
3. The power supply starts all main rails: +12 V, +3.3 V, +5 V.
4. Once all rails stabilize within tolerance, the supply asserts **PWR_OK** (also called `PWROK` or `POWERGOOD`) after a hold-up delay, typically 100 ms–500 ms.
5. The chipset (PCH/SoC) sees `PWR_OK` and releases the CPU's `PLTRST#` or `SYS_RESET#`. The CPU now leaves the reset state and begins fetching code.

> **Source:** ATX12V and EPS power specifications are maintained by Intel and the PSU industry. A concise reference is the [Intel ATX12V Power Supply Design Guide](https://www.intel.com/content/www/us/en/products/docs/servers/server-power/atx12v-power-supply-design-guide.html).

## 1.2 x86 reset vector: 0xFFFFFFF0

On a 64-bit Intel or AMD CPU, a cold reset initializes the CS selector to `0xF000` and the hidden base to `0xFFFF0000`. The first instruction is physically fetched from:

```
0xFFFF0000 + 0xFFF0 = 0xFFFFFFF0
```

This is 16 bytes below the top of the 4 GB real-mode address space. The ROM/flash must be mapped there. Because only 16 bytes are guaranteed, the first instruction is almost always a far jump to the real initialization routine.

> **Source:** [Intel Minimal Intel Architecture Boot Loader White Paper](https://www.intel.com/content/dam/www/public/us/en/documents/white-papers/minimal-intel-architecture-boot-loader-paper.pdf) — "When an IA bootstrap processor powers on, the first address fetched and executed is at physical address 0xFFFFFFF0."

## 1.3 UEFI Platform Initialization (PI) phases

PI does **not** jump straight to the OS. It climbs a ladder of abstraction:

```
Power on
    ↓
SEC — Security (Trust anchor, CAR, microcode, ACM/TXT)
    ↓
PEI — Pre-EFI Initialization (memory detection, S3/S4 resume, permanent memory)
    ↓
DXE — Driver Execution Environment (most UEFI drivers, protocols, runtime services)
    ↓
BDS — Boot Device Selection (read NVRAM, present UI, choose boot option)
    ↓
TSL — Transient System Load (UEFI OS loader runs with Boot Services)
    ↓
RT — Runtime (OS has called ExitBootServices; only Runtime Services remain usable)
    ↓
AL — After Life (S3/S4/S5, EFI Update Capsule, error paths)
```

* **SEC** runs from cache as RAM (CAR). It finds and executes the earliest authentication code modules (ACM) for Intel TXT or equivalent.
* **PEI** initializes memory and creates the handoff to DXE.
* **DXE** dispatches UEFI drivers, publishes protocols, and produces the UEFI Boot and Runtime Services tables.
* **BDS** reads `Boot####` and `BootOrder` NVRAM variables, then loads and starts the selected UEFI application.

## 1.4 How UEFI finds and loads the OS loader

BDS uses the UEFI Boot Manager. For each boot option it knows:

1. The `Boot####` UEFI NVRAM variable contains a `LoadOption` structure.
2. Inside that structure is the device path of the target (e.g., `PciRoot(0x0)/Pci(0x1F,0x2)/.../HD(Part1,Sig...)`) and an optional file path.
3. The firmware locates the partition, calls `LoadImage()` to load the PE32+ executable (`*.efi`), and calls `StartImage()`.
4. The OS loader, such as `bootmgfw.efi`, runs in UEFI context with Boot Services available.
5. Before the kernel takes full control, the OS loader must call `ExitBootServices()`. After this call, UEFI Boot Services are gone, only Runtime Services and UEFI-provided memory map remain.

## 1.5 Legacy BIOS vs. UEFI

| Capability | Legacy BIOS | UEFI |
|---|---|---|
| CPU mode at boot | Real (16-bit) | 32/64-bit protected/long mode |
| Disk layout | MBR (32-bit LBA, 2 TiB limit) | GPT (64-bit LBA, 9.4 ZiB) |
| Partition count | 4 primary or 3 + extended | up to 128 (Windows default) |
| Drivers | 16-bit real-mode option ROMs | PE32+ UEFI drivers, protocols |
| Networking | not standardized | UEFI network stack, HTTP boot, PXE |
| Security | none standard | Secure Boot, measured boot, capsule updates |

### MBR vs. GPT

**MBR:**
- 512-byte sector at LBA 0.
- Contains boot code, partition table (4x 16-byte entries), and `0x55 0xAA` signature.
- Partition limits: 2 TiB per volume.
- No built-in redundancy; if the single MBR is corrupted, boot fails.

**GPT:**
- Protective MBR at LBA 0 (for compatibility).
- GPT header at LBA 1, backup at last LBA.
- Each partition is a 128-byte GUID entry.
- Redundant header and CRC32 checksums.
- ESP (EFI System Partition) identified by `C12A7328-F81F-11D2-BA4B-00A0C93EC93B`.

## 1.6 Text diagram: a full UEFI boot chain

```
ATX PSU
  PS_ON ──► rails ──► PWROK ──► CPU reset released
                                  │
                                  ▼
                          CS: 0xF000, IP: 0xFFF0
                          physical fetch at 0xFFFFFFF0
                                  │
                                  ▼
                            SEC phase (CAR, ACM)
                                  │
                                  ▼
                            PEI phase (memory init)
                                  │
                                  ▼
                            DXE phase (UEFI drivers)
                                  │
                                  ▼
                            BDS phase (NVRAM boot menu)
                                  │
                                  ▼
                    LoadImage(\EFI\Microsoft\Boot\bootmgfw.efi)
                                  │
                                  ▼
                         OS loader (TSL phase)
                                  │
                                  ▼
                         ExitBootServices()
                                  │
                                  ▼
                            OS runtime
```

## 1.7 Common misconceptions
- *"The power button tells the CPU to start."* It does not; the EC/PSU handshake starts the rails.
- *"UEFI is just a big BIOS."* UEFI is an interface and a modular pre-OS environment, not a monolithic BIOS.
- *"Secure Boot is the same as measured boot."* Secure Boot **authorizes**; measured boot **records**. Lecture 2 and 6 cover this again.

## 1.8 Review questions
1. What signal does the front-panel power button drive, and what rail is already alive?
2. Why is the x86 reset vector at `0xFFFFFFF0` and why is the first instruction usually a jump?
3. List the UEFI PI phases in order and name what each phase does.
4. What is the purpose of `ExitBootServices()`?
5. Compare MBR and GPT in three ways: size limit, partition count, and redundancy.

## 1.9 Sources
- Intel, *Minimal Intel Architecture Boot Loader White Paper* — [PDF](https://www.intel.com/content/dam/www/public/us/en/documents/white-papers/minimal-intel-architecture-boot-loader-paper.pdf)
- UEFI Forum, *UEFI Specification 2.10* — [PDF](https://uefi.org/sites/default/files/resources/UEFI_Spec_2_10_Aug29.pdf)
- UEFI Forum, *UEFI 2.10 Online* — [https://uefi.org/specs/UEFI/2.10/](https://uefi.org/specs/UEFI/2.10/)
- Microsoft, *BCD System Store Settings for UEFI* — [https://learn.microsoft.com/en-us/windows-hardware/manufacture/desktop/bcd-system-store-settings-for-uefi](https://learn.microsoft.com/en-us/windows-hardware/manufacture/desktop/bcd-system-store-settings-for-uefi)

---

# LECTURE 2: UEFI Firmware Architecture

## Learning objectives
1. Understand the evolution of the UEFI specification.
2. Differentiate Boot Services, Runtime Services, and protocols.
3. Explain UEFI drivers, UEFI applications, and the UEFI Shell.
4. Configure Secure Boot key databases (PK, KEK, db, dbx).
5. Contrast Secure Boot and measured boot.

## 2.1 UEFI specification history

- **1998:** Intel begins EFI (Extensible Firmware Interface) for Itanium.
- **2005:** UEFI Forum created; UEFI 2.0 released.
- **2006:** UEFI 2.1 adds protocol services.
- **2012:** UEFI 2.3.1 becomes the common Windows 8/8.1 baseline.
- **2022:** UEFI 2.10 updates boot management, HTTP boot, and Secure Boot clarifications.

> **Source:** [UEFI 2.10](https://uefi.org/specs/UEFI/2.10/) and [UEFI Forum Specifications page](https://uefi.org/specifications).

## 2.2 UEFI services

### Boot Services
Available from DXE until `ExitBootServices()`. Examples:
- `AllocatePages()`, `FreePages()`
- `LoadImage()`, `StartImage()`, `Exit()`
- `OpenProtocol()`, `CloseProtocol()`
- `SetVariable()`, `GetVariable()`

### Runtime Services
Available before and after the OS takes over:
- `GetVariable()`, `SetVariable()` (with UEFI 2.5+ Virtual Memory extensions)
- `GetTime()`, `SetTime()`
- `ResetSystem()`
- `UpdateCapsule()`

## 2.3 UEFI protocols

A **protocol** is a structure identified by a 128-bit GUID. It is published with `InstallProtocolInterface()` and discovered with `HandleProtocol()` or `LocateProtocol()`. Example: the `EFI_BLOCK_IO_PROTOCOL` lets an OS loader or driver read sectors. The GUID for `EFI_LOADED_IMAGE_PROTOCOL` is `5B1B31A1-9562-11D2-8E3F-00A0C969723B`.

## 2.4 UEFI drivers vs. UEFI applications

| Type | Lifetime | Typical use |
|---|---|---|
| UEFI application | Loaded and runs until it exits or chain-loads another | `bootmgfw.efi`, GRUB, UEFI Shell |
| UEFI driver | Dispatched in DXE; may stay resident until `ExitBootServices()` | Disk, network, graphics, option ROMs |

Option ROMs on PCI devices now commonly ship as UEFI PE/COFF images and get dispatched by the DXE dispatcher.

## 2.5 UEFI Shell

The UEFI Shell (`shellx64.efi`) is a command-line pre-OS environment. It can:
- List devices: `map`, `ls`, `cd`
- Load and run UEFI applications
- Edit UEFI variables: `setvar`
- Diagnose and test hardware before the OS starts.

It is an optional UEFI application, not a firmware requirement.

## 2.6 NVRAM variables

UEFI variables live in NVRAM and are identified by a `(GUID, name)` pair and attributes. Important attributes include:
- `EFI_VARIABLE_NON_VOLATILE`
- `EFI_VARIABLE_BOOTSERVICE_ACCESS`
- `EFI_VARIABLE_RUNTIME_ACCESS`
- `EFI_VARIABLE_TIME_BASED_AUTHENTICATED_WRITE_ACCESS` (for secure variables)

Examples:
- `BootCurrent`, `BootOrder`, `Boot####` — boot menu.
- `SecureBoot`, `SetupMode`, `PK`, `KEK`, `db`, `dbx` — Secure Boot policy.
- `AuditMode`, `DeployedMode` — Secure Boot lifecycle.

## 2.7 UEFI capsule updates

A **capsule** is a data blob passed from the OS to the firmware through `UpdateCapsule()` Runtime Service. The OS wraps a firmware binary and a vendor-specific header. On the next reboot, the firmware recognizes the capsule and flashes the SPI ROM. Capsule updates can be:
- Non-reset (can be processed immediately).
- Reset-required (firmware applies on next reset, before DXE).
- Authenticated (signed; the UEFI variable is `CapsuleUpdateResult`).

## 2.8 UEFI Secure Boot architecture

Secure Boot uses four signature databases stored as authenticated UEFI variables:

- **PK** — Platform Key. The top-level owner of the platform. The OEM or administrator owns the private key.
- **KEK** — Key Enrollment Key. Used to sign updates to `db` and `dbx` without changing PK.
- **db** — Allowed signature database. Public keys, certificates, or hashes of trusted images.
- **dbx** — Forbidden (revoked) signature database. Known-bad signatures and vulnerable boot loaders.

At boot, the UEFI firmware verifies the signature of every PE/COFF image (firmware drivers, option ROMs, OS loaders, UEFI apps) before execution. If the hash/certificate is in `db` and not in `dbx`, the image runs.

> **Source:** Microsoft, *Windows Secure Boot Key Creation and Management Guidance* — [https://learn.microsoft.com/en-us/windows-hardware/manufacture/desktop/windows-secure-boot-key-creation-and-management-guidance](https://learn.microsoft.com/en-us/windows-hardware/manufacture/desktop/windows-secure-boot-key-creation-and-management-guidance)

### Secure Boot state machine

```
SetupMode = 1, SecureBoot = 0
      │
      ▼
Set PK, KEK, db, dbx
      │
      ▼
SetupMode = 0, SecureBoot = 1
      │
      ▼
Deploy to AuditMode or DeployedMode
```

## 2.9 Measured Boot vs. Secure Boot

| Property | Secure Boot | Measured Boot |
|---|---|---|
| Goal | Authorize code before execution | Record what ran |
| Action | Hash/signature check → allow/deny | Extend PCRs with hash of each stage |
| Failure | Boot stops if signature invalid | System may still boot, but evidence is different |
| Key consumer | UEFI firmware | TPM and remote attestation |

Measured boot is the substrate for Windows BitLocker PCR binding and device-health attestation.

## 2.10 UEFI on ARM vs. x86

ARM systems using UEFI (for example Windows on ARM devices) share the same PE/COFF loader and `*.efi` naming conventions but with an `AArch64` PE32+ image. The primary differences are:
- CPU reset path and firmware handoff.
- Memory map and cache coherency requirements.
- ACPI and Device Tree co-exist in some designs.
- Secure Boot uses the same PK/KEK/db/dbx variables.

## 2.11 Common misconceptions
- *"UEFI Secure Boot can't be turned off."* It is optional; many PCs let users disable it in Setup, though some mobile/IoT devices do not.
- *"NVRAM variables are infinite."* NVRAM is finite (commonly 64 KB–4 MB total), and corrupting it can brick the boot menu.

## 2.12 Review questions
1. What are the three main UEFI service categories?
2. How does a UEFI application discover a protocol?
3. What are the four Secure Boot key variables, and what does each control?
4. Contrast Secure Boot and measured boot.
5. Why is `ExitBootServices()` the boundary between Boot Services and Runtime Services?

## 2.13 Sources
- UEFI 2.10 Specification — [https://uefi.org/sites/default/files/resources/UEFI_Spec_2_10_Aug29.pdf](https://uefi.org/sites/default/files/resources/UEFI_Spec_2_10_Aug29.pdf)
- Microsoft, *Secure Boot Key Management* — [https://learn.microsoft.com/en-us/windows-hardware/manufacture/desktop/windows-secure-boot-key-creation-and-management-guidance](https://learn.microsoft.com/en-us/windows-hardware/manufacture/desktop/windows-secure-boot-key-creation-and-management-guidance)

---

# LECTURE 3: The EFI System Partition (ESP)

## Learning objectives
1. Identify the ESP by GUID and file system.
2. List the standard directory layout on a Windows PC.
3. Mount and modify the ESP on Windows and Linux.
4. Understand the fallback boot path and multi-OS considerations.

## 3.1 What the ESP is, and why it exists

The **EFI System Partition** (ESP) is a small FAT32 partition identified by GUID `C12A7328-F81F-11D2-BA4B-00A0C93EC93B`. It exists for a simple reason: UEFI firmware is designed to understand a **universal filesystem** (FAT) rather than per-OS boot code hidden in a disk's boot sector.

The ESP holds:
- UEFI boot loader files.
- BitLocker startup keys (when used).
- BCD, utility tools, and localized resources.

## 3.2 FAT32 requirement and why

The UEFI spec mandates that the firmware be able to read **FAT12, FAT16, and FAT32** depending on size. FAT32 was chosen for compatibility with removable media and small storage footprint. The reasons:
- Patent-free at time of adoption.
- Easy to implement in firmware.
- Long file names, reasonable file size.

> **Source:** UEFI 2.10, Section 13.3 (media formats).

## 3.3 Standard directory structure

A Windows UEFI install typically looks like this:

```
ESP (S:)
├── EFI
│   ├── Microsoft
│   │   ├── Boot
│   │   │   ├── bootmgfw.efi      (Windows Boot Manager)
│   │   │   ├── bootmgr.efi       (legacy/fallback)
│   │   │   ├── BCD               (Boot Configuration Data)
│   │   │   ├── boot.stl          (Secure Boot file-list signature)
│   │   │   ├── memtest.efi
│   │   │   ├── Fonts
│   │   │   ├── en-US
│   │   │   └── Resources
│   │   └── Recovery
│   └── BOOT
│       └── BOOTX64.EFI            (fallback removable-media loader)
└── (Boot sector area: GPT protective MBR)
```

## 3.4 Key files

- `bootmgfw.efi` — the Windows Boot Manager.
- `BCD` — the active BCD store used by `bootmgfw.efi`.
- `memtest.efi` — the Windows Memory Diagnostics tool.
- `boot.stl` — Secure Boot "bitmap" list.
- Fonts and localization directories.

## 3.5 How to mount the ESP

### On Windows

```cmd
mountvol S: /S
```

`/S` assigns the EFI System Partition to `S:`. You can also use `diskpart` to find and assign:

```cmd
diskpart
list volume
select volume 1      # the ESP volume
assign letter=S
exit
```

### On Linux

List ESP partitions:

```bash
sudo fdisk -l
```

Mount:

```bash
sudo mkdir /mnt/esp
sudo mount /dev/nvme0n1p1 /mnt/esp
```

## 3.6 The fallback boot path

For removable media and recovery, UEFI uses a fixed path:

```
\EFI\BOOT\BOOTX64.EFI   (x64)
\EFI\BOOT\BOOTIA32.EFI  (x86)
\EFI\BOOT\BOOTAA64.EFI  (ARM64)
```

If the BDS boot option for the device points to the device without a specific file path, the firmware falls back to `BOOT<ARCH>.EFI`.

## 3.7 Multiple OS booting

Linux installers usually put GRUB at:

```
\EFI\<distro>\grubx64.efi
```

The ESP can hold many OS boot managers:

```
ESP
└── EFI
    ├── Microsoft
    │   └── Boot
    │       └── bootmgfw.efi
    ├── Ubuntu
    │   └── grubx64.efi
    ├── refind
    │   └── refind_x64.efi
    └── BOOT
        └── BOOTX64.EFI
```

`rEFInd` scans the ESP for `*.efi` loaders and displays a graphical menu.

## 3.8 ESP and Secure Boot

Secure Boot validates every PE/COFF image loaded from the ESP. With most Linux distributions, a **shim** (`shimx64.efi`) is pre-signed by Microsoft's UEFI CA and validates the distribution's GRUB. The chain of trust is:

```
UEFI firmware (db)
        │
        ▼
    shimx64.efi   (Microsoft UEFI CA)
        │
        ▼
    grubx64.efi   (Distro key or hash in MOK)
        │
        ▼
    Linux kernel
```

The **Machine Owner Key (MOK)** list is an unsigned variable protected by a setup-mode password, managed by `MokManager`.

## 3.9 Common misconceptions
- *"The ESP is the Windows boot partition."* It is shared; other OSes store their loaders here too.
- *"You can format the ESP as NTFS."* No. UEFI firmware does not guarantee NTFS support.

## 3.10 Review questions
1. What GUID identifies the ESP?
2. Why is the ESP formatted FAT32?
3. What is the path to the Windows Boot Manager on x64?
4. What is the UEFI fallback removable-media path?
5. How does Linux GRUB fit into the Secure Boot chain?

## 3.11 Sources
- UEFI 2.10, Section 13.3 (file system and media) — [https://uefi.org/specs/UEFI/2.10/](https://uefi.org/specs/UEFI/2.10/)
- Microsoft, *BCD System Store Settings for UEFI* — [https://learn.microsoft.com/en-us/windows-hardware/manufacture/desktop/bcd-system-store-settings-for-uefi](https://learn.microsoft.com/en-us/windows-hardware/manufacture/desktop/bcd-system-store-settings-for-uefi)

---

# LECTURE 4: Windows Boot Manager and BCD

## Learning objectives
1. Describe `bootmgfw.efi` and its responsibilities.
2. Read and modify the BCD store with `bcdedit`.
3. Identify the identifiers `{default}`, `{bootmgr}`, `{fwbootmgr}`, and others.
4. Build safe recovery and custom boot entries.

## 4.1 `bootmgfw.efi`

`bootmgfw.efi` is the Windows Boot Manager. It is the first OS-owned code loaded by the firmware. Responsibilities:
- Read the active BCD store.
- Display the boot menu or default entry.
- Hand off to `winload.efi` (the Windows OS loader) for the chosen OS.

> **Source:** Microsoft, *BCD System Store Settings for UEFI* — [https://learn.microsoft.com/en-us/windows-hardware/manufacture/desktop/bcd-system-store-settings-for-uefi](https://learn.microsoft.com/en-us/windows-hardware/manufacture/desktop/bcd-system-store-settings-for-uefi)

## 4.2 The BCD store

The **Boot Configuration Data** (BCD) store is a registry-style binary file. On UEFI systems it lives at:

```
\EFI\Microsoft\Boot\BCD
```

On BIOS/MBR systems it is at:

```
\Boot\BCD
```

BCD replaces `boot.ini`. It can hold:
- Windows boot loader entries.
- Windows Boot Manager settings.
- RAM diagnostic options.
- Real-mode boot options (`{ntldr}`).

## 4.3 `bcdedit` major commands

Always run as Administrator.

```cmd
bcdedit /enum /v        # list all objects with GUIDs
bcdedit /enum all       # include firmware objects
bcdedit /default {guid} # set default entry
bcdedit /timeout 5      # set menu timeout
bcdedit /set {current} safeboot Minimal
bcdedit /deletevalue {current} safeboot
bcdedit /copy {current} /d "Debug Entry"
bcdedit /export C:\bcd-backup
bcdedit /import C:\bcd-backup
```

## 4.4 Important identifiers

| Identifier | Meaning |
|---|---|
| `{bootmgr}` | Windows Boot Manager (`bootmgfw.efi`) |
| `{fwbootmgr}` | UEFI firmware boot manager |
| `{current}` | Currently running OS loader entry |
| `{default}` | Alias for the default OS loader entry |
| `{ntldr}` | Legacy NTLDR entry for Windows XP/2003 |
| `{memdiag}` | Windows Memory Diagnostics |
| `{globalsettings}` | Global BCD settings |
| `{dbgsettings}` | Kernel debugging settings |

A real UEFI `{bootmgr}` looks like:

```cmd
identifier              {bootmgr}
device                  partition=\Device\HarddiskVolume1
path                    \EFI\Microsoft\Boot\bootmgfw.efi
description             Windows Boot Manager
```

## 4.5 Safe Mode and WinRE

To enable Safe Mode:

```cmd
bcdedit /set {default} safeboot Minimal
```

Options:
- `Minimal` — Safe Mode
- `Network` — Safe Mode with Networking
- `DsRepair` — Directory Services Repair Mode
- `Alternateshell` — Safe Mode with command prompt

For WinRE:

```cmd
bcdedit /set {default} bootstatuspolicy ignoreallfailures
bcdedit /set {default} recoveryenabled Yes
```

## 4.6 Boot status policy and error handling

`BootStatusPolicy` can be:
- `IgnoreAllFailures` — always try to boot.
- `DisplayAllFailures` — show recovery on every boot failure.
- `Shutdown` — shutdown after a failure.
- `RecoverySequence` — boot into the specified WinRE entry.

`RecoveryEnabled Yes` tells Windows to automatically invoke WinRE after consecutive boot failures.

## 4.7 How to break and fix BCD

A broken BCD can cause `0xc000000f` or `0xc0000098`. Recovery:

1. Boot from Windows install media.
2. Open Command Prompt (Shift+F10).
3. Rebuild:

```cmd
bootrec /fixmbr
bootrec /fixboot
bootrec /scanos
bootrec /rebuildbcd
```

If `rebuildbcd` does not see an install:

```cmd
diskpart
list volume
select volume 2
assign letter=C
exit
bcdboot C:\Windows /s S: /f UEFI
```

## 4.8 Custom boot entries

Create a copy and modify:

```cmd
bcdedit /copy {current} /d "Safe Debug"
bcdedit /set {guid} debug Yes
bcdedit /set {guid} debugtype Serial
bcdedit /set {guid} debugport 1
bcdedit /set {guid} baudrate 115200
```

## 4.9 Common misconceptions
- *"`bcdedit` edits the BIOS boot order."* It edits the Windows BCD store; `BootOrder` is a UEFI variable.
- *"Deleting BCD makes Windows unrecoverable."* It is painful but usually recoverable with `bcdboot`.

## 4.10 Review questions
1. Where is the BCD store on a UEFI system?
2. What does `bootmgfw.efi` do after it is loaded by UEFI?
3. What is the difference between `{bootmgr}` and `{fwbootmgr}`?
4. How do you enable Safe Mode from BCD?
5. What command rebuilds the BCD from a Windows PE command prompt?

## 4.11 Sources
- Microsoft, *BCD System Store Settings for UEFI* — [https://learn.microsoft.com/en-us/windows-hardware/manufacture/desktop/bcd-system-store-settings-for-uefi](https://learn.microsoft.com/en-us/windows-hardware/manufacture/desktop/bcd-system-store-settings-for-uefi)
- Microsoft, *Boot Options Identifiers* — [https://learn.microsoft.com/en-us/windows-hardware/drivers/devtest/boot-options-identifiers](https://learn.microsoft.com/en-us/windows-hardware/drivers/devtest/boot-options-identifiers)

---

# LECTURE 5: Windows Kernel Boot

## Learning objectives
1. Trace `winload.efi` through kernel handoff.
2. List the files `winload` loads and the registry hives it needs.
3. Describe the chain `smss → csrss → winlogon → userinit → explorer`.
4. Explain boot-start, system-start, and auto-start drivers.

## 5.1 `winload.efi` and `winload.exe`

`winload.efi` is the UEFI OS loader for 64-bit Windows. `winload.exe` is the legacy BIOS version. `winload.efi`:
- Allocates memory.
- Loads `ntoskrnl.exe`, `hal.dll`, `kdcom.dll`, `ci.dll`, `clfs.sys`, and other boot dependencies.
- Loads the `SYSTEM` hive.
- Loads boot-start drivers.
- Passes the `LOADER_PARAMETER_BLOCK` to the kernel.

> **Source:** *Windows Internals, Part 2, 7th Edition* — [https://learn.microsoft.com/en-us/sysinternals/resources/windows-internals](https://learn.microsoft.com/en-us/sysinternals/resources/windows-internals)

## 5.2 Kernel loading into memory

1. `winload.efi` reads the BCD for the OS entry.
2. It allocates physical pages and maps the kernel and HAL.
3. It initializes the page tables.
4. It copies boot data, including the `LOADER_PARAMETER_BLOCK`.
5. It calls the kernel's protected-mode entry point in `ntoskrnl.exe`.

## 5.3 Boot-start drivers

Boot-start drivers are listed in:

```
HKLM\SYSTEM\CurrentControlSet\Control\SystemStartOptions
```

and in the registry `Services` key with `Start = 0` (`SERVICE_BOOT_START`). Examples: disk, file-system, and storage drivers. These must be loaded before the kernel can access the boot volume.

## 5.4 The registry during boot

Only the `SYSTEM` hive is loaded initially. Other hives (SAM, SECURITY, SOFTWARE, DEFAULT) are loaded later by `smss.exe` and `Services.exe`. The `CurrentControlSet` is a volatile alias to the selected `ControlSet00x`.

## 5.5 Session Manager (`smss.exe`)

`smss.exe` (Session Manager Subsystem) is the first user-mode process. It:
- Creates the paging file.
- Loads the rest of the registry hives.
- Sets up environment subsystems.
- Starts `csrss.exe` and `wininit.exe` for session 0.
- Starts `winlogon.exe` and `csrss.exe` for each interactive session.

## 5.6 Winlogon and user logon

`winlogon.exe` is the interactive logon manager. It:
- Registers Ctrl+Alt+Del Secure Attention Sequence (SAS).
- Launches `LogonUI.exe`.
- Verifies credentials with `lsass.exe`.
- Starts `userinit.exe` after successful authentication.

## 5.7 Shell launch (`explorer.exe`)

`userinit.exe` runs logon scripts, loads user profile, then starts the shell configured in:

```
HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon\Shell
```

The default is `explorer.exe`.

## 5.8 Services startup (SCM)

`Services.exe` (the Service Control Manager, started by `wininit.exe`) reads the `HKLM\SYSTEM\CurrentControlSet\Services` hive and starts drivers and services marked `SERVICE_SYSTEM_START` (1) and `SERVICE_AUTO_START` (2).

## 5.9 Full boot chain diagram

```
UEFI firmware
    │
    ▼
bootmgfw.efi      (Windows Boot Manager)
    │
    ▼
winload.efi       (OS loader)
    │
    ▼
ntoskrnl.exe      (kernel)
    │
    ▼
smss.exe          (Session Manager)
    │
    ├── wininit.exe
    │     ├── services.exe  (SCM)
    │     └── lsass.exe     (LSA)
    │
    └── winlogon.exe
          ├── LogonUI.exe
          └── userinit.exe
                └── explorer.exe  (shell)
```

## 5.10 Common misconceptions
- *"`explorer.exe` is the desktop."* It is the Windows shell, not the OS kernel or desktop manager.
- *"All registry hives are loaded before the kernel starts."* Only `SYSTEM` is; `smss.exe` loads the rest.

## 5.11 Review questions
1. What registry hive does `winload.efi` load before `ntoskrnl.exe`?
2. What is the `Start` value for a boot-start driver?
3. What does `smss.exe` do that no earlier process can?
4. Which process launches `explorer.exe`?
5. What is the full user-mode boot chain from `winload` to the shell?

## 5.12 Sources
- Microsoft, *Windows Internals Book* — [https://learn.microsoft.com/en-us/sysinternals/resources/windows-internals](https://learn.microsoft.com/en-us/sysinternals/resources/windows-internals)
- Microsoft Press, *Troubleshooting Windows Startup and Shutdown Problems* — [https://www.microsoftpressstore.com/articles/article.aspx?p=2201310](https://www.microsoftpressstore.com/articles/article.aspx?p=2201310)

---

# LECTURE 6: TPM (Trusted Platform Module) Deep Dive

## Learning objectives
1. Trace TPM evolution from 1.1b to 2.0.
2. Compare discrete, firmware, and virtual TPMs.
3. Explain hierarchies, PCRs, and the measured-boot process.
4. Perform sealing, unsealing, and attestation.
5. List common TPM attack surfaces and defenses.

## 6.1 TPM history

- **TPM 1.1b** — 2003, basic key and platform-attestation functions.
- **TPM 1.2** — widely deployed; SHA-1, single authorization model.
- **TPM 2.0** — 2015 ISO/IEC 11889; algorithm agility, hierarchies, sessions, NV indexes, policy-based authorization.

> **Source:** TCG, *TPM 2.0 Library* — [https://trustedcomputinggroup.org/resource/tpm-library-specification/](https://trustedcomputinggroup.org/resource/tpm-library-specification/)

## 6.2 TPM hardware forms

| Form | Implementation | Use case |
|---|---|---|
| Discrete TPM | Separate hardware chip (e.g., Infineon, Nuvoton) | Servers, high-assurance workstations |
| fTPM | Firmware TPM inside the CPU/SoC | Consumer PCs, modern AMD/Intel CPUs |
| vTPM | Hypervisor-backed virtual TPM | Azure, Hyper-V, KVM |

Microsoft Pluton is a newer security processor that integrates the TPM and many other root-of-trust functions.

## 6.3 TPM 2.0 architecture

TPM 2.0 is structured around:
- **Hierarchies** — Platform, Storage, Endorsement, plus Null.
- **Sessions** — authorization, policy, audit.
- **Commands** — TPM2_CreatePrimary, TPM2_Create, TPM2_Load, TPM2_Quote, etc.
- **NV indices** — non-volatile memory accessible via policy.
- **PCR banks** — SHA-1, SHA-256, SHA-384, etc.

## 6.4 Key hierarchy

- **EK** — Endorsement Key, tied to the TPM identity, used to prove "this TPM exists."
- **SRK** — Storage Root Key, used to wrap other keys for storage outside the TPM.
- **AIK/AK** — Attestation Identity Key, used to sign PCR quotes for remote attestation.

In TPM 2.0, the EK is created from a primary seed in the Endorsement hierarchy; the SRK is created in the Storage hierarchy.

## 6.5 Platform Configuration Registers (PCRs)

PCR are 24 (or more) fixed-size registers. On Windows/TCG PC Client, common meaning includes:

| PCR | What it measures |
|---|---|
| 0 | Core root of trust measurement, BIOS/SEC |
| 1 | Platform and motherboard configuration |
| 2-3 | Option ROM code and data |
| 4 | Master boot record / boot manager |
| 5 | Master boot record / boot config |
| 6 | Platform transition to ACPI S3/S4/S5 |
| 7 | Secure Boot state |
| 8-9 | OS-reserved |
| 10 | CNG/BitLocker kernel |
| 11 | BitLocker disk unlock / recovery |
| 12-15 | Application-controlled / reserved |
| 16-23 | Debug / local / DRTM use |

A measurement is an **extend** operation:

```
new_PCR = hash(old_PCR || measurement)
```

This makes every PCR value dependent on the entire ordered history.

## 6.6 Measured boot process

```
SEC/PEI/DXE          OS loader          Windows
    │                    │                 │
    ▼                    ▼                 ▼
  hash(UEFI) ──extend──► PCR[0]
  hash(bootmgfw.efi) ──► PCR[4]
  hash(winload.efi) ───► PCR[4/9]
  hash(ntoskrnl.exe) ──► PCR[8/9]
  hash(SecureBoot var) ─► PCR[7]
```

## 6.7 Sealing and unsealing

A sealed blob can be tied to specific PCR values. The TPM only unseals the data if the current PCR values match the values at seal time. This is the basis of BitLocker's "TPM-only" protector.

## 6.8 TPM attestation

Remote attestation sends a signed **quote** (`TPM2_Quote`) that includes a chosen set of PCRs and a nonce from the verifier. The verifier uses the EK certificate and AK public key to trust the quote, then compares PCRs to expected values.

## 6.9 Anti-hammering

TPMs implement dictionary-attack prevention: failed authorization attempts trigger a lockout with increasing delays. On Windows, the **TPM Base Services (TBS)** and `TPM.msc` show the lockout status.

## 6.10 Windows TPM stack

- **TPM Base Services (TBS)** — user-mode API to the TPM.
- **CNG (Cryptography API: Next Generation)** — can use the TPM as a key storage provider.
- **WMI `Win32_Tpm`** — management surface for system administrators.

## 6.11 `tpm2-tools` on Linux

```bash
tpm2_pcrread
tpm2_quote -c ak.ctx -l sha256:0,1,2,3 -q nonce
tpm2_nvreadpublic
```

## 6.12 Common TPM attacks and defenses

| Attack | Defense |
|---|---|
| Bus sniffing | Decoupled/firmware TPM, memory encryption |
| Fault/glitch injection | Shielding, error detection, signed boot |
| Decapping | Tamper-resistant epoxy, vendor certification |
| Reset attack (cold boot) | MOR bit, memory scrub, preboot auth |
| PCR replay | PCRs can only be extended, not written |

## 6.13 Common misconceptions
- *"The TPM stores the OS."* No, it stores a small amount of keys and measurements.
- *"TPM is only for BitLocker."* It also supports measured boot, Windows Hello, device health attestation, and remote attestation.

## 6.14 Review questions
1. What are the four TPM hardware forms discussed?
2. What is the difference between `extend` and a normal hash write to a PCR?
3. Which PCR typically measures the UEFI Secure Boot state?
4. What is the purpose of an Attestation Key?
5. How does a sealed key become unusable if firmware changes?

## 6.15 Sources
- TCG, *TPM 2.0 Library Specification* — [https://trustedcomputinggroup.org/resource/tpm-library-specification/](https://trustedcomputinggroup.org/resource/tpm-library-specification/)
- ISO/IEC 11889-1:2015 — via TCG
- Microsoft, *TPM fundamentals* — [https://learn.microsoft.com/en-us/windows/security/hardware-security/tpm/](https://learn.microsoft.com/en-us/windows/security/hardware-security/tpm/)

---

# LECTURE 7: BitLocker Full Disk Encryption

## Learning objectives
1. Describe the BitLocker key hierarchy (VMK, FVEK, data key).
2. Compare AES-CBC and XTS-AES.
3. Configure key protectors and recovery.
4. Explain the BitLocker and TPM PCR relationship.
5. Troubleshoot common BitLocker failure modes.

## 7.1 BitLocker history and architecture

BitLocker debuted in Windows Vista. It encrypts entire volumes, not files. It relies on the TPM for integrity verification and uses Full Volume Encryption (FVE) metadata stored in the volume's unencrypted space.

## 7.2 AES-CBC vs. XTS-AES

- **AES-CBC** — older; each sector is encrypted with cipher block chaining. Without an elephant diffuser (used in old BitLocker), an attacker could modify targeted ciphertext bits.
- **XTS-AES** — modern default. It is a tweakable block cipher in XEX mode with ciphertext stealing. Each 512-byte or 4 KB sector has an independent tweak, so a single sector modification does not propagate. XTS-AES is NIST SP 800-38E approved.

## 7.3 BitLocker key hierarchy

```
Recovery password / PIN / USB key / TPM
                 │
                 ▼
      Volume Master Key (VMK)  — decrypts FVE metadata
                 │
                 ▼
  Full Volume Encryption Key (FVEK) — bulk-encrypts data
                 │
                 ▼
       Data Encryption Key (derived per sector) — actual AES key
```

The FVEK is encrypted by the VMK, which is encrypted by one or more **key protectors**.

## 7.4 Key protectors

| Protector | Where the VMK is protected |
|---|---|
| TPM | Tied to platform integrity (PCR values) |
| TPM+PIN | PIN + TPM; unlock requires both |
| TPM+USB startup key | Key on a removable USB drive |
| Recovery password | 48-digit numeric password |
| Password | User-supplied password (discouraged) |
| AD/Azure AD | Backed up to Active Directory/Entra ID |

> **Source:** Microsoft, *BitLocker Overview* — [https://learn.microsoft.com/en-us/windows/security/operating-system-security/data-protection/bitlocker/](https://learn.microsoft.com/en-us/windows/security/operating-system-security/data-protection/bitlocker/)

## 7.5 BitLocker and TPM PCRs

Windows 10/11 default protects the VMK to PCRs that include:

- PCR 7 — Secure Boot configuration.
- PCR 11 — BitLocker drive-encryption control.

If the firmware or bootloader changes, the PCR values change and the TPM refuses to unseal the VMK. The user is prompted for the recovery password.

## 7.6 BitLocker recovery triggers

Recovery is forced when:
- Boot config changes (BCD, UEFI boot entry, Secure Boot policy).
- Firmware update changes PCRs.
- A boot-start driver is added or changed.
- The MBR is modified.
- The TPM is cleared or replaced.
- PCRs diverge from the sealed values.

Group Policy can allow PCR 7 alone to reduce false positives after firmware updates.

## 7.7 Network Unlock

Network Unlock allows domain-joined systems on wired corporate networks to automatically obtain a recovery key from a **Network Unlock provider**. It requires:
- Windows Server with AD CS and the BitLocker Network Unlock role.
- A DHCP server.
- UEFI with a network stack and the Network Unlock certificate in `db`.

## 7.8 Used Space Only vs. Full encryption

- **Used Space Only** — encrypts only allocated space. Faster but free space is encrypted as it is written.
- **Full encryption** — encrypts all sectors, including unused space. More secure for freshly used disks; slower.

## 7.9 `manage-bde.exe`

```cmd
manage-bde -status
manage-bde -on C: -recoverypassword
manage-bde -protectors -add C: -pw
manage-bde -unlock E: -recoverypassword
manage-bde -off C:
```

> **Source:** Microsoft, *manage-bde reference* — [https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/manage-bde](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/manage-bde)

### PowerShell equivalent

```powershell
Get-BitLockerVolume
Enable-BitLocker -MountPoint C: -RecoveryPasswordProtector
Unlock-BitLocker -MountPoint C: -RecoveryPassword "123456-..."
```

## 7.10 BitLocker and Secure Boot interaction

Secure Boot ensures the boot loader is trustworthy. BitLocker uses that trust through PCR 7. If Secure Boot is off, the measured boot chain changes and the VMK remains sealed. This is why firmware setup will often force BitLocker recovery after disabling Secure Boot.

## 7.11 Common failure modes

| Symptom | Likely cause |
|---|---|
| Recovery prompt on every boot | BCD/firmware changed, wrong PCR binding |
| `0xC0210000` | TPM not available or cleared |
| Stuck at "BitLocker waiting for activation" | No protector protecting VMK |
| Performance drop | XTS-AES 256 on a disk without AES-NI |

## 7.12 Common misconceptions
- *"BitLocker is file-by-file encryption."* No, it is full-volume encryption.
- *"TPM-only BitLocker stops all attacks."* It does not stop DMA or active-in-memory attacks.

## 7.13 Review questions
1. Name the three main BitLocker keys and what each protects.
2. Why is XTS-AES preferred over AES-CBC for full-disk encryption?
3. What protector combines the TPM with a user PIN?
4. Which PCRs does BitLocker commonly use for sealing the VMK?
5. When will BitLocker prompt for a recovery key?

## 7.14 Sources
- Microsoft, *BitLocker Overview* — [https://learn.microsoft.com/en-us/windows/security/operating-system-security/data-protection/bitlocker/](https://learn.microsoft.com/en-us/windows/security/operating-system-security/data-protection/bitlocker/)
- Microsoft, *BitLocker countermeasures* — [https://learn.microsoft.com/en-us/windows/security/operating-system-security/data-protection/bitlocker/countermeasures](https://learn.microsoft.com/en-us/windows/security/operating-system-security/data-protection/bitlocker/countermeasures)
- NIST SP 800-38E — [https://csrc.nist.gov/publications/detail/sp/800-38e/final](https://csrc.nist.gov/publications/detail/sp/800-38e/final)

---

# LECTURE 8: Windows Recovery Environment (WinRE)

## Learning objectives
1. Explain what WinRE is and why it is WinPE-based.
2. Locate and manage `winre.wim`.
3. Use `reagentc.exe`.
4. Evaluate WinRE as an attack surface.

## 8.1 What WinRE is

The **Windows Recovery Environment** is a minimal WinPE-based OS that can boot from a hidden recovery partition or a USB drive. It runs before the main Windows installation to repair, restore, reset, or recover the system.

> **Source:** Microsoft, *Windows Recovery Environment Technical Reference* — [https://learn.microsoft.com/en-us/windows-hardware/manufacture/desktop/windows-recovery-environment--windows-re--technical-reference](https://learn.microsoft.com/en-us/windows-hardware/manufacture/desktop/windows-recovery-environment--windows-re--technical-reference)

## 8.2 `winre.wim`

`winre.wim` is a Windows Imaging Format file. Default location on an online system:

```
C:\Windows\System32\Recovery\winre.wim
```

It is also copied to a dedicated recovery partition. `reagentc /info` shows the active source.

## 8.3 `reagentc.exe` commands

Run from an elevated command prompt:

```cmd
reagentc /info
reagentc /enable
reagentc /disable
reagentc /setreimage /path T:\Recovery\WindowsRE
reagentc /boottore
```

- `/enable` — register `winre.wim` as the active recovery image.
- `/disable` — disable automatic WinRE.
- `/boottore` — boot into WinRE on next restart.
- `/setreimage` — point to a custom `winre.wim`.

## 8.4 What WinRE can do

- **Startup Repair** — tries to fix boot-critical files.
- **System Restore** — rolls back to a restore point.
- **System Image Recovery** — restores from a Windows image backup.
- **Startup Settings** — safe mode, debugging, low-resolution video.
- **Command Prompt** — `cmd.exe` with full admin rights.
- **Reset this PC** — local reinstall or cloud download.

## 8.5 How WinRE is triggered

Automatic:
- After consecutive failed boot attempts (`BootStatusPolicy` + `RecoveryEnabled`).

Manual:
- Via Settings → Update & Security → Recovery → Advanced startup.
- Shift+Restart.
- `reagentc /boottore`.
- Boot media or recovery partition.

## 8.6 WinRE and BitLocker

WinRE can unlock BitLocker-protected drives. It prompts for the recovery password or a pre-staged key file. This makes BitLocker recovery password entry possible before Windows loads.

## 8.7 Customizing WinRE

OEMs can inject drivers, languages, and scripts into `winre.wim` with DISM:

```cmd
Dism /Mount-Image /ImageFile:winre.wim /Index:1 /MountDir:C:\WinRE-mount
Dism /Add-Driver /Image:C:\WinRE-mount /Driver:C:\Drivers
Dism /Unmount-Image /MountDir:C:\WinRE-mount /Commit
reagentc /setreimage /path C:\WinRE-custom
```

## 8.8 WinRE as a security concern

WinRE runs with high privileges before the OS loads. Attack surfaces include:
- Physical access → boot into WinRE and use `cmd` to replace files.
- Malicious `winre.wim` replacement.
- BCD hijacking to always boot into attacker-controlled WinRE.
- BitLocker recovery password can be used if the attacker knows it.

Mitigations: BitLocker, Secure Boot, physical case locks, measured boot, and `BootStatusPolicy` restrictions.

## 8.9 Common misconceptions
- *"WinRE is part of the installed Windows."* It is a separate WinPE image; it can be modified independently.
- *"Disabling WinRE removes the image."* `reagentc /disable` only changes the BCD entry; the WIM remains on disk.

## 8.10 Review questions
1. What Windows PE image does WinRE use?
2. Where is `winre.wim` located by default?
3. What command enables and sets a custom WinRE image?
4. How can WinRE be triggered automatically?
5. Why is WinRE a privileged attack surface?

## 8.11 Sources
- Microsoft, *Windows Recovery Environment Technical Reference* — [https://learn.microsoft.com/en-us/windows-hardware/manufacture/desktop/windows-recovery-environment--windows-re--technical-reference](https://learn.microsoft.com/en-us/windows-hardware/manufacture/desktop/windows-recovery-environment--windows-re--technical-reference)
- Microsoft, *REAgentC command-line options* — [https://learn.microsoft.com/en-us/windows-hardware/manufacture/desktop/reagentc-command-line-options](https://learn.microsoft.com/en-us/windows-hardware/manufacture/desktop/reagentc-command-line-options)

---

# LECTURE 9: Windows Security Features Overview

## Learning objectives
1. List the major Windows endpoint-protection features.
2. Explain the technical mechanism behind each.
3. Understand how features overlap and how they are configured.

## 9.1 Microsoft Defender Antivirus

Real-time, behavior-based, and cloud-delivered protection. It uses the **Antimalware Scan Interface (AMSI)**, `mpeng.exe` engine, and the **Microsoft Defender Exploit Guard** engine. It integrates with the Windows Security app and Group Policy.

## 9.2 SmartScreen

A reputation-based filter that blocks known-bad executables, scripts, and websites. At the OS level it is called **Windows Defender SmartScreen**. It checks file signatures and telemetry against Microsoft's cloud.

## 9.3 User Account Control (UAC)

UAC uses **Mandatory Integrity Control** and **UI privilege isolation**. A split-token model means even an admin user runs with a filtered token until elevation. The Secure Desktop (`ConsentPrompt`) runs on Winlogon's desktop to defeat shatter attacks.

## 9.4 Windows Firewall

A stateful host firewall using the **Windows Filtering Platform (WFP)**. Rules can be applied by profile (Domain/Private/Public) and by application path, service, or IP/ port.

## 9.5 AppLocker and Software Restriction Policies

- **SRP** — older, DLL + script policy by hash/path/certificate.
- **AppLocker** — newer, supports path, hash, publisher, and package-name rules.

AppLocker is enforced by `appid.exe` and the AppID driver; it can block execution before the program starts.

## 9.6 Windows Sandbox

A lightweight desktop environment based on **Windows containers** and the Windows hypervisor. It creates a temporary copy-on-write `vmmemWSL`-style virtual machine, runs the app, and discards all changes on close. It is isolated from the host by VMBus and virtual devices.

## 9.7 Device Guard and Code Integrity

**Device Guard** was the Windows 10/Server 2016 umbrella term for code-integrity policies. It has been superseded by **Windows Defender Application Control (WDAC)**. WDAC specifies which code is trusted at the kernel and user mode levels, enforced by `ci.dll`.

## 9.8 Virtualization-Based Security (VBS) and HVCI

VBS uses the Windows hypervisor to create a secure world called **VSM (Virtual Secure Mode)**. HVCI, also called **Memory Integrity**, runs code-integrity checks inside VSM so kernel memory cannot be tampered with by host malware.

> **Source:** Microsoft, *Memory Integrity and VBS* — [https://learn.microsoft.com/en-us/windows-hardware/drivers/bringup/device-guard-and-credential-guard](https://learn.microsoft.com/en-us/windows-hardware/drivers/bringup/device-guard-and-credential-guard)

## 9.9 Credential Guard

Credential Guard uses VSM to isolate **LSASS** (`lsass.exe`) secrets, NTLM hashes, and Kerberos tickets from the normal OS. Even a kernel compromise cannot read those secrets directly.

## 9.10 Attack Surface Reduction (ASR) rules

ASR rules are part of Microsoft Defender for Endpoint. They block risky behaviors such as:
- Office apps creating child processes.
- JavaScript/VBScript launching executable content.
- Stealing credentials from LSASS.

Rules are enforced by the Defender antimalware engine and configured in Group Policy or Intune.

## 9.11 Exploit Protection

Exploit protection applies mitigations such as:
- DEP, ASLR, CFG, SEHOP.
- Arbitrary code guard (ACG).
- Handle corruption and heap integrity.

Settings can be inherited from EMET/WDEG and controlled by `ProcessMitigations`.

## 9.12 Controlled Folder Access

Part of ransomware protection. It allows only trusted apps to modify protected folders (Documents, Pictures, Desktop, etc.). Unknown processes must be explicitly allowed.

## 9.13 Common misconceptions
- *"Windows Defender is just an antivirus."* It is a platform with EDR, ASR, network protection, and exploit protection.
- *"VBS/HVCI is only Hyper-V."* It uses the hypervisor but does not require the Hyper-V role to be enabled.

## 9.14 Review questions
1. Which mitigation does UAC use to protect elevation prompts?
2. What is the difference between AppLocker and WDAC?
3. How does HVCI protect kernel code integrity?
4. What does Credential Guard isolate?
5. What technology underpins Windows Sandbox?

## 9.15 Sources
- Microsoft, *VBS and HVCI* — [https://learn.microsoft.com/en-us/windows-hardware/drivers/bringup/device-guard-and-credential-guard](https://learn.microsoft.com/en-us/windows-hardware/drivers/bringup/device-guard-and-credential-guard)
- Microsoft, *Enable VBS* — [https://learn.microsoft.com/en-us/windows/security/hardware-security/enable-virtualization-based-protection-of-code-integrity](https://learn.microsoft.com/en-us/windows/security/hardware-security/enable-virtualization-based-protection-of-code-integrity)

---

# LECTURE 10: Windows Shell and Kiosk Features

## Learning objectives
1. Distinguish `explorer.exe` from the desktop manager.
2. Configure the Winlogon shell registry key.
3. Compare Shell Launcher, Assigned Access, and multi-app kiosk.
4. Understand bypass methods and when each feature is appropriate.

## 10.1 `explorer.exe` — what it actually is

`explorer.exe` is the **Windows shell**. It creates the taskbar, Start menu, file-management windows, and desktop. It is not the window manager (that is `dwm.exe`), nor is it the logon process (`winlogon.exe`). Its location and name are configured in the registry:

```
HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon\Shell
```

Default value: `explorer.exe`.

## 10.2 Winlogon shell registry key

`Winlogon` passes the `Shell` value to `userinit.exe`, which then launches the specified program as the user's shell. A malicious or misconfigured shell path can prevent login or substitute a fake UI.

## 10.3 Shell Launcher

Shell Launcher is an Enterprise/Education feature. It lets the administrator set a **custom shell** for a specific user or group. It is configured by:

```
HKLM\SOFTWARE\Microsoft\Windows Embedded\Shell Launcher\
```

It can start any executable and optionally block the Start menu and taskbar. It is intended for point-of-sale and industrial systems.

## 10.4 Assigned Access (kiosk mode)

Assigned Access limits a user to a single Universal Windows Platform (UWP) app. The kiosk user logs in and the app occupies the full screen with no access to the desktop. Configured in Settings or with `AssignedAccess` PowerShell cmdlets.

## 10.5 Custom Credential Providers

Credential providers implement the logon UI tiles. The COM DLLs are registered and loaded by `LogonUI.exe`/`Winlogon`. They can collect passwords, PINs, smart card, or biometric data. A malicious credential provider can harvest credentials.

## 10.6 Multi-app kiosk

Multi-app kiosk uses **Shell Launcher v2** or **MDM policies** to expose only a curated set of apps. It is available in Enterprise/Education editions. It is configured with XML provisioning packages or CSPs.

## 10.7 Bypass methods

| Feature | Bypass or weakness |
|---|---|
| Winlogon Shell | Boot to WinRE, load offline registry, edit `Shell`. |
| Shell Launcher | Kill the custom shell; a fallback may launch `cmd.exe` or `explorer.exe`. |
| Assigned Access | If the kiosk app can open a file dialog or browser, it may escape. |
| Credential Provider | Physical access to register a rogue provider; debug UAC. |

## 10.8 When to use which

| Scenario | Feature |
|---|---|
| Single-app tablet | Assigned Access |
| POS terminal with custom .NET app | Shell Launcher |
| Shared call-center desktop with five approved apps | Multi-app kiosk |
| Biometric + smart-card login | Custom credential provider |

## 10.9 Common misconceptions
- *"Kiosk mode makes the system tamper-proof."* No; it raises the bar but does not prevent a dedicated attacker with physical access and WinPE.
- *"Shell Launcher is the same as Assigned Access."* Shell Launcher replaces the shell; Assigned Access runs one UWP app over a reduced shell.

## 10.10 Review questions
1. What registry key controls the default user shell?
2. What process actually starts `explorer.exe`?
3. What is the difference between Shell Launcher and Assigned Access?
4. How could an attacker bypass a custom Winlogon shell?
5. Which editions of Windows support multi-app kiosk?

## 10.11 Sources
- Microsoft, *Winlogon shell and logon* — [https://learn.microsoft.com/en-us/windows/win32/secauthn/winlogon](https://learn.microsoft.com/en-us/windows/win32/secauthn/winlogon)
- Microsoft, *Shell Launcher* — [https://learn.microsoft.com/en-us/windows-hardware/customize/enterprise/shell-launcher](https://learn.microsoft.com/en-us/windows-hardware/customize/enterprise/shell-launcher)

---

# LECTURE 11: Windows Registry Deep Dive

## Learning objectives
1. Map the registry hives to their files on disk.
2. Explain registry virtualization and transactions.
3. Identify critical keys for boot, logon, shell, and services.
4. Describe how malware and red-teamers use the registry.

## 11.1 Registry hives

| Hive | File | Purpose |
|---|---|---|
| `HKLM\SAM` | `%windir%\System32\config\SAM` | Local user hashes |
| `HKLM\SECURITY` | `%windir%\System32\config\SECURITY` | LSA secrets, service creds |
| `HKLM\SOFTWARE` | `%windir%\System32\config\SOFTWARE` | Installed software and OS config |
| `HKLM\SYSTEM` | `%windir%\System32\config\SYSTEM` | Services, drivers, control sets |
| `HKU\.DEFAULT` | `%windir%\System32\config\DEFAULT` | Default user profile |
| `HKU\<SID>` | `%userprofile%\ntuser.dat` | Per-user settings |
| `HKCU\Software\Classes` | `%userprofile%\AppData\Local\Microsoft\Windows\UsrClass.dat` | User file associations |

## 11.2 Hive files on disk

Hives are binary files with a header, bins, and cells. The kernel maps them via `CmRegisterCallback`. The `RegIdleBackup` task and `RegBack` folder historically kept copies; modern Windows may disable automatic backups but still supports `rundll32.exe` backup APIs.

## 11.3 Registry virtualization

Registry virtualization redirects writes to `HKEY_LOCAL_MACHINE\SOFTWARE` from unelevated applications to a per-user virtual store. It exists to support older applications written before UAC. Virtualized keys are under:

```
HKCU\Software\Classes\VirtualStore\MACHINE\SOFTWARE
```

## 11.4 Critical keys for boot and logon

| Key | What it controls |
|---|---|
| `HKLM\SYSTEM\CurrentControlSet\Control\Session Manager` | `BootExecute`, `Execute`, `SetupExecute`, `CriticalSectionTimeout` |
| `HKLM\SYSTEM\CurrentControlSet\Services` | All drivers and services start type, path, dependencies |
| `HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon` | `Shell`, `Userinit`, `GinaDLL` (legacy) |
| `HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Run` | Machine-wide persistence |
| `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` | Per-user persistence |
| `HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Image File Execution Options` | Can redirect/debug a process by name |

## 11.5 Run keys, RunOnce, services, drivers

Persistence mechanisms:

```
HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Run
HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\RunOnce
HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\RunOnceEx
HKCU\Software\Microsoft\Windows\CurrentVersion\Run
HKLM\SYSTEM\CurrentControlSet\Services\<svc>\ImagePath
```

`RunOnce` keys are processed by `userinit.exe` and removed after execution.

## 11.6 Registry permissions and ACLs

Registry keys have ACLs. Tools like `regedit`, `PowerShell` (`Get-Acl`/`Set-Acl`), and `SetACL.exe` can modify them. Weak permissions on `HKLM\SYSTEM\CurrentControlSet\Services` can allow unprivileged users to install or modify service entries.

## 11.7 Malware use of the registry

- `Run` keys for persistence.
- `Image File Execution Options` to redirect `sethc.exe` to `cmd.exe`.
- Services added to `HKLM\SYSTEM\CurrentControlSet\Services`.
- UAC bypass by hijacking `HKCU\Environment` or `HKCU\...\Classes`.
- COM hijacking under `HKCR\CLSID` to intercept processes.

## 11.8 Safe modification

- Back up the registry before changes.
- Use `reg export` or `regedit` Export.
- Test in a VM.
- Avoid editing `HKLM\SECURITY` or `HKLM\SAM` directly unless you know the implications.

## 11.9 Registry transaction logs

Modern Windows uses transaction logs (`*.TxR`, `*.log` in `%windir%\System32\config`) to maintain hive consistency. Forensic tools can replay these logs to recover deleted keys.

## 11.10 Common misconceptions
- *"The registry is a file system."* It is a hierarchical database loaded into kernel memory, not a true file system.
- *"UAC stops all registry tampering."* UAC stops many operations but not all; weak DACLs still matter.

## 11.11 Review questions
1. Which hive file stores the SAM database?
2. What is the purpose of `BootExecute` under `Session Manager`?
3. Where is the per-user `Run` key located?
4. What is IFEO and how is it abused?
5. What are transaction logs used for?

## 11.12 Sources
- Microsoft, *Windows Registry* — [https://learn.microsoft.com/en-us/windows/win32/sysinfo/registry](https://learn.microsoft.com/en-us/windows/win32/sysinfo/registry)
- Microsoft, *Registry hives* — [https://learn.microsoft.com/en-us/windows/win32/sysinfo/registry-hives](https://learn.microsoft.com/en-us/windows/win32/sysinfo/registry-hives)

---

# LECTURE 12: Windows Services and Scheduled Tasks

## Learning objectives
1. Explain the Service Control Manager (SCM).
2. Distinguish service types and start types.
3. Compare service and scheduled-task persistence for red/blue teams.
4. Use the Task Scheduler API safely.

## 12.1 The Service Control Manager

`Services.exe` is the SCM. It:
- Reads `HKLM\SYSTEM\CurrentControlSet\Services`.
- Starts drivers and services in dependency order.
- Manages service status messages and recovery actions.

## 12.2 Service types

| Type | Value | Meaning |
|---|---|---|
| Kernel driver | 0x1 | `SERVICE_KERNEL_DRIVER` |
| Filesystem driver | 0x2 | `SERVICE_FILE_SYSTEM_DRIVER` |
| User-mode service | 0x10 / 0x20 | `SERVICE_WIN32_OWN_PROCESS` / `SERVICE_WIN32_SHARE_PROCESS` |
| Interactive | 0x100 | `SERVICE_INTERACTIVE_PROCESS` |

## 12.3 Service accounts

| Account | Use |
|---|---|
| `LocalSystem` | Highest privileges; acts as the computer on the network. |
| `LocalService` | Lower privilege; uses anonymous network credentials. |
| `NetworkService` | Lower privilege; uses computer account on the network. |
| `NT SERVICE\<name>` | Per-service SID (Windows Vista+). |

## 12.4 Service start types

- `Boot` (0) — loaded by `winload.efi` or the kernel.
- `System` (1) — loaded by the kernel after boot-start drivers.
- `Automatic` (2) — started by the SCM at system start.
- `Manual` (3) — started on demand.
- `Disabled` (4) — cannot be started.

## 12.5 Service recovery actions

For each failure a service can:
- Restart the service.
- Run a program.
- Restart the computer.
- Take no action.

Attackers sometimes set a recovery action to run a malicious command after a service crash.

## 12.6 Scheduled tasks

The Task Scheduler is a separate persistence mechanism from the SCM. A task consists of:
- **Triggers** — time, logon, idle, event, boot, registration.
- **Actions** — start a program, send email (deprecated), show message.
- **Conditions** — AC power, network, idle time.
- **Settings** — allow wake, run on demand, stop if runs too long.

### Common management commands

```cmd
schtasks /create /tn "MyTask" /tr "C:\tool.exe" /sc onlogon
schtasks /query /v /fo list
schtasks /delete /tn "MyTask" /f
```

### PowerShell

```powershell
Get-ScheduledTask
New-ScheduledTask -TaskName "MyTask" -Action $a -Trigger $t
```

## 12.7 Services vs. scheduled tasks for persistence

| Factor | Service | Scheduled Task |
|---|---|---|
| Privilege required | Admin (usually) | Admin or user for user tasks |
| Visibility | Very visible in `services.msc` | Less obvious, hidden deep in Task Scheduler |
| Persistence after user logoff | Yes | Only if run as SYSTEM or with correct trigger |
| Flexibility | Continuous daemon | Event/time-based triggers |

## 12.8 Common service/scheduled task attacks

- Adding a service with `sc create`.
- Modifying an existing service `ImagePath` to a malicious payload.
- Creating a hidden task in `\Microsoft\Windows` folder to blend in.
- Exploiting weak service ACLs for privilege escalation (unquoted path, weak permissions, DllPath hijacking).

## 12.9 Common misconceptions
- *"Services can only be created by admin."* A non-admin can create some user-level scheduled tasks and, in rare cases, services.
- *"Disabling a service stops the process."* Disabling only prevents future starts; the running process continues until killed.

## 12.10 Review questions
1. Which process is the Service Control Manager?
2. What `Start` value means a driver is loaded by the kernel at boot?
3. What is the difference between `LocalService` and `NetworkService`?
4. Name three task triggers.
5. Why might an attacker prefer a scheduled task over a service?

## 12.11 Sources
- Microsoft, *Service Control Manager* — [https://learn.microsoft.com/en-us/windows/win32/services/service-control-manager](https://learn.microsoft.com/en-us/windows/win32/services/service-control-manager)
- Microsoft, *Task Scheduler* — [https://learn.microsoft.com/en-us/windows/win32/taskschd/task-scheduler-start-page](https://learn.microsoft.com/en-us/windows/win32/taskschd/task-scheduler-start-page)

---

# LECTURE 13: Windows Networking Stack (for Firmware/Boot Context)

## Learning objectives
1. Explain PXE boot and the UEFI network stack.
2. Trace BitLocker Network Unlock.
3. Compare Wake-on-LAN and HTTP Boot.
4. Describe iPXE and custom network boot.

## 13.1 PXE boot and the UEFI network stack

**PXE** (Preboot eXecution Environment, now called **HTTP Boot** in UEFI) is an Intel/UEFI standard. The UEFI network stack includes:

- **MNP** — Managed Network Protocol.
- **ARP / IP4 / IP6** — Internet Protocol.
- **DHCP4 / DHCP6** — address configuration.
- **TCP4 / TCP6 / UDP4 / UDP6** — transport.
- **HTTP / HTTPS** — UEFI 2.5+.
- **iSCSI / FTP** — optional.

## 13.2 DHCP in UEFI

When the UEFI BDS selects a network boot option, the NIC driver broadcasts a DHCP Discover. The DHCP server can return:
- `option 60` — PXE client class.
- `option 66` — TFTP server name.
- `option 67` — boot file name.
- `option 97` — client system architecture.

For HTTP boot, DHCP can also include `option 93` and URI options (RFC 4578, 4579).

## 13.3 BitLocker Network Unlock

Network Unlock allows a domain-joined client to unlock automatically when:
1. The wired network is available.
2. DHCP gives an IP.
3. The client obtains a Network Unlock certificate.
4. The server validates the client's identity and releases a key.

It is a convenience feature but not a bypass of the TPM.

## 13.4 Wake-on-LAN

WoL uses a **Magic Packet** (UDP or Ethernet broadcast) that contains the target NIC's MAC address repeated 16 times. The system remains in S5 soft-off with the NIC powered from +5 VSB. UEFI/ACPI tables describe whether the NIC supports wake events.

## 13.5 UEFI HTTP Boot

UEFI HTTP Boot (introduced in UEFI 2.5 and enhanced in 2.6+) lets the firmware download `bootmgfw.efi` or a network installation image directly over HTTP/HTTPS. The boot URI is passed by the DHCP server or typed in the UEFI setup menu:

```
https://pxe.contoso.com/boot/bootx64.efi
```

## 13.6 How network boot works at the firmware level

```
NIC initializes in UEFI
        │
        ▼
DHCP Discover / Request
        │
        ▼
DHCP Ack + boot filename / URI
        │
        ▼
TFTP / HTTP / HTTPS transfer
        │
        ▼
LoadImage() on the downloaded PE32+ image
        │
        ▼
StartImage()
```

## 13.7 iPXE and custom network boot

**iPXE** is an open-source network boot firmware. It can be:
- Chain-loaded from a standard NIC PXE ROM.
- Flashed into the network card option ROM.
- Loaded as a UEFI driver.

iPXE supports HTTP, HTTPS, iSCSI, FCoE, and scripting, making it a flexible choice for labs and data centers.

## 13.8 Common misconceptions
- *"PXE requires a legacy BIOS."* UEFI has a full network stack and HTTP Boot.
- *"Network Unlock bypasses BitLocker."* It is a key-release mechanism, not a backdoor; it requires a domain-joined, wired connection, and proper certificates.

## 13.9 Review questions
1. What UEFI protocol suite does HTTP Boot use?
2. What DHCP options are used for traditional PXE?
3. What conditions must be true for BitLocker Network Unlock to work?
4. What is a Magic Packet?
5. How can iPXE be introduced into the UEFI boot process?

## 13.10 Sources
- UEFI 2.10, Network and HTTP Boot sections — [https://uefi.org/specs/UEFI/2.10/](https://uefi.org/specs/UEFI/2.10/)
- iPXE project — [https://ipxe.org/](https://ipxe.org/)
- Microsoft, *BitLocker Network Unlock* — [https://learn.microsoft.com/en-us/windows/security/operating-system-security/data-protection/bitlocker/network-unlock](https://learn.microsoft.com/en-us/windows/security/operating-system-security/data-protection/bitlocker/network-unlock)

---

# LECTURE 14: Hardware-Firmware Interface

## Learning objectives
1. Read and interpret ACPI tables.
2. Locate SMBIOS/DMI data.
3. Describe UEFI Runtime Services visible to the OS.
4. Explain Windows firmware update delivery and the roles of ME/PSP and SPI flash.

## 14.1 ACPI

The **Advanced Configuration and Power Interface** (ACPI) is the OS-directed power and configuration interface. The firmware provides a set of tables in memory; the OS parses them to discover devices, power states, and thermal/cooling controls.

> **Source:** UEFI/ACPI Forum, *ACPI 6.6* — [https://uefi.org/specs/ACPI/6.6/](https://uefi.org/specs/ACPI/6.6/)

## 14.2 Important ACPI tables

| Table | Name | Purpose |
|---|---|---|
| RSDT/XSDT | Root System Description Table | Pointer list to other tables |
| FADT/FACP | Fixed ACPI Description Table | Power and reset info |
| DSDT | Differentiated System Description Table | Main AML code (device tree and power resources) |
| SSDT | Secondary System Description Table | Additional AML, often CPU/graphics methods |
| MADT/APIC | Multiple APIC Description Table | Interrupt routing, CPU list |
| MCFG | PCI Express memory-mapped config | BAR for ECAM |

The DSDT and SSDT contain **AML** (ACPI Machine Language), a virtual-machine bytecode that the OS's ACPI interpreter (`acpi.sys`) executes.

## 14.3 SMBIOS / DMI

**System Management BIOS** (now called **Desktop Management Interface**, DMI) exposes system info:

```
SMBIOS structure table
    ├── Type 0  BIOS information
    ├── Type 1  System information (vendor, product, version, serial)
    ├── Type 2  Baseboard
    ├── Type 3  Enclosure / chassis
    ├── Type 4  Processor
    ├── Type 17 Memory
    └── Type 128+ OEM-specific
```

Windows exposes this through `Win32_ComputerSystemProduct`, `Win32_BIOS`, and `Get-WmiObject` / `Get-CimInstance`.

## 14.4 UEFI Runtime Services available to the OS

After `ExitBootServices()`, the OS can still call:
- `GetVariable()` / `SetVariable()`
- `GetTime()` / `SetTime()` / `GetWakeupTime()`
- `SetVirtualAddressMap()` — required for paging.
- `ResetSystem()` — warm/cold shutdown.
- `UpdateCapsule()` — OS-to-firmware update.

## 14.5 WMI and its relationship to ACPI/SMBIOS

Windows Management Instrumentation (WMI) is a user-mode API that abstracts system data. Many WMI classes (e.g., `Win32_Tpm`, `Win32_ComputerSystem`, `Win32_BIOS`) read from ACPI, SMBIOS, UEFI variables, and driver-managed MOF files.

## 14.6 How Windows queries firmware information

- `GetSystemFirmwareTable` Win32 API returns raw ACPI/SMBIOS.
- `DeviceIoControl` to `\\.\ACPI#...` or `\\.\TPM`.
- `GetFirmwareEnvironmentVariable` for UEFI variables.
- WMI classes for parsed, user-readable data.

## 14.7 Firmware updates via Windows Update

Windows Update can deliver UEFI updates through the **UpdateCapsule** Runtime Service. The process:

1. Windows downloads a signed `.cab` or `.bin` capsule.
2. The OS calls `UpdateCapsule()` to stage the update.
3. On next reboot, the firmware applies the capsule before DXE.

Modern Windows uses the **Windows UEFI CA** signatures and maintains `dbx` revocation lists for known-bad or leaked firmware.

## 14.8 Intel ME / AMD PSP overview

- **Intel ME (Management Engine)** — an independent ARC/X86 microcontroller inside the chipset. It has its own flash region, RAM, and network stack. It runs MINIX-derived firmware and performs initialization, power management, and AMT.
- **AMD PSP (Platform Security Processor)** — an ARM TrustZone-based co-processor that initializes the x86 CPU, validates PSP bootloader, and hosts fTPM.

Both are powerful auxiliary processors; vulnerabilities (e.g., CVE-2017-5689, AMD Chimera) have raised concerns about attack surface outside the main OS.

## 14.9 SPI flash interface

The firmware is stored in a **SPI NOR flash** chip on the motherboard. It is organized into regions:

```
BIOS region
    ├── NVRAM
    ├── UEFI image
    ├── Microcode
    └── GBE/EC if included
Intel ME/AMD PSP region
GbE region
Descriptor region (Intel)
```

The chipset uses the **Intel Flash Descriptor** to enforce read/write permissions for different agents (CPU, ME, GbE).

## 14.10 JTAG and hardware debugging

JTAG and other debug ports (e.g., Intel XDP, AMD HDT) can read and write the CPU and PCH. With physical access, an attacker can:
- Dump SPI flash contents.
- Halt CPU execution.
- Modify reset vector.

Defense: tamper-evident seals, disabling fuses, and vendor-specific lock bits.

## 14.11 Common misconceptions
- *"ACPI is just for power management."* It is also the device-enumeration table and the OS's main view of platform configuration.
- *"The BIOS region is the only thing in SPI flash."* ME/PSP, GbE, and the flash descriptor all occupy the same physical chip.

## 14.12 Review questions
1. What is the difference between DSDT and SSDT?
2. What SMBIOS type contains the system serial number?
3. Which UEFI Runtime Service is used to stage a firmware update?
4. What processor runs the Intel ME?
5. Why is the SPI flash chip a high-value physical target?

## 14.13 Sources
- UEFI/ACPI, *ACPI 6.6* — [https://uefi.org/specs/ACPI/6.6/](https://uefi.org/specs/ACPI/6.6/)
- UEFI, *UEFI 2.10* — [https://uefi.org/specs/UEFI/2.10/](https://uefi.org/specs/UEFI/2.10/)
- Intel, *Intel ME* — [https://www.intel.com/content/www/us/en/products/details/chipsets/platforms-technologies/intel-management-engine.html](https://www.intel.com/content/www/us/en/products/details/chipsets/platforms-technologies/intel-management-engine.html)

---

# LECTURE 15: Security Threats at the Firmware Level

## Learning objectives
1. Classify MBR/VBR and UEFI bootkits.
2. Analyze the LoJax rootkit.
3. Describe SPI flash, TPM, and Intel ME attack surfaces.
4. Explain real Secure Boot bypasses.
5. Apply NIST 800-147 and 800-193 to enterprise procurement.

## 15.1 Bootkits

A **bootkit** modifies the boot chain below the OS. Historically:
- **MBR bootkits** overwrite the master boot record (e.g., TDL4, Rovnix).
- **VBR bootkits** target the volume boot record.
- **UEFI bootkits** install malicious DXE drivers or modify the SPI flash image.

Because they run before the OS, they can disable security software and maintain persistence across OS reinstallation.

## 15.2 LoJax UEFI rootkit

LoJax, discovered by ESET in 2018, is the first known **in-the-wild UEFI rootkit**. It is a trojanized version of Absolute Software's LoJack anti-theft agent. Attackers:

1. Used a tool to dump and patch the SPI flash.
2. Added a malicious DXE driver (`SecDxe`) that drops a user-mode payload at boot.
3. Survived OS reinstallation and disk replacement.

> **Source:** ESET, *LoJax: First UEFI rootkit found in the wild* — [PDF](https://web-assets.esetstatic.com/wls/2018/09/ESET-LoJax.pdf)

## 15.3 Computrace / Absolute

Computrace (now Absolute) is a legitimate anti-theft product that installs an UEFI/BIOS module and a Windows agent. It has been called a **"legitimate rootkit"** because:
- It runs in firmware.
- It is hard to remove.
- It has been exploited (e.g., Absolute/LoJax) when attackers subverted its update or C&C channels.

The lesson: any deeply embedded firmware agent is a root-of-trust concern, whether legitimate or malicious.

## 15.4 SPI flash attacks

If an attacker can write to the SPI flash, they can:
- Replace the UEFI image.
- Modify NVRAM variables.
- Implant rootkits in option ROMs or DXE drivers.

Defenses: flash write-protect, SPI controller lock-down, `BIOSWE` and `BLE` bits, hardware-level write switches.

## 15.5 TPM attacks

| Attack | Description | Defense |
|---|---|---|
| Bus sniffing | Reading the LPC/eSPI bus between TPM and chipset | fTPM/Pluton, bus encryption |
| Decapping | Physical chip attack | Hardened packaging |
| Fault injection | Glitching power/clock to leak keys | RNG/fault detection |
| Cold boot/reset attack | Reading RAM before memory is scrubbed | MOR bit, preboot auth |

## 15.6 Intel ME vulnerabilities

Historically:
- **CVE-2017-5689** — AMT authentication bypass.
- **PLATINUM** group used AMT for in-band networking.
- **Silent Bob is Silent** research demonstrated ME code execution.

Mitigations: vendor patches, disabling AMT when not required, using HAP (High Assurance Platform) bit to disable ME.

## 15.7 UEFI Secure Boot bypasses

Notable incidents:
- **Golden Key** (2016) — Microsoft accidentally leaked a test-mode Secure Boot key, undermining trust in `db` for some devices.
- **PKfail** (2024) — leaked/lazily-managed platform keys allowed attackers to sign UEFI updates for multiple vendors.
- **BootHole / GRUB2** (2020) — vulnerabilities in GRUB2 led to `dbx` updates revoking many boot loader hashes.

These incidents show that key management is as important as the technology itself.

## 15.8 Firmware supply chain attacks

- Compromised ODM update tools.
- Vendor source-code leaks leading to leaked signing keys.
- Counterfeit or reflashed SPI chips.
- Software bill of materials (SBOM) and firmware SBOM are increasingly required for traceability.

## 15.9 How to detect firmware-level compromise

- Compare UEFI image hash to vendor baseline.
- Use **CHIPSEC** to read and verify SPI flash descriptor and protections.
- Monitor NVRAM variables for unauthorized changes.
- Verify PCR measurements against a known-good attestation baseline.
- Use endpoint detection with kernel- and firmware-aware telemetry.

## 15.10 NIST SP 800-147 and 800-193

### NIST SP 800-147: BIOS Protection Guidelines

Provides four mandatory features for PC BIOS/UEFI:

1. **Authenticated update mechanism** — cryptographically signed updates.
2. **Optional secure local update** — physical presence for emergency updates.
3. **Integrity protection** — prevent unauthorized modification outside the update path.
4. **Non-bypassability** — no hidden ways to skip the update check.

> **Source:** NIST, *SP 800-147* — [https://csrc.nist.gov/pubs/sp/800/147/final](https://csrc.nist.gov/pubs/sp/800/147/final)

### NIST SP 800-193: Platform Firmware Resiliency Guidelines

Three principles:

1. **Protection** — prevent unauthorized changes.
2. **Detection** — discover integrity failures.
3. **Recovery** — recover securely and rapidly from corruption.

> **Source:** NIST, *SP 800-193* — [https://csrc.nist.gov/pubs/sp/800/193/final](https://csrc.nist.gov/pubs/sp/800/193/final)

## 15.11 Text diagram: a layered firmware attack model

```
┌─────────────────────────────┐
│  OS / malware                │  ← easiest to detect
├─────────────────────────────┤
│  Boot manager / BCD          │  ← bootkits, BCD editing
├─────────────────────────────┤
│  UEFI DXE drivers / ESP      │  ← UEFI rootkits, Secure Boot bypass
├─────────────────────────────┤
│  SPI flash / NVRAM           │  ← LoJax, SPI rewrite
├─────────────────────────────┤
│  ME / PSP / TPM              │  ← AMT, fTPM bus, Pluton
├─────────────────────────────┤
│  Hardware / JTAG             │  ← physical, supply-chain
└─────────────────────────────┘
```

## 15.12 Common misconceptions
- *"UEFI Secure Boot blocks all rootkits."* Secure Boot stops unsigned code in the boot path; it does not stop signed-but-malicious updates or firmware reflash.
- *"If I reinstall Windows, malware is gone."* A UEFI rootkit in SPI flash survives OS reinstallation and disk replacement.

## 15.13 Review questions
1. What is the difference between a bootkit and a rootkit at the UEFI level?
2. How did LoJax achieve persistence across disk replacement?
3. Name two real Secure Boot bypass incidents and their root cause.
4. What are the three principles of NIST SP 800-193?
5. What command-line tool can you use to audit SPI flash protections?

## 15.14 Sources
- ESET, *LoJax white paper* — [https://web-assets.esetstatic.com/wls/2018/09/ESET-LoJax.pdf](https://web-assets.esetstatic.com/wls/2018/09/ESET-LoJax.pdf)
- NIST, *SP 800-147* — [https://csrc.nist.gov/pubs/sp/800/147/final](https://csrc.nist.gov/pubs/sp/800/147/final)
- NIST, *SP 800-193* — [https://csrc.nist.gov/pubs/sp/800/193/final](https://csrc.nist.gov/pubs/sp/800/193/final)

---

# Consolidated Reference List

1. UEFI Forum, *UEFI Specification 2.10* — [PDF](https://uefi.org/sites/default/files/resources/UEFI_Spec_2_10_Aug29.pdf) / [HTML](https://uefi.org/specs/UEFI/2.10/)
2. UEFI/ACPI Forum, *ACPI Specification 6.6* — [https://uefi.org/specs/ACPI/6.6/](https://uefi.org/specs/ACPI/6.6/)
3. Intel, *Minimal Intel Architecture Boot Loader White Paper* — [PDF](https://www.intel.com/content/dam/www/public/us/en/documents/white-papers/minimal-intel-architecture-boot-loader-paper.pdf)
4. Intel, *ATX12V Power Supply Design Guide* — [https://www.intel.com/content/www/us/en/products/docs/servers/server-power/atx12v-power-supply-design-guide.html](https://www.intel.com/content/www/us/en/products/docs/servers/server-power/atx12v-power-supply-design-guide.html)
5. Microsoft, *Windows Internals* — [https://learn.microsoft.com/en-us/sysinternals/resources/windows-internals](https://learn.microsoft.com/en-us/sysinternals/resources/windows-internals)
6. Microsoft, *BCD System Store Settings for UEFI* — [https://learn.microsoft.com/en-us/windows-hardware/manufacture/desktop/bcd-system-store-settings-for-uefi](https://learn.microsoft.com/en-us/windows-hardware/manufacture/desktop/bcd-system-store-settings-for-uefi)
7. Microsoft, *Boot Options Identifiers* — [https://learn.microsoft.com/en-us/windows-hardware/drivers/devtest/boot-options-identifiers](https://learn.microsoft.com/en-us/windows-hardware/drivers/devtest/boot-options-identifiers)
8. Microsoft, *Secure Boot Key Management* — [https://learn.microsoft.com/en-us/windows-hardware/manufacture/desktop/windows-secure-boot-key-creation-and-management-guidance](https://learn.microsoft.com/en-us/windows-hardware/manufacture/desktop/windows-secure-boot-key-creation-and-management-guidance)
9. Microsoft, *BitLocker Overview* — [https://learn.microsoft.com/en-us/windows/security/operating-system-security/data-protection/bitlocker/](https://learn.microsoft.com/en-us/windows/security/operating-system-security/data-protection/bitlocker/)
10. Microsoft, *BitLocker Countermeasures* — [https://learn.microsoft.com/en-us/windows/security/operating-system-security/data-protection/bitlocker/countermeasures](https://learn.microsoft.com/en-us/windows/security/operating-system-security/data-protection/bitlocker/countermeasures)
11. Microsoft, *manage-bde reference* — [https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/manage-bde](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/manage-bde)
12. Microsoft, *WinRE Technical Reference* — [https://learn.microsoft.com/en-us/windows-hardware/manufacture/desktop/windows-recovery-environment--windows-re--technical-reference](https://learn.microsoft.com/en-us/windows-hardware/manufacture/desktop/windows-recovery-environment--windows-re--technical-reference)
13. Microsoft, *REAgentC command-line options* — [https://learn.microsoft.com/en-us/windows-hardware/manufacture/desktop/reagentc-command-line-options](https://learn.microsoft.com/en-us/windows-hardware/manufacture/desktop/reagentc-command-line-options)
14. Microsoft, *VBS / HVCI* — [https://learn.microsoft.com/en-us/windows-hardware/drivers/bringup/device-guard-and-credential-guard](https://learn.microsoft.com/en-us/windows-hardware/drivers/bringup/device-guard-and-credential-guard)
15. Microsoft, *Registry hives* — [https://learn.microsoft.com/en-us/windows/win32/sysinfo/registry-hives](https://learn.microsoft.com/en-us/windows/win32/sysinfo/registry-hives)
16. Trusted Computing Group, *TPM 2.0 Library* — [https://trustedcomputinggroup.org/resource/tpm-library-specification/](https://trustedcomputinggroup.org/resource/tpm-library-specification/)
17. NIST, *SP 800-147 BIOS Protection Guidelines* — [https://csrc.nist.gov/pubs/sp/800/147/final](https://csrc.nist.gov/pubs/sp/800/147/final)
18. NIST, *SP 800-193 Platform Firmware Resiliency Guidelines* — [https://csrc.nist.gov/pubs/sp/800/193/final](https://csrc.nist.gov/pubs/sp/800/193/final)
19. ESET, *LoJax white paper* — [https://web-assets.esetstatic.com/wls/2018/09/ESET-LoJax.pdf](https://web-assets.esetstatic.com/wls/2018/09/ESET-LoJax.pdf)
20. iPXE — [https://ipxe.org/](https://ipxe.org/)

---

## End of course

This concludes the Windows firmware and boot-internals lecture series. Students should now be able to reason about a PC from the power button through UEFI, the Windows boot manager, the kernel and service startup, platform security features, and the threat landscape at the firmware layer.
