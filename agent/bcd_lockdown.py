"""
BCD (Boot Configuration Data) Lockdown Module
----------------------------------------------
Hardens the Windows boot process to prevent bypassing the agent via:
  - Safe Mode (F8 / Advanced Startup)
  - Windows Recovery Environment (WinRE)
  - Automatic Repair / Recovery menu
  - Boot status override (F8 -> "Disable automatic restart on failure")
  - Multi-boot menu (alternate OS without the agent)

What this module does on lockdown:
  1. Disables WinRE (reagentc /disable)                     [CRITICAL]
  2. Disables the recovery menu (recoveryenabled No)         [CRITICAL]
  3. Disables the boot menu display (displaybootmenu No)     [CRITICAL]
  4. Disables F8 advanced boot options (bootmenupolicy Standard) [BEST-EFFORT]
  5. Sets bootstatuspolicy to IgnoreAllFailures              [BEST-EFFORT]

CC19: Critical vs. best-effort split.
  - Critical settings close direct bypass vectors (WinRE, recovery, boot menu).
    If ANY critical setting fails, ALL changes are rolled back and no sentinel
    is written. The agent still ACKs with key_material + boot_lock_status: "partial".
  - Best-effort settings are defense-in-depth. Failure is logged but does not
    trigger rollback.
  - `bootstatuspolicy IgnoreAllFailures` is best-effort because the bypass it
    targets (Automatic Repair -> advanced options) is already closed by
    `recoveryenabled No` + `reagentc /disable`. Treating it as critical would
    cause unnecessary rollbacks on machines where the BCD policy field is
    OEM-locked.
  - `displaybootmenu No` is critical because on a multi-boot machine the boot
    menu offers alternate OSes that may not run the agent service — a direct
    bypass. The cost of a false-positive rollback on single-OS is trivial
    (re-show an already-shown menu); the cost of a false-negative on multi-boot
    is a bypass.

CC18: Rollback on critical failure.
  - Rollback restores BCD settings to their pre-lockdown values (from .bcd_state).
  - Rollback failures are NON-FATAL: log ERROR, return False, do not raise.
    If reagentc /enable fails during rollback (e.g., WinRE image corrupted),
    we still return without raising — the agent continues to ACK.
  - Rollback is scoped to boot-state files (.bcd_locked, .bcd_state) ONLY.
    It must NOT delete or touch the encryption key files (File A / File B).

Phase 4: Verification re-reads.
  - After setting each BCD value, re-read it to verify it took effect.
  - If verification fails, treat as a failed setting (triggers rollback if critical).

Requirements:
  - Windows Vista or later (BCD available)
  - Admin privileges (bcdedit and reagentc require elevation)
"""

import json
import logging
import os
import platform
import subprocess
from pathlib import Path

log = logging.getLogger("lockdown-agent")

# File to track whether BCD lockdown was applied (for safe removal)
BCD_LOCK_SENTINEL = Path(__file__).parent / ".bcd_locked"

# File to save pre-lockdown BCD state for restoration on rollback/recovery
BCD_STATE_FILE = Path(__file__).parent / ".bcd_state"


def _atomic_write_text(path: Path, content: str) -> None:
    """Write text to a file atomically (write to temp + rename)."""
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(content)
    tmp.replace(path)


# Dry-run mode: when True, all bcdedit/reagentc calls are printed
# instead of executed. No BCD changes happen.
# Set via set_dry_run(True) or the LOCKDOWN_DRY_RUN=1 env var.
_DRY_RUN = os.environ.get("LOCKDOWN_DRY_RUN", "").lower() in ("1", "true", "yes")

# Simulated WinRE state for dry-run
_DRY_RUN_WINRE_ENABLED = True

# Simulated BCD state for dry-run (current values of settings we modify)
_DRY_RUN_BCD_STATE = {
    "bootmenupolicy": "Legacy",
    "displaybootmenu": "Yes",
    "bootstatuspolicy": "DisplayAllFailures",
    "recoveryenabled": "Yes",
    # T4: new best-effort settings
    "nointegritychecks": "No",
    "allowprereleasesignatures": "No",
    "timeout": "30",
}

