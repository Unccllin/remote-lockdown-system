# Rootkits and Bootkits (Matrosov, Rodionov, Bratus) — Delta Study Note

> **Scope:** Defensive analysis only. This note extracts mechanisms and detection
> implications for the PBL/agent architecture. It is a **delta note**: it covers
> only material from the book that is *not* already documented in
> `STUDY-UEFI-BOOTKITS.md` and the other study notes indexed in
> `STUDY-INDEX.md`. Where the book overlaps existing notes (LoJax, Secure Boot
> layering, SPI write protection, measured boot), only the *new* implementation
> detail is recorded.

## Source

- **Book:** Alex Matrosov, Eugene Rodionov, Sergey Bratus, *Rootkits and
  Bootkits: Reversing Modern Malware and Next Generation Threats*, No Starch
  Press, 2019.
- **Local PDF:** `docs/reference/books/rootkits-and-bootkits.pdf` (450 PDF pages).
- **Extraction:** PyPDF2 3.0.1 → per-page text at `/tmp/rb-pages/page-NNNN.txt`.
- **Page convention:** citations use **PDF page** numbers (valid per task spec).
  Book page ≈ PDF page − 36. Chapters read: 1–7, 10–19 (ch. 8–9 are
  static/dynamic-analysis tooling chapters with little delta value).
- **Companion exercises:** `docs/reference/pre-exercises/ch3_*.c` — all five
  files are **Chapter 3 ("Observing Rootkit Infections")** exercises:
  - `ch3_apc_callbacks.c` — kernel/user APC queueing and APC enumeration
    (`EPROCESS->ThreadListHead` → `KTHREAD->ApcState.ApcListHead`).
  - `ch3_dpc_enumeration.c` — per-processor `KPRCB.DpcData` DPC walk.
  - `ch3_timer_enumeration.c` — per-processor `KPRCB.TimerTable` (256 buckets).
  - `ch3_workitem_enumeration.c` — `ExWorkerQueue` critical/delayed/normal.
  - `ch3_thread_context.c` — `PsCreateSystemThread` NULL vs. non-NULL
    `ProcessHandle` context (System/PID 4 vs. caller).
- **Delta boundary:** `STUDY-UEFI-BOOTKITS.md` already covers LoJax,
  MosaicRegressor, MoonBounce, CosmicStrand, BlackLotus, LogoFAIL, Bootkitty,
  the three-layer UEFI persistence taxonomy, `LoadedImageCount`,
  `bootmgr_hash`, BCD parsing, SPI bits, PCR 12/13, and TOCTOU-safe
  `LoadImage`. This note adds the book's pre-UEFI boot-chain, Windows
  kernel/storage internals, management-plane, ransomware, and forensics
  material, plus book-specific detail on Computrace, Option ROMs, S3 boot
  scripts, SMI handler abuse, and CHIPSEC misconfiguration patterns.

## Overview

The book's contribution relative to the existing notes is threefold. First, it
documents the **entire pre-UEFI bootkit lineage** — MBR code patching, MBR
partition-table infection (Olmasco), VBR/IPL infection (Rovnix), and 4-byte
BPB `HiddenSectors` redirection (Gapz) — together with the hidden filesystems,
storage-stack hooks, and private network stacks that made those bootkits
self-defending. Second, it provides the **Windows kernel mechanics** the OS
agent must survive: `DRIVER_OBJECT`/`DEVICE_OBJECT` hijacking, IRP handler
splicing, APC/DPC/timer/work-item concealment, ELAM's limited vantage point,
`g_CiEnabled`-style single points of failure, and the VBS/HVCI answer to them.
Third, it covers **everything below and beside UEFI that PBL cannot see**:
unsigned Option ROMs, SMM/SMI update-handler abuse, the S3 boot script as a
pre-OS code-execution path, ME/AMT/BMC out-of-band persistence, software-vs-
hardware firmware acquisition (including the FSMIE forgery attack), and MBR
ransomware's pre-boot lock screens. It also contains the closest known public
analogue to this repository: Absolute Software's **Computrace/LoJack**, a
legitimate firmware-resident anti-theft stack whose architecture (DXE drivers
installing an OS agent, SMM services, cloud C2, remote wipe, OS-reinstall-
surviving persistence) is structurally the same as PBL + `agent.py` — both a
design precedent and a threat-model warning.

## Key technical facts/mechanisms

### Anti-theft precedent and firmware persistence

