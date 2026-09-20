# Session Capture — 2026-09-20 — sess-132

## Context
- Task: NG-T7: monotonic lock-epoch counter for lock-state NV freshness
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
- An NV counter index's value IS readable via TPM2_NV_Read (uint64 BE) — confirmed by PblTpmReadPolicyVersion
- swtpm stores all NV in one tpm2-00.permall blob → counter and cache can't be rolled back independently, so stale-epoch rejection is unreachable in emulation
- Carving a field from a struct's Reserved/padding keeps the NV index size fixed — Epoch went into Reserved[20]→[12]
- Generalize counter helpers (PblTpmNvIncrementCounter/ReadCounter) rather than duplicating the policy-version pattern

## Mistakes / Corrections
- Forgot forward declarations for new STATIC helpers used earlier in the file

## Open Questions
- <none recorded>

## File References
- firmware/PblPkg/PblApp/TpmClient.c
- firmware/PblPkg/PblApp/PblApp.h
- docs/wayfinder/tickets/NG-T7-monotonic-freshness.md

## Optional Fields (applied to consolidated memories)
- evidence_sources: <none>
- impact: <none>
- response: <none>
