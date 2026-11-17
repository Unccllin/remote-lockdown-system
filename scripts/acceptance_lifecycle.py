#!/usr/bin/env python3
"""Lifecycle acceptance run: one command, and the report is the machine's own state.

Why this exists
---------------
The live lifecycle test on MOLE (S269-S270) found five defects in an afternoon and
nothing in the unit suite found any of them, because every one was a disagreement
between what the agent *reported* and what the machine *was*:

  * `tracking_state.json` recorded `decoy_account: "GuestUser"` while
    `Get-LocalUser GuestUser` said there was no such account;
  * `agent_lockdown_confirmed` was sent after every BCD layer had rolled back;
  * a re-install printed the PREVIOUS run's `install.log` and read as "Installation
    Complete" — the installer had crashed before doing anything.

So each step here is done when its POST-CONDITION IS OBSERVED on the target (via
``scripts/acceptance_probe.ps1``, which changes nothing) and on the server (via the API),
and the report carries the observation. A step that cannot be observed is SKIP with the
reason — never PASS, and never a silent omission.

Design notes
------------
* The evaluators are pure functions over (server record, device snapshot, command
  record). That is what makes them testable without a Windows machine, and
  ``--snapshot`` replays a stored probe so a report can be re-derived offline.
* Credentials are never embedded: the SSH target comes from ``RLS_SSH_*`` (as
  ``scripts/rsh.py`` does) and the admin credential from an env var, both for the reason
  S140 recorded — a host, a user and a password went into git once already.
* Destructive steps are opt-in (``--allow-destructive``): ``track`` disables the signed-in
  account and EFS-encrypts its profile, and a failed run of it is not undone by itself.

Usage
-----
    RLS_SSH_HOST=192.0.2.10 RLS_SSH_USER=labadmin RLS_SSH_KEY=~/.ssh/lab \\
      ADMIN_TOKEN=... python3 scripts/acceptance_lifecycle.py \\
        --server-url http://192.0.2.20:8787 --device MOLE --step all --allow-destructive

    # Re-derive a report from a stored snapshot, no network, no SSH:
    python3 scripts/acceptance_lifecycle.py --snapshot probe.json --step lock

Exit code: 0 when every evaluated step is PASS or SKIP, 1 when any step FAILs, 2 on a
usage error (which is a failure of the harness, not of the device).
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path

HERE = Path(__file__).resolve().parent
PROBE_PATH = HERE / "acceptance_probe.ps1"

# A device that has not checked in for two poll intervals is not reporting. The limit is
# never allowed below CHECKIN_FLOOR_SECONDS, because the agent's interval is ADAPTIVE and
# server-driven: MOLE reported poll_interval 30 in its config while the server told it 300,
# so a 60 s limit failed a perfectly healthy device (measured, S270). The observation
# prints both the age and the limit, so a loose pass is still readable.
CHECKIN_INTERVALS = 2
CHECKIN_FLOOR_SECONDS = 300

STEPS = ("enroll", "lock", "recover", "track", "stop-track")


# ---------------------------------------------------------------------------
# Report model
# ---------------------------------------------------------------------------


@dataclass
class Check:
    """One post-condition, and what was actually observed for it."""

    name: str
    passed: bool | None  # None = not observable (SKIP), never treated as a pass
    observed: str


@dataclass
class StepResult:
    step: str
    checks: list[Check] = field(default_factory=list)
    note: str = ""

    @property
    def status(self) -> str:
        """FAIL beats SKIP beats PASS — an unobservable post-condition is not a pass."""
        if any(c.passed is False for c in self.checks):
            return "FAIL"
        if not self.checks or any(c.passed is None for c in self.checks):
            return "SKIP"
        return "PASS"

    def failures(self) -> list[Check]:
        return [c for c in self.checks if c.passed is False]


def check(name: str, passed: bool | None, observed: object) -> Check:
    """Build a check, rendering the observation the same way every time."""
    if passed is None:
        return Check(name, None, f"not observable ({observed})")
    return Check(name, bool(passed), str(observed))


# ---------------------------------------------------------------------------
# Pure evaluators — one per lifecycle step
# ---------------------------------------------------------------------------


def _parse_ts(value: str | None) -> datetime | None:
    if not value:
        return None
    text = str(value).replace("Z", "+00:00")
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=UTC)


def _poll_seconds(snapshot: dict) -> int:
    """The agent's poll interval from its own config, tolerated as junk.

    A config written by hand can carry a string or nothing at all; a check that crashes
    on it reports nothing, which is worse than falling back to the documented default.
    """
    raw = snapshot.get("poll_interval")
    if isinstance(raw, str):
        try:
            value = int(raw)
        except ValueError:
            return 60
    elif isinstance(raw, int) and not isinstance(raw, bool):
        value = raw
    else:
        return 60
    return value if value > 0 else 60


def checkin_fresh(
    device: dict,
    now: datetime,
    poll_seconds: int = 60,
    intervals: int = CHECKIN_INTERVALS,
) -> tuple[bool | None, str]:
    """Is the device's last check-in recent enough to call it connected?

    Unobservable (None) when the server never recorded a check-in: "no data" must not be
    reported as "offline", because that is the same conflation the status derivation
    question turns on.
    """
    last = _parse_ts(device.get("last_checkin"))
    if last is None:
        return None, "last_checkin absent"
    age = (now - last).total_seconds()
    limit = max(poll_seconds * intervals, CHECKIN_FLOOR_SECONDS)
    return age <= limit, f"{age:.0f}s ago (limit {limit}s)"


def evaluate_enroll(
    device: dict | None, snap: dict, now: datetime, expected_hostname: str | None = None
) -> StepResult:
    result = StepResult("enroll")
    result.checks.append(
        check("service Running", snap.get("service") == "Running", snap.get("service"))
    )
    result.checks.append(
        check(
            "config.json parses",
            snap.get("config_parses") is True,
            snap.get("config_parses"),
        )
    )

    fresh, detail = checkin_fresh(device or {}, now, _poll_seconds(snap))
    result.checks.append(check("agent checked in", fresh, detail))

    if device is None:
        result.checks.append(
            check("device enrolled on the server", False, "no device record")
        )
        return result

    result.checks.append(check("device enrolled on the server", True, device.get("id")))
    # Cross-surface: the config's device_id must be the id the server knows, or the
    # machine is checking in as somebody else.
    same = snap.get("config_device_id") == device.get("id")
    result.checks.append(
        check(
            "config device_id matches the server",
            same,
            f"{snap.get('config_device_id')} vs {device.get('id')}",
        )
    )
    if expected_hostname:
        result.checks.append(
            check(
                "hostname matches",
                str(device.get("hostname", "")).upper() == expected_hostname.upper(),
                f"{device.get('hostname')} vs {expected_hostname}",
            )
        )
    result.checks.append(
        check(
            "agent reports a version",
            bool(device.get("agent_version")),
            device.get("agent_version"),
        )
    )
    return result


def account_disabled(snap: dict) -> tuple[bool | None, str]:
    """Is the interactive account's UF_ACCOUNTDISABLE bit set, per the OS account database?

    This is the flag Windows consults to refuse a logon, read through ADSI. A LogonUserW
    probe with a wrong password was tried first and cannot answer the question (measured on
    MOLE, S271): a nonexistent user, an enabled user with a wrong password and a disabled
    user with a wrong password all return 1326 ERROR_LOGON_FAILURE — 1331 only appears when
    the credentials are otherwise valid, which this harness must not have.
    """
    probe = snap.get("account_probe") or {}
    if not probe.get("attempted"):
        return None, probe.get("meaning") or "UserFlags not readable"
    disabled = probe.get("disabled")
    detail = f"{probe.get('meaning')} (UserFlags={probe.get('user_flags')})"
    return (None if disabled is None else bool(disabled)), detail


def account_state(snap: dict) -> tuple[bool | None, str]:
    """(disabled, detail) for the interactive account.

    The OS flag is the authority. When it is unreadable the `net user` state is used as a
    weaker fallback rather than dropping the check entirely — with its name in the report,
    so a reader can tell which was used.
    """
    disabled, detail = account_disabled(snap)
    if disabled is not None:
        return (
            disabled,
            f"{detail}; net user says active={snap.get('real_user_active')}",
        )
    active = snap.get("real_user_active")
    if active is None:
        return None, f"{detail}; no interactive user detected"
    return (active is False), f"net user says active={active} ({detail})"


def lockdown_folder_state(snap: dict) -> tuple[int, int]:
    """(encrypted, plaintext) file counts in the lockdown folder.

    The lockdown encrypts CONTENT into `NAME.ext.enc` siblings (agent.py::encrypt_folder);
    the EFS attribute stays clear, so counting it reported "0 encrypted" for a folder that
    was genuinely encrypted (measured on MOLE, S271).
    """
    enc = snap.get("lockdown_enc_files")
    plain = snap.get("lockdown_plain_files")
    if enc is None:
        return (1 if (snap.get("lockdown_encrypted") or 0) > 0 else 0), 0
    return int(enc or 0), int(plain or 0)


def evaluate_lock(device: dict | None, snap: dict, command: dict | None) -> StepResult:
    result = StepResult("lock")
    result.checks.append(
        check(
            "lock sentinel present",
            snap.get("lock_sentinel"),
            snap.get("lock_sentinel"),
        )
    )

    enc_files, plain_files = lockdown_folder_state(snap)
    result.checks.append(
        check(
            "lockdown folder encrypted",
            enc_files > 0 and plain_files == 0,
            f"{enc_files} .enc file(s), {plain_files} plaintext left",
        )
    )

    # Sign-in is the half that was missing: the operator signed straight back in to a
    # "locked" MOLE with their own password (S270). The account-disabled bit is the
    # authority; the `net user` read is named in the observation as corroboration.
    disabled, disabled_detail = account_state(snap)
    result.checks.append(
        check(
            f"account disabled ({snap.get('real_user') or 'no interactive user'})",
            disabled,
            disabled_detail,
        )
    )

    status = (device or {}).get("status")
    result.checks.append(
        check(
            "server reports a locked device", status in ("locked", "recovering"), status
        )
    )

    if command is None:
        result.checks.append(
            check("lockdown command executed", None, "no lockdown command on record")
        )
        return result

    result.checks.append(
        check(
            "lockdown command executed",
            command.get("status") == "executed",
            command.get("status"),
        )
    )
    # The pair that must never be conflated: the lock CAN be applied and be ineffective.
    effective = command.get("lockdown_effective")
    result.checks.append(
        check(
            "lockdown effective (not just applied)",
            effective if isinstance(effective, bool) else None,
            f"lockdown_effective={effective} boot_lock_status={command.get('boot_lock_status')}",
        )
    )
    blocked = command.get("encryption_blocked_files")
    result.checks.append(
        check(
            "no files left unencrypted",
            None if blocked is None else len(blocked) == 0,
            blocked,
        )
    )
    return result


def evaluate_recover(
    device: dict | None, snap: dict, command: dict | None
) -> StepResult:
    result = StepResult("recover")
    result.checks.append(
        check(
            "lock sentinel gone",
            not snap.get("lock_sentinel"),
            snap.get("lock_sentinel"),
        )
    )

    enc_files, plain_files = lockdown_folder_state(snap)
    result.checks.append(
        check(
            "lockdown folder decrypted",
            enc_files == 0,
            f"{enc_files} .enc file(s) left, {plain_files} plaintext",
        )
    )

    # Recovery must hand the account back even when decryption is what failed.
    disabled, disabled_detail = account_state(snap)
    result.checks.append(
        check(
            f"account re-enabled ({snap.get('real_user') or 'no interactive user'})",
            None if disabled is None else disabled is False,
            disabled_detail,
        )
    )

    status = (device or {}).get("status")
    result.checks.append(
        check(
            "server reports the device usable", status in ("active", "locked"), status
        )
    )
    if command is None:
        result.checks.append(
            check("unlock command executed", None, "no unlock command on record")
        )
    else:
        result.checks.append(
            check(
                "unlock command executed",
                command.get("status") == "executed",
                command.get("status"),
            )
        )
    return result


def evaluate_track(device: dict | None, snap: dict, command: dict | None) -> StepResult:
    """The step that produced three of the five live defects."""
    result = StepResult("track")
    state = snap.get("tracking_state") or {}
    applied = state.get("applied") or []

    # Observed on the machine, not taken from the agent's state file:
    result.checks.append(
        check(
            "decoy account exists",
            snap.get("decoy_exists"),
            f"{snap.get('decoy_name')}={snap.get('decoy_exists')}",
        )
    )
    result.checks.append(
        check(
            "real user disabled",
            snap.get("real_user_active") is False,
            f"active={snap.get('real_user_active')}",
        )
    )

    # Profile EFS cannot work from the service context without a Data Recovery Agent
    # (measured on MOLE, S271: `cipher /e` on another user's file returns [ERR]). The
    # product now DECLARES that instead of failing every run, so what is asserted is the
    # honesty of the claim: declared, and never reported as applied.
    unsupported = [str(u) for u in (state.get("unsupported") or [])]
    result.checks.append(
        check(
            "profile EFS declared unsupported (not silently skipped)",
            any(u.startswith("efs_profile") for u in unsupported),
            unsupported or "not declared",
        )
    )
    result.checks.append(
        check(
            "profile EFS not falsely claimed as applied",
            "efs_encrypt" not in applied,
            f"applied={applied}",
        )
    )

    # The state file may claim a layer that the machine does not show. That mismatch is
    # the defect itself (S269), so it is a check, not a footnote.
    claims = {
        "enable_decoy": snap.get("decoy_exists"),
        "create_decoy": snap.get("decoy_exists"),
        "disable_real_user": snap.get("real_user_active") is False,
        # `efs_encrypt` is deliberately absent: the layer is unsupported, so a claim of it is
        # handled by the dedicated "not falsely claimed" check above rather than measured
        # against folders that should never carry the attribute.
    }
    for claimed in applied:
        if claimed in claims:
            result.checks.append(
                check(
                    f"state file claim '{claimed}' corroborated",
                    bool(claims[claimed]),
                    f"claimed applied, machine says {claims[claimed]}",
                )
            )

    status = (device or {}).get("status")
    result.checks.append(check("server reports tracking", status == "tracking", status))
    if command is not None:
        result.checks.append(
            check(
                "track command executed",
                command.get("status") == "executed",
                command.get("status"),
            )
        )
    return result


def evaluate_stop_track(
    device: dict | None, snap: dict, command: dict | None
) -> StepResult:
    result = StepResult("stop-track")
    # Tracking releases ITS reason. If a lockdown still holds the account — the harness
    # re-locks to make tracking legal in the first place — staying disabled is correct,
    # and asserting "re-enabled" would demand the interlock be broken.
    disabled, disabled_detail = account_state(snap)
    holds = [h for h in (snap.get("logon_holds") or []) if isinstance(h, str)]
    if disabled is None:
        result.checks.append(
            check("account state after stop-track", None, disabled_detail)
        )
    elif holds:
        result.checks.append(
            check(
                f"account still held by {','.join(sorted(holds))} (correct while locked)",
                disabled is True,
                f"{disabled_detail}; holds={sorted(holds)}",
            )
        )
    else:
        result.checks.append(
            check("real user re-enabled", disabled is False, disabled_detail)
        )
    result.checks.append(
        check(
            "decoy account removed",
            snap.get("decoy_exists") is False,
            f"exists={snap.get('decoy_exists')}",
        )
    )
    status = (device or {}).get("status")
    result.checks.append(
        check("server no longer reports tracking", status != "tracking", status)
    )
    if command is not None:
        result.checks.append(
            check(
                "stop_track command executed",
                command.get("status") == "executed",
                command.get("status"),
            )
        )
    return result


EVALUATORS = {
    "enroll": evaluate_enroll,
    "lock": evaluate_lock,
    "recover": evaluate_recover,
    "track": evaluate_track,
    "stop-track": evaluate_stop_track,
}

# The device status each step is supposed to reach. `recover` returns to `active`, so a
# "changed from active" predicate would wait out the timeout on a successful recovery.
EXPECTED_STATUS = {
    "lock": ("locked", "recovering"),
    "recover": ("active",),
    "track": ("tracking",),
    "stop-track": ("active", "locked"),
}

# Which command type each step's server-side evidence lives on.
COMMAND_FOR_STEP = {
    "lock": "lockdown",
    "recover": "unlock",
    "track": "track",
    "stop-track": "stop_track",
}


def latest_command(commands: list[dict], command_type: str) -> dict | None:
    """Newest command of `command_type`, or None. A missing record is not a pass."""
    matching = [c for c in commands if c.get("command_type") == command_type]
    if not matching:
        return None
    matching.sort(key=lambda c: str(c.get("created_at", "")), reverse=True)
    return matching[0]


def evaluate_step(
    step: str,
    device: dict | None,
    snap: dict,
    commands: list[dict],
    now: datetime,
    expected_hostname: str | None = None,
) -> StepResult:
    """Evaluate one step from already-fetched evidence (no IO)."""
    if step == "enroll":
        return evaluate_enroll(device, snap, now, expected_hostname)
    command = latest_command(commands, COMMAND_FOR_STEP[step])
    return EVALUATORS[step](device, snap, command)  # type: ignore[operator]


# ---------------------------------------------------------------------------
# Rendering
# ---------------------------------------------------------------------------


def render(results: list[StepResult]) -> str:
    lines: list[str] = []
    marks = {"PASS": "PASS", "FAIL": "FAIL", "SKIP": "SKIP"}
    for result in results:
        lines.append(f"[{marks[result.status]}] {result.step}")
        for c in result.checks:
            flag = {True: "  ok  ", False: " FAIL ", None: " skip "}[c.passed]
            lines.append(f"  {flag} {c.name}: {c.observed}")
        if result.note:
            lines.append(f"         note: {result.note}")
    passed = sum(1 for r in results if r.status == "PASS")
    failed = sum(1 for r in results if r.status == "FAIL")
    skipped = sum(1 for r in results if r.status == "SKIP")
    lines.append("")
    lines.append(f"{passed} passed, {failed} failed, {skipped} skipped")
    return "\n".join(lines)


def artifact(results: list[StepResult], snapshot: dict, extra: dict) -> dict:
    return {
        "generated_at": datetime.now(UTC).isoformat(),
        "steps": [
            {
                "step": r.step,
                "status": r.status,
                "checks": [
                    {"name": c.name, "passed": c.passed, "observed": c.observed}
                    for c in r.checks
                ],
            }
            for r in results
        ],
        "snapshot": snapshot,
        **extra,
    }


# ---------------------------------------------------------------------------
# IO: the network, the machine, and nothing else
# ---------------------------------------------------------------------------


class Server:
    """The Worker/Express API. Every call returns parsed JSON or raises ApiError.

    The base URL is audited at construction: `urllib` will happily open `file://` and
    other schemes, and an operator-supplied `--server-url` is not a trusted input just
    because a human typed it (same reasoning, and the same fix, as
    `scripts/hw-window-preflight.py`).
    """

    ALLOWED_SCHEMES = ("http", "https")

    def __init__(self, base_url: str, token: str, timeout: float = 15.0):
        scheme = urllib.parse.urlsplit(base_url).scheme.lower()
        if scheme not in self.ALLOWED_SCHEMES:
            raise ApiError(
                f"refusing {scheme or 'absent'} scheme in --server-url — this tool only "
                "fetches http(s)"
            )
        self.base_url = base_url.rstrip("/")
        self.token = token
        self.timeout = timeout

    def _request(self, method: str, path: str, body: dict | None = None) -> object:
        data = json.dumps(body).encode() if body is not None else None
        # S310 is satisfied at runtime by the scheme allowlist in __init__: a `file:` or
        # custom scheme cannot reach this line.
        request = urllib.request.Request(  # noqa: S310
            f"{self.base_url}{path}", data=data, method=method
        )
        request.add_header("Authorization", f"Bearer {self.token}")
        if data is not None:
            request.add_header("Content-Type", "application/json")
        try:
            # S310 is satisfied at runtime by the scheme allowlist in __init__: a
            # `file:`/custom scheme cannot reach this line.
            with urllib.request.urlopen(request, timeout=self.timeout) as response:  # noqa: S310
                payload = response.read().decode("utf-8", errors="replace")
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")[:300]
            raise ApiError(f"{method} {path} -> HTTP {exc.code}: {detail}") from exc
        except (urllib.error.URLError, OSError) as exc:
            raise ApiError(f"{method} {path} -> {exc}") from exc
        if not payload:
            return None
        try:
            return json.loads(payload)
        except json.JSONDecodeError as exc:
            raise ApiError(
                f"{method} {path} returned non-JSON: {payload[:120]}"
            ) from exc

    def get(self, path: str, attempts: int = 3) -> object:
        """GET with a short retry, because the dev server restarts under you.

        `wrangler dev` restarts on file changes and on some KV writes; a run that dies on
        its first read with "Connection refused" costs the entire destructive cycle it was
        about to drive (observed, S270). Only GETs are retried: a POST that queues a
        command must never be replayed, because a duplicated lockdown is worse than a
        failed run.
        """
        last: ApiError | None = None
        for attempt in range(attempts):
            try:
                return self._request("GET", path)
            except ApiError as exc:
                last = exc
                if "Connection refused" not in str(exc) or attempt == attempts - 1:
                    raise
                time.sleep(2.0)
        # `assert` disappears under `python -O`; a retry loop that runs out must say so.
        raise (
            last
            if last is not None
            else ApiError(f"GET {path} failed without an error")
        )

    def post(self, path: str, body: dict | None = None) -> object:
        return self._request("POST", path, body if body is not None else {})

    def device_by_hostname(self, hostname: str) -> dict | None:
        devices = self.get("/api/devices")
        if not isinstance(devices, list):
            # Not an internal invariant: a wrong shape here is the server breaking the
            # documented contract, and `assert` disappears under `python -O`.
            raise ApiError(
                f"GET /api/devices returned {type(devices).__name__}, expected a list"
            )
        for device in devices:
            if str(device.get("hostname", "")).upper() == hostname.upper():
                return device
        return None

    def device(self, device_id: str) -> dict:
        found = self.get(f"/api/devices/{device_id}")
        if not isinstance(found, dict):
            raise ApiError(
                f"GET /api/devices/{device_id} returned {type(found).__name__}, expected an object"
            )
        return found

    def commands(self, device_id: str, limit: int = 20) -> list[dict]:
        """The command ledger — the only way an ACK's evidence is readable."""
        found = self.get(f"/api/devices/{device_id}/commands?limit={limit}")
        return found if isinstance(found, list) else []


