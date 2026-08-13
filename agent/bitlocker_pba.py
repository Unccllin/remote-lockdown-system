"""BitLocker TPM+PIN PBA module (T9 — Phase 3).

Adds a TPM+PIN protector to an existing BitLocker-encrypted drive, captures
the 48-digit recovery password, and provides removal during unlock.

Design decisions (see trace.md RULE-ZERO):
- Q7=A: BitLocker must already be enabled. If off, enable_pba() fails with
  a clear error — the agent does NOT enable BitLocker.
- Q1=A: PBA is opt-in (enable_pba flag from the server).
- Uses WMI Win32_EncryptableVolume for protector management and manage-bde
  for status checks (consistent with hp_uefi_lockdown._check_bitlocker).
- The protector_id is persisted locally in a state file so the agent can
  remove the PIN protector during unlock without server-side state.

Debt items addressed:
- D-008: BitLocker status check (check_bitlocker_status reuses the same
  manage-bde approach as bcd_lockdown._check_bitlocker)
- D-019: BitLocker suspension for BIOS changes — this module adds the
  TPM+PIN protector layer that makes BitLocker a PBA factor
"""

import json
import logging
import os
import platform
import secrets
import subprocess
from pathlib import Path

log = logging.getLogger("bitlocker_pba")

# Master dry-run switch (propagated from agent.py via set_dry_run())
_DRY_RUN = False

# Local state file for protector_id persistence across lockdown/unlock cycles.
# Stored alongside the agent's other state files.
_BITLOCKER_PBA_STATE_FILE = Path(
    os.environ.get(
        "BITLOCKER_PBA_STATE_FILE",
        str(Path.home() / ".local" / "share" / "lockdown-agent" / "bitlocker_pba_state.json"),
    )
)

# Dry-run simulated state
_DRY_RUN_BITLOCKER_ENABLED = True
_DRY_RUN_PROTECTOR_ID = "{FAFA-FAFA-FAFA}"
_DRY_RUN_RECOVERY_PASSWORD = "111111-222222-333333-444444-555555-666666-777777-888888"


# ---------------------------------------------------------------------------
# Dry-run control
# ---------------------------------------------------------------------------


def set_dry_run(value: bool) -> None:
    """Enable/disable dry-run mode (called by agent.py at startup)."""
    global _DRY_RUN
    _DRY_RUN = value


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


def _run_cmd(cmd: list[str], timeout: int = 10) -> tuple[int, str, str]:
    """Run a command-line tool (manage-bde) and return (rc, stdout, stderr)."""
    if _DRY_RUN:
        cmd_str = " ".join(cmd)
        print(f"  [DRY-RUN] {cmd_str}")
        if "manage-bde" in cmd and "-status" in cmd:
            status = "Protection On" if _DRY_RUN_BITLOCKER_ENABLED else "Protection Off"
            return (
                0,
                f"    Protection Status:    {status}\n    Conversion Status:    100% Encrypted",
                "",
            )
        return 0, "", ""
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        return result.returncode, result.stdout.strip(), result.stderr.strip()
    except FileNotFoundError:
        return -1, "", f"Command not found: {cmd[0]}"
    except subprocess.TimeoutExpired:
        return -2, "", f"Command timed out: {' '.join(cmd)}"
    except Exception as e:
        return -3, "", str(e)


def _dry_run_powershell_response(script: str) -> str:
    """Return a simulated response for a PowerShell WMI query in dry-run mode."""
    if "GetConversionStatus" in script:
        # BitLocker is fully encrypted (ConversionStatus = 1 = FullyEncrypted)
        return "1"
    if "GetProtectionStatus" in script:
        # Protection is on (ProtectionStatus = 1 = Protected)
        return "1"
    if "ProtectKeyWithTPMAndPIN" in script:
        # Return a simulated protector ID
        return _DRY_RUN_PROTECTOR_ID
    if "GetKeyProtectorNumericalPassword" in script:
        # Recovery password query — must be checked before GetKeyProtectors
        # because the script contains both strings
        return _DRY_RUN_RECOVERY_PASSWORD
    if "GetKeyProtectors" in script:
        # Return a simulated protector list: TPM+PIN + NumericalPassword
        return (
            f"ID={{TPM-ONLY-0001}};Type=1\n"
            f"ID={_DRY_RUN_PROTECTOR_ID};Type=4\n"
            f"ID={{RECOVERY-0001}};Type=3\n"
        )
    if "DeleteKeyProtector" in script:
        return "0"  # Success
    return ""


# ---------------------------------------------------------------------------
# BitLocker status check
# ---------------------------------------------------------------------------


