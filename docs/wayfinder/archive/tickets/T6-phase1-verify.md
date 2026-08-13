# T6: Phase 1 — Write all tests + verify

> **Label:** `wayfinder:task`
> **Status:** CLOSED (2026-08-14)
> **Blocks:** T7 (Phase 2 start)
> **Blocked by:** T1, T2, T3, T4, T5
> **Implements:** Q6

## Question

Run the full verification suite for all Phase 1 changes and capture the
artifact.

## Work

1. Run `cd agent && python3 -m pytest tests/ -q` — all tests must pass.
2. Run `cd agent && python3 -m ruff check . && python3 -m ruff format --check .` — clean.
3. Run `cd server && npm test` — server tests must pass (no server changes in
   Phase 1, but verify no regressions).
4. Capture the test output as the artifact.
5. Update `trace.md` with the session-end status block.
6. Update `DEBT-LEDGER.md` with new debt items (D-015 through D-019) marked
   CLOSED with commit ref + artifact ref.

## Acceptance

- All agent tests pass (230 + new Phase 1 tests).
- Ruff clean.
- Server tests pass (no regressions).
- trace.md updated.
- Debt items created and closed.
