"""
HP UEFI/BIOS Lockdown Module
-----------------------------
Uses HP's WMI BIOS interface (root\\hp\\InstrumentedBIOS) to lock down the
boot process so a thief cannot boot from external media or enter BIOS setup.

What this module does on lockdown:
  1. Sets a BIOS Setup (supervisor) password — prevents entering BIOS setup (F10)
  2. Disables USB boot — prevents booting from USB sticks
  3. Disables Network (PXE) boot — prevents booting from network
  4. Disables Legacy/CSM boot — forces UEFI-only (harder to boot random tools)
  5. Enables Fast Boot — prevents F-key interruption during POST
  6. Requires admin password for F12 boot menu — can't pick alternate boot device

What this prevents:
  - Pressing F10 to enter BIOS setup → requires password
  - Pressing F12 to boot from USB → requires password / USB boot disabled
  - Booting from USB stick → USB boot disabled
  - Booting from PXE/network → PXE boot disabled
  - Using F-keys during POST to interrupt boot → Fast Boot enabled
  - Booting legacy OS/tools → Legacy boot disabled

All changes are reversible during the recovery flow.

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
import platform
import subprocess
import secrets
import string
from pathlib import Path

log = logging.getLogger("lockdown-agent")

HP_WMI_NAMESPACE = r"root\hp\InstrumentedBIOS"

# BIOS settings to apply during lockdown.
# Each entry: (setting_name, lockdown_value)
# We try each setting name — not all exist on every HP model.
# Missing settings are silently skipped (logged at debug level).
LOCKDOWN_SETTINGS = [
    # --- Disable external boot paths ---
    ("Network (PXE) Boot", "Disable"),
    ("Network Boot", "Disable"),
    ("USB Boot", "Disable"),
    ("USB Storage Boot", "Disable"),
    ("USB Floppy/CD Boot", "Disable"),
    # --- Force UEFI only (no legacy/CSM) ---
    ("Legacy Boot Options", "Disable"),
    ("Legacy Support", "Disable"),
    # --- Enable Fast Boot (prevents F-key interruption during POST) ---
    ("Fast Boot", "Enable"),
    # --- Require setup password for F12 boot menu ---
    ("Prompt for Admin password on F12 (Network Boot)", "Enable"),
    ("F12 Boot Menu", "Disable"),
    # --- Disable one-time boot menu if available ---
    ("One-Time Boot Menu", "Disable"),
]

# File to save pre-lockdown BIOS state for restoration on recovery
BOOT_STATE_FILE = Path(__file__).parent / ".boot_state"

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
    result = subprocess.run(
        ["powershell", "-NoProfile", "-NonInteractive", "-Command", script],
        capture_output=True,
        text=True,
        timeout=timeout,
    )
    if result.returncode != 0:
        raise RuntimeError(f"PowerShell failed (exit {result.returncode}): {result.stderr.strip()}")
    return result.stdout.strip()


def is_hp_machine() -> bool:
    """Check if this is an HP machine by looking for the HP WMI namespace."""
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


def _read_setting(name: str) -> str | None:
    """Read the current value of a BIOS setting. Returns None if not found."""
    # Try HP_BIOSEnumeration first (most settings are here)
    try:
        output = _run_powershell(
            f"(Get-WmiObject -Namespace '{HP_WMI_NAMESPACE}' "
            f"-Class HP_BIOSEnumeration -Filter \"Name='{name}'\").CurrentValue"
        )
        if output:
            return output
    except Exception:
        pass
    # Fall back to HP_BIOSSetting
    try:
        output = _run_powershell(
            f"(Get-WmiObject -Namespace '{HP_WMI_NAMESPACE}' "
            f"-Class HP_BIOSSetting -Filter \"Name='{name}'\").Value"
        )
        if output:
            return output
    except Exception:
        pass
    return None


def _set_setting(name: str, value: str, password: str | None) -> int:
    """Set a BIOS setting. Returns the WMI return code (0 = success)."""
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


def _is_setup_password_set() -> bool:
    """Check if a BIOS Setup password is currently set."""
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
    return ''.join(secrets.choice(alphabet) for _ in range(length))


# ---------------------------------------------------------------------------
# State save / restore
# ---------------------------------------------------------------------------

def save_boot_state(password_was_set: bool, settings: dict) -> None:
    """Save pre-lockdown BIOS state to a file for later restoration."""
    state = {
        "setup_password_was_set": password_was_set,
        "settings": settings,  # {setting_name: original_value}
    }
    BOOT_STATE_FILE.write_text(json.dumps(state, indent=2))
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
# Public API: apply / remove boot lockdown
# ---------------------------------------------------------------------------

def apply_boot_lockdown(existing_password: str | None = None) -> str | None:
    """Apply UEFI/BIOS lockdown on an HP machine.

    Args:
        existing_password: The current BIOS Setup password, if one is already
            set. If None and no password is set, a new random password is
            generated. If None and a password IS set, the lockdown cannot
            proceed (we can't authenticate BIOS changes without it).

    Returns:
        The BIOS password used (for reporting to the server), or None if
        the lockdown could not be applied.

    Raises:
        RuntimeError if a critical step fails.
    """
    if not is_hp_machine():
        log.warning("Not an HP machine — skipping UEFI lockdown")
        return None

    # Determine the password to use
    password_already_set = _is_setup_password_set()
    if password_already_set and not existing_password:
        log.error(
            "BIOS Setup password is already set but no UEFI_PASSWORD configured. "
            "Cannot apply BIOS lockdown without the existing password. "
            "Set UEFI_PASSWORD in the agent config to the current BIOS password."
        )
        return None

    if not password_already_set:
        # Generate a new password and set it
        bios_password = generate_bios_password()
        log.info("Setting new BIOS Setup password...")
        rc = _set_setting("Setup Password", bios_password, None)
        if rc != 0:
            log.error("Failed to set Setup password: %s", SET_BIOS_RETURN_CODES.get(rc, f"code {rc}"))
            return None
        log.info("BIOS Setup password set successfully")
    else:
        # Use the existing password to authorize changes
        bios_password = existing_password
        log.info("Using existing BIOS Setup password for lockdown changes")

    # Save current state of all settings we're about to change
    saved_settings = {}
    for setting_name, _ in LOCKDOWN_SETTINGS:
        current = _read_setting(setting_name)
        if current is not None:
            saved_settings[setting_name] = current

    save_boot_state(password_already_set, saved_settings)

    # Apply each lockdown setting
    applied = 0
    skipped = 0
    failed = 0
    for setting_name, lockdown_value in LOCKDOWN_SETTINGS:
        current = _read_setting(setting_name)
        if current is None:
            # Setting doesn't exist on this model — skip
            skipped += 1
            continue
        if current == lockdown_value:
            # Already in desired state
            skipped += 1
            continue
        rc = _set_setting(setting_name, lockdown_value, bios_password)
        if rc == 0:
            applied += 1
            log.info("BIOS setting '%s' → %s", setting_name, lockdown_value)
        elif rc == 1:
            # Not supported on this model — skip
            skipped += 1
            log.debug("Setting '%s' not supported on this model", setting_name)
        else:
            failed += 1
            log.warning(
                "Failed to set '%s' to '%s': %s",
                setting_name, lockdown_value, SET_BIOS_RETURN_CODES.get(rc, f"code {rc}")
            )

    log.info(
        "UEFI lockdown applied: %d settings changed, %d skipped, %d failed",
        applied, skipped, failed
    )

    if failed > 0 and applied == 0:
        log.error("All BIOS settings failed to apply — lockdown may be ineffective")
        return None

    return bios_password


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

    state = load_boot_state()
    if not state:
        log.warning("No saved boot state — restoring BIOS settings to safe defaults")
        # If we have no saved state, just re-enable everything
        restore_settings = {}
        for setting_name, _ in LOCKDOWN_SETTINGS:
            restore_settings[setting_name] = None  # None = set to safe default
    else:
        restore_settings = state.get("settings", {})
        password_was_set = state.get("setup_password_was_set", False)

    # Restore each setting to its original value (or safe default)
    safe_defaults = {
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

    restored = 0
    for setting_name, _ in LOCKDOWN_SETTINGS:
        original = restore_settings.get(setting_name)
        if original is None:
            # Use safe default
            original = safe_defaults.get(setting_name)
        if original is None:
            continue

        rc = _set_setting(setting_name, original, bios_password)
        if rc == 0:
            restored += 1
            log.info("BIOS setting '%s' → %s (restored)", setting_name, original)
        elif rc == 1:
            log.debug("Setting '%s' not supported — skipping restore", setting_name)
        else:
            log.warning(
                "Failed to restore '%s' to '%s': %s",
                setting_name, original, SET_BIOS_RETURN_CODES.get(rc, f"code {rc}")
            )

    log.info("Restored %d BIOS settings to pre-lockdown state", restored)

    # Clear the Setup password if we were the ones who set it
    if state and not state.get("setup_password_was_set", False):
        log.info("Clearing BIOS Setup password (was set by lockdown agent)...")
        rc = _set_setting("Setup Password", "", bios_password)
        if rc == 0:
            log.info("BIOS Setup password cleared successfully")
        else:
            log.warning(
                "Failed to clear Setup password: %s — "
                "admin may need to clear it manually in BIOS",
                SET_BIOS_RETURN_CODES.get(rc, f"code {rc}")
            )
    else:
        log.info("Setup password was pre-existing — not clearing (admin manages it)")

    clear_boot_state()
    return True
