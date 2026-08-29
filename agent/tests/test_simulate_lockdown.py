"""Tests for the boot lockdown end-to-end simulation module (agent/simulate_lockdown.py).

Covers:
  - SimulatedServer: device registration, flag stolen, recover, checkin, ACK,
    key/password storage
  - SimulatedAgent: checkin, ACK, lockdown flow, unlock flow, poll_and_execute
  - simulate_reboot(): dry-run boot path verification
  - run_simulation(): full end-to-end lockdown → recovery cycle

The simulate_lockdown module sets dry_run=True on bcd_lockdown and
hp_uefi_lockdown at import time. A module-scoped fixture restores the
original dry_run state after all tests in this file complete.
"""

import copy
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))

# Save dry_run state BEFORE importing simulate_lockdown (which sets it True)
import bcd_lockdown  # noqa: E402
import hp_uefi_lockdown  # noqa: E402

# Capture the ORIGINAL defaults from the module source (not the current
# state, which may have been modified by other test modules that ran first).
_DEFAULT_BCD_STATE = {
    "bootmenupolicy": "Legacy",
    "displaybootmenu": "Yes",
    "bootstatuspolicy": "DisplayAllFailures",
    "recoveryenabled": "Yes",
    "nointegritychecks": "No",
    "allowprereleasesignatures": "No",
    "timeout": "30",
}
_DEFAULT_BIOS_STATE = {
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
    "Secure Boot": "Enable",
    "SecureBoot": "Enable",
    "Configure Legacy Support and Secure Boot": "Secure Boot",
    "VT-d": "Enable",
    "Intel VT-d": "Enable",
    "Virtualization Technology for Directed I/O": "Enable",
    "DMA Protection": "Enable",
    "Sure Start BIOS Settings Protection": "Disable",
}
_DEFAULT_WINRE_ENABLED = True

_saved_bcd_dry_run = bcd_lockdown._DRY_RUN
_saved_hp_dry_run = hp_uefi_lockdown._DRY_RUN

# Importing simulate_lockdown sets dry_run=True on both modules as a side
# effect. We immediately restore the original state so other test modules
# (test_boot_lockdown_bcd, test_boot_lockdown_uefi, etc.) are not affected.
import simulate_lockdown  # noqa: E402

bcd_lockdown.set_dry_run(_saved_bcd_dry_run)
hp_uefi_lockdown.set_dry_run(_saved_hp_dry_run)


def _reset_dry_run_state():
    """Reset dry-run in-memory state to known defaults."""
    bcd_lockdown._DRY_RUN_BCD_STATE = copy.deepcopy(_DEFAULT_BCD_STATE)
    hp_uefi_lockdown._DRY_RUN_BIOS_STATE = copy.deepcopy(_DEFAULT_BIOS_STATE)
    bcd_lockdown._DRY_RUN_WINRE_ENABLED = _DEFAULT_WINRE_ENABLED


# ---------------------------------------------------------------------------
# Module-scoped fixture: restore dry_run state after all tests
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True, scope="module")
def _restore_dry_run_state():
    """Restore dry_run flags and in-memory state after all tests in this module."""
    yield
    bcd_lockdown.set_dry_run(_saved_bcd_dry_run)
    hp_uefi_lockdown.set_dry_run(_saved_hp_dry_run)
    _reset_dry_run_state()


@pytest.fixture(autouse=True)
def _enable_dry_run_for_test():
    """Enable dry_run for each test and restore in-memory state after.

    simulate_lockdown.py requires dry_run=True to function. We enable it
    per-test and restore the original state after, so other test modules
    are not affected.
    """
    bcd_lockdown.set_dry_run(True)
    hp_uefi_lockdown.set_dry_run(True)
    _reset_dry_run_state()
    yield
    bcd_lockdown.set_dry_run(_saved_bcd_dry_run)
    hp_uefi_lockdown.set_dry_run(_saved_hp_dry_run)
    _reset_dry_run_state()


# ---------------------------------------------------------------------------
# Per-test fixture: redirect boot lockdown state files to temp locations
# ---------------------------------------------------------------------------


