"""Tests for scripts/acceptance_lifecycle.py.

The acceptance run exists because five defects survived a green unit suite (S269-S270),
and every one was a disagreement between what the agent *reported* and what the machine
*was*. So what is pinned here is the reporting discipline, not the plumbing:

  * a post-condition that cannot be observed is SKIP, never PASS — "no command record" and
    "command executed" must not render the same way;
  * `lock` reports `lockdown_effective: false` as its OWN failed check. A locked device
    whose boot layer rolled back is the dangerous case, and it must not disappear behind
    the word "locked";
  * `track` corroborates the agent's own state file against the machine. The S269 defect
    was `tracking_state.json` recording `decoy_account: GuestUser` on a machine where
    `Get-LocalUser GuestUser` said no such account — that mismatch is a failing check;
  * the harness refuses a non-http(s) `--server-url` before opening anything, and a step
    timeout is reported with the observation, not as a traceback.
"""

import importlib
import importlib.util
import sys
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

pytest: Any = importlib.import_module("pytest")

SCRIPT = Path(__file__).resolve().parent / "acceptance_lifecycle.py"
NOW = datetime(2026, 11, 17, 12, 0, 0, tzinfo=UTC)


def load_module():
    spec = importlib.util.spec_from_file_location("acceptance_lifecycle", SCRIPT)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    # Registered before exec: `@dataclass` resolves `cls.__module__` through sys.modules,
    # and a module that is not registered there comes back as None (a confusing
    # 'NoneType has no attribute __dict__').
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


mod = load_module()


def snapshot(**overrides) -> dict:
    """A healthy enrolled machine, in the shape acceptance_probe.ps1 emits."""
    base = {
        "hostname": "MOLE",
        "service": "Running",
        "config_parses": True,
        "config_device_id": "dev-1",
        "config_server_url": "http://192.0.2.20:8787",
        "poll_interval": 30,
        "verify_tls": False,
        "lock_sentinel": False,
        "lockdown_files": 3,
        "lockdown_encrypted": 0,
        "real_user": "labadmin",
        "real_user_active": True,
        "decoy_name": "GuestUser",
        "decoy_exists": False,
        "decoy_active": None,
        "efs_paths": [],
        "tracking_state": None,
        "agent_binary_sha256": "A" * 64,
        "installer_runs": [],
    }
    base.update(overrides)
    return base


def device(**overrides) -> dict:
    base = {
        "id": "dev-1",
        "hostname": "MOLE",
        "status": "active",
        "last_checkin": (NOW - timedelta(seconds=20))
        .isoformat()
        .replace("+00:00", "Z"),
        "agent_version": "1.0.0",
    }
    base.update(overrides)
    return base


def command(**overrides) -> dict:
    base = {
        "id": "cmd-1",
        "device_id": "dev-1",
        "command_type": "lockdown",
        "status": "executed",
        "created_at": "2026-11-17T11:00:00Z",
        "executed_at": "2026-11-17T11:00:04Z",
        "lockdown_effective": True,
        "boot_lock_status": "success",
        "encryption_blocked_files": [],
    }
    base.update(overrides)
    return base


def by_name(result, name_prefix: str):
    return next(c for c in result.checks if c.name.startswith(name_prefix))


# ---------------------------------------------------------------------------
# Evidence with no observation is not a pass
# ---------------------------------------------------------------------------


class TestUnobservableIsNotPass:
    def test_enroll_skips_when_the_server_never_recorded_a_checkin(self):
        result = mod.evaluate_enroll(device(last_checkin=None), snapshot(), NOW)
        check = by_name(result, "agent checked in")
        assert check.passed is None
        assert "absent" in check.observed
        # "no data" must not be reported as "offline" — that is the same conflation of
        # unknown with a known-bad state that the status derivation question turns on.
        assert result.status == "SKIP"

    def test_lock_skips_when_no_command_record_exists(self):
        result = mod.evaluate_lock(
            device(status="locked"),
            snapshot(lock_sentinel=True, lockdown_encrypted=3),
            None,
        )
        assert by_name(result, "lockdown command executed").passed is None
        assert result.status == "SKIP"

    def test_skip_beats_pass_and_fail_beats_skip(self):
        assert mod.StepResult("x", [mod.check("a", True, 1)]).status == "PASS"
        assert (
            mod.StepResult(
                "x", [mod.check("a", True, 1), mod.check("b", None, "n/a")]
            ).status
            == "SKIP"
        )
        assert (
            mod.StepResult(
                "x",
                [
                    mod.check("a", None, "n/a"),
                    mod.check("b", False, 0),
                    mod.check("c", True, 1),
                ],
            ).status
            == "FAIL"
        )

    def test_an_empty_result_is_not_a_pass(self):
        # A step that observes nothing has not passed; it has not run.
        assert mod.StepResult("x", []).status == "SKIP"