class ApiError(RuntimeError):
    pass


class Target:
    """The Windows machine, over SSH. Credentials come from the environment."""

    def __init__(
        self,
        host: str | None = None,
        user: str | None = None,
        key: str | None = None,
        port: str = "22",
        timeout: float = 120.0,
    ):
        self.host = host or os.environ.get("RLS_SSH_HOST", "")
        self.user = user or os.environ.get("RLS_SSH_USER", "")
        self.key = key or os.environ.get("RLS_SSH_KEY", "")
        self.port = port or os.environ.get("RLS_SSH_PORT", "22")
        self.timeout = timeout
        if not self.host or not self.user:
            raise ApiError(
                "RLS_SSH_HOST and RLS_SSH_USER must be set (see scripts/rsh.py)"
            )

    def powershell(self, script: str) -> str:
        """Run a SHORT PowerShell script on the target; return stdout.

        The script arrives on **stdin** (`powershell -Command -`), which avoids every
        layer of shell quoting between here and Windows — the version of this that built
        command lines by string concatenation mangled `$` variables.

        stdin is only for one-liners: with `-Command -` PowerShell executes statement by
        statement, so a multi-line construct (a hashtable, a try block) is a parse error.
        Anything structured goes through :meth:`run_script` instead.
        """
        return self._ssh(
            "powershell -NoProfile -ExecutionPolicy Bypass -Command -",
            input_text=script,
        )

    def run_script(self, script: str, remote_name: str) -> str:
        """Upload a multi-line PowerShell script and run it with `-File`.

        Not `-EncodedCommand`: that base64 is UTF-16LE, so a ~7 KB probe becomes ~19 KB
        and fails with "The command line is too long." (measured on MOLE) — the Windows
        limit is ~8 KB. scp plus `-File` has no limit and keeps PowerShell's normal
        multi-line parsing.
        """
        remote = f"C:/ProgramData/LockdownAgent/{remote_name}"
        with tempfile.NamedTemporaryFile(
            "w", suffix=".ps1", delete=False, encoding="utf-8"
        ) as handle:
            handle.write(script)
            local = handle.name
        try:
            upload = ["scp", "-P", self.port, "-o", "BatchMode=yes"]
            if self.key:
                upload += ["-i", self.key]
            upload += [local, f"{self.user}@{self.host}:{remote}"]
            completed = subprocess.run(
                upload,
                capture_output=True,
                text=True,
                timeout=self.timeout,
                check=False,
            )
            if completed.returncode != 0:
                raise ApiError(
                    f"scp {local} -> {self.host}:{remote} exited {completed.returncode}: "
                    f"{(completed.stderr or completed.stdout).strip()[:300]}"
                )
            return self._ssh(
                f'powershell -NoProfile -ExecutionPolicy Bypass -File "{remote}"'
            )
        finally:
            Path(local).unlink(missing_ok=True)

    def _ssh(self, remote_command: str, input_text: str | None = None) -> str:
        command = ["ssh", "-p", self.port, "-o", "BatchMode=yes"]
        if self.key:
            command += ["-i", self.key]
        command += [f"{self.user}@{self.host}", remote_command]
        try:
            completed = subprocess.run(
                command,
                input=input_text,
                capture_output=True,
                text=True,
                timeout=self.timeout,
                check=False,
            )
        except (OSError, subprocess.SubprocessError) as exc:
            raise ApiError(f"ssh {self.user}@{self.host}: {exc}") from exc
        if completed.returncode != 0:
            raise ApiError(
                f"ssh {self.user}@{self.host} exited {completed.returncode}: "
                f"{(completed.stderr or completed.stdout).strip()[:300]}"
            )
        return completed.stdout

    def probe(self, real_user: str = "") -> dict:
        """Read the machine's state. Changes nothing."""
        script = PROBE_PATH.read_text(encoding="utf-8")
        if real_user:
            script = script.replace("$RealUser = ''", f"$RealUser = '{real_user}'")
        # The probe prints ONE JSON line; anything else on stdout is a runner banner.
        output = self.run_script(script, "acceptance_probe.ps1")
        for line in reversed([ln.strip() for ln in output.splitlines() if ln.strip()]):
            if line.startswith("{") and line.endswith("}"):
                try:
                    parsed = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if isinstance(parsed, dict):
                    return parsed
        raise ApiError(
            f"probe returned no JSON object (stdout: {output.strip()[:300]})"
        )