@pytest.fixture
def redirect_state_files(tmp_path):
    """Redirect BCD sentinel, boot state, and password backup to temp paths.

    Also resets the in-memory dry-run state so tests don't leak state.
    """
    orig_bcd_sentinel = bcd_lockdown.BCD_LOCK_SENTINEL
    orig_boot_state = hp_uefi_lockdown.BOOT_STATE_FILE
    orig_pw_backup = hp_uefi_lockdown.BIOS_PASSWORD_BACKUP_FILE

    bcd_lockdown.BCD_LOCK_SENTINEL = tmp_path / ".bcd_locked"
    hp_uefi_lockdown.BOOT_STATE_FILE = tmp_path / ".boot_state"
    hp_uefi_lockdown.BIOS_PASSWORD_BACKUP_FILE = tmp_path / ".bios_pw_backup"

    # Reset dry-run in-memory state to defaults
    _reset_dry_run_state()

    yield tmp_path

    bcd_lockdown.BCD_LOCK_SENTINEL = orig_bcd_sentinel
    hp_uefi_lockdown.BOOT_STATE_FILE = orig_boot_state
    hp_uefi_lockdown.BIOS_PASSWORD_BACKUP_FILE = orig_pw_backup
    _reset_dry_run_state()


# ---------------------------------------------------------------------------
# SimulatedServer tests
# ---------------------------------------------------------------------------


class TestSimulatedServer:
    def test_register_device_creates_device(self):
        """register_device creates a device with a UUID and correct fields."""
        server = simulate_lockdown.SimulatedServer()
        device = server.register_device("HP-TEST-001", "Test User")

        assert device["hostname"] == "HP-TEST-001"
        assert device["owner_name"] == "Test User"
        assert device["status"] == "active"
        assert "id" in device
        assert device["id"] in server.devices

    def test_register_device_generates_unique_ids(self):
        """Each register_device call generates a unique device ID."""
        server = simulate_lockdown.SimulatedServer()
        dev1 = server.register_device("HOST-1", "User 1")
        dev2 = server.register_device("HOST-2", "User 2")
        assert dev1["id"] != dev2["id"]

    def test_flag_stolen_changes_status_and_queues_command(self):
        """flag_stolen sets status to 'stolen' and queues a lockdown command."""
        server = simulate_lockdown.SimulatedServer()
        device = server.register_device("HP-TEST-001", "Test User")

        cmd = server.flag_stolen(device["id"])

        assert server.devices[device["id"]]["status"] == "stolen"
        assert cmd["command_type"] == "lockdown"
        assert cmd["status"] == "pending"
        assert cmd["device_id"] == device["id"]
        assert len(server.commands) == 1
        assert server.audit_log[-1]["action"] == "flag_stolen"

    def test_recover_device_changes_status_and_queues_command(self):
        """recover_device sets status to 'recovering' and queues an unlock command."""
        server = simulate_lockdown.SimulatedServer()
        device = server.register_device("HP-TEST-001", "Test User")

        cmd = server.recover_device(device["id"])

        assert server.devices[device["id"]]["status"] == "recovering"
        assert cmd["command_type"] == "unlock"
        assert cmd["status"] == "pending"
        assert len(server.commands) == 1

    def test_checkin_returns_command_for_registered_device(self):
        """checkin returns device status + pending command."""
        server = simulate_lockdown.SimulatedServer()
        device = server.register_device("HP-TEST-001", "Test User")
        server.flag_stolen(device["id"])

        result = server.checkin("HP-TEST-001")

        assert result["device_id"] == device["id"]
        assert result["status"] == "stolen"
        assert result["command"] is not None
        assert result["command"]["type"] == "lockdown"

    def test_checkin_unregistered_device_returns_error(self):
        """checkin for an unregistered hostname returns an error."""
        server = simulate_lockdown.SimulatedServer()
        result = server.checkin("UNKNOWN-HOST")
        assert "error" in result

    def test_checkin_no_pending_command(self):
        """checkin with no pending command returns command=None."""
        server = simulate_lockdown.SimulatedServer()
        server.register_device("HP-TEST-001", "Test User")

        result = server.checkin("HP-TEST-001")

        assert result["command"] is None

    def test_checkin_unlock_command_includes_key_and_bios_password(self):
        """Unlock commands include the stored encryption key and BIOS password."""
        server = simulate_lockdown.SimulatedServer()
        device = server.register_device("HP-TEST-001", "Test User")
        server.flag_stolen(device["id"])

        # Simulate lockdown ACK storing key + bios password
        lockdown_cmd = server.commands[0]
        server.command_ack(
            "HP-TEST-001",
            lockdown_cmd["id"],
            "executed",
            key_material="base64key==",
            bios_password="BIOSpw123",
        )

        # Now queue unlock
        server.recover_device(device["id"])

        result = server.checkin("HP-TEST-001")
        assert result["command"]["type"] == "unlock"
        assert result["command"]["key_material"] == "base64key=="
        assert result["command"]["bios_password"] == "BIOSpw123"

    def test_command_ack_stores_key_and_bios_password(self):
        """command_ack stores the encryption key and BIOS password."""
        server = simulate_lockdown.SimulatedServer()
        device = server.register_device("HP-TEST-001", "Test User")
        cmd = server.flag_stolen(device["id"])

        server.command_ack(
            "HP-TEST-001",
            cmd["id"],
            "executed",
            key_material="abc123",
            bios_password="pw456",
        )

        assert server.get_stored_key(device["id"]) == "abc123"
        assert server.get_stored_bios_password(device["id"]) == "pw456"

    def test_command_ack_updates_device_status_on_lockdown(self):
        """ACK with 'executed' on lockdown sets device status to 'locked'."""
        server = simulate_lockdown.SimulatedServer()
        device = server.register_device("HP-TEST-001", "Test User")
        cmd = server.flag_stolen(device["id"])

        server.command_ack("HP-TEST-001", cmd["id"], "executed")

        assert server.devices[device["id"]]["status"] == "locked"

    def test_command_ack_updates_device_status_on_unlock(self):
        """ACK with 'executed' on unlock sets device status to 'active'."""
        server = simulate_lockdown.SimulatedServer()
        device = server.register_device("HP-TEST-001", "Test User")
        lock_cmd = server.flag_stolen(device["id"])
        server.command_ack("HP-TEST-001", lock_cmd["id"], "executed")

        unlock_cmd = server.recover_device(device["id"])
        server.command_ack("HP-TEST-001", unlock_cmd["id"], "executed")

        assert server.devices[device["id"]]["status"] == "active"

    def test_command_ack_unregistered_device_returns_error(self):
        """command_ack for unregistered hostname returns an error."""
        server = simulate_lockdown.SimulatedServer()
        result = server.command_ack("UNKNOWN", "cmd-1", "executed")
        assert "error" in result

    def test_get_stored_bios_password_none_when_empty(self):
        """get_stored_bios_password returns None when no password stored."""
        server = simulate_lockdown.SimulatedServer()
        assert server.get_stored_bios_password("dev-1") is None

    def test_get_stored_key_none_when_empty(self):
        """get_stored_key returns None when no key stored."""
        server = simulate_lockdown.SimulatedServer()
        assert server.get_stored_key("dev-1") is None


