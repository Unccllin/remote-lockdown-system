# Windows Firmware & Boot Security Research for Anti-Theft / Device Lockdown

**Project:** Windows "MKOPA-like" remote lockdown system
**Date:** 2026-09-02

---

## How to read this document

Each major section contains:
- **Factual answer** – how the technology works, with primary-source citations.
- **Application to our system** – how it could be used in the anti-theft/lockdown design.
- **Feasibility (2 weeks)** – whether this can realistically be built/prototyped inside a short sprint.
- **Risk level** – how likely it is to damage or brick the test machine, and what the mitigation is.

---

## 1. UEFI Firmware

### 1.1 UEFI vs legacy BIOS and the modern Windows 10/11 boot process

UEFI is a modern pre-OS firmware environment that runs in 32/64-bit mode, uses GPT, and exposes Boot Services and Runtime Services. Boot chain:

1. Platform Initialization (SEC → PEI → DXE) in UEFI firmware
2. Boot Device Selection (BDS) phase
3. UEFI Boot Manager reads NVRAM boot entries (`Boot####`, `BootOrder`)
4. Loads `\EFI\Microsoft\Boot\bootmgfw.efi` from the ESP
5. Windows Boot Manager reads the BCD store
6. Loads `winload.efi` → kernel (`ntoskrnl.exe`) → `ExitBootServices`

**Application:** The earliest place we can insert our own logic is in the UEFI phase, before any OS code runs. This is the strongest possible layer for tamper-resistant boot lock.

**Feasibility:** Creating a simple UEFI "stop and ask for code" application is feasible in two weeks in QEMU. Porting to real hardware is not.

**Risk:** High. Wrong NVRAM boot entries or a bug can prevent booting. Test only in QEMU/OVMF first.

### 1.2 EFI System Partition (ESP)

FAT32-formatted partition holding UEFI boot loaders. A custom UEFI app can be placed at `\EFI\Custom\lock.efi` but must be registered in NVRAM or copied to `\EFI\Boot\BOOTX64.EFI`.

**Application:** Convenient place for our custom UEFI lock app and lock-flag file. But ESP is not encrypted — readable by a thief who removes the drive.

**Risk:** Low to add a file; high if the app becomes first in BootOrder.

### 1.3 Secure Boot

Verifies digital signatures of every pre-OS executable. Uses four key databases in NVRAM:

| Key/DB | Purpose |
|---|---|
| **PK** (Platform Key) | Root of trust; signs KEK and PK updates |
| **KEK** (Key Enrollment Key) | Signs updates to `db` and `dbx` |
| **db** (Allowed Signatures) | Trusted signers |
| **dbx** (Forbidden Signatures) | Revoked signatures |

To make our UEFI app boot under Secure Boot we must either disable Secure Boot (bad) or enroll our own signing cert into `db` (requires Setup Mode + physical presence).

**Risk:** Very high. Enrolling wrong PK can permanently lock the platform. Always test in QEMU first.

### 1.4 UEFI applications (.efi)

PE/COFF `.efi` files with entry point `efi_main()`. Development stacks:
- **EDK II / TianoCore** — Intel's reference (C/C++)
- **GNU-EFI** — minimal Linux toolchain
- **Rust** — `uefi-rs` crate

A UEFI app can run before Windows if placed in the boot path ahead of `bootmgfw.efi`.

**Application:** Write a UEFI app that checks a lock flag on every boot, and if set, shows a lock message and refuses to chain to Windows.

**Feasibility:** Basic "display text, wait for key, or halt" app is feasible in two weeks. Full GUI/networking is not.

### 1.5 CMOS clear / CMOS battery removal

Modern UEFI systems store config in **SPI flash NVRAM**, not CMOS battery-backed RAM. Removing the CMOS battery:
- Resets RTC clock and a few legacy settings
- **Does NOT** reliably erase UEFI variable store or Secure Boot databases
- Some boards DO re-initialize UEFI variables on CMOS clear (vendor-specific)

**Application:** Relying on UEFI NVRAM alone is not enough. Need additional storage on disk (ESP) and/or TPM.

### 1.6 NVRAM variables vs CMOS