# D-008: Simulated BitLocker state for dry-run
_DRY_RUN_BITLOCKER_ENABLED = False
_DRY_RUN_BITLOCKER_SUSPENDED = False


def set_dry_run(enabled: bool) -> None:
    """Enable or disable dry-run mode."""
    global _DRY_RUN
    _DRY_RUN = enabled
    if enabled:
        log.info("DRY RUN mode enabled — no BCD changes will be made")


# ---------------------------------------------------------------------------
# Admin check (Phase 4.1 — fail-fast before any state writes)
# ---------------------------------------------------------------------------


def _is_admin() -> bool:
    """Check if the current process has admin/elevation privileges.

    On Windows, uses `net session` (succeeds only as admin).
    On non-Windows, returns True (dry-run/test mode).
    In dry-run mode, always returns True.

    This is the FIRST check before any state-file writes or BCD changes.
    Admin-failure is fail-fast, not rollback — there's nothing to roll back.
    """
    if _DRY_RUN:
        return True
    if platform.system() != "Windows":
        return True  # Non-Windows = test/dev environment
    try:
        # `net session` succeeds only with admin privileges
        result = subprocess.run(
            ["net", "session"],
            capture_output=True,
            text=True,
            timeout=5,
        )
        return result.returncode == 0
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired, FileNotFoundError, OSError):
        return False


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _run(cmd: list[str], timeout: int = 15) -> tuple[int, str, str]:
    """Run a command, return (returncode, stdout, stderr)."""
    if _DRY_RUN:
        cmd_str = " ".join(cmd)
        print(f"  [DRY-RUN] {cmd_str}")
        # Simulate responses for known commands
        if "reagentc" in cmd and "/info" in cmd:
            global _DRY_RUN_WINRE_ENABLED
            status = "Enabled" if _DRY_RUN_WINRE_ENABLED else "Disabled"
            return 0, f"Windows RE status: {status}", ""
        if "reagentc" in cmd and "/disable" in cmd:
            _DRY_RUN_WINRE_ENABLED = False
            return 0, "", ""
        if "reagentc" in cmd and "/enable" in cmd:
            _DRY_RUN_WINRE_ENABLED = True
            return 0, "", ""
        if "bcdedit" in cmd and "/query" in cmd:
            # Simulate bcdedit /query {default} <setting>
            for key, val in _DRY_RUN_BCD_STATE.items():
                if key in cmd_str:
                    return 0, val, ""
            return 0, "", ""
        # bcdedit /set commands — simulate success and update dry-run state
        if "bcdedit" in cmd and "/set" in cmd:
            # Parse: bcdedit /set {default} <setting> <value>
            parts = cmd_str.split()
            if len(parts) >= 6:
                setting = parts[4]
                value = parts[5]
                _DRY_RUN_BCD_STATE[setting] = value
            return 0, "", ""
        return 0, "", ""
    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=timeout,
        )
        return result.returncode, result.stdout.strip(), result.stderr.strip()
    except FileNotFoundError:
        return -1, "", f"Command not found: {cmd[0]}"
    except subprocess.TimeoutExpired:
        return -2, "", f"Command timed out: {' '.join(cmd)}"
    except (subprocess.SubprocessError, OSError) as e:
        return -3, "", str(e)


def _is_windows() -> bool:
    if _DRY_RUN:
        return True
    return platform.system() == "Windows"


# ---------------------------------------------------------------------------
# BCD setting read/verify (Phase 4.5 — verification re-reads)
# ---------------------------------------------------------------------------


def _read_bcd_setting(setting: str) -> str | None:
    """Read a BCD element from the entry that owns it.

    `bcdedit /query <entry> <element>` is not valid syntax — Windows answers
    "An unknown command was specified" with RC=1, so every verification read
    failed and every lockdown was rolled back. That is why E-BCD reported
    critical_applied=0 on the Azure VM, on the HP laptop and on a Windows Server
    2022 VM: the apply worked, the check never did. The supported form is
    `bcdedit /enum <entry>` and locating the element line.
    """
    entry = "{bootmgr}" if setting in BOOTMGR_SCOPED_SETTINGS else "{default}"
    rc, stdout, stderr = _run(["bcdedit", "/enum", entry])
    if rc != 0:
        log.debug("bcdedit /enum %s failed: %s", entry, stderr)
        return None
    # Output lines look like "recoveryenabled         Yes"
    for line in stdout.splitlines():
        parts = line.split()
        if len(parts) >= 2 and parts[0].lower() == setting.lower():
            return parts[-1]
    return None


