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
    except Exception:
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
}

# Model-specific overrides (loaded from hp_model_overrides.json if present).
# Format: {"EliteBook 840 G7": {"network_boot": ["Custom PXE Name"], ...}}
_MODEL_OVERRIDES: dict | None = None

# Path to the model-specific override file
MODEL_OVERRIDES_FILE = Path(__file__).parent / "hp_model_overrides.json"


def _load_model_overrides() -> dict:
    """Load model-specific setting name overrides from JSON file.

    D-009: The override file is optional. If present, it maps HP model
    names (from WMI query) to dicts of concept → list of setting names.
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
    except Exception as e:
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
    except Exception as e:
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
    best_effort_concepts = ["fast_boot", "f12_password"]

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
        raise RuntimeError(f"PowerShell failed (exit {result.returncode}): {result.stderr.strip()}")
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
        # _is_setup_password_set check
        return "0"  # password not set
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
    except Exception:
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
    """
    result = {
        "sure_admin_detected": False,
        "sure_run_detected": False,
        "sure_start_detected": False,
        "any_sure_feature": False,
        "warning": None,
    }

    # Check each Sure feature via WMI
    sure_features = {
        "sure_admin_detected": ["Sure Admin", "HP Sure Admin"],
        "sure_run_detected": ["Sure Run", "HP Sure Run"],
        "sure_start_detected": ["Sure Start", "HP Sure Start"],
    }

    for result_key, setting_names in sure_features.items():
        for name in setting_names:
            value = _read_setting(name)
            if value is not None:
                # Check if the feature is enabled
                value_lower = value.lower().strip()
                if value_lower in ("enable", "enabled", "on", "true", "1", "yes", "active"):
                    result[result_key] = True
                    log.warning("D-010: %s is enabled — BIOS changes may be reverted", name)
                break  # Found the setting, no need to check aliases

    result["any_sure_feature"] = (
        result["sure_admin_detected"]
        or result["sure_run_detected"]
        or result["sure_start_detected"]
    )

    if result["any_sure_feature"]:
        features = []
        if result["sure_admin_detected"]:
            features.append("Sure Admin")
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
    except Exception as e:
        log.debug("HP_BIOSEnumeration query failed for '%s': %s", name, e)
    # Fall back to HP_BIOSSetting
    try:
        output = _run_powershell(
            f"(Get-WmiObject -Namespace '{HP_WMI_NAMESPACE}' "
            f"-Class HP_BIOSSetting -Filter \"Name='{escaped_name}'\").Value"
        )
        if output:
            return output
    except Exception as e:
        log.debug("HP_BIOSSetting query failed for '%s': %s", name, e)
    return None


def _set_setting(name: str, value: str, password: str | None) -> int:
    """Set a BIOS setting. Returns the WMI return code (0 = success)."""
    if _DRY_RUN:
        print(f"  [DRY-RUN] SetBIOSSetting('{name}', '{value}', '***')")
        # Update simulated state
        if name == "Setup Password":
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
        return False
    log.info("BIOS setting '%s' → %s (verified)", name, expected_value)
    return True


def _set_and_verify(name: str, value: str, password: str) -> bool:
    """Set a BIOS setting and verify it took effect (Phase 4.5).

    Returns True if the setting was applied AND verified, False otherwise.
    """
    rc = _set_setting(name, value, password)
    if rc != 0:
        log.warning(
            "BIOS setting '%s' → '%s' failed: %s",
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
    except Exception:
        return False


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
    except Exception as e:
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
                log.info("Rollback: %s → %s (restored and verified)", setting_name, original_value)
            else:
                log.error(
                    "Rollback: %s → %s verification failed — "
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


def apply_boot_lockdown(existing_password: str | None = None) -> dict:
    """Apply UEFI/BIOS lockdown on an HP machine.

    Phase 4 changes:
      - Admin check first (fail-fast before any state writes)
      - Critical/best-effort split (CC19)
      - Verification re-reads after each setting (Phase 4.5)
      - Rollback on critical failure (CC18) — does NOT clear Setup Password
      - Returns a dict with password + status (password returned even on critical failure)

    Args:
        existing_password: The current BIOS Setup password, if one is already
            set. If None and no password is set, a new random password is
            generated. If None and a password IS set, the lockdown cannot
            proceed (we can't authenticate BIOS changes without it).

    Returns:
        dict with keys:
          - bios_password: str | None — the BIOS password (for server-side storage).
            Returned even on critical failure (for operator manual BIOS clear).
          - success: bool — True if all critical settings applied successfully
          - partial: bool — True if some best-effort settings failed (but critical OK)
          - rolled_back: bool — True if a critical failure triggered rollback
          - critical_applied: int — number of critical settings applied
          - best_effort_applied: int — number of best-effort settings applied
          - best_effort_failed: int — number of best-effort settings that failed
          - not_hp: bool — True if not an HP machine (nothing done)
          - sure_admin_status: dict | None — D-010: Sure Admin/Sure Run/Sure
            Start detection status (sure_admin_detected, sure_run_detected,
            sure_start_detected, any_sure_feature, warning)
    """
    result = {
        "bios_password": None,
        "success": False,
        "partial": False,
        "rolled_back": False,
        "critical_applied": 0,
        "best_effort_applied": 0,
        "best_effort_failed": 0,
        "not_hp": False,
        "sure_admin_status": None,  # D-010: Sure Admin/Sure Run/Sure Start
    }

    if not is_hp_machine():
        log.warning("Not an HP machine — skipping UEFI lockdown")
        result["not_hp"] = True
        result["success"] = True  # Not an error — just nothing to do
        return result

    # D-010: Check for HP Sure Admin / Sure Run / Sure Start.
    # If any of these are enabled, BIOS changes may be reverted on next boot.
    # The agent proceeds but reports the status so the operator is warned.
    sure_admin_status = _check_sure_admin()
    result["sure_admin_status"] = sure_admin_status
    if sure_admin_status["any_sure_feature"]:
        log.warning("D-010: %s", sure_admin_status["warning"])

    # Phase 4.1: Admin check — fail-fast before any state writes
    if not _is_admin():
        log.error("UEFI lockdown requires admin privileges — aborting (fail-fast)")
        return result

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

    # --- Check for critical failure → rollback (CC18) ---
    if critical_failed > 0:
        log.error(
            "UEFI lockdown: %d critical setting(s) failed — rolling back BIOS changes",
            critical_failed,
        )
        # CC18: Rollback does NOT clear the Setup Password
        _rollback_bios_settings(saved_settings, bios_password)
        result["rolled_back"] = True
        result["success"] = False
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
    return result


def remove_boot_lockdown(bios_password: str) -> bool:
    """Remove UEFI/BIOS lockdown and restore original settings.

    Args:
        bios_password: The BIOS Setup password that was set during lockdown
            (received from the server in the unlock command).

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
    return True
