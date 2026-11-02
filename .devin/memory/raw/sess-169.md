# Session Capture — 2026-11-02 — sess-169

## Context
- Task: Close D-135: find and fix why the lock-epoch counter never incremented and NG-T7 never fired
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
- 0x9A2 = tpm2_rc_decode 'session(1): authorization failure without DA implications'. It is an HMAC/RS_PW failure, never an NV policy error.
- D-135 had three authorization defects, each sufficient alone: (1) mNvNameCache[3] for 4 indices, (2) PblTpmNvRefreshName called for 3 of 4 indices so warm boots used define-template names lacking TPMA_NV_WRITTEN, (3) the RS_PW fallback sent an EMPTY password while indices are created with a non-empty PcdPblTpmNvAuthValue.
- Fix pattern that removes the recurrence: drive both lists from PBL_NV_INDEX_COUNT with STATIC_ASSERT, and have PblTpmGetHandleName ask the TPM (TPM2_NV_ReadPublic needs no auth) for an uncached NV name instead of using the 4-byte handle.
- D-136: PblAesCfb256Process ran in place for both directions and always took CFB feedback from Output; on decrypt the XOR overwrites the ciphertext with plaintext before it becomes the next feedback block, so only block 0 decrypted correctly and everything past byte 16 was noise. Fix: Decrypt flag, feedback from the input block when decrypting.
- Why it hid for sessions: every harness asserted on block-0 fields (magic, verdict, IssuedAt). DeviceId (offset 12) and Epoch (offset 48) were garbage in every recorded boot and nothing looked there.
- Verification tooling gotchas: tpm2_nvread takes the auth with -P (not -p, which is nvdefine's); bash cannot hold the NUL terminating the PCD password so -P file: is required; the harness image has no strings (use grep -ao); a pipeline ending in grep -c returns 1 at zero matches and set -o pipefail aborts the script.
- Counter verified: 1 -> 2 -> out-of-band 4 -> 5 across three boots on one persistent TPM; NG-T7: cache epoch=1 live=1 (fresh), cache epoch=2 live=4 then 'lock-state epoch stale (cache=2 live=4) - rolled back?'.

## Mistakes / Corrections
- mistake: S167 described the defect as 'PBL's command construction (session/HMAC or handle ordering)' and S168 as 'HMAC vs empty auth'. Both were plausible guesses; the actual cause chain needed printing the compared values, not reading more code.
- mistake: my verification failed three times on tooling (-P/-p, NUL-in-variable, missing strings) and each failure looked like 'the firmware denies access' — the same misreading that kept D-135 open.
- mistake: the harness aborted silently on grep -c returning 1 under pipefail, so a run looked like a firmware failure when the assertions had not executed at all.

## Open Questions
- <none recorded>

## File References
- firmware/PblPkg/PblApp/TpmClient.c
- firmware/PblPkg/PblApp/TpmSession.c
- firmware/PblPkg/PblApp/PblApp.h
- firmware/PblPkg/test-d135-epoch-harness.sh
- firmware/PblPkg/artifacts/d135-epoch-results.txt
- docs/adr/PBL-DEBT-LEDGER.md
- .devin/graph/GRAPH-SPEC.yaml

## Optional Fields (applied to consolidated memories)
- evidence_sources: <none>
- impact: <none>
- response: <none>
