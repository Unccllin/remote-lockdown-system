"""
Test script for boot lockdown — run on the HP test machine OR in dry-run mode.

This script lets you test the boot lockdown modules WITHOUT going through
the full server/agent flow. Useful for verifying that:
  1. The HP WMI BIOS interface is accessible
  2. BCD lockdown works (reversible)
  3. UEFI lockdown works (reversible)

Usage:
  # Real mode (run as Administrator on the HP machine):
  python test_boot_lockdown.py status       — check current state
  python test_boot_lockdown.py bcd-lock     — apply BCD lockdown only
  python test_boot_lockdown.py bcd-unlock   — remove BCD lockdown
  python test_boot_lockdown.py uefi-lock    — apply UEFI lockdown (HP only)
  python test_boot_lockdown.py uefi-unlock  — remove UEFI lockdown
  python test_boot_lockdown.py full-lock    — apply both (like real lockdown)
  python test_boot_lockdown.py full-unlock  — remove both

  # Dry-run mode (safe — no actual BIOS/BCD changes, works on any OS):
  python test_boot_lockdown.py --dry-run status
  python test_boot_lockdown.py --dry-run full-lock
  python test_boot_lockdown.py --dry-run full-unlock

IMPORTANT: In real mode, run as Administrator. BCD and BIOS changes require elevation.
"""
import sys
import os

# Parse --dry-run flag
DRY_RUN = "--dry-run" in sys.argv
if DRY_RUN:
    sys.argv.remove("--dry-run")

# Ensure we're running as admin on Windows (skip check in dry-run mode)
def check_admin():
    if DRY_RUN:
        print("=== DRY RUN MODE — no actual changes will be made ===\n")
        return
    if os.name != 'nt':
        print("WARNING: Not running on Windows — some features won't work")
        print("Use --dry-run to simulate without a real Windows machine.\n")
        return
    try:
        import ctypes
        if not ctypes.windll.shell32.IsUserAnAdmin():
            print("ERROR: This script must be run as Administrator!")
            print("Right-click → Run as administrator, or run from an elevated cmd.")
            sys.exit(1)
    except Exception:
        pass

check_admin()

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import hp_uefi_lockdown
import bcd_lockdown

# Enable dry-run mode in the modules
if DRY_RUN:
    hp_uefi_lockdown.set_dry_run(True)
    bcd_lockdown.set_dry_run(True)


def cmd_status():
    print("=== Boot Lockdown Status ===\n")
    print(f"Platform: {sys.platform}")
    print(f"Dry-run mode: {DRY_RUN}")
    print(f"HP machine: {hp_uefi_lockdown.is_hp_machine()}")
    print(f"BIOS Setup password set: {hp_uefi_lockdown._is_setup_password_set()}")
    print(f"BCD lockdown sentinel: {bcd_lockdown.BCD_LOCK_SENTINEL.exists()}")
    print(f"Boot state file: {hp_uefi_lockdown.BOOT_STATE_FILE.exists()}")

    if hp_uefi_lockdown.is_hp_machine():
        print(f"\n--- Current BIOS Settings ---")
        for name, _ in hp_uefi_lockdown.LOCKDOWN_SETTINGS:
            val = hp_uefi_lockdown._read_setting(name)
            if val is not None:
                print(f"  {name}: {val}")
            else:
                print(f"  {name}: (not available on this model)")

    if hp_uefi_lockdown.BOOT_STATE_FILE.exists():
        state = hp_uefi_lockdown.load_boot_state()
        if state:
            print(f"\n--- Saved Boot State ---")
            print(f"  Password was pre-existing: {state.get('setup_password_was_set')}")
            for name, val in state.get('settings', {}).items():
                print(f"  {name}: {val}")

    print(f"\n--- WinRE Status ---")
    print(f"  WinRE enabled: {bcd_lockdown._is_winre_enabled()}")


def cmd_bcd_lock():
    print("Applying BCD lockdown...")
    result = bcd_lockdown.apply_bcd_lockdown()
    print(f"\nResult: {'SUCCESS' if result else 'FAILED'}")


def cmd_bcd_unlock():
    print("Removing BCD lockdown...")
    result = bcd_lockdown.remove_bcd_lockdown()
    print(f"\nResult: {'SUCCESS' if result else 'FAILED'}")


def cmd_uefi_lock():
    print("Applying UEFI lockdown...")
    if not hp_uefi_lockdown.is_hp_machine():
        print("Not an HP machine — cannot apply UEFI lockdown")
        return
    password = hp_uefi_lockdown.apply_boot_lockdown()
    if password:
        print(f"\nSUCCESS — BIOS password: {password}")
        if not DRY_RUN:
            print("WRITE THIS DOWN! If lost, the machine may need OEM support to recover.")
        else:
            print("(dry-run — this is a simulated password)")
    else:
        print("FAILED or skipped — see logs above")


def cmd_uefi_unlock():
    print("Removing UEFI lockdown...")
    if DRY_RUN:
        # In dry-run, use a fake password
        password = "DryRunPassword123"
        print(f"  (dry-run — using simulated password: {password})")
    else:
        password = input("Enter the BIOS password that was set: ").strip()
    if not password:
        print("No password entered — aborting")
        return
    result = hp_uefi_lockdown.remove_boot_lockdown(password)
    print(f"\nResult: {'SUCCESS' if result else 'FAILED'}")


def cmd_full_lock():
    print("=== Applying full boot lockdown (BCD + UEFI) ===\n")
    cmd_bcd_lock()
    print()
    cmd_uefi_lock()


def cmd_full_unlock():
    print("=== Removing full boot lockdown (BCD + UEFI) ===\n")
    cmd_bcd_unlock()
    print()
    cmd_uefi_unlock()


COMMANDS = {
    "status": cmd_status,
    "bcd-lock": cmd_bcd_lock,
    "bcd-unlock": cmd_bcd_unlock,
    "uefi-lock": cmd_uefi_lock,
    "uefi-unlock": cmd_uefi_unlock,
    "full-lock": cmd_full_lock,
    "full-unlock": cmd_full_unlock,
}

if __name__ == "__main__":
    if len(sys.argv) < 2 or sys.argv[1] not in COMMANDS:
        print(__doc__)
        print(f"\nAvailable commands: {', '.join(COMMANDS.keys())}")
        sys.exit(1)
    COMMANDS[sys.argv[1]]()