# ---------------------------------------------------------------------------
# Step actions (what the operator would click, in order)
# ---------------------------------------------------------------------------


# Statuses in which the Worker accepts a `track` (handleTrackAction): a device must already
# be treated as lost before it is put into covert tracking.
TRACKABLE_STATUSES = ("stolen", "locked", "tracking")


def track_needs_relock(step: str, status: str | None) -> bool:
    """True when a `track` step must flag the device stolen again first."""
    return step == "track" and status not in TRACKABLE_STATUSES


def wait_for_command(
    server: Server, device_id: str, command_type: str, timeout: float
) -> dict | None:
    """Wait until the newest command of this type is no longer pending.

    Device status is the WRONG signal for track/stop_track: the Worker flips it when the
    command is QUEUED, so a status-based wait asserts while the agent has not even fetched
    the command — both steps reported `pending` on MOLE (S271).
    """

    def terminal() -> dict | None:
        newest = latest_command(server.commands(device_id), command_type)
        if newest is None or newest.get("status") in (None, "pending"):
            return None
        return newest

    return wait_for(
        terminal, timeout=timeout, interval=5.0, label=f"{command_type} terminal"
    )


def action_payload(step: str, device: dict) -> dict:
    """Body for a step's POST.

    `flag` and `recover` demand the hostname typed back as a confirmation — they are the
    two actions that can lock or unlock a real machine, and the Worker rejects them with
    HTTP 400 otherwise ("Confirmation hostname does not match"). Sending `{}` made the
    harness die on its first destructive step with a server-side 400 (S270).
    """
    if step in ("lock", "recover"):
        return {"hostname_confirm": device.get("hostname", "")}
    return {}


