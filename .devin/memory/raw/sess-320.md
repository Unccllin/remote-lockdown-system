# Session Capture — 2026-11-20 — sess-320

## Context
- Task: S344: close the verification gap in the store locks (test the primitive, not the outcome) and resolve S343's two open questions
- Environment: repo remote-lockdown-system, branch master, python 3.14.8
- Duration: <not specified>

## Decisions Made
- test exclusion directly (B.entry >= A.release) instead of adding another outcome test
- parametrise it over memory.py and brain.py because the two store_lock() bodies are independent copies
- record the Windows item as blocked-on-access with a measured HTTP 000, rather than leaving it as an open question

## Actions Taken
- added test_store_lock_excludes_a_second_process (2 parametrisations, suite 49 -> 51)
- teeth by mutating LOCK_EX to LOCK_SH: both cases fail naming the measured overlap, then restored
- checked Dependabot run history: nothing has run since fdfceab, so that question is unanswered by scheduling
- checked lab server reachability for the Windows half: HTTP 000

## Outcomes
- What worked: - choosing the LOCK_SH mutation, which leaves a working lock that excludes nobody; a test that only fires when the lock is absent would have missed it
- asking what the existing tests actually assert before adding more
- What failed: - nothing failed this session
- What was unexpected: - the most recent Dependabot run is older than the fix by three hours and four days of schedule — the question was never going to be answered by time alone
- the lab server is simply down, which makes the Windows verification a blocker rather than a task

## Learnings
- outcome tests are blindest where the mechanism matters least: 12 concurrent writers passed 12/12 while the race was present
- for a lock, the honest assertion is 'the second process did not enter', and the honest mutation is a shared lock, not a removed one

## Mistakes / Corrections
- mistake (carried from S342/S343): described concurrency tests as measuring the lock when they measured data survival; correction: primitive-level test with a mechanism-specific mutation

## Open Questions
- <none recorded>

## File References
- scripts/test_memory.py
- docs/artifacts/s344-store-lock-exclusion.txt

## Optional Fields (applied to consolidated memories)
- evidence_sources: <none>
- impact: <none>
- response: <none>
