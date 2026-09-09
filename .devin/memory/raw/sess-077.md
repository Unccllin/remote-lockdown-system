# Session Capture — 2026-09-09 — sess-077

## Context
- Task: D-102 TPM HMAC session: session start in boot flow + flush before chain-load + proper response pHash
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
- PblTpmStartHmacSession called from PblApp.c step 3, bound to PBL_NV_LOCK_STATE with empty auth
- PblTpmFlushSession called before all chain-load/shutdown paths (PASS, DEGRADED, OverrideGranted, OverrideDenied, UNKNOWN)
- PblTpmVerifyResponseHmacEx implements proper response pHash: SHA256(responseCode || commandCode || responseParams)
- PblTpmParseSessionResponse now takes CommandCode parameter for pHash computation
- Without swtpm (D-101), session start fails and falls back to TPM_RS_PW — expected in no-TPM QEMU
- PCR extend operations still use no-session (TPM_ST_NO_SESSIONS) — C2 §3.3 says separate sessions needed

## Mistakes / Corrections
- <none recorded>

## Open Questions
- <none recorded>

## File References
- firmware/PblPkg/PblApp/PblApp.c
- firmware/PblPkg/PblApp/TpmSession.c
- firmware/PblPkg/PblApp/TpmClient.c
- firmware/PblPkg/PblApp/PblApp.h
- docs/adr/PBL-DEBT-LEDGER.md

## Optional Fields (applied to consolidated memories)
- evidence_sources: <none>
- impact: <none>
- response: <none>