def check_bitlocker_status() -> dict:
    """Check if BitLocker is enabled on C: with a TPM protector.

    # D-008: BitLocker status check — reuses the same manage-bde approach
    # as bcd_lockdown._check_bitlocker for consistency.

    Returns a dict with:
      - enabled: bool — True if BitLocker protection is ON
      - has_tpm_protector: bool — True if a TPM-only protector exists
      - has_pin_protector: bool — True if a TPM+PIN protector exists
      - error: str | None — error message if the check failed
    """
    if _DRY_RUN:
        return {
            "enabled": _DRY_RUN_BITLOCKER_ENABLED,
            "has_tpm_protector": _DRY_RUN_BITLOCKER_ENABLED,
            "has_pin_protector": False,
            "error": None,
        }
    if platform.system() != "Windows":
        return {
            "enabled": False,
            "has_tpm_protector": False,
            "has_pin_protector": False,
            "error": None,
        }
    try:
        # Check protection status via manage-bde (consistent with hp_uefi_lockdown)
        rc, stdout, stderr = _run_cmd(["manage-bde", "-status", "C:"], timeout=10)
        if rc != 0:
            return {
                "enabled": False,
                "has_tpm_protector": False,
                "has_pin_protector": False,
                "error": f"manage-bde failed: {stderr}",
            }
        enabled = "protection on" in stdout.lower()

        # Check protector types via WMI
        has_tpm = False
        has_pin = False
        if enabled:
            # ProtectorType: 1=TpmOnly, 4=TpmPin, 3=NumericalPassword
            script = (
                "$v = Get-WmiObject -Namespace 'root\\cimv2\\security\\MicrosoftVolumeEncryption' "
                "-Class Win32_EncryptableVolume -Filter \"DriveLetter='C:'\"; "
                "$protectors = $v.GetKeyProtectors(); "
                "foreach ($p in $protectors.KeyProtector) { "
                'Write-Output "ID=$($p.ID);Type=$($p.ProtectionType)" }'
            )
            output = _run_powershell(script, timeout=15)
            for line in output.split("\n"):
                line = line.strip()
                if ";Type=1" in line:
                    has_tpm = True
                if ";Type=4" in line:
                    has_pin = True

        return {
            "enabled": enabled,
            "has_tpm_protector": has_tpm,
            "has_pin_protector": has_pin,
            "error": None,
        }
    except Exception as e:
        return {
            "enabled": False,
            "has_tpm_protector": False,
            "has_pin_protector": False,
            "error": str(e),
        }


# ---------------------------------------------------------------------------
# PIN generation
# ---------------------------------------------------------------------------


def _generate_pin(length: int = 6) -> str:
    """Generate a random numeric PIN of the given length."""
    return "".join(str(secrets.randbelow(10)) for _ in range(length))


# ---------------------------------------------------------------------------
# Protector management
# ---------------------------------------------------------------------------


def add_tpm_pin_protector(pin: str) -> str:
    """Add a TPM+PIN protector to C:.

    Returns the protector ID on success, raises RuntimeError on failure.
    """
    script = (
        "$v = Get-WmiObject -Namespace 'root\\cimv2\\security\\MicrosoftVolumeEncryption' "
        "-Class Win32_EncryptableVolume -Filter \"DriveLetter='C:'\"; "
        f"$result = $v.ProtectKeyWithTPMAndPIN(null, null, '{pin}'); "
        "if ($result.ReturnValue -ne 0) { "
        '  throw "ProtectKeyWithTPMAndPIN failed: $($result.ReturnValue)" } '
        "Write-Output $result.ProtectorKeyID"
    )
    protector_id = _run_powershell(script, timeout=30)
    if not protector_id:
        raise RuntimeError("ProtectKeyWithTPMAndPIN returned empty protector ID")
    log.info("T9: TPM+PIN protector added (ID=%s)", protector_id)
    return protector_id


def get_recovery_password() -> str:
    """Retrieve the 48-digit numerical recovery password for C:.

    Iterates all protectors, finds the NumericalPassword type, and extracts
    the recovery key. Raises RuntimeError if not found.
    """
    # First, get the numerical password protector ID
    script = (
        "$v = Get-WmiObject -Namespace 'root\\cimv2\\security\\MicrosoftVolumeEncryption' "
        "-Class Win32_EncryptableVolume -Filter \"DriveLetter='C:'\"; "
        "$protectors = $v.GetKeyProtectors(); "
        "foreach ($p in $protectors.KeyProtector) { "
        "  if ($p.ProtectionType -eq 3) { "
        "    $pw = $v.GetKeyProtectorNumericalPassword($p.ID); "
        "    Write-Output $pw.NumericalPassword } }"
    )
    recovery_password = _run_powershell(script, timeout=15)
    if not recovery_password:
        raise RuntimeError("No numerical recovery password protector found")
    log.info("T9: Recovery password retrieved (48-digit)")
    return recovery_password


def remove_tpm_pin_protector(protector_id: str) -> bool:
    """Delete the TPM+PIN protector from C:.

    Returns True on success, False on failure.
    """
    script = (
        "$v = Get-WmiObject -Namespace 'root\\cimv2\\security\\MicrosoftVolumeEncryption' "
        "-Class Win32_EncryptableVolume -Filter \"DriveLetter='C:'\"; "
        f"$result = $v.DeleteKeyProtector('{protector_id}'); "
        "if ($result.ReturnValue -ne 0) { "
        '  throw "DeleteKeyProtector failed: $($result.ReturnValue)" } '
        "Write-Output '0'"
    )
    _run_powershell(script, timeout=15)
    log.info("T9: TPM+PIN protector removed (ID=%s)", protector_id)
    return True


