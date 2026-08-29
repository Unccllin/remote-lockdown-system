"""
HP UEFI/BIOS Lockdown Module
-----------------------------
Uses HP's WMI BIOS interface (root\\hp\\InstrumentedBIOS) to lock down the
boot process so a thief cannot boot from external media or enter BIOS setup.

What this module does on lockdown:
  1. Sets a BIOS Setup (supervisor) password — prevents entering BIOS setup (F10)
  2. Disables USB boot — prevents booting from USB sticks          [CRITICAL]
  3. Disables Network (PXE) boot — prevents booting from network   [CRITICAL]
  4. Disables Legacy/CSM boot — forces UEFI-only                   [CRITICAL]
  5. Disables F12 / One-Time Boot Menu                             [CRITICAL]
  6. Enables Fast Boot — prevents F-key interruption during POST   [BEST-EFFORT]
  7. Requires admin password for F12 boot menu                     [BEST-EFFORT]

CC19: Critical vs. best-effort split.
  - Critical settings close direct bypass vectors (USB/PXE boot, legacy boot,
    F12 boot menu). If ANY critical setting fails after the Setup Password is
    set, ALL BIOS changes are rolled back — BUT the Setup Password is NOT
    cleared (CC18: clearing it during rollback risks a BIOS-locked machine
    with no recorded password if the clear fails).
  - Best-effort settings (Fast Boot, F12 admin password prompt) are
    defense-in-depth. Failure is logged but does not trigger rollback.

CC18: Rollback on critical failure.
  - Rollback restores BIOS settings to pre-lockdown values (from .boot_state).
  - Rollback does NOT clear the Setup Password even if we set it.
    Rationale: if password-clear fails during rollback, the machine is
    BIOS-locked with no recorded password and no server ACK. Instead, the
    password is returned to the caller for server-side operator action.
  - Rollback failures are NON-FATAL: log ERROR, return False, do not raise.
  - Rollback is scoped to boot-state files (.boot_state) ONLY. It must NOT
    delete or touch the encryption key files (File A / File B).

Phase 4: Verification re-reads.
  - After setting each BIOS value, re-read it to verify it took effect.
  - If verification fails, treat as a failed setting (triggers rollback if critical).

Phase 4: apply_boot_lockdown() returns the password even on critical failure.
  - The password is needed for server-side operator action (manual BIOS clear).
  - The caller (agent.py) ACKs with key_material + bios_password + boot_lock_status: "partial".

Requirements:
  - HP business machine (EliteBook, ProBook, EliteDesk, ProDesk, etc.)
  - Windows with admin privileges
  - HP WMI BIOS interface (pre-installed on all HP business machines)

WMI interface reference:
  Namespace: root\\hp\\InstrumentedBIOS
  Classes:
    HP_BIOSSetting         — read setting (Name, Value, IsReadOnly)
    HP_BIOSEnumeration     — read enum setting (Name, CurrentValue, PossibleValues)
    HP_BIOSPassword        — read password info (Name, IsSet, MinLength, MaxLength)
    HP_BIOSSettingInterface — SetBIOSSetting(Name, Value, Password) method

  SetBIOSSetting return codes:
    0=Success, 1=NotSupported, 2=UnspecifiedError, 3=Timeout,
    4=Failed, 5=InvalidParameter, 6=AccessDenied

  Password format: "<utf-16/>" + password (UTF-16 encoding prefix required)
"""

import json
import logging
import os
import platform
import secrets
import string
import subprocess
from pathlib import Path

log = logging.getLogger("lockdown-agent")

HP_WMI_NAMESPACE = r"root\hp\InstrumentedBIOS"

# Dry-run mode: when True, all PowerShell/WMI calls are intercepted and
# their commands are printed instead of executed. No BIOS changes happen.
# Set via set_dry_run(True) or the LOCKDOWN_DRY_RUN=1 env var.
_DRY_RUN = os.environ.get("LOCKDOWN_DRY_RUN", "").lower() in ("1", "true", "yes")

# D-010: Module-level flag set by _check_sure_admin() during apply_boot_lockdown().
# Used by _verify_setting() to add a Sure Admin-specific warning when
# verification fails (Sure Admin silently blocks unsigned BIOS changes —
# the WMI set appears to succeed but the value doesn't change).
_sure_admin_active = False

# Simulated BIOS state for dry-run mode (mimics a typical HP EliteBook)
_DRY_RUN_BIOS_STATE = {
    "Setup Password": {"is_set": False},
    "Network (PXE) Boot": "Enable",
    "Network Boot": "Enable",
    "USB Boot": "Enable",
    "USB Storage Boot": "Enable",
    "USB Floppy/CD Boot": "Enable",
    "Legacy Boot Options": "Enable",
    "Legacy Support": "Enable",
    "Fast Boot": "Disable",
    "Prompt for Admin password on F12 (Network Boot)": "Disable",
    "F12 Boot Menu": "Enable",
    "One-Time Boot Menu": "Enable",
    # T2: Secure Boot (dry-run default: enabled)
    "Secure Boot": "Enable",
    "SecureBoot": "Enable",
    "Configure Legacy Support and Secure Boot": "Secure Boot",
    # T3: VT-d / IOMMU / DMA Protection (dry-run default: enabled)
    "VT-d": "Enable",
    "Intel VT-d": "Enable",
    "Virtualization Technology for Directed I/O": "Enable",
    "IOMMU": "Enable",
    "DMA Protection": "Enable",
    # T7: Power-On Password (dry-run default: not set)
    "Power-On Password": {"is_set": False},
    # T7: Sure Start BIOS Settings Protection (dry-run default: disabled)
    # If enabled, the lock-then-seal pattern would disable it before BIOS
    # changes and re-enable after. Default disabled so the path is not
    # triggered unless a test explicitly mocks it.
    "Sure Start BIOS Settings Protection": "Disable",
    # D-010: Sure Admin (EBAM) — dry-run default: disabled
    # The actual BIOS setting name is "Enhanced BIOS Authentication Mode (EBAM)"
    # per HP documentation (RESEARCH-HP-HARDWARE.md)
    "Enhanced BIOS Authentication Mode (EBAM)": "Disable",
}


def set_dry_run(enabled: bool) -> None:
    """Enable or disable dry-run mode."""
    global _DRY_RUN
    _DRY_RUN = enabled
    if enabled:
        log.info("DRY RUN mode enabled — no BIOS changes will be made")


# ---------------------------------------------------------------------------
# Admin check (Phase 4.1 — fail-fast before any state writes)
# ---------------------------------------------------------------------------


def _is_admin() -> bool:
    """Check if the current process has admin/elevation privileges.

    On Windows, uses `net session` (succeeds only as admin).
    On non-Windows, returns True (dry-run/test mode).
    In dry-run mode, always returns True.

    This is the FIRST check before any state-file writes or BIOS changes.
    Admin-failure is fail-fast, not rollback — there's nothing to roll back.
    """
    if _DRY_RUN:
        return True
    if platform.system() != "Windows":
        return True  # Non-Windows = test/dev environment
    try:
        result = subprocess.run(
            ["net", "session"],
            capture_output=True,
            text=True,
            timeout=5,
        )
        return result.returncode == 0
    except (subprocess.TimeoutExpired, FileNotFoundError, OSError):
        return False


# ---------------------------------------------------------------------------
# BIOS settings: critical vs. best-effort (CC19)
# ---------------------------------------------------------------------------
# D-009: Setting names are now model-aware. The CONCEPTS (what we want to
# disable) are defined here as canonical identifiers. The actual setting
# names vary by HP model and are resolved via _resolve_setting_names(),
# which checks a model-specific override file first, then falls back to
# the DEFAULT_SETTING_NAMES below.
#
# Each concept maps to a list of possible setting names (tried in order).
# The first name that exists on the machine is used. This handles the case
# where different HP models use different names for the same BIOS feature.

# Canonical concepts (stable identifiers, not displayed to users)
CONCEPTS = {
    "network_boot": "Disable",  # Disable PXE/network boot
    "usb_boot": "Disable",  # Disable USB boot
    "legacy_boot": "Disable",  # Force UEFI-only (no CSM)
    "boot_menu": "Disable",  # Disable F12/one-time boot menu
    "fast_boot": "Enable",  # Enable Fast Boot (best-effort)
    "f12_password": "Enable",  # Require password for F12 (best-effort)
    # T3: VT-d/IOMMU DMA protection (best-effort — blocks Thunderbolt/PCIe DMA attacks)
    "dma_protection": "Enable",  # Enable DMA Protection / IOMMU
}

# Default setting name aliases per concept (tried in order).
# These cover the most common HP EliteBook/ProBook/EliteDesk models.
# D-009: A model-specific override file (hp_model_overrides.json) can
# provide alternative names for models that use different naming.
DEFAULT_SETTING_NAMES = {
    "network_boot": ["Network (PXE) Boot", "Network Boot", "PXE Boot", "PXE ROM Boot"],
    "usb_boot": ["USB Boot", "USB Storage Boot", "USB Floppy/CD Boot", "USB Device Boot"],
    "legacy_boot": ["Legacy Boot Options", "Legacy Support", "CSM Support", "Compatibility Mode"],
    "boot_menu": ["F12 Boot Menu", "One-Time Boot Menu", "Boot Menu", "F12 Hot Key"],
    "fast_boot": ["Fast Boot", "FastBoot", "Quick Boot"],
    "f12_password": [
        "Prompt for Admin password on F12 (Network Boot)",
        "F12 Boot Menu Password",
        "Prompt for Setup Password on F12",
    ],
    # T3: VT-d / IOMMU / DMA Protection setting name aliases
    "dma_protection": [
        "DMA Protection",
        "VT-d",
        "Intel VT-d",
        "Virtualization Technology for Directed I/O",
        "IOMMU",
    ],
}

