# UEFI — Refined Study Notes

Source article: https://en.wikipedia.org/wiki/UEFI (UEFI spec 2.11, Dec 2024)
Refined into study notes for the remote-lockdown-system project, which has UEFI
enforcement paths (E-HP-UEFI, capsule updates, Secure Boot). Cross-references to
project memory and enforcement paths are marked **[proj]**.

> Note: the Wikipedia article carries a "may be confusing or unclear" banner
> (July 2025) and several `[citation needed]` / `[failed verification]` tags.
> Claims flagged weak are marked **[weak]** below — treat as leads, not facts.

---

## 0. One-paragraph mental model

UEFI is a **specification** (not an implementation) for the firmware that runs
first on power-on, before any OS. It replaces the legacy IBM PC BIOS. The spec
is owned by the **UEFI Forum** (an industry consortium) since Intel handed off
EFI 1.10 in 2005. Implementations are mostly proprietary (AMI Aptio, Phoenix
SecureCore, InsydeH2O); the open reference is **TianoCore EDK II** (C). UEFI
defines: a boot manager driven by NVRAM variables, an EFI System Partition
(FAT) holding UEFI applications, a two-tier service model (boot services +
runtime services), Secure Boot (signature-gated loading), and the UEFI Capsule
firmware-update interface. The boot path is staged: SEC → PEI → DXE → BDS →
TSL → RT.

---

## 1. History (the lineage matters)

- **mid-1990s**: EFI motivation = BIOS too restrictive for Itanium (Intel–HP)
  servers. Effort began 1998 as "Intel Boot Initiative", renamed EFI.
- **2004**: Intel released **Tiano**, the first open-source UEFI impl →
  superseded by EDK → **EDK II** (TianoCore community).
- **Jul 2005**: Intel stopped at EFI 1.10, contributed to **Unified EFI Forum**
  → spec renamed UEFI. (EFI 1.10 still owned/licensed by Intel; UEFI owned by
  Forum.)
- **UEFI 2.0** (31 Jan 2006): added cryptography/security.
- **UEFI 2.1** (7 Jan 2007): network auth + **HII** (Human Interface
  Infrastructure — the pre-boot UI/forms framework).
- **UEFI 2.3.1** (6 Apr 2011): added **Secure Boot** + ARM support.
- **UEFI 2.5**: HTTP boot.
- **UEFI 2.11** (Dec 2024): latest.
- **Dec 2018**: Microsoft released **Project Mu** (TianoCore EDK II fork, used
  in Surface/Hyper-V; service-based firmware delivery model).
- **Oct 2017 / 2019**: Intel removed legacy PC BIOS support by 2020 → UEFI
  Class 3. By 2019 all Intel-platform PCs ship UEFI-only (no CSM).
- **Arm ServerReady / SystemReady**: SBBR (UEFI+ACPI+SMBIOS, enterprise) and
  EBBR (embedded subset, e.g. Yocto) compliance programs.

**Study hook**: the EFI→UEFI handoff is why two things coexist that look
redundant — "EFI" prefixes (EFI System Partition, EFI handover protocol) and
"UEFI" names. EFI = Intel's pre-2005 spec; UEFI = Forum's continuation.

---

## 2. Compatibility

### Processor compatibility
- UEFI supports 32-bit+ **little-endian** processors only (spec 2.11 §1.9.1).
- Officially documented (§3.5.1.1): x86 (IA-32, x86-64), Itanium (IA-64),
  ARM (AArch32, AArch64), RISC-V (32/64/128), LoongArch (32/64).
- Abandoned unofficial: POWERPC64 (EDK II on OPAL, little-endian) and MIPS.
- **Bit-width lock**: firmware only executes UEFI apps matching its own
  bit-width, regardless of CPU capability. (A 64-bit CPU with 32-bit UEFI
  firmware can only run 32-bit UEFI apps.) After `ExitBootServices()` the OS
  can switch modes, but calling **runtime services** requires switching back
  to the firmware's original mode.