# ---------------------------------------------------------------------------
# State persistence
# ---------------------------------------------------------------------------


def _save_pba_state(protector_id: str, pin: str, recovery_password: str) -> None:
    """Persist PBA state (protector_id) for use during unlock."""
    state = {
        "protector_id": protector_id,
        "pin": pin,
        "recovery_password": recovery_password,
    }
    _BITLOCKER_PBA_STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    _BITLOCKER_PBA_STATE_FILE.write_text(json.dumps(state))
    log.info("T9: PBA state saved to %s", _BITLOCKER_PBA_STATE_FILE)


def _load_pba_state() -> dict | None:
    """Load persisted PBA state. Returns None if no state file exists."""
    if not _BITLOCKER_PBA_STATE_FILE.exists():
        return None
    try:
        return json.loads(_BITLOCKER_PBA_STATE_FILE.read_text())
    except Exception as e:
        log.warning("T9: Failed to load PBA state: %s", e)
        return None


def _clear_pba_state() -> None:
    """Delete the PBA state file after unlock."""
    if _BITLOCKER_PBA_STATE_FILE.exists():
        _BITLOCKER_PBA_STATE_FILE.unlink()
        log.info("T9: PBA state file cleared")


# ---------------------------------------------------------------------------
# Orchestrators
# ---------------------------------------------------------------------------


def enable_pba(pin: str | None = None) -> dict:
    """Add a TPM+PIN protector to BitLocker and capture recovery password.

    # D-019: Adds the TPM+PIN protector layer that makes BitLocker a PBA
    # factor. The 48-digit recovery password is captured for operator
    # recovery via the dashboard PBA Recovery panel.

    Q7=A: Requires BitLocker already enabled. If off, returns failure with
    a clear error — the agent does NOT enable BitLocker.

    Args:
        pin: Optional PIN string (numeric). If None, a random 6-digit PIN
             is generated.

    Returns:
        dict with:
          - success: bool
          - pin: str | None — the PIN that was set
          - recovery_password: str | None — 48-digit recovery key
          - protector_id: str | None — needed for disable_pba()
          - error: str | None — error message on failure
    """
    if pin is None:
        pin = _generate_pin()

    # Q7=A: Check BitLocker is enabled
    status = check_bitlocker_status()
    if not status["enabled"]:
        return {
            "success": False,
            "pin": None,
            "recovery_password": None,
            "protector_id": None,
            "error": "BitLocker is not enabled on C: — cannot add TPM+PIN protector (Q7=A)",
        }
    if status["has_pin_protector"]:
        return {
            "success": False,
            "pin": None,
            "recovery_password": None,
            "protector_id": None,
            "error": "TPM+PIN protector already exists — refusing to add a second one",
        }

    try:
        # Add the TPM+PIN protector
        protector_id = add_tpm_pin_protector(pin)

        # Capture the recovery password (48-digit numerical password)
        recovery_password = get_recovery_password()

        # Persist state for unlock
        _save_pba_state(protector_id, pin, recovery_password)

        log.warning(
            "T9: BitLocker TPM+PIN PBA active — device will require PIN at boot "
            "(not remotely recoverable after reboot)"
        )
        return {
            "success": True,
            "pin": pin,
            "recovery_password": recovery_password,
            "protector_id": protector_id,
            "error": None,
        }
    except Exception as e:
        log.error("T9: Failed to enable BitLocker PBA: %s", e)
        return {
            "success": False,
            "pin": None,
            "recovery_password": None,
            "protector_id": None,
            "error": str(e),
        }


def disable_pba(protector_id: str | None = None) -> dict:
    """Remove the TPM+PIN protector, restoring TPM-only boot.

    # D-019: Removes the TPM+PIN protector during unlock/recovery so the
    # device boots normally without the PIN prompt.

    Args:
        protector_id: The protector ID to delete. If None, loads from the
                      persisted PBA state file.

    Returns:
        dict with:
          - success: bool
          - error: str | None — error message on failure
    """
    if protector_id is None:
        state = _load_pba_state()
        if state is None:
            return {
                "success": False,
                "error": "No PBA state file — cannot determine protector_id to remove",
            }
        protector_id = state.get("protector_id")
        if not protector_id:
            return {
                "success": False,
                "error": "PBA state file has no protector_id",
            }

    try:
        remove_tpm_pin_protector(protector_id)
        _clear_pba_state()
        log.info("T9: BitLocker TPM+PIN PBA removed — device boots without PIN")
        return {"success": True, "error": None}
    except Exception as e:
        log.error("T9: Failed to disable BitLocker PBA: %s", e)
        return {"success": False, "error": str(e)}