# ---------------------------------------------------------------------------
# lock: "locked" and "effective" are two facts
# ---------------------------------------------------------------------------


class TestLock:
    def test_a_complete_lock_passes(self):
        result = mod.evaluate_lock(
            device(status="locked"),
            snapshot(lock_sentinel=True, lockdown_encrypted=3),
            command(lockdown_effective=True),
        )
        assert result.status == "PASS", result.checks

    def test_an_ineffective_lock_fails_on_its_own_check(self):
        """The exact MOLE state: encrypted, sentinel present, ACK says not effective."""
        result = mod.evaluate_lock(
            device(status="locked"),
            snapshot(lock_sentinel=True, lockdown_encrypted=3),
            command(lockdown_effective=False, boot_lock_status="partial"),
        )
        assert result.status == "FAIL"
        effective = by_name(result, "lockdown effective")
        assert effective.passed is False
        assert "boot_lock_status=partial" in effective.observed
        # Everything else about the lock is true, and stays reported as true.
        assert by_name(result, "lock sentinel present").passed is True

    def test_files_the_agent_could_not_encrypt_fail_the_step(self):
        result = mod.evaluate_lock(
            device(status="locked"),
            snapshot(lock_sentinel=True, lockdown_encrypted=3),
            command(encryption_blocked_files=["C:/Users/lab/Documents/secret.txt"]),
        )
        assert by_name(result, "no files left unencrypted").passed is False
        assert result.status == "FAIL"

    def test_the_folder_must_actually_hold_encrypted_files(self):
        result = mod.evaluate_lock(
            device(status="locked"),
            snapshot(lock_sentinel=True, lockdown_encrypted=0),
            command(),
        )
        assert by_name(result, "lockdown folder encrypted").passed is False


# ---------------------------------------------------------------------------
# track: the state file is a claim, the machine is the observation
# ---------------------------------------------------------------------------


class TestTrack:
    def tracking_snapshot(self, **overrides):
        base = {
            "real_user_active": False,
            "decoy_exists": True,
            "decoy_active": True,
            "efs_paths": [
                {"path": "C:/Users/labadmin/Documents", "encrypted": 4},
                {"path": "C:/Users/labadmin/Downloads", "encrypted": 2},
            ],
            "tracking_state": {
                "applied": ["efs_encrypt", "disable_real_user", "create_decoy"]
            },
        }
        base.update(overrides)
        return snapshot(**base)

    def track_command(self):
        return command(
            command_type="track", lockdown_effective=None, boot_lock_status=None
        )

    def test_a_verified_tracking_cycle_passes(self):
        result = mod.evaluate_track(
            device(status="tracking"), self.tracking_snapshot(), self.track_command()
        )
        assert result.status == "PASS", result.checks

    def test_a_recorded_decoy_that_does_not_exist_fails(self):
        """S269: tracking_state.json said GuestUser existed; Get-LocalUser said it did not."""
        result = mod.evaluate_track(
            device(status="tracking"),
            self.tracking_snapshot(decoy_exists=False, decoy_active=None),
            self.track_command(),
        )
        assert result.status == "FAIL"
        assert by_name(result, "decoy account exists").passed is False
        claim = by_name(result, "state file claim 'create_decoy'")
        assert claim.passed is False
        assert "machine says False" in claim.observed

    def test_efs_that_did_not_apply_fails_even_when_the_state_file_says_it_did(self):
        result = mod.evaluate_track(
            device(status="tracking"),
            self.tracking_snapshot(
                efs_paths=[
                    {"path": "C:/Users/labadmin/Documents", "encrypted": 0},
                    {"path": "C:/Users/labadmin/Downloads", "encrypted": 0},
                ],
            ),
            self.track_command(),
        )
        assert (
            by_name(result, "EFS applied to at least one profile folder").passed
            is False
        )
        assert by_name(result, "state file claim 'efs_encrypt'").passed is False

    def test_an_enabled_account_fails_the_disable_layer(self):
        result = mod.evaluate_track(
            device(status="tracking"),
            self.tracking_snapshot(real_user_active=True),
            self.track_command(),
        )
        assert by_name(result, "real user disabled").passed is False

    def test_a_track_command_that_is_still_pending_is_reported(self):
        result = mod.evaluate_track(
            device(status="tracking"),
            self.tracking_snapshot(),
            self.track_command() | {"status": "pending"},
        )
        assert by_name(result, "track command executed").passed is False