1. **Computrace/LoJack is a firmware-resident anti-theft stack with the same
   architecture as this repository.** On the analyzed ThinkPads it comprises
   `LenovoComputraceEnableDxe` (watches BIOS menu activation),
   `LenovoComputraceLoaderDxe` (verifies security policy before loading),
   `AbsoluteComputraceInstallerDxe` (writes the agent into NTFS directly; on
   modern laptops ACPI tables are used instead), and
   `LenovoComputraceSmiServices` (SMM-side communication support). The OS
   agent `rpcnetp.exe` is *embedded in the DXE driver image*, runs after user
   logon, injects `rpcnetp.dll` into `iexplore.exe`/`svchost.exe`, collects
   geolocation, talks to Absolute's cloud, and can perform remote low-level
   disk wiping. (PDF pp. 316–319)
2. **Firmware anti-theft persistence survives OS-agent removal.** Removing
   `rpcnetp.exe` does not remove Computrace: the DXE installer re-drops it on
   the next boot. Disabling it requires BIOS-side action; a one-time-
   programmable NVRAM option can permanently forbid reactivation. This is
   exactly the survivability property this repository wants — and exactly the
   property a factory-shipped stack gives an attacker who controls it. (PDF
   pp. 317, 319)
3. **The SPI flash is only one of many firmware persistence surfaces.** The
   book enumerates UEFI/BIOS, Intel ME/CSME, HDD/SSD firmware, peripheral and
   GPU firmware, the Embedded Controller, Intel Sensor Hub, NIC firmware, CPU
   microcode, BMC, and AMT as implant-capable layers; such implants survive OS
   reinstall and disk replacement, potentially for the life of the
   motherboard. Disk-level cleanup therefore cannot evict them. (PDF
   pp. 298–300, 323–325)
4. **Unsigned PCI/PCIe Option ROMs are a DXE-phase code path.** An Option ROM
   contains a PE/DXE image that firmware maps and executes during DXE;
   Thunderstrike (2014) weaponized the Apple Ethernet adapter's Option ROM,
   and Snare/Heasman demonstrated earlier variants. Enterprise machines may
   ship third-party Option ROMs disabled, but the BIOS setting can be
   re-enabled. Detection angle: an Option-ROM-sourced image shows a PCI device
   path in `EFI_LOADED_IMAGE_PROTOCOL`, which distinguishes it from
   FV-resident DXE drivers. (PDF pp. 295–296, 303–305)
5. **The generic firmware-implant kill chain has four stages:** user-mode
   exploit/dropper → kernel-mode elevation → SMM exploit that defeats SPI
   write protection → malicious image written to SPI flash. A shortcut variant
   abuses the *vendor's own signed update path*: a signed kernel driver maps
   an attacker-controlled update image and invokes the SMI flash handler, so
   Secure Boot and SPI write protection alone do not stop a weak or
   unauthenticated update handler (`SmiFlash` writes unauthenticated images;
   `SecSmiFlash` authenticates; VU#507496 is the cited example). (PDF
   pp. 307–311, 341–342)
6. **SMI handlers must validate everything the OS hands them.** Because SMM
   runs at Ring −2 in SMRAM, every pointer, offset, length arithmetic, and
   returned status passed across the SMI boundary is an attack surface; the
   OS cannot inspect SMM, and the host can only reach SMM through the
   handler's ABI. A compromised host OS plus a careless handler equals SPI
   write access. PBL cannot audit handlers; it can only measure protection
   *state* and report platform identity for server-side risk policy. (PDF
   pp. 335–342)
7. **The S3 boot script is a pre-OS code-execution path that bypasses normal
   boot controls.** The boot script table is built by UEFI code during normal
   boot, stored in DRAM across suspend, and replayed by the Script Executor at
   the end of the PEI phase during resume — before DXE and before most
   protections are re-established. Its opcodes cover I/O port read/write, PCI
   config read/write, and arbitrary physical-memory read/write — enough to
   attack a hypervisor's isolated memory. Kernel malware can corrupt the
   table (e.g., via the `AcpiGlobalVariable` boot-script pointer) and trigger
   S3 resume to run it. (PDF pp. 342–345)
8. **AMT/BMC are independent, powered-off attack surfaces.** AMT runs inside
   the ME, can read/write DRAM independently of the host CPU, exposes its own
   web server and SOL (Serial-over-LAN) channel usable as an OS-independent
   covert channel, and was remotely exploitable via CVE-2017-5689
   (INTEL-SA-00075, auth bypass) — *including while the machine was off*.
   Embedi's AMTactivator showed AMT can be enabled even on non-vPro systems.
   BMCs similarly have their own CPU, flash, NIC, and web server; a
   compromised BMC persists independently of UEFI and OS state. (PDF
   pp. 323–325, 349–352)
