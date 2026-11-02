# Session Capture — 2026-11-02 — sess-166

## Context
- Task: D-134: build PblApp with PcdPblTpmUsePlatformHierarchy FALSE and test whether the owner-hierarchy fallback restores TPM NV reachability on stock firmware
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
- Flipping PcdPblTpmUsePlatformHierarchy to FALSE does NOT fix NV reachability: the TRUE build on stock OVMF returns 0x9A2 (handle/hierarchy), the FALSE build returns 0x149 (TPM_RC_NV_AUTHORIZATION).
- Why: PblTpmReadAkName authorizes NV_Read with TPM_RH_OWNER when the PCD is FALSE, but PblTpmNvDefineSpace defines owner indices with 0x02040004 (AUTHWRITE|AUTHREAD|NO_DA) with no OWNERREAD. TPM 2.0 requires TPMA_NV_OWNERREAD when authHandle is TPM_RH_OWNER.
- Measured matrix (pure tpm2-tools + swtpm, fresh TPM per case): 0x420D000D read via platform OK / via owner 0x149 / via index OK; 0x02040004 via owner 0x149 / via index OK; 0x02060004 (adds OWNERREAD) via owner OK / via index OK. So the fix is OWNERREAD (or authorizing with the index handle).
- PLATFORMCREATE makes a platform-created index undeletable by the owner hierarchy, so a fleet cannot be migrated between hierarchy schemes in place; the choice must be made at enrolment and enrolment+consumption must agree.
- A fresh/empty TPM gives 0x28B (TPM_RC_HANDLE on the second handle) for BOTH PCD variants because the AK Name index is written at enrolment and PBL reads it before its own PblTpmProvisionNvIndices runs - an empty TPM is an unenrolled device, not a hierarchy signal.
- RC mapping: 0x14A = TPM_RC_NV_UNINITIALIZED (firmware treats it as benign 'unprovisioned'), 0x149 = TPM_RC_NV_AUTHORIZATION (hard error).

## Mistakes / Corrections
- mistake: my close criteria for D-134 said 'flip the PCD', presuming the fallback worked; nobody had ever run that branch. A fallback path never executed is a hypothesis, not a fallback.
- mistake: first matrix harness asserted an RC format of 9 hex digits where tpm2-tools prints 8 (0x00000149) - the physics was right, the parsing was wrong.
- mistake: first micro-test reused one TPM across cases; PLATFORMCREATE made owner-hierarchy undefine fail, producing a cascade of misleading 'define FAIL' lines that looked like the TPM rejecting my cases.

## Open Questions
- <none recorded>

## File References
- firmware/PblPkg/test-d134-nv-auth-matrix.sh
- firmware/PblPkg/artifacts/d134-nv-auth-matrix-results.txt
- firmware/PblPkg/PblApp/TpmClient.c
- firmware/PblPkg/PblPkg.dec
- docs/adr/PBL-DEBT-LEDGER.md
- .devin/PENDING-RULING.md

## Optional Fields (applied to consolidated memories)
- evidence_sources: <none>
- impact: <none>
- response: <none>