# ---------------------------------------------------------------------------
# SimulatedAgent tests
# ---------------------------------------------------------------------------


class TestSimulatedAgent:
    def _make_cfg(self, tmp_folder, tmp_sentinel):
        """Build a sim config pointing at temp paths."""
        return {
            "server_url": "http://simulated-server",
            "agent_key": "sim-key",
            "hostname": "HP-TEST-001",
            "poll_interval": 1,
            "lockdown_folder": tmp_folder,
            "lock_sentinel": tmp_sentinel,
            "verify_tls": True,
            "boot_lock_enabled": True,
            "uefi_password": "",
        }

    def test_checkin_delegates_to_server(self, tmp_folder, tmp_sentinel):
        """SimulatedAgent.checkin calls server.checkin with hostname."""
        server = simulate_lockdown.SimulatedServer()
        server.register_device("HP-TEST-001", "Test User")
        cfg = self._make_cfg(tmp_folder, tmp_sentinel)
        agent = simulate_lockdown.SimulatedAgent(server, cfg)

        result = agent.checkin()

        assert result["device_id"] is not None
        assert result["status"] == "active"

    def test_ack_command_delegates_to_server(self, tmp_folder, tmp_sentinel):
        """SimulatedAgent.ack_command calls server.command_ack."""
        server = simulate_lockdown.SimulatedServer()
        device = server.register_device("HP-TEST-001", "Test User")
        cmd = server.flag_stolen(device["id"])
        cfg = self._make_cfg(tmp_folder, tmp_sentinel)
        agent = simulate_lockdown.SimulatedAgent(server, cfg)

        agent.ack_command(cmd["id"], "executed", key_material="abc", bios_password="pw")

        assert server.get_stored_key(device["id"]) == "abc"
        assert server.get_stored_bios_password(device["id"]) == "pw"

    def test_run_lockdown_encrypts_folder_and_writes_sentinel(
        self, tmp_folder, tmp_sentinel, redirect_state_files
    ):
        """run_lockdown encrypts files, writes sentinel, and ACKs."""
        server = simulate_lockdown.SimulatedServer()
        device = server.register_device("HP-TEST-001", "Test User")
        lock_cmd = server.flag_stolen(device["id"])
        cfg = self._make_cfg(tmp_folder, tmp_sentinel)
        agent = simulate_lockdown.SimulatedAgent(server, cfg)

        agent.run_lockdown({"id": lock_cmd["id"], "type": "lockdown"})

        # Folder is encrypted
        assert len(list(tmp_folder.rglob("*.enc"))) > 0
        assert not (tmp_folder / "file1.txt").exists()
        # Sentinel written
        assert tmp_sentinel.exists()
        # Server received ACK with key
        assert server.get_stored_key(device["id"]) is not None

    def test_run_lockdown_skips_if_sentinel_exists(
        self, tmp_folder, tmp_sentinel, redirect_state_files
    ):
        """run_lockdown skips if the sentinel already exists."""
        server = simulate_lockdown.SimulatedServer()
        device = server.register_device("HP-TEST-001", "Test User")
        lock_cmd = server.flag_stolen(device["id"])
        cfg = self._make_cfg(tmp_folder, tmp_sentinel)
        agent = simulate_lockdown.SimulatedAgent(server, cfg)

        # Pre-create sentinel
        tmp_sentinel.write_text(json.dumps({"locked": True}))

        agent.run_lockdown({"id": lock_cmd["id"], "type": "lockdown"})

        # Files should NOT be encrypted (skipped)
        assert (tmp_folder / "file1.txt").exists()
        assert len(list(tmp_folder.rglob("*.enc"))) == 0

    def test_run_unlock_decrypts_folder_and_removes_sentinel(
        self, tmp_folder, tmp_sentinel, redirect_state_files
    ):
        """run_unlock decrypts files, removes sentinel, and ACKs."""
        server = simulate_lockdown.SimulatedServer()
        device = server.register_device("HP-TEST-001", "Test User")
        lock_cmd = server.flag_stolen(device["id"])
        cfg = self._make_cfg(tmp_folder, tmp_sentinel)
        agent = simulate_lockdown.SimulatedAgent(server, cfg)

        # First, lock down
        agent.run_lockdown({"id": lock_cmd["id"], "type": "lockdown"})
        stored_key = server.get_stored_key(device["id"])
        assert stored_key is not None

        # Queue unlock command on the server
        unlock_cmd = server.recover_device(device["id"])

        # Now unlock
        agent.run_unlock(
            {
                "id": unlock_cmd["id"],
                "type": "unlock",
                "key_material": stored_key,
                "bios_password": "fake_pw",
            }
        )

        # Folder is decrypted
        assert (tmp_folder / "file1.txt").read_text() == "hello world"
        assert (tmp_folder / "file2.txt").read_text() == "secret data"
        # Sentinel removed
        assert not tmp_sentinel.exists()

    def test_run_unlock_fails_without_key_material(
        self, tmp_folder, tmp_sentinel, redirect_state_files
    ):
        """run_unlock ACKs as 'failed' when no key_material is provided."""
        server = simulate_lockdown.SimulatedServer()
        device = server.register_device("HP-TEST-001", "Test User")
        unlock_cmd = server.recover_device(device["id"])
        cfg = self._make_cfg(tmp_folder, tmp_sentinel)
        agent = simulate_lockdown.SimulatedAgent(server, cfg)

        agent.run_unlock({"id": unlock_cmd["id"], "type": "unlock"})

        # Command should be ACKed as failed
        for c in server.commands:
            if c["id"] == unlock_cmd["id"]:
                assert c["status"] == "failed"

    def test_poll_and_execute_lockdown(self, tmp_folder, tmp_sentinel, redirect_state_files):
        """poll_and_execute dispatches a lockdown command from the server."""
        server = simulate_lockdown.SimulatedServer()
        device = server.register_device("HP-TEST-001", "Test User")
        server.flag_stolen(device["id"])

        cfg = self._make_cfg(tmp_folder, tmp_sentinel)
        agent = simulate_lockdown.SimulatedAgent(server, cfg)

        agent.poll_and_execute()

        # Device status on the server is updated to "locked" after ACK
        assert server.devices[device["id"]]["status"] == "locked"
        assert tmp_sentinel.exists()

    def test_poll_and_execute_unlock(self, tmp_folder, tmp_sentinel, redirect_state_files):
        """poll_and_execute dispatches an unlock command from the server."""
        server = simulate_lockdown.SimulatedServer()
        device = server.register_device("HP-TEST-001", "Test User")
        server.flag_stolen(device["id"])

        cfg = self._make_cfg(tmp_folder, tmp_sentinel)
        agent = simulate_lockdown.SimulatedAgent(server, cfg)

        # First poll: lockdown
        agent.poll_and_execute()

        # Queue unlock
        server.recover_device(device["id"])

        # Second poll: unlock
        agent.poll_and_execute()

        # Device status on the server is updated to "active" after ACK
        assert server.devices[device["id"]]["status"] == "active"
        assert not tmp_sentinel.exists()
        assert (tmp_folder / "file1.txt").read_text() == "hello world"

    def test_poll_and_execute_no_command(self, tmp_folder, tmp_sentinel):
        """poll_and_execute with no pending command just returns checkin result."""
        server = simulate_lockdown.SimulatedServer()
        server.register_device("HP-TEST-001", "Test User")

        cfg = self._make_cfg(tmp_folder, tmp_sentinel)
        agent = simulate_lockdown.SimulatedAgent(server, cfg)

        result = agent.poll_and_execute()

        assert result["command"] is None
        # Files unchanged
        assert (tmp_folder / "file1.txt").exists()


