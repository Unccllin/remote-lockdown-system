# Research: HP Hardware — BIOS Setting Names & Sure Admin/Start/Run

> **Date:** 2026-08-14
> **Purpose:** Close D-009 (HP UEFI setting names) and D-010 (Sure Admin
> awareness) with documented evidence from primary sources.
> **Status:** Research complete — code changes implemented

## D-009: HP UEFI Setting Names

### Verified BIOS Setting Names

| Setting | Confirmed Name(s) | Source |
|---------|-------------------|--------|
| Power-On Password | "Power-On Password" | HP Linux kernel driver `bioscfg.h`¹ |
| Setup Password | "Setup Password" | HP Linux kernel driver `bioscfg.h`¹, HP Developer Portal² |
| Network Boot | "Network (PXE) Boot", "Network Boot" | HP BIOS Simulator Manual³ |
| Fast Boot | "Fast Boot" | HP Support Documentation⁴ |
| DMA Protection | "DMA Protection", "VT-d", "Intel VT-d", "IOMMU" | HP Secured-core PC Report⁵ |
| Secure Boot | "Secure Boot", "Configure Legacy Support and Secure Boot" | HP BIOS Setup Whitepaper⁶ |

### Assessment of Current Agent Code

The current `DEFAULT_SETTING_NAMES` in `agent/hp_uefi_lockdown.py` is
**confirmed correct** — all candidate names match HP documentation.
No changes needed for D-009.

## D-010: HP Sure Admin / Sure Start / Sure Run

### Sure Admin

- **BIOS setting name:** "Enhanced BIOS Authentication Mode (EBAM)"
  - Source: HP Developer Portal⁷, HP Connect User Guide⁸, HP BIOS Setup Whitepaper⁶
  - HP documentation: "We will use HP Sure Admin and EBAM interchangeably"
- **CMSL cmdlet:** `Get-HPSureAdminState` — retrieves current Sure Admin state
  - Source: https://developers.hp.com/hp-client-management/doc/firmware
- **Also relevant:** `Get-HPSecurePlatformState` — retrieves SPM state
  (Sure Admin requires SPM to be provisioned)
- **Behavior:** Blocks ALL unsigned BIOS changes. WMI set appears to
  succeed but change is NOT applied. Sure Start reverts it on next boot.
- **No bypass without SPM signing key.**

### Sure Start

- **BIOS setting name:** "Sure Start BIOS Settings Protection"
  - Source: HP BIOS Setup Whitepaper⁶, HP Sure Start Manual⁹
  - Description: "Protects critical BIOS Settings by saving a backup
    copy and restoring them if altered."
- **No dedicated CMSL cmdlet** — managed through standard BIOS settings
  via `HP_BIOSEnumeration` in `root\HP\InstrumentedBIOS`.
- **Q2=A (lock then seal) validated:** Sure Start reverts unauthorized
  changes; disable → apply → re-enable is the documented approach.

### Sure Run

- **NOT a standard BIOS setting name.** BIOS display-only settings under
  "Secure Platform Management (SPM)" menu:
  - "HP Sure Run Current State" (Display Only) — Values: Active/Inactive
  - "HP Sure Run" (Display Only) — Values: Provisioned/Not provisioned
- **Windows service name:** `HPSureRun`
  - Source: HP Support Community¹⁰, registry path
    `LocalMachine\SYSTEM\CurrentControlSet\Services\HPSureRun`
- **HP Client Security Manager service:** `DpHost` (display name:
  "Authentication Service" or "DigitalPersona Authentication Service")
- **No dedicated CMSL cmdlet** for Sure Run status.
- **Detection approach:** Check `HPSureRun` Windows service + check
  BIOS display-only settings via `HP_BIOSEnumeration`.

### WQL Substring Matching

HP WMI `HP_BIOSEnumeration` supports WQL `LIKE` operator with `%` wildcard:
```wql
SELECT Name, CurrentValue FROM HP_BIOSEnumeration WHERE Name LIKE '%Sure%'
```
This enables substring matching for Sure feature detection without
enumerating all settings.

### HP CMSL Cmdlets for Sure Feature Detection

| Cmdlet | Purpose |
|--------|---------|
| `Get-HPSureAdminState` | Sure Admin state |
| `Get-HPSecurePlatformState` | SPM state (prerequisite for Sure Admin) |
| `Get-HPBIOSSetting` | Check if a specific setting exists |
| `Get-HPBIOSSettingsList` | Enumerate all BIOS settings |

## Code Changes Implemented

### 1. Sure Admin detection (Q1)
- Added "Enhanced BIOS Authentication Mode (EBAM)" and "EBAM" as
  candidate setting names (first in the list — most likely to match)
- Kept "Sure Admin" and "HP Sure Admin" as fallbacks
- Added optional CMSL detection via `Get-HPSureAdminState` (if CMSL
  is installed, this is more reliable than BIOS setting name lookup)

### 2. Sure Start detection (Q2)
- Added "Sure Start BIOS Settings Protection" and "BIOS Settings
  Protection" as candidate setting names
- Added WQL LIKE substring matching as fallback: if no exact match,
  query `WHERE Name LIKE '%Sure Start%'` to catch any variant

### 3. Sure Run detection (Q3)
- Added "HP Sure Run Current State" and "HP Sure Run" as BIOS setting
  candidates (display-only settings, but may be readable via WMI)
- Added Windows service check for `HPSureRun` service as secondary
  detection — `Get-Service HPSureRun` via PowerShell

### 4. Sure Admin silent failure warning (Q4)
- When `_set_and_verify()` fails and Sure Admin is detected, the
  warning message now includes: "Sure Admin (EBAM) may be blocking
  unsigned changes. Use HP CMSL signed commands or disable Sure Admin
  in BIOS."

## Primary Sources

1. HP Linux kernel driver: https://kernel.googlesource.com/pub/scm/linux/kernel/git/ido/linux/+/3dc58c9ce1c5802fec680cb4e95962f1430d5771/drivers/platform/x86/hp/hp-bioscfg/bioscfg.h
2. HP Developer Portal — BIOS and Device: https://developers.hp.com/hp-client-management/doc/bios-and-device
3. HP BIOS Simulator Manual: https://h10032.www1.hp.com/ctg/Manual/c06489420.pdf
4. HP Support — Fast Boot: https://support.hp.com/us-en/document/c04136030
5. HP Secured-core PC Report: https://support.hpwolf.com/s/article/Secured-Core-PC-Report
6. HP BIOS Setup Whitepaper: https://ftp.hp.com/pub/caps-softpaq/cmit/whitepapers/HPBIOSSetup.pdf
7. HP Developer Portal — Sure Admin and CMSL: https://developers.hp.com/hp-client-management/blog/secure-bios-hp-sure-admin-and-cmsl
8. HP Connect User Guide: https://connect.admin.hp.com/static/HPConnectUserGuide.pdf
9. HP Sure Start Manual: https://h10032.www1.hp.com/ctg/Manual/c05423300.pdf
10. HP Support Community — HPSureRun service: https://h30434.www3.hp.com/t5/Business-Notebooks/HP-Sure-Run-cannot-start/td-p/7065529
11. HP CMSL Firmware docs: https://developers.hp.com/hp-client-management/doc/firmware
12. HP CMSL Get-HPBIOSSettingsList: https://developers.hp.com/hp-client-management/doc/Get-HPBIOSSettingsList
13. Microsoft WQL LIKE operator: https://learn.microsoft.com/en-us/windows/win32/wmisdk/like-operator
