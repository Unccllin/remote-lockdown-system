"""
Windows Tamper Protection
-------------------------
Hardens the agent against deletion by a thief with admin access.

Layers:
1. **File ACL hardening** — Sets DENY DELETE ACL on the agent binary,
   config, and state files. Even admins can't delete without first
   removing the DENY ACE (which requires taking ownership).
2. **Registry protection** — Sets DENY DELETE on the service registry
   keys and scheduled task registry keys.
3. **Uninstall authorization** — The local uninstall script must
   present a server-issued uninstall token. Without it, the agent's
   self-protection re-asserts (re-locks, flags as tampered).
4. **Mutual watchdog** — The agent monitors the watchdog process and
   vice versa. Killing one triggers the other to restart it.

This module is Windows-only. On other platforms it's a no-op.

Usage:
    from tamper_protection import apply_file_acls, apply_registry_protection, \
        verify_uninstall_token, remove_protection

    # On install:
    apply_file_acls(agent_path, config_path, state_dir)
    apply_registry_protection()

    # On uninstall (requires server token):
    if verify_uninstall_token(token, device_id, server_url, api_key):
        remove_protection(agent_path, config_path, state_dir)
        # ... proceed with uninstall
"""

import json
import logging
import platform
import subprocess
import time
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

log = logging.getLogger("lockdown-agent")

# ---------------------------------------------------------------------------
# Platform check
# ---------------------------------------------------------------------------


def _is_windows() -> bool:
    return platform.system() == "Windows"


def _is_admin() -> bool:
    """Check if running with admin privileges."""
    if not _is_windows():
        return False
    try:
        result = subprocess.run(["net", "session"], capture_output=True, text=True, timeout=5)
        return result.returncode == 0
    except (subprocess.SubprocessError, OSError, FileNotFoundError):
        return False


# ---------------------------------------------------------------------------
# 1. File ACL Hardening
# ---------------------------------------------------------------------------

# Paths to protect — agent binary, config, state directory, watchdog binary
_PROTECTED_FILES = []


def _get_icacls_deny_delete_command(file_path: str) -> list[str]:
    """Build icacls command to DENY DELETE on a file for Everyone.

    This sets a DENY ACE for DELETE permission. Even admins must take
    ownership and remove the DENY ACE before they can delete the file.
    """
    # DENY Everyone:(DE) — deny Delete permission
    return [
        "icacls",
        file_path,
        "/deny",
        "Everyone:(DE)",
        "/inheritance:r",
    ]


def _get_icacls_grant_system_command(file_path: str) -> list[str]:
    """Grant SYSTEM full control (so the agent itself can still operate)."""
    return [
        "icacls",
        file_path,
        "/grant",
        "SYSTEM:(F)",
        "/grant",
        "Administrators:(RX)",  # Read+Execute, NOT Delete
    ]


def apply_file_acls(
    agent_path: Path,
    config_path: Path | None = None,
    state_dir: Path | None = None,
    watchdog_path: Path | None = None,
) -> dict:
    """Apply DENY DELETE ACLs to critical agent files.

    Args:
        agent_path: Path to the agent binary/script
        config_path: Path to the config file
        state_dir: Path to the state directory (deadman, heartbeat, etc.)
        watchdog_path: Path to the watchdog binary

    Returns:
        Dict mapping file paths to success/failure status.
    """
    if not _is_windows():
        log.info("ACL hardening is Windows-only — skipping")
        return {"skipped": "not Windows"}

    if not _is_admin():
        log.error("ACL hardening requires admin privileges")
        return {"error": "not admin"}

    results = {}
    files_to_protect = []

    if agent_path and agent_path.exists():
        files_to_protect.append(("agent", agent_path))
    if config_path and config_path.exists():
        files_to_protect.append(("config", config_path))
    if watchdog_path and watchdog_path.exists():
        files_to_protect.append(("watchdog", watchdog_path))

    # Protect individual state files if state_dir is given
    if state_dir and state_dir.exists():
        for state_file in [
            ".deadman",
            ".locked",
            ".heartbeat",
            ".pending_ack",
            ".bios_pw_backup",
            ".bcd_state",
            ".boot_state",
        ]:
            sf = state_dir / state_file
            if sf.exists():
                files_to_protect.append((f"state/{state_file}", sf))

    for label, fpath in files_to_protect:
        fpath_str = str(fpath)
        try:
            # First grant SYSTEM full control + Admins read/execute
            grant_cmd = _get_icacls_grant_system_command(fpath_str)
            result = subprocess.run(grant_cmd, capture_output=True, text=True, timeout=10)
            if result.returncode != 0:
                log.warning("Failed to grant SYSTEM access to %s: %s", fpath_str, result.stderr)
                results[label] = {"grant": False, "deny": False}
                continue

            # Then deny DELETE for Everyone (including admins)
            deny_cmd = _get_icacls_deny_delete_command(fpath_str)
            result = subprocess.run(deny_cmd, capture_output=True, text=True, timeout=10)
            if result.returncode != 0:
                log.warning("Failed to deny DELETE on %s: %s", fpath_str, result.stderr)
                results[label] = {"grant": True, "deny": False}
            else:
                log.info("ACL hardened: %s (DELETE denied for Everyone)", fpath_str)
                results[label] = {"grant": True, "deny": True}
        except (subprocess.SubprocessError, OSError, FileNotFoundError) as e:
            log.error("ACL hardening failed for %s: %s", fpath_str, e)
            results[label] = {"grant": False, "deny": False, "error": str(e)}

    return results