| CMOS (legacy) | UEFI NVRAM |
|---|---|
| Small, battery-backed | Stored in SPI flash, persists across power loss |
| RTC, legacy BIOS settings | Secure Boot keys, boot entries, UEFI variables |
| Cleared by removing battery | Not cleared by CMOS reset on most modern boards |

---

## 2. Trusted Platform Module (TPM 2.0)

### 2.1 What TPM stores

- **EK** (Endorsement Key) — manufacturer-issued identity
- **SRK** (Storage Root Key) — user/admin generated
- **AK** (Attestation Key) — signs PCR quotes
- **Sealed keys** — encrypted blobs only unsealable when PCRs match
- **NV memory** — small amount of persistent data

**Application:** Store a key/secret that only releases when boot chain is unmodified. If thief tampers with boot files, TPM refuses to unseal → BitLocker recovery.

### 2.2 PCR registers for BitLocker

Default Windows 10/11 with Secure Boot:
- **PCR 7** — Secure Boot state, boot loader policy
- **PCR 11** — BitLocker-specific measurement

Any change to these (firmware update, new boot loader, changed BCD) → TPM won't release key → BitLocker recovery.

**Application:** Intentionally configure BitLocker to recover on any tampering. Hardware-backed "tripwire."

**Risk:** High. Wrong PCR profile = recovery on every reboot. Always have recovery key.

### 2.3 Storing our own keys in TPM

Yes, via TPM Base Services (TBS) API on Windows or tpm2-tools on Linux. Create key in TPM → get encrypted blob → store on disk → load when needed.

**Feasibility:** Writing a C/C# agent using TBS/CNG is feasible in two weeks.

### 2.4 Can thief extract TPM keys by removing chip?

Modern PCs have **firmware-integrated TPM** (fTPM) or **discrete TPM soldered to motherboard**. Socketed TPM modules are rare. Even if moved:
- Keys are non-migratable
- BitLocker keys sealed to TPM A won't unseal on TPM B
- Physical attacks (decapping) require specialized lab equipment

**Application:** TPM provides strong hardware binding. Thief can't "swap the chip."

### 2.5 TPM attestation

Remote server asks device to prove its boot state:
1. Device generates Attestation Key in TPM
2. Server sends challenge (nonce)
3. Device creates Quote over PCRs, signed by AK
4. Server verifies signature + PCR values against known-good policy

**Application:** Server can verify device hasn't been tampered with before unlocking.

**Feasibility:** Full attestation server = multi-week. Simple "read PCRs and compare" prototype = feasible in two weeks.

### 2.6 BitLocker with TPM+PIN

PIN is **local** to device. No native Microsoft mechanism to set PIN remotely. But we can:
- Force device into recovery (`manage-bde -forcerecovery C:`)
- Add/remove protectors remotely if agent has admin access

### 2.7 BitLocker after CMOS clear or moving drive

- **CMOS/TPM clear** → changes PCR measurements → BitLocker recovery
- **Moving drive to another machine** → different TPM → recovery
- **Changing boot order/hardware** → can trigger recovery

**Application:** BitLocker's recovery-on-tamper is a feature for anti-theft.

---

## 3. BitLocker

### 3.1 Full disk encryption on Windows 10 Pro

AES or XTS-AES (128/256 bit). Requires TPM (recommended) or startup key/USB.

**Feasibility:** Trivial: `Enable-BitLocker C:` or `manage-bde -on C:`.

### 3.2 Recovery key

48-digit numeric password. Can be saved to:
- Microsoft account, Entra ID, AD
- USB, printed
- **Custom server** (retrieve via PowerShell `Get-BitLockerVolume` or `manage-bde -protectors -get`)

**Application:** Our server should be the authoritative holder of the recovery key. If stolen, withhold the key → disk effectively unrecoverable.

### 3.3 Enabling BitLocker remotely

```powershell
$SecureString = ConvertTo-SecureString "123456" -AsPlainText -Force
Enable-BitLocker C: -EncryptionMethod XtsAes256 -UsedSpaceOnly -Pin $SecureString -TPMandPinProtector
```

**Feasibility:** Feasible in a day.

### 3.4 BitLocker Network Unlock

