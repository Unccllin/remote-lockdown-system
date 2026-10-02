"""firmware_audit.py — remote SPI/Secure-Boot protection audit for fleet
delivery decisions.

Reports what the OS can observe about the platform's firmware protection
posture so the operator can decide per-unit which PblPersistDxe delivery
path is possible (signed capsule / Setup-Mode enrollment / external flash).

This module answers ONE question for the operator: "can this machine's SPI
flash be written, and does Secure Boot constrain what we can load?" It does
NOT flash, write, or modify anything — it is read-only reconnaissance.

What it collects (all via PowerShell/WMI — no kernel driver required):

  - secure_boot_enabled   — Confirm-SecureBootUEFI (True/False/None)
  - setup_mode            — SetupMode UEFI var presence (db writable?)
  - bios_vendor/version   — Win32_BIOS (identifies flash tooling/family)
  - manufacturer/model    — Win32_ComputerSystem (OEM flash path differs)
  - bios_lock_reg         — SPI protection bits where readable
                          (BIOSWE/BLE/SMM_BWP via GetFirmwareEnvironmentVariable
                          is NOT available; real register read needs kernel —
                          we report what's observable and flag the rest)

Fields we CANNOT read from user-mode (reported as null with a note so the
operator knows the gap is "needs a driver/deeper probe", not "absent"):
  BIOSWE, BLE, SMM_BWP, PRR coverage — these require MMIO access to the SPI
  controller (BAR0), which needs a signed kernel driver or a UEFI app.

The server-side handler stores this in a firmware_audit JSONB column on the
device record, alongside the checkin.

Copyright (c) 2026 Remote Lockdown System. All rights reserved.
"""

import json
import logging
import platform
import subprocess

log = logging.getLogger(__name__)

_AUDIT_TIMEOUT = 15  # seconds per PowerShell call


def _ps(command: str, timeout: int = _AUDIT_TIMEOUT) -> str | None:
    """Run a PowerShell command, return stdout stripped or None on failure.

    Never raises — this is best-effort reconnaissance; a missing capability
    is data (the operator needs to know "can't read it"), not an error.
    """
    try:
        out = subprocess.check_output(
            ["powershell", "-NoProfile", "-NonInteractive", "-Command", command],
            timeout=timeout,
            stderr=subprocess.DEVNULL,
            text=True,
        )
        return out.strip() or None
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired, FileNotFoundError, OSError):
        return None


def _secure_boot_state() -> dict:
    """Probe Secure Boot state via Confirm-SecureBootUEFI.

    Returns dict with keys: enabled (bool|None), setup_mode (bool|None),
    error (str|None). Confirm-SecureBootUEFI throws when SB is unsupported
    or the cmdlet needs elevation — we surface that as nulls + note.
    """
    result: dict = {"enabled": None, "setup_mode": None, "note": None}

    # Confirm-SecureBootUEFI returns True/False, throws if unsupported or
    # insufficient privilege. We catch and read the error text.
    out = _ps(
        "try { Confirm-SecureBootUEFI } catch { Write-Output ('ERR:' + $_.Exception.Message) }"
    )
    if out is None:
        result["note"] = "powershell unavailable"
        return result
    if out == "True":
        result["enabled"] = True
    elif out == "False":
        result["enabled"] = False
    elif out and out.startswith("ERR:"):
        result["note"] = out[4:].strip()[:200]
        # Distinguish "not elevated" from "SB unsupported"
        if "privilege" in out.lower() or "administrator" in out.lower():
            result["note"] = "requires_elevation"
        elif "not supported" in out.lower() or "notimplemented" in out.lower():
            result["enabled"] = False
            result["note"] = "secure_boot_unsupported"
    return result


def _bios_info() -> dict:
    """BIOS vendor + version + manufacturer/model via Win32 classes."""
    info = {
        "bios_vendor": None,
        "bios_version": None,
        "manufacturer": None,
        "model": None,
    }
    bios = _ps(
        "Get-CimInstance -ClassName Win32_Bios | "
        "Select-Object -Property Manufacturer,SMBIOSBIOSVersion | "
        "ConvertTo-Json -Compress"
    )
    if bios:
        try:
            b = json.loads(bios)
            if isinstance(b, list):
                b = b[0]
            info["bios_vendor"] = b.get("Manufacturer")
            info["bios_version"] = b.get("SMBIOSBIOSVersion")
        except (json.JSONDecodeError, TypeError, IndexError):
            pass

    cs = _ps(
        "Get-CimInstance -ClassName Win32_ComputerSystem | "
        "Select-Object -Property Manufacturer,Model | "
        "ConvertTo-Json -Compress"
    )
    if cs:
        try:
            c = json.loads(cs)
            info["manufacturer"] = c.get("Manufacturer")
            info["model"] = c.get("Model")
        except (json.JSONDecodeError, TypeError):
            pass
    return info


def _tpm_present() -> bool | None:
    """TPM present flag via Win32_Tpm (None on failure)."""
    out = _ps(
        "try { (Get-CimInstance -ClassName Win32_Tpm "
        "-Namespace root\\cimv2\\security\\microsofttpm -ErrorAction Stop) "
        ".IsEnabled_InitialValue } catch { 'ERR' }"
    )
    if out is None or out == "ERR":
        return None
    return out.strip().lower() in ("true", "1")


def audit_firmware() -> dict:
    """Collect the firmware protection audit. Returns a dict for checkin.

    Always returns a dict (never None/raises) — partial data is still useful:
    even {secure_boot_enabled: null} tells the operator "unknown, needs a
    deeper probe" rather than silently omitting the field.

    On non-Windows platforms returns {platform: <os>, note: ...} so the
    server sees the audit ran but platform doesn't support it.
    """
    audit = {
        "platform": platform.system(),
        "secure_boot": None,
        "setup_mode": None,
        "bios_vendor": None,
        "bios_version": None,
        "manufacturer": None,
        "model": None,
        "tpm_enabled": None,
        "spi_registers": None,  # needs kernel driver — always null for now
        "note": None,
    }

    if platform.system() != "Windows":
        audit["note"] = "firmware audit only supported on Windows"
        return audit

    sb = _secure_boot_state()
    audit["secure_boot"] = sb["enabled"]
    audit["setup_mode"] = sb["setup_mode"]
    if sb["note"]:
        audit["note"] = sb["note"]

    bios = _bios_info()
    audit.update(bios)
    audit["tpm_enabled"] = _tpm_present()

    # Note for operator: SPI register reads need a kernel driver. We report
    # what's observable now; if the audit shows flash-write capability is
    # needed, that's a follow-up kernel-side probe (CHIPSEC-class).
    if audit["secure_boot"] == False and audit["note"] is None:  # noqa: E712 — distinguish False from None (unknown)
        audit["note"] = "secure_boot_off"

    log.debug("Firmware audit: %s", audit)
    return audit


__all__ = ["audit_firmware"]
