# current-state.md — Compact Session State

> **Purpose**: This is the primary file agents read at session start. It
> contains the latest session's status, open items, and next session opening.
> For full session history, read `.devin/graph/trace.md`.
>
> **Graph invariant I4**: `assert_session_closed_with_trace()` and
> `assert_current_state_updated()` enforce that this file is updated at every
> session end with a status block.

---

## Latest session: 2026-08-13 (final) — Code review fixes + CI fix + PBA role gating

### Fog cleared
- CI Agent Tests job had been failing since commit 7257390 (4 commits).
  Root cause: test_graph_assertions.py imports graph_assert.py →
  graph_loader.py, which requires pyyaml. But pyyaml was not in
  agent/requirements-dev.txt, so CI's clean environment didn't have it.
  Worse, graph_loader.py called sys.exit(1) on missing pyyaml, crashing
  pytest collection with INTERNALERROR. Fixed: added pyyaml to
  requirements-dev.txt, CI now installs requirements-dev.txt, and
  graph_loader.py raises ImportError instead of sys.exit(1).
- Code review of 93ebbef...HEAD diff found 2 hard violations + 3
  judgement calls. All hard violations fixed:
  1. orchestrator.sh used `python` instead of `python3` (AGENTS.md standard)
  2. PBA credentials endpoint used requireRole('operator') but T10 spec
     says "admin-only" → changed to requireRole('super-admin')
- PBA role-gating follow-on: dashboard PBA Recovery panel was visible to
  operators but the endpoint now requires super-admin. Gated the panel
  behind isSuperAdmin. Updated PBA_RECOVERY_RUNBOOK.md. Added dashboard
  test verifying operators can't see the panel.
- Extracted duplicated password_type discriminator logic from
  routes/agent.js and routes/devices.js to shared utility
  server/src/db/pbaCredentials.js (groupPbaCredentials). 5 unit tests.
- Added # D-XXX: debt ledger comments to 3 new agent files per AGENTS.md
  convention (bitlocker_pba.py, test_bitlocker_pba.py,
  test_graph_assertions.py).
- Skipped BitLocker credential data clumps refactor (judgement call:
  mild smell, only 2 fields, poor risk/reward with no test coverage of
  those specific params).

### Fog remaining
- None. All code review findings addressed (hard violations fixed,
  judgement calls either addressed or consciously skipped with rationale).

### Debt items closed
None — this is code review remediation and CI fix work, not debt closure.

### Debt items still open
None — all 19 debt items (D-001 through D-019) remain CLOSED.

### Blockers
None — CI is fully green (all 7 jobs passed on 95e710a).

### Next session opening
All code review findings resolved. CI green. 753 tests passing
(368 server + 344 agent + 41 dashboard). Tree clean. Optional next
steps: real HP hardware testing (E-HP-UEFI still verified-in-unit-test),
HP CMSL integration, or new feature requests.

---

## Open wayfinder tickets

| Ticket | Title | Status | Blocks |
|--------|-------|--------|--------|
| Q1 | Goodhart's Law defense design | CLOSED | — |
| T1 | Archive + trace restructure | CLOSED | — |
| T2 | Clean-state + Goodhart + attribution | CLOSED | — |
| T3 | Error messages with fix instructions | CLOSED | — |

Map: `docs/wayfinder/harness-engineering-map.md`

---

## Open debt items

None. All 19 debt items (D-001 through D-019) are CLOSED.
See `docs/adr/DEBT-LEDGER.md` for the full ledger.

---

## Quick reference

- **Graph spec**: `.devin/graph/GRAPH-SPEC.yaml`
- **Full trace history**: `.devin/graph/trace.md` (3300+ lines — read on demand)
- **Debt ledger**: `docs/adr/DEBT-LEDGER.md`
- **Graph ADR**: `docs/adr/GRAPH-SPEC.md`
- **Verification**: `make graph-check` (runs `graph_assert.py` — all invariants)
- **Clean state**: `make clean-state` (runs 5-condition checklist from L12)
- **Test counts**: 344 agent + 368 server + 41 dashboard = 753 total
