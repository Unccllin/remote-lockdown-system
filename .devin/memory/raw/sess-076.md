# Session Capture — 2026-09-09 — sess-076

## Context
- Task: D-102 TPM HMAC session: per-command nonce refresh + fail-closed response HMAC verification
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
- PblTpmRefreshNonce generates new 32-byte nonceCaller from TPM2_GetRandom per command for replay protection
- Auth area expanded from 41 to 73 bytes to hold full nonce (2+32) + HMAC (2+32)
- PblTpmFillCommandHmac refreshes nonce, writes it into auth area, then computes pHash-based HMAC
- PblTpmParseSessionResponse now fail-closed: returns NULL on HMAC mismatch
- Session is still not started from boot flow (PblTpmStartHmacSession not called from PblApp entry)
- Response HMAC uses simplified computation (raw buffer), not proper pHash

## Mistakes / Corrections
- <none recorded>

## Open Questions
- <none recorded>

## File References
- firmware/PblPkg/PblApp/TpmSession.c
- firmware/PblPkg/PblApp/TpmClient.c
- firmware/PblPkg/PblApp/PblApp.h
- docs/adr/PBL-DEBT-LEDGER.md

## Optional Fields (applied to consolidated memories)
- evidence_sources: <none>
- impact: <none>
- response: <none>