Requires WDS server + DHCP + UEFI DHCP driver. **Not serverless-compatible.** Avoid for our prototype.

### 3.5 Tamper detection

BitLocker enters recovery when it detects:
- Boot order change
- New hardware (RAM, GPU, battery)
- UEFI/BIOS update
- Modified MBR, boot sector, boot manager, BCD
- TPM state change
- Drive moved to another PC

### 3.6 Force BitLocker to lock if stolen

```cmd
manage-bde -forcerecovery C:
```

Deletes all TPM protectors. Next reboot requires 48-digit recovery key. If server holds that key, device stays locked until server releases it.

**Application:** This is the **primary remote kill switch**. Agent phones home, receives "stolen" command, runs `manage-bde -forcerecovery`.

**Feasibility:** Very easy.

**Risk:** High if recovery key is lost. Keep secure backup.

### 3.7 BitLocker + TPM + Secure Boot interaction

- BitLocker relies on TPM to unseal VMK
- TPM uses PCR measurements; PCR 7 reflects Secure Boot state
- If Secure Boot disabled or different boot loader used → PCR 7 changes → recovery
- Together: UEFI Secure Boot + TPM sealing + BitLocker = extremely hard to boot alternate OS

---

## 4. Windows Boot Process

### 4.1 Full boot chain and injection points

| Stage | Component | What it does |
|---|---|---|
| UEFI firmware | — | Hardware init, Secure Boot, BDS |
| UEFI Boot Manager | — | Reads NVRAM, loads `bootmgfw.efi` |
| Windows Boot Manager | `bootmgfw.efi` | Reads BCD, loads OS loader |
| OS Loader | `winload.efi` | Loads kernel, boot drivers |
| NT Kernel | `ntoskrnl.exe` | Kernel init |
| Session Manager | `smss.exe` | Creates session, starts winlogon |
| Winlogon | `winlogon.exe` | Interactive logon, launches shell |
| Shell | `explorer.exe` | Desktop, taskbar |

**Realistic injection points for our system:**
1. UEFI app (pre-OS) — strongest, highest risk
2. BCD lockdown — disable safe mode, recovery
3. Winlogon / Credential Provider — lock screen at login
4. Shell replacement — replace explorer.exe

### 4.2 BCD (Boot Configuration Data)

```cmd
:: Disable WinRE failover
bcdedit /set {default} recoveryenabled no

:: Disable F8 menu
bcdedit /set {default} bootmenupolicy Standard

:: Remove safeboot flag
bcdedit /deletevalue {default} safeboot
```

**Application:** Disable recovery and safe-mode boot paths that a thief could use to bypass our lock.

**Feasibility:** One command. **Risk:** Medium — disabling recovery makes machine unrecoverable from legitimate boot problems.

### 4.3 Windows Recovery Environment (WinRE)

Separable WinPE environment for Startup Repair, System Restore, reset. Can open command prompt → major bypass surface.

Disable:
```cmd
reagentc /disable
```

**Application:** Disable WinRE after provisioning. Keep Windows install USB for owner recovery.

### 4.4 Safe Mode

Boots with minimal drivers/services. Thief could boot to Safe Mode, disable our agent, boot normally.

Prevent:
1. Remove Safe Mode entries in BCD
2. Disable F8/Advanced Startup menu
3. Disable WinRE
4. Ensure agent is boot-start or persistent service

### 4.5 Winlogon and shell replacement

Registry: `HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon\Shell`

Default: `explorer.exe`. Replace with our lock screen → user sees ONLY our app (no desktop, no taskbar, no start menu).

**Shell Launcher** (Enterprise/Education feature) — more robust shell replacement for specific users.

**Application:** MKOPA-style lock — our app IS the desktop. Can't access anything else because explorer.exe never starts.

**Feasibility:** One-day C# project. **Risk:** Low — if custom shell fails, boot to WinRE/live USB and fix registry.

### 4.6 Custom Credential Providers

COM DLLs loaded by LogonUI.exe. Can add custom tiles to login screen, intercept credentials, force specific tile.

**Application:** Show "DEVICE LOCKED — enter unlock code" tile before user can log in.

