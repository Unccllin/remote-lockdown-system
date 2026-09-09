# Session Capture — 2026-09-09 — sess-078

## Context
- Task: D-102 PCR HMAC session (bound to TPM_RH_NULL) for PCR extends per C2 §3.3
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
- mPcrSession is a second static session struct in TpmSession.c, parallel to mSession
- PblTpmStartPcrSession starts unbound HMAC session (bind=TPM_RH_NULL, no bind auth)
- PblTpmExtendPcr now uses TPM_ST_SESSIONS with PCR session when active, falls back to no-session
- PblTpmFlushPcrSession called alongside PblTpmFlushSession in all 5 chain-load/shutdown paths
- PblTpmFillCommandHmac and PblTpmParseSessionResponse still use mSession (NV session) fields — need parameterization for PCR session
- Without swtpm (D-101), both session starts fail and all commands fall back to password/no-session auth

## Mistakes / Corrections
- <none recorded>

## Open Questions
- <none recorded>

## File References
- firmware/PblPkg/PblApp/TpmSession.c
- firmware/PblPkg/PblApp/TpmClient.c
- firmware/PblPkg/PblApp/PblApp.c
- firmware/PblPkg/PblApp/PblApp.h
- docs/adr/PBL-DEBT-LEDGER.md

## Optional Fields (applied to consolidated memories)
- evidence_sources: <none>
- impact: <none>
- response: <none>