def remove_file_acls(
    agent_path: Path,
    config_path: Path | None = None,
    state_dir: Path | None = None,
    watchdog_path: Path | None = None,
) -> dict:
    """Remove DENY DELETE ACLs (for authorized uninstall).

    This resets the ACLs to default before deletion.
    """
    if not _is_windows():
        return {"skipped": "not Windows"}

    if not _is_admin():
        return {"error": "not admin"}

    results = {}
    files_to_reset = []

    if agent_path and agent_path.exists():
        files_to_reset.append(("agent", agent_path))
    if config_path and config_path.exists():
        files_to_reset.append(("config", config_path))
    if watchdog_path and watchdog_path.exists():
        files_to_reset.append(("watchdog", watchdog_path))
    if state_dir and state_dir.exists():
        for state_file in [
            ".deadman",
            ".locked",
            ".heartbeat",
            ".pending_ack",
            ".bios_pw_backup",
            ".bcd_state",
            ".boot_state",
        ]:
            sf = state_dir / state_file
            if sf.exists():
                files_to_reset.append((f"state/{state_file}", sf))

    for label, fpath in files_to_reset:
        fpath_str = str(fpath)
        try:
            # Reset ACLs to default (remove all explicit ACEs)
            result = subprocess.run(
                ["icacls", fpath_str, "/reset", "/q"],
                capture_output=True,
                text=True,
                timeout=10,
            )
            if result.returncode == 0:
                log.info("ACL reset: %s", fpath_str)
                results[label] = True
            else:
                log.warning("ACL reset failed for %s: %s", fpath_str, result.stderr)
                results[label] = False
        except (subprocess.SubprocessError, OSError, FileNotFoundError) as e:
            log.error("ACL reset failed for %s: %s", fpath_str, e)
            results[label] = False

    return results


# ---------------------------------------------------------------------------
# 2. Registry Protection
# ---------------------------------------------------------------------------

# Registry keys that hold the service registration and scheduled task info
# Protecting these prevents `sc delete` and `schtasks /delete` from working
_REGISTRY_KEYS_TO_PROTECT = [
    # NSSM service registration
    r"HKLM\SYSTEM\CurrentControlSet\Services\LockdownAgent",
    # Scheduled task (SystemHealthMonitor)
    (
        r"HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion"
        r"\Schedule\TaskCache\Tree\SystemHealthMonitor"
    ),
    # Registry run key value
    r"HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Run",
]


