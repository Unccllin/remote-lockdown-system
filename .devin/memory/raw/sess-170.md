# Session Capture — 2026-11-02 — sess-170

## Context
- Task: Session 170: reconcile the four open debt items against reality, audit D-136 blast radius, and harden its regression coverage
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
- Every remaining open item is resource-blocked, not code-blocked: D-129/D-134 need the HP machine, D-120 needs real BitLocker-encrypted media (the harness image is synthetic), D-130 needs a provisioned fleet signing PFX.
- D-136 blast radius is exactly one consumer: PblTpmDecryptResponseParams has 3 call sites, only the 64-byte lock-state read exceeds one AES block; policy-version and epoch reads are ~10 bytes and sit entirely in block 0. Within the lock state, every field at offset >= 16 was corrupt.
- A regression assertion on the STORED lock-state Epoch field read via tpm2-tools cannot catch D-136: tpm2-tools does not use the session, so the stored bytes were always correct (the firmware printed garbage while the dump showed 02). The guard that works asserts the firmware's DECODED value in the serial log (NG-T7: cache epoch=1 live=1), which would have failed before the CFB fix.
- General rule learned here: before accepting any regression test, ask 'would this have failed before the fix?'. Reading the same field through a different path is not the same test.
- D-134's GRAPH-SPEC description was stale (claimed PcdPblTpmUsePlatformHierarchy=TRUE default after the ruling flipped it to FALSE); descriptions are read as instructions so staleness there is not cosmetic.

## Mistakes / Corrections
- mistake: wrote a regression assertion that passes whether or not the bug returns, because it read data through a path the bug never touched. Caught only by asking 'would this have failed before the fix?' AFTER writing it; the question belongs before.
- mistake: nearly reported a green harness run as evidence of D-136 coverage when only the stored bytes were being checked.

## Open Questions
- <none recorded>

## File References
- firmware/PblPkg/test-d135-epoch-harness.sh
- firmware/PblPkg/artifacts/d135-epoch-field.txt
- firmware/PblPkg/artifacts/d135-epoch-results.txt
- .devin/graph/GRAPH-SPEC.yaml
- docs/adr/PBL-DEBT-LEDGER.md

## Optional Fields (applied to consolidated memories)
- evidence_sources: <none>
- impact: <none>
- response: <none>
