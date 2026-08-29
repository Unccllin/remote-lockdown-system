---
name: hw-test-harness-v2
description: Hardware-in-the-loop test harness v2.0. Use when running hardware tests, verifying enforcement paths, or extending the harness with new tests.
---

# Skill: Hardware Test Harness v2.0

## When to use this skill

- **Before running hardware tests** — to understand the harness modes, flags, and test registry.
- **When verifying enforcement paths** — the harness is the only way to produce real hardware artifacts (required by graph invariant I3).
- **When extending the harness** — to add a new enforcement path test following the established patterns.
- **When debugging a hardware test failure** — to understand the phase lifecycle, timeout, retry, and rollback mechanics.
- **In CI** — the dry-run mode is wired into CI (`hw-harness-dry-run` job) to verify harness structure without hardware.

## Overview

The hardware test harness is at `agent/hw_test_harness.py` (v2.0, ~1600 lines).
It was redesigned from v1.0 with 12 patterns borrowed from established HIL
frameworks (OpenHTF, bench-vv, f0_library, FleetDM, Windows-Red-Teaming,
pytest-timeout, pytest-rerunfailures, Allure/JUnit/CTRF, macOSLab, GhostWall).

The harness executes 12 enforcement path tests against real Windows/HP
hardware. On non-Windows or non-HP platforms, tests are gracefully skipped
(not failed).

## The 12 patterns

| # | Pattern | Source | Implementation |
|---|---------|--------|----------------|
| 1 | Phase lifecycle | OpenHTF | `HardwareTest` base class: `precondition() -> action() -> verify() -> cleanup()` |
| 2 | Service gating | pytest-embedded | `--services hp,tpm,server,defender` — tests declare `requires_services`, harness checks availability before running |
| 3 | Tri-mode | Windows-Red-Teaming | `--mode dry-run|check|simulate` — dry-run skips, check reports eligibility, simulate executes real actions |
| 4 | Hash binding | bench-vv | `compute_agent_hash()` records agent binary SHA-256 in every artifact |
| 5 | VHD isolation | f0_library | Destructive tests target VHD/temp dirs, not real disk (tests use `tempfile.TemporaryDirectory`) |
| 6 | Command lifecycle | FleetDM | E-INTEGRATION tests Pending -> Fetched -> Acked -> Error -> Canceled flow |
| 7 | Timeout protection | pytest-timeout | `with_timeout()` decorator + threading.Timer, default 60s per test, `--timeout` flag |
| 8 | Retry logic | pytest-rerunfailures | `with_retry()` decorator, retries on ERROR (not FAIL), `--retry` flag, only for `is_network=True` tests |
| 9 | CTRF JSON format | CTRF standard | `build_ctrf_artifact()` — standardized report with summary, tests[], extra |
| 10 | Tag-based filtering | custom | `--tag E-ENCRYPT,E-DURESS` — tests declare `tags` list, harness filters |
| 11 | Evidence capture | macOSLab | `capture_state()` — before/after state snapshots with file listings, sizes, SHA-256 hashes |
| 12 | Rollback | GhostWall | `RollbackContext` — capture prior state, restore after destructive test; `is_destructive=True` tests |

## The 12 enforcement path tests

All tests are registered in `ALL_TESTS` list at line ~1236 of
`agent/hw_test_harness.py`.

| Test ID | Enforcement Path | Name | Platform | Services | Destructive | Network | Timeout |
|---------|-----------------|------|----------|----------|-------------|---------|---------|
| E-ENCRYPT-01 | E-ENCRYPT | File encryption roundtrip | Any | — | No | No | 30s |
| E-LOCK-SCREEN-01 | E-LOCK-SCREEN | Workstation lock (sentinel-verified) | Windows | — | No | No | 15s |
| E-GUARDIAN-01 | E-GUARDIAN | Lock guardian re-lock (verified) | Windows | — | No | No | 30s |
| E-BCD-01 | E-BCD | BCD lockdown (with rollback) | Windows | admin | Yes | No | 60s |
| E-HP-UEFI-01 | E-HP-UEFI | HP UEFI/BIOS lockdown (with rollback) | Windows | hp, admin | Yes | No | 120s |
| E-DURESS-01 | E-DURESS | Duress unlock + re-lock | Windows | — | No | No | 30s |
| E-HIDDEN-FILE-01 | E-HIDDEN-FILE | Hidden file trigger -> lockdown | Any | — | No | No | 15s |
| E-TAMPER-01 | E-TAMPER | Agent binary tamper detection | Windows | — | No | No | 15s |
| E-TPM-01 | E-TPM | TPM sealing of state files | Windows | tpm | No | No | 30s |
| E-ENROLL-01 | E-ENROLL | Token enrollment flow | Any | server | No | Yes (2 retries) | 30s |
| E-HWID-01 | E-HWID | Hardware ID collection | Any | — | No | No | 15s |
| E-INTEGRATION-01 | E-INTEGRATION | Full cycle: enroll -> flag -> lockdown -> recover | Any | server | Yes | Yes (2 retries) | 120s |

