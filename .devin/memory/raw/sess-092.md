# Session Capture — 2026-09-15 — sess-092

## Context
- Task: Run a QEMU PASS/mismatch chain-load test with the real Windows 11 23H2 bootx64.efi and a PBL policy containing the correct bootmgr_hash (C4 key 58), then close D-214 and D-218.
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
- The local EDK2 OVMF build (OvmfPkgX64, no network boot options) is essential for avoiding PBL's NetworkBootEntriesPresent block.\n- virt-fw-vars can prepare a PBL-friendly varstore: --enroll-microsoft for db/dbx, --set-true SecureBoot/MemoryOverwriteRequestControl, --set-false SetupMode, and a dummy dbx cert.\n- test-d205.py --generate-keys must be idempotent; otherwise the mock server signs with a different key than the policy embeds, and PBL verdict verification fails.\n- The Windows 11 23H2 ISO bootx64.efi is a signed PE32+ with certificate table at file offset 0x19ac00; whole-file SHA-256 is a20b35...\n- PblChainLoadWindows with a hash-verified buffer reaches LoadImage and StartImage; StartImage fails with Invalid Parameter because the ISO boot manager is not in a full installed-Windows environment, but the hash check and chain-load path are exercised.

## Mistakes / Corrections
- Initially edited PblApp.c/Decision.c to add debug prints, then had to remove them; the repo source was already clean, so the edits were unnecessary and the old PblApp.efi in /tmp contained stale debug output.\n- First run of test-chainload-harness.sh failed because --generate-keys regenerated keys after policy generation; the harness should generate or load keys once at the start.

## Open Questions
- <none recorded>

## File References
- firmware/PblPkg/test-chainload-harness.sh\n- firmware/PblPkg/test-d205.py\n- firmware/PblPkg/PblApp/PlatformState.c\n- firmware/PblPkg/PblApp/DmaProtection.c\n- docs/adr/PBL-DEBT-LEDGER.md\n- .devin/graph/trace.md\n- .devin/graph/current-state.md

## Optional Fields (applied to consolidated memories)
- evidence_sources: <none>
- impact: <none>
- response: <none>
