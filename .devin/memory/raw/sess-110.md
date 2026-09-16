# Session Capture — 2026-09-16 — sess-110

## Context
- Task: Prove Secure Boot rejects tampered PblApp.efi in OVMF emulation (D-217 prevention)
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
- SECURE_BOOT_ENABLE=FALSE OVMF silently accepts everything — verify DxeImageVerificationLib is in the FV before claiming SB coverage. - virt-fw-vars --enroll-generate + --add-db-hash <guid> <authenticode-sha256> + --sb creates a working SB vars store; authenticode hash != file sha256 (excludes checksum/security-dir/cert-table) — use virt.peutils.pesign.pe_authenticode_hash. - Clean tamper for SB tests: append a byte past the last section (in auth hash, never loaded); flipping inside .reloc breaks loading itself (Unsupported, not SB rejection). - SB-enabled OVMF + default vars = SetupMode = unsigned still allowed — no regression for existing harnesses.

## Mistakes / Corrections
- mistake: first tamper flipped a byte in .reloc tail — assumed padding, but the loader applies relocations from that section, so the binary failed to LOAD even without Secure Boot; control scenario caught it

## Open Questions
- <none recorded>

## File References
- firmware/PblPkg/test-sb-harness.sh - firmware/PblPkg/build-pbl.sh - docs/adr/PBL-SECURE-BOOT-DEPLOYMENT.md - docs/adr/PBL-DEBT-LEDGER.md

## Optional Fields (applied to consolidated memories)
- evidence_sources: <none>
- impact: <none>
- response: <none>