### Test details

- **E-ENCRYPT**: Creates 3 test files in a temp dir, encrypts with Fernet,
  verifies .enc files exist and plaintext is gone, decrypts, verifies
  content matches. Works on any platform.

- **E-LOCK-SCREEN**: Creates a sentinel file, issues `_lock_workstation()`,
  waits 2s, verifies sentinel survived. Uses `tsdiscon` when in Session 0,
  `LockWorkStation` otherwise. Windows-only.

- **E-GUARDIAN**: Starts `start_lock_guardian()`, waits 12s (one re-lock
  cycle at 10s interval), stops guardian. Windows-only.

- **E-BCD**: Calls `bcd_lockdown.apply_bcd_lockdown()`, captures BCD
  settings before/after, attempts rollback. Requires admin. Destructive.
  BitLocker protectors are suspended before BCD changes and resumed after.

- **E-HP-UEFI**: Calls `hp_uefi_lockdown.apply_boot_lockdown()`, captures
  BIOS settings before, attempts rollback. Requires HP machine + admin.
  Destructive. Detects Sure Admin (EBAM) and reports blocked if active.

- **E-DURESS**: Tests hidden trigger detection (create -> detect -> consume)
  and duress command detection (`is_duress_unlock()`). Windows-only.

- **E-HIDDEN-FILE**: Tests hidden file trigger lifecycle (create -> detect
  -> consume). Works on any platform (uses `duress` module).

- **E-TAMPER**: Tests agent binary tamper detection — creates a fake
  protected file, deletes it, verifies missing file is detected.
  Windows-only.

- **E-TPM**: Tests TPM seal/unseal roundtrip via `tpm_seal` module.
  Requires TPM present. Windows-only.

- **E-ENROLL**: Generates enrollment token via server API
  (`POST /api/enroll/token`). Requires server running at localhost:3000.
  Network test with 2 retries.

- **E-HWID**: Collects hostname, hardware UUID (`agent.get_hardware_uuid()`),
  and MAC address (`agent.get_mac_address()`). Works on any platform.

- **E-INTEGRATION**: Full lifecycle — enrolls a test device, flags it
  stolen, verifies status, recovers it, verifies status. Requires server.
  Network + destructive with 2 retries.

## CLI usage

```bash
# Run all tests in simulate mode (default — executes real actions)
python3 hw_test_harness.py

# Dry-run mode (skip all tests — just shows what would run)
python3 hw_test_harness.py --mode dry-run

# Check mode (report environment + test eligibility, no execution)
python3 hw_test_harness.py --mode check

# Simulate mode (execute real enforcement actions)
python3 hw_test_harness.py --mode simulate

# Run specific enforcement paths by tag
python3 hw_test_harness.py --tag E-ENCRYPT,E-DURESS

# Gate on required services
python3 hw_test_harness.py --services hp,tpm,server,defender

# Per-test timeout (default 60s)
python3 hw_test_harness.py --timeout 120

# Retry network tests up to N times (default 0)
python3 hw_test_harness.py --retry 3

# Write artifact to specific path
python3 hw_test_harness.py --artifact /tmp/hw-result.json

# Artifact format: ctrf (default), junit (XML), legacy (v1.0 JSON)
python3 hw_test_harness.py --format ctrf
python3 hw_test_harness.py --format junit
python3 hw_test_harness.py --format legacy

# Upload artifact to server (POST to /api/hw-test-artifact)
python3 hw_test_harness.py --upload http://localhost:3000

# Backward compat: --dry-run flag (shortcut for --mode dry-run)
python3 hw_test_harness.py --dry-run

# Backward compat: --only flag (maps v1.0 names to v2.0 tags)
python3 hw_test_harness.py --only encrypt
```

All commands must be run from the `agent/` directory (or use `cd agent &&`).

## Make targets

| Target | Command | Purpose |
|--------|---------|---------|
| `make hw-test` | `cd agent && python3 hw_test_harness.py --mode simulate` | Run real enforcement path tests (simulate mode) |
| `make hw-test-dry` | `cd agent && python3 hw_test_harness.py --mode dry-run` | Dry-run — see what would run without executing |
| `make hw-test-check` | `cd agent && python3 hw_test_harness.py --mode check` | Check test eligibility (no execution) |

## Artifact formats

### CTRF (default, `.json`)
Standardized test report format:
```json
{
  "results": {
    "tool": { "name": "hw-test-harness", "version": "2.0" },
    "summary": { "tests": 12, "passed": 5, "failed": 0, "skipped": 7, "errors": 0 },
    "tests": [ { "name": "E-ENCRYPT-01", "status": "passed", "duration": 33, ... } ],
    "extra": { "environment": {...}, "agent_binary_hash": "..." }
  }
}
```

