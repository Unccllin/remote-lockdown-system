# Session Capture — 2026-11-02 — sess-167

## Context
- Task: D-134: apply the ruling (owner-hierarchy NV + index-handle auth), align provisioning, verify in QEMU; file D-135 for the epoch counter
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
- NV_Read authorized by the INDEX handle works under every attribute set and hierarchy state, so it is independent of platformAuth and ownerAuth. That is why the D-134 ruling chose it.
- Index-handle auth also reads platform-created indices (AUTHREAD is set in both schemes), so units enrolled under the old platform-hierarchy scheme keep working after the firmware upgrade. New defines use the owner hierarchy: 'read both, write owner'.
- Owner attribute set for PBL is now 0x02060004 = AUTHWRITE|AUTHREAD|NO_DA|OWNERREAD; PcdPblTpmUsePlatformHierarchy defaults to FALSE; provisioning scripts create NV 0x01C00003 with '-C o -a 0x02060004' so enrolment and firmware agree.
- A cleared TPM needs no new code for fail-closed behaviour: a missing index reads as unprovisioned, which already routes to refuse-to-fetch -> denied-boot-with-local-unlock (D-131 Q1).
- New defect D-135: NV_Increment(0x1C00004) returns 0x9A2 on every boot although the index is defined and provisioning reports OK, so NG-T7 rollback detection is inert. NOT an authorization problem (PblTpmNvIncrementCounter already uses the index handle) and tpm2-tools increments an identical counter index fine (read-back 0000000000000001) while a non-counter index is refused 0x282 - so it is PBL's NV_Increment command construction.
- tpm2-tools swtpm TCTI derives the control port as data+1; a mismatch shows up as 'Could not load tcti' and then as silent aborts under set -e.
- tpm2_startup must be best-effort (|| true): it can return non-zero right after swtpm start and set -e then aborts the whole harness before any boot.

## Mistakes / Corrections
- mistake: harness aborted before any boot because 'tpm2_startup -c' failed under set -e without '|| true'; the empty output looked like a container problem.
- mistake: port arithmetic put the swtpm control socket at data-1 while the TCTI expects data+1, producing 'Could not load tcti' errors that were easy to misread as a broken image.
- mistake: wrote D-134's original close criteria from the symptom ('flip the PCD') rather than from the mechanism, which S166 then disproved.
- mistake: several sessions grepped logs for the line they wanted and never read the whole [3/8] block, which is why the epoch-counter warning sat unnoticed in every log.

## Open Questions
- <none recorded>

## File References
- firmware/PblPkg/PblApp/TpmClient.c
- firmware/PblPkg/PblPkg.dec
- scripts/provision-qemu-tpm.sh
- firmware/PblPkg/ci-harness-docker.sh
- firmware/PblPkg/test-d134-owner-hierarchy-harness.sh
- firmware/PblPkg/artifacts/d134-owner-hierarchy-results.txt
- docs/adr/PBL-DEBT-LEDGER.md
- .devin/PENDING-RULING.md
- .devin/graph/GRAPH-SPEC.yaml

## Optional Fields (applied to consolidated memories)
- evidence_sources: <none>
- impact: <none>
- response: <none>