# Model-specific overrides (loaded from hp_model_overrides.json if present).
# Format: {"EliteBook 840 G7": {"network_boot": ["Custom PXE Name"], ...}}
_MODEL_OVERRIDES: dict | None = None

# Path to the model-specific override file
MODEL_OVERRIDES_FILE = Path(__file__).parent / "hp_model_overrides.json"


def _load_model_overrides() -> dict:
    """Load model-specific setting name overrides from JSON file.

    D-009: The override file is optional. If present, it maps HP model
    names (from WMI query) to dicts of concept -> list of setting names.
    This allows supporting HP models that use non-standard BIOS setting
    names without modifying the source code.
    """
    global _MODEL_OVERRIDES
    if _MODEL_OVERRIDES is not None:
        return _MODEL_OVERRIDES
    if not MODEL_OVERRIDES_FILE.exists():
        _MODEL_OVERRIDES = {}
        return _MODEL_OVERRIDES
    try:
        _MODEL_OVERRIDES = json.loads(MODEL_OVERRIDES_FILE.read_text())
        log.info("Loaded HP model overrides from %s", MODEL_OVERRIDES_FILE)
    except (OSError, json.JSONDecodeError, ValueError, TypeError) as e:
        log.warning("Failed to load HP model overrides: %s", e)
        _MODEL_OVERRIDES = {}
    return _MODEL_OVERRIDES


def _detect_hp_model() -> str | None:
    """Detect the HP model name via WMI.

    D-009: Queries Win32_ComputerSystem for the model name (e.g.,
    "HP EliteBook 840 G7"). Returns None if not available.
    """
    if _DRY_RUN:
        return "HP EliteBook 840 G7"  # Simulated model for dry-run
    if platform.system() != "Windows":
        return None
    try:
        output = _run_powershell("(Get-WmiObject -Class Win32_ComputerSystem).Model")
        model = output.strip() if output else ""
        return model if model else None
    except Exception as e:  # noqa: BLE001 — WMI/PowerShell may raise platform-specific errors
        log.debug("Failed to detect HP model: %s", e)
        return None


def _resolve_setting_names() -> tuple[list[tuple[str, str]], list[tuple[str, str]]]:
    """Resolve canonical concepts to actual BIOS setting names for this machine.

    D-009: This is the core of model-awareness. For each concept:
    1. Check if the detected HP model has overrides in hp_model_overrides.json
    2. If yes, use the override's setting name list
    3. If no, use DEFAULT_SETTING_NAMES
    4. For each candidate name, check if it exists on this machine via _read_setting()
    5. Use the first name that exists

    Returns:
        (critical_settings, best_effort_settings) — each is a list of
        (setting_name, lockdown_value) tuples, same format as the old
        HP_CRITICAL_SETTINGS / HP_BEST_EFFORT_SETTINGS.
    """
    model = _detect_hp_model()
    overrides = _load_model_overrides()
    model_overrides = {}
    if model:
        # Case-insensitive lookup — WMI may return different casing than the JSON
        for key in overrides:
            if key.lower() == model.lower():
                model_overrides = overrides[key]
                log.info("Using model-specific setting names for %s (matched %s)", model, key)
                break

    critical_concepts = ["network_boot", "usb_boot", "legacy_boot", "boot_menu"]
    # T3: dma_protection is best-effort — not all HP models support VT-d/IOMMU
    best_effort_concepts = ["fast_boot", "f12_password", "dma_protection"]

    def resolve_concept(concept: str) -> list[str]:
        """Get the list of candidate setting names for a concept."""
        if concept in model_overrides:
            names = model_overrides[concept]
            if isinstance(names, str):
                names = [names]
            elif not isinstance(names, list):
                log.warning(
                    "D-009: Invalid override type for concept '%s': %s — ignoring",
                    concept,
                    type(names).__name__,
                )
                return []
            return names
        return DEFAULT_SETTING_NAMES.get(concept, [])

    critical_settings = []
    best_effort_settings = []

    for concept in critical_concepts:
        lockdown_value = CONCEPTS[concept]
        candidates = resolve_concept(concept)
        for name in candidates:
            current = _read_setting(name)
            if current is not None:
                critical_settings.append((name, lockdown_value))
                log.info("D-009: Concept '%s' resolved to setting name '%s'", concept, name)
                break  # Use the first matching name
        else:
            log.debug("Concept '%s': no matching setting found on this model", concept)

    for concept in best_effort_concepts:
        lockdown_value = CONCEPTS[concept]
        candidates = resolve_concept(concept)
        for name in candidates:
            current = _read_setting(name)
            if current is not None:
                best_effort_settings.append((name, lockdown_value))
                log.info("D-009: Concept '%s' resolved to setting name '%s'", concept, name)
                break
        else:
            log.debug("Concept '%s': no matching setting found on this model", concept)

    return critical_settings, best_effort_settings


# Backward-compatible constants (used by tests and remove_boot_lockdown).
# These are the DEFAULT settings — apply_boot_lockdown() now uses
# _resolve_setting_names() for model-awareness, but these remain as
# the fallback/default list.
HP_CRITICAL_SETTINGS = [
    ("Network (PXE) Boot", "Disable"),
    ("Network Boot", "Disable"),
    ("USB Boot", "Disable"),
    ("USB Storage Boot", "Disable"),
    ("USB Floppy/CD Boot", "Disable"),
    ("Legacy Boot Options", "Disable"),
    ("Legacy Support", "Disable"),
    ("F12 Boot Menu", "Disable"),
    ("One-Time Boot Menu", "Disable"),
]

HP_BEST_EFFORT_SETTINGS = [
    ("Fast Boot", "Enable"),
    ("Prompt for Admin password on F12 (Network Boot)", "Enable"),
]

# Combined list (for state save/restore — saves ALL settings we might change)
ALL_LOCKDOWN_SETTINGS = HP_CRITICAL_SETTINGS + HP_BEST_EFFORT_SETTINGS

# File to save pre-lockdown BIOS state for restoration on recovery
BOOT_STATE_FILE = Path(__file__).parent / ".boot_state"

# Emergency password backup — written IMMEDIATELY after password generation,
# before any BIOS changes or ACK attempts. This is the safety net against
# the 3 critical password-loss risks:
#   R1: ACK fails + pending_ack file deleted
#   R2: Critical failure + crash before ACK
#   R3: Sure Admin blocks + pre-existing password unknown
# The backup file is encrypted with a simple XOR cipher using the agent's
# hardware UUID as the key (not cryptographically strong, but prevents
# casual discovery). The real protection is that this file is also covered
# by the tamper protection ACLs (DENY DELETE).
BIOS_PASSWORD_BACKUP_FILE = Path(__file__).parent / ".bios_pw_backup"


def _write_password_backup(bios_password: str, power_on_password: str | None = None) -> None:
    """Write BIOS passwords to an emergency backup file immediately after generation.

    This is the safety net against password loss. The file is written BEFORE
    any BIOS changes or ACK attempts, so even if the agent crashes, the
    password is recoverable from this file.

    The file contains a simple XOR-encrypted JSON blob (not strong crypto,
    but prevents casual discovery). The real protection is tamper protection
    ACLs on the file.
    """
    import json as _json
    import platform as _platform

    try:
        # Simple XOR cipher using hardware UUID as key
        # (not crypto-strong, but prevents casual discovery)
        key = _platform.node().encode("utf-8") or b"fallback-key"
        data = _json.dumps(
            {
                "bios_password": bios_password,
                "power_on_password": power_on_password,
                "timestamp": __import__("time").time(),
            }
        ).encode("utf-8")

        # XOR encrypt
        encrypted = bytes(b ^ key[i % len(key)] for i, b in enumerate(data))
        # Base64 encode for safe file storage
        import base64

        encoded = base64.b64encode(encrypted).decode("ascii")

        _atomic_write_text(BIOS_PASSWORD_BACKUP_FILE, encoded)
        log.info("BIOS password backup written to %s", BIOS_PASSWORD_BACKUP_FILE)
    except (OSError, ValueError, TypeError) as e:
        log.error("CRITICAL: Could not write BIOS password backup: %s", e)
        log.error("If lockdown proceeds, BIOS password may be unrecoverable if ACK fails")


def read_password_backup() -> dict | None:
    """Read BIOS passwords from the emergency backup file.

    Returns dict with bios_password and power_on_password, or None if
    the backup file doesn't exist or can't be decrypted.
    """
    import base64
    import json as _json
    import platform as _platform

    if not BIOS_PASSWORD_BACKUP_FILE.exists():
        return None
    try:
        encoded = BIOS_PASSWORD_BACKUP_FILE.read_text().strip()
        encrypted = base64.b64decode(encoded)
        key = _platform.node().encode("utf-8") or b"fallback-key"
        # XOR decrypt
        decrypted = bytes(b ^ key[i % len(key)] for i, b in enumerate(encrypted))
        data = _json.loads(decrypted.decode("utf-8"))
        return data
    except (OSError, json.JSONDecodeError, ValueError, TypeError) as e:
        log.error("Could not read BIOS password backup: %s", e)
        return None


