# Session Capture — 2026-10-30 — sess-159

## Context
- Task: D-130: sign PblApp and boot it under Secure Boot to see how far the PASS path gets
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
- The pbl-qemu image ships OVMF_VARS_4M.snakeoil.fd AND the matching private key /usr/share/ovmf/PkKek-1-snakeoil.key (passphrase 'snakeoil'), so Secure Boot can be exercised with no enrollment step. OVMF_CODE_4M.secboot.fd is the real code file; the snakeoil one is a symlink to it.
- OVMF's Secure Boot build requires -machine q35,smm=on plus -global driver=cfi.pflash01,property=secure,value=on. Without SMM it stalls with no serial output at all.
- Result: a signed PblApp loads and runs under Secure Boot and Decision Step 5 passes; the block basis moves to 'dbx lacks the MS 2011 revocation'. So signing works; what remains is db/dbx CONTENT (Microsoft CA 2023 + 2011 revocation) and the TPM interface under SMM.
- TPM under SMM: tpm-tis reaches a TPM holding none of our indices (TPM_RC_HANDLE 0x18B/0x9A2, which reads like 'unprovisioned' but is an interface mismatch); tpm-crb stalls the boot entirely.

## Mistakes / Corrections
- Passed an OVMF CODE file through docker cp without noticing it was a symlink; the dangling link made the harness silently fall back to non-Secure-Boot OVMF and the run reported 'Secure Boot disabled' while looking completely normal.
- Ran the harness without mounting /firmware (exit 127), and suppressed a provisioner's output once so a failed AK write looked like success until the firmware reported unprovisioned.
- Took several runs to notice that a TPM_RC_HANDLE error in the guest meant the guest was talking to a different TPM than the one I provisioned.

## Open Questions
- <none recorded>

## File References
- firmware/PblPkg/test-d131-wire-harness.sh
- firmware/PblPkg/artifacts/d130-secureboot-serial.log
- firmware/PblPkg/artifacts/d130-secureboot-results.txt
- docs/adr/PBL-DEBT-LEDGER.md

## Optional Fields (applied to consolidated memories)
- evidence_sources: <none>
- impact: <none>
- response: <none>
