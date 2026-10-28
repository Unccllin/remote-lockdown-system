# Session Capture — 2026-10-27 — sess-141

## Context
- Task: D-129 hardware runbook: turn the hardware-test plan + harness into a runbook that produces artifacts graph I3 accepts
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
- 8 of the 9 unit-test-only enforcement paths have NO harness test (grep: deadman/track/offline_queue/auto_update/effectiveness = 0 occurrences); only E-HP-UEFI is runnable, measured via --tag exit codes (8x exit 1 'No tests match tags')
- graph I3 only checks that hardware_artifact_ref is a non-empty string, so E-BCD is marked verified-on-hardware while its cited artifact records E-BCD-01 FAIL
- --retry defaults to 0 and silently overrides each test's default_retries, so network tests get zero retries unless --retry N is passed
- the harness records platform, not machine: no model/serial/uuid/secure_boot in environment, so hardware inventory must be filed alongside the CTRF json
- two evidence streams share the D-129 trip but not the artifact: firmware serial log vs harness CTRF

## Mistakes / Corrections
- mistake: the S142 handover assumed the hardware window would convert 9 paths; measured coverage showed 8 have no test at all — check the registry before planning a window, not after

## Open Questions
- <none recorded>

## File References
- docs/D-129-HARDWARE-RUNBOOK.md
- docs/README.md
- agent/hw_test_harness.py
- firmware/PblPkg/HARDWARE-TEST-PLAN.md
- .devin/graph/GRAPH-SPEC.yaml
- .devin/graph/graph_assert.py

## Optional Fields (applied to consolidated memories)
- evidence_sources: <none>
- impact: <none>
- response: <none>