def delete_password_backup() -> None:
    """Delete the BIOS password backup file (called after successful unlock)."""
    try:
        BIOS_PASSWORD_BACKUP_FILE.unlink(missing_ok=True)
        log.info("BIOS password backup deleted (unlock successful)")
    except (OSError, PermissionError) as e:
        log.warning("Could not delete BIOS password backup: %s", e)


def _atomic_write_text(path: Path, content: str) -> None:
    """Write text to a file atomically (write to temp + rename)."""
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(content)
    tmp.replace(path)


# Return code mapping for SetBIOSSetting
SET_BIOS_RETURN_CODES = {
    0: "Success",
    1: "Not Supported",
    2: "Unspecified Error",
    3: "Timeout",
    4: "Failed",
    5: "Invalid Parameter",
    6: "Access Denied",
}


# ---------------------------------------------------------------------------
# PowerShell / WMI helpers
# ---------------------------------------------------------------------------


def _run_powershell(script: str, timeout: int = 30) -> str:
    """Run a PowerShell command and return stdout. Raises on failure."""
    if _DRY_RUN:
        print(f"  [DRY-RUN] PowerShell: {script}")
        return _dry_run_powershell_response(script)
    result = subprocess.run(
        ["powershell", "-NoProfile", "-NonInteractive", "-Command", script],
        capture_output=True,
        text=True,
        timeout=timeout,
    )
    if result.returncode != 0:
        raise RuntimeError(
            f"PowerShell failed (exit {result.returncode}): {result.stderr.strip()}. "
            "Fix: ensure PowerShell is available, the script has no syntax errors, "
            "and the agent is running with sufficient privileges (Administrator)."
        )
    return result.stdout.strip()


def _dry_run_powershell_response(script: str) -> str:
    """Return a simulated response for a PowerShell WMI query in dry-run mode."""
    # Detect what kind of query this is and return simulated data
    if "HP_BIOSSetting " in script and "Select-Object -First 1" in script:
        # is_hp_machine check
        return "Fast Boot"  # non-empty = HP machine detected
    if "net session" in script:
        # _is_admin check
        return ""  # non-empty = admin
    if "HP_BIOSPassword" in script and "IsSet" in script:
        # _is_setup_password_set or _is_power_on_password_set check
        if "Power-On Password" in script:
            return "0"  # Power-On Password not set
        return "0"  # Setup Password not set
    if "HP_BIOSEnumeration" in script and "CurrentValue" in script:
        # _read_setting from enumeration
        for name, val in _DRY_RUN_BIOS_STATE.items():
            if f"Name='{name}'" in script:
                return str(val)
        return ""
    if "HP_BIOSSetting" in script and ".Value" in script:
        # _read_setting from BIOSSetting
        for name, val in _DRY_RUN_BIOS_STATE.items():
            if f"Name='{name}'" in script:
                return str(val)
        return ""
    if "SetBIOSSetting" in script:
        # _set_setting — simulate success and update dry-run state
        for name in _DRY_RUN_BIOS_STATE:
            if f"'{name}'" in script:
                if name == "Setup Password":
                    _DRY_RUN_BIOS_STATE[name]["is_set"] = True
                else:
                    # Parse the value — it's the second arg to SetBIOSSetting
                    pass
                return "0"
        return "0"
    return ""


def is_hp_machine() -> bool:
    """Check if this is an HP machine by looking for the HP WMI namespace."""
    if _DRY_RUN:
        return True
    if platform.system() != "Windows":
        return False
    try:
        output = _run_powershell(
            f"Get-WmiObject -Namespace '{HP_WMI_NAMESPACE}' -Class HP_BIOSSetting "
            f"| Select-Object -First 1 -ExpandProperty Name"
        )
        return bool(output)
    except Exception:  # noqa: BLE001 — WMI/PowerShell may raise platform-specific errors
        return False


# ---------------------------------------------------------------------------
# HP Sure Admin / Sure Run / Sure Start awareness (D-010)
# ---------------------------------------------------------------------------
# Modern enterprise HPs (2022+) ship with HP Sure Start enabled by default.
# Sure Start will revert unauthorized BIOS changes on the next reboot.
# So even if SetBIOSSetting returns 0, the setting may be restored to
# factory defaults within one boot cycle.
#
# HP Sure Admin is a hardware root-of-trust feature that requires BIOS
# changes to be signed by an authorized key. If Sure Admin is enabled,
# our unsigned SetBIOSSetting calls will be accepted by WMI but rejected
# by the hardware on next boot.
#
# Close criteria for D-010: Agent detects Sure Admin and either works
# with it or reports blocked. This code implements the "detect and report"
# path — the agent checks for Sure Admin/Sure Run/Sure Start and includes
# the status in the boot lockdown result dict. The operator can then
# decide whether to proceed (knowing changes may be reverted) or to
# disable Sure Admin in BIOS first.
#
# Detection is done via:
# 1. WMI query for HP_BIOSSetting with names containing "Sure Admin",
#    "Sure Run", or "Sure Start"
# 2. If any of these settings exist and are enabled, the agent reports
#    sure_admin_detected: True in the result dict


def _check_sure_admin() -> dict:
    """Check for HP Sure Admin / Sure Run / Sure Start features.

    D-010: Returns a dict with:
      - sure_admin_detected: bool — True if Sure Admin is enabled
      - sure_run_detected: bool — True if Sure Run is enabled
      - sure_start_detected: bool — True if Sure Start is enabled
      - any_sure_feature: bool — True if ANY Sure feature is enabled
      - warning: str | None — warning message if a Sure feature may
        revert BIOS changes

    Research (RESEARCH-HP-HARDWARE.md):
      - Sure Admin BIOS setting: "Enhanced BIOS Authentication Mode (EBAM)"
        (not "Sure Admin" — that's the marketing name, not the BIOS setting)
      - Sure Start BIOS setting: "Sure Start BIOS Settings Protection"
        (the BSP check in _check_sure_start_bsp() already uses the correct name;
        this function checks for the general Sure Start self-healing feature)
      - Sure Run: NOT a standard BIOS setting. Detected via the HPSureRun
        Windows service or BIOS display-only settings under SPM menu.
      - WQL LIKE operator supports substring matching: WHERE Name LIKE '%Sure%'
    """
    result = {
        "sure_admin_detected": False,
        "sure_run_detected": False,
        "sure_start_detected": False,
        "any_sure_feature": False,
        "warning": None,
    }

    # D-010: Sure Admin — the actual BIOS setting name is "Enhanced BIOS
    # Authentication Mode (EBAM)", not "Sure Admin". Keep old names as
    # fallbacks for older HP models that may use different naming.
    sure_admin_names = [
        "Enhanced BIOS Authentication Mode (EBAM)",
        "Enhanced BIOS Authentication Mode",
        "EBAM",
        "Sure Admin",
        "HP Sure Admin",
    ]

    for name in sure_admin_names:
        value = _read_setting(name)
        if value is not None:
            value_lower = value.lower().strip()
            if value_lower in ("enable", "enabled", "on", "true", "1", "yes", "active"):
                result["sure_admin_detected"] = True
                log.warning("D-010: Sure Admin (EBAM) is enabled — BIOS changes may be reverted")
            break

    # D-010: Sure Start — check for the general Sure Start self-healing
    # feature. The BSP-specific check is in _check_sure_start_bsp().
    # Use exact names first, then WQL LIKE substring match as fallback.
    sure_start_names = [
        "Sure Start BIOS Settings Protection",
        "BIOS Settings Protection",
        "Sure Start",
        "HP Sure Start",
    ]

    sure_start_found = False
    for name in sure_start_names:
        value = _read_setting(name)
        if value is not None:
            value_lower = value.lower().strip()
            if value_lower in ("enable", "enabled", "on", "true", "1", "yes", "active"):
                result["sure_start_detected"] = True
                log.warning("D-010: Sure Start is enabled — BIOS changes may be reverted")
            sure_start_found = True
            break

    # WQL LIKE substring fallback for Sure Start — catches variants like
    # "Sure Start Hardware Self-Healing" that we don't have as exact candidates
    if not sure_start_found and not _DRY_RUN:
        try:
            output = _run_powershell(
                f"Get-WmiObject -Namespace '{HP_WMI_NAMESPACE}' "
                f"-Class HP_BIOSEnumeration -Filter \"Name LIKE '%Sure Start%'\" | "
                f'ForEach-Object {{ Write-Output "$($_.Name)=$($_.CurrentValue)" }}'
            )
            if output:
                for line in output.split("\n"):
                    if "=" in line:
                        sname, sval = line.split("=", 1)
                        sval_lower = sval.lower().strip()
                        if sval_lower in ("enable", "enabled", "on", "true", "1", "yes", "active"):
                            result["sure_start_detected"] = True
                            log.warning("D-010: Sure Start variant '%s' is enabled", sname)
                            break
        except Exception as e:  # noqa: BLE001 — WMI/PowerShell may raise platform-specific errors
            log.debug("D-010: Sure Start WQL LIKE fallback failed: %s", e)

    # D-010: Sure Run — NOT a standard BIOS setting on most models.
    # Try BIOS display-only settings first, then fall back to Windows service check.
    sure_run_names = [
        "HP Sure Run Current State",
        "HP Sure Run",
        "Sure Run",
        "HP Sure Run",
    ]

    sure_run_found = False
    for name in sure_run_names:
        value = _read_setting(name)
        if value is not None:
            value_lower = value.lower().strip()
            if value_lower in (
                "enable",
                "enabled",
                "on",
                "true",
                "1",
                "yes",
                "active",
                "provisioned",
            ):
                result["sure_run_detected"] = True
                log.warning("D-010: Sure Run is enabled (BIOS setting '%s')", name)
            sure_run_found = True
            break

    # Sure Run service-based detection — check if the HPSureRun Windows
    # service exists and is running. This is more reliable than BIOS settings
    # on models where Sure Run is managed via HP Client Security Manager.
    if not sure_run_found and not _DRY_RUN:
        try:
            output = _run_powershell(
                "(Get-Service -Name HPSureRun -ErrorAction SilentlyContinue).Status"
            )
            if output and output.strip().lower() == "running":
                result["sure_run_detected"] = True
                log.warning("D-010: Sure Run is enabled (HPSureRun service is running)")
        except Exception as e:  # noqa: BLE001 — WMI/PowerShell may raise platform-specific errors
            log.debug("D-010: Sure Run service check failed: %s", e)

    result["any_sure_feature"] = (
        result["sure_admin_detected"]
        or result["sure_run_detected"]
        or result["sure_start_detected"]
    )

    # D-010: Set module-level flag for _verify_setting() to use
    global _sure_admin_active
    _sure_admin_active = result["sure_admin_detected"]

    if result["any_sure_feature"]:
        features = []
        if result["sure_admin_detected"]:
            features.append("Sure Admin (EBAM)")
        if result["sure_run_detected"]:
            features.append("Sure Run")
        if result["sure_start_detected"]:
            features.append("Sure Start")
        result["warning"] = (
            f"HP {'+'.join(features)} detected. BIOS changes may be reverted "
            f"on next boot. Consider disabling these features in BIOS before "
            f"applying lockdown, or use HP Sure Admin signed commands."
        )

    return result