9. **CHIPSEC results show that "protection bits set" ≠ "BIOS protected."**
   The `common.bios_wp` output in the book shows real machines where BLE is
   enabled but Protected Range registers (PRx) are absent, zeroed,
   read-only-only, or fail to cover the FREG1 BIOS region — and the exact
   coverage varies materially by vendor. Protection-state attestation must
   therefore compare *PRx range coverage against the actual BIOS region*, not
   just record bit values. (PDF pp. 300–302, 331–333)
10. **Software firmware acquisition is forgeable by a compromised SMM.** A
    host-side SPI dump (locate RCRB via RCBA at bus 0/dev 31h/func 0 → SPIBAR
    at offset 0x3800 → FREG1 → program FADDR/HSFC/FGO → read FDATAX) can be
    defeated if malicious SMM code sets the HSFC **FSMIE** bit first: an SMI
    fires at cycle completion and the attacker rewrites FDATAX before the
    reader sees it. Only a hardware SPI programmer clipped to the chip is a
    trustworthy dump — and it additionally reaches ME/GBE regions the host CPU
    is forbidden from reading. (PDF pp. 403–410)

### Legacy boot-chain infection (pre-UEFI, still disk-resident on UEFI systems)

11. **The MBR/VBR/IPL infection taxonomy is about *which bytes* change.**
    TDL4-class: replace MBR code (~446 bytes). Olmasco: leave MBR code intact,
    overwrite one *empty partition-table entry* (16 bytes) to point at a fake
    partition whose first sector mimics a legitimate VBR, and mark it active.
    Rovnix: overwrite the NTFS IPL — the ~15 sectors after the VBR. Gapz:
    change only the 4-byte `HiddenSectors` field in the VBR's NTFS BIOS
    Parameter Block so the VBR loads bootkit code staged before the first
    partition or after the last. Each step reduced the infected footprint;
    BPB-field anomalies defeated scanners that only checksummed boot code.
    (PDF pp. 122–137, 175–177, 222–225)
12. **Rovnix hooks without patching and survives the real→protected mode
    switch.** It sets hardware breakpoints in DR0–DR7 (via a hooked INT 1h
    handler) so hooked code bytes are never modified, and it copies its code
    into the unused second half of the IDT (~1 KB) to persist through the mode
    transition — the IDT base is recoverable via `sidt`. To load its unsigned
    driver, it hooks `winload.exe`'s `OslArchTransferToKernel` and inserts a
    record into `LOADER_PARAMETER_BLOCK.BootDriverListHead`, so the kernel
    itself initializes the malicious driver as if it were a signed boot-start
    driver. (PDF pp. 196–200)
13. **Gapz splices past hot-patch prologues and un-infects at boot.** Its
    kernel module is position-independent code blocks (not a PE image). It
    hooks miniport IRP handlers by *code splicing* with a built-in HDE
    disassembler that deliberately skips leading `nop`/`mov edi,edi`
    instructions — both to dodge prologue-only integrity checks and to avoid
    breaking OS hot-patching. It also restores the clean VBR early in boot
    (evading startup-time security scans) and re-infects later from kernel
    mode. (PDF pp. 225–227, 230–232)