- Linux 3.15+: can boot a 64-bit kernel on 32-bit UEFI via the **EFI handover
  protocol** (loader defers UEFI init to the kernel's EFI boot stub).

### Disk device compatibility
- UEFI supports both **MBR** and **GPT** (GPT is part of the UEFI standard).
  GPT lifts MBR's limits (4 primary partitions, 2 TiB) → up to 8 ZiB with
  512-byte sectors.
- UEFI spec only supports **FAT12/16/32** partitions on GPT/MBR + El Torito
  optical discs (§13.3).
- **Linux**: `CONFIG_EFI_PARTITION` enables GPT. BIOS-GPT booting is possible
  (GRUB embeds 2nd-stage in a BIOS boot partition, GUID
  `21686148-6449-6E6F-744E-656564454649`, ~1 MB). UEFI-GPT does NOT need that
  partition.
- **Windows**: Win11, Vista SP1/SP2 x64, Win7 x64, Win8/8.1/10 (32+64-bit)
  can boot GPT >2 TiB.

**[proj] memory tie-in**: prior session memory notes "OVMF requires GPT with
ESP type code (C12A7328-F81F-...)" — that GUID is the ESP partition type.
This is the partition you must create when building an OVMF-bootable image.

---

## 3. Features (the core of the spec)

### 3.1 Services — the two-tier model (memorize this)
| | Boot services | Runtime services |
|---|---|---|
| Available | before `ExitBootServices()` | while OS is running |
| Examples | text/graphical consoles, bus/block/file services | date/time, **NVRAM/variables**, GOP framebuffer |

Other service categories: GOP (Graphics Output Protocol), UEFI memory map,
**SMM** (System Management Mode), ACPI, SMBIOS, Devicetree (RISC), **Variable
services**, Time services.

- **Variable services**: UEFI variables = key/value pairs in namespaces
  identified by **GUIDs**; some are non-volatile (NVRAM) and shared between
  firmware and OS. Example use: store crash messages in NVRAM for OS retrieval
  after reboot.
- **Time services**: support timezone + DST; PC-AT RTC defaults to local time
  for BIOS-Windows compat (UTC needs a Windows registry entry).

**[proj] memory tie-in**: "AgentState persists in NVRAM across reboots" and
"SetFirmwareEnvironmentVariableExW with CapsuleUpdate..." — both are runtime
variable services. The lockdown agent's persisted state and capsule triggering
ride on UEFI runtime variable services, which is exactly why they survive
reboots and OS reinstalls.

### 3.2 Applications
UEFI apps are files on the ESP, launched by the UEFI Shell, the firmware boot
manager, or other apps. OS boot loaders (GRUB, rEFInd, systemd-boot, Windows
Boot Manager) are UEFI apps. UEFI Shell itself is a UEFI app.

### 3.3 Protocols
Protocols = software interfaces between two binary modules. All EFI drivers
expose services via protocols. Analogous to BIOS interrupt calls (INT 10h etc.)
but structured/GUID-based.

### 3.4 Device drivers
- ISA-independent **EBC** (EFI Byte Code) drivers stored in NVRAM, interpreted
  by firmware — analogous to Open Firmware's FCode (PowerPC Macs, Sun SPARC).
- Architecture-specific EFI drivers can expose interfaces the OS reuses for
  early graphics/network before native drivers load.
- EFI **filesystem drivers** exist (e.g. efifs, 37 FSes from GRUB2 code; Rufus
  uses one for chain-loading NTFS ESPs).

### 3.5 Graphics
- EFI 1.0 defined **UGA** (Universal Graphic Adapter); UEFI dropped UGA for
  **GOP** (Graphics Output Protocol).
- UEFI 2.1 **HII** manages input, localized strings, fonts, forms (HTML-like)
  for pre-boot config UIs. Default string encoding UTF-16; ASCII allowed for
  ASCII-only strings since UEFI 2.4.
- Early firmware was console-based; modern is GUI-based.

### 3.6 EFI System Partition (ESP)
- Partition accessed by firmware at power-on; holds UEFI apps + their files
  (boot loaders). Partition tables: MBR, GPT, El Torito optical (§2.6.2).
- UEFI defines its **own FAT variant** (FAT12/16/32) maintained inside the
  spec, independent of the original FAT spec (§13.3).
- ESP also reserves a boot sector for BIOS backward compat.

### 3.7 Booting
- **UEFI booting**: no boot sectors. A **boot manager** (part of the spec)
  reads boot config from **NVRAM variables** (paths to OS loaders/kernels) and
  executes the chosen loader.
- **Auto-detect removable media** via standardized path:
  `<ESP>\EFI\BOOT\BOOT<MACHINE>.EFI` → e.g. `\efi\boot\bootx64.efi` (x86-64),
  `\efi\boot\bootaa64.efi` (ARM64).
- UEFI-GPT = booting UEFI from GPT. UEFI-MBR = some firmware falls back to CSM
  on MBR disks (spec requires MBR support, but impls vary).
- "UEFI BIOS" = marketing term for firmware supporting UEFI boot; newer x86
  platforms drop CSM entirely.

#### CSM booting (legacy compat)
- **CSM** (Compatibility Support Module) = legacy BIOS boot from MBR via boot
  sector, ignoring partition table. Lets legacy OSes/option ROMs run.
- Provides legacy **SMM** (CompatibilitySmm) + UEFI SMM — e.g. USB legacy
  keyboard/mouse by emulating PS/2.
- Intel: phase out CSM for clients by 2020 (announced Nov 2017), servers by
  2024 (announced Aug 2023).
- **Jul 2022**: Kaspersky disclosed a rootkit chaining malicious boot code on
  Intel H81 chipset + CSM.

#### Network booting
- **PXE** over IPv4/IPv6, UDP, DHCP, TFTP, iSCSI. SAN boot via iSCSI + FCoE.
- UEFI 2.5 added **HTTP boot**.

#### Secure Boot (study this carefully — it's a project enforcement path)
- Prevents loading UEFI drivers/loaders **not signed** with an acceptable
  digital signature.
- **Mode lifecycle**:
  1. **Setup mode** (fresh) → write the **Platform Key (PK)** to firmware.
  2. **User mode** → only images signed with PK (or chained from it) load.
  3. **Custom mode** → add extra public keys not matching PK's private half.
- **KEK** (Key Exchange Keys): a database of certs that must chain back to PK's
  private key; lets other certificates be trusted.
- Supported by Windows 8/8.1/10/11 + Server 2012–2022, VMware vSphere 6.5,
  Fedora 18+, openSUSE 12.3+, RHEL/CentOS 7+, Debian 10+, Ubuntu 12.04.2+,
  Linux Mint 21.3+, AlmaLinux 8.4+. FreeBSD support still planning (Jan 2025).

**[proj]**: E-HP-UEFI enforcement path depends on Secure Boot state. The
PK/KEK/db model is what determines whether a lockdown-signed loader will run.

### 3.8 UEFI Shell
- Shell = UEFI app that runs other UEFI apps + introspects system/firmware.
- Key commands: `memmap` (memory map), `bcfg` (boot manager variables),
  `diskpart`, `load` (drivers), `edit`, `dmpstore` (variables), `dh`, `pci`,
  `ver`, `set`, `map`, `ls`, `cp`, `rm`, `mkdir`, `mount`, `reset`, etc.
- Shell v2 best on UEFI 2.3+; Shell v1 works on all UEFI.
- Launch: firmware setup option, embedded shell via key combo, or place
  `SHELLX64.EFI` on ESP, or `bcfg` a boot option pointing at it.

**[proj] memory tie-in**: "CapsuleApp.efi must be run from UEFI shell with
args..." — CapsuleApp is a UEFI shell app; the shell is the delivery vehicle
for capsule-based firmware updates in the lockdown flow.

### 3.9 Extensions
UEFI extensions can load from essentially any non-volatile storage — e.g. an
OEM ESP on disk adding functions to the motherboard ROM firmware.

### 3.10 UEFI Capsule (firmware update interface)
- Defines a **firmware-to-OS firmware update interface**.
- Supported by Windows 8/8.1/10 and **Fwupd** (Linux).

**[proj] memory tie-ins**: "FMP capsule payload has a 16-byte FMP_PAYLOAD_HEAD"
and "MISTAKE: Forgot EFI_FIRMWARE_IMAGE_AUTHENTICATION..." — capsules use the
FMP (Firmware Management Protocol) payload format with an authentication
header. Forgetting the auth header breaks signed capsule validation. This is
the mechanism behind the project's capsule-based lockdown enforcement.

### 3.11 Hardware
- Like BIOS: init + test hardware, then load boot loader from storage/network.
- x86: firmware usually in **NOR flash** on motherboard; boot is complex (PCIe
  detection/init). ARM Android/WinPhone: UEFI bootloader in eMMC/eUFS flash.

---

## 4. Classes (transition taxonomy)
| Class | Description |
|---|---|
| 0 | Legacy BIOS |
| 1 | UEFI + CSM, no external UEFI interface (UEFI interfaces internal only) |
| 2 | UEFI + CSM + external UEFI interface (UEFI Boot) |
| 3 | UEFI, no CSM, external UEFI interface |
| 3+ | Class 3 with Secure Boot enabled |

- 10th-gen Intel Core onward: no Legacy Video BIOS for iGPU → legacy boot
  needs a discrete GPU providing VBIOS.

---

## 5. Boot stages (the SEC→PEI→DXE→BDS→TSL→RT pipeline — memorize order)

```
SEC → PEI → DXE → BDS → TSL → RT
```

### SEC — Security Phase (first)
- May be preceded by platform-specific binary (Intel ME, AMD PSP, CPU
  microcode).
- Minimal **assembly** for the specific arch.
- Initializes **temporary memory** (often CPU cache-as-RAM / CAR, or SoC
  on-chip boot processor).
- Acts as the system's **software root of trust** — can verify PEI before
  hand-off.
- Responsibilities: (1) init temp memory for PEI; (2) root of trust — verify
  PEI integrity; (3) pass handoff info to PEI Foundation (temp memory
  location/size, stack location/size, platform state).

### PEI — Pre-EFI Initialization (second)
- Dependency-aware **dispatcher** loads/runs **PEIMs** (Pre-EFI Initialization
  Modules) for early hardware init: main memory (memory controller + DRAM),
  firmware recovery, boot-mode discovery, ACPI S3 resume (restore hardware
  registers to pre-sleep state). Uses CAR.
- Resource-constrained → must stay minimal, just enough to prep DXE.
- Components: **PEI Foundation**, **PEIMs**, **PPI** (PEIM-to-PEIM Interface).
  - **PEI Foundation**: dispatch PEIMs, init permanent RAM, hand off to DXE,
    facilitate PPI communication.
  - **PEI Dispatcher**: invoke PEIMs, manage dependencies.
  - **PEIMs**: minimal drivers, one responsibility each (memory, CPU,
    chipset, board); come from different vendors.
  - **PPI**: data structure of GUID pointer pairs; PEIMs discover PPIs via
    PEI services.
- PEI Foundation dispatches DXE Foundation via a special PPI called **IPL**
  (Initial Program Load).

### DXE — Driver Execution Environment
- **C modules** + dependency-aware dispatcher. Main memory now available.
- CPU, chipset, board, I/O devices initialized here and in BDS.
- Assigns **EFI device paths** to hardware; transfers config data to hardware.

### BDS — Boot Device Select (Boot Manager)
- Part of DXE. Boot devices initialized; UEFI drivers / PCI **Option ROMs**
  executed per **NVRAM** architecturally-defined variables; OS boot loaders
  (e.g. Windows Boot Manager) started.

### TSL — Transient System Load
- Between BDS and OS hand-off. Can enter UEFI Shell or run a UEFI app (e.g. OS
  boot loader).

### RT — Runtime
- After `ExitBootServices()`, firmware hands off to OS.
- Firmware unloads unneeded code/data, leaving only **runtime services**
  (SMM, ACPI). Modern OS prefers its own drivers for hardware.
- Legacy OS: CSM handles this call for BIOS compatibility.

**Study hook**: SEC and PEI are pre-memory/pre-C (assembly + minimal); DXE
onward is C with full memory. The trust chain is SEC → PEI → DXE. NVRAM
variables (boot config, Secure Boot keys) are consumed at BDS.

---

## 6. Usage

### Implementations
- **Intel Tiano** (Platform Innovation Framework): XScale, Itanium, IA-32,
  x86-64; proprietary, partial BSD/EPL release as **TianoCore EDK II**. Can be
  a coreboot payload.
- **Phoenix SecureCore (SCT)**, **AMI Aptio**, **Insyde InsydeH2O**, **Byosoft
  ByoCore**.
- **Project Mu** (Microsoft, Dec 2018, open-source TianoCore EDK II fork from
  Surface).
- **Das U-Boot** got a UEFI API (2017); ARMv8 Linux distros use U-Boot UEFI +
  GRUB; iPXE can be a UEFI app loaded by U-Boot for iSCSI boot.

### Platforms (timeline highlights)
- 2000: Itanium workstations/servers, EFI 1.02.
- 2002: HP Itanium 2, EFI 1.10 (booted Windows/Linux/FreeBSD/HP-UX).
- 2003: OpenVMS UEFI (Jun); OpenVMS IA-64 eval Dec 2003, prod Jan 2005.
- Jan 2006: Apple's first Intel Macs used EFI (replaced Open Firmware); Boot
  Camp (Apr 2006) added BIOS compat via firmware update.
- 2005: >1M Intel UEFI systems shipped **[weak: failed verification]**.
- 2008: x86-64 UEFI adoption (some CSM-only, some true UEFI — IBM x3450, MSI
  ClickBIOS, HP EliteBook).
- 2009: IBM System x, Dell PowerEdge servers with UEFI.
- 2011: consumer boards (ASRock/Asus/Gigabyte/MSI) on Intel 6-series LGA1155
  + AMD 9-series AM3+.
- Oct 2012: Win8 cert requires UEFI; Connected-Standby systems must NOT have
  CSM (can't boot legacy BIOS OSes).
- Oct 2017: Intel removing legacy BIOS by 2020 → Class 3; by 2019 all
  Intel-platform PCs are UEFI-only.

### Operating systems (EFI-aware)
Default loader path: `<ESP>/BOOT/BOOT<MACHINE>.EFI` (IA32/X64/IA64/ARM/AA64).
- Linux: EFI since early 2000s (elilo → GRUB/systemd-boot); EFI boot stub lets
  kernel be its own loader; ACPI (PC) or DeviceTree (mobile) with UEFI.
- HP-UX (IA-64 since 2002), OpenVMS (IA-64 since 2003; x86-64 too), Apple
  Intel Macs (EFI v1.10 32-bit until OS X 10.8), Windows IA-64 (XP 64-bit /
  Server 2003, DIG64 requirement), Windows x86-64 (Vista SP1 / Server 2008 —
  UGA 1.1 / INT 10h only, no GOP → Class 2), Windows 8 (GOP, 32-bit UEFI,
  Secure Boot, faster startup), Windows 11 (UEFI mandatory; IoT Enterprise
  24H2 excepted).
- FreeBSD (UEFI amd64 in 10.1, arm64 in 11.0), NetBSD 8.0 (i386/amd64) / 9.0
  (ARM), Solaris 11.1+ (GRUB2), OpenBSD 5.9 (x86-64) / 6.0 (ARMv7), illumos
  (Oct 2017), ArcaOS 5.1 (emulates INT 10h/13h).

### With virtualization
- HP Integrity VMs (UEFI boot + virtualized UEFI for guests).
- Intel **OVMF** (Open Virtual Machine Firmware) on SourceForge → used by
  QEMU/KVM with TianoCore.
- VMware Fusion 3 (Mac OS X Server UEFI), Workstation 11+ (UEFI), 14+
  (Secure Boot), ESXi 5.0 (UEFI), 6.5 (Secure Boot).
- VirtualBox 3.1+ (UEFI; limited — Unix/Linux + Win8+, not Vista/7 x64).
- Hyper-V gen2 VMs (virtualized UEFI).
- GCP Shielded VMs (virtualized UEFI for Secure Boot).

**[proj]**: OVMF is what you use to test UEFI enforcement paths in QEMU
without real HP hardware (matches memory: "OVMF requires GPT with ESP type
code..."). Real-hardware verification is graph invariant I3.

---

## 7. Vulnerabilities
- UEFI impl flaws exploited for **persistence** — surviving reboot, OS
  reinstall, even partial physical part replacement (e.g. corrupted PCI
  persistent flash).
- 2023: vulns even **with Secure Boot enabled**.
- 2023: Microsoft warned about **BlackLotus** UEFI malware.

---

## 8. Applications development
- **EADK** (EDK2 Application Development Kit): standard C library functions in
  UEFI apps. Free from Intel's TianoCore UDK/EDK2 (moved to GitHub since
  UDK2015). Example: a Python interpreter ported as a UEFI app via EADK.

---

## 9. Criticism

### General
- Ronald G. Minnich (coreboot co-author) + Cory Doctorow: UEFI removes user
  control of the computer; UEFI perpetuates the "two drivers per device"
  (firmware + OS) historic arrangement.
- TianoCore lacks chipset-init drivers/modules → used as a coreboot payload;
  coreboot needs chipset-mfr cooperation for init-driver specs.

### Secure Boot criticism (the big controversy)
- **2011**: Microsoft required Win8-certified PCs to ship with MS public key
  enrolled + Secure Boot enabled → UEFI becomes mandatory for those devices.
- FSF + open-source advocates feared Secure Boot as Linux lock-in. Microsoft
  denied lock-in; required x86 Win8-cert systems to allow Custom Mode or
  disable — but **not on ARM**. Win10 lets OEMs decide whether x86 users can
  manage Secure Boot.
- **GPLv3 concern** (Matthew Garrett, ex-Red Hat): GPLv3 may prevent GRUB use
  without the distro disclosing its private key (FSF later clarified: key
  availability is the hardware mfr's responsibility). Hard for advanced users
  to build custom kernels that work under Secure Boot without self-signing.
- **shim** (Garrett): minimal precompiled signed bootloader that lets users
  individually trust distro keys. Distros split:
  - **Ubuntu 12.10**: shim + Canonical key, signs **only the bootloader**,
    allows unsigned kernels (rationale: trusted kernel secures only user
    space, not pre-boot; lets users build custom kernels/modules).
  - **Fedora**: shim, but signs **kernel + modules** too.
  - **MOK** (Machine Owner Key): sign locally compiled kernels/software
    without entering setup mode (managed by shim's MokManager).
- Dispute: spec doesn't require kernel+module signing, but MS contractually
  requires it and reserves right to revoke certs. Windows requires all kernel
  drivers signed under Secure Boot (non-WHQL may be refused).
- Feb 2013: Red Hat dev proposed a kernel patch to parse MS authenticode via
  an X.509 master key in PE files signed by MS → **Linus Torvalds rejected**,
  arguing Red Hat was accommodating MS control over Secure Boot.
- Mar 2013: Hispalinux filed EU Commission complaint — MS Secure Boot
  requirements "obstructive" + anti-competitive.
- Aug 2013 (Black Hat): researchers presented exploits in vendor UEFI impls
  to bypass Secure Boot.
- **Aug 2016**: "golden key" — researchers found an exploitable binary signed
  by MS's signing key (not the key itself). Enables rootkit/bootkit risk;
  complicates remediation (signed exploitable binary can be re-flashed to
  downgrade a patch). MS: affects ARM/Windows RT only; released 2 updates
  (incomplete — full fix needs key replacement in end-user firmware) **[weak:
  citation needed]**.
- **1 Mar 2023**: ESET reported **BlackLotus** — first active UEFI bootkit
  bypassing Secure Boot by exploiting limits of prior security updates.
- **Aug 2024**: Win10/Win11 security updates applied **SBAT** (Secure Boot
  Advanced Targeting) to UEFI NVRAM → refused buggy/vulnerable intermediate
  loaders (old Win Boot Manager, GRUB) → **broke some Linux distros**.
  Reverted next month. SBAT is supported by new Win Boot Manager + shim.
- **Jun 2025 (LWN)**: MS UEFI CA 2011 cert expires **24 Jun 2026** → may
  refuse some Linux under Secure Boot. Mitigation: TianoCore EDK II + many
  commercial impls (AMI Aptio) **disable cert time/date checks by default**.

---

## Study checklist (self-test)

1. Name the 6 boot stages in order and the resource boundary between PEI and
   DXE. *(Answer: SEC→PEI→DXE→BDS→TSL→RT; PEI is pre-RAM/CAR, DXE has full
   memory and is C.)*
2. What's the difference between boot services and runtime services, and what
   call transitions between them? *(ExitBootServices().)*
3. Secure Boot mode lifecycle: setup → user → custom. What are PK, KEK, db?
4. Why does a 64-bit CPU with 32-bit UEFI firmware only run 32-bit UEFI apps,
   and what's the runtime-services caveat after mode switching?
5. Standard removable-media boot path on x86-64 and ARM64.
6. What is the ESP, what FS does it use, and why does UEFI maintain its own
   FAT variant?
7. What is CSM, why is it being phased out, and what rootkit abused it (2022)?
8. UEFI Capsule + FMP: what's the payload header, and what auth header must
   not be forgotten? *(proj: 16-byte FMP_PAYLOAD_HEAD; EFI_FIRMWARE_IMAGE_
   AUTHENTICATION.)*
9. shim vs MOK: who signs what in Ubuntu vs Fedora, and why the split?
10. SBAT (2024) and the 2026 MS UEFI CA 2011 expiry — what broke and what's
    the default mitigation?
11. UEFI Classes 0–3+: which has CSM, which has Secure Boot?
12. Name 4 production UEFI implementations + the open reference. *(AMI Aptio,
    Phoenix SecureCore, Insyde InsydeH2O, Byosoft ByoCore; TianoCore EDK II.)*

---

## Answer Key (researched against primary sources)

Each answer cites the primary source that owns the claim. Sources are UEFI
spec 2.11, UEFI PI spec 1.9, EDK2 source/docs, Microsoft secureboot_objects
wiki, Kaspersky Securelist, LWN, Red Hat, Canonical, and distro wikis.

### A1. Boot stages + the PEI→DXE resource boundary

**Order: SEC → PEI → DXE → BDS → TSL → RT.**

The PEI→DXE boundary is the **permanent-memory boundary**:
- **PEI** runs before DRAM is initialized. It uses **cache-as-RAM (CAR)** —
  the SEC phase programs the processor cache into "no evictions mode" so
  reads/writes hit the cache without backing store, since main memory isn't
  configured yet. PEI is minimal (assembly + small modules) because resources
  are scarce. Its final job is to initialize permanent memory and hand off to
  DXE via the **DXE IPL PPI**.
- **DXE** runs with full main memory available. It's written in **C**, has a
  dependency-aware dispatcher, and performs most system initialization
  (CPU, chipset, board, I/O). The PEI→DXE handoff state is passed through a
  list of position-independent data structures called **Hand-Off Blocks
  (HOBs)** — at minimum: resource descriptor HOBs for physical memory, the
  BSP stack HOB, firmware-volume HOBs, and the boot-strap processor store HOB.

The trust chain is **SEC → PEI → DXE**: SEC is the root of trust and may
authenticate the PEI Foundation before invoking it; PEI then preps DXE.

**Sources:**
- UEFI PI Spec 1.9, §13 Security (SEC) Phase Information — SEC creates
  temporary memory (cache "no evictions mode"), is the root of trust, passes
  BFV/temp-RAM/stack handoff info to PEI.
  <https://uefi.org/specs/PI/1.9/V1_Security_SEC_Phase_Information.html>
- UEFI PI Spec 1.9, §2 Overview — "PEI...is responsible for initializing
  permanent memory...The state of the system at the end of the PEI phase is
  passed to the DXE phase through...Hand-Off Blocks (HOBs)."
  <https://uefi.org/specs/PI/1.9/V2_Overview.html>
- UEFI PI Spec 1.8, §9 PEI to DXE Handoff — "PEI Foundation uses a special
  PPI named the DXE Initial Program Load (IPL) PPI to discover and dispatch
  the DXE Foundation."
  <https://uefi.org/specs/PI/1.8/V1_PEI_to_DXE_Handoff.html>

### A2. Boot services vs runtime services; the transition call

| | Boot services | Runtime services |
|---|---|---|
| Available | only before `ExitBootServices()` succeeds | before AND after `ExitBootServices()` |
| Purpose | device access, memory allocation, console, image loading | time, variables (NVRAM), GOP framebuffer, capsule update |
| Owner | UEFI OS loader uses them to prep the OS boot | OS calls them at runtime |

`ExitBootServices()` is the **only** transition. Per the UEFI spec: "All
boot services functionality is available until a UEFI OS loader loads enough
of its own environment to take control of the system's continued operation
and then terminates boot services with a call to `ExitBootServices()`."
After it returns successfully, only runtime services may be called.

Two runtime-services addressing caveats from the spec:
- The OS must switch to **flat physical addressing mode** to make a runtime
  call (or virtual mode if it has called `SetVirtualAddressMap()`).
- Runtime services may be called with interrupts enabled; the firmware
  internally disables interrupts when needed and restores the entry state.

**Sources:**
- UEFI Spec 2.11, §7 Services — Boot Services
  <https://uefi.org/specs/UEFI/2.11/07_Services_Boot_Services.html>
- UEFI Spec 2.11, §8 Services — Runtime Services
  <https://uefi.org/specs/UEFI/2.11/08_Services_Runtime_Services.html>
- UEFI Spec 2.10, §2 Overview — runtime services require flat physical or
  virtual addressing mode after `SetVirtualAddressMap()`.
  <https://uefi.org/specs/UEFI/2.10/02_Overview.html>

### A3. Secure Boot lifecycle: setup → user → custom; PK, KEK, db

**Mode lifecycle:**
- **Setup mode** — no PK is enrolled. Secure variables (PK/KEK/db/dbx) can be
  written **without** the usual authentication checks (the auth descriptor
  must still be present but isn't verified). Secure Boot is **off** in this
  mode. Most firmware auto-transitions to User/Custom mode at next boot once
  a PK is enrolled.
- **User mode** — PK is enrolled. Every write to a secure variable must carry
  a validly signed authentication descriptor. Secure Boot is **on by default**
  and only executes EFI binaries that (a) are unsigned but have a SHA-256
  hash in `db` and not `dbx`, or (b) are signed with a cert in `db` and not
  in `dbx`, or (c) are signed by a key in KEK or db with neither key nor
  signature in `dbx`.
- **Custom mode** — the system owner can change PK/KEK/db/dbx freely, owning
  the chain of trust completely. This is the recommended mode for
  self-managed platforms (e.g. FoundriesFactory LmP).

**The four key stores (hierarchical):**
| Store | Variable | Count | Owner | Signs what |
|---|---|---|---|---|
| **Platform Key (PK)** | `PK` | exactly 1 | OEM | KEK updates (and can sign db/dbx updates). Root of trust. **Cannot** be used to sign boot-time binaries. |
| **Key Exchange Key (KEK)** | `KEK` | multiple | OS vendor (e.g. Microsoft) + optional OEM | db and dbx updates. Can sign bootable content but this is discouraged. |
| **Authorized Database (db)** | `db` | many entries | OS/OEM | certs or SHA-256 hashes of **allowed** boot binaries. |
| **Forbidden Database (dbx)** | `dbx` | many entries | OS/OEM | certs/hashes of **revoked/blocked** binaries. |

Hierarchy: PK → KEK → db/dbx. PK is the trust anchor; KEK keys authorize db
updates; db entries authorize boot images. All keys are RSA-2048 (or
stronger) X.509 certs, or RSA2048-type for the secure-variable auth format.

**Sources:**
- UEFI Spec 2.3.1c §7.2 (secure variables) — via James Bottomley's
  authoritative write-up "The Meaning of all the UEFI Keys"
  <https://blog.hansenpartnership.com/the-meaning-of-all-the-uefi-keys/>
- UEFI Summit 2012, "Deploying Secure Boot: Key Creation and Management"
  (PDF) — PK/KEK/db/dbx roles, RSA-2048 requirement, key deployment process.
  <https://uefi.org/sites/default/files/resources/1_-_UEFI_Summit_Deploying_Secure_Boot_July_2012_0.pdf>
- Microsoft secureboot_objects wiki, "Secure Boot Workflow" — hierarchical
  key structure diagram, setup/user/custom mode definitions.
  <https://github.com/microsoft/secureboot_objects/wiki/Secure-Boot-Workflow>
- FoundriesFactory docs — PK "cannot be used for signing binaries that are
  verified at boot time"; Custom Mode = owner controls all key stores.
  <https://docs.foundries.io/latest/reference-manual/security/secure-boot-uefi.html>

### A4. Bit-width lock + the runtime-services mode-switch caveat

**Why a 64-bit CPU with 32-bit UEFI firmware only runs 32-bit UEFI apps:**
UEFI firmware is compiled for one machine mode (e.g. IA-32 or x64). Per the
spec, images are loaded as PE32+ and control is transferred "according to
the normal indirect calling conventions of applications based on supported
32-bit, 64-bit, or 128-bit processors." An x64 UEFI firmware **does not
include support for launching 32-bit EFI applications** — there is no
thunking layer in firmware (unlike x86_64 Linux/Windows, which can run
32-bit user code). The EFI app must be compiled for the firmware's exact
bitness/architecture. This is why some low-cost devices shipped with 32-bit
UEFI on 64-bit CPUs caused boot headaches.

**The runtime-services caveat after mode switching:**
Once a UEFI app calls `ExitBootServices()` and the OS takes full control,
the OS **can** switch the processor to a different execution mode (e.g. a
64-bit OS kernel running on 32-bit UEFI firmware switches to long mode).
**But** runtime services may only be called from the **same processor mode
as the firmware implementation**. So if the OS wants to call a runtime
service (read a UEFI variable, trigger a capsule update), it must briefly
switch back to the firmware's original mode (e.g. 32-bit protected mode),
make the call, then return to its native mode. This is why Linux's EFI
mixed-mode support exists — it lets a 64-bit kernel boot on 32-bit EFI
firmware, but runtime calls still require the mode switch.

**Sources:**
- UEFI Spec 2.11 §2.3.2 / §2.3.4 (processor mode constraints) — referenced
  by the Wikipedia article and confirmed by ArchWiki: "An x64 UEFI firmware
  does not include support for launching 32-bit EFI applications...the EFI
  application must be compiled for that specific firmware processor
  bitness/architecture."
  <https://wiki.archlinux.org/title/Unified_Extensible_Firmware_Interface>
- UEFI Spec 2.10 §2 Overview — "Runtime service functions are available
  during the boot process and also at runtime provided the OS switches into
  flat physical addressing mode to make the runtime call."
  <https://uefi.org/specs/UEFI/2.10/02_Overview.html>
- LWN, "EFI mixed mode" (Matt Fleming, 2014) — Linux CONFIG_EFI_MIXED
  enables booting a 64-bit kernel on 32-bit EFI; no boot loader changes
  needed if it uses the EFI handover protocol.
  <https://lwn.net/Articles/589193/>

### A5. Standard removable-media boot path

The UEFI spec defines a standardized file path for auto-detection of OS
loaders on removable media, so firmware can boot a USB drive without a
pre-configured NVRAM boot entry:

```
<EFI_SYSTEM_PARTITION>\EFI\BOOT\BOOT<MACHINE_TYPE_SHORT_NAME>.EFI
```

| Architecture | Short name | Path |
|---|---|---|
| x86-64 | X64 | `\efi\boot\bootx64.efi` |
| ARM64 | AA64 | `\efi\boot\bootaa64.efi` |
| IA-32 | IA32 | `\efi\boot\bootia32.efi` |
| Itanium | IA64 | `\efi\boot\bootia64.efi` |
| ARM (32-bit) | ARM | `\efi\boot\bootarm.efi` |

**Source:** UEFI Spec 2.11 §3.5.1.1 (the Wikipedia article cites this
section directly). The path is `<ESP>/BOOT/BOOT<MACHINE>.EFI` with the
short names IA32/X64/IA64/ARM/AA64.

### A6. ESP, the FAT variant, and why UEFI maintains its own

**What it is:** The EFI System Partition (ESP) is a partition accessed by
firmware at power-on; it stores UEFI applications (boot loaders, kernels,
utilities) and their files. It can sit on a GPT or MBR disk (or El Torito
optical). Its GPT partition type GUID is `C12A7328-F81F-11D2-BA4B-
00A0C93EC93B`; its MBR partition ID is `0xEF`.

**What FS it uses:** UEFI mandates support for FAT12, FAT16, and FAT32 —
**but the choice is media-size-driven**: FAT32 for fixed-disk system
partitions, FAT12 or FAT16 for removable media. In practice most firmware
only implements FAT32 reliably on real hardware; FAT16 works on some
platforms; FAT12 is rarely implemented.

**Why UEFI maintains its own FAT variant (the key insight):** UEFI does
**not** use "plain FAT." It defines a specific, frozen version of FAT —
called the "EFI file system" — that is explicitly documented and testable
within the UEFI spec (§13.3). The spec states:

> "EFI defines a specific version of FAT that is explicitly documented and
> testable. Conformance to the EFI specification...is the only definition
> of FAT that needs to be implemented to support EFI. To differentiate the
> EFI file system from pure FAT, a new partition file system type has been
> defined."

The reason: **the original FAT spec evolved over time with errata and
variant interpretations across OS drivers and utilities.** UEFI freezes a
single target so firmware vendors implement one predictable format, not a
moving target. "The definition of the EFI file system will be maintained by
specification and will not evolve over time to deal with errata...Future
enhancements and compatibility enhancements to FAT will not be
automatically included in EFI file systems." This is why the ESP has its
own partition type GUID distinct from generic FAT — it signals "this is the
EFI-frozen FAT, not a normal FAT volume."

**Sources:**
- UEFI Spec 2.11 §13.3.1.1 File System Format — "The EFI firmware must
  support the FAT32, FAT16, and FAT12 variants of the EFI file system. What
  variant of EFI FAT to use is defined by the size of the media."
- UEFI Spec 2.9 §13.3 — "EFI encompasses the use of FAT32 for a system
  partition, and FAT12 or FAT16 for removable media." (quoted in
  fedora-coreos-tracker #993)
  <https://github.com/coreos/fedora-coreos-tracker/issues/993>
- Superuser answer quoting UEFI spec §12.3.1 — the "frozen FAT" rationale
  and the distinct partition type.
  <https://superuser.com/questions/1025423/uefi-exfat-partition>
- ArchWiki ESP — GPT type GUID, MBR ID 0xEF, FAT32 recommendation.
  <https://wiki.archlinux.org/title/ESP>
- OSDev Wiki — "In reality most firmware only support FAT32."
  <https://wiki.osdev.org/EFI_System_Partition>

### A7. CSM, its phase-out, and the 2022 rootkit

**What CSM is:** The Compatibility Support Module (CSM) is an optional
firmware component that provides legacy BIOS compatibility — it lets UEFI
firmware boot legacy OSes and option ROMs from MBR-partitioned disks via
the boot sector, ignoring the partition table. It also provides legacy
System Management Mode (SMM) functions (e.g. USB legacy keyboard/mouse by
emulating PS/2). A system with CSM can boot in either UEFI mode or legacy
BIOS mode.

**Why it's being phased out:**
- **Nov 2017**: Intel announced it would remove legacy PC BIOS support
  (CSM) from all client platforms by 2020, in favor of UEFI Class 3.
- **By 2019**: all Intel-platform PCs shipped UEFI-only (no CSM).
- **Aug 2023**: Intel announced phasing out CSM for server platforms by 2024.
- **Oct 2012**: Windows 8 certification already required UEFI, and systems
  supporting "Connected Standby" were forbidden from shipping a CSM.
- 10th-gen Intel Core onward: no Legacy Video BIOS for the iGPU, so legacy
  boot needs a discrete GPU providing VBIOS.

**The 2022 rootkit that abused CSM: CosmicStrand** (Kaspersky, July 2022).
- Found in modified UEFI firmware images of **Gigabyte and ASUS motherboards
  using the Intel H81 chipset** (2013–2015 hardware).
- The attackers **patched the `CSMCORE` DXE driver** — the driver that
  facilitates legacy boot via MBR. Its entry point was redirected to
  attacker code in the `.reloc` section.
- The malicious code hooks `HandleProtocol` boot service, identifies a
  specific component to infect (the Windows boot loader `bootmgfw.efi`),
  hooks the Windows kernel loader, and injects a shellcode that fetches a
  payload after a sleep. It also tries to disable PatchGuard.
- Persistence: lives in the SPI flash on the motherboard — survives disk
  wipes and OS reinstalls. Active since late 2016; an earlier variant was
  documented by Qihoo360 as "Spy Shadow Trojan."
- Infection vector unknown; possibly an automated patcher requiring physical
  access or a prior implant. One victim had a second-hand ASUS motherboard
  from an online store.

**Sources:**
- Kaspersky Securelist, "CosmicStrand: the discovery of a sophisticated UEFI
  firmware rootkit" — technical details, H81 chipset, CSMCORE DXE driver
  patching, execution chain.
  <https://securelist.com/cosmicstrand-uefi-firmware-rootkit/106973/>
- Kaspersky blog, "CosmicStrand rootkit hides in the UEFI firmware" —
  persistence, victim profile.
  <https://www.kaspersky.com/blog/cosmicstrand-uefi-rootkit/45017/>
- BleepingComputer, "CosmicStrand UEFI malware found in Gigabyte, ASUS
  motherboards" — Qihoo360 "Spy Shadow Trojan" earlier name, Mark Lechtik
  quote on CSMCORE modification.
  <https://www.bleepingcomputer.com/news/security/cosmicstrand-uefi-malware-found-in-gigabyte-asus-motherboards/>

### A8. UEFI Capsule + FMP: payload header and auth header

**The on-disk layout of a signed FMP capsule payload (in order):**

```
EFI_FIRMWARE_IMAGE_AUTHENTICATION   ← the auth header (MUST come first)
  UINT64                  MonotonicCount   ← 8 bytes, anti-replay
  WIN_CERTIFICATE_UEFI_GUID  AuthInfo      ← variable-length cert + signature
FMP_PAYLOAD_HEADER                  ← 16 bytes
  UINT32  Signature                 ← 'MSS1' = 0x3153534D (little-endian)
  UINT32  HeaderSize                ← 16
  UINT32  FwVersion
  UINT32  LowestSupportedVersion
<actual firmware image bytes>       ← the payload being updated
```

**The 16-byte `FMP_PAYLOAD_HEADER`**: `{ Signature, HeaderSize, FwVersion,
LowestSupportedVersion }` — four UINT32s = 16 bytes. Signature is
`SIGNATURE_32('M','S','S','1')` = `0x3153534D` read as a little-endian
UINT32. This header is processed by `FmpPayloadHeaderLib` in EDK2's
`FmpDevicePkg`.

**The auth header that must not be forgotten: `EFI_FIRMWARE_IMAGE_AUTHENTICATION`**:
```c
typedef struct {
    UINT64                    MonotonicCount;   // anti-replay; included in AuthInfo signature
    WIN_CERTIFICATE_UEFI_GUID AuthInfo;         // cert + signature over (payload + MonotonicCount)
} EFI_FIRMWARE_IMAGE_AUTHENTICATION;
```
- `MonotonicCount` (8 bytes) is incremented on every firmware image
  operation and is included in the signed data of `AuthInfo` to guarantee
  freshness / prevent replay attacks.
- `AuthInfo` is a `WIN_CERTIFICATE_UEFI_GUID` carrying the X.509 cert and
  the RSA signature.
- The auth header comes **before** the FMP payload header. Forgetting it
  (or forgetting that `MonotonicCount` precedes `WIN_CERTIFICATE`) produces
  an unsigned capsule that a Secure-Boot-enforcing FMP device will reject —
  this was a recorded project mistake (memory m-036).
- `CERTIFICATE_GUID` and `MONOTONIC_COUNT` in the FDF `[FmpPayload]`
  section must be provided as a pair; if `CERTIFICATE_GUID` is omitted, the
  capsule is processed as unsigned (non-authenticated) FMP and
  `MONOTONIC_COUNT` must NOT be provided.

**Sources:**
- EDK2 PyTool Library (edk2toollib), "Fmp auth header" — the
  `EFI_FIRMWARE_IMAGE_AUTHENTICATION` struct definition and field semantics.
  <https://www.tianocore.org/edk2-pytool-library/api/uefi/fmp_auth_header/>
- EDK2 PyTool Library, "Fmp payload header" — the `FMP_PAYLOAD_HEADER`
  struct (4 × UINT32 = 16 bytes) and `FMP_PAYLOAD_HEADER_SIGNATURE` =
  `SIGNATURE_32('M','S','S','1')`.
  <https://www.tianocore.org/edk2-pytool-library/api/uefi/edk2/fmp_payload_header/>
- EDK2 FDF Spec, §3.8 [FmpPayload] Sections — `CERTIFICATE_GUID` and
  `MONOTONIC_COUNT` must work as a pair.
  <https://tianocore-docs.github.io/edk2-FdfSpecification/draft/3_edk_ii_fdf_file_format/38_[fmppayload]_sections.html>
- EDK2 source, `BaseTools/Source/Python/Capsule/GenerateCapsule.py` —
  decode order: FmpAuthHeader → FmpPayloadHeader.
  <https://github.com/tianocore/edk2/blob/master/BaseTools/Source/Python/Capsule/GenerateCapsule.py>
- Dasharo Universe, "Capsule Updates Details" — `MonotonicCount` guards
  against replay; appended to payload before signing.
  <https://docs.dasharo.com/kb/edk2-capsule-updates/>

### A9. shim vs MOK: Ubuntu vs Fedora signing split

**shim** is a small, precompiled, Microsoft-signed first-stage bootloader
(developed by Matthew Garrett) that lets users individually trust
distribution-provided keys. It loads the next stage (GRUB2/systemd-boot/
kernel) and validates it against keys it trusts. shim is signed by
Microsoft's UEFI CA so it boots on any Secure-Boot-enabled PC whose db
contains the Microsoft key (which is nearly all of them).

**MOK (Machine Owner Key)** is a key the **machine owner** generates and
enrolls into shim's trust store via **MokManager** (`mm.efi`, an EFI app
bundled with shim). MOK lets the owner sign locally-compiled kernels or
out-of-tree kernel modules **without** entering firmware Setup mode or
changing the platform PK. On boot, shim mirrors MOK keys into a UEFI
runtime variable and a UEFI config table; the kernel loads them into the
platform keyring. MOK is managed by `mokutil` in the OS.

**The Ubuntu vs Fedora split:**
| | Ubuntu | Fedora |
|---|---|---|
| shim signs | the **bootloader only** (shim → GRUB2) | the **bootloader** (shim → GRUB2) |
| kernel signed? | **No** — kernels can be unsigned | **Yes** — kernel is signed with a Fedora key |
| kernel modules signed? | **No by default**, but DKMS modules must be MOK-signed to load under Secure Boot | **Yes** — in-tree modules are signed; loading checks enforced |
| user-built kernels | work without re-signing (shim trusts the next stage, kernel isn't validated by shim) | must be self-signed with a MOK or Fedora key |
| rationale | "a trusted kernel secures only user space, not the pre-boot state Secure Boot is designed to protect" — so signing only the bootloader is more feasible and lets users build custom kernels/modules | defense in depth — validate the whole chain: bootloader + kernel + modules |

**Why the split matters:** Ubuntu's choice maximizes user flexibility
(custom kernels, DKMS modules via MOK) at the cost of a weaker chain
(only the bootloader is cryptographically anchored). Fedora's choice
maximizes integrity (the whole boot chain is signed) at the cost of
harder custom-kernel workflows. Both use shim + MOK; they differ in
**how far down the chain the distro key extends.**

**Sources:**
- Ubuntu Wiki, "UEFI/SecureBoot/DKMS" — DKMS modules need MOK signing or
  Secure Boot disabled; `mokutil --import` enrollment flow.
  <https://wiki.ubuntu.com/UEFI/SecureBoot/DKMS>
- Canonical, "How to sign things for Secure Boot" — MOK key generation,
  enrollment in shim, `kmodsign` for modules, the full trust chain from
  firmware → bootloader → kernel → modules.
  <https://canonical.com/blog/how-to-sign-things-for-secure-boot>
- Fedora Project Wiki, "Features/SecureBoot" — shim holds a Fedora key;
  kernel checks loaded module signatures and refuses unsigned ones; grub2
  operates with supervisory-password-like restrictions under Secure Boot.
  <https://www.fedoraproject.org/wiki/Features/SecureBoot>
- Roderick Smith (rodsbooks), "Signing Kernel Modules for Secure Boot" —
  distros that support Secure Boot (Fedora, openSUSE, Ubuntu) provide
  signed kernels; the relationship between Secure Boot keys and module
  signing.
  <https://www.rodsbooks.com/efi-bootloaders/sb-modules.html>
- Ubuntu Community Hub — MOK keys enrolled by mokmanager into UEFI
  variable storage; shim mirrors them to RT variable + UEFI config table;
  kernel loads them into the platform keyring.
  <https://discourse.ubuntu.com/t/does-the-ubuntu-kernel-carry-a-downstream-patch-which-enables-loading-mok-keys-into-kernel-keyring/25849>

### A10. SBAT (2024) and the 2026 MS UEFI CA 2011 expiry

**SBAT (Secure Boot Advanced Targeting) — what broke in Aug 2024:**
- SBAT is a **shim-ecosystem mechanism for revoking boot components by
  generation**, separate from the db/dbx revocation mechanism. It's
  supported by new Windows Boot Manager and shim. SBAT metadata in UEFI
  applications lets the loader refuse buggy/vulnerable intermediate
  bootloaders (identified by component name + generation number) without
  revoking an entire certificate.
- **August 2024**: Windows 10/11 security updates applied an SBAT setting
  to devices' UEFI NVRAM to block boot managers vulnerable to
  **CVE-2022-2601** (a GRUB2 Secure Boot bypass). The intent was to block
  old, vulnerable Windows Boot Manager and GRUB2 versions.
- **What broke**: the SBAT update was supposed to skip dual-boot systems,
  but Microsoft's dual-boot detection failed on some customized
  dual-boot setups, so SBAT was applied where it shouldn't have been.
  Result: Linux distros (Ubuntu, Linux Mint, Zorin OS, Puppy Linux, and
  others) failed to boot with the error `"Verifying shim SBAT data failed:
  Security Policy Violation. SBAT self-check failed: Security Policy
  Violation."`
- **Fix**: Microsoft reverted the SBAT update the next month (Sep 2024).
  The verified recovery for affected systems was: disable Secure Boot,
  install the latest distro version (with an updated shim), re-enable
  Secure Boot.

**MS UEFI CA 2011 expiry (June 26/27, 2026) — what breaks and the mitigation:**
- The **Microsoft Corporation UEFI CA 2011** certificate (used to sign
  Linux shims and option ROMs) **expires June 26–27, 2026**. It is being
  replaced by the **Microsoft UEFI CA 2023** (expires 2038).
- **What actually breaks (the common misconception vs. reality):**
  - **Expiration is NOT revocation.** UEFI Secure Boot validates a
    signature against the trust database (db) and revocation state (dbx),
    **not against the certificate's validity period.** Firmware is
    generally designed to **ignore certificate expiration** when
    evaluating whether a signature is valid.
  - Existing 2011-signed shims **keep booting** after June 2026 on systems
    that still trust the 2011 CA.
  - The real risk: once an OS vendor ships a shim signed **only** by the
    2023 CA, any system whose firmware does **not** already trust the 2023
    CA will fail to boot. The work is to confirm (before that update
    arrives) that systems trust the 2023 CA.
- **Mitigation (default + operational):**
  - **Default mitigation (already in place)**: TianoCore EDK II and many
    commercial UEFI implementations (e.g. AMI Aptio) **disable
    time/date checks for Secure Boot certificates by default** — so
    expiration alone doesn't block booting.
  - **Dual-signed shims**: since October 2025, Microsoft signs shims with
    **both** the 2011 and 2023 keys. Red Hat shipped dual-signed shims
    starting with RHEL 9.8 / 10.2; RHEL 8 gets them in June 2026. As long
    as either cert is trusted, the shim boots.
  - **Firmware db updates**: OEMs may ship firmware updates that enroll
    the 2023 CA into db. No plans to revoke the 2011 cert soon (option
    ROMs signed with it would break).

**Sources:**
- Microsoft Community Hub, "What IT teams need to know about Linux Secure
  Boot certificates expiring in 2026" — expiration ≠ revocation; firmware
  validates against db/dbx not validity period; 2023 CA replacement;
  dual-signing since Oct 2025.
  <https://techcommunity.microsoft.com/blog/linuxandopensourceblog/what-it-teams-need-to-know-about-linux-secure-boot-certificates-expiring-in-2026/4530725>
- Red Hat blog, "Expiration of Secure Boot signing certificates in 2026"
  — dual-signed shims for RHEL 9/10; 2011 cert not being revoked; option
  ROMs also signed with 2011.
  <https://www.redhat.com/en/blog/expiration-secure-boot-signing-certificates-2026>
- LWN, "Secure Boot certificate expiration is here" — MS UEFI CA 2011
  expired June 26, 2026; firmware ignores cert expiration by design; 2023
  CA expires 2038.
  <https://lwn.net/Articles/1079808/>
- BleepingComputer, "Microsoft confirms August updates break Linux boot in
  dual-boot systems" — SBAT update for CVE-2022-2601; error message;
  dual-boot detection failure.
  <https://www.bleepingcomputer.com/news/microsoft/microsoft-confirms-august-updates-break-linux-boot-in-dual-boot-systems/>
- BleepingComputer, "Microsoft fixes Linux boot issues on dual-boot
  Windows systems" — Sep 2024 revert; recovery procedure.
  <https://www.bleepingcomputer.com/news/microsoft/microsoft-fixes-linux-boot-issues-on-dual-boot-windows-systems/>

### A11. UEFI Classes 0–3+: CSM and Secure Boot

| Class | CSM? | External UEFI interface? | Secure Boot? |
|---|---|---|---|
| **0** | (it IS legacy BIOS) | no | no |
| **1** | yes | no (UEFI interfaces internal only) | no |
| **2** | yes | yes (UEFI Boot exposed) | no (or optional) |
| **3** | **no** | yes | no (or optional) |
| **3+** | **no** | yes | **yes (enabled)** |

- **CSM present**: Classes 0, 1, 2. (Class 0 *is* BIOS, not UEFI-with-CSM,
  but it's the legacy-compat end of the spectrum.)
- **CSM absent**: Classes 3 and 3+.
- **Secure Boot enabled by definition**: only Class 3+.
- Class 3+ is the target for all modern Intel platforms (Intel removed CSM
  from client platforms by 2020; by 2019 all Intel-platform PCs ship
  Class 3). Windows 11 requires UEFI (Class 3+ in practice, since Secure
  Boot is also required).

### A12. Production UEFI implementations + the open reference

**Production (proprietary) implementations:**
1. **AMI Aptio** — American Megatrends.
2. **Phoenix SecureCore (SCT)** — Phoenix Technologies.
3. **Insyde InsydeH2O** — Insyde Software.
4. **Byosoft ByoCore** — Byosoft.

**Open reference implementation:**
- **TianoCore EDK II** — the C reference implementation, maintained by the
  TianoCore community (originally Intel's "Tiano"). Partial BSD/EPL
  release. Used as a coreboot payload and as the basis for OVMF (QEMU/KVM
  virtual UEFI) and Microsoft's Project Mu (Surface/Hyper-V fork).

**Source:** Wikipedia UEFI article §6.1 Implementations, cross-checked
against the UEFI Forum member list.

---

## What I learned while refining this (project-relevant)

- The **runtime variable services** are the substrate for both the lockdown
  agent's persisted AgentState (NVRAM) and capsule triggering
  (SetFirmwareEnvironmentVariableExW) — confirmed by prior session memory.
- **Capsule updates** use FMP with a 16-byte FMP_PAYLOAD_HEAD and an
  EFI_FIRMWARE_IMAGE_AUTHENTICATION header; the auth-header omission was a
  recorded mistake. CapsuleApp.efi runs from the UEFI shell.
- **OVMF** is the virtualization path (QEMU/KVM) for testing UEFI enforcement
  without HP hardware; it needs GPT + ESP (type GUID C12A7328-F81F-...).
  Real-hardware verification is gated by graph invariant I3.
- **Secure Boot** (PK/KEK/db) is the trust model behind the E-HP-UEFI
  enforcement path; the 2026 MS UEFI CA 2011 expiry and SBAT are real
  operational risks for any lockdown flow that relies on MS-signed shims.
- **SEC is the software root of trust** and verifies PEI — relevant to any
  tamper-detection story for the lockdown system.