**Feasibility:** Few days of C++ work following Windows SDK sample. **Risk:** Low — can be disabled from WinRE/safe mode.

---

## 5. Windows Assigned Access (Kiosk Mode)

### 5.1 What it is

- **Assigned Access** — available on Windows 10/11 Pro, Enterprise, Education
- **Shell Launcher** — generally requires Enterprise or Education

Windows 10 Pro Education (our test machine) supports both.

### 5.2 How it works

Ties a user account to a single app. On logon, app launches full-screen. User cannot access desktop, Start menu, or other apps.

### 5.3 Configuration

```powershell
Set-AssignedAccess -AppUserModelId <AUMID> -UserName <username>
```

### 5.4 Bypasses

Known bypasses exist:
- Edge "Help" links to open unrestricted browser
- File-picker dialogs to spawn explorer.exe
- Renaming forbidden binary to allowed kiosk app name
- Windows key or search to launch other apps

**Application:** Assigned Access alone is not enough. Must combine with lower-level enforcement (BitLocker, BCD, credential provider, WinRE disabled).

### 5.5 Defender interaction

**No.** Assigned Access and Shell Launcher are built-in Windows features. Defender does not flag them. This is a major advantage over our ctypes approach.

---

## 6. MKOPA Architecture Comparison

### 6.1 How MKOPA locks Android phones

- Device provisioned as financed unit at factory/setup
- Remote server tracks payment status
- Missed payment → server tells on-device lock app to restrict device
- "Locked" mode: emergency calls, settings, payment top-ups only
- Some systems include SIM lock or hardware PAYG token

### 6.2 Windows equivalent of each MKOPA layer

| MKOPA / Android layer | Windows equivalent |
|---|---|
| Remote command server | Our cloud API + agent |
| Device Owner / DPC lock | Credential Provider + Shell Launcher + Assigned Access |
| Verified Boot | UEFI Secure Boot + BitLocker + TPM PCRs |
| Factory Reset Protection | BitLocker recovery key held by server |
| Kiosk / restricted launcher | Shell Launcher / Assigned Access |
| Payment token / SIM lock | Local agent policy (no direct hardware equivalent) |

### 6.3 What MKOPA can do that we can't

- OEM bakes lock into factory image and hardware
- Device Owner mode is single, system-level control point
- Verified Boot hard to bypass without unlocking bootloader (wipes data)
- Factory Reset Protection prevents re-use after wipe
- SIM/IMEI lock prevents use on new account

### 6.4 What we can do that MKOPA can't

- BitLocker full-disk encryption (stronger than Android FDE in many cases)
- TPM is standard and well-integrated
- UEFI gives pre-OS environment for even earlier lock
- Desktop OS is more open — can modify boot chain and shell
- PowerShell and Win32 APIs give flexible automation

**Realistic take:** Windows can't match Android's factory-integrated model on an arbitrary consumer PC. But it can build a multi-layer lockdown system that's "good enough" for financed-PC use cases.

---

## 7. Anti-theft Software Landscape

### 7.1 Computrace / Absolute Persistence

Embedded in UEFI/BIOS at factory. On each boot, UEFI module checks if Windows agent is installed, and if not, injects downloader by patching `autochk.exe`. Survives:
- OS reinstallation
- Hard drive replacement
- BIOS firmware updates

**This is the gold standard for persistence.** Requires OEM cooperation to embed in firmware.

### 7.2 Prey

Cross-platform agent running inside OS. Tracks location, takes screenshots, displays messages, locks screen, wipes data. Does **not** survive disk format or OS reinstall.

### 7.3 Windows Find My Device

Built into Windows 10/11. Requires Microsoft account. Does not survive OS reinstall.

### 7.4 LoJack for Laptops

Rebrand of Absolute/Computrace. Same UEFI/BIOS persistence.

---

## 8. Practical Implementation

### 8.1 UEFI app that checks lock flag

1. Read UEFI NVRAM variable or file on ESP
2. Check lock/unlock token
3. If locked → clear screen, display message, halt
4. If unlocked → `LoadImage`/`StartImage` on `bootmgfw.efi`

