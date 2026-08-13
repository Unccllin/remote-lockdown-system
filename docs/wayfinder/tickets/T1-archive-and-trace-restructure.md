# T1: Archive completed artifacts + restructure trace.md

> **Label:** `wayfinder:task`
> **Status:** CLOSED (2026-08-13)
> **Blocks:** T2 (process hardening — needs clean trace state)
> **Blocked by:** none
> **Implements:** H1 (trace.md restructure), H6 (archive completed artifacts)

## Question

trace.md is 2761 lines. Every session reads it at startup, consuming
significant context budget. Completed artifacts (REFACTOR-LOG.md, old wayfinder
map + tickets) are marked "Active" or left in place, creating stale state.
Restructure trace.md for fast session startup and archive completed work.

## Work

### trace.md restructure (H1)

1. Create `.devin/graph/current-state.md` — a compact (50-100 line) file
   containing:
   - Latest session's status block (fog cleared, fog remaining, debt open,
     blockers, next session opening)
   - Current open debt items (if any)
   - Current open wayfinder tickets (if any)
   - A pointer to `trace.md` for full history
2. Move the full session history to `trace.md` (keep as-is — don't delete
   history, just stop making sessions read it all at startup)
3. Update `AGENTS.md` mandatory reads: change "read trace.md" to
   "read `current-state.md` first, then `trace.md` on demand"
4. Update `graph_assert.py` I4 check: session-end block must be appended to
   BOTH `trace.md` (full history) AND `current-state.md` (compact summary)
5. Update `orchestrator.sh` `write_session_end()` to write to both files

### Archive completed artifacts (H6)

1. `docs/adr/REFACTOR-LOG.md` — all 10 refactors DONE. Move to
   `docs/adr/archive/REFACTOR-LOG.md` and add a note in `docs/adr/` pointing
   to the archive location.
2. `docs/wayfinder/archive/` — already created, pba-hardening-map.md and all
   21 closed tickets already moved there (done during map creation).
3. `docs/wayfinder/archive/README.md` — add a brief note that this archive
   contains completed wayfinder work (PBA + boot hardening, all tickets
   closed 2026-08-14).

### Update AGENTS.md

1. Update the "Mandatory reads at session start" section to reference
   `current-state.md` as the primary read, with `trace.md` as on-demand
2. Note that `REFACTOR-LOG.md` has been archived

## Files to edit

- `.devin/graph/current-state.md` (new — compact session state)
- `.devin/graph/trace.md` (update — no content change, just no longer the
  primary startup read)
- `.devin/graph/graph_assert.py` (update I4 check)
- `.devin/orchestration/orchestrator.sh` (update write_session_end)
- `AGENTS.md` (update mandatory reads section)
- `docs/adr/archive/REFACTOR-LOG.md` (moved from docs/adr/)
- `docs/wayfinder/archive/README.md` (new — brief archive note)

## Acceptance

- `current-state.md` exists and is under 100 lines
- `current-state.md` contains the latest session's status block
- `current-state.md` contains a pointer to `trace.md` for full history
- `AGENTS.md` mandatory reads section references `current-state.md` first
- `graph_assert.py` I4 check verifies session-end block in both files
- `REFACTOR-LOG.md` is in `docs/adr/archive/`
- `docs/wayfinder/archive/` contains the old map + 21 closed tickets
- `make graph-check` passes
- All existing tests pass (no regressions)

### Demonstration (red-green)

**Before**: Simulate a new session startup — measure how many lines must be
read from trace.md to reach the "next session opening" (answer: ~2761 lines,
or the agent must scroll to the end).

**After**: Same simulation — `current-state.md` provides the "next session
opening" in the first 100 lines. Show that `graph_assert.py` catches a
session-end block written to only `trace.md` (not `current-state.md`) as an
I4 violation.