def _apply_bcd_setting(setting: str, value: str) -> bool:
    """Set a BCD setting on whichever entry owns it, then verify.

    `displaybootmenu` and `timeout` are boot manager elements; everything else in
    the tables is a loader element. Getting this wrong is not cosmetic: the whole
    lockdown aborts and rolls back.
    """
    if setting in BOOTMGR_SCOPED_SETTINGS:
        return _set_bcd_setting_bootmgr(setting, value)
    return _set_bcd_setting(setting, value)


def _set_bcd_setting(setting: str, value: str) -> bool:
    """Set a loader ({default}) BCD setting and verify it took effect (Phase 4.5).

    Returns True if the setting was applied AND verified, False otherwise.
    """
    rc, _, stderr = _run(["bcdedit", "/set", "{default}", setting, value])
    if rc != 0:
        log.warning("bcdedit /set %s %s failed: %s", setting, value, stderr)
        return False

    # Verification re-read: confirm the setting actually took effect
    current = _read_bcd_setting(setting)
    if current is None:
        log.warning("Could not verify BCD setting %s (read failed)", setting)
        return False
    if current.lower() != value.lower():
        log.warning(
            "BCD setting %s verification failed: expected '%s', got '%s'", setting, value, current
        )
        return False

    log.info("BCD: %s = %s (verified)", setting, value)
    return True


def _set_bcd_setting_bootmgr(setting: str, value: str) -> bool:
    """Set a {bootmgr} BCD setting and verify it took effect.

    Verification goes through _read_bcd_setting, which already dispatches to
    {bootmgr} for boot-manager elements — one verification path for both scopes,
    so the two cannot drift apart.
    """
    rc, _, stderr = _run(["bcdedit", "/set", "{bootmgr}", setting, value])
    if rc != 0:
        log.warning("bcdedit /set {bootmgr} %s %s failed: %s", setting, value, stderr)
        return False

    current = _read_bcd_setting(setting)
    if current is None:
        log.warning("Could not verify BCD {bootmgr} setting %s (read failed)", setting)
        return False
    if current.lower() != value.lower():
        log.warning(
            "BCD {bootmgr} setting %s verification failed: expected '%s', got '%s'",
            setting,
            value,
            current,
        )
        return False

    log.info("BCD {bootmgr}: %s = %s (verified)", setting, value)
    return True


def _clear_bootsequence() -> bool:
    """Clear the one-time boot sequence override.

    T4: `bcdedit /bootsequence` sets a one-time boot override that takes
    effect on the next boot only. If an attacker (or malware) set this before
    lockdown, it would bypass our {default} lockdown on the next boot.
    We delete the bootsequence value to ensure the next boot uses the
    normal boot order.

    Returns True if cleared (or was already empty), False on failure.
    """
    rc, _, stderr = _run(["bcdedit", "/deletevalue", "{bootmgr}", "bootsequence"])
    if rc == 0:
        log.info("T4: bootsequence cleared (one-time boot override removed)")
        return True
    # bootsequence may not exist — that's fine, not an error
    log.debug("T4: bootsequence clear returned %d: %s (may not exist — OK)", rc, stderr)
    return True


# ---------------------------------------------------------------------------
# BCD commands: critical vs. best-effort (CC19)
# ---------------------------------------------------------------------------

# Critical settings: close direct bypass vectors.
# If ANY of these fail, ALL changes are rolled back and no sentinel is written.
# Each entry: (setting_name, lockdown_value, description)
# BCD elements live on either the boot manager entry or the loader entry, and
# applying one to the wrong entry fails with "The element data type specified is
# not recognized" — which aborted the entire lockdown and rolled it back (seen on
# Windows Server 2022: `bcdedit /set {default} displaybootmenu No` cannot work).
# Every set/read goes through _apply_bcd_setting/_read_bcd_value, which dispatch
# on this set.
BOOTMGR_SCOPED_SETTINGS = {"displaybootmenu", "timeout"}