14. **Bootkit hidden filesystems are real filesystems in unallocated space.**
    TDL4/Olmasco/Rovnix/Gapz all keep custom encrypted filesystems in the gap
    before the first partition or at the end of the disk: Olmasco added
    directory hierarchy, CRC32 per-file integrity, and `$bitmap`/`$bad`
    metadata files (names deliberately echoing NTFS); Rovnix used a
    VFAT-like FS with RC6-ECB (key in last 16 bytes of the FS's first sector)
    and exposed it to payloads via a `\DosDevices\<GUID>` symbolic link and
    ordinary `CreateFile`/`ReadFile`; Gapz stored a FAT32 image *inside* an
    ordinary file under `\System Volume Information\` and encrypted sectors
    with AES-256-CBC using the sector number as IV. The ESET HiddenFsReader
    tool exists precisely because each family's layout needs its own parser.
    (PDF pp. 178–181, 203–205, 229–230, 396–398)
15. **Storage self-defense hooks sit at the miniport, not the filesystem.**
    Rovnix hooks `IRP_MJ_INTERNAL_CONTROL` on the disk miniport's
    `DRIVER_OBJECT`: writes to protected regions get `STATUS_ACCESS_DENIED`;
    reads get a malicious completion routine that zeroes the returned buffer.
    TDL3/TDL4, Rovnix, and Olmasco go further by swapping the whole
    `DEVICE_OBJECT.DriverObject` pointer to a rogue `DRIVER_OBJECT`, which is
    harder to remove because the original object must be located to restore.
    Detection heuristic from the book: dispatch pointers that fall outside the
    owning driver's image range are hooked — but reconstructing legitimate
    pointers requires emulating each driver's init, which does not generalize
    across vendors. (PDF pp. 201–203, 390–396)
16. **Malware can bypass *all* OS network monitoring with a private TCP/IP
    stack.** Rovnix embeds lwIP and drives the NDIS miniport directly;
    Gapz implements its own data-link/transport/protocol layers; Olmasco
    instead attaches a TDI filter to `\Device\Tcp`, `\Device\Udp`,
    `\Device\Ip`, `\Device\RawIp` and rewrites `TDI_CONNECT` destinations so a
    connection that appears benign at Winsock level is rerouted underneath.
    In-OS `netstat`/firewall telemetry cannot see any of this. (PDF
    pp. 180–181, 206–207, 232)

### Windows kernel and boot-security mechanics

17. **ELAM's blind spot is structural, not fixable.** ELAM classifies
    boot-start drivers from only five inputs — image name, registry path,
    cert publisher/issuer, image hash + algorithm, cert thumbprint + algorithm
    — and *cannot read the image file or see its load address* because the
    storage stack isn't up yet. The default policy
    (`PNP_INITIALIZE_BAD_CRITICAL_DRIVERS`, 0x03) still loads known-bad
    *critical* drivers for availability. And bootkits inject into
    `BootDriverListHead` *before* ELAM ever runs, so ELAM structurally cannot
    see them. (PDF pp. 106–108)
18. **Pre-Win8 code integrity had a single point of failure: `nt!g_CiEnabled`.**
    Uroburos/Turla loaded the legitimately signed `VBoxDrv.sys`, exploited it,
    and cleared `g_CiEnabled` — after which any unsigned driver loads.
    `TESTSIGNING` (abused by Necurs, which signed itself with a custom cert)
    and `DISABLE_INTEGRITY_CHECKS` are the BCD-level equivalents; note that
    *with Secure Boot enabled, later Windows ignores `nointegritychecks` in
    BCD*. Windows 8 removed the single flag; Windows 10's VBS/HVCI moves CI
    into a hypervisor-isolated container so a compromised kernel can't reach
    it — and Device Guard's driver rules (NX nonpaged pool, no writable+exec
    sections, no self-modifying kernel code, no data-as-code) independently
    break most rootkit implementation patterns even with a valid signature.
    (PDF pp. 111–117)
19. **Kernel observation requires enumerating scheduler objects a rootkit can
    hide in.** The Chapter 3 exercises demonstrate the concrete inventory: APC
    queues hang off each thread's `KTHREAD->ApcState.ApcListHead[0/1]`
    (walk `EPROCESS->ThreadListHead`, requires ≥ APC_LEVEL); DPCs live in
    per-processor `KPRCB.DpcData` under a spin lock (all processors must be
    visited, `DISPATCH_LEVEL`, mind the 0x133 watchdog); timers live in
    per-processor `KPRCB.TimerTable` (256 buckets on Win8+, and a timer's DPC
    may already have moved into a DPC queue so its linkage "doesn't make
    sense"); work items live in `ExWorkerQueue` critical/delayed/normal lists.
    `PsCreateSystemThread(NULL,...)` runs in the System process (PID 4), not
    the caller — a thread-context check is itself a signal. These structures
    are undocumented and version-fragile, which is why in-OS enumeration is
    always one step behind; the book's point is that such enumeration is how
    a defender finds queued malicious callbacks. (Exercise files
    `docs/reference/pre-exercises/ch3_*.c`; PDF pp. 75–84)
20. **A trustworthy observer must sit outside the observed OS.** The book's
    arc from SoftIce (a freeze-frame console the rootkit "could not alter"),
    through remote WinDbg (interferable-with, but interference is conspicuous
    and therefore itself a detection signal), to EDR (bulk telemetry to a
    *central* server + anomaly detection) is the architectural justification
    for PBL + server verdicts: ground truth must be collected at a layer the
    compromised component doesn't control. (PDF pp. 80–81)
21. **MBR ransomware is a hostile pre-boot lock screen.** Petya (admin →
    `\\.\PhysicalDriveX` → `IOCTL_VOLUME_GET_VOLUME_DISK_EXTENTS` to find the
    boot disk; MBR and GPT aware) replaces MBR code, stages its loader in
    pre-partition sectors, encrypts the NTFS MFT with Salsa20, stores a
    key-validation sector, fakes a `chkdsk` progress display, and reboots into
    its ransom UI. Satana is a cruder MBR+file-encryption hybrid whose unlock
    path loops forever. Shamoon (same era) used a signed legitimate disk tool
    to wipe. Defensive reading: raw-disk writes + MFT manipulation + reboot is
    the behavioral signature, and any pre-boot "this machine is locked" screen
    is indistinguishable from ours without an attestation path. (PDF
    pp. 243–278)
22. **Hidden-storage forensics must be done offline.** Live analysis lets the
    rootkit's self-defense falsify reads (item 15) or detect the foreign boot
    and wipe evidence; the book recommends trusted-boot/hardware acquisition
    plus per-family parsers (HiddenFsReader supports TDL3/4, Olmasco, Sirefef,
    Rovnix, Xpaj, Gapz, Flamer, Urelas, Avatar). An OS agent's own disk scan
    is untrustworthy once kernel compromise is suspected. (PDF pp. 390–398)

## PBL/agent mapping — which existing checks catch or miss each mechanism

Legend: **PBL** = `firmware/PblPkg/PblApp/`; **Agent** = `agent/`; **Server** =
verdict/policy side; **OEM/forensic** = outside this codebase.

| Book mechanism | What exists today | Verdict |
|----------------|-------------------|---------|
| SPI flash implant (LoJax-class) | `SpiProtections.c` bit checks → `Decision.c` ll. 180–195 (unknown→DEGRADED); `LoadedImageCount`+`LoadedImageDigest` (`PlatformState.c` ll. 931–1013, `PblApp.h` ll. 303–309); PCR 4/5/7/11 in state digest (`PlatformState.c` ll. 611–660) | **Partial.** Catches missing protections and extra/changed images; cannot see SPI contents or prove PRx actually covers the FREG1 region (item 9). Needs raw HSFS/BIOS_CNTL/FLOCKDN/PRx range attestation. |
| Option-ROM DXE injection | `LoadedImageDigest` covers device path + file path per image (D-213) | **Partial, newly feasible.** Digest will change, but nothing classifies *PCI-device-path* images vs FV images; no Option-ROM allowlist/policy knob. |
| Weak SMI update handler (`SmiFlash`) | Nothing — SMM is opaque to PBL | **Miss.** Server-side firmware-version floor (`FirmwareVersion`, `PblApp.h` ll. 227–229; `Decision.c` REQ-04) is the only lever; OEM fix required. |
| S3 boot-script attack | `S3Enabled` from FADT (`PlatformState.c` ll. 482–572); `MorRequested` (`Mor.c`); S3+MOR→BLOCK (`Decision.c` ll. 244–249) | **Weak signal only.** Bits detect that S3 exists, not that the boot-script table was tampered. No resume-vs-cold-boot distinction in attestation. |
| AMT/BMC/ME out-of-band | `AmtCheck.c` → `AmtProvisioned`→DEGRADED (`Decision.c` ll. 199–204); `DciCheck.c` → `UsbDciEnabled` | **Partial.** Detects provisioned AMT but not "AMT activatable" (non-vPro), BMC presence, or powered-off management-plane compromise (item 8). |
| MBR/partition-table infection (TDL4, Olmasco) | None in PBL (UEFI-only); PCR 5 *is* read and digested (`PlatformState.c` ll. 648–651) — and PCR 5 covers the GPT/partition table | **Partial via PCR 5.** Olmasco's partition-entry edit would shift PCR 5; server baseline comparison could catch it. On a CSM/legacy-boot machine PBL doesn't run at all — **miss** there. |
| VBR/IPL/BPB infection (Rovnix, Gapz) | `bootmgr_hash` + `SourceBuffer` TOCTOU-safe load (`ChainLoad.c` ll. 217–290) covers `bootmgfw.efi` only; BCD hive is parsed (`Bcd.c`, fields `PblApp.h` ll. 269–287) | **Miss** for legacy boot path. Nothing reads VBR, BPB `HiddenSectors`, IPL, or unallocated gap sectors. PBL already has `DiskIo` plumbing (`Fve.c` ll. 59, 311–330) that could baseline them. |
| Hidden filesystem in unallocated space | Nothing | **Miss.** Neither PBL nor `agent.py` scans unallocated disk regions; an agent-side raw read is falsifiable anyway once storage hooks exist (item 15). Needs offline/forensic path. |
| Storage-stack hooks (`IRP_MJ_*`, `DRIVER_OBJECT` swap, splicing) | Nothing — `agent.py` is user-mode Python | **Miss.** Would need kernel telemetry (driver inventory, dispatch-pointer-vs-image-range check, minifilter/callback enumeration) reported to the server, or a CHIPSEC-equivalent runbook in `agent/hw_test_harness.py`. |
| ELAM / code-integrity / VBS-HVCI posture | BCD flags only: `BcdNoIntegrityChecks`, `BcdTestSigning`, `BcdHypervisorLaunchType` (`PblApp.h` ll. 274–285) | **Partial.** BCD shows intent, not runtime state; nothing reports whether HVCI/VBS/CI actually initialized, and nothing inventories *vulnerable signed* drivers (BYOVD, Uroburos-class). Agent checkin could carry this. |
| Kernel callback concealment (APC/DPC/timer/work-item) | `agent.py` has no kernel component | **Miss in-OS; mitigated by design.** PBL+server is the out-of-OS observer (item 20); `_run_tamper_check` (`agent.py` ll. 3214–3286, `tamper_protection.py` ll. 504–544) checks only files/service/task — user-mode visibility. |
| MBR ransomware / hostile pre-boot lock | `agent.py` `encrypt_folder` (l. 504) + lock screen (ll. 728–810); PBL `LockScreen.c` | **Miss on detection; collision risk.** Nothing watches `\\.\PhysicalDrive*` writes or MFT corruption; and Petya's fake `chkdsk`→ransom UI is visually confusable with a lockdown screen — the lock UI should carry a verifiable server-bound marker. |
| Software SPI dump for forensics | Nothing | **N/A → document.** Any agent-side firmware read is forgeable via FSMIE/SMM (item 10); only a hardware programmer dump is evidence-grade. Belongs in the recovery/forensic runbook, not the agent. |
| Computrace-class *legitimate* firmware agent | Nothing | **Blind spot.** If factory Computrace/Absolute (or OEM equivalent) is enabled, a third-party DXE stack can write to the OS and reinstall its own agent — competing with lockdown semantics. `LoadedImageDigest` change + firmware scan is the only PBL-visible signal. |

## New capabilities this suggests

Ordered roughly by leverage. Each item names where it would live.

1. **Legacy-boot posture check (PBL).** Extend `PblCollectBootOrderState`
   (`PlatformState.c` ll. 233–340, which already parses `Boot####` device
   paths for BBS/network entries) to also flag CSM/legacy-path entries, and
   add a `csm_policy` C4 key. A PBL that only runs under UEFI silently cedes
   the machine to the entire MBR/VBR/IPL lineage if CSM is enabled.
   (Items 11–13)