# ---------------------------------------------------------------------------
# Secure Boot verification (T2)
# ---------------------------------------------------------------------------
# Secure Boot ensures only signed, trusted bootloaders can run. If it's
# disabled, an attacker can boot an unsigned bootloader from external media
# (even with USB boot disabled, some DMA-based attacks can bypass this).
# The agent verifies Secure Boot is enabled and warns if it's not.
# This is verification-only — the agent does NOT enable Secure Boot (that
# requires a platform key and should be done via GPO or HP CMSL, not during
# a lockdown emergency).


def _check_secure_boot() -> dict:
    """Check Secure Boot status via HP WMI.

    T2: Returns a dict with:
      - enabled: bool — True if Secure Boot is enabled
      - setting_name: str | None — the BIOS setting name that was found
      - warning: str | None — warning message if Secure Boot is disabled
    """
    result = {
        "enabled": False,
        "setting_name": None,
        "warning": None,
    }

    # Candidate setting names for Secure Boot across HP models
    secure_boot_names = [
        "Secure Boot",
        "SecureBoot",
        "Configure Legacy Support and Secure Boot",
    ]

    for name in secure_boot_names:
        value = _read_setting(name)
        if value is not None:
            result["setting_name"] = name
            value_lower = value.lower().strip()
            # "Secure Boot" enum value or "Enable"/"Enabled"
            if value_lower in ("enable", "enabled", "on", "true", "1", "secure boot"):
                result["enabled"] = True
                log.info("T2: Secure Boot is enabled (setting '%s' = '%s')", name, value)
            else:
                result["enabled"] = False
                result["warning"] = (
                    f"Secure Boot is disabled (setting '{name}' = '{value}'). "
                    f"An attacker may boot an unsigned bootloader. "
                    f"Enable Secure Boot in BIOS or via GPO."
                )
                log.warning("T2: %s", result["warning"])
            break  # Found the setting, no need to check aliases

    if result["setting_name"] is None:
        result["warning"] = (
            "Secure Boot setting not found in HP WMI. "
            "The machine may not support Secure Boot or uses a non-standard setting name."
        )
        log.debug("T2: Secure Boot setting not found in WMI")

    return result


# ---------------------------------------------------------------------------
# Sure Start BIOS Settings Protection — lock-then-seal (T7, Q2=A)
# ---------------------------------------------------------------------------
# HP Sure Start BIOS Settings Protection (BSP) is a feature that monitors BIOS
# settings and reverts unauthorized changes on the next boot. If BSP is enabled
# when we apply lockdown, our BIOS changes will be silently reverted — the
# agent reports success but the machine isn't actually locked down.
#
# The "lock then seal" pattern (Q2=A):
#   1. Check if BSP is enabled
#   2. If enabled, disable it (using the Setup Password as authorization)
#   3. Apply all lockdown BIOS settings
#   4. Re-enable BSP (so the lockdown settings become tamper-proof)
#
# This is distinct from the general Sure Start feature check in _check_sure_admin().
# That function checks if "Sure Start" (the self-healing BIOS feature) is present.
# This function checks specifically for "BIOS Settings Protection" (the sub-feature
# that reverts setting changes).
#
# Candidate setting names across HP models:
#   "Sure Start BIOS Settings Protection"
#   "BIOS Settings Protection"
#   "Sure Start Settings Protection"


# T7: Candidate setting names for Sure Start BSP
_SURE_START_BSP_NAMES = [
    "Sure Start BIOS Settings Protection",
    "BIOS Settings Protection",
    "Sure Start Settings Protection",
]


def _check_sure_start_bsp() -> dict:
    """Check if Sure Start BIOS Settings Protection is enabled.

    T7: Returns a dict with:
      - enabled: bool — True if BSP is enabled
      - setting_name: str | None — the setting name that was found
      - warning: str | None — warning message if BSP is enabled
    """
    result = {
        "enabled": False,
        "setting_name": None,
        "warning": None,
    }

    for name in _SURE_START_BSP_NAMES:
        value = _read_setting(name)
        if value is not None:
            result["setting_name"] = name
            value_lower = value.lower().strip()
            if value_lower in ("enable", "enabled", "on", "true", "1", "yes", "active"):
                result["enabled"] = True
                result["warning"] = (
                    f"Sure Start BIOS Settings Protection is enabled (setting '{name}'). "
                    f"BIOS changes will be reverted on next boot unless BSP is disabled first. "
                    f"Using lock-then-seal pattern: disable BSP -> apply lockdown -> re-enable BSP."
                )
                log.warning("T7: %s", result["warning"])
            else:
                log.info("T7: Sure Start BSP is disabled (setting '%s' = '%s')", name, value)
            break

    if result["setting_name"] is None:
        log.debug("T7: Sure Start BSP setting not found in WMI — not supported on this model")

    return result


def _disable_sure_start_bsp(setup_password: str) -> bool:
    """Disable Sure Start BIOS Settings Protection before lockdown changes.

    T7: Uses the Setup Password as authorization. Returns True on success.
    """
    for name in _SURE_START_BSP_NAMES:
        value = _read_setting(name)
        if value is not None:
            rc = _set_setting(name, "Disable", setup_password)
            if rc == 0:
                log.info("T7: Sure Start BSP disabled (setting '%s')", name)
                return True
            log.warning(
                "T7: Failed to disable Sure Start BSP '%s': %s",
                name,
                SET_BIOS_RETURN_CODES.get(rc, f"code {rc}"),
            )
            return False
    log.debug("T7: Sure Start BSP setting not found — nothing to disable")
    return True  # Not found = nothing to disable = success


def _enable_sure_start_bsp(setup_password: str) -> bool:
    """Re-enable Sure Start BIOS Settings Protection after lockdown changes.

    T7: Called after all lockdown settings are applied so they become
    tamper-proof. Returns True on success.
    """
    for name in _SURE_START_BSP_NAMES:
        value = _read_setting(name)
        if value is not None:
            rc = _set_setting(name, "Enable", setup_password)
            if rc == 0:
                log.info("T7: Sure Start BSP re-enabled (setting '%s') — lockdown sealed", name)
                return True
            log.warning(
                "T7: Failed to re-enable Sure Start BSP '%s': %s",
                name,
                SET_BIOS_RETURN_CODES.get(rc, f"code {rc}"),
            )
            return False
    log.debug("T7: Sure Start BSP setting not found — nothing to re-enable")
    return True  # Not found = nothing to re-enable = success


# ---------------------------------------------------------------------------
# BitLocker awareness for BIOS changes (T5)
# ---------------------------------------------------------------------------
# Q8=A: BIOS setting changes can alter PCR measurements, potentially triggering
# a BitLocker recovery prompt on the next boot. This is especially catastrophic
# once PBA is enabled — a BitLocker recovery prompt on a PBA-protected machine
# is a brick (the agent can't boot to receive unlock commands).
#
# This mirrors the D-008 pattern from bcd_lockdown.py: suspend BitLocker
# protectors before BIOS changes, resume after. The functions are duplicated
# here (not imported from bcd_lockdown) because the two modules use different
# command execution patterns (this module uses _run_powershell for WMI, but
# manage-bde is a command-line tool that's cleaner via subprocess directly).

