# Session Capture — 2026-11-02 — sess-165

## Context
- Task: D-130 gap 2: determine why the SMM guest could not see PBL's TPM NV indices; also verify the no-WSL Windows target constraint
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
- D-130 gap 2 was never SMM and never tpm-tis/crb: a 6-way matrix (SMM x device x OVMF build) shows the outcome tracks ONLY the OVMF build. PBL OVMF reads the AK Name in all three arms (incl. SMM+CRB); stock distro OVMF fails 0x9A2 in all three.
- Cause: stock OVMF wires PeiDxeTpmPlatformHierarchyLib, whose ConfigureTpmPlatformHierarchy randomizes platformAuth (Tpm2HierarchyChangeAuth) or disables the hierarchy (Tpm2HierarchyControl NO). PBL creates NV indices under TPM_RH_PLATFORM with PLATFORMCREATE (PcdPblTpmUsePlatformHierarchy=TRUE), so read fails 0x9A2 and define 0x18B. The PBL OVMF patch to PeiDxeTpmPlatformHierarchyLibNull is the entire difference.
- tpm-crb works identically to tpm-tis on the PBL build - the old 'crb stalls with no output' was the pre-session-101 swtpm startup sequence, not the device.
- swtpm logs show 1900+ command lines in the SMM arms, so the guest's TPM traffic does reach the emulator (contradicting the session-160 reading).
- The same failure was already recorded in session 113 for a FVE harness that accidentally used the distro OVMF.
- Production risk filed as D-134: the production PCD default (platform hierarchy) is a guess with a demonstrated failure mode on firmware that manages platformAuth properly.
- Target machines have no WSL: one-click NSIS uses certutil + sc.exe + registry only; ZIP path uses PowerShell + bundled nssm.exe; agent/install_service.ps1 needs system Python + NSSM so it is not a supported target path.

## Mistakes / Corrections
- mistake: kept the first sweep's serial logs in the container's /tmp, so the evidence was gone and the harness had to be rewritten before any line could be quoted. Correction: write artifacts to the bind mount and chown them for the host user.
- mistake: printf '--- name ...' in the harness - printf reads the leading dashes as options and aborted the run before any QEMU started. Correction: printf -- or echo.
- mistake: accepted a recorded diagnosis (S160's 'SMM traffic does not reach swtpm') as fact for a whole session instead of testing it against the artifact; the matrix cost two minutes and refuted it.

## Open Questions
- <none recorded>

## File References
- firmware/PblPkg/test-d130-tpm-hierarchy-harness.sh
- firmware/PblPkg/artifacts/d130-tpm-hierarchy-results.txt
- firmware/PblPkg/PblApp/TpmClient.c
- firmware/PblPkg/PblPkg.dec
- firmware/PblPkg/ovmf-platform-hierarchy-null.patch
- docs/adr/PBL-DEBT-LEDGER.md
- docs/D-129-HARDWARE-RUNBOOK.md
- README.md

## Optional Fields (applied to consolidated memories)
- evidence_sources: <none>
- impact: <none>
- response: <none>
