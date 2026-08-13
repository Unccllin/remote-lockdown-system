# T4: Phase 1 — BCD hardening (timeout, bootsequence, integrity checks)

> **Label:** `wayfinder:task`
> **Status:** OPEN
> **Blocks:** none
> **Blocked by:** none
> **Implements:** Q6

## Question

Add additional BCD hardening: timeout=0, clear bootsequence, set
nointegritychecks No, allowprereleasesignatures No.

## Work

1. Add these to `BCD_BEST_EFFORT_COMMANDS` in `agent/bcd_lockdown.py`:
   - `{bootmgr} timeout 0` — eliminates boot menu wait
   - `{default} nointegritychecks No` — ensures driver signature enforcement
   - `{default} allowprereleasesignatures No` — blocks test-signed drivers
2. Add a step to clear `bootsequence` (one-time boot override):
   `bcdedit /bootsequence /remove` (or deletevalue).
3. Add to `BCD_RESTORE_COMMANDS` for removal.
4. Update dry-run BCD state.
5. Write tests (mocked bcdedit calls).

## Files to edit

- `agent/bcd_lockdown.py` (add to BCD_BEST_EFFORT_COMMANDS, BCD_RESTORE_COMMANDS,
  dry-run state)
- `agent/tests/test_boot_lockdown.py` (add tests for new BCD settings)

## Acceptance

- New BCD settings are applied as best-effort.
- bootsequence is cleared.
- Restore commands reverse the new settings.
- Tests pass (mocked). Ruff clean.