2. **Disk boot-structure baseline (PBL).** Using the existing `DiskIo`
   plumbing from `Fve.c` (ll. 59, 311–330): hash LBA-0 (protective MBR),
   primary + backup GPT headers, the ESP and OS-volume VBRs, and the NTFS BPB
   `HiddenSectors` field; record the count and hash of sectors in the
   pre-first-partition gap and post-last-partition region. Feeds the
   platform-state digest; catches Olmasco-style partition edits, Gapz-style
   BPB redirects, and staged bootkit code in unallocated space — including on
   disks the agent can no longer be trusted to read. (Items 11–14)
3. **PCR 5 server-side baseline for partition-table integrity.** PBL already
   reads PCR 5 into the digest (`PlatformState.c` ll. 648–651); the delta is
   *server-side*: compare the quoted PCR 5 against a per-device golden value
   to detect partition-table edits (Olmasco) that no file hash covers.
   (Item 11)
4. **Option-ROM / device-path classification of loaded images (PBL + policy).**
   `LoadedImageDigest` (D-213) hashes `DevicePath(DeviceHandle)‖FilePath` per
   image; extend the collection to also bucket images by device-path type
   (PCI → likely Option ROM, FV file → firmware-resident, media → ESP) and add
   an `option_rom_policy` C4 key. Distinguishes Thunderstrike-class injections
   from ordinary DXE volume churn. (Item 4)