**Feasibility:** Text-only prototype feasible in two weeks in QEMU. Real hardware + Secure Boot signing is not.

### 8.2 Persisting lock state across CMOS clear

| Tier | Survives CMOS clear? | Notes |
|---|---|---|
| UEFI NVRAM | Usually yes | Vulnerable to SPI reflash |
| TPM NVRAM | Yes | Small, requires owner auth |
| Encrypted disk / ESP file | Yes, unless disk wiped | Readable if booted from live USB |
| Boot ROM / SPI chip | Yes | Requires OEM cooperation |

**Recommendation:** Store lock state on disk inside BitLocker-encrypted partition AND in UEFI NVRAM variable. UEFI app checks both. If disk removed → encrypted state unreadable. If CMOS cleared → disk state survives.

### 8.3 BitLocker as primary enforcement

```cmd
manage-bde -forcerecovery C:
```

**This is the single most effective enforcement** available on a standard Windows PC. If server is only place with recovery key, thief cannot unlock drive.

Caveats:
- If recovery key leaked/saved locally, thief can unlock
- If thief boots Linux live USB, data is protected but device isn't "bricked" unless it needs Windows

### 8.4 Minimum enforcement stack for thesis-quality system

**Recommended (from lowest to highest risk):**

1. **BitLocker with TPM+PIN and server-held recovery key** ← start here
2. **BCD hardening** — disable WinRE, disable Safe Mode
3. **Custom Credential Provider** — lock screen at logon
4. **Shell Launcher / Assigned Access** — restrict desktop
5. **Windows agent as SYSTEM** — phone home, trigger `manage-bde -forcerecovery`
6. **UEFI boot-lock app** (QEMU prototype only) — stretch goal

**In two weeks:** Implement items 1-5. Item 6 stays in QEMU.

### 8.5 Tools for UEFI development

- **EDK II / TianoCore** + **OVMF** (UEFI firmware for QEMU)
- **GNU-EFI** or **uefi-rs** for simpler apps
- **QEMU** with `-pflash OVMF.fd` for safe testing

**Rule:** Do ALL UEFI development in QEMU first. Only move to real hardware after app is proven to chain to `bootmgfw.efi` correctly.

---

## 9. Recommendations

1. **Prototype top-down first** (Credential Provider → Shell Launcher → BitLocker → BCD → UEFI in QEMU). Faster and safer than starting at firmware.
2. **BitLocker `manage-bde -forcerecovery` is the strongest, simplest remote kill switch.** Build server API and agent around it first.
3. **Do UEFI work only in QEMU/OVMF.** Do not flash real firmware in a 2-week sprint.
4. **Store recovery key securely on server.** Without it, forced recovery = permanent data loss.
5. **Disable WinRE and Safe Mode** in BCD to reduce bypass surface. Keep Windows install USB for recovery.
6. **Don't expect to match MKOPA/Android.** Windows PCs aren't factory-integrated financing devices. Aim for "best effort" multi-layer lockdown.
7. **Document every script and test on a VM first.** BitLocker and BCD mistakes are common ways to brick a thesis demo.

---

## 10. Key References

- Microsoft BitLocker docs: https://learn.microsoft.com/en-us/windows/security/operating-system-security/data-protection/bitlocker/
- manage-bde command: https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/manage-bde
- Shell Launcher: https://learn.microsoft.com/en-us/windows/configuration/shell-launcher/
- Credential Providers: https://learn.microsoft.com/en-us/windows/win32/secauthn/credential-providers-in-windows
- Assigned Access: https://learn.microsoft.com/en-us/windows/configuration/assigned-access/quickstart-kiosk
- UEFI 2.10 spec: https://uefi.org/specs/UEFI/2.10/02_Overview.html
- EDK2/OVMF: https://github.com/tianocore/edk2/blob/master/OvmfPkg/README
- NIST SP 800-193 (firmware resiliency): https://doi.org/10.6028/nist.sp.800-193
- Android Verified Boot: https://source.android.com/docs/security/features/verifiedboot/verified-boot
- Computrace analysis: https://blackhat.com/docs/us-14/materials/us-14-Kamluk-Kamluk-Computrace-Backdoor-Revisited.pdf
