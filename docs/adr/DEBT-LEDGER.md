# DEBT-LEDGER.md — Production Readiness Debt Items

> This is the single source of truth for what needs to ship. Each debt item
> has a close criteria, a status, and (when closed) a commit hash + artifact
> reference. The graph asserts that no debt item can be CLOSED without both.
>
> **Graph invariant I2**: `assert_debt_close_has_evidence()` enforces this.

## How to use this file

1. At **SESSION-START**: read this file to identify open debt items.
2. During **RULE-ZERO**: confirm the debt item's close criteria match what
   the source material / skill files actually require.
3. At **CLOSE-DEBT**: update the item's status to CLOSED, add commit hash
   and artifact reference. The graph will assert the evidence exists.

## Debt Items

### D-001 — Orchestrator only knows phases 0-7, not 8-16
- **Status**: CLOSED
- **Commit ref**: 2026-08-10 session (orchestrator.sh update)
- **Artifact ref**: `orchestrator.sh status` shows all 17 phases (0-16) as COMPLETE;
  `orchestrator.sh test 16` and `orchestrator.sh test 8` both pass;
  graph_assert.py I6 violation resolved
- **Close criteria met**: `orchestrator.sh` updated with all 17 phases in PHASE_DEPS,
  PHASE_NAMES, show_status, run_all, and case statement

### D-002 — Phase completion markers are empty 0-byte files
- **Status**: CLOSED
- **Commit ref**: 2026-08-10 session (.complete files populated)
- **Artifact ref**: All 17 `.complete` files now contain commit hash + artifact description
  + date + tests; total 4597 bytes (was 0); graph_assert.py I7 violation resolved
- **Close criteria met**: Each `results/phase-N.complete` file contains commit hash
  + artifact reference

### D-003 — No hardware-in-the-loop test harness for enforcement paths
- **Status**: OPEN (scaffolding built, needs real hardware to close)
- **Close criteria**: At least one enforcement path verified on real hardware with run artifact
- **Blocks**: E-LOCK-SCREEN, E-GUARDIAN, E-BCD, E-HP-UEFI
- **Notes**: Every enforcement path is tested only through mocks. No test in the repo
  has ever executed a real enforcement action against real Windows or real HP firmware.
  The E2E harness (`tests/e2e/agent-helpers.js`) explicitly disables boot lockdown
  (`boot_lock_enabled = false` at line 278).
- **Progress (2026-08-10)**: Built agent/hw_test_harness.py — a standalone test
  runner that executes each enforcement path (E-ENCRYPT, E-LOCK-SCREEN, E-GUARDIAN,
  E-BCD, E-HP-UEFI) against real OS/firmware APIs. Detects environment (platform,
  HP model, admin, session context, BitLocker). Generates JSON run artifact with
  per-test PASS/FAIL/SKIP/ERROR status. Gracefully skips tests on non-Windows/non-HP.
  The E-ENCRYPT test passes on any platform. 14 unit tests for harness logic.
  To close D-003: run `python3 hw_test_harness.py` on real Windows/HP hardware
  and verify at least one enforcement path passes.

### D-004 — HP UEFI lockdown reports false success when critical_applied=0
- **Status**: CLOSED
- **Commit ref**: Phase 17 (2026-08-10 session)
- **Artifact ref**: 330 server tests + 143 agent tests + 26 dashboard tests pass;
  `boot_lock_detail` with `critical_applied_total` now sent in ACK;
  `lockdown_effective` computed server-side; dashboard shows red "BOOT LOCKDOWN
  INEFFECTIVE" panel when `critical_applied_total === 0`
- **Close criteria met**: Server treats `critical_applied=0` as `lockdown_effective=false`;
  dashboard shows warning panel with per-layer breakdown

### D-005 — No cross-session context persistence
- **Status**: CLOSED
- **Commit ref**: 2026-08-10 graph session
- **Artifact ref**: `.devin/graph/trace.md` created with two session entries (Phase 17 + graph creation);
  `assert_session_closed_with_trace()` in `graph_assert.py` enforces I4
- **Close criteria met**: `trace.md` exists and is updated at session end with status block

### D-006 — No formal graph spec or assertion engine
- **Status**: CLOSED
- **Commit ref**: 2026-08-10 graph session
- **Artifact ref**: `GRAPH-SPEC.yaml` (17 phases, 12 verify nodes, 13 enforcement paths, 7 invariants);
  `graph_loader.py` runs and shows full graph summary;
  `graph_assert.py` runs and correctly detects 2 violations (I6, I7);
  deliberate violation test raises `GraphViolationError` for I1
- **Close criteria met**: GRAPH-SPEC.yaml + graph_loader.py + graph_assert.py exist and enforce transitions

### D-007 — Lock guardian uses LockWorkStation from service session (Session 0 isolation)
- **Status**: OPEN (software implemented, needs hardware verification)
- **Close criteria**: Lock guardian works from service context OR documented as requiring interactive session
- **Blocks**: E-LOCK-SCREEN, E-GUARDIAN
- **Notes**: `ctypes.windll.user32.LockWorkStation()` from a Windows service (Session 0)
  cannot lock a user's interactive desktop (Session 1). This is a classic Windows
  session-isolation gap. The agent's `install-service-enhanced.ps1` sets up the agent
  as a service, so the lock screen path may be a no-op in production.
- **Progress (2026-08-10)**: Added _detect_session_context() which uses
  WTSGetActiveConsoleSessionId + ProcessIdToSessionId to detect Session 0.
  _lock_workstation() now uses tsdiscon to disconnect the active console session
  when running in Session 0, falling back to LockWorkStation if tsdiscon fails.
  handle_lockdown() captures lock_session_context and passes it to ack_command().
  Server stores lock_session_context in audit log. Dashboard shows "Lock Applied
  from Service Session" panel when is_session_zero=true. 12 unit tests pass
  (8 agent + 2 server + 2 dashboard). Needs real Windows hardware with service
  context to verify tsdiscon actually locks the user's desktop.