BCD_CRITICAL_COMMANDS = [
    # Disable Windows Recovery Environment option
    # (closes WinRE -> command prompt bypass)
    ("recoveryenabled", "No", "Disable recovery menu"),
    # Don't display the boot menu at all — a {bootmgr} element
    # (closes multi-boot alternate OS bypass — CC19 promoted to critical)
    ("displaybootmenu", "No", "Hide boot menu"),
]

# Best-effort settings: defense-in-depth.
# Failure is logged but does not trigger rollback.
BCD_BEST_EFFORT_COMMANDS = [
    # Disable F8 legacy boot menu (no advanced boot options)
    ("bootmenupolicy", "Standard", "Disable F8 legacy boot menu"),
    # Ignore all boot failures — no recovery prompt, just boot normally
    # (CC19 demoted to best-effort: bypass already closed by recoveryenabled No + WinRE disable)
    ("bootstatuspolicy", "IgnoreAllFailures", "Set bootstatuspolicy to IgnoreAllFailures"),
    # T4: Ensure driver signature enforcement is ON (nointegritychecks=No)
    # If nointegritychecks=Yes, Windows loads unsigned drivers — a bypass vector
    ("nointegritychecks", "No", "Ensure driver signature enforcement"),
    # T4: Block test-signed drivers (allowprereleasesignatures=No)
    # If allowprereleasesignatures=Yes, test-signed drivers load — a bypass vector
    ("allowprereleasesignatures", "No", "Block test-signed drivers"),
]

# T4: Boot manager-level settings (applied to {bootmgr}, not {default})
# These are best-effort. The timeout=0 eliminates the boot menu wait entirely,
# so even if displaybootmenu somehow gets re-enabled, the menu flashes too
# fast to interact with.
BCD_BOOTMGR_COMMANDS = [
    ("timeout", "0", "Set boot manager timeout to 0 (no menu wait)"),
]

# Restore commands: reverse the lockdown settings
BCD_RESTORE_COMMANDS = [
    ("bootmenupolicy", "Legacy", "Restore F8 legacy boot menu"),
    ("displaybootmenu", "Yes", "Show boot menu"),
    ("bootstatuspolicy", "DisplayAllFailures", "Restore bootstatuspolicy"),
    ("recoveryenabled", "Yes", "Re-enable recovery menu"),
    # T4: Restore driver signature enforcement defaults
    ("nointegritychecks", "No", "Restore nointegritychecks"),
    ("allowprereleasesignatures", "No", "Restore allowprereleasesignatures"),
]

# T4: Restore commands for {bootmgr} level
BCD_BOOTMGR_RESTORE_COMMANDS = [
    ("timeout", "30", "Restore boot manager timeout to 30s"),
]


# ---------------------------------------------------------------------------
# WinRE control
# ---------------------------------------------------------------------------


def _disable_winre() -> bool:
    """Disable Windows Recovery Environment."""
    rc, _, stderr = _run(["reagentc", "/disable"])
    if rc == 0:
        log.info("WinRE disabled (reagentc /disable)")
        return True
    # reagentc returns non-zero if WinRE is already disabled or not installed
    log.debug("reagentc /disable returned %d: %s", rc, stderr)
    return False


def _enable_winre() -> bool:
    """Re-enable Windows Recovery Environment."""
    rc, _, stderr = _run(["reagentc", "/enable"])
    if rc == 0:
        log.info("WinRE enabled (reagentc /enable)")
        return True
    log.debug("reagentc /enable returned %d: %s", rc, stderr)
    return False


def _is_winre_enabled() -> bool:
    """Check if WinRE is currently enabled."""
    rc, stdout, _ = _run(["reagentc", "/info"])
    if rc != 0:
        return False
    # Output contains "Windows RE status: Enabled" or "Disabled"
    return "Enabled" in stdout