# T5: Simulated BitLocker state for dry-run
_DRY_RUN_BITLOCKER_ENABLED = False
_DRY_RUN_BITLOCKER_SUSPENDED = False


def _run_cmd(cmd: list[str], timeout: int = 10) -> tuple[int, str, str]:
    """Run a command-line tool (manage-bde) and return (rc, stdout, stderr).

    T5: Used for BitLocker management commands. Not using _run_powershell
    because manage-bde is a CLI tool, not a PowerShell cmdlet.
    """
    if _DRY_RUN:
        cmd_str = " ".join(cmd)
        print(f"  [DRY-RUN] {cmd_str}")
        global _DRY_RUN_BITLOCKER_SUSPENDED
        if "manage-bde" in cmd and "-status" in cmd:
            status = "Protection On" if _DRY_RUN_BITLOCKER_ENABLED else "Protection Off"
            return (
                0,
                f"    Protection Status:    {status}\n    Conversion Status:    100% Encrypted",
                "",
            )
        if "manage-bde" in cmd and "-disable" in cmd:
            if _DRY_RUN_BITLOCKER_ENABLED:
                _DRY_RUN_BITLOCKER_SUSPENDED = True
            return 0, "", ""
        if "manage-bde" in cmd and "-enable" in cmd:
            _DRY_RUN_BITLOCKER_SUSPENDED = False
            return 0, "", ""
        return 0, "", ""
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        return result.returncode, result.stdout.strip(), result.stderr.strip()
    except FileNotFoundError:
        return -1, "", f"Command not found: {cmd[0]}"
    except subprocess.TimeoutExpired:
        return -2, "", f"Command timed out: {' '.join(cmd)}"
    except (OSError, subprocess.SubprocessError) as e:
        return -3, "", str(e)


def _check_bitlocker() -> dict:
    """Check BitLocker status on the system drive (C:).

    T5: Returns a dict with:
      - enabled: bool — True if BitLocker is ON
      - suspended: bool — True if protectors are suspended
      - percentage: str — encryption percentage
      - error: str | None — error message if the check failed
    """
    if _DRY_RUN:
        return {
            "enabled": _DRY_RUN_BITLOCKER_ENABLED,
            "suspended": _DRY_RUN_BITLOCKER_SUSPENDED,
            "percentage": "100%" if _DRY_RUN_BITLOCKER_ENABLED else "0%",
            "error": None,
        }
    if platform.system() != "Windows":
        return {"enabled": False, "suspended": False, "percentage": "0%", "error": None}
    try:
        rc, stdout, stderr = _run_cmd(["manage-bde", "-status", "C:"], timeout=10)
        if rc != 0:
            return {
                "enabled": False,
                "suspended": False,
                "percentage": "0%",
                "error": f"manage-bde failed: {stderr}",
            }
        enabled = False
        suspended = False
        percentage = "0%"
        for line in stdout.split("\n"):
            line_lower = line.strip().lower()
            if "protection status" in line_lower and "protection on" in line_lower:
                enabled = True
            if "protection status" in line_lower and "protection off" in line_lower:
                suspended = "suspended" in line_lower
            if "conversion status" in line_lower:
                parts = line.strip().split()
                for part in parts:
                    if "%" in part:
                        percentage = part
                        break
        return {
            "enabled": enabled,
            "suspended": suspended,
            "percentage": percentage,
            "error": None,
        }
    except (OSError, ValueError, TypeError) as e:
        return {"enabled": False, "suspended": False, "percentage": "0%", "error": str(e)}


def _suspend_bitlocker() -> bool:
    """Suspend BitLocker protectors on C: before BIOS changes (T5).

    Returns True if suspension succeeded (or BitLocker was not enabled).
    """
    if _DRY_RUN:
        global _DRY_RUN_BITLOCKER_SUSPENDED
        if _DRY_RUN_BITLOCKER_ENABLED:
            _DRY_RUN_BITLOCKER_SUSPENDED = True
            log.info("[DRY-RUN] BitLocker protectors suspended on C: (for BIOS changes)")
        return True
    if platform.system() != "Windows":
        return True
    try:
        rc, _, stderr = _run_cmd(
            ["manage-bde", "-protectors", "-disable", "C:", "-rebootcount", "1"], timeout=10
        )
        if rc == 0:
            log.info("T5: BitLocker protectors suspended on C: (auto-resume after 1 reboot)")
            return True
        log.warning("T5: Failed to suspend BitLocker protectors: %s", stderr)
        return False
    except (OSError, ValueError, TypeError) as e:
        log.warning("T5: Failed to suspend BitLocker protectors: %s", e)
        return False


def _resume_bitlocker() -> bool:
    """Resume BitLocker protectors on C: after BIOS changes (T5).

    Returns True if resumption succeeded (or BitLocker was not enabled).
    """
    if _DRY_RUN:
        global _DRY_RUN_BITLOCKER_SUSPENDED
        _DRY_RUN_BITLOCKER_SUSPENDED = False
        if _DRY_RUN_BITLOCKER_ENABLED:
            log.info("[DRY-RUN] BitLocker protectors resumed on C: (after BIOS changes)")
        return True
    if platform.system() != "Windows":
        return True
    try:
        rc, _, stderr = _run_cmd(["manage-bde", "-protectors", "-enable", "C:"], timeout=10)
        if rc == 0:
            log.info("T5: BitLocker protectors resumed on C: (after BIOS changes)")
            return True
        log.warning("T5: Failed to resume BitLocker protectors: %s", stderr)
        return False
    except (OSError, ValueError, TypeError) as e:
        log.warning("T5: Failed to resume BitLocker protectors: %s", e)
        return False


def _read_setting(name: str) -> str | None:
    """Read the current value of a BIOS setting. Returns None if not found."""
    if _DRY_RUN:
        val = _DRY_RUN_BIOS_STATE.get(name)
        if isinstance(val, dict):
            return None
        return val
    # D-014: Escape single quotes in the filter value, matching _set_setting
    escaped_name = name.replace("'", "''")
    # Try HP_BIOSEnumeration first (most settings are here)
    try:
        output = _run_powershell(
            f"(Get-WmiObject -Namespace '{HP_WMI_NAMESPACE}' "
            f"-Class HP_BIOSEnumeration -Filter \"Name='{escaped_name}'\").CurrentValue"
        )
        if output:
            return output
    except Exception as e:  # noqa: BLE001 — WMI/PowerShell may raise platform-specific errors
        log.debug("HP_BIOSEnumeration query failed for '%s': %s", name, e)
    # Fall back to HP_BIOSSetting
    try:
        output = _run_powershell(
            f"(Get-WmiObject -Namespace '{HP_WMI_NAMESPACE}' "
            f"-Class HP_BIOSSetting -Filter \"Name='{escaped_name}'\").Value"
        )
        if output:
            return output
    except Exception as e:  # noqa: BLE001 — WMI/PowerShell may raise platform-specific errors
        log.debug("HP_BIOSSetting query failed for '%s': %s", name, e)
    return None


def _set_setting(name: str, value: str, password: str | None) -> int:
    """Set a BIOS setting. Returns the WMI return code (0 = success)."""
    if _DRY_RUN:
        print(f"  [DRY-RUN] SetBIOSSetting('{name}', '{value}', '***')")
        # Update simulated state
        # T7: Power-On Password is stored as a dict with is_set, like Setup Password
        if name in ("Setup Password", "Power-On Password"):
            _DRY_RUN_BIOS_STATE[name]["is_set"] = bool(value)
        else:
            _DRY_RUN_BIOS_STATE[name] = value
        return 0
    pw_format = f"<utf-16/>{password}" if password else "<utf-16/>"
    # Escape single quotes in the name and value for the PowerShell filter
    escaped_name = name.replace("'", "''")
    escaped_value = value.replace("'", "''")
    script = (
        f"$iface = Get-WmiObject -Namespace '{HP_WMI_NAMESPACE}' "
        f"-Class HP_BIOSSettingInterface; "
        f"$result = $iface.SetBIOSSetting('{escaped_name}', "
        f"'<utf-16/>{escaped_value}', '{pw_format}'); "
        f"Write-Output $result.Return"
    )
    output = _run_powershell(script)
    return int(output) if output.isdigit() else -1


def _verify_setting(name: str, expected_value: str) -> bool:
    """Verify a BIOS setting took effect by re-reading it (Phase 4.5 / D-013).

    Returns True if the setting matches expected_value, False otherwise.
    D-010: When verification fails and Sure Admin is active, adds a specific
    warning — Sure Admin silently blocks unsigned BIOS changes (the WMI set
    appears to succeed but the value doesn't change).
    """
    current = _read_setting(name)
    if current is None:
        log.warning("Could not verify BIOS setting '%s' (read failed)", name)
        return False
    if current.lower() != expected_value.lower():
        log.warning(
            "BIOS setting '%s' verification failed: expected '%s', got '%s'",
            name,
            expected_value,
            current,
        )
        # D-010: Sure Admin silent failure warning
        if _sure_admin_active:
            log.warning(
                "D-010: BIOS setting '%s' was not applied — Sure Admin (EBAM) "
                "may be blocking unsigned changes. Use HP CMSL signed commands "
                "or disable Sure Admin in BIOS.",
                name,
            )
        return False
    log.info("BIOS setting '%s' -> %s (verified)", name, expected_value)
    return True