### JUnit XML (`.xml`)
Standard JUnit format for CI integration. Uses `xml.etree.ElementTree`.

### Legacy (`.json`)
v1.0-compatible format with `harness_version`, `timestamp`, `environment`,
`results[]`, `summary` at top level. For backward compatibility with
existing tooling.

Default artifact path: `agent/hw_test_artifact.json` (or `.xml` for JUnit).

## The --upload flag and /api/hw-test-artifact endpoint

When `--upload <server-url>` is passed, the harness POSTs the artifact JSON
to `<server-url>/api/hw-test-artifact`. The server endpoint
(`server/src/routes/hwTestArtifact.js`) stores the artifact and associates
it with a device by hostname. This enables the dashboard to display
hardware test results.

```bash
python3 hw_test_harness.py --mode simulate --upload http://localhost:3000
```

If the upload fails, a WARNING is printed but the harness does not fail
(upload is best-effort).

## Environment detection

`detect_environment()` collects:
- `platform` (Windows/Linux/macOS)
- `is_hp` + `hp_model` (via `hp_uefi_lockdown.is_hp_machine()`)
- `is_admin` (via `ctypes.windll.shell32.IsUserAnAdmin()`)
- `session_context` (Session 0 detection via `agent._detect_session_context()`)
- `bitlocker_enabled` (via `bcd_lockdown._check_bitlocker()`)
- `tpm_present` (via PowerShell `Get-Tpm`)
- `defender_exclusion` (via PowerShell `Get-MpPreference`)
- `agent_binary_hash` (SHA-256 of agent binary or agent.py source)
- `hostname` (via `platform.node()`)

Tests use this environment dict to decide eligibility (precondition + service gating).

## How to add a new enforcement path test

1. **Create a new test class** subclassing `HardwareTest`:
   ```python
   class TestMyNewPath(HardwareTest):
       test_id = "E-NEW-01"
       enforcement_path = "E-NEW"
       name = "My new enforcement path test"
       tags = ["E-NEW", "non-destructive"]
       requires_platform = "Windows"  # or None for any platform
       requires_services = ["admin"]  # optional: hp, tpm, server, defender, admin, windows
       is_destructive = False  # set True if test modifies system state
       is_network = False  # set True if test needs network (enables retry)
       default_timeout = 60
       default_retries = 0

       def action(self, env: dict, mode: str) -> str:
           # Execute the enforcement action
           # Return a detail string (must contain a success keyword for verify)
           return "Action completed successfully"

       def verify(self, env: dict, mode: str, action_detail: str = "") -> tuple[bool, str]:
           # Check that the action succeeded
           if "successfully" in action_detail:
               return True, "Verified"
           return False, action_detail

       # Optional overrides for destructive tests:
       def capture_before(self, env: dict) -> dict:
           return capture_state("before", [Path("/some/setting")])

       def capture_after(self, env: dict) -> dict:
           return capture_state("after", [Path("/some/setting")])

       def rollback(self, before_state: dict) -> None:
           # Restore prior state
           pass

       def cleanup(self, env: dict, mode: str) -> None:
           # Always runs, even on failure
           pass
   ```

2. **Register the test** in the `ALL_TESTS` list:
   ```python
   ALL_TESTS: list[HardwareTest] = [
       # ... existing tests ...
       TestMyNewPath(),
   ]
   ```

3. **Update GRAPH-SPEC.yaml** — add the enforcement path to the
   `enforcement_paths` section with appropriate `verified_by` and `status`.

4. **Test in dry-run mode first**:
   ```bash
   python3 hw_test_harness.py --mode dry-run --tag E-NEW
   ```
   Verify the test appears and is correctly tagged.

5. **Test in check mode** to verify eligibility logic:
   ```bash
   python3 hw_test_harness.py --mode check --tag E-NEW
   ```

6. **Run on real hardware** in simulate mode:
   ```bash
   python3 hw_test_harness.py --mode simulate --tag E-NEW
   ```

## CI integration

The `hw-harness-dry-run` CI job (in `.github/workflows/ci.yml`) runs:
```bash
python3 hw_test_harness.py --mode dry-run
python3 hw_test_harness.py --mode check
```
This verifies the harness structure and test eligibility logic without
requiring real hardware. All tests are expected to SKIP on Linux CI.

## Key files

| File | Purpose |
|------|---------|
| `agent/hw_test_harness.py` | The harness itself (~1600 lines, v2.0) |
| `agent/hw_test_artifact.json` | Default artifact output (CTRF format) |
| `agent/hw_test_artifact_azure.json` | Real hardware artifact from Azure Windows 11 VM |
| `agent/hw_test_artifact_azure_bitlocker.json` | Real hardware artifact with BitLocker verification |
| `server/src/routes/hwTestArtifact.js` | Server endpoint for artifact upload |
| `.github/workflows/ci.yml` | CI job `hw-harness-dry-run` |
| `Makefile` | `hw-test`, `hw-test-dry`, `hw-test-check` targets |
