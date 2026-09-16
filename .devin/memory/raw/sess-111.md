# Session Capture — 2026-09-16 — sess-111

## Context
- Task: AES-256-CFB TPM parameter encryption for C2 REQ-05 — implement correctly and enable PCD
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
- Parameter-encryption sessionValue = sessionKey || authValue(entity), appended unconditionally (unlike HMAC includeAuth). Key+IV = KDFa(SHA256, sessionValue, CFB, nonceNewer, nonceOlder, 384): cmd dir (nonceCaller, nonceTPM), resp dir (fresh nonceTPM, nonceCaller). Only first TPM2B buffer encrypted; cpHash covers ciphertext so encrypt before HMAC. Wire-verified vs swtpm: NV_Write attrs=0x21 ciphertext, NV_Read attrs=0x41 ciphertext response.

## Mistakes / Corrections
- mistake: previous code used raw sessionKey + IV=0 and encrypted after HMAC, both wrong per libtpms; also NV_Write/NV_Increment never rolled nonceTPM (latent BAD_AUTH) — fixed with PblTpmRollNonceFromSessionResponse

## Open Questions
- <none recorded>

## File References
- docs/adr/PBL-DEBT-LEDGER.md

## Optional Fields (applied to consolidated memories)
- evidence_sources: <none>
- impact: <none>
- response: <none>