def wait_for(
    predicate, timeout: float, interval: float = 5.0, label: str = "condition"
):
    """Poll `predicate` until truthy. Returns the value, or None on timeout.

    A timeout is not an exception: the caller reports the post-condition as FAIL with
    whatever it last saw, which is the evidence the operator needs.
    """
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        last = predicate()
        if last:
            return last
        time.sleep(interval)
    return last


def action_enroll(
    server: Server, target: Target, hostname: str, one_liner_url: str
) -> str:
    """Enrol the device with the dashboard's own one-liner, non-interactively."""
    token = server.post("/api/enroll/token", {})
    if not isinstance(token, dict):
        raise ApiError(
            f"POST /api/enroll/token returned {type(token).__name__}, expected an object"
        )
    enroll_token = str(token["token"])
    script = (
        f"$env:LOCKDOWN_ENROLL_TOKEN='{enroll_token}'; " f"iex (irm '{one_liner_url}')"
    )
    target.powershell(script)
    return enroll_token


def run(args: argparse.Namespace) -> int:
    now = datetime.now(UTC)

    # --- Replay mode: no network, no SSH, just the stored evidence. ---
    if args.snapshot:
        try:
            snapshot = json.loads(Path(args.snapshot).read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            print(
                f"ERROR: cannot read snapshot {args.snapshot}: {exc}", file=sys.stderr
            )
            return 2
        replay = {k: v for k, v in snapshot.items() if k != "steps"}
        device = replay.get("device")
        commands = replay.get("commands") or []
        steps = args.step or list(STEPS)
        results = [
            evaluate_step(
                step, device, replay.get("probe") or {}, commands, now, args.device
            )
            for step in steps
        ]
        print(render(results))
        return 0 if all(r.status != "FAIL" for r in results) else 1

    try:
        server = Server(args.server_url, os.environ.get(args.admin_token_env, ""))
        target = Target()
    except ApiError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2

    if not os.environ.get(args.admin_token_env):
        print(f"ERROR: {args.admin_token_env} is not set", file=sys.stderr)
        return 2

    destructive = {"track", "lock"}
    steps = args.step or list(STEPS)
    if not args.allow_destructive:
        blocked = [s for s in steps if s in destructive]
        if blocked and not args.dry_run:
            print(
                f"ERROR: {', '.join(blocked)} is destructive (it disables the signed-in "
                "account and encrypts its profile). Re-run with --allow-destructive, "
                "or use --dry-run to only observe.",
                file=sys.stderr,
            )
            return 2

    results: list[StepResult] = []
    device = server.device_by_hostname(args.device) if args.device else None

    for step in steps:
        if not args.dry_run and step != "enroll":
            if device is None:
                results.append(
                    StepResult(step, [check("device exists", False, "not enrolled")])
                )
                continue
            # `track` is only accepted on a device already in a stolen/locked posture, and
            # rightly so: it disables the signed-in account. After `recover` the device is
            # active, so an operator re-locks it first — the harness does the same rather
            # than posting a command the server will (correctly) refuse.
            if track_needs_relock(step, device.get("status")):
                server.post(
                    f"/api/devices/{device['id']}/flag",
                    {"hostname_confirm": device.get("hostname", "")},
                )
                wait_for(
                    lambda: (server.device_by_hostname(args.device) or {}).get("status")
                    in ("locked", "recovering"),
                    timeout=args.timeout,
                    interval=5.0,
                    label="relock before track",
                )
                device = server.device_by_hostname(args.device) or device

            endpoint = {
                "lock": f"/api/devices/{device['id']}/flag",
                "recover": f"/api/devices/{device['id']}/recover",
                "track": f"/api/devices/{device['id']}/track",
                "stop-track": f"/api/devices/{device['id']}/stop-track",
            }[step]
            server.post(endpoint, action_payload(step, device))
            # Wait for the status THIS step should produce, not just "changed from active":
            # a recover moves recovering -> active, so a "not active" predicate waits out
            # the whole timeout on a perfectly good recovery. The work itself is slow
            # (boot-lock layers, EFS on three folders, ~7 s per HP BIOS call).
            # The command itself must reach a terminal state before anything is asserted.
            command_type = COMMAND_FOR_STEP.get(step)
            if command_type:
                wait_for_command(server, device["id"], command_type, args.timeout)

            expected = EXPECTED_STATUS[step]
            # Bound as a default argument: B023 is right that a bare closure over a loop
            # variable reads whatever the LAST iteration assigned, which would make this
            # wait match the wrong step as soon as the loop is ever reused.
            wait_for(
                lambda exp=expected: (server.device_by_hostname(args.device) or {}).get(
                    "status"
                )
                in exp,
                timeout=args.timeout,
                interval=5.0,
                label=f"status in {sorted(expected)}",
            )
        elif not args.dry_run and step == "enroll":
            server_url = args.server_url.rstrip("/")
            action_enroll(
                server, target, args.device or "", f"{server_url}/api/enroll/setup.ps1"
            )
            wait_for(
                lambda: server.device_by_hostname(args.device or ""),
                timeout=args.timeout,
            )

        device = server.device_by_hostname(args.device) if args.device else None
        snapshot = target.probe()
        commands = server.commands(device["id"]) if device else []
        result = evaluate_step(
            step, device, snapshot, commands, datetime.now(UTC), args.device
        )
        results.append(result)

    report = artifact(
        results, {}, {"device": args.device, "server_url": args.server_url}
    )
    if args.artifact:
        Path(args.artifact).parent.mkdir(parents=True, exist_ok=True)
        Path(args.artifact).write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(render(results))
    if args.artifact:
        print(f"artifact: {args.artifact}")
    return 0 if all(r.status != "FAIL" for r in results) else 1


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--server-url", help="Worker/Express base URL")
    parser.add_argument("--device", help="target hostname, as enrolled")
    parser.add_argument(
        "--step",
        action="append",
        choices=STEPS,
        help="step to run (repeatable; default: every step in lifecycle order)",
    )
    parser.add_argument(
        "--admin-token-env", default="ADMIN_TOKEN", help="env var holding the admin JWT"
    )
    parser.add_argument(
        "--timeout", type=float, default=600.0, help="seconds to wait per step"
    )
    parser.add_argument("--artifact", help="write the JSON report here")
    parser.add_argument(
        "--snapshot", help="re-derive the report from a stored snapshot (no IO)"
    )
    parser.add_argument(
        "--dry-run", action="store_true", help="observe and assert, run no actions"
    )
    parser.add_argument(
        "--allow-destructive",
        action="store_true",
        help="permit lock/track, which change the machine's security posture",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if not args.snapshot and not args.server_url:
        print(
            "ERROR: --server-url is required (or --snapshot to replay)", file=sys.stderr
        )
        return 2
    return run(args)


if __name__ == "__main__":
    raise SystemExit(main())