# ---------------------------------------------------------------------------
# simulate_reboot tests
# ---------------------------------------------------------------------------


class TestSimulateReboot:
    def test_simulate_reboot_does_not_raise(self, redirect_state_files, capsys):
        """simulate_reboot runs without error in dry-run mode."""
        simulate_lockdown.simulate_reboot()
        captured = capsys.readouterr()
        assert "SIM REBOOT" in captured.out

    def test_simulate_reboot_reports_boot_paths(self, redirect_state_files, capsys):
        """simulate_reboot checks all boot paths (F2, F12, USB, PXE, F8, WinRE)."""
        simulate_lockdown.simulate_reboot()
        captured = capsys.readouterr()
        for path in ["F2/Del", "F12", "USB boot", "PXE/network", "Safe Mode", "WinRE"]:
            assert path in captured.out


# ---------------------------------------------------------------------------
# run_simulation (full end-to-end) tests
# ---------------------------------------------------------------------------


class TestRunSimulation:
    def test_run_simulation_completes_without_error(self, tmp_path, capsys):
        """The full end-to-end simulation completes without assertions or errors."""
        # Redirect BIOS_PASSWORD_BACKUP_FILE to temp (run_simulation handles
        # BOOT_STATE_FILE and BCD_LOCK_SENTINEL itself, but not the password backup)
        orig_pw_backup = hp_uefi_lockdown.BIOS_PASSWORD_BACKUP_FILE
        hp_uefi_lockdown.BIOS_PASSWORD_BACKUP_FILE = tmp_path / ".bios_pw_backup"

        # Reset dry-run state to defaults before running the full simulation
        _reset_dry_run_state()

        try:
            simulate_lockdown.run_simulation()
        except SystemExit as e:
            pytest.fail(f"run_simulation exited with code {e.code}")
        finally:
            hp_uefi_lockdown.BIOS_PASSWORD_BACKUP_FILE = orig_pw_backup
            _reset_dry_run_state()

        captured = capsys.readouterr()
        assert "SIMULATION COMPLETE" in captured.out
        assert "ALL CHECKS PASSED" in captured.out