def _set_and_verify(name: str, value: str, password: str) -> bool:
    """Set a BIOS setting and verify it took effect (Phase 4.5).

    Returns True if the setting was applied AND verified, False otherwise.
    """
    rc = _set_setting(name, value, password)
    if rc != 0:
        log.warning(
            "BIOS setting '%s' -> '%s' failed: %s",
            name,
            value,
            SET_BIOS_RETURN_CODES.get(rc, f"code {rc}"),
        )
        return False
    return _verify_setting(name, value)


def _is_setup_password_set() -> bool:
    """Check if a BIOS Setup password is currently set."""
    if _DRY_RUN:
        return _DRY_RUN_BIOS_STATE.get("Setup Password", {}).get("is_set", False)
    try:
        output = _run_powershell(
            f"(Get-WmiObject -Namespace '{HP_WMI_NAMESPACE}' "
            f"-Class HP_BIOSPassword -Filter \"Name='Setup Password'\").IsSet"
        )
        return output.strip().lower() in ("1", "true")
    except Exception:  # noqa: BLE001 — WMI/PowerShell may raise platform-specific errors
        return False


# ---------------------------------------------------------------------------
# HP Power-On Password (T7 — Tier 1 PBA)
# ---------------------------------------------------------------------------
# Q1=A: PBA is opt-in via enable_pba flag (default False).
# The Power-On Password is a BIOS-level pre-boot password that must be entered
# before the machine will boot. This is Tier 1 PBA — it prevents booting without
# the password, even from external media.
#
# The Power-On Password requires the Setup Password to be set first (HP BIOS
# requires the Setup Password as authorization to set the Power-On Password).
# Once set, the machine will prompt for the Power-On Password on every cold
# boot and warm reboot.
#
# CRITICAL TRADE-OFF (Q1): Once PBA is enabled, a rebooted device CANNOT be
# remotely recovered — the agent can't boot to receive unlock commands. The
# operator must physically enter the Power-On Password to boot the machine.
# This is why PBA is opt-in, not default.


def _is_power_on_password_supported() -> bool:
    """Check if this HP machine supports the Power-On Password feature.

    T7: Enumerates HP_BIOSPassword instances and checks for "Power-On Password".
    Not all HP models support a separate Power-On Password (some only have
    Setup Password).
    """
    if _DRY_RUN:
        return True  # Simulated support for dry-run
    if platform.system() != "Windows":
        return False
    try:
        output = _run_powershell(
            f"Get-WmiObject -Namespace '{HP_WMI_NAMESPACE}' "
            f"-Class HP_BIOSPassword -Filter \"Name='Power-On Password'\" "
            f"| Select-Object -ExpandProperty Name"
        )
        return bool(output and output.strip())
    except Exception:  # noqa: BLE001 — WMI/PowerShell may raise platform-specific errors
        return False


def _is_power_on_password_set() -> bool:
    """Check if a Power-On Password is currently set."""
    if _DRY_RUN:
        return _DRY_RUN_BIOS_STATE.get("Power-On Password", {}).get("is_set", False)
    try:
        output = _run_powershell(
            f"(Get-WmiObject -Namespace '{HP_WMI_NAMESPACE}' "
            f"-Class HP_BIOSPassword -Filter \"Name='Power-On Password'\").IsSet"
        )
        return output.strip().lower() in ("1", "true")
    except Exception:  # noqa: BLE001 — WMI/PowerShell may raise platform-specific errors
        return False


def set_power_on_password(password: str, setup_password: str) -> int:
    """Set the HP Power-On Password (Tier 1 PBA).

    T7: Requires the Setup Password to be set first (used as authorization).
    Returns the WMI return code (0 = success, 1 = Not Supported).
    """
    return _set_setting("Power-On Password", password, setup_password)


def clear_power_on_password(setup_password: str) -> int:
    """Clear the HP Power-On Password.

    T7: Called during remove_boot_lockdown when PBA was active.
    Requires the Setup Password as authorization.
    Returns the WMI return code (0 = success).
    """
    return _set_setting("Power-On Password", "", setup_password)


# ---------------------------------------------------------------------------
# Password generation
# ---------------------------------------------------------------------------


def generate_bios_password(length: int = 12) -> str:
    """Generate a random BIOS-compatible password.

    HP BIOS passwords: 4-15 characters, alphanumeric + common symbols.
    We use uppercase + lowercase + digits (avoid special chars that may
    cause keyboard layout issues in pre-boot environment).
    """
    alphabet = string.ascii_letters + string.digits
    return "".join(secrets.choice(alphabet) for _ in range(length))


# ---------------------------------------------------------------------------
# State save / restore
# ---------------------------------------------------------------------------


def save_boot_state(password_was_set: bool, settings: dict) -> None:
    """Save pre-lockdown BIOS state to a file for later restoration."""
    state = {
        "setup_password_was_set": password_was_set,
        "settings": settings,  # {setting_name: original_value}
    }
    _atomic_write_text(BOOT_STATE_FILE, json.dumps(state, indent=2))
    log.info("Boot state saved to %s", BOOT_STATE_FILE)


def load_boot_state() -> dict | None:
    """Load saved boot state. Returns None if no state file exists."""
    if not BOOT_STATE_FILE.exists():
        return None
    try:
        return json.loads(BOOT_STATE_FILE.read_text())
    except (OSError, json.JSONDecodeError, ValueError, TypeError) as e:
        log.error("Could not read boot state: %s", e)
        return None


def clear_boot_state() -> None:
    """Remove the boot state file."""
    if BOOT_STATE_FILE.exists():
        BOOT_STATE_FILE.unlink()
        log.info("Boot state file removed")


# ---------------------------------------------------------------------------
# Rollback (CC18 — on critical failure, restore BIOS to pre-lockdown state)
# ---------------------------------------------------------------------------


def _rollback_bios_settings(saved_settings: dict, bios_password: str) -> bool:
    """Restore BIOS settings to pre-lockdown values.

    CC18: Does NOT clear the Setup Password even if we set it.
    Rationale: if password-clear fails during rollback, the machine is
    BIOS-locked with no recorded password and no server ACK. Instead,
    the password is returned to the caller for server-side operator action.

    CC18: Rollback failures are NON-FATAL. Log ERROR, return False, do not raise.

    This function is scoped to boot-state files (.boot_state) ONLY. It must
    NOT touch the encryption key files (File A / File B).

    Returns True if all restorations succeeded, False if any failed.
    """
    log.warning("Rolling back BIOS changes due to critical failure...")
    all_ok = True

    for setting_name, original_value in saved_settings.items():
        rc = _set_setting(setting_name, original_value, bios_password)
        if rc == 0:
            # D-013: Verify rollback actually took effect (safety-net path)
            if _verify_setting(setting_name, original_value):
                log.info("Rollback: %s -> %s (restored and verified)", setting_name, original_value)
            else:
                log.error(
                    "Rollback: %s -> %s verification failed — "
                    "setting may not be restored (non-fatal, continuing)",
                    setting_name,
                    original_value,
                )
                all_ok = False
        else:
            log.error(
                "Rollback: failed to restore '%s' to '%s': %s — non-fatal, continuing",
                setting_name,
                original_value,
                SET_BIOS_RETURN_CODES.get(rc, f"code {rc}"),
            )
            all_ok = False

    # Remove the boot state file (rollback complete)
    clear_boot_state()

    if all_ok:
        log.info("BIOS rollback complete — settings restored (password NOT cleared per CC18)")
    else:
        log.error("BIOS rollback completed with errors — some settings may need manual restoration")
    return all_ok


# ---------------------------------------------------------------------------
# Public API: apply / remove boot lockdown
# ---------------------------------------------------------------------------


