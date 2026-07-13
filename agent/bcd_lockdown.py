"""
BCD (Boot Configuration Data) Lockdown Module
----------------------------------------------
Hardens the Windows boot process to prevent bypassing the agent via:
  - Safe Mode (F8 / Advanced Startup)
  - Windows Recovery Environment (WinRE)
  - Automatic Repair / Recovery menu
  - Boot status override (F8 → "Disable automatic restart on failure")

What this module does on lockdown:
  1. Disables WinRE (reagentc /disable)
  2. Disables the recovery menu (recoveryenabled No)
  3. Sets bootstatuspolicy to IgnoreAllFailures (no F8 interrupt)
  4. Disables the boot menu display (displaybootmenu No)
  5. Disables F8 advanced boot options (bootmenupolicy Standard = no legacy menu)

What this prevents:
  - Booting into Safe Mode → agent service doesn't start in Safe Mode, so
    a thief could bypass the lock screen. Disabling F8/recovery prevents this.
  - Booting into WinRE → command prompt access could delete the sentinel
    file or the agent itself.
  - Using "Reset this PC" → recovery menu is disabled.
  - Using "Startup Repair" → bootstatuspolicy ignores failures and boots normally.

All changes are reversible during the recovery flow.

Requirements:
  - Windows Vista or later (BCD available)
  - Admin privileges (bcdedit and reagentc require elevation)
"""

import logging
import platform
import subprocess
from pathlib import Path

log = logging.getLogger("lockdown-agent")

# File to track whether BCD lockdown was applied (for safe removal)
BCD_LOCK_SENTINEL = Path(__file__).parent / ".bcd_locked"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _run(cmd: list[str], timeout: int = 15) -> tuple[int, str, str]:
    """Run a command, return (returncode, stdout, stderr)."""
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
    except Exception as e:
        return -3, "", str(e)


def _is_windows() -> bool:
    return platform.system() == "Windows"


# ---------------------------------------------------------------------------
# BCD commands to apply / remove
# ---------------------------------------------------------------------------

# Each entry: (args, description)
# We use {default} which is the standard Windows boot loader identifier.
# On most systems this is correct. For dual-boot systems, the admin would
# need to adjust, but this covers the standard single-OS case.
BCD_LOCKDOWN_COMMANDS = [
    # Disable F8 advanced boot options (no legacy boot menu)
    (["bcdedit", "/set", "{default}", "bootmenupolicy", "Standard"],
     "Disable F8 legacy boot menu"),
    # Don't display the boot menu at all
    (["bcdedit", "/set", "{default}", "displaybootmenu", "No"],
     "Hide boot menu"),
    # Ignore all boot failures — no recovery prompt, just boot normally
    (["bcdedit", "/set", "{default}", "bootstatuspolicy", "IgnoreAllFailures"],
     "Set bootstatuspolicy to IgnoreAllFailures"),
    # Disable Windows Recovery Environment option
    (["bcdedit", "/set", "{default}", "recoveryenabled", "No"],
     "Disable recovery menu"),
]

BCD_RESTORE_COMMANDS = [
    # Restore F8 legacy boot menu
    (["bcdedit", "/set", "{default}", "bootmenupolicy", "Legacy"],
     "Restore F8 legacy boot menu"),
    # Show boot menu again
    (["bcdedit", "/set", "{default}", "displaybootmenu", "Yes"],
     "Show boot menu"),
    # Restore default boot status policy (display failures)
    (["bcdedit", "/set", "{default}", "bootstatuspolicy", "DisplayAllFailures"],
     "Restore bootstatuspolicy"),
    # Re-enable recovery menu
    (["bcdedit", "/set", "{default}", "recoveryenabled", "Yes"],
     "Re-enable recovery menu"),
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
# Public API: apply / remove BCD lockdown
# ---------------------------------------------------------------------------

def apply_bcd_lockdown() -> bool:
    """Apply BCD hardening to prevent Safe Mode / WinRE / recovery bypass.

    Returns:
        True if at least some hardening was applied, False if all failed.
    """
    if not _is_windows():
        log.info("Not Windows — skipping BCD lockdown")
        return True

    applied = 0
    failed = 0

    # Disable WinRE first
    if _disable_winre():
        applied += 1
    else:
        failed += 1

    # Apply BCD settings
    for cmd, description in BCD_LOCKDOWN_COMMANDS:
        rc, _, stderr = _run(cmd)
        if rc == 0:
            applied += 1
            log.info("BCD: %s", description)
        else:
            failed += 1
            log.warning("BCD failed: %s — %s", description, stderr)

    # Write sentinel so we know to revert on recovery
    if applied > 0:
        BCD_LOCK_SENTINEL.write_text("locked")
        log.info("BCD lockdown applied: %d succeeded, %d failed", applied, failed)
    else:
        log.error("BCD lockdown failed entirely — no changes applied")

    return applied > 0


def remove_bcd_lockdown() -> bool:
    """Remove BCD hardening and restore normal boot options.

    Returns:
        True if restoration was applied, False if it failed.
    """
    if not _is_windows():
        log.info("Not Windows — skipping BCD lockdown removal")
        return True

    if not BCD_LOCK_SENTINEL.exists():
        log.info("No BCD lockdown sentinel — nothing to restore")
        return True

    restored = 0
    failed = 0

    # Restore BCD settings
    for cmd, description in BCD_RESTORE_COMMANDS:
        rc, _, stderr = _run(cmd)
        if rc == 0:
            restored += 1
            log.info("BCD restored: %s", description)
        else:
            failed += 1
            log.warning("BCD restore failed: %s — %s", description, stderr)

    # Re-enable WinRE
    if _enable_winre():
        restored += 1
    else:
        failed += 1

    # Remove sentinel
    if BCD_LOCK_SENTINEL.exists():
        BCD_LOCK_SENTINEL.unlink()

    log.info("BCD lockdown removed: %d restored, %d failed", restored, failed)
    return restored > 0