# ---------------------------------------------------------------------------
# BitLocker awareness (D-008)
# ---------------------------------------------------------------------------
# If BitLocker is enabled on the system drive, changing BCD settings can
# trigger a BitLocker recovery key prompt on next boot. The agent should
# suspend BitLocker protectors before applying BCD changes, and resume
# them after. This is the standard Windows approach for making BCD changes
# on BitLocker-protected systems.
#
# Close criteria for D-008: Agent checks BitLocker and either handles or
# warns before bcdedit. This code implements the "handle" path: suspend
# before, resume after. The "warn" path is covered by the bitlocker_status
# field in the result dict, which the agent includes in the ACK.


def _check_bitlocker() -> dict:
    """Check BitLocker status on the system drive (C:).

    D-008: Returns a dict with:
      - enabled: bool — True if BitLocker is ON
      - suspended: bool — True if BitLocker protectors are suspended
      - percentage: str — encryption percentage (e.g., "100%")
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
        rc, stdout, stderr = _run(["manage-bde", "-status", "C:"], timeout=10)
        if rc != 0:
            # manage-bde not available or no BitLocker — treat as not enabled
            return {
                "enabled": False,
                "suspended": False,
                "percentage": "0%",
                "error": f"manage-bde failed: {stderr}",
            }
        # Parse output for Protection Status and Conversion Status
        enabled = False
        suspended = False
        percentage = "0%"
        for line in stdout.split("\n"):
            line_lower = line.strip().lower()
            if "protection status" in line_lower and "protection on" in line_lower:
                enabled = True
            if "protection status" in line_lower and "protection off" in line_lower:
                # Could be suspended or disabled
                suspended = "suspended" in line_lower
            if "conversion status" in line_lower:
                # e.g., "    Conversion Status:    100% Encrypted"
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
    except (ValueError, TypeError, IndexError, OSError) as e:
        return {"enabled": False, "suspended": False, "percentage": "0%", "error": str(e)}


def _suspend_bitlocker() -> bool:
    """Suspend BitLocker protectors on the system drive (D-008).

    This temporarily disables BitLocker protection so BCD changes don't
    trigger a recovery key prompt on next boot. Protectors auto-resume
    after a reboot, but we also explicitly resume them after BCD changes.

    Returns True if suspension succeeded (or BitLocker was not enabled).
    """
    if _DRY_RUN:
        global _DRY_RUN_BITLOCKER_SUSPENDED
        if _DRY_RUN_BITLOCKER_ENABLED:
            _DRY_RUN_BITLOCKER_SUSPENDED = True
            log.info("[DRY-RUN] BitLocker protectors suspended on C:")
        return True
    if platform.system() != "Windows":
        return True
    try:
        # Suspend protectors with 1 reboot count (auto-resume after 1 reboot)
        rc, _, stderr = _run(
            ["manage-bde", "-protectors", "-disable", "C:", "-rebootcount", "1"], timeout=10
        )
        if rc == 0:
            log.info("BitLocker protectors suspended on C: (auto-resume after 1 reboot)")
            return True
        log.warning("Failed to suspend BitLocker protectors: %s", stderr)
        return False
    except (subprocess.SubprocessError, OSError, ValueError, TypeError) as e:
        log.warning("Failed to suspend BitLocker protectors: %s", e)
        return False


def _resume_bitlocker() -> bool:
    """Resume BitLocker protectors on the system drive (D-008).

    Called after BCD changes are complete. Re-enables protection so the
    drive is protected again immediately (without waiting for a reboot).

    Returns True if resumption succeeded (or BitLocker was not enabled).
    """
    if _DRY_RUN:
        global _DRY_RUN_BITLOCKER_SUSPENDED
        _DRY_RUN_BITLOCKER_SUSPENDED = False
        if _DRY_RUN_BITLOCKER_ENABLED:
            log.info("[DRY-RUN] BitLocker protectors resumed on C:")
        return True
    if platform.system() != "Windows":
        return True
    try:
        rc, _, stderr = _run(["manage-bde", "-protectors", "-enable", "C:"], timeout=10)
        if rc == 0:
            log.info("BitLocker protectors resumed on C:")
            return True
        log.warning("Failed to resume BitLocker protectors: %s", stderr)
        return False
    except (subprocess.SubprocessError, OSError, ValueError, TypeError) as e:
        log.warning("Failed to resume BitLocker protectors: %s", e)
        return False


# ---------------------------------------------------------------------------
# BCD state save/restore (Phase 4.2)
# ---------------------------------------------------------------------------


def save_bcd_state() -> dict:
    """Save pre-lockdown BCD state to a file for later restoration.

    Reads the current values of all settings we're about to change
    (both critical and best-effort) and saves them to BCD_STATE_FILE.
    Also saves WinRE enabled/disabled state.

    Returns the state dict (also written to file).
    """
    state = {
        "winre_enabled": _is_winre_enabled(),
        "settings": {},
    }

    # Save current values of all settings we modify
    all_settings = [s for s, _, _ in BCD_CRITICAL_COMMANDS] + [
        s for s, _, _ in BCD_BEST_EFFORT_COMMANDS
    ]
    for setting in all_settings:
        current = _read_bcd_setting(setting)
        if current is not None:
            state["settings"][setting] = current

    # T4: Save {bootmgr}-level settings (timeout)
    state["bootmgr_settings"] = {}
    for setting, _, _ in BCD_BOOTMGR_COMMANDS:
        rc, stdout, _ = _run(["bcdedit", "/query", "{bootmgr}", setting])
        if rc == 0:
            lines = stdout.strip().split("\n")
            for line in lines:
                parts = line.strip().split()
                if len(parts) >= 2:
                    state["bootmgr_settings"][setting] = parts[-1]
                    break

    _atomic_write_text(BCD_STATE_FILE, json.dumps(state, indent=2))
    log.info("BCD state saved to %s", BCD_STATE_FILE)
    return state


def load_bcd_state() -> dict | None:
    """Load saved BCD state. Returns None if no state file exists."""
    if not BCD_STATE_FILE.exists():
        return None
    try:
        return json.loads(BCD_STATE_FILE.read_text())
    except (json.JSONDecodeError, ValueError, TypeError, OSError) as e:
        log.error("Could not read BCD state: %s", e)
        return None


def clear_bcd_state() -> None:
    """Remove the BCD state file."""
    if BCD_STATE_FILE.exists():
        BCD_STATE_FILE.unlink()
        log.info("BCD state file removed")


# ---------------------------------------------------------------------------
# Rollback (CC18 — on critical failure, restore BCD to pre-lockdown state)
# ---------------------------------------------------------------------------


def _rollback_bcd(state: dict) -> bool:
    """Restore BCD settings to pre-lockdown values.

    CC18: Rollback failures are NON-FATAL. If reagentc /enable fails during
    rollback (e.g., WinRE image corrupted), log ERROR, return False, do not raise.

    This function is scoped to boot-state files ONLY. It must NOT touch
    the encryption key files (File A / File B).

    Returns True if all restorations succeeded, False if any failed.
    """
    log.warning("Rolling back BCD changes due to critical failure...")
    all_ok = True

    # Restore WinRE if it was enabled before lockdown
    if state.get("winre_enabled", False):
        if not _enable_winre():
            log.error("Rollback: failed to re-enable WinRE — non-fatal, continuing")
            all_ok = False

    # Restore BCD settings to their original values
    saved_settings = state.get("settings", {})
    for setting, original_value in saved_settings.items():
        if _apply_bcd_setting(setting, original_value):
            log.info("Rollback: %s -> %s (restored)", setting, original_value)
        else:
            log.error(
                "Rollback: failed to restore %s to '%s' — non-fatal, continuing",
                setting,
                original_value,
            )
            all_ok = False

    # Remove the BCD state file (rollback complete, no state to restore later)
    clear_bcd_state()

    if all_ok:
        log.info("BCD rollback complete — all settings restored")
    else:
        log.error("BCD rollback completed with errors — some settings may need manual restoration")
    return all_ok


# ---------------------------------------------------------------------------
# Public API: apply / remove BCD lockdown
# ---------------------------------------------------------------------------


def apply_bcd_lockdown() -> dict:
    """Apply BCD hardening to prevent Safe Mode / WinRE / recovery bypass.

    Phase 4 changes:
      - Admin check first (fail-fast before any state writes)
      - Critical/best-effort split (CC19)
      - BCD state save before applying (Phase 4.2)
      - Verification re-reads after each setting (Phase 4.5)
      - Rollback on critical failure (CC18)
      - Rollback failures are non-fatal

    Returns:
        dict with keys:
          - success: bool — True if all critical settings applied successfully
          - partial: bool — True if some best-effort settings failed (but critical OK)
          - rolled_back: bool — True if a critical failure triggered rollback
          - winre_disabled: bool — True if WinRE was disabled
          - critical_applied: int — number of critical settings applied
          - best_effort_applied: int — number of best-effort settings applied
          - best_effort_failed: int — number of best-effort settings that failed
          - bitlocker_status: dict | None — D-008: BitLocker status (enabled,
            suspended, percentage, error) if checked, None if not Windows
    """
    result = {
        "success": False,
        "partial": False,
        "rolled_back": False,
        "winre_disabled": False,
        "critical_applied": 0,
        "best_effort_applied": 0,
        "best_effort_failed": 0,
        "bitlocker_status": None,  # D-008: BitLocker awareness
    }

    if not _is_windows():
        log.info("Not Windows — skipping BCD lockdown")
        result["success"] = True
        return result

    # Phase 4.1: Admin check — fail-fast before any state writes
    if not _is_admin():
        log.error("BCD lockdown requires admin privileges — aborting (fail-fast)")
        return result

    # D-008: Check BitLocker status before applying BCD changes.
    # If BitLocker is enabled, suspend protectors to prevent recovery key
    # prompt on next boot. Resume after BCD changes are complete.
    bitlocker = _check_bitlocker()
    result["bitlocker_status"] = bitlocker
    bitlocker_was_suspended = False
    if bitlocker["enabled"]:
        log.warning(
            "BitLocker is enabled (%s encrypted) — suspending protectors before BCD changes",
            bitlocker["percentage"],
        )
        if _suspend_bitlocker():
            bitlocker_was_suspended = True
        else:
            log.error("Failed to suspend BitLocker — BCD changes may trigger recovery key prompt")
            # Proceed anyway — the operator is warned via the ACK's bitlocker_status

    # Phase 4.2: Save BCD state BEFORE applying any changes (for rollback)
    state = save_bcd_state()

    critical_applied = 0
    critical_failed = 0

    # --- Critical setting 1: Disable WinRE ---
    # WinRE is handled separately (reagentc, not bcdedit)
    if _disable_winre():
        critical_applied += 1
        result["winre_disabled"] = True
    else:
        critical_failed += 1
        log.error("CRITICAL: WinRE disable failed")

    # --- Critical BCD settings ---
    for setting, value, description in BCD_CRITICAL_COMMANDS:
        if _apply_bcd_setting(setting, value):  # includes verification re-read
            critical_applied += 1
        else:
            critical_failed += 1
            log.error("CRITICAL: %s failed", description)

    # --- Check for critical failure -> rollback (CC18) ---
    if critical_failed > 0:
        log.error(
            "BCD lockdown: %d critical setting(s) failed — rolling back all changes",
            critical_failed,
        )
        _rollback_bcd(state)  # non-fatal rollback
        result["rolled_back"] = True
        result["success"] = False
        # D-008: Resume BitLocker if we suspended it
        if bitlocker_was_suspended:
            _resume_bitlocker()
        # Do NOT write the sentinel — boot lockdown was not applied
        return result

    # --- Best-effort settings (failure does not trigger rollback) ---
    best_effort_applied = 0
    best_effort_failed = 0
    for setting, value, description in BCD_BEST_EFFORT_COMMANDS:
        if _apply_bcd_setting(setting, value):  # includes verification re-read
            best_effort_applied += 1
        else:
            best_effort_failed += 1
            log.warning("BEST-EFFORT: %s failed — continuing (not critical)", description)

    # T4: Boot manager-level best-effort settings ({bootmgr}, not {default})
    for setting, value, description in BCD_BOOTMGR_COMMANDS:
        if _set_bcd_setting_bootmgr(setting, value):
            best_effort_applied += 1
        else:
            best_effort_failed += 1
            log.warning("BEST-EFFORT {bootmgr}: %s failed — continuing", description)

    # T4: Clear one-time boot sequence override (defense-in-depth)
    if _clear_bootsequence():
        best_effort_applied += 1
    else:
        best_effort_failed += 1
        log.warning("BEST-EFFORT: bootsequence clear failed — continuing")

    # --- Success: write sentinel ---
    BCD_LOCK_SENTINEL.write_text("locked")
    log.info(
        "BCD lockdown applied: %d critical, %d best-effort succeeded, %d best-effort failed",
        critical_applied,
        best_effort_applied,
        best_effort_failed,
    )

    # D-008: Resume BitLocker protectors after BCD changes are complete
    if bitlocker_was_suspended:
        _resume_bitlocker()

    result["success"] = True
    result["partial"] = best_effort_failed > 0
    result["critical_applied"] = critical_applied
    result["best_effort_applied"] = best_effort_applied
    result["best_effort_failed"] = best_effort_failed
    return result


def remove_bcd_lockdown() -> bool:
    """Remove BCD hardening and restore normal boot options.

    Uses the saved BCD state (.bcd_state) if available for accurate restoration.
    Falls back to safe defaults if no state file exists.

    Returns:
        True if restoration was applied, False if it failed.
    """
    if not _is_windows():
        log.info("Not Windows — skipping BCD lockdown removal")
        return True

    if not BCD_LOCK_SENTINEL.exists():
        log.info("No BCD lockdown sentinel — nothing to restore")
        return True

    # Phase 4.1: Admin check
    if not _is_admin():
        log.error("BCD lockdown removal requires admin privileges — aborting")
        return False

    restored = 0
    failed = 0

    # Try to use saved state for accurate restoration
    state = load_bcd_state()
    if state:
        saved_settings = state.get("settings", {})
        winre_was_enabled = state.get("winre_enabled", True)

        # Restore BCD settings to their original values
        for setting, original_value in saved_settings.items():
            if _apply_bcd_setting(setting, original_value):
                restored += 1
                log.info("BCD restored: %s -> %s", setting, original_value)
            else:
                failed += 1
                log.warning("BCD restore failed: %s -> %s", setting, original_value)

        # Re-enable WinRE if it was enabled before lockdown
        if winre_was_enabled:
            if _enable_winre():
                restored += 1
            else:
                failed += 1
        else:
            log.info("WinRE was disabled before lockdown — not re-enabling")

        # T4: Restore {bootmgr}-level settings (timeout)
        saved_bootmgr = state.get("bootmgr_settings", {})
        for setting, original_value in saved_bootmgr.items():
            rc, _, stderr = _run(["bcdedit", "/set", "{bootmgr}", setting, original_value])
            if rc == 0:
                restored += 1
                log.info("BCD {bootmgr} restored: %s -> %s", setting, original_value)
            else:
                failed += 1
                log.warning(
                    "BCD {bootmgr} restore failed: %s -> %s: %s", setting, original_value, stderr
                )
    else:
        # No saved state — use safe defaults
        log.warning("No saved BCD state — restoring to safe defaults")
        for setting, value, description in BCD_RESTORE_COMMANDS:
            ok = _apply_bcd_setting(setting, value)
            if ok:
                restored += 1
                log.info("BCD restored: %s", description)
            else:
                failed += 1
                log.warning("BCD restore failed: %s — %s", description, stderr)

        # T4: Restore {bootmgr} safe defaults
        for setting, value, description in BCD_BOOTMGR_RESTORE_COMMANDS:
            rc, _, stderr = _run(["bcdedit", "/set", "{bootmgr}", setting, value])
            if rc == 0:
                restored += 1
                log.info("BCD {bootmgr} restored: %s", description)
            else:
                failed += 1
                log.warning("BCD {bootmgr} restore failed: %s — %s", description, stderr)

        # Re-enable WinRE (safe default)
        if _enable_winre():
            restored += 1
        else:
            failed += 1

    # Remove sentinel and state file
    if BCD_LOCK_SENTINEL.exists():
        BCD_LOCK_SENTINEL.unlink()
    clear_bcd_state()

    log.info("BCD lockdown removed: %d restored, %d failed", restored, failed)
    return restored > 0
