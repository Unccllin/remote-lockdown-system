# Session Capture — 2026-11-02 — sess-168

## Context
- Task: D-135: root-cause why NV_Increment(0x1C00004) returns 0x9A2 on every boot
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
- 0x9A2 decodes with tpm2_rc_decode as 'tpm:session(1):authorization failure without DA implications' - it is an HMAC/session failure, not an NV authorization error. Any NV-authorization theory (like D-134's) is the wrong tree.
- Layer 1: mNvNameCache was [3] while PblApp.h defines four NV indices; PblTpmCacheNvName claims slots in definition order so LOCK_EPOCH never got one, PblTpmGetHandleName fell back to the 4-byte handle name, the cpHash was computed over the wrong authName and the TPM rejected it. Fixed by sizing to PBL_NV_INDEX_COUNT with a STATIC_ASSERT plus a loud cache-full warning. Cold boot is now clean.
- Layer 2 (still open): on a warm boot PblTpmProvisionNvIndices re-derives names from the define template while live indices carry TPMA_NV_WRITTEN, and TPMS_NV_PUBLIC is part of the name, so a name computed without WRITTEN never matches. Evidence from tpm2_nvreadpublic: LOCK_STATE 0x22060004 and LOCK_EPOCH 0x22060014 are written; POLICY_VERSION 0x02060014 and AK_NAME 0x02060004 are not - and the warm-boot log fails exactly on AK_NAME, the counter read and the increment.
- Fix direction: names must come from TPM2_NV_ReadPublic (no authorization needed) and be cached verbatim, not computed from locally assumed attributes.
- The epoch counter is the only visible symptom because it is the only command aimed at the fourth index.

## Mistakes / Corrections
- mistake: checked only boot 1 after the cache-size fix and nearly declared D-135 fixed; the warm boot is what exposed layer 2. A single-boot test cannot see a WRITTEN-bit name mismatch.
- mistake: S167's write-up described the defect as 'PBL's command construction (session/HMAC or handle ordering)' when the real cause was the input to the HMAC (a wrong entity name) - loose phrasing that would send the next session into the wrong function.
- mistake: the harness's counter() helper returned the sentinel 'unknown' instead of failing loudly, so the harness summary was untrustworthy while the real evidence sat in logs it does not summarise.

## Open Questions
- <none recorded>

## File References
- firmware/PblPkg/PblApp/TpmClient.c
- firmware/PblPkg/PblApp/PblApp.h
- firmware/PblPkg/test-d135-epoch-harness.sh
- firmware/PblPkg/artifacts/d135-nv-name-vs-tpm.txt
- firmware/PblPkg/artifacts/d135-boot-1-cold-serial.log
- firmware/PblPkg/artifacts/d135-boot-2-warm-serial.log
- docs/adr/PBL-DEBT-LEDGER.md

## Optional Fields (applied to consolidated memories)
- evidence_sources: <none>
- impact: <none>
- response: <none>