def apply_boot_lockdown(
    existing_password: str | None = None,
    enable_pba: bool = False,
) -> dict:
    """Apply UEFI/BIOS lockdown on an HP machine.

    Phase 4 changes:
      - Admin check first (fail-fast before any state writes)
      - Critical/best-effort split (CC19)
      - Verification re-reads after each setting (Phase 4.5)
      - Rollback on critical failure (CC18) — does NOT clear Setup Password
      - Returns a dict with password + status (password returned even on critical failure)

    T7 changes (Phase 2 PBA):
      - enable_pba flag (Q1=A, default False): when True, sets HP Power-On
        Password after Setup Password for Tier 1 pre-boot authentication
      - Sure Admin report-blocked (Q3=B): if Sure Admin is detected, skips all
        BIOS changes and reports bios_lockdown_blocked=True
      - Sure Start BSP lock-then-seal (Q2=A): if BIOS Settings Protection is
        enabled, disables it before BIOS changes and re-enables after, so
        lockdown settings become tamper-proof

    Args:
        existing_password: The current BIOS Setup password, if one is already
            set. If None and no password is set, a new random password is
            generated. If None and a password IS set, the lockdown cannot
            proceed (we can't authenticate BIOS changes without it).
        enable_pba: If True, set HP Power-On Password for Tier 1 PBA.
            Default False — PBA is opt-in (Q1=A) because it prevents remote
            recovery of rebooted devices.

    Returns:
        dict with keys:
          - bios_password: str | None — the BIOS password (for server-side storage).
            Returned even on critical failure (for operator manual BIOS clear).
          - power_on_password: str | None — T7: the Power-On Password (for
            server-side storage). Only set when enable_pba=True.
          - success: bool — True if all critical settings applied successfully
          - partial: bool — True if some best-effort settings failed (but critical OK)
          - rolled_back: bool — True if a critical failure triggered rollback
          - critical_applied: int — number of critical settings applied
          - best_effort_applied: int — number of best-effort settings applied
          - best_effort_failed: int — number of best-effort settings that failed
          - not_hp: bool — True if not an HP machine (nothing done)
          - bios_lockdown_blocked: bool — T7: True if Sure Admin blocked BIOS changes
          - sure_admin_status: dict | None — D-010: Sure Admin/Sure Run/Sure
            Start detection status (sure_admin_detected, sure_run_detected,
            sure_start_detected, any_sure_feature, warning)
          - sure_start_bsp_status: dict | None — T7: Sure Start BIOS Settings
            Protection status (enabled, setting_name, warning)
          - secure_boot_status: dict | None — T2: Secure Boot verification
            (enabled, setting_name, warning)
          - bitlocker_status: dict | None — T5: BitLocker status for BIOS
            changes (enabled, suspended, percentage, error)
    """
    result = {
        "bios_password": None,
        "power_on_password": None,  # T7: Power-On Password for PBA
        "success": False,
        "partial": False,
        "rolled_back": False,
        "critical_applied": 0,
        "best_effort_applied": 0,
        "best_effort_failed": 0,
        "not_hp": False,
        "bios_lockdown_blocked": False,  # T7: Sure Admin blocked BIOS changes
        "sure_admin_status": None,  # D-010: Sure Admin/Sure Run/Sure Start
        "sure_start_bsp_status": None,  # T7: Sure Start BSP lock-then-seal
        "secure_boot_status": None,  # T2: Secure Boot verification
        "bitlocker_status": None,  # T5: BitLocker awareness for BIOS changes
    }

    if not is_hp_machine():
        log.warning("Not an HP machine — skipping UEFI lockdown")
        result["not_hp"] = True
        result["success"] = True  # Not an error — just nothing to do
        return result

    # D-010: Check for HP Sure Admin / Sure Run / Sure Start.
    # T7 (Q3=B): If Sure Admin is detected, skip ALL BIOS changes and report
    # blocked. Sure Admin requires signed payloads which we don't support.
    # Attempting unsigned SetBIOSSetting calls would be silently rejected by
    # the hardware on next boot — the same "trust return code 0" problem we
    # fixed with D-013. Reporting blocked is honest and safe.
    sure_admin_status = _check_sure_admin()
    result["sure_admin_status"] = sure_admin_status
    if sure_admin_status["sure_admin_detected"]:
        log.error(
            "T7: Sure Admin is enabled — BIOS changes blocked. "
            "Disable Sure Admin or provision SPM keys for signed commands."
        )
        result["bios_lockdown_blocked"] = True
        # Still report Secure Boot status for operator awareness
        result["secure_boot_status"] = _check_secure_boot()
        return result
    if sure_admin_status["any_sure_feature"]:
        log.warning("D-010: %s", sure_admin_status["warning"])

    # T2: Verify Secure Boot is enabled. This is verification-only — the agent
    # does NOT enable Secure Boot (that requires a platform key). If it's off,
    # the operator is warned via the ACK's secure_boot_status field.
    secure_boot_status = _check_secure_boot()
    result["secure_boot_status"] = secure_boot_status
    if not secure_boot_status["enabled"] and secure_boot_status["warning"]:
        log.warning("T2: %s", secure_boot_status["warning"])

    # Phase 4.1: Admin check — fail-fast before any state writes
    if not _is_admin():
        log.error("UEFI lockdown requires admin privileges — aborting (fail-fast)")
        return result

    # T5: Check BitLocker status before BIOS changes. If BitLocker is enabled,
    # suspend protectors to prevent recovery key prompt on next boot (Q8=A).
    # Resume after all BIOS changes are complete (both success and rollback paths).
    bitlocker = _check_bitlocker()
    result["bitlocker_status"] = bitlocker
    bitlocker_was_suspended = False
    if bitlocker["enabled"]:
        log.warning(
            "T5: BitLocker is enabled (%s encrypted) — suspending protectors before BIOS changes",
            bitlocker["percentage"],
        )
        if _suspend_bitlocker():
            bitlocker_was_suspended = True
        else:
            log.error(
                "T5: Failed to suspend BitLocker — BIOS changes may trigger recovery key prompt"
            )
            # Proceed anyway — the operator is warned via the ACK's bitlocker_status

    # Determine the password to use
    password_already_set = _is_setup_password_set()
    if password_already_set and not existing_password:
        log.error(
            "BIOS Setup password is already set but no UEFI_PASSWORD configured. "
            "Cannot apply BIOS lockdown without the existing password. "
            "Set UEFI_PASSWORD in the agent config to the current BIOS password."
        )
        return result

    if not password_already_set:
        # Generate a new password and set it
        bios_password = generate_bios_password()
        # SAFETY: Write password backup IMMEDIATELY after generation,
        # before any BIOS changes or ACK attempts. This ensures the
        # password is recoverable even if the agent crashes (R2) or
        # ACK fails + pending_ack is deleted (R1).
        _write_password_backup(bios_password)
        log.info("Setting new BIOS Setup password...")
        rc = _set_setting("Setup Password", bios_password, None)
        if rc != 0:
            log.error(
                "Failed to set Setup password: %s", SET_BIOS_RETURN_CODES.get(rc, f"code {rc}")
            )
            return result
        # Return password even on verification failure (for operator manual BIOS clear)
        result["bios_password"] = bios_password
        # D-013: Verify the password was actually set (not just rc==0)
        if not _is_setup_password_set():
            log.error(
                "BIOS Setup password verification failed — "
                "SetBIOSSetting returned success but password is not set"
            )
            return result
        log.info("BIOS Setup password set successfully (verified)")
    else:
        # Use the existing password to authorize changes
        bios_password = existing_password
        log.info("Using existing BIOS Setup password for lockdown changes")

    # Always return the password, even on critical failure (CC18)
    result["bios_password"] = bios_password

    # T7: Set Power-On Password for Tier 1 PBA (Q1=A — opt-in).
    # The Power-On Password must be set AFTER the Setup Password (HP BIOS
    # requires the Setup Password as authorization). It's returned in the
    # result dict for server-side storage and used during unlock to clear it.
    if enable_pba:
        if not _is_power_on_password_supported():
            log.warning(
                "T7: Power-On Password not supported on this HP model — "
                "PBA cannot be applied (enable_pba=True was requested)"
            )
        elif _is_power_on_password_set():
            log.warning("T7: Power-On Password is already set — not overwriting")
        else:
            power_on_pw = generate_bios_password()
            # SAFETY: Update backup with power-on password too
            _write_password_backup(bios_password, power_on_pw)
            log.info("T7: Setting Power-On Password for Tier 1 PBA...")
            rc = set_power_on_password(power_on_pw, bios_password)
            if rc != 0:
                log.error(
                    "T7: Failed to set Power-On Password: %s — PBA not active",
                    SET_BIOS_RETURN_CODES.get(rc, f"code {rc}"),
                )
            else:
                # D-013: Verify the password was actually set
                if not _is_power_on_password_set():
                    log.error(
                        "T7: Power-On Password verification failed — "
                        "SetBIOSSetting returned success but password is not set"
                    )
                else:
                    result["power_on_password"] = power_on_pw
                    log.info("T7: Power-On Password set successfully (verified) — PBA active")

    # T7: Sure Start BSP lock-then-seal (Q2=A).
    # If BIOS Settings Protection is enabled, disable it before applying
    # lockdown settings, then re-enable after so the settings become
    # tamper-proof. If BSP is not supported or already disabled, skip.
    sure_start_bsp = _check_sure_start_bsp()
    result["sure_start_bsp_status"] = sure_start_bsp
    bsp_was_disabled = False
    if sure_start_bsp["enabled"]:
        log.info("T7: Sure Start BSP is enabled — disabling before lockdown (lock-then-seal)")
        if _disable_sure_start_bsp(bios_password):
            bsp_was_disabled = True
        else:
            log.error(
                "T7: Failed to disable Sure Start BSP — BIOS changes may be reverted on next boot"
            )
            # Proceed anyway — the operator is warned via sure_start_bsp_status

    # D-009: Resolve setting names for this specific HP model.
    # This replaces the hardcoded HP_CRITICAL_SETTINGS / HP_BEST_EFFORT_SETTINGS
    # with model-aware setting names.
    critical_settings, best_effort_settings = _resolve_setting_names()
    all_settings = critical_settings + best_effort_settings

    if not critical_settings:
        log.warning(
            "D-009: No critical BIOS settings found for this HP model. "
            "The model may use non-standard setting names. "
            "Add an override in hp_model_overrides.json."
        )
        result["success"] = False
        result["critical_applied"] = 0
        result["best_effort_applied"] = 0
        result["best_effort_failed"] = 0
        result["no_critical_settings"] = True
        # T7: Re-enable BSP if we disabled it (nothing to seal, but restore state)
        if bsp_was_disabled:
            _enable_sure_start_bsp(bios_password)
        # T5: Resume BitLocker if suspended
        if bitlocker_was_suspended:
            _resume_bitlocker()
        return result

    # Save current state of all settings we're about to change (for rollback)
    saved_settings = {}
    for setting_name, _ in all_settings:
        current = _read_setting(setting_name)
        if current is not None:
            saved_settings[setting_name] = current

    save_boot_state(password_already_set, saved_settings)

    # --- Apply critical settings (with verification re-reads) ---
    critical_applied = 0
    critical_failed = 0
    for setting_name, lockdown_value in critical_settings:
        current = _read_setting(setting_name)
        if current is None:
            # Setting doesn't exist on this model — skip (not a failure)
            log.debug("Setting '%s' not supported on this model — skipping", setting_name)
            continue
        if current == lockdown_value:
            # Already in desired state — count as applied
            critical_applied += 1
            continue
        if _set_and_verify(setting_name, lockdown_value, bios_password):
            critical_applied += 1
        else:
            critical_failed += 1

    # --- Check for critical failure -> rollback (CC18) ---
    if critical_failed > 0:
        log.error(
            "UEFI lockdown: %d critical setting(s) failed — rolling back BIOS changes",
            critical_failed,
        )
        # CC18: Rollback does NOT clear the Setup Password
        _rollback_bios_settings(saved_settings, bios_password)
        result["rolled_back"] = True
        result["success"] = False
        # T7: Re-enable Sure Start BSP (rollback path — restore to pre-lockdown state)
        if bsp_was_disabled:
            _enable_sure_start_bsp(bios_password)
        # T5: Resume BitLocker protectors after BIOS changes (rollback path)
        if bitlocker_was_suspended:
            _resume_bitlocker()
        # Password is still returned (already set above) for server-side operator action
        return result

    # --- Apply best-effort settings (failure does not trigger rollback) ---
    best_effort_applied = 0
    best_effort_failed = 0
    for setting_name, lockdown_value in best_effort_settings:
        current = _read_setting(setting_name)
        if current is None:
            log.debug("Setting '%s' not supported on this model — skipping", setting_name)
            continue
        if current == lockdown_value:
            best_effort_applied += 1
            continue
        if _set_and_verify(setting_name, lockdown_value, bios_password):
            best_effort_applied += 1
        else:
            best_effort_failed += 1
            log.warning("BEST-EFFORT: '%s' failed — continuing (not critical)", setting_name)

    log.info(
        "UEFI lockdown applied: %d critical, %d best-effort succeeded, %d best-effort failed",
        critical_applied,
        best_effort_applied,
        best_effort_failed,
    )

    result["success"] = True
    result["partial"] = best_effort_failed > 0
    result["critical_applied"] = critical_applied
    result["best_effort_applied"] = best_effort_applied
    result["best_effort_failed"] = best_effort_failed
    # T7: Re-enable Sure Start BSP (lock-then-seal step 2 — seal the lockdown)
    if bsp_was_disabled:
        _enable_sure_start_bsp(bios_password)
    # T5: Resume BitLocker protectors after BIOS changes (success path)
    if bitlocker_was_suspended:
        _resume_bitlocker()
    return result