def apply_registry_protection() -> dict:
    """Apply DENY DELETE on service registry keys.

    Uses PowerShell to set DENY ACE on registry keys, preventing
    `sc delete` and `schtasks /delete` from removing the service.
    """
    if not _is_windows():
        return {"skipped": "not Windows"}

    if not _is_admin():
        return {"error": "not admin"}

    results = {}
    for key in _REGISTRY_KEYS_TO_PROTECT:
        try:
            # Use PowerShell to set registry ACL — deny DELETE to Everyone
            ps_script = f"""
$path = '{key}'
if (Test-Path -Path "Registry::$path" -ErrorAction SilentlyContinue) {{
    $acl = Get-Acl -Path "Registry::$path"
    $rule = New-Object System.Security.AccessControl.RegistryAccessRule(
        "Everyone",
        "Delete",
        "ContainerInherit",
        "None",
        "Deny"
    )
    $acl.AddAccessRule($rule)
    Set-Acl -Path "Registry::$path" -AclObject $acl
    Write-Output "PROTECTED"
}} else {{
    Write-Output "NOT_FOUND"
}}
""".strip()
            result = subprocess.run(
                ["powershell", "-NoProfile", "-Command", ps_script],
                capture_output=True,
                text=True,
                timeout=10,
            )
            if "PROTECTED" in result.stdout:
                log.info("Registry key protected: %s", key)
                results[key] = True
            elif "NOT_FOUND" in result.stdout:
                log.debug("Registry key not found (skipping): %s", key)
                results[key] = "not_found"
            else:
                log.warning("Registry protection failed for %s: %s", key, result.stderr)
                results[key] = False
        except (subprocess.SubprocessError, OSError, FileNotFoundError) as e:
            log.error("Registry protection failed for %s: %s", key, e)
            results[key] = False

    return results


def remove_registry_protection() -> dict:
    """Remove DENY DELETE from registry keys (for authorized uninstall)."""
    if not _is_windows():
        return {"skipped": "not Windows"}

    if not _is_admin():
        return {"error": "not admin"}

    results = {}
    for key in _REGISTRY_KEYS_TO_PROTECT:
        try:
            ps_script = f"""
$path = '{key}'
if (Test-Path -Path "Registry::$path" -ErrorAction SilentlyContinue) {{
    $acl = Get-Acl -Path "Registry::$path"
    # Remove all DENY rules for Everyone
    $rules = $acl.Access | Where-Object {{
        $_.AccessControlType -eq "Deny" -and $_.IdentityReference.Value -eq "Everyone"
    }}
    foreach ($rule in $rules) {{
        $acl.RemoveAccessRule($rule) | Out-Null
    }}
    Set-Acl -Path "Registry::$path" -AclObject $acl
    Write-Output "RESET"
}} else {{
    Write-Output "NOT_FOUND"
}}
""".strip()
            result = subprocess.run(
                ["powershell", "-NoProfile", "-Command", ps_script],
                capture_output=True,
                text=True,
                timeout=10,
            )
            if "RESET" in result.stdout:
                log.info("Registry key ACL reset: %s", key)
                results[key] = True
            else:
                results[key] = "not_found" if "NOT_FOUND" in result.stdout else False
        except (subprocess.SubprocessError, OSError, FileNotFoundError) as e:
            log.error("Registry ACL reset failed for %s: %s", key, e)
            results[key] = False

    return results


# ---------------------------------------------------------------------------
# 3. Uninstall Authorization
# ---------------------------------------------------------------------------


def request_uninstall_token(
    server_url: str,
    api_key: str,
    device_id: str | None = None,
    hostname: str | None = None,
) -> str | None:
    """Request an uninstall authorization token from the server.

    The server issues a short-lived token (valid for 5 minutes) that
    the local uninstall script must present to remove_protection().

    Returns the token string, or None if the request failed.
    """
    url = f"{server_url.rstrip('/')}/api/agent/uninstall-auth"
    payload = json.dumps(
        {
            "device_id": device_id,
            "hostname": hostname,
            "timestamp": int(time.time()),
        }
    ).encode("utf-8")

    req = Request(url, data=payload, method="POST")  # noqa: S310 — URL is server-provided
    req.add_header("Content-Type", "application/json")
    req.add_header("Authorization", f"Bearer {api_key}")
    req.add_header("X-API-Key", api_key)

    try:
        with urlopen(req, timeout=10) as resp:  # noqa: S310
            data = json.loads(resp.read().decode("utf-8"))
            return data.get("uninstall_token")
    except HTTPError as e:
        log.error(
            "Uninstall token request failed: HTTP %d — %s",
            e.code,
            e.read().decode("utf-8", errors="replace"),
        )
        return None
    except (OSError, json.JSONDecodeError, ValueError, TypeError) as e:
        log.error("Uninstall token request failed: %s", e)
        return None


