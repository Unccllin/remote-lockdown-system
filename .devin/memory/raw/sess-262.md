# Session Capture — 2026-11-06 — sess-262

## Context
- Task: Replace test_destructive_tests_have_rollback (which never checked rollback) with honest tests plus a shrink-only baseline of stub rollbacks, and stop a test from writing evidence into the repo
- Environment: <not specified>
- Duration: <not specified>

## Decisions Made
- <none recorded>

## Actions Taken
- <none recorded>

## Outcomes
- What worked: <not recorded>
- What failed: <not recorded>
- What was unexpected: <not recorded>

## Learnings
- All three destructive harness tests have no-op rollbacks: E-BCD-01 and E-HP-UEFI-01 override rollback() with pass, E-INTEGRATION-01 has no override; the suite's green test only asserted the ids existed and its name claimed the property
- rollback_is_stub defaults True on HardwareTest (the base rollback is a no-op), so the flag is only meaningful when scoped to is_destructive tests — comparing it across all tests matches every one
- The repo's shrink-only baseline idiom (test_cross_surface_contract.py KNOWN_GAPS) is the right shape for known-stub behaviour: implementing it must break a test, or nobody notices
- A test that exercises a disk-writing feature must pass its own evidence dir (tmp_path), or it writes into the repo

## Mistakes / Corrections
- mistake: used 'git checkout <file>' to undo a temporary negative-control edit and reverted the whole file, wiping this session's rollback_is_stub work; a ranged undo of the two added lines was what was needed
- mistake: S262's test ran a destructive test without evidence_dir, so 4 E-FAKE-01-before-*.json files were written into agent/ and committed by 'git add -A'; fixed at cause (tmp_path) and symptom (files deleted)
- mistake: first version of the baseline test compared rollback_is_stub across all tests, so all 20 matched; and I guessed the class name TestBcd instead of TestBcdLockdown

## Open Questions
- <none recorded>

## File References
- agent/hw_test_harness.py
- agent/tests/test_hw_harness.py

## Optional Fields (applied to consolidated memories)
- evidence_sources: <none>
- impact: <none>
- response: <none>
