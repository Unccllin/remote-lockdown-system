# Session Capture — 2026-10-27 — sess-142

## Context
- Task: D-129 Phase A: implement the 8 missing harness tests for the enforcement paths that had no coverage
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
- _StubServer (real ThreadingHTTPServer on 127.0.0.1:0) beats mocking requests: HMAC signing, payload shaping and ACK retry then run for real
- _patch_agent_state (repointing PENDING_ACK_FILE/DEADMAN_FILE/OFFLINE_QUEUE_DB/UPDATE_*) is mandatory for any harness test touching agent state — otherwise a hardware run writes live C:\ProgramData\LockdownSystem
- _Checks/_PhaseATest pattern: action() returns a check summary so a failure names itself in the CTRF artifact (FAILED 2/9 assertions: ...) instead of a bare FAIL
- every graph enforcement path now has a harness tag; a pytest test parses GRAPH-SPEC.yaml so a new path cannot be added without a test

## Mistakes / Corrections
- mistake: assumed the pending-ACK retry preserved command_uuid; it did not — handle_lockdown never recorded one, so each retry invented a new UUID and server dedup could not match. Test asserted the claim and found the bug; fixed in agent.py
- mistake: first E-TRACK-01 asserted 'no location => queued offline'; it is the opposite (no location => nothing to queue). Assert both directions
- mistake: E-AUTO-UPDATE checked a guessed artifact filename instead of reading the patched agent.UPDATE_* constants

## Open Questions
- <none recorded>

## File References
- agent/hw_test_harness.py
- agent/agent.py
- agent/tests/test_hw_harness.py
- docs/D-129-HARDWARE-RUNBOOK.md
- .devin/skills/hw-test-harness-v2/SKILL.md

## Optional Fields (applied to consolidated memories)
- evidence_sources: <none>
- impact: <none>
- response: <none>