5. **S3-resume-aware attestation (PBL + server).** The book shows resume
   replays attacker-modifiable DRAM state before protections re-arm (item 7).
   Suggested: record a "boot path" indicator (cold boot vs S3 resume — e.g.,
   via `EFI_VARIABLE_BOOTSERVICE_ACCESS` state or the wake vector path),
   include it in the digest, and let policy require a *cold* boot for
   high-risk verdict transitions (LOCKED→UNLOCKED). Server treats resume-
   originated attestations with lower confidence.
6. **Agent kernel-integrity telemetry (Agent → Server).** The Chapter 3
   inventory (item 19) argues for periodic agent reporting of: boot-start +
   minifilter driver list, `HKLM\SYSTEM\CurrentControlSet\Services` deltas,
   registered callback counts (`PsSetCreateProcessNotifyRoutine` array size
   changes are themselves a signal — see `ch3_apc_callbacks.c` ll. 148–155),
   loaded-driver signer catalog, and `DeviceGuard`/`HVCI`/VBS CIM state.
   Server-side anomaly detection (the book's EDR argument, item 20) — the
   agent reports, the server diffs; the agent is not the judge.
7. **Raw-disk access guard (Agent).** Watch for `\\.\PhysicalDrive*` opens
   and sector writes outside the agent's own activity, plus MFT-region write
   anomalies and VSS deletion — the Petya behavioral signature (item 21).
   `tamper_protection.py` (ll. 504–544) currently checks only file/service/
   task presence; a disk-write watchdog is a natural sibling, with the caveat
   that user-mode hooks are bypassable — treat as tripwire, not proof.
8. **Verified lock-screen provenance.** Any pre-OS "locked" UI is confusable
   with MBR ransomware (item 21). `LockScreen.c` and `agent/lock_screen.py`
   should render a server-issued, device-bound marker (e.g., a per-device
   signed token/QR the user can verify against the dashboard) so a victim can
   distinguish our lockdown from Petya-style fake-`chkdsk` screens.
9. **CHIPSEC-equivalent PRx validation (PBL `SpiProtections.c` + hw harness).**
   Item 9's lesson: log raw `FREG1` (BIOS region base/limit) and each PRx
   range + WP/RP attributes, and verify PRx coverage *contains* the BIOS
   region with write-protect semantics — not merely that bits are nonzero.
   Today `SpiProtections.c` exposes `PrrCoverBios` as one boolean; the book
   shows zeroed/read-only PRx configurations that pass a naive check.
   For the OS side, `agent/hw_test_harness.py` is the natural host for a
   CHIPSEC-driven configuration audit.
10. **Vulnerable-signed-driver inventory (Agent → Server).** Uroburos cleared
    `g_CiEnabled` through signed `VBoxDrv.sys`; BlackLotus used signed
    `hvloader.efi`. A signed-driver inventory diffed against a
    known-vulnerable list (LOLDrivers-class) is the BYOVD countermeasure the
    BCD flags can't provide. (Item 18)
11. **Factory anti-theft detection + coexistence policy.** Enumerate
    Computrace/Absolute-class DXE components (firmware scan on the server
    side; `LoadedImageDigest` change pre-PBL) and add a policy decision: is a
    third-party firmware agent that can write NTFS and reinstall OS code
    acceptable on a locked-down device? It is simultaneously our design
    precedent and a rival persistence layer. (Items 1–2)
12. **Offline forensic acquisition runbook (docs + `offline_recovery.py`).**
    Item 22 + item 10: disk imaging and SPI dumps must happen from trusted
    boot media / a hardware programmer, because live malware falsifies both
    filesystem and SPI reads. Codify the acquisition order (hardware SPI dump
    → offline disk image → hidden-sector carve → per-family hidden-FS parse)
    in the recovery docs; `agent/offline_recovery.py` is the anchor point.
13. **Management-plane posture reporting.** `AmtCheck.c` reports
    `AmtProvisioned`; the book adds that AMT is *activatable* on non-vPro
    parts (AMTactivator) and attackable while powered off (item 8). Extend
    reporting toward: ME/CSME firmware version, AMT state (disabled vs
    unprovisioned vs provisioned), and — server-side — model-level BMC
    presence as a standing risk factor rather than a per-boot check.
14. **Deadman/verdict as cross-layer tripwire.** The book's observation-model
    argument (item 20) supports treating *disagreement between layers* as a
    first-class signal: e.g., agent reports healthy while PBL's
    `LoadedImageDigest` shifted, or PCR 5 moved while BCD is unchanged.
    `check_deadman` (`agent.py` ll. 2890–3003) already inverts the heartbeat;
    adding a digest-drift term makes silence-plus-drift louder than silence
    alone.

## Cross-references

- `STUDY-UEFI-BOOTKITS.md` — the UEFI-layer counterpart; this note covers
  everything *below* (firmware update path, SMM, S3, ME/AMT/BMC, legacy disk
  boot chain) and *above* (Windows kernel/storage interception) that layer.
- `STUDY-INTEL-PLATFORM-SECURITY.md` — Boot Guard/SPI/SMM hardware detail;
  the delta here is the *attack choreography* (SmiFlash abuse, FSMIE forgery,
  PRx misconfiguration evidence, boot-script table corruption).
- `STUDY-WINDOWS-NT-INTERNALS.md` and `STUDY-OS-INTERNALS-AGENT-HARDENING.md` —
  Windows internals already covered (IRP/device stacks, VBS/HVCI, DKOM-as-
  concept). Delta here: *concrete* hook placement (miniport `MajorFunction`
  splice, `DRIVER_OBJECT` swap), the APC/DPC/timer/work-item enumeration
  exercises, ELAM's five-input blind spot, and `g_CiEnabled` history.
- `STUDY-FIRMWARE-SECURITY-TALKS.md` — Thunderstrike/Option ROM and S3 topics
  appear there as talk summaries; this note supplies the book's mechanism-
  level detail (opcode capabilities, `AcpiGlobalVariable` pointer, FSMIE).

## Outstanding questions

1. Can PBL legally/structurally read the S3 boot-script table or its pointer
   (`AcpiGlobalVariable`) pre-boot to hash it into the digest, or is resume-
   vs-cold-boot signalling the only practical control?
2. On HP targets running Insyde firmware, which of `PrrCoverBios`,
   `FLOCKDN`, and the PRx range contents are actually populated — and does
   `SpiProtections.c`'s boolean survive the CHIPSEC-style misconfiguration
   cases in item 9?
3. Is a `Boot####`→device-path classification sufficient to detect CSM-only
   boot configurations, or must PBL also read the CSM/legacy NVRAM variables?
4. Should the server flag a *present-but-inactive* Computrace stack (BIOS
   option off) differently from an active one, given the one-time NVRAM
   "permanently disable" option exists?
5. What fraction of agent-side raw-disk monitoring is still meaningful once a
   miniport-level hook is present — i.e., at what point does the runbook say
   "trust only offline acquisition"?

## Self-test (delta material)

1. **Which legitimate product is architecturally closest to PBL + agent.py,
   and what does it prove about survivability?**
   - Answer: Absolute Software's Computrace/LoJack — DXE drivers that
     reinstall an OS agent, SMM services, cloud C2, remote wipe. It proves
     firmware-level persistence survives OS reinstall and agent deletion, and
     that a one-time NVRAM option can permanently disable reactivation.
     Confidence: high (PDF pp. 316–319).
2. **Which 4 bytes did Gapz change, and why did that evade detection?**
   - Answer: the `HiddenSectors` field of the NTFS BPB inside the VBR —
     redirecting IPL load to bootkit code staged in unallocated space.
     Scanners checksummed boot *code*, not BPB *fields*, and the value is
     legitimately variable per machine. Confidence: high (PDF pp. 222–225).
3. **Why can't ELAM catch a Rovnix-class bootkit?**
   - Answer: the driver is inserted into `LOADER_PARAMETER_BLOCK.
     BootDriverListHead` before ELAM runs; ELAM also only sees name, registry
     path, cert, hash, and thumbprint — never the image itself. Confidence:
     high (PDF pp. 106–108, 199–200).
4. **Why is a software SPI dump insufficient forensic evidence?**
   - Answer: a compromised SMM can arm HSFC.FSMIE so an SMI fires at cycle
     completion and FDATAX is rewritten before the reader sees it. Only a
     hardware programmer clip is trustworthy. Confidence: high (PDF
     pp. 408–410).
5. **What does the S3 boot script buy an attacker that a normal boot
   doesn't?**
   - Answer: code execution (I/O ports, PCI config, arbitrary physical memory
     R/W) during resume *before* DXE and security controls re-initialize —
     enough to attack even hypervisor-isolated memory. Confidence: high (PDF
     pp. 342–345).
6. **Which existing PBL signal would detect an Olmasco partition-table
   infection, even though no file changed?**
   - Answer: PCR 5 (GPT/partition-table measurement), already read into the
     platform-state digest in `PlatformState.c`; detection requires a
     server-side golden baseline. Confidence: high.