def verify_uninstall_token(
    token: str,
    server_url: str,
    api_key: str,
    device_id: str | None = None,
) -> bool:
    """Verify an uninstall token with the server.

    Returns True if the server confirms the token is valid and not expired.
    """
    url = f"{server_url.rstrip('/')}/api/agent/uninstall-auth/verify"
    payload = json.dumps(
        {
            "uninstall_token": token,
            "device_id": device_id,
        }
    ).encode("utf-8")

    req = Request(url, data=payload, method="POST")  # noqa: S310 — URL is server-provided
    req.add_header("Content-Type", "application/json")
    req.add_header("Authorization", f"Bearer {api_key}")
    req.add_header("X-API-Key", api_key)

    try:
        with urlopen(req, timeout=10) as resp:  # noqa: S310
            data = json.loads(resp.read().decode("utf-8"))
            return data.get("authorized", False)
    except HTTPError:
        return False
    except (OSError, json.JSONDecodeError, ValueError, TypeError):
        return False


# ---------------------------------------------------------------------------
# 4. Combined Protection (install/uninstall)
# ---------------------------------------------------------------------------


def apply_all_protection(
    agent_path: Path,
    config_path: Path | None = None,
    state_dir: Path | None = None,
    watchdog_path: Path | None = None,
) -> dict:
    """Apply all tamper protection layers. Call during installation."""
    if not _is_windows():
        return {"skipped": "not Windows"}

    results = {
        "file_acls": apply_file_acls(agent_path, config_path, state_dir, watchdog_path),
        "registry": apply_registry_protection(),
    }
    log.info("Tamper protection applied: %s", results)
    return results


def remove_all_protection(
    agent_path: Path,
    config_path: Path | None = None,
    state_dir: Path | None = None,
    watchdog_path: Path | None = None,
    uninstall_token: str | None = None,
    server_url: str | None = None,
    api_key: str | None = None,
    device_id: str | None = None,
) -> dict:
    """Remove all tamper protection layers. Call during authorized uninstall.

    If uninstall_token is provided, it will be verified with the server
    before removing protection. If verification fails, protection stays
    in place and an error is returned.
    """
    if not _is_windows():
        return {"skipped": "not Windows"}

    # Verify uninstall token with server if provided
    if uninstall_token and server_url and api_key:
        if not verify_uninstall_token(uninstall_token, server_url, api_key, device_id):
            log.error("Uninstall token verification failed — protection NOT removed")
            return {"error": "uninstall token invalid or expired", "protection_removed": False}

    results = {
        "file_acls": remove_file_acls(agent_path, config_path, state_dir, watchdog_path),
        "registry": remove_registry_protection(),
        "protection_removed": True,
    }
    log.info("Tamper protection removed: %s", results)
    return results


# ---------------------------------------------------------------------------
# 5. Tamper Detection Check
# ---------------------------------------------------------------------------


def check_tamper(state_dir: Path) -> dict:
    """Check for signs of tampering.

    Returns a dict with:
        - files_missing: list of protected files that are gone
        - service_missing: True if the service registration is gone
        - task_missing: True if the scheduled task is gone
        - tampered: True if any tamper detected
    """
    result = {
        "files_missing": [],
        "service_missing": False,
        "task_missing": False,
        "tampered": False,
    }

    if not _is_windows():
        return result

    # Check if critical state files are missing (may indicate deletion attempt)
    critical_files = [".deadman", ".locked"]
    for fname in critical_files:
        fpath = state_dir / fname
        if not fpath.exists():
            result["files_missing"].append(fname)

    # Check if the scheduled task still exists
    try:
        task_result = subprocess.run(
            ["schtasks", "/Query", "/TN", "SystemHealthMonitor"],
            capture_output=True,
            text=True,
            timeout=5,
        )
        result["task_missing"] = task_result.returncode != 0
    except (subprocess.SubprocessError, OSError, FileNotFoundError):
        result["task_missing"] = True

    # Check if the service still exists
    try:
        svc_result = subprocess.run(
            ["sc", "query", "LockdownAgent"],
            capture_output=True,
            text=True,
            timeout=5,
        )
        result["service_missing"] = svc_result.returncode != 0
    except (subprocess.SubprocessError, OSError, FileNotFoundError):
        result["service_missing"] = True

    result["tampered"] = (
        len(result["files_missing"]) > 0 or result["service_missing"] or result["task_missing"]
    )

    return result
