# current-state.md — Compact Session State

> **Purpose**: This is the primary file agents read at session start. It
> contains the latest session's status, open items, and next session opening.
> For full session history, read `.devin/graph/trace.md`.
>
> **Graph invariant I4**: `assert_session_closed_with_trace()` and
> `assert_current_state_updated()` enforce that this file is updated at every
> session end with a status block.

---

## Latest session: 2026-08-13 (later) — Commit T3 follow-up + audit device_id fix

### Fog cleared
- The uncommitted `audit.js` change is a real bug fix, not just cosmetic:
  the strict UUID regex rejected valid SQLite-generated device IDs (32-char
  hex, no dashes) in the dev/test backend. Loosened regex now accepts both
  PostgreSQL UUIDs (36 chars) and SQLite hex IDs (32 chars).
- Verified via `migrations/001_base.sql` (UUID type) + `sqlitePool.js`
  line 116 (gen_random_uuid → lower(hex(randomblob(16)))).
- All 362 server tests pass before commit.

### Fog remaining
- None for this change.

### Debt items closed
None — small bug fix surfaced from T3, not a debt item.

### Debt items still open
None — all 19 debt items (D-001 through D-019) remain CLOSED.

### Blockers
None.

### Next session opening
T3 follow-up committed (ca87de0). Tree clean. All harness engineering
tickets CLOSED, all 19 debt items CLOSED. Optional next steps remain:
real HP hardware testing, HP CMSL integration, addressing graph invariant
violations I6 (orchestrator only knows phases 0-7, not all 17) and I7
(every COMPLETE phase needs non-empty artifact reference), or new feature
requests.

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
- **Test counts**: 344 agent + 362 server + 40 dashboard = 746 total
