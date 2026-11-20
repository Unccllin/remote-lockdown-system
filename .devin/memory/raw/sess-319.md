# Session Capture — 2026-11-20 — sess-319

## Context
- Task: S343: fix the memory.py store race S342 identified, and harden both store locks
- Environment: repo remote-lockdown-system, branch master, python 3.14.8, scripts/memory.py + scripts/brain.py
- Duration: <not specified>

## Decisions Made
- lock is reentrant (thread-local depth) because consolidate/reconcile/decay/cleanup call stage_index() in-process and flock blocks rather than errors on re-entry
- three concurrency tests spawn the real CLI against a copy of memory.py in a temp repo root, because in-process tests cannot see a lost update
- two mutually contradictory lint rules (unwrapped open vs SIM115) resolved with one line-level noqa plus a try/except SystemExit
- added a guard: no locking primitive => refuse to run, so getattr-resolved msvcrt cannot silently degrade to no lock

## Actions Taken
- measured the race at several concurrency levels before fixing; 40 concurrent captures kept 33 without the lock, 40 with it
- applied @mutating to 7 memory stages; kept stage_graph undecorated (it does not mutate)
- found and fixed an import-time LOCK_FILE that made tests lock the real store
- removed .devin/brain/.beliefs.lock from git and gitignored both lock paths
- replaced msvcrt direct attribute access with getattr in both scripts (cleared 5 Pyright errors S342 introduced)

## Outcomes
- What worked: - measuring before fixing, and treating two negative results as evidence about the measurement rather than the code
- testing the deadlock by removing the reentrancy and watching timeout exit 124
- What failed: - first teeth experiment in S342 was void (patch script asserted the wrong count and aborted); this time each revert was verified by grepping the file afterwards
- What was unexpected: - 8 and 12 concurrent captures showed NO race at all; only 40 writers exposed it
- memory.py's LOCK_FILE constant meant every in-process test was taking an exclusive lock on the real repo store

## Learnings
- a lost-update window's size is set by what the writer reads: a directory glob (microseconds) vs a parsed+serialised document (tens of ms) — same defect, very different reproduce rate
- a lock copied between two scripts must be reentrant if either script has nested mutating stages, and flock blocks rather than raising, so the failure is a hang
- lock paths must be resolved from the current store directory at call time, or monkeypatched tests lock the real store

## Mistakes / Corrections
- mistake: first draft of the artifact claimed a timeout exit code that had not been run, and a consolidate run that found no learnings so it never exercised the reentrancy path; correction: measured both for real and regenerated those sections

## Open Questions
- <none recorded>

## File References
- scripts/memory.py
- scripts/brain.py
- scripts/test_memory.py
- scripts/test_brain.py
- docs/artifacts/s343-memory-store-lock.txt
- .gitignore
- AGENTS.md

## Optional Fields (applied to consolidated memories)
- evidence_sources: <none>
- impact: <none>
- response: <none>