### D-008 — BCD lockdown does not check BitLocker status
- **Status**: OPEN (software implemented, needs hardware verification)
- **Close criteria**: Agent checks BitLocker and either handles or warns before `bcdedit`
- **Blocks**: E-BCD
- **Notes**: If the HP machine has BitLocker enabled (common on enterprise HPs), changing
  BCD settings can trigger a BitLocker recovery key prompt on next boot. The code has
  no BitLocker awareness.
- **Progress (2026-08-10)**: Added _check_bitlocker(), _suspend_bitlocker(),
  _resume_bitlocker() to bcd_lockdown.py. apply_bcd_lockdown() now suspends
  BitLocker protectors before BCD changes and resumes after (both success and
  rollback paths). Result dict includes bitlocker_status field. 12 unit tests
  pass. Needs real Windows hardware with BitLocker to fully close.

### D-009 — HP UEFI setting names are hardcoded
- **Status**: OPEN (software implemented, needs hardware verification)
- **Close criteria**: Setting names are dynamically discovered or model-aware
- **Blocks**: E-HP-UEFI
- **Notes**: Setting names like `"Network (PXE) Boot"`, `"USB Boot"`, `"Legacy Support"`
  vary wildly across HP models and BIOS versions. An EliteDesk 800 G9 does not use the
  same setting names as an EliteBook 840 G7. The code handles "setting not found" by
  skipping, so on many real HPs zero critical settings get applied and the result is
  reported as `success: True` with `critical_applied: 0`.
- **Progress (2026-08-10)**: Added CONCEPTS dict, DEFAULT_SETTING_NAMES (alias lists
  per concept), _detect_hp_model() via WMI, _load_model_overrides() from JSON file,
  and _resolve_setting_names() which picks the first candidate name that exists on
  the machine. apply_boot_lockdown() now uses resolved names. Sample
  hp_model_overrides.json provided. 9 unit tests pass. Needs real HP hardware to
  verify setting name resolution works correctly.

### D-010 — No HP Sure Admin / Sure Run / Sure Start awareness
- **Status**: OPEN (software implemented, needs hardware verification)
- **Close criteria**: Agent detects Sure Admin and either works with it or reports blocked
- **Blocks**: E-HP-UEFI
- **Notes**: Modern enterprise HPs (2022+) ship with Sure Start enabled by default.
  Sure Start will revert unauthorized BIOS changes on the next reboot. So even if
  `SetBIOSSetting` returns 0, the setting may be restored to factory defaults within
  one boot cycle.
- **Progress (2026-08-10)**: Added _check_sure_admin() to hp_uefi_lockdown.py which
  queries WMI for Sure Admin, Sure Run, and Sure Start settings.
  apply_boot_lockdown() now calls _check_sure_admin() and includes
  sure_admin_status in the result dict with per-feature detection flags and a
  warning message. 7 unit tests pass. Needs real HP hardware with Sure Admin
  to verify detection works correctly.

### D-011 — File encryption fails silently on open files
- **Status**: OPEN (software implemented, needs hardware verification)
- **Close criteria**: Agent retries with file-closed detection or reports which files blocked encryption
- **Blocks**: E-ENCRYPT
- **Notes**: If a user has an Office doc or Outlook PST open in LOCKDOWN_FOLDER, Fernet's
  `Path.read_bytes()` / `write_bytes()` will throw `PermissionError` on Windows. The code
  catches it and rolls back the sentinel, which means lockdown silently fails on the most
  common real-world scenario.
- **Progress (2026-08-10)**: encrypt_folder() now catches PermissionError, retries 3
  times with 1-second delay, and returns a list of blocked files. handle_lockdown()
  passes blocked files to ack_command() via the encryption_blocked_files param.
  Server stores encryption_blocked_files in the audit log. 4 unit tests pass.
  Needs real Windows hardware with open files to fully close.

### D-012 — Dashboard does not surface lockdown-effectiveness to operator
- **Status**: CLOSED
- **Commit ref**: Phase 17 (2026-08-10 session)
- **Artifact ref**: 5 new dashboard tests pass; DeviceDetailPage shows "Lockdown
  Effectiveness" panel with red/green flagging for locked/stolen devices;
  handles both Postgres JSONB objects and SQLite TEXT strings
- **Close criteria met**: DeviceDetailPage shows `boot_lock_detail` panel with red flagging

---

## Close criteria summary

| ID | Description | Status | Blocks |
|----|-------------|--------|--------|
| D-001 | Orchestrator missing phases 8-16 | CLOSED | — |
| D-002 | Empty completion markers | CLOSED | — |
| D-003 | No hardware test harness | OPEN | E-LOCK-SCREEN, E-GUARDIAN, E-BCD, E-HP-UEFI |
| D-004 | False success on critical_applied=0 | CLOSED | — |
| D-005 | No cross-session trace | CLOSED | — |
| D-006 | No graph spec/engine | CLOSED | — |
| D-007 | Session 0 lock isolation | OPEN | E-LOCK-SCREEN, E-GUARDIAN |
| D-008 | No BitLocker check | OPEN | E-BCD |
| D-009 | Hardcoded HP setting names | OPEN | E-HP-UEFI |
| D-010 | No Sure Admin awareness | OPEN | E-HP-UEFI |
| D-011 | Open-file encryption failure | OPEN | E-ENCRYPT |
| D-012 | Dashboard effectiveness panel | CLOSED | — |