# ---------------------------------------------------------------------------
# enroll / recover / stop-track
# ---------------------------------------------------------------------------


class TestEnrollAndRecovery:
    def test_a_healthy_enrolment_passes(self):
        result = mod.evaluate_enroll(
            device(), snapshot(), NOW, expected_hostname="MOLE"
        )
        assert result.status == "PASS", result.checks

    def test_a_stopped_service_fails_and_names_the_condition(self):
        result = mod.evaluate_enroll(device(), snapshot(service="Stopped"), NOW)
        assert result.status == "FAIL"
        assert by_name(result, "service Running").observed == "Stopped"

    def test_a_config_id_that_differs_from_the_server_record_fails(self):
        # The machine checking in as somebody else is exactly the split this catches.
        result = mod.evaluate_enroll(device(), snapshot(config_device_id="dev-2"), NOW)
        assert by_name(result, "config device_id matches the server").passed is False

    def test_a_device_the_server_does_not_know_fails(self):
        result = mod.evaluate_enroll(None, snapshot(), NOW)
        assert by_name(result, "device enrolled on the server").passed is False

    def test_a_healthy_device_on_a_slow_adaptive_interval_passes(self):
        """MOLE reported poll_interval 30 in its config while the server told it 300.

        A 2-interval limit therefore failed a device that was checking in every five
        minutes exactly as instructed (measured: 137s old, limit 60s, S270). The floor is
        what keeps the harness from inventing failures out of a correct configuration.
        """
        slow = device(
            last_checkin=(NOW - timedelta(seconds=137))
            .isoformat()
            .replace("+00:00", "Z")
        )
        result = mod.evaluate_enroll(slow, snapshot(poll_interval=30), NOW)
        assert by_name(result, "agent checked in").passed is True
        assert "limit 300s" in by_name(result, "agent checked in").observed

    def test_the_floor_does_not_hide_a_device_that_stopped_talking(self):
        # 300 s of floor, not "any age passes": a wedged agent (12 hours on MOLE) fails.
        dead = device(
            last_checkin=(NOW - timedelta(hours=12)).isoformat().replace("+00:00", "Z")
        )
        result = mod.evaluate_enroll(dead, snapshot(poll_interval=30), NOW)
        assert by_name(result, "agent checked in").passed is False

    def test_a_stale_checkin_fails(self):
        stale = device(
            last_checkin=(NOW - timedelta(minutes=30))
            .isoformat()
            .replace("+00:00", "Z")
        )
        result = mod.evaluate_enroll(stale, snapshot(poll_interval=30), NOW)
        assert by_name(result, "agent checked in").passed is False

    def test_recovery_requires_the_sentinel_to_be_gone_and_files_decrypted(self):
        unlock = command(
            command_type="unlock", lockdown_effective=None, boot_lock_status=None
        )
        result = mod.evaluate_recover(
            device(), snapshot(lock_sentinel=False, lockdown_encrypted=0), unlock
        )
        assert result.status == "PASS", result.checks

        still_locked = mod.evaluate_recover(
            device(), snapshot(lock_sentinel=True, lockdown_encrypted=3), unlock
        )
        assert still_locked.status == "FAIL"

    def test_stop_track_requires_the_account_back_and_the_decoy_gone(self):
        stop = command(
            command_type="stop_track", lockdown_effective=None, boot_lock_status=None
        )
        result = mod.evaluate_stop_track(
            device(), snapshot(real_user_active=True, decoy_exists=False), stop
        )
        assert result.status == "PASS", result.checks


# ---------------------------------------------------------------------------
# Command selection and rendering
# ---------------------------------------------------------------------------