def remove_boot_lockdown(
    bios_password: str,
    power_on_password: str | None = None,
) -> bool:
    """Remove UEFI/BIOS lockdown and restore original settings.

    T7: If power_on_password is provided, clears the Power-On Password
    (Tier 1 PBA removal). The presence of power_on_password indicates
    PBA was active during lockdown.

    Args:
        bios_password: The BIOS Setup password that was set during lockdown
            (received from the server in the unlock command).
        power_on_password: T7: The Power-On Password that was set during
            lockdown, if PBA was enabled. If provided, it's cleared after
            BIOS settings are restored. If None, PBA was not active.

    Returns:
        True if lockdown was successfully removed, False otherwise.
    """
    if not is_hp_machine():
        log.warning("Not an HP machine — skipping UEFI lockdown removal")
        return True  # Nothing to remove

    # Phase 4.1: Admin check
    if not _is_admin():
        log.error("UEFI lockdown removal requires admin privileges — aborting")
        return False

    # T5: Suspend BitLocker before BIOS restore (same as apply path)
    bitlocker = _check_bitlocker()
    bitlocker_was_suspended = False
    if bitlocker["enabled"]:
        log.info("T5: BitLocker enabled — suspending protectors before BIOS restore")
        if _suspend_bitlocker():
            bitlocker_was_suspended = True

    # T7: Disable Sure Start BSP before BIOS restore (lock-then-seal for removal)
    bsp_was_disabled = False
    sure_start_bsp = _check_sure_start_bsp()
    if sure_start_bsp["enabled"]:
        log.info("T7: Sure Start BSP enabled — disabling before BIOS restore")
        if _disable_sure_start_bsp(bios_password):
            bsp_was_disabled = True

    state = load_boot_state()
    # D-009: Resolve model-specific setting names so we restore the right ones
    critical_settings, best_effort_settings = _resolve_setting_names()
    resolved_settings = critical_settings + best_effort_settings

    if not state:
        log.warning("No saved boot state — restoring BIOS settings to safe defaults")
        restore_settings = {}
        for setting_name, _ in resolved_settings:
            restore_settings[setting_name] = None  # None = set to safe default
    else:
        restore_settings = state.get("settings", {})

    # Build safe defaults from the resolved settings (inverse of lockdown values)
    safe_defaults = {}
    for setting_name, lockdown_value in resolved_settings:
        # Safe default is the opposite of the lockdown value
        if lockdown_value == "Disable":
            safe_defaults[setting_name] = "Enable"
        else:
            safe_defaults[setting_name] = "Disable"

    restored = 0
    for setting_name, _ in resolved_settings:
        original = restore_settings.get(setting_name)
        if original is None:
            # Use safe default
            original = safe_defaults.get(setting_name)
        if original is None:
            continue

        rc = _set_setting(setting_name, original, bios_password)
        if rc == 0:
            # D-013: Verify restore actually took effect
            if _verify_setting(setting_name, original):
                restored += 1
            else:
                log.warning(
                    "BIOS setting '%s' restore verification failed — setting may not be restored",
                    setting_name,
                )
        elif rc == 1:
            log.debug("Setting '%s' not supported — skipping restore", setting_name)
        else:
            log.warning(
                "Failed to restore '%s' to '%s': %s",
                setting_name,
                original,
                SET_BIOS_RETURN_CODES.get(rc, f"code {rc}"),
            )

    log.info("Restored %d BIOS settings to pre-lockdown state", restored)

    # T7: Clear Power-On Password if PBA was active (power_on_password provided).
    # This must be done BEFORE clearing the Setup Password, because clearing
    # the Power-On Password requires the Setup Password as authorization.
    if power_on_password:
        if _is_power_on_password_set():
            log.info("T7: Clearing Power-On Password (PBA removal)...")
            rc = clear_power_on_password(bios_password)
            if rc == 0:
                if _is_power_on_password_set():
                    log.warning(
                        "T7: Power-On Password clear verification failed — "
                        "SetBIOSSetting returned success but password is still set. "
                        "Admin may need to clear it manually in BIOS."
                    )
                else:
                    log.info("T7: Power-On Password cleared successfully (verified)")
            else:
                log.warning(
                    "T7: Failed to clear Power-On Password: %s — "
                    "admin may need to clear it manually in BIOS",
                    SET_BIOS_RETURN_CODES.get(rc, f"code {rc}"),
                )
        else:
            log.info("T7: Power-On Password not set — nothing to clear")

    # Clear the Setup password if we were the ones who set it
    if state and not state.get("setup_password_was_set", False):
        log.info("Clearing BIOS Setup password (was set by lockdown agent)...")
        rc = _set_setting("Setup Password", "", bios_password)
        if rc == 0:
            # D-013: Verify the password was actually cleared
            if _is_setup_password_set():
                log.warning(
                    "BIOS Setup password clear verification failed — "
                    "SetBIOSSetting returned success but password is still set. "
                    "Admin may need to clear it manually in BIOS."
                )
            else:
                log.info("BIOS Setup password cleared successfully (verified)")
        else:
            log.warning(
                "Failed to clear Setup password: %s — admin may need to clear it manually in BIOS",
                SET_BIOS_RETURN_CODES.get(rc, f"code {rc}"),
            )
    else:
        log.info("Setup password was pre-existing — not clearing (admin manages it)")

    clear_boot_state()

    # T7: Re-enable Sure Start BSP after BIOS restore (seal the restoration)
    if bsp_was_disabled:
        _enable_sure_start_bsp(bios_password)

    # T5: Resume BitLocker protectors after BIOS restore
    if bitlocker_was_suspended:
        _resume_bitlocker()

    # SAFETY: Delete the password backup file now that unlock is complete
    delete_password_backup()

    return True