class TestCommandSelection:
    def test_the_newest_command_of_the_requested_type_is_used(self):
        commands = [
            {
                "command_type": "lockdown",
                "created_at": "2026-11-17T10:00:00Z",
                "status": "failed",
            },
            {
                "command_type": "lockdown",
                "created_at": "2026-11-17T11:00:00Z",
                "status": "executed",
            },
            {
                "command_type": "unlock",
                "created_at": "2026-11-17T12:00:00Z",
                "status": "pending",
            },
        ]
        latest = mod.latest_command(commands, "lockdown")
        assert latest is not None and latest["status"] == "executed"

    def test_a_missing_type_is_none_not_an_empty_success(self):
        assert mod.latest_command([{"command_type": "unlock"}], "lockdown") is None

    def test_evaluate_step_routes_lock_to_the_lockdown_command(self):
        commands = [command()]
        result = mod.evaluate_step(
            "lock",
            device(status="locked"),
            snapshot(lock_sentinel=True, lockdown_encrypted=2),
            commands,
            NOW,
        )
        assert by_name(result, "lockdown command executed").passed is True


class TestRendering:
    def test_the_report_shows_every_post_condition_with_its_observation(self):
        results = [
            mod.evaluate_enroll(device(), snapshot(), NOW),
            mod.evaluate_lock(
                device(status="locked"),
                snapshot(lock_sentinel=True, lockdown_encrypted=3),
                command(lockdown_effective=False, boot_lock_status="partial"),
            ),
        ]
        text = mod.render(results)
        assert "[PASS] enroll" in text
        assert "[FAIL] lock" in text
        assert "lockdown effective (not just applied)" in text
        assert "1 passed, 1 failed, 0 skipped" in text

    def test_a_skipped_step_is_counted_as_skipped(self):
        # Everything observable says the lock is applied; only the command record is
        # missing, so the step is SKIP — not PASS (nothing proved the ACK) and not FAIL.
        results = [
            mod.evaluate_lock(
                device(status="locked"),
                snapshot(lock_sentinel=True, lockdown_encrypted=3),
                None,
            )
        ]
        text = mod.render(results)
        assert "[SKIP] lock" in text
        assert "0 passed, 0 failed, 1 skipped" in text

    def test_the_artifact_keeps_the_observation_not_just_the_verdict(self):
        results = [
            mod.evaluate_lock(
                device(status="locked"),
                snapshot(lock_sentinel=True, lockdown_encrypted=3),
                command(lockdown_effective=False, boot_lock_status="partial"),
            )
        ]
        payload = mod.artifact(results, {"service": "Running"}, {"device": "MOLE"})
        step = payload["steps"][0]
        assert step["status"] == "FAIL"
        effective = next(
            c for c in step["checks"] if c["name"].startswith("lockdown effective")
        )
        assert effective["passed"] is False
        assert "partial" in effective["observed"]


# ---------------------------------------------------------------------------
# The IO edge: refuse a URL scheme that is not http(s)
# ---------------------------------------------------------------------------


class TestServerGuard:
    @pytest.mark.parametrize(
        "url", ["file:///etc/passwd", "ftp://example.com", "gopher://host"]
    )
    def test_a_non_http_scheme_is_refused_before_anything_is_opened(self, url):
        with pytest.raises(mod.ApiError):
            mod.Server(url, "token")

    def test_https_and_plain_http_are_accepted(self):
        # Plain HTTP is the documented lab deployment (AGENTS.md), so refusing it here
        # would make the harness unusable exactly where it is used.
        mod.Server("http://192.0.2.20:8787", "token")
        mod.Server("https://lockdown.example.com", "token")


if __name__ == "__main__":
    from script_test_runner import run

    raise SystemExit(run(__file__))


class TestActionPayload:
    """The body each step posts — pinned because a 400 is discovered only on a real device.

    `flag` and `recover` require the hostname typed back (the Worker rejects with
    "Confirmation hostname does not match" otherwise), and the first destructive run of
    this harness died on exactly that (S270).
    """

    def test_lock_and_recover_send_the_hostname_confirmation(self):
        dev = {"hostname": "MOLE"}
        assert mod.action_payload("lock", dev) == {"hostname_confirm": "MOLE"}
        assert mod.action_payload("recover", dev) == {"hostname_confirm": "MOLE"}

    def test_tracking_needs_no_confirmation(self):
        dev = {"hostname": "MOLE"}
        assert mod.action_payload("track", dev) == {}
        assert mod.action_payload("stop-track", dev) == {}
